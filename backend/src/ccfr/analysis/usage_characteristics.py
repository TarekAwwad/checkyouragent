"""Usage Characteristics: overlapping (non-partition) properties of usage.

Mirrors /usage's "what's contributing to your limits usage?" panel: each entry
is an independent characteristic ("N% of usage came from X"), not a breakdown,
so shares may overlap and need not sum to 1. Cost-weighted (token-weighted when
no pricing); thresholds are pinned to /usage for visual comparability.

Built on usage_map.load_events so the denominator equals the usage-map total.
Computation is on-demand from the rebuildable SQLite cache, like discovery.py.
Design doc: docs/superpowers/specs/2026-06-16-usage-characteristics-design.md
"""

from __future__ import annotations

import sqlite3
from collections import defaultdict
from datetime import datetime
from typing import Any

from ccfr.analysis.pricing import load_price_table
from ccfr.analysis.usage_map import EventRec, load_events
from ccfr.config import pricing_path

# Thresholds pinned to /usage (tunable). Subagent-heavy ratio is our own choice
# (/usage's exact definition is unknown) and documented as approximate.
CONTEXT_BAND_TOKENS = 150_000
LONG_SESSION_HOURS = 8
AGENT_TYPE_MIN_SHARE = 0.05

BASIS_NOTE = (
    "Shares are weighted by cost (USD). Claude Code's /usage weights by "
    "rate-limit consumption, so expect directional, not exact, agreement."
)

TOKEN_BASIS_NOTE = (
    "Shares are weighted by total tokens (no pricing table loaded). Claude "
    "Code's /usage weights by rate-limit consumption, so expect directional, "
    "not exact, agreement."
)

GUIDANCE = {
    "subagent_usage": (
        "Work done inside subagent turns — each subagent runs its own requests. "
        "This is the direct subagent share of usage; the rest is the main thread."
    ),
    "subagent_sessions": (
        "The whole cost of every session that spawned at least one subagent "
        "(main thread + subagents) — shows how pervasive subagents are in your "
        "workflow, not how much they cost directly. Be deliberate about spawning "
        "them, and consider a cheaper model for simple ones."
    ),
    "context_gt_150k": (
        "Longer sessions are more expensive even when cached. /compact "
        "mid-task, /clear when switching tasks."
    ),
    "duration_gte_8h": (
        "Often background or loop sessions. Continuous usage adds up — make "
        "sure it is intentional."
    ),
    "agent_type": (
        "If this runs frequently, consider a cheaper model or tighter prompts "
        "for this subagent type."
    ),
}


def _span_hours(first_ts: str | None, last_ts: str | None) -> float:
    """Wall-clock hours between two ISO timestamps; 0.0 for missing/unparseable."""
    if not first_ts or not last_ts:
        return 0.0
    try:
        a = datetime.fromisoformat(first_ts.replace("Z", "+00:00"))
        b = datetime.fromisoformat(last_ts.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return 0.0
    return max(0.0, (b - a).total_seconds() / 3600)


def _char(key: str, headline: str, kind: str,
          weight_num: float, cost_sum: float, total: float) -> dict[str, Any]:
    guidance = GUIDANCE.get("agent_type" if key.startswith("agent_type:") else key, "")
    return {
        "key": key,
        "headline": headline,
        "kind": kind,
        "share": round(weight_num / total, 6) if total > 0 else 0.0,
        "cost_usd": round(cost_sum, 6),
        "guidance": guidance,
    }


def compute_characteristics(
    events: list[EventRec],
    *,
    session_spans: dict[int, tuple[str | None, str | None]],
    agent_types: dict[tuple[int, str], str],
    use_cost: bool,
) -> list[dict[str, Any]]:
    """Overlapping characteristics over already-loaded events. Pure: no DB.

    `weight` is the share basis (cost when use_cost else raw tokens); `cost_usd`
    is always the USD sum. Returned list is sorted by share descending.
    """
    def weight(e: EventRec) -> float:
        return e.cost if use_cost else float(e.tokens)

    total = sum(weight(e) for e in events)

    sess_cost: dict[int, float] = defaultdict(float)
    sess_weight: dict[int, float] = defaultdict(float)
    sess_sub_weight: dict[int, float] = defaultdict(float)
    sub_weight_total = 0.0
    sub_cost_total = 0.0
    ctx_weight = 0.0
    ctx_cost = 0.0
    type_weight: dict[str, float] = defaultdict(float)
    type_cost: dict[str, float] = defaultdict(float)

    for e in events:
        w = weight(e)
        sess_cost[e.session_db_id] += e.cost
        sess_weight[e.session_db_id] += w
        if e.agent_id is not None:
            sub_weight_total += w
            sub_cost_total += e.cost
            sess_sub_weight[e.session_db_id] += w
            atype = agent_types.get((e.session_db_id, e.agent_id), "unspecified")
            type_weight[atype] += w
            type_cost[atype] += e.cost
        if e.input_context_tokens > CONTEXT_BAND_TOKENS:
            ctx_weight += w
            ctx_cost += e.cost

    # Sessions that involve subagents at all: count the WHOLE session cost
    # (main + subagent) whenever the session spawned >=1 subagent. Distinct from
    # the direct attribution (sub_*_total) — this measures how pervasive
    # subagents are in the workflow, not how much they cost directly.
    uses_sub = [sid for sid, sw in sess_sub_weight.items() if sw > 0]
    uses_weight = sum(sess_weight[sid] for sid in uses_sub)
    uses_cost = sum(sess_cost[sid] for sid in uses_sub)

    long_sids = [
        sid for sid in sess_weight
        if _span_hours(*session_spans.get(sid, (None, None))) >= LONG_SESSION_HOURS
    ]
    long_weight = sum(sess_weight[sid] for sid in long_sids)
    long_cost = sum(sess_cost[sid] for sid in long_sids)

    chars: list[dict[str, Any]] = [
        _char("subagent_usage", "subagent turns", "subagent",
              sub_weight_total, sub_cost_total, total),
        _char("subagent_sessions", "sessions that use subagents", "session",
              uses_weight, uses_cost, total),
        _char("context_gt_150k", f">{CONTEXT_BAND_TOKENS // 1000}k context", "call",
              ctx_weight, ctx_cost, total),
        _char("duration_gte_8h", f"sessions active for {LONG_SESSION_HOURS}+ hours",
              "session", long_weight, long_cost, total),
    ]
    for atype, wt in type_weight.items():
        share = wt / total if total > 0 else 0.0
        if share >= AGENT_TYPE_MIN_SHARE:
            chars.append(_char(
                f"agent_type:{atype}", f'subagents under "{atype}"', "subagent",
                wt, type_cost[atype], total))

    chars.sort(key=lambda c: c["share"], reverse=True)
    return chars


def _session_spans(
    conn: sqlite3.Connection, project_id: int | None,
) -> dict[int, tuple[str | None, str | None]]:
    sql = "SELECT id, first_ts, last_ts FROM sessions"
    params: list[Any] = []
    if project_id is not None:
        sql += " WHERE project_id = ?"
        params.append(project_id)
    return {row["id"]: (row["first_ts"], row["last_ts"])
            for row in conn.execute(sql, params).fetchall()}


def _agent_types(
    conn: sqlite3.Connection, project_id: int | None,
) -> dict[tuple[int, str], str]:
    sql = ("SELECT sa.parent_session_id AS sid, sa.agent_id, sa.agent_type "
           "FROM subagents sa JOIN sessions s ON s.id = sa.parent_session_id")
    params: list[Any] = []
    if project_id is not None:
        sql += " WHERE s.project_id = ?"
        params.append(project_id)
    return {(row["sid"], row["agent_id"]): (row["agent_type"] or "unspecified")
            for row in conn.execute(sql, params).fetchall()}


def usage_characteristics_analytics(
    conn: sqlite3.Connection,
    *,
    project_id: int | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
) -> dict[str, Any]:
    """Overlapping-characteristics payload for the filtered corpus."""
    table = load_price_table(pricing_path())
    cost_available = bool(table)
    events = load_events(conn, table, project_id=project_id,
                         date_from=date_from, date_to=date_to)
    total_usd = sum(e.cost for e in events)
    total_tokens = sum(e.tokens for e in events)
    use_cost = cost_available and total_usd > 0
    characteristics = compute_characteristics(
        events,
        session_spans=_session_spans(conn, project_id),
        agent_types=_agent_types(conn, project_id),
        use_cost=use_cost,
    )
    return {
        "meta": {
            "project_id": project_id,
            "window": {"date_from": date_from, "date_to": date_to},
            "total_usd": round(total_usd, 6),
            "total_tokens": int(round(total_tokens)),
            "cost_available": cost_available,
            "costs_partial": any(not e.priced for e in events),
            "sessions_analyzed": len({e.session_db_id for e in events}),
            "share_basis": "cost" if use_cost else "tokens",
            "basis_note": BASIS_NOTE if use_cost else TOKEN_BASIS_NOTE,
        },
        "characteristics": characteristics,
    }
