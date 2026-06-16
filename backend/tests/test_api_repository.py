from __future__ import annotations

import sqlite3
from pathlib import Path

from ccfr.api import repository
from ccfr.ingest import import_export
from ccfr.storage import init_db
from tests.fixtures import sanitized_export


def test_repository_returns_session_timeline_trace_and_event_detail(tmp_path: Path) -> None:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_db(conn)
    import_export(conn, sanitized_export(tmp_path))

    sessions = repository.list_sessions(conn, has_subagents=True)
    assert sessions

    session_id = sessions[0]["id"]
    timeline = repository.get_timeline(conn, session_id)
    trace = repository.get_trace(conn, session_id)
    subagents = repository.list_subagents(conn, session_id)
    event = repository.get_event(conn, timeline[0]["event_id"], include_raw=True)
    sessions_with_findings = [s for s in repository.list_sessions(conn) if s["finding_count"] > 0]

    assert timeline
    assert trace["lanes"]
    assert isinstance(trace["spans"], list)
    assert subagents
    assert event is not None
    assert event["raw_json"] is not None
    assert "pattern_risk_score" in sessions[0]
    assert sessions_with_findings

    findings = repository.list_risk_findings(conn, sessions_with_findings[0]["id"])
    assert findings
    assert findings[0]["pattern"]
    assert "lift" in findings[0]


def test_list_sessions_and_projects_carry_cost_estimates(tmp_path: Path) -> None:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_db(conn)
    import_export(conn, sanitized_export(tmp_path))

    sessions = repository.list_sessions(conn)
    assert sessions
    for session in sessions:
        assert "cost_usd" in session
        assert "cost_available" in session

    # The sanitized export has priced models, so at least one session costs money,
    # and each session's listed cost matches the detailed per-session estimate.
    priced = [s for s in sessions if s["cost_usd"] > 0]
    assert priced
    sample = priced[0]
    assert sample["cost_usd"] == repository.session_cost(conn, sample["id"])["usd"]

    projects = repository.list_projects(conn)
    assert projects
    for project in projects:
        assert "cost_usd" in project
        # A project's cost is the sum of its sessions' costs.
        session_sum = round(
            sum(s["cost_usd"] for s in sessions if s["project_id"] == project["id"]), 6
        )
        assert project["cost_usd"] == session_sum


def test_list_sessions_session_id_filter_returns_single_row(tmp_path: Path) -> None:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_db(conn)
    import_export(conn, sanitized_export(tmp_path))

    all_sessions = repository.list_sessions(conn, with_cost=False)
    # The fixture imports at least two sessions; pick two distinct ids to verify isolation.
    assert len(all_sessions) >= 2
    target = all_sessions[0]
    other = all_sessions[1]

    filtered = repository.list_sessions(conn, session_id=target["id"], with_cost=False)
    assert len(filtered) == 1
    assert filtered[0]["id"] == target["id"]

    other_filtered = repository.list_sessions(conn, session_id=other["id"], with_cost=False)
    assert len(other_filtered) == 1
    assert other_filtered[0]["id"] == other["id"]


def test_get_session_matches_list_sessions_row(tmp_path: Path) -> None:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_db(conn)
    import_export(conn, sanitized_export(tmp_path))

    all_sessions = repository.list_sessions(conn, with_cost=False)
    assert all_sessions
    target = all_sessions[0]

    result = repository.get_session(conn, target["id"])
    assert result is not None
    # Response shape must be identical to the corresponding list_sessions row.
    assert result == target


def test_get_session_returns_none_for_nonexistent_id(tmp_path: Path) -> None:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_db(conn)
    import_export(conn, sanitized_export(tmp_path))

    result = repository.get_session(conn, 999_999)
    assert result is None


from ccfr.storage import connect


def _seed_two_dated_sessions(conn):
    """Two sessions, identical 1M base-input tokens on Opus, on different dates."""
    init_db(conn)
    conn.execute("INSERT INTO imports(source_path, imported_at, status) VALUES('x','x','done')")
    conn.execute("INSERT INTO projects(import_id, export_name) VALUES(1,'proj')")
    for sid, (session_key, ts) in enumerate(
        {"old": "2026-01-15T10:00:00Z", "new": "2026-08-15T10:00:00Z"}.items(), start=1
    ):
        conn.execute(
            "INSERT INTO sessions(project_id, session_id, first_ts, last_ts) VALUES(1,?,?,?)",
            (session_key, ts, ts),
        )
        conn.execute(
            "INSERT INTO events(session_id, source_path, line_no, type, timestamp, raw_json) "
            "VALUES(?,?,?,?,?,'{}')",
            (sid, "f", sid, "assistant", ts),
        )
        conn.execute(
            "INSERT INTO messages(event_id, role, model, base_input_tokens, output_tokens) "
            "VALUES(?, 'assistant', 'claude-opus-4-1', 1000000, 0)",
            (sid,),
        )
    conn.commit()


def _pricing(tmp_path):
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
    return baseline, sheets


def test_session_cost_prices_by_session_date(monkeypatch, tmp_path):
    conn = connect(tmp_path / "db.sqlite3")
    _seed_two_dated_sessions(conn)
    baseline, sheets = _pricing(tmp_path)
    monkeypatch.setattr(repository, "pricing_path", lambda: baseline)
    monkeypatch.setattr(repository, "pricing_dir", lambda: sheets)

    assert repository.session_cost(conn, 1, historical=True)["usd"] == 15.0
    assert repository.session_cost(conn, 2, historical=True)["usd"] == 5.0
    assert repository.session_cost(conn, 1, historical=False)["usd"] == 5.0


def test_session_cost_map_prices_by_date(monkeypatch, tmp_path):
    conn = connect(tmp_path / "db.sqlite3")
    _seed_two_dated_sessions(conn)
    baseline, sheets = _pricing(tmp_path)
    monkeypatch.setattr(repository, "pricing_path", lambda: baseline)
    monkeypatch.setattr(repository, "pricing_dir", lambda: sheets)
    costs, available = repository.session_cost_map(conn, historical=True)
    assert available is True
    assert costs == {1: 15.0, 2: 5.0}
