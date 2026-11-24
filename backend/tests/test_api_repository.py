from __future__ import annotations

import sqlite3
from pathlib import Path

from ccfr.api import repository
from ccfr.ingest import import_export
from ccfr.storage import init_db
from tests.fixtures import sanitized_export


def test_import_status_exposes_coverage_latest_success_and_persisted_issues() -> None:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_db(conn)
    successful_id = conn.execute(
        """
        INSERT INTO imports(source_path, imported_at, file_count, status, error_count)
        VALUES('source-a', '2026-06-01T12:00:00Z', 4, 'completed_with_errors', 2)
        """
    ).lastrowid
    failed_id = conn.execute(
        """
        INSERT INTO imports(source_path, imported_at, file_count, status, error_count)
        VALUES('source-b', '2026-06-02T12:00:00Z', 1, 'failed', 1)
        """
    ).lastrowid
    project_id = conn.execute(
        "INSERT INTO projects(import_id, export_name) VALUES(?, 'd--Alpha')",
        (successful_id,),
    ).lastrowid
    conn.executemany(
        "INSERT INTO sessions(project_id, session_id, first_ts, last_ts) VALUES(?, ?, ?, ?)",
        [
            (project_id, "early", "2026-01-03T10:00:00Z", "2026-01-03T10:05:00Z"),
            (project_id, "late", "2026-05-09T10:00:00Z", None),
        ],
    )
    conn.execute(
        "INSERT INTO import_errors(import_id, path, line_no, message) VALUES(?, 'bad.jsonl', 7, 'Invalid JSON')",
        (failed_id,),
    )

    stats = repository.cache_stats(conn)
    history = repository.list_imports(conn)

    assert stats["observed_date_from"] == "2026-01-03"
    assert stats["observed_date_to"] == "2026-05-09"
    assert stats["last_successful_sync_at"] == "2026-06-01T12:00:00Z"
    assert stats["latest_import_error_count"] == 1
    assert "memory_count" not in stats
    assert history[0]["status"] == "failed"
    assert history[0]["errors"] == [
        {"path": "bad.jsonl", "line_no": 7, "message": "Invalid JSON"}
    ]


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
    assert "pattern_risk_score" not in sessions[0]
    assert "top_finding_severity" not in sessions[0]
    assert sessions_with_findings

    findings = repository.list_session_findings(conn, sessions_with_findings[0]["id"])
    assert findings
    assert findings[0]["basis"] in {"observed", "estimated", "inferred", "associated"}
    assert "score" not in findings[0]
    assert "lift" not in findings[0]
    assert "pattern" not in findings[0]


def test_session_findings_validate_and_deduplicate_evidence_events() -> None:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_db(conn)
    conn.execute("INSERT INTO imports(source_path, imported_at, status) VALUES('x','x','done')")
    conn.execute("INSERT INTO projects(import_id, export_name) VALUES(1,'project')")
    conn.execute("INSERT INTO sessions(project_id, session_id) VALUES(1,'target')")
    conn.execute("INSERT INTO sessions(project_id, session_id) VALUES(1,'other')")
    target_event = conn.execute(
        "INSERT INTO events(session_id, source_path, line_no, type, raw_json) "
        "VALUES(1,'target.jsonl',1,'user','{}')"
    ).lastrowid
    other_event = conn.execute(
        "INSERT INTO events(session_id, source_path, line_no, type, raw_json) "
        "VALUES(2,'other.jsonl',1,'user','{}')"
    ).lastrowid
    conn.execute(
        """
        INSERT INTO session_findings(
            session_id, finding_key, detector_key, basis, category, title,
            explanation, evidence_json
        ) VALUES(1, 'timeout:one', 'timeout', 'observed', 'execution_failure',
                 'Timed out', 'The call timed out.', ?)
        """,
        (f'{{"event_ids":[{target_event},{target_event},{other_event},999,"bad"]}}',),
    )
    conn.execute(
        """
        INSERT INTO session_findings(
            session_id, finding_key, detector_key, basis, category, title,
            explanation, evidence_json
        ) VALUES(1, 'large:one', 'large_tool_result', 'estimated', 'result_size',
                 'Large result', 'The result was large.', ?)
        """,
        (f'{{"event_ids":{target_event}}}',),
    )

    findings = repository.list_session_findings(conn, 1)
    finding = findings[0]

    assert finding["evidence_event_ids"] == [target_event]
    assert finding["evidence"]["event_ids"] == [
        target_event,
        target_event,
        other_event,
        999,
        "bad",
    ]
    assert findings[1]["evidence_event_ids"] == []


def test_session_top_finding_uses_documented_detector_precedence() -> None:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_db(conn)
    conn.execute("INSERT INTO imports(source_path, imported_at, status) VALUES('x','x','done')")
    conn.execute("INSERT INTO projects(import_id, export_name) VALUES(1,'project')")
    conn.execute("INSERT INTO sessions(project_id, session_id) VALUES(1,'target')")
    findings = [
        ("large:one", "large_tool_result", "estimated", "Large result"),
        ("permission:one", "permission_rejected", "observed", "Permission rejected"),
        ("repeat:one", "repeated_identical_failure", "observed", "Repeated failure"),
    ]
    conn.executemany(
        """
        INSERT INTO session_findings(
            session_id, finding_key, detector_key, basis, category, title, explanation
        ) VALUES(1, ?, ?, ?, 'execution_failure', ?, 'Evidence-backed explanation')
        """,
        findings,
    )

    session = repository.list_sessions(conn, with_cost=False)[0]

    assert session["finding_count"] == 3
    assert session["top_finding_title"] == "Repeated failure"
    assert session["top_finding_basis"] == "observed"
    assert "pattern_risk_score" not in session
    assert "top_finding_severity" not in session


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


def test_list_projects_counts_do_not_multiply_events_by_subagents() -> None:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_db(conn)
    import_id = conn.execute(
        """
        INSERT INTO imports(source_path, imported_at, file_count, status, error_count)
        VALUES('source', '2026-06-01T12:00:00Z', 1, 'completed', 0)
        """
    ).lastrowid

    def project(name: str) -> int:
        return conn.execute(
            "INSERT INTO projects(import_id, export_name) VALUES(?, ?)", (import_id, name)
        ).lastrowid

    def session(project_id: int, sid: str, *, events: int, replays: int, subagents: int) -> None:
        pk = conn.execute(
            "INSERT INTO sessions(project_id, session_id) VALUES(?, ?)", (project_id, sid)
        ).lastrowid
        conn.executemany(
            """
            INSERT INTO events(session_id, source_path, line_no, type, raw_json, is_replay)
            VALUES(?, 'x.jsonl', ?, 'user', '{}', ?)
            """,
            [(pk, n, int(n < replays)) for n in range(events)],
        )
        conn.executemany(
            "INSERT INTO subagents(parent_session_id, agent_id) VALUES(?, ?)",
            [(pk, f"agent-{n}") for n in range(subagents)],
        )

    busy = project("d--Busy")
    session(busy, "fan-out", events=5, replays=2, subagents=3)
    session(busy, "plain", events=4, replays=0, subagents=0)
    session(busy, "empty", events=0, replays=0, subagents=0)
    replayed = project("d--Replayed")
    session(replayed, "all-replay", events=2, replays=2, subagents=1)
    project("d--Idle")

    counts = {
        p["export_name"]: (p["session_count"], p["event_count"], p["subagent_count"])
        for p in repository.list_projects(conn)
    }

    # 5 + 4 events less the 2 replays; the join must not repeat events per subagent.
    assert counts == {
        "d--Busy": (3, 7, 3),
        "d--Idle": (0, 0, 0),
        "d--Replayed": (1, 0, 1),
    }
    assert [p["export_name"] for p in repository.list_projects(conn)] == [
        "d--Busy", "d--Idle", "d--Replayed",
    ]


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


def _seed_session_activity(conn):
    conn.execute(
        "INSERT INTO subagents(parent_session_id, agent_id, agent_type, event_count, first_ts, last_ts) "
        "VALUES(1, 'agent-a', 'Explore', 2, '2026-01-15T10:00:00Z', '2026-01-15T10:05:00Z')"
    )
    conn.execute("UPDATE events SET agent_id = 'agent-a' WHERE id = 1")
    conn.execute("UPDATE messages SET input_tokens = 1000000 WHERE event_id = 1")
    conn.execute(
        "INSERT INTO messages(event_id, role, model, input_tokens, output_tokens, base_input_tokens) "
        "VALUES(1, 'assistant', 'custom-unpriced-model', 250, 50, 250)"
    )

    result_event_id = conn.execute(
        "INSERT INTO events(session_id, source_path, line_no, type, timestamp, agent_id, raw_json) "
        "VALUES(1, 'f', 100, 'user', '2026-01-15T10:05:00Z', 'agent-a', '{}')"
    ).lastrowid
    conn.execute(
        "INSERT INTO tool_calls(event_id, session_id, tool_use_id, tool_name, raw_json) "
        "VALUES(1, 1, 'read-1', 'Read', '{}')"
    )
    conn.execute(
        "INSERT INTO tool_calls(event_id, session_id, tool_use_id, tool_name, raw_json) "
        "VALUES(1, 1, 'read-2', 'Read', '{}')"
    )
    persisted_id = conn.execute(
        "INSERT INTO persisted_outputs(session_id, path, size_bytes) VALUES(1, 'large-output.txt', 1234)"
    ).lastrowid
    raw_result = '{"content":"abcdef"}'
    conn.execute(
        "INSERT INTO tool_results(event_id, session_id, tool_use_id, is_error, persisted_output_id, raw_json) "
        "VALUES(?, 1, 'read-1', 1, ?, ?)",
        (result_event_id, persisted_id, raw_result),
    )
    conn.execute(
        "INSERT INTO events(session_id, source_path, line_no, type, timestamp, agent_id, raw_json) "
        "VALUES(1, 'f', 101, 'system', '2026-01-15T10:06:00Z', 'agent-a', '{}')"
    )

    conn.execute(
        "INSERT INTO subagents(parent_session_id, agent_id, agent_type, event_count, first_ts, last_ts) "
        "VALUES(2, 'agent-b', 'Plan', 1, '2026-08-15T10:00:00Z', '2026-08-15T10:00:00Z')"
    )
    conn.execute("UPDATE events SET agent_id = 'agent-b' WHERE id = 2")
    conn.execute(
        "UPDATE messages SET model = 'only-unpriced-model', input_tokens = 1000000 WHERE event_id = 2"
    )
    conn.commit()
    return raw_result


def test_subagent_activity_uses_direct_lane_receipts_and_historical_prices(monkeypatch, tmp_path):
    conn = connect(tmp_path / "db.sqlite3")
    _seed_two_dated_sessions(conn)
    _seed_session_activity(conn)
    baseline, sheets = _pricing(tmp_path)
    monkeypatch.setattr(repository, "pricing_path", lambda: baseline)
    monkeypatch.setattr(repository, "pricing_dir", lambda: sheets)

    historical = repository.list_subagents(conn, 1, historical=True)[0]
    current = repository.list_subagents(conn, 1, historical=False)[0]

    assert historical["input_tokens"] == 1_000_250
    assert historical["output_tokens"] == 50
    assert historical["error_count"] == 1
    assert historical["api_equivalent_usd"] == 15.0
    assert current["api_equivalent_usd"] == 5.0
    assert historical["cost_available"] is True
    assert historical["unpriced_models"] == ["custom-unpriced-model"]

    system_items = [item for item in repository.get_timeline(conn, 1) if item["kind"] == "system"]
    assert sorted(item["is_error"] for item in system_items) == [False, True]

    unpriced = repository.list_subagents(conn, 2, historical=True)[0]
    assert unpriced["api_equivalent_usd"] == 0
    assert unpriced["cost_available"] is True
    assert unpriced["unpriced_models"] == ["only-unpriced-model"]


def test_tool_activity_reports_receipt_sizes_without_allocating_model_cost(tmp_path):
    conn = connect(tmp_path / "db.sqlite3")
    _seed_two_dated_sessions(conn)
    raw_result = _seed_session_activity(conn)

    activity = repository.list_tool_activity(conn, 1)

    assert activity == [
        {
            "tool_name": "Read",
            "call_count": 2,
            "error_count": 1,
            "observed_result_bytes": len(raw_result.encode("utf-8")),
            "persisted_result_bytes": 1234,
        }
    ]
    assert "api_equivalent_usd" not in activity[0]


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
