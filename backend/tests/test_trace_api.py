from __future__ import annotations

import sqlite3
from pathlib import Path

from ccfr.api import repository
from ccfr.ingest import import_export
from ccfr.storage import init_db
from tests.fixtures import sanitized_export


def _conn(tmp_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_db(conn)
    import_export(conn, sanitized_export(tmp_path))
    return conn


def test_list_sessions_includes_new_signal_fields(tmp_path: Path) -> None:
    conn = _conn(tmp_path)
    sessions = repository.list_sessions(conn)
    assert sessions
    sample = sessions[0]
    for key in (
        "duration_seconds",
        "loop_count",
        "max_repeat",
        "max_agent_events",
        "finding_count",
        "pattern_risk_score",
    ):
        assert key in sample
        assert isinstance(sample[key], int | float)
    # Guard against silent all-zero bugs: the fixture has subagents, real
    # durations, and at least one tool call, so these aggregates must be populated.
    assert any(s["duration_seconds"] > 0 for s in sessions)
    assert any(s["max_agent_events"] > 0 for s in sessions)
    assert any(s["max_repeat"] >= 1 for s in sessions)


def test_list_sessions_rounds_known_duration_seconds() -> None:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_db(conn)
    import_id = conn.execute(
        """
        INSERT INTO imports (source_path, imported_at, file_count, status, error_count)
        VALUES (?, ?, 0, ?, 0)
        """,
        ("fixture", "2026-01-01T00:00:00Z", "complete"),
    ).lastrowid
    project_id = conn.execute(
        "INSERT INTO projects (import_id, export_name, inferred_cwd) VALUES (?, ?, ?)",
        (import_id, "fixture-project", None),
    ).lastrowid
    conn.execute(
        """
        INSERT INTO sessions (project_id, session_id, first_ts, last_ts)
        VALUES (?, ?, ?, ?)
        """,
        (
            project_id,
            "known-duration",
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:01:30Z",
        ),
    )

    sessions = repository.list_sessions(conn)

    assert sessions[0]["duration_seconds"] == 90


def test_get_trace_returns_lanes_and_spans(tmp_path: Path) -> None:
    conn = _conn(tmp_path)
    sessions = repository.list_sessions(conn, has_subagents=True)
    session_id = sessions[0]["id"]
    trace = repository.get_trace(conn, session_id)

    assert trace["session_id"] == session_id
    assert any(lane["lane_id"] == "main" for lane in trace["lanes"])
    assert trace["spans"]
    assert all(
        "lane" in span
        and "kind" in span
        and "tool_name" in span
        and "loop_run_id" in span
        and "loop_position" in span
        and "loop_count" in span
        for span in trace["spans"]
    )
    # subagent sessions should produce at least one non-main lane
    assert any(lane["kind"] == "subagent" for lane in trace["lanes"])

    span_ids = [s["id"] for s in trace["spans"]]
    assert len(span_ids) == len(set(span_ids))  # no duplicate span ids
    event_ids = [s["event_id"] for s in trace["spans"]]
    assert len(event_ids) == len(set(event_ids))  # exactly one span per event


def test_get_trace_spans_carry_token_usage(tmp_path: Path) -> None:
    conn = _conn(tmp_path)
    sessions = repository.list_sessions(conn)
    session_id = sessions[0]["id"]
    trace = repository.get_trace(conn, session_id)

    assert trace["spans"]
    for span in trace["spans"]:
        assert "input_tokens" in span
        assert "output_tokens" in span
        assert isinstance(span["input_tokens"], int)
        assert isinstance(span["output_tokens"], int)
    # The fixture has assistant messages with usage, so at least one span
    # must report non-zero tokens (guards against an all-zero wiring bug).
    assert any(s["input_tokens"] > 0 or s["output_tokens"] > 0 for s in trace["spans"])
    # Input must include cached tokens: the bare `usage.input_tokens` is only a handful,
    # but cache_creation/cache_read push the real input into the thousands. This guards
    # against regressing to total ~= output.
    assert max(s["input_tokens"] for s in trace["spans"]) > 1000


def test_get_trace_spans_carry_model(tmp_path: Path) -> None:
    conn = _conn(tmp_path)
    sessions = repository.list_sessions(conn)
    session_id = sessions[0]["id"]
    trace = repository.get_trace(conn, session_id)

    assert trace["spans"]
    for span in trace["spans"]:
        assert "model" in span
        assert span["model"] is None or isinstance(span["model"], str)
    # The fixture has assistant messages, so at least one span carries a model.
    assert any(s["model"] for s in trace["spans"])
