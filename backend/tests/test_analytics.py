# backend/tests/test_analytics.py
from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from ccfr.api import analytics
from ccfr.api.analytics import bucket_for_range, cost_analytics, session_turn_cost_breakdown
from ccfr.storage import init_db


def test_bucket_for_range_daily_within_threshold() -> None:
    assert bucket_for_range("2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z") == "day"


def test_bucket_for_range_weekly_beyond_threshold() -> None:
    assert bucket_for_range("2026-01-01T00:00:00Z", "2026-06-01T00:00:00Z") == "week"


def test_bucket_for_range_defaults_to_day_on_missing_or_bad_bounds() -> None:
    assert bucket_for_range(None, "2026-02-01T00:00:00Z") == "day"
    assert bucket_for_range("not-a-date", "also-bad") == "day"


def _add_message(conn: sqlite3.Connection, session_id: int, ts: str, model: str, base: int, c5: int, c1: int, cr: int, out: int) -> int:
    ev = conn.execute(
        "INSERT INTO events (session_id, source_path, line_no, type, timestamp, raw_json)"
        " VALUES (?, 'f.jsonl', 1, 'assistant', ?, '{}')",
        (session_id, ts),
    ).lastrowid
    conn.execute(
        "INSERT INTO messages (event_id, role, model, input_tokens, output_tokens,"
        " base_input_tokens, cache_5m_tokens, cache_1h_tokens, cache_read_tokens)"
        " VALUES (?, 'assistant', ?, ?, ?, ?, ?, ?, ?)",
        (ev, model, base + c5 + c1 + cr, out, base, c5, c1, cr),
    )
    return int(ev)


def _add_user_turn(conn: sqlite3.Connection, session_id: int, ts: str) -> int:
    ev = conn.execute(
        "INSERT INTO events (session_id, source_path, line_no, type, timestamp, raw_json)"
        " VALUES (?, 'f.jsonl', 1, 'user', ?, '{}')",
        (session_id, ts),
    ).lastrowid
    conn.execute(
        "INSERT INTO messages (event_id, role, text_preview) VALUES (?, 'user', 'Prompt')",
        (ev,),
    )
    return int(ev)


def _seed(conn: sqlite3.Connection) -> None:
    """Two projects, two sessions, deterministic token usage on two priced models."""
    import_id = conn.execute(
        "INSERT INTO imports (source_path, imported_at, file_count, status, error_count)"
        " VALUES ('fx', '2026-01-01T00:00:00Z', 0, 'complete', 0)"
    ).lastrowid
    p1 = conn.execute(
        "INSERT INTO projects (import_id, export_name, inferred_cwd) VALUES (?, 'alpha', NULL)",
        (import_id,),
    ).lastrowid
    p2 = conn.execute(
        "INSERT INTO projects (import_id, export_name, inferred_cwd) VALUES (?, 'beta', NULL)",
        (import_id,),
    ).lastrowid
    s1 = conn.execute(
        "INSERT INTO sessions (project_id, session_id, title, first_ts, last_ts)"
        " VALUES (?, 's1', 'Session One', '2026-05-01T00:00:00Z', '2026-05-01T01:00:00Z')",
        (p1,),
    ).lastrowid
    s2 = conn.execute(
        "INSERT INTO sessions (project_id, session_id, title, first_ts, last_ts)"
        " VALUES (?, 's2', 'Session Two', '2026-05-02T00:00:00Z', '2026-05-02T01:00:00Z')",
        (p2,),
    ).lastrowid

    # s1: opus on 2026-05-01; s2: sonnet on 2026-05-02
    _add_user_turn(conn, s1, "2026-05-01T00:05:00Z")
    ev1 = _add_message(conn, s1, "2026-05-01T00:10:00Z", "claude-opus-4-8", 1_000_000, 0, 0, 0, 1_000_000)
    _add_user_turn(conn, s2, "2026-05-02T00:05:00Z")
    _add_message(conn, s2, "2026-05-02T00:10:00Z", "claude-sonnet-4-6", 1_000_000, 0, 0, 0, 1_000_000)
    conn.execute(
        "INSERT INTO tool_results(event_id, session_id, tool_use_id, is_error, raw_json)"
        " VALUES (?, ?, 'tool-1', 1, '{}')",
        (ev1, s1),
    )
    conn.execute(
        "INSERT INTO risk_findings(session_id, severity, category, title, explanation, score)"
        " VALUES (?, 'medium', 'loop', 'Repeated expensive work', 'Fixture finding.', 2.5)",
        (s1,),
    )
    conn.execute(
        """
        INSERT INTO session_stats(
            session_id, event_count, turn_count, tool_call_count, subagent_count, error_count,
            system_count, persisted_output_count, input_tokens, output_tokens, loop_count, max_repeat
        ) VALUES (?, 10, 4, 6, 1, 1, 0, 0, 1000000, 1000000, 2, 3)
        """,
        (s1,),
    )
    conn.execute(
        """
        INSERT INTO session_stats(
            session_id, event_count, turn_count, tool_call_count, subagent_count, error_count,
            system_count, persisted_output_count, input_tokens, output_tokens, loop_count, max_repeat
        ) VALUES (?, 8, 2, 4, 0, 0, 0, 0, 1000000, 1000000, 0, 0)
        """,
        (s2,),
    )
    conn.commit()


@pytest.fixture()
def seeded(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> sqlite3.Connection:
    # Deterministic prices independent of the repo's pricing.csv.
    csv = tmp_path / "pricing.csv"
    csv.write_text(
        "model,base-input-tokens,5m-cache-writes,1h-cache-writes,cache-hits-&-refreshes,output-tokens\n"
        "claude-opus-4-8,5,6.25,10,0.50,25\n"
        "claude-sonnet-4-6,3,3.75,6,0.30,15\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(analytics, "pricing_path", lambda: csv)
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_db(conn)
    _seed(conn)
    return conn


def test_cost_analytics_totals_and_treemap(seeded: sqlite3.Connection) -> None:
    payload = cost_analytics(seeded)
    # opus: 1M base*5 + 1M output*25 = $30 ; sonnet: 1M*3 + 1M*15 = $18 ; total $48
    assert payload["meta"]["total_usd"] == 48.0
    assert payload["meta"]["available"] is True
    assert payload["meta"]["total_tokens"] == 4_000_000  # 2M per session (base + output)
    projects = {p["project_name"]: p for p in payload["treemap"]}
    assert projects["alpha"]["usd"] == 30.0
    assert projects["beta"]["usd"] == 18.0
    assert projects["alpha"]["children"][0] == {"model": "claude-opus-4-8", "usd": 30.0}
    # treemap is sorted by usd descending
    assert [p["project_name"] for p in payload["treemap"]] == ["alpha", "beta"]


def test_cost_analytics_categories_and_by_model(seeded: sqlite3.Connection) -> None:
    payload = cost_analytics(seeded)
    cats = payload["categories"]
    assert cats["base_input"]["tokens"] == 2_000_000  # 1M each session
    assert cats["output"]["tokens"] == 2_000_000
    assert cats["cache_read"]["tokens"] == 0
    # base_input usd = 1M*5/1e6 + 1M*3/1e6 = 8.0
    assert cats["base_input"]["usd"] == 8.0
    by_model = {m["model"]: m for m in payload["by_model"]}
    assert by_model["claude-opus-4-8"]["usd"] == 30.0
    assert by_model["claude-opus-4-8"]["input_tokens"] == 1_000_000
    assert by_model["claude-opus-4-8"]["output_tokens"] == 1_000_000
    assert by_model["claude-opus-4-8"]["effective_usd_per_million"] == 15.0
    assert payload["by_model"][0]["model"] == "claude-opus-4-8"  # sorted by usd desc


def test_cost_analytics_over_time_and_sessions(seeded: sqlite3.Connection) -> None:
    payload = cost_analytics(seeded)
    assert payload["meta"]["bucket"] == "day"
    buckets = {b["bucket"]: b for b in payload["over_time"]}
    assert buckets["2026-05-01"]["per_model"]["claude-opus-4-8"] == 30.0
    assert buckets["2026-05-02"]["per_model"]["claude-sonnet-4-6"] == 18.0
    sessions = payload["sessions"]
    assert sessions[0]["title"] == "Session One" and sessions[0]["usd"] == 30.0
    assert {
        "id", "session_id", "title", "project_name", "usd", "tokens", "turn_count",
        "tool_call_count", "subagent_count", "error_count", "loop_count", "max_repeat",
        "finding_count", "duration_seconds", "turn_cost_stats",
    } <= set(sessions[0])
    assert sessions[0]["turn_count"] == 4
    assert sessions[0]["error_count"] == 1
    assert sessions[0]["loop_count"] == 2
    assert sessions[0]["finding_count"] == 1
    assert sessions[0]["turn_cost_stats"] == {
        "turn_count": 1,
        "median_usd": 30.0,
        "p95_usd": 30.0,
        "max_usd": 30.0,
        "outlier_count": 0,
    }


def test_cost_analytics_cache_economics(seeded: sqlite3.Connection) -> None:
    s2_id = next(
        s["id"] for s in cost_analytics(seeded)["sessions"] if s["title"] == "Session Two"
    )
    _add_message(
        seeded,
        s2_id,
        "2026-05-02T00:20:00Z",
        "claude-sonnet-4-6",
        0,
        1_000_000,
        0,
        9_000_000,
        0,
    )
    seeded.commit()

    cache = cost_analytics(seeded)["cache_economics"]
    # New sonnet input: observed = 1M*3.75 + 9M*.30 = $6.45;
    # no-cache = 10M*base($3) = $30, so net savings are $23.55.
    assert cache["cache_read_tokens"] == 9_000_000
    assert cache["cache_write_tokens"] == 1_000_000
    assert cache["observed_input_usd"] == 14.45
    assert cache["no_cache_input_usd"] == 38.0
    assert cache["net_savings_usd"] == 23.55
    sonnet = next(row for row in cache["by_model"] if row["model"] == "claude-sonnet-4-6")
    assert sonnet["net_savings_usd"] == 23.55


def test_session_turn_cost_breakdown_surfaces_outlier_drivers(seeded: sqlite3.Connection) -> None:
    s1_id = next(s["id"] for s in cost_analytics(seeded)["sessions"] if s["title"] == "Session One")
    high_event = seeded.execute(
        "SELECT id FROM events WHERE session_id = ? AND type = 'assistant' ORDER BY id LIMIT 1",
        (s1_id,),
    ).fetchone()["id"]
    for tool_use_id in ("tool-a", "tool-b", "tool-c"):
        seeded.execute(
            "INSERT INTO tool_calls(event_id, session_id, tool_use_id, tool_name, raw_json) VALUES (?, ?, ?, 'Read', '{}')",
            (high_event, s1_id, tool_use_id),
        )

    for index in range(3):
        _add_user_turn(seeded, s1_id, f"2026-05-01T00:{20 + index * 5:02d}:00Z")
        _add_message(seeded, s1_id, f"2026-05-01T00:{21 + index * 5:02d}:00Z", "claude-opus-4-8", 50_000, 0, 0, 0, 50_000)
    seeded.commit()

    breakdown = session_turn_cost_breakdown(seeded, s1_id)

    assert breakdown["session_id"] == s1_id
    assert breakdown["turn_count"] == 4
    assert breakdown["outlier_count"] == 1
    assert breakdown["outlier_threshold_usd"] > 0
    expensive_turn = max(breakdown["turns"], key=lambda turn: turn["usd"])
    assert expensive_turn["is_outlier"] is True
    assert expensive_turn["tool_call_count"] == 3
    assert expensive_turn["loop_count"] == 1
    assert expensive_turn["max_repeat"] == 3
    assert expensive_turn["models"] == ["claude-opus-4-8"]
    assert expensive_turn["preview"] == "Prompt"


def test_cost_analytics_spikes_identify_contributor_sessions(seeded: sqlite3.Connection) -> None:
    s2_id = next(
        s["id"] for s in cost_analytics(seeded)["sessions"] if s["title"] == "Session Two"
    )
    _add_message(
        seeded,
        s2_id,
        "2026-05-03T00:10:00Z",
        "claude-opus-4-8",
        2_000_000,
        0,
        0,
        0,
        2_000_000,
    )
    seeded.commit()

    spikes = cost_analytics(seeded)["spikes"]
    assert spikes[0]["bucket"] == "2026-05-03"
    assert spikes[0]["total_usd"] == 60.0
    assert spikes[0]["delta_usd"] == 42.0
    assert spikes[0]["sessions"][0]["id"] == s2_id
    assert spikes[0]["sessions"][0]["usd"] == 60.0


def test_cost_analytics_project_and_model_filters(seeded: sqlite3.Connection) -> None:
    alpha_id = next(p["project_id"] for p in cost_analytics(seeded)["treemap"] if p["project_name"] == "alpha")
    only_alpha = cost_analytics(seeded, project_id=alpha_id)
    assert only_alpha["meta"]["total_usd"] == 30.0
    assert [p["project_name"] for p in only_alpha["treemap"]] == ["alpha"]
    # available_projects ignores the project filter (both still offered)
    assert {p["name"] for p in only_alpha["meta"]["available_projects"]} == {"alpha", "beta"}

    only_sonnet = cost_analytics(seeded, model="claude-sonnet-4-6")
    assert only_sonnet["meta"]["total_usd"] == 18.0
    assert [m["model"] for m in only_sonnet["by_model"]] == ["claude-sonnet-4-6"]
    assert set(only_sonnet["meta"]["available_models"]) == {"claude-opus-4-8", "claude-sonnet-4-6"}


def test_cost_analytics_date_filter(seeded: sqlite3.Connection) -> None:
    may1_only = cost_analytics(seeded, date_from="2026-05-01T00:00:00Z", date_to="2026-05-01T23:59:59Z")
    assert may1_only["meta"]["total_usd"] == 30.0


def test_cost_analytics_no_price_table(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(analytics, "pricing_path", lambda: tmp_path / "missing.csv")
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_db(conn)
    _seed(conn)
    payload = cost_analytics(conn)
    assert payload["meta"]["available"] is False
    assert payload["meta"]["total_usd"] == 0.0
    # token analytics still populated
    assert payload["categories"]["base_input"]["tokens"] == 2_000_000
    assert payload["meta"]["unpriced_models"] == ["claude-opus-4-8", "claude-sonnet-4-6"]


def test_cost_analytics_uses_leaf_folder_name_when_cwd_known(seeded: sqlite3.Connection) -> None:
    # alpha's encoded export_name resolves to the leaf folder of its real cwd.
    seeded.execute(
        "UPDATE projects SET export_name = 'd--Cheqd-Code-agent-dashboard',"
        " inferred_cwd = 'd:\\Cheqd\\Code\\agent-dashboard' WHERE export_name = 'alpha'"
    )
    seeded.commit()
    payload = cost_analytics(seeded)
    names = {p["project_name"] for p in payload["treemap"]}
    assert "agent-dashboard" in names and "d--Cheqd-Code-agent-dashboard" not in names
    assert "agent-dashboard" in {p["name"] for p in payload["meta"]["available_projects"]}
    assert "agent-dashboard" in {s["project_name"] for s in payload["sessions"]}


def _conn_two_dated_opus(tmp_path):
    """One project, two assistant messages (1M base-input each) on claude-opus-4-1,
    dated Jan 2026 and Aug 2026 — straddling a 2026-07-01 price change."""
    from ccfr.storage import connect, init_db
    conn = connect(tmp_path / "ca.sqlite3")
    init_db(conn)
    conn.execute("INSERT INTO imports(source_path, imported_at, status) VALUES('x','x','done')")
    conn.execute("INSERT INTO projects(import_id, export_name) VALUES(1,'proj')")
    for sid, ts in enumerate(["2026-01-15T10:00:00Z", "2026-08-15T10:00:00Z"], start=1):
        conn.execute("INSERT INTO sessions(project_id, session_id, first_ts, last_ts) VALUES(1,?,?,?)",
                     (f"s{sid}", ts, ts))
        conn.execute("INSERT INTO events(session_id, source_path, line_no, type, timestamp, raw_json) "
                     "VALUES(?,?,?,?,?,'{}')", (sid, "f", sid, "assistant", ts))
        conn.execute("INSERT INTO messages(event_id, role, model, base_input_tokens, output_tokens) "
                     "VALUES(?, 'assistant', 'claude-opus-4-1', 1000000, 0)", (sid,))
    conn.commit()
    return conn


def test_cost_analytics_prices_by_period(monkeypatch, tmp_path):
    from ccfr.api import analytics

    conn = _conn_two_dated_opus(tmp_path)
    baseline = tmp_path / "pricing.csv"
    baseline.write_text(
        "model,base-input-tokens,5m-cache-writes,1h-cache-writes,cache-hits-&-refreshes,output-tokens\n"
        "Claude-Opus-4.1,15,0,0,0,75\n",
        encoding="utf-8",
    )
    sheets = tmp_path / "pricing"
    sheets.mkdir()
    (sheets / "pricing-2026-07-01.csv").write_text(
        "model,base-input-tokens,5m-cache-writes,1h-cache-writes,cache-hits-&-refreshes,output-tokens\n"
        "Claude-Opus-4.1,5,0,0,0,25\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(analytics, "pricing_path", lambda: baseline)
    monkeypatch.setattr(analytics, "pricing_dir", lambda: sheets)

    on = analytics.cost_analytics(conn, historical=True)
    off = analytics.cost_analytics(conn, historical=False)
    # ON: $15 (Jan) + $5 (Aug) = $20. OFF: both at current $5 = $10.
    assert round(on["meta"]["total_usd"], 2) == 20.0
    assert round(off["meta"]["total_usd"], 2) == 10.0


def test_cost_analytics_sums_multi_model_session(seeded: sqlite3.Connection) -> None:
    # Add a second model's usage to the FIRST session and re-query.
    s1_id = next(
        s["id"] for s in cost_analytics(seeded)["sessions"] if s["title"] == "Session One"
    )
    ev = seeded.execute(
        "INSERT INTO events (session_id, source_path, line_no, type, timestamp, raw_json)"
        " VALUES (?, 'f.jsonl', 2, 'assistant', '2026-05-01T00:20:00Z', '{}')",
        (s1_id,),
    ).lastrowid
    seeded.execute(
        "INSERT INTO messages (event_id, role, model, input_tokens, output_tokens,"
        " base_input_tokens, cache_5m_tokens, cache_1h_tokens, cache_read_tokens)"
        " VALUES (?, 'assistant', 'claude-sonnet-4-6', 1000000, 0, 1000000, 0, 0, 0)",
        (ev,),
    )
    seeded.commit()
    session = next(s for s in cost_analytics(seeded)["sessions"] if s["id"] == s1_id)
    # original opus cost $30 + new sonnet 1M base * $3 = $3 => $33
    assert session["usd"] == 33.0
