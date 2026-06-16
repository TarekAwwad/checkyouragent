# backend/src/ccfr/api/analytics.py
"""Cross-session token/cost analytics: builds the payload for GET /api/analytics/cost.

Reuses ccfr.analysis.pricing to turn per-message token sums into dollars. Cost cannot be
summed in SQL (prices come from pricing.csv), so SQL returns grouped token counts and Python
applies prices — the same approach as repository.session_cost_map.
"""
from __future__ import annotations

import sqlite3
from bisect import bisect_right
from datetime import datetime
from typing import Any

from ccfr.analysis.pricing import (
    ModelPrice,
    PriceTimeline,
    TokenBreakdown,
    cost_usd,
    load_price_timeline,
    match_price,
    normalize_model_key,
)
from ccfr.analysis.metrics import compute_loop_stats
from ccfr.naming import project_display_name
from ccfr.config import pricing_dir, pricing_path

# Payload category -> messages column. input_tokens == base+5m+1h+read, so we sum the four
# breakdown columns plus output and never touch input_tokens (avoids double counting).
_CATEGORY_COLUMNS = {
    "base_input": "base_input_tokens",
    "cache_write_5m": "cache_5m_tokens",
    "cache_write_1h": "cache_1h_tokens",
    "cache_read": "cache_read_tokens",
    "output": "output_tokens",
}
_CATEGORIES = tuple(_CATEGORY_COLUMNS)


def bucket_for_range(start: str | None, end: str | None) -> str:
    """'day' when the span is <= 92 days, else 'week'. Missing/invalid bounds -> 'day'.

    Inverted or invalid spans (end before start) also fall back to 'day'."""
    if not start or not end:
        return "day"
    try:
        s = datetime.fromisoformat(start.replace("Z", "+00:00"))
        e = datetime.fromisoformat(end.replace("Z", "+00:00"))
    except ValueError:
        return "day"
    return "week" if (e - s).days > 92 else "day"


def _where(date_from: str | None, date_to: str | None, project_id: int | None) -> tuple[str, list[Any]]:
    """Build the shared SQL WHERE fragment (date + project). Model filtering is done in
    Python after grouping, so normalize_model_key can fold dated release suffixes."""
    clauses: list[str] = []
    params: list[Any] = []
    if date_from:
        clauses.append("e.timestamp >= ?")
        params.append(date_from)
    if date_to:
        clauses.append("e.timestamp <= ?")
        params.append(date_to)
    if project_id is not None:
        clauses.append("s.project_id = ?")
        params.append(project_id)
    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    return where, params


def _token_sum_select() -> str:
    return ", ".join(f"COALESCE(SUM(m.{col}),0) AS {cat}" for cat, col in _CATEGORY_COLUMNS.items())


def _token_value_select() -> str:
    return ", ".join(f"COALESCE(m.{col},0) AS {cat}" for cat, col in _CATEGORY_COLUMNS.items())


def _breakdown(row: sqlite3.Row) -> TokenBreakdown:
    return TokenBreakdown(**{cat: int(row[cat]) for cat in _CATEGORIES})


def _tokens_total(row: sqlite3.Row) -> int:
    return sum(int(row[cat]) for cat in _CATEGORIES)


def _input_tokens_total(breakdown: TokenBreakdown) -> int:
    return (
        breakdown.base_input
        + breakdown.cache_write_5m
        + breakdown.cache_write_1h
        + breakdown.cache_read
    )


def _cache_write_tokens_total(breakdown: TokenBreakdown) -> int:
    return breakdown.cache_write_5m + breakdown.cache_write_1h


def _observed_input_usd(price: ModelPrice, breakdown: TokenBreakdown) -> float:
    return (
        breakdown.base_input * price.base_input
        + breakdown.cache_write_5m * price.cache_write_5m
        + breakdown.cache_write_1h * price.cache_write_1h
        + breakdown.cache_read * price.cache_read
    ) / 1_000_000


def _no_cache_input_usd(price: ModelPrice, breakdown: TokenBreakdown) -> float:
    return _input_tokens_total(breakdown) * price.base_input / 1_000_000


def _percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    pos = (len(ordered) - 1) * pct
    lower = int(pos)
    upper = min(lower + 1, len(ordered) - 1)
    if lower == upper:
        return ordered[lower]
    weight = pos - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def _outlier_threshold(values: list[float]) -> float:
    if not values:
        return 0.0
    q1 = _percentile(values, 0.25)
    q3 = _percentile(values, 0.75)
    return q3 + (q3 - q1) * 1.5


def _turn_cost_stat(values: list[float]) -> dict[str, Any]:
    if not values:
        return {
            "turn_count": 0,
            "median_usd": 0.0,
            "p95_usd": 0.0,
            "max_usd": 0.0,
            "outlier_count": 0,
        }
    threshold = _outlier_threshold(values)
    return {
        "turn_count": len(values),
        "median_usd": round(_percentile(values, 0.5), 6),
        "p95_usd": round(_percentile(values, 0.95), 6),
        "max_usd": round(max(values), 6),
        "outlier_count": sum(1 for value in values if value > threshold),
    }


def session_turn_cost_breakdown(conn: sqlite3.Connection, session_id: int, *, historical: bool = True) -> dict[str, Any]:
    timeline = load_price_timeline(pricing_path(), pricing_dir())
    turn_start_rows = conn.execute(
        """
        SELECT
            e.id AS start_event_id,
            e.timestamp AS start_timestamp,
            m.text_preview AS preview
        FROM events e
        JOIN messages m ON m.event_id = e.id
        WHERE e.session_id = ?
          AND e.is_sidechain = 0
          AND m.role = 'user'
        ORDER BY e.id
        """,
        (session_id,),
    ).fetchall()

    if not turn_start_rows:
        return {
            "session_id": session_id,
            "turn_count": 0,
            "median_usd": 0.0,
            "p95_usd": 0.0,
            "max_usd": 0.0,
            "outlier_threshold_usd": 0.0,
            "outlier_count": 0,
            "turns": [],
        }

    turn_ids = [int(row["start_event_id"]) for row in turn_start_rows]
    turns: list[dict[str, Any]] = []
    turns_by_start: dict[int, dict[str, Any]] = {}
    for index, row in enumerate(turn_start_rows, start=1):
        turn = {
            "index": index,
            "start_event_id": int(row["start_event_id"]),
            "title": f"Turn {index}",
            "preview": row["preview"] or None,
            "start_timestamp": row["start_timestamp"],
            "usd": 0.0,
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_read_tokens": 0,
            "cache_write_tokens": 0,
            "event_count": 0,
            "assistant_message_count": 0,
            "tool_call_count": 0,
            "error_count": 0,
            "subagent_count": 0,
            "_models": set(),
            "_tool_names": [],
        }
        turns.append(turn)
        turns_by_start[turn["start_event_id"]] = turn

    tool_call_count_by_event: dict[int, int] = {}
    tool_names_by_event: dict[int, list[str]] = {}
    for row in conn.execute(
        "SELECT event_id, tool_name FROM tool_calls WHERE session_id = ? ORDER BY id",
        (session_id,),
    ).fetchall():
        event_id = int(row["event_id"])
        tool_call_count_by_event[event_id] = tool_call_count_by_event.get(event_id, 0) + 1
        tool_name = row["tool_name"]
        if tool_name:
            tool_names_by_event.setdefault(event_id, []).append(str(tool_name))

    error_events = {
        int(row["event_id"])
        for row in conn.execute(
            "SELECT DISTINCT event_id FROM tool_results WHERE session_id = ? AND is_error = 1",
            (session_id,),
        ).fetchall()
    }

    for row in conn.execute(
        f"""
        SELECT
            e.id AS event_id,
            e.timestamp AS event_ts,
            e.is_sidechain,
            m.role,
            m.model,
            {_token_value_select()}
        FROM events e
        LEFT JOIN messages m ON m.event_id = e.id
        WHERE e.session_id = ?
        ORDER BY e.id
        """,
        (session_id,),
    ).fetchall():
        event_id = int(row["event_id"])
        turn_index = bisect_right(turn_ids, event_id) - 1
        if turn_index < 0:
            continue

        start_event_id = turn_ids[turn_index]
        turn = turns_by_start[start_event_id]
        turn["event_count"] += 1
        if row["role"] == "assistant":
            turn["assistant_message_count"] += 1
        turn["tool_call_count"] += tool_call_count_by_event.get(event_id, 0)
        if event_id in error_events:
            turn["error_count"] += 1
        if row["is_sidechain"]:
            turn["subagent_count"] += 1
        turn["_tool_names"].extend(tool_names_by_event.get(event_id, []))

        model = row["model"]
        if not model:
            continue
        price = timeline.price_for(str(model), row["event_ts"], historical=historical)
        if price is None:
            continue

        breakdown = _breakdown(row)
        turn["usd"] += cost_usd(price, breakdown)
        turn["input_tokens"] += _input_tokens_total(breakdown)
        turn["output_tokens"] += breakdown.output
        turn["cache_read_tokens"] += breakdown.cache_read
        turn["cache_write_tokens"] += _cache_write_tokens_total(breakdown)
        turn["_models"].add(str(model))

    values = [turn["usd"] for turn in turns]
    stats = _turn_cost_stat(values)
    threshold = _outlier_threshold(values)
    detail_rows = []
    for turn in turns:
        loop_count, max_repeat = compute_loop_stats(turn.pop("_tool_names"))
        detail_rows.append(
            {
                **turn,
                "usd": round(turn["usd"], 6),
                "models": sorted(turn.pop("_models")),
                "loop_count": loop_count,
                "max_repeat": max_repeat,
                "is_outlier": turn["usd"] > threshold,
            }
        )

    return {
        "session_id": session_id,
        **stats,
        "outlier_threshold_usd": round(threshold, 6),
        "turns": detail_rows,
    }


def _turn_cost_stats(
    conn: sqlite3.Connection,
    timeline: PriceTimeline,
    *,
    where: str,
    params: list[Any],
    project_id: int | None,
    matches: Any,
    historical: bool = True,
) -> dict[int, dict[str, Any]]:
    if not timeline.has_prices:
        return {}
    project_clause = "AND s.project_id = ?" if project_id is not None else ""
    project_params: list[Any] = [project_id] if project_id is not None else []
    user_rows = conn.execute(
        f"""
        SELECT e.session_id AS session_id, e.id AS start_event_id
        FROM events e
        JOIN messages um ON um.event_id = e.id
        JOIN sessions s ON s.id = e.session_id
        WHERE e.is_sidechain = 0
          AND um.role = 'user'
          {project_clause}
        GROUP BY e.session_id, e.id
        ORDER BY e.session_id, e.id
        """,
        project_params,
    ).fetchall()
    turn_starts_by_session: dict[int, list[int]] = {}
    for row in user_rows:
        turn_starts_by_session.setdefault(row["session_id"], []).append(row["start_event_id"])

    costs_by_turn: dict[int, dict[int, float]] = {}
    for row in conn.execute(
        f"""
        SELECT e.session_id AS session_id, e.id AS event_id, e.timestamp AS event_ts, m.model AS model, { _token_value_select() }
        FROM events e
        JOIN messages m ON m.event_id = e.id
        JOIN sessions s ON s.id = e.session_id
        {where}
        ORDER BY e.session_id, e.id
        """,
        params,
    ).fetchall():
        if not matches(row["model"]):
            continue
        price = timeline.price_for(row["model"], row["event_ts"], historical=historical)
        if price is None:
            continue
        turn_starts = turn_starts_by_session.get(row["session_id"], [])
        turn_index = bisect_right(turn_starts, row["event_id"]) - 1
        if turn_index < 0:
            continue
        start_event_id = turn_starts[turn_index]
        session_turns = costs_by_turn.setdefault(row["session_id"], {})
        session_turns.setdefault(start_event_id, 0.0)
        session_turns[start_event_id] += cost_usd(price, _breakdown(row))

    return {
        session_id: _turn_cost_stat(list(turns.values()))
        for session_id, turns in costs_by_turn.items()
    }


def cost_analytics(
    conn: sqlite3.Connection,
    *,
    date_from: str | None = None,
    date_to: str | None = None,
    project_id: int | None = None,
    model: str | None = None,
    historical: bool = True,
) -> dict[str, Any]:
    timeline = load_price_timeline(pricing_path(), pricing_dir())
    period_expr = timeline.sql_period_expr("e.timestamp", historical=historical)
    price_available = timeline.has_prices
    model_key = normalize_model_key(model) if model else None
    where, params = _where(date_from, date_to, project_id)
    cols = _token_sum_select()

    def _price(period: int | None, model_id: str | None) -> ModelPrice | None:
        return match_price(timeline.table_for_period(period, historical=historical), model_id)

    def matches(raw: str | None) -> bool:
        return model_key is None or normalize_model_key(raw or "") == model_key

    # Effective time span -> bucket granularity for the over_time series.
    span = conn.execute(
        f"SELECT MIN(e.timestamp) AS lo, MAX(e.timestamp) AS hi "
        f"FROM events e JOIN sessions s ON s.id = e.session_id{where}",
        params,
    ).fetchone()
    bucket = bucket_for_range(date_from or span["lo"], date_to or span["hi"])
    bucket_expr = "strftime('%Y-%m-%d', e.timestamp)" if bucket == "day" else "strftime('%Y-%W', e.timestamp)"

    treemap: dict[int, dict[str, Any]] = {}
    by_model: dict[str, dict[str, Any]] = {}
    categories = {cat: {"tokens": 0, "usd": 0.0} for cat in _CATEGORIES}
    cache_economics: dict[str, Any] = {
        "observed_input_usd": 0.0,
        "no_cache_input_usd": 0.0,
        "net_savings_usd": 0.0,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
        "by_model": {},
    }
    unpriced: set[str] = set()
    total_usd = 0.0
    total_tokens = 0

    pm_rows = conn.execute(
        f"""
        SELECT s.project_id AS project_id, p.export_name AS project_name, p.inferred_cwd AS project_cwd,
               m.model AS model, ({period_expr}) AS price_period, {cols}
        FROM messages m
        JOIN events e ON e.id = m.event_id
        JOIN sessions s ON s.id = e.session_id
        JOIN projects p ON p.id = s.project_id
        {where}
        GROUP BY s.project_id, m.model, price_period
        """,
        params,
    ).fetchall()
    for row in pm_rows:
        if not matches(row["model"]):
            continue
        breakdown = _breakdown(row)
        used = any(getattr(breakdown, c) for c in _CATEGORIES)
        price = _price(row["price_period"], row["model"])
        usd = cost_usd(price, breakdown) if price else 0.0
        label = row["model"] or "unknown"
        if price is None and used and row["model"]:
            unpriced.add(row["model"])
        for cat in _CATEGORIES:
            tok = getattr(breakdown, cat)
            categories[cat]["tokens"] += tok
            total_tokens += tok
            if price is not None:
                categories[cat]["usd"] += tok * getattr(price, cat) / 1_000_000
        if price is not None:
            observed_input = _observed_input_usd(price, breakdown)
            no_cache_input = _no_cache_input_usd(price, breakdown)
            cache_economics["observed_input_usd"] += observed_input
            cache_economics["no_cache_input_usd"] += no_cache_input
            cache_model = cache_economics["by_model"].setdefault(
                label,
                {
                    "model": label,
                    "observed_input_usd": 0.0,
                    "no_cache_input_usd": 0.0,
                    "net_savings_usd": 0.0,
                    "input_tokens": 0,
                    "cache_read_tokens": 0,
                    "cache_write_tokens": 0,
                },
            )
            cache_model["observed_input_usd"] += observed_input
            cache_model["no_cache_input_usd"] += no_cache_input
            cache_model["input_tokens"] += _input_tokens_total(breakdown)
            cache_model["cache_read_tokens"] += breakdown.cache_read
            cache_model["cache_write_tokens"] += _cache_write_tokens_total(breakdown)
        cache_economics["cache_read_tokens"] += breakdown.cache_read
        cache_economics["cache_write_tokens"] += _cache_write_tokens_total(breakdown)
        total_usd += usd
        proj = treemap.setdefault(
            row["project_id"],
            {
                "project_id": row["project_id"],
                "project_name": project_display_name(row["project_name"], row["project_cwd"]),
                "usd": 0.0,
                "children": {},
            },
        )
        proj["usd"] += usd
        proj["children"][label] = proj["children"].get(label, 0.0) + usd
        bm = by_model.setdefault(
            label,
            {
                "model": label,
                "usd": 0.0,
                "tokens": 0,
                "input_tokens": 0,
                "output_tokens": 0,
                "cache_read_tokens": 0,
                "cache_write_tokens": 0,
            },
        )
        bm["usd"] += usd
        bm["tokens"] += _tokens_total(row)
        bm["input_tokens"] += _input_tokens_total(breakdown)
        bm["output_tokens"] += breakdown.output
        bm["cache_read_tokens"] += breakdown.cache_read
        bm["cache_write_tokens"] += _cache_write_tokens_total(breakdown)

    over_time: dict[str, dict[str, Any]] = {}
    for row in conn.execute(
        f"""
        SELECT {bucket_expr} AS bucket, m.model AS model, ({period_expr}) AS price_period, {cols}
        FROM messages m
        JOIN events e ON e.id = m.event_id
        JOIN sessions s ON s.id = e.session_id
        {where}
        GROUP BY bucket, m.model, price_period
        """,
        params,
    ).fetchall():
        if row["bucket"] is None or not matches(row["model"]):
            continue
        price = _price(row["price_period"], row["model"])
        if price is None:
            continue
        usd = cost_usd(price, _breakdown(row))
        if usd == 0:
            continue
        b = over_time.setdefault(row["bucket"], {"bucket": row["bucket"], "per_model": {}})
        label = row["model"] or "unknown"
        b["per_model"][label] = round(b["per_model"].get(label, 0.0) + usd, 6)

    sessions: dict[int, dict[str, Any]] = {}
    for row in conn.execute(
        f"""
        SELECT s.id AS id, s.session_id AS session_id, s.title AS title,
               p.export_name AS project_name, p.inferred_cwd AS project_cwd, m.model AS model,
               ({period_expr}) AS price_period,
               COALESCE(ss.turn_count, 0) AS turn_count,
               COALESCE(ss.tool_call_count, 0) AS tool_call_count,
               COALESCE(ss.subagent_count, 0) AS subagent_count,
               COALESCE(ss.loop_count, 0) AS loop_count,
               COALESCE(ss.max_repeat, 0) AS max_repeat,
               COALESCE(
                   (SELECT COUNT(*) FROM tool_results tr WHERE tr.session_id = s.id AND tr.is_error = 1),
                   0
               ) AS error_count,
               CAST(
                   ROUND(COALESCE((julianday(s.last_ts) - julianday(s.first_ts)) * 86400, 0)) AS INTEGER
               ) AS duration_seconds,
               COALESCE((SELECT COUNT(*) FROM risk_findings rf WHERE rf.session_id = s.id), 0) AS finding_count,
               {cols}
        FROM messages m
        JOIN events e ON e.id = m.event_id
        JOIN sessions s ON s.id = e.session_id
        JOIN projects p ON p.id = s.project_id
        LEFT JOIN session_stats ss ON ss.session_id = s.id
        {where}
        GROUP BY s.id, m.model, price_period
        """,
        params,
    ).fetchall():
        if not matches(row["model"]):
            continue
        price = _price(row["price_period"], row["model"])
        usd = cost_usd(price, _breakdown(row)) if price else 0.0
        s = sessions.setdefault(
            row["id"],
            {"id": row["id"], "session_id": row["session_id"], "title": row["title"],
             "project_name": project_display_name(row["project_name"], row["project_cwd"]),
             "usd": 0.0, "tokens": 0,
             "turn_count": int(row["turn_count"] or 0),
             "tool_call_count": int(row["tool_call_count"] or 0),
             "subagent_count": int(row["subagent_count"] or 0),
             "error_count": int(row["error_count"] or 0),
             "loop_count": int(row["loop_count"] or 0),
             "max_repeat": int(row["max_repeat"] or 0),
             "finding_count": int(row["finding_count"] or 0),
             "duration_seconds": int(row["duration_seconds"] or 0)},
        )
        s["usd"] += usd
        s["tokens"] += _tokens_total(row)

    bucket_sessions: dict[str, dict[int, dict[str, Any]]] = {}
    for row in conn.execute(
        f"""
        SELECT {bucket_expr} AS bucket, s.id AS id, s.session_id AS session_id, s.title AS title,
               p.export_name AS project_name, p.inferred_cwd AS project_cwd, m.model AS model,
               ({period_expr}) AS price_period, {cols}
        FROM messages m
        JOIN events e ON e.id = m.event_id
        JOIN sessions s ON s.id = e.session_id
        JOIN projects p ON p.id = s.project_id
        {where}
        GROUP BY bucket, s.id, m.model, price_period
        """,
        params,
    ).fetchall():
        if row["bucket"] is None or not matches(row["model"]):
            continue
        price = _price(row["price_period"], row["model"])
        usd = cost_usd(price, _breakdown(row)) if price else 0.0
        if usd == 0:
            continue
        bucket_key = row["bucket"]
        sessions_by_id = bucket_sessions.setdefault(bucket_key, {})
        item = sessions_by_id.setdefault(
            row["id"],
            {
                "id": row["id"],
                "session_id": row["session_id"],
                "title": row["title"],
                "project_name": project_display_name(row["project_name"], row["project_cwd"]),
                "usd": 0.0,
                "tokens": 0,
            },
        )
        item["usd"] += usd
        item["tokens"] += _tokens_total(row)

    # Pickers: respect the date filter, ignore project/model filters.
    date_where, date_params = _where(date_from, date_to, None)
    proj_rows = conn.execute(
        f"""
        SELECT DISTINCT s.project_id AS id, p.export_name AS name, p.inferred_cwd AS cwd
        FROM events e JOIN sessions s ON s.id = e.session_id
        JOIN projects p ON p.id = s.project_id{date_where}
        ORDER BY p.export_name
        """,
        date_params,
    ).fetchall()
    model_rows = conn.execute(
        f"""
        SELECT DISTINCT m.model AS model
        FROM messages m JOIN events e ON e.id = m.event_id
        JOIN sessions s ON s.id = e.session_id{date_where}
        """,
        date_params,
    ).fetchall()

    treemap_out = [
        {
            "project_id": proj["project_id"],
            "project_name": proj["project_name"],
            "usd": round(proj["usd"], 6),
            "children": [
                {"model": mdl, "usd": round(usd, 6)}
                for mdl, usd in sorted(proj["children"].items(), key=lambda kv: kv[1], reverse=True)
            ],
        }
        for proj in sorted(treemap.values(), key=lambda x: x["usd"], reverse=True)
    ]
    by_model_out = [
        {
            "model": bm["model"],
            "usd": round(bm["usd"], 6),
            "tokens": bm["tokens"],
            "input_tokens": bm["input_tokens"],
            "output_tokens": bm["output_tokens"],
            "cache_read_tokens": bm["cache_read_tokens"],
            "cache_write_tokens": bm["cache_write_tokens"],
            "effective_usd_per_million": round((bm["usd"] / bm["tokens"]) * 1_000_000, 6)
            if bm["tokens"] > 0
            else 0.0,
        }
        for bm in sorted(by_model.values(), key=lambda x: x["usd"], reverse=True)
    ]
    categories_out = {
        cat: {"tokens": categories[cat]["tokens"], "usd": round(categories[cat]["usd"], 6)}
        for cat in _CATEGORIES
    }
    over_time_out = [over_time[k] for k in sorted(over_time)]
    sessions_out = sorted(
        ({**s, "usd": round(s["usd"], 6)} for s in sessions.values()),
        key=lambda x: x["usd"],
        reverse=True,
    )
    turn_costs = _turn_cost_stats(
        conn,
        timeline,
        where=where,
        params=params,
        project_id=project_id,
        matches=matches,
        historical=historical,
    )
    for session in sessions_out:
        session["turn_cost_stats"] = turn_costs.get(session["id"], _turn_cost_stat([]))
    cache_economics["net_savings_usd"] = (
        cache_economics["no_cache_input_usd"] - cache_economics["observed_input_usd"]
    )
    cache_economics_out = {
        "observed_input_usd": round(cache_economics["observed_input_usd"], 6),
        "no_cache_input_usd": round(cache_economics["no_cache_input_usd"], 6),
        "net_savings_usd": round(cache_economics["net_savings_usd"], 6),
        "cache_read_tokens": cache_economics["cache_read_tokens"],
        "cache_write_tokens": cache_economics["cache_write_tokens"],
        "by_model": [
            {
                **model_cache,
                "observed_input_usd": round(model_cache["observed_input_usd"], 6),
                "no_cache_input_usd": round(model_cache["no_cache_input_usd"], 6),
                "net_savings_usd": round(
                    model_cache["no_cache_input_usd"] - model_cache["observed_input_usd"], 6
                ),
            }
            for model_cache in sorted(
                cache_economics["by_model"].values(),
                key=lambda item: abs(item["no_cache_input_usd"] - item["observed_input_usd"]),
                reverse=True,
            )
        ],
    }

    bucket_totals = {
        item["bucket"]: round(sum(item["per_model"].values()), 6)
        for item in over_time_out
    }
    spikes = []
    bucket_keys = sorted(bucket_totals)
    for index, key in enumerate(bucket_keys):
        if index == 0:
            continue
        previous = bucket_totals[bucket_keys[index - 1]]
        delta = round(bucket_totals[key] - previous, 6)
        if delta <= 0:
            continue
        contributors = sorted(
            (
                {**session, "usd": round(session["usd"], 6)}
                for session in bucket_sessions.get(key, {}).values()
            ),
            key=lambda item: item["usd"],
            reverse=True,
        )[:3]
        spikes.append(
            {
                "bucket": key,
                "total_usd": bucket_totals[key],
                "delta_usd": delta,
                "sessions": contributors,
            }
        )
    spikes_out = sorted(spikes, key=lambda item: item["delta_usd"], reverse=True)[:5]

    return {
        "meta": {
            "available": price_available,
            "unpriced_models": sorted(unpriced),
            "total_usd": round(total_usd, 6),
            "total_tokens": total_tokens,
            "available_projects": [
                {"id": r["id"], "name": project_display_name(r["name"], r["cwd"])} for r in proj_rows
            ],
            "available_models": sorted({r["model"] for r in model_rows if r["model"]}),
            "bucket": bucket,
        },
        "treemap": treemap_out,
        "over_time": over_time_out,
        "categories": categories_out,
        "by_model": by_model_out,
        "sessions": sessions_out,
        "cache_economics": cache_economics_out,
        "spikes": spikes_out,
    }
