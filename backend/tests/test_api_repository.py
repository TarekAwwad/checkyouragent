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
