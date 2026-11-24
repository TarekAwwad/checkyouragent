"""Usage Characteristics: overlapping (non-partition) properties of usage.

Mirrors /usage's "what's contributing to your limits usage?" panel: each entry
is an independent characteristic with a short label and its share of usage, not
a breakdown, so shares may overlap and need not sum to 1. Cost-weighted
(token-weighted when no pricing); thresholds are pinned to /usage for visual
comparability. What each characteristic means, and the advice that goes with
it, lives in the frontend glossary, not in this payload.

Built on usage_map.load_events so the denominator equals the usage-map total.
Computation is on-demand from the rebuildable SQLite cache, like discovery.py.
Design doc: docs/superpowers/specs/2026-06-16-usage-characteristics-design.md
"""

from __future__ import annotations

import sqlite3
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from ccfr.analysis.pricing import load_price_timeline
from ccfr.analysis.usage_map import EventRec, load_events
from ccfr.config import pricing_dir, pricing_path

# Thresholds pinned to /usage (tunable). The labels below quote them, and the
# glossary entries for each driver repeat them, so change all three together.
CONTEXT_BAND_TOKENS = 150_000
LONG_SESSION_HOURS = 8
AGENT_TYPE_MIN_SHARE = 0.05


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


@dataclass
class _Sums:
    """Running totals for one characteristic: share weight, USD and tokens."""
    weight: float = 0.0
    cost: float = 0.0
    tokens: float = 0.0

    def add(self, e: EventRec, w: float) -> None:
        self.weight += w
        self.cost += e.cost
        self.tokens += e.tokens

    def absorb(self, other: _Sums) -> None:
        self.weight += other.weight
        self.cost += other.cost
        self.tokens += other.tokens


def _char(key: str, label: str, kind: str, sums: _Sums, total: float) -> dict[str, Any]:
    return {
        "key": key,
        "label": label,
        "kind": kind,
        "share": round(sums.weight / total, 6) if total > 0 else 0.0,
        "cost_usd": round(sums.cost, 6),
        "tokens": int(round(sums.tokens)),
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
    and `tokens` are always the USD and token sums. Returned list is sorted by
    share descending.
    """
    def weight(e: EventRec) -> float:
        return e.cost if use_cost else float(e.tokens)

    total = sum(weight(e) for e in events)

    sess: dict[int, _Sums] = defaultdict(_Sums)
    sess_sub_weight: dict[int, float] = defaultdict(float)
    sub = _Sums()
    ctx = _Sums()
    by_type: dict[str, _Sums] = defaultdict(_Sums)

    for e in events:
        w = weight(e)
        sess[e.session_db_id].add(e, w)
        if e.agent_id is not None:
            sub.add(e, w)
            sess_sub_weight[e.session_db_id] += w
            atype = agent_types.get((e.session_db_id, e.agent_id), "unspecified")
            by_type[atype].add(e, w)
        if e.input_context_tokens > CONTEXT_BAND_TOKENS:
            ctx.add(e, w)

    # Sessions that involve subagents at all: count the WHOLE session (main +
    # subagent) whenever the session spawned >=1 subagent. Distinct from the
    # direct attribution (`sub`) — this measures how pervasive subagents are in
    # the workflow, not how much they cost directly.
    uses_sub = _Sums()
    for sid, sw in sess_sub_weight.items():
        if sw > 0:
            uses_sub.absorb(sess[sid])

    long_sessions = _Sums()
    for sid, sums in sess.items():
        if _span_hours(*session_spans.get(sid, (None, None))) >= LONG_SESSION_HOURS:
            long_sessions.absorb(sums)

    chars: list[dict[str, Any]] = [
        _char("subagent_usage", "Subagent turns", "subagent", sub, total),
        _char("subagent_sessions", "Sessions with subagents", "session", uses_sub, total),
        _char("context_gt_150k", f"Calls over {CONTEXT_BAND_TOKENS // 1000}k context",
              "call", ctx, total),
        _char("duration_gte_8h", f"Sessions active {LONG_SESSION_HOURS}h+",
              "session", long_sessions, total),
    ]
    for atype, sums in by_type.items():
        share = sums.weight / total if total > 0 else 0.0
        if share >= AGENT_TYPE_MIN_SHARE:
            chars.append(_char(f"agent_type:{atype}", f"Subagent: {atype}",
                               "subagent", sums, total))

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
    historical: bool = True,
    project_id: int | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
) -> dict[str, Any]:
    """Overlapping-characteristics payload for the filtered corpus."""
    timeline = load_price_timeline(pricing_path(), pricing_dir())
    cost_available = timeline.has_prices
    events = load_events(conn, timeline, historical=historical, project_id=project_id,
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
        },
        "characteristics": characteristics,
    }
