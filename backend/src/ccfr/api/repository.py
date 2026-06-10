from __future__ import annotations

import json
import sqlite3
from typing import Any

from ccfr.analysis.pricing import (
    TokenBreakdown,
    cost_usd,
    load_price_table,
    match_price,
)
from ccfr.analysis.trace import build_trace
from ccfr.naming import project_display_name
from ccfr.config import pricing_path

_COST_CATEGORIES = ("base_input", "cache_write_5m", "cache_write_1h", "cache_read", "output")


def session_cost(conn: sqlite3.Connection, session_id: int) -> dict[str, Any]:
    """Estimate the session's dollar cost from per-model token breakdowns.

    Tokens are grouped by model and priced via pricing.csv (per million). Models with
    usage but no price row are reported in ``unpriced_models`` so the UI can flag that
    the estimate is partial. When no price table is available, ``available`` is False.
    """
    table = load_price_table(pricing_path())
    rows = conn.execute(
        """
        SELECT
            m.model AS model,
            COALESCE(SUM(m.base_input_tokens), 0) AS base_input,
            COALESCE(SUM(m.cache_5m_tokens), 0) AS cache_write_5m,
            COALESCE(SUM(m.cache_1h_tokens), 0) AS cache_write_1h,
            COALESCE(SUM(m.cache_read_tokens), 0) AS cache_read,
            COALESCE(SUM(m.output_tokens), 0) AS output
        FROM messages m
        JOIN events e ON e.id = m.event_id
        WHERE e.session_id = ?
        GROUP BY m.model
        """,
        (session_id,),
    ).fetchall()

    total_usd = 0.0
    tokens_total = {category: 0 for category in _COST_CATEGORIES}
    unpriced: set[str] = set()
    for row in rows:
        breakdown = TokenBreakdown(**{category: int(row[category]) for category in _COST_CATEGORIES})
        used = any(getattr(breakdown, category) for category in _COST_CATEGORIES)
        for category in _COST_CATEGORIES:
            tokens_total[category] += getattr(breakdown, category)
        price = match_price(table, row["model"])
        if price is None:
            if used and row["model"]:
                unpriced.add(row["model"])
            continue
        total_usd += cost_usd(price, breakdown)

    return {
        "usd": round(total_usd, 6),
        "available": bool(table),
        "unpriced_models": sorted(unpriced),
        "tokens": tokens_total,
    }


def session_cost_map(conn: sqlite3.Connection) -> tuple[dict[int, float], bool]:
    """Estimate every session's dollar cost in one pass.

    Returns ``({session_id: usd}, available)``. ``available`` is False when no price
    table is loaded; sessions whose models are all unpriced are simply absent from the
    map (treated as 0 by callers). Costs are rounded to match :func:`session_cost`.
    """
    table = load_price_table(pricing_path())
    rows = conn.execute(
        """
        SELECT
            e.session_id AS session_id,
            m.model AS model,
            COALESCE(SUM(m.base_input_tokens), 0) AS base_input,
            COALESCE(SUM(m.cache_5m_tokens), 0) AS cache_write_5m,
            COALESCE(SUM(m.cache_1h_tokens), 0) AS cache_write_1h,
            COALESCE(SUM(m.cache_read_tokens), 0) AS cache_read,
            COALESCE(SUM(m.output_tokens), 0) AS output
        FROM messages m
        JOIN events e ON e.id = m.event_id
        GROUP BY e.session_id, m.model
        """
    ).fetchall()

    costs: dict[int, float] = {}
    for row in rows:
        price = match_price(table, row["model"])
        if price is None:
            continue
        breakdown = TokenBreakdown(**{category: int(row[category]) for category in _COST_CATEGORIES})
        costs[row["session_id"]] = costs.get(row["session_id"], 0.0) + cost_usd(price, breakdown)
    return {sid: round(usd, 6) for sid, usd in costs.items()}, bool(table)


def project_cost_map(conn: sqlite3.Connection) -> tuple[dict[int, float], bool]:
    """Aggregate session costs to ``({project_id: usd}, available)``."""
    session_costs, available = session_cost_map(conn)
    project_costs: dict[int, float] = {}
    if session_costs:
        for row in conn.execute("SELECT id, project_id FROM sessions").fetchall():
            usd = session_costs.get(row["id"])
            if usd:
                project_costs[row["project_id"]] = project_costs.get(row["project_id"], 0.0) + usd
    return {pid: round(usd, 6) for pid, usd in project_costs.items()}, available


def rows_to_dicts(rows: list[sqlite3.Row]) -> list[dict[str, Any]]:
    return [dict(row) for row in rows]


def list_imports(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    return rows_to_dicts(conn.execute("SELECT * FROM imports ORDER BY imported_at DESC").fetchall())


def cache_stats(conn: sqlite3.Connection) -> dict[str, int]:
    """Current totals across the whole local cache (independent of any single import)."""
    counts = {
        "project_count": "SELECT COUNT(*) FROM projects",
        "session_count": "SELECT COUNT(*) FROM sessions",
        "event_count": "SELECT COUNT(*) FROM events",
        "subagent_count": "SELECT COUNT(*) FROM subagents",
        "memory_count": "SELECT COUNT(*) FROM memory_nodes",
        "persisted_output_count": "SELECT COUNT(*) FROM persisted_outputs",
    }
    return {key: conn.execute(sql).fetchone()[0] for key, sql in counts.items()}


def import_summary_stats(conn: sqlite3.Connection, import_id: int) -> dict[str, int]:
    """Current counts for one import, including rows not yet committed."""
    counts = {
        "project_count": "SELECT COUNT(*) FROM projects WHERE import_id = ?",
        "session_count": """
            SELECT COUNT(*)
            FROM sessions s
            JOIN projects p ON p.id = s.project_id
            WHERE p.import_id = ?
        """,
        "event_count": """
            SELECT COUNT(*)
            FROM events e
            JOIN sessions s ON s.id = e.session_id
            JOIN projects p ON p.id = s.project_id
            WHERE p.import_id = ?
        """,
        "subagent_count": """
            SELECT COUNT(*)
            FROM subagents sa
            JOIN sessions s ON s.id = sa.parent_session_id
            JOIN projects p ON p.id = s.project_id
            WHERE p.import_id = ?
        """,
        "memory_count": """
            SELECT COUNT(*)
            FROM memory_nodes m
            JOIN projects p ON p.id = m.project_id
            WHERE p.import_id = ?
        """,
        "persisted_output_count": """
            SELECT COUNT(*)
            FROM persisted_outputs po
            JOIN sessions s ON s.id = po.session_id
            JOIN projects p ON p.id = s.project_id
            WHERE p.import_id = ?
        """,
    }
    return {key: int(conn.execute(sql, (import_id,)).fetchone()[0]) for key, sql in counts.items()}


def list_projects(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT
            p.id,
            p.export_name,
            p.inferred_cwd,
            COUNT(DISTINCT s.id) AS session_count,
            COUNT(DISTINCT e.id) AS event_count,
            COUNT(DISTINCT sa.id) AS subagent_count
        FROM projects p
        LEFT JOIN sessions s ON s.project_id = p.id
        LEFT JOIN events e ON e.session_id = s.id
        LEFT JOIN subagents sa ON sa.parent_session_id = s.id
        GROUP BY p.id
        ORDER BY p.export_name
        """
    ).fetchall()
    costs, available = project_cost_map(conn)
    projects = rows_to_dicts(rows)
    for project in projects:
        project["display_name"] = project_display_name(project["export_name"], project["inferred_cwd"])
        project["cost_usd"] = costs.get(project["id"], 0.0)
        project["cost_available"] = available
    return projects


def list_sessions(
    conn: sqlite3.Connection,
    *,
    project_id: int | None = None,
    session_id: int | None = None,
    q: str | None = None,
    has_subagents: bool | None = None,
    has_errors: bool | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    with_cost: bool = True,
) -> list[dict[str, Any]]:
    clauses: list[str] = []
    params: list[Any] = []
    if project_id is not None:
        clauses.append("s.project_id = ?")
        params.append(project_id)
    if session_id is not None:
        clauses.append("s.id = ?")
        params.append(session_id)
    if has_subagents is not None:
        clauses.append("COALESCE(ss.subagent_count, 0) > 0" if has_subagents else "COALESCE(ss.subagent_count, 0) = 0")
    if has_errors is not None:
        actual_error_count = "(SELECT COUNT(*) FROM tool_results tr WHERE tr.session_id = s.id AND tr.is_error = 1)"
        clauses.append(f"{actual_error_count} > 0" if has_errors else f"{actual_error_count} = 0")
    if date_from:
        clauses.append("s.last_ts >= ?")
        params.append(date_from)
    if date_to:
        clauses.append("s.first_ts <= ?")
        params.append(date_to)
    if q:
        clauses.append(
            """
            s.id IN (
                SELECT CAST(session_id AS INTEGER)
                FROM search_index
                WHERE session_id IS NOT NULL AND search_index MATCH ?
            )
            """
        )
        params.append(_fts_query(q))
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    rows = conn.execute(
        f"""
        SELECT
            s.id,
            s.project_id,
            p.export_name AS project_name,
            p.inferred_cwd AS project_cwd,
            s.session_id,
            s.title,
            s.first_ts,
            s.last_ts,
            s.cwd,
            s.version,
            s.entrypoint,
            s.git_branch,
            COALESCE(ss.event_count, 0) AS event_count,
            COALESCE(ss.turn_count, 0) AS turn_count,
            COALESCE(ss.tool_call_count, 0) AS tool_call_count,
            COALESCE(ss.subagent_count, 0) AS subagent_count,
            COALESCE(
                (SELECT COUNT(*) FROM tool_results tr WHERE tr.session_id = s.id AND tr.is_error = 1),
                0
            ) AS error_count,
            COALESCE(ss.system_count, 0) AS system_count,
            COALESCE(ss.persisted_output_count, 0) AS persisted_output_count,
            COALESCE(ss.input_tokens, 0) AS input_tokens,
            COALESCE(ss.output_tokens, 0) AS output_tokens,
            COALESCE(ss.loop_count, 0) AS loop_count,
            COALESCE(ss.max_repeat, 0) AS max_repeat,
            CAST(
                ROUND(COALESCE((julianday(s.last_ts) - julianday(s.first_ts)) * 86400, 0)) AS INTEGER
            ) AS duration_seconds,
            COALESCE(
                (SELECT MAX(event_count) FROM subagents WHERE parent_session_id = s.id), 0
            ) AS max_agent_events,
            COALESCE(
                (SELECT COUNT(*) FROM risk_findings rf WHERE rf.session_id = s.id), 0
            ) AS finding_count,
            COALESCE(
                (SELECT SUM(rf.score) FROM risk_findings rf WHERE rf.session_id = s.id), 0
            ) AS pattern_risk_score,
            (
                SELECT rf.category FROM risk_findings rf
                WHERE rf.session_id = s.id
                ORDER BY rf.score DESC, rf.id ASC
                LIMIT 1
            ) AS top_finding_category,
            (
                SELECT rf.severity FROM risk_findings rf
                WHERE rf.session_id = s.id
                ORDER BY rf.score DESC, rf.id ASC
                LIMIT 1
            ) AS top_finding_severity,
            (
                SELECT rf.title FROM risk_findings rf
                WHERE rf.session_id = s.id
                ORDER BY rf.score DESC, rf.id ASC
                LIMIT 1
            ) AS top_finding_title
        FROM sessions s
        JOIN projects p ON p.id = s.project_id
        LEFT JOIN session_stats ss ON ss.session_id = s.id
        {where}
        ORDER BY COALESCE(s.last_ts, s.first_ts) DESC, s.id DESC
        """,
        params,
    ).fetchall()
    sessions = rows_to_dicts(rows)
    costs, available = session_cost_map(conn) if with_cost else ({}, False)
    for session in sessions:
        session["project_name"] = project_display_name(
            session["project_name"], session.pop("project_cwd", None) or session.get("cwd"),
        )
        session["cost_usd"] = costs.get(session["id"], 0.0)
        session["cost_available"] = available
    return sessions


def get_session(conn: sqlite3.Connection, session_id: int) -> dict[str, Any] | None:
    # Cost is skipped here: this powers 404 guards and the single-session card, neither of
    # which surfaces cost (the triage list and trace endpoint carry it), so the token
    # GROUP-BY is avoided. The session_id filter makes this a single-row PK lookup
    # rather than a full session listing.
    rows = list_sessions(conn, session_id=session_id, with_cost=False)
    return rows[0] if rows else None


def get_timeline(conn: sqlite3.Connection, session_id: int) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT
            e.id AS event_id,
            e.type AS event_type,
            e.timestamp,
            e.is_sidechain,
            e.agent_id,
            m.role,
            m.text_preview,
            tc.tool_name,
            tc.tool_use_id,
            tr.is_error,
            tr.output_preview
        FROM events e
        LEFT JOIN messages m ON m.event_id = e.id
        LEFT JOIN tool_calls tc ON tc.event_id = e.id
        LEFT JOIN tool_results tr ON tr.event_id = e.id
        WHERE e.session_id = ?
        ORDER BY COALESCE(e.timestamp, ''), e.id
        """,
        (session_id,),
    ).fetchall()
    items: list[dict[str, Any]] = []
    for row in rows:
        kind = _timeline_kind(row)
        title = _timeline_title(row, kind)
        preview = row["text_preview"] or row["output_preview"]
        related = [
            edge["target_event_id"]
            for edge in conn.execute(
                "SELECT target_event_id FROM event_edges WHERE source_event_id = ?",
                (row["event_id"],),
            ).fetchall()
        ]
        items.append(
            {
                "id": f"event-{row['event_id']}",
                "event_id": row["event_id"],
                "kind": kind,
                "title": title,
                "timestamp": row["timestamp"],
                "preview": preview,
                "event_type": row["event_type"],
                "role": row["role"],
                "tool_name": row["tool_name"],
                "agent_id": row["agent_id"],
                "is_sidechain": bool(row["is_sidechain"]),
                "related_event_ids": related,
            }
        )
    return items



def get_trace(conn: sqlite3.Connection, session_id: int) -> dict[str, Any]:
    rows = conn.execute(
        """
        SELECT
            e.id AS event_id,
            e.type AS event_type,
            e.timestamp,
            e.is_sidechain,
            e.agent_id,
            m.role,
            m.model,
            m.input_tokens,
            m.output_tokens
        FROM events e
        LEFT JOIN messages m ON m.event_id = e.id
        WHERE e.session_id = ?
        ORDER BY COALESCE(e.timestamp, ''), e.id
        """,
        (session_id,),
    ).fetchall()

    # One representative tool_call / tool_result per event (first by row id),
    # so an event with several parallel tool_use blocks still yields one span.
    tool_call_by_event: dict[int, dict[str, Any]] = {}
    for r in conn.execute(
        "SELECT event_id, tool_name, tool_use_id FROM tool_calls WHERE session_id = ? ORDER BY id",
        (session_id,),
    ).fetchall():
        tool_call_by_event.setdefault(
            r["event_id"], {"tool_name": r["tool_name"], "tool_use_id": r["tool_use_id"]}
        )

    tool_result_by_event: dict[int, dict[str, Any]] = {}
    for r in conn.execute(
        "SELECT event_id, is_error, output_preview FROM tool_results WHERE session_id = ? ORDER BY id",
        (session_id,),
    ).fetchall():
        tool_result_by_event.setdefault(
            r["event_id"], {"is_error": r["is_error"], "output_preview": r["output_preview"]}
        )

    result_ts: dict[str, str] = {}
    for r in conn.execute(
        """
        SELECT tr.tool_use_id, e.timestamp
        FROM tool_results tr
        JOIN events e ON e.id = tr.event_id
        WHERE tr.session_id = ? AND tr.tool_use_id IS NOT NULL AND e.timestamp IS NOT NULL
        """,
        (session_id,),
    ).fetchall():
        result_ts.setdefault(r["tool_use_id"], r["timestamp"])

    normalized: list[dict[str, Any]] = []
    for r in rows:
        tc = tool_call_by_event.get(r["event_id"], {})
        tr = tool_result_by_event.get(r["event_id"], {})
        kind_row = {
            "tool_name": tc.get("tool_name"),
            "output_preview": tr.get("output_preview"),
            "event_type": r["event_type"],
            "is_error": tr.get("is_error", 0),
            "is_sidechain": r["is_sidechain"],
            "role": r["role"],
        }
        normalized.append(
            {
                "event_id": r["event_id"],
                "kind": _timeline_kind(kind_row),
                "timestamp": r["timestamp"],
                "tool_name": tc.get("tool_name"),
                "tool_use_id": tc.get("tool_use_id"),
                "agent_id": r["agent_id"],
                "is_sidechain": bool(r["is_sidechain"]),
                "model": r["model"],
                "input_tokens": int(r["input_tokens"] or 0),
                "output_tokens": int(r["output_tokens"] or 0),
            }
        )
    trace = build_trace(session_id=session_id, rows=normalized, result_ts_by_use_id=result_ts)
    trace["cost"] = session_cost(conn, session_id)
    return trace


def list_subagents(conn: sqlite3.Connection, session_id: int) -> list[dict[str, Any]]:
    return rows_to_dicts(
        conn.execute(
            """
            SELECT id, agent_id, agent_type, description, name, tool_use_id, event_count, first_ts, last_ts
            FROM subagents
            WHERE parent_session_id = ?
            ORDER BY event_count DESC, agent_id
            """,
            (session_id,),
        ).fetchall()
    )


def list_risk_findings(conn: sqlite3.Connection, session_id: int) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT
            rf.id,
            rf.session_id,
            rf.severity,
            rf.category,
            rf.title,
            rf.explanation,
            rf.start_event_id,
            rf.end_event_id,
            rf.score,
            rf.evidence_json,
            sp.pattern_json,
            COALESCE(sp.support, 0) AS support,
            COALESCE(sp.positive_support, 0) AS positive_support,
            COALESCE(sp.negative_support, 0) AS negative_support,
            COALESCE(sp.lift, 0) AS lift
        FROM risk_findings rf
        LEFT JOIN sequence_patterns sp ON sp.id = rf.pattern_id
        WHERE rf.session_id = ?
        ORDER BY
            CASE rf.severity
                WHEN 'high' THEN 0
                WHEN 'medium' THEN 1
                ELSE 2
            END,
            rf.score DESC,
            rf.id ASC
        """,
        (session_id,),
    ).fetchall()
    findings: list[dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        item["pattern"] = _loads_json_list(item.pop("pattern_json"))
        item["evidence"] = _loads_json_dict(item.pop("evidence_json"))
        findings.append(item)
    return findings


def get_event(conn: sqlite3.Connection, event_id: int, *, include_raw: bool = True) -> dict[str, Any] | None:
    row = conn.execute(
        """
        SELECT
            e.*,
            i.source_path AS import_source_path,
            m.role,
            m.model,
            m.text_preview
        FROM events e
        JOIN sessions s ON s.id = e.session_id
        JOIN projects p ON p.id = s.project_id
        JOIN imports i ON i.id = p.import_id
        LEFT JOIN messages m ON m.event_id = e.id
        WHERE e.id = ?
        """,
        (event_id,),
    ).fetchone()
    if row is None:
        return None
    tool_calls = rows_to_dicts(
        conn.execute(
            "SELECT id, tool_use_id, tool_name, input_preview FROM tool_calls WHERE event_id = ?",
            (event_id,),
        ).fetchall()
    )
    tool_results = rows_to_dicts(
        conn.execute(
            """
            SELECT tr.id, tr.tool_use_id, tr.is_error, tr.output_preview, po.path AS persisted_output_path
            FROM tool_results tr
            LEFT JOIN persisted_outputs po ON po.id = tr.persisted_output_id
            WHERE tr.event_id = ?
            """,
            (event_id,),
        ).fetchall()
    )
    related = [
        item
        for edge in conn.execute(
            """
            SELECT source_event_id, target_event_id FROM event_edges
            WHERE source_event_id = ? OR target_event_id = ?
            """,
            (event_id, event_id),
        ).fetchall()
        for item in (edge["source_event_id"], edge["target_event_id"])
        if item != event_id
    ]
    return {
        "id": row["id"],
        "session_id": row["session_id"],
        "uuid": row["uuid"],
        "parent_uuid": row["parent_uuid"],
        "type": row["type"],
        "timestamp": row["timestamp"],
        "is_sidechain": bool(row["is_sidechain"]),
        "agent_id": row["agent_id"],
        "source_path": row["source_path"],
        "line_no": row["line_no"],
        "role": row["role"],
        "model": row["model"],
        "text_preview": row["text_preview"],
        "tool_calls": tool_calls,
        "tool_results": tool_results,
        "related_event_ids": sorted(set(related)),
        "raw_json": _load_raw_event(row) if include_raw else None,
    }


def search(
    conn: sqlite3.Connection,
    *,
    q: str,
    project_id: int | None = None,
    session_id: int | None = None,
) -> list[dict[str, Any]]:
    clauses = ["search_index MATCH ?"]
    params: list[Any] = [_fts_query(q)]
    if project_id is not None:
        clauses.append("project_id = ?")
        params.append(project_id)
    if session_id is not None:
        clauses.append("session_id = ?")
        params.append(session_id)
    rows = conn.execute(
        f"""
        SELECT kind, CAST(ref_id AS INTEGER) AS ref_id, project_id, session_id, title, snippet(search_index, 5, '[', ']', '…', 12) AS preview
        FROM search_index
        WHERE {' AND '.join(clauses)}
        LIMIT 100
        """,
        params,
    ).fetchall()
    return rows_to_dicts(rows)


def _fts_query(q: str) -> str:
    terms = [term.replace('"', "") for term in q.strip().split() if term.strip()]
    if not terms:
        return '""'
    return " OR ".join(f'"{term}"' for term in terms)


def _loads_json_list(value: Any) -> list[str]:
    if not value:
        return []
    try:
        loaded = json.loads(str(value))
    except json.JSONDecodeError:
        return []
    if not isinstance(loaded, list):
        return []
    return [str(item) for item in loaded]


def _loads_json_dict(value: Any) -> dict[str, Any]:
    if not value:
        return {}
    try:
        loaded = json.loads(str(value))
    except json.JSONDecodeError:
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _timeline_kind(row: sqlite3.Row) -> str:
    if row["is_error"]:
        return "system"
    if row["event_type"] == "system":
        return "system"
    if row["tool_name"]:
        return "tool_call"
    if row["output_preview"]:
        return "tool_result"
    if row["is_sidechain"]:
        return "subagent_event"
    if row["role"] == "user":
        return "user_turn"
    if row["role"] == "assistant":
        return "assistant"
    return row["event_type"]


def _timeline_title(row: sqlite3.Row, kind: str) -> str:
    if row["is_error"]:
        return "Tool error"
    if kind == "tool_call":
        return f"Tool call: {row['tool_name']}"
    if kind == "tool_result":
        return "Tool result"
    if kind == "subagent_event":
        return f"Subagent {row['agent_id'] or ''}".strip()
    if kind == "user_turn":
        return "User turn"
    if kind == "assistant":
        return "Assistant response"
    if kind == "system":
        return "System event"
    return str(row["event_type"])


def _load_raw_event(row: sqlite3.Row) -> dict[str, Any]:
    from pathlib import Path

    source_root = Path(row["import_source_path"])
    source_file = source_root / row["source_path"]
    try:
        with source_file.open("r", encoding="utf-8", errors="replace") as fh:
            for current, line in enumerate(fh, start=1):
                if current == row["line_no"]:
                    return json.loads(line)
    except (OSError, json.JSONDecodeError):
        pass
    return json.loads(row["raw_json"])
