from __future__ import annotations

import json
import sqlite3
from typing import Any

import pytest

from ccfr.analysis.session_findings import (
    LARGE_TOOL_RESULT_THRESHOLD_BYTES,
    normalize_failure_signature,
    normalize_tool_arguments,
    normalize_tool_name,
    rebuild_session_findings,
)
from ccfr.storage import init_db


def memory_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_db(conn)
    return conn


def add_session(conn: sqlite3.Connection, external_id: str = "session-a") -> int:
    import_id = conn.execute(
        "INSERT INTO imports(source_path, imported_at, status) VALUES (?, '2026-01-01', 'completed')",
        (f"/{external_id}",),
    ).lastrowid
    project_id = conn.execute(
        "INSERT INTO projects(import_id, export_name) VALUES (?, ?)",
        (import_id, f"project-{external_id}"),
    ).lastrowid
    return int(
        conn.execute(
            "INSERT INTO sessions(project_id, session_id) VALUES (?, ?)",
            (project_id, external_id),
        ).lastrowid
    )


def add_event(conn: sqlite3.Connection, session_id: int, *, event_type: str = "event") -> int:
    line_no = int(
        conn.execute("SELECT COUNT(*) FROM events WHERE session_id = ?", (session_id,)).fetchone()[0]
    ) + 1
    return int(
        conn.execute(
            """
            INSERT INTO events(session_id, source_path, line_no, type, raw_json)
            VALUES (?, 'fixture.jsonl', ?, ?, '{}')
            """,
            (session_id, line_no, event_type),
        ).lastrowid
    )


def add_receipt(
    conn: sqlite3.Connection,
    session_id: int,
    *,
    tool_name: str,
    arguments: dict[str, Any],
    output: str,
    is_error: bool,
    persisted_size: int | None = None,
    call_event_id: int | None = None,
    result_event_id: int | None = None,
) -> tuple[int, int]:
    ordinal = int(conn.execute("SELECT COUNT(*) FROM tool_calls").fetchone()[0]) + 1
    tool_use_id = f"tool-{ordinal}"
    if call_event_id is None:
        call_event_id = add_event(conn, session_id, event_type="assistant")
    call_json = {
        "type": "tool_use",
        "id": tool_use_id,
        "name": tool_name,
        "input": arguments,
    }
    conn.execute(
        """
        INSERT INTO tool_calls(event_id, session_id, tool_use_id, tool_name, input_preview, raw_json)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (call_event_id, session_id, tool_use_id, tool_name, json.dumps(arguments), json.dumps(call_json)),
    )

    persisted_output_id = None
    if persisted_size is not None:
        persisted_output_id = conn.execute(
            """
            INSERT INTO persisted_outputs(session_id, path, size_bytes, first_line_preview)
            VALUES (?, ?, ?, ?)
            """,
            (session_id, f"outputs/{tool_use_id}.txt", persisted_size, output[:80]),
        ).lastrowid

    if result_event_id is None:
        result_event_id = add_event(conn, session_id, event_type="user")
    result_json = {
        "type": "tool_result",
        "tool_use_id": tool_use_id,
        "is_error": is_error,
        "content": output,
    }
    conn.execute(
        """
        INSERT INTO tool_results(
            event_id, session_id, tool_use_id, is_error, output_preview,
            persisted_output_id, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            result_event_id,
            session_id,
            tool_use_id,
            int(is_error),
            output,
            persisted_output_id,
            json.dumps(result_json),
        ),
    )
    return call_event_id, result_event_id


def findings(conn: sqlite3.Connection, session_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM session_findings WHERE session_id = ? ORDER BY detector_key, start_event_id, id",
        (session_id,),
    ).fetchall()


def detector_keys(conn: sqlite3.Connection, session_id: int) -> list[str]:
    rebuild_session_findings(conn, session_ids=[session_id])
    return [str(row["detector_key"]) for row in findings(conn, session_id)]


@pytest.mark.parametrize(
    ("detector_key", "output", "errors", "persisted_size"),
    [
        ("permission_rejected", "User rejected tool use", [True, True], None),
        ("timeout", "operation timed out", [True, True], None),
        ("missing_dependency_or_command", "command not found", [True, True], None),
        (
            "large_tool_result",
            "large output",
            [False, False],
            LARGE_TOOL_RESULT_THRESHOLD_BYTES,
        ),
        (
            "repeated_identical_failure",
            "same test failure",
            [True, True, False, True, True],
            None,
        ),
    ],
)
def test_findings_distinguish_results_sharing_one_event(
    detector_key: str,
    output: str,
    errors: list[bool],
    persisted_size: int | None,
) -> None:
    conn = memory_conn()
    session_id = add_session(conn)
    call_event_id = add_event(conn, session_id, event_type="assistant")
    result_event_id = add_event(conn, session_id, event_type="user")
    for is_error in errors:
        add_receipt(
            conn,
            session_id,
            tool_name="Bash",
            arguments={"command": "pytest -q"},
            output=output if is_error else "successful output",
            is_error=is_error,
            persisted_size=persisted_size,
            call_event_id=call_event_id,
            result_event_id=result_event_id,
        )

    rebuild_session_findings(conn, session_ids=[session_id])

    rows = findings(conn, session_id)
    assert sum(row["detector_key"] == detector_key for row in rows) == 2
    assert len({row["finding_key"] for row in rows}) == len(rows)
    for row in rows:
        assert row["start_event_id"] == result_event_id
        assert row["end_event_id"] == result_event_id
        evidence = json.loads(row["evidence_json"])
        if row["detector_key"] == "repeated_identical_failure":
            assert evidence["occurrence_count"] == 2
            assert evidence["event_ids"] == [call_event_id, result_event_id] * 2
        else:
            assert evidence["event_ids"] == [result_event_id]

    first_snapshot = [
        {key: row[key] for key in row.keys() if key != "id"} for row in rows
    ]
    rebuild_session_findings(conn, session_ids=[session_id])
    assert [
        {key: row[key] for key in row.keys() if key != "id"}
        for row in findings(conn, session_id)
    ] == first_snapshot


def test_normalization_helpers_are_pure_and_deterministic() -> None:
    arguments = {"offset": 20, "file_path": "src/example.py", "query": "  one   two  "}

    assert normalize_tool_name("  BaSH ") == "bash"
    assert normalize_tool_arguments(arguments) == (
        '{"file_path":"src/example.py","offset":20,"query":"one two"}'
    )
    assert normalize_failure_signature("\x1b[31mFAILED\x1b[0m\n  Exit   Code 2") == "failed exit code 2"
    assert arguments["query"] == "  one   two  "


def test_repeated_identical_failure_requires_matching_receipts() -> None:
    conn = memory_conn()
    session_id = add_session(conn)
    first_call, first_result = add_receipt(
        conn,
        session_id,
        tool_name="Bash",
        arguments={"command": "pytest -q"},
        output="FAILED  tests/test_example.py\nexit code 1",
        is_error=True,
    )
    second_call, second_result = add_receipt(
        conn,
        session_id,
        tool_name=" bash ",
        arguments={"command": "pytest   -q"},
        output=" failed tests/test_example.py  EXIT CODE 1 ",
        is_error=True,
    )

    rebuild_session_findings(conn, session_ids=[session_id])

    row = findings(conn, session_id)[0]
    evidence = json.loads(row["evidence_json"])
    assert row["detector_key"] == "repeated_identical_failure"
    assert row["basis"] == "observed"
    assert row["recommendation"] is None
    assert row["start_event_id"] == first_result
    assert row["end_event_id"] == second_result
    assert evidence["event_ids"] == [first_call, first_result, second_call, second_result]
    assert evidence["occurrence_count"] == 2
    assert evidence["normalized_tool_name"] == "bash"
    assert evidence["normalized_arguments"] == '{"command":"pytest -q"}'
    assert evidence["failure_signature"] == "failed tests/test_example.py exit code 1"


@pytest.mark.parametrize(
    ("tool_name", "first_arguments", "second_arguments"),
    [
        ("Read", {"file_path": "src/a.py"}, {"file_path": "src/b.py"}),
        (
            "Read",
            {"file_path": "src/a.py", "offset": 1, "limit": 100},
            {"file_path": "src/a.py", "offset": 101, "limit": 100},
        ),
        ("Bash", {"command": "pytest tests/a.py"}, {"command": "pytest tests/b.py"}),
    ],
)
def test_repeated_failure_does_not_merge_changed_arguments(
    tool_name: str,
    first_arguments: dict[str, Any],
    second_arguments: dict[str, Any],
) -> None:
    conn = memory_conn()
    session_id = add_session(conn)
    add_receipt(
        conn,
        session_id,
        tool_name=tool_name,
        arguments=first_arguments,
        output="same observed failure",
        is_error=True,
    )
    add_receipt(
        conn,
        session_id,
        tool_name=tool_name,
        arguments=second_arguments,
        output="same observed failure",
        is_error=True,
    )

    assert detector_keys(conn, session_id) == []


def test_successful_state_change_breaks_repeated_failure_segment() -> None:
    conn = memory_conn()
    session_id = add_session(conn)
    failing = dict(
        tool_name="Bash",
        arguments={"command": "pytest -q"},
        output="one test failed",
        is_error=True,
    )
    add_receipt(conn, session_id, **failing)
    add_receipt(
        conn,
        session_id,
        tool_name="Edit",
        arguments={"file_path": "src/example.py", "old_string": "a", "new_string": "b"},
        output="updated file",
        is_error=False,
    )
    add_receipt(conn, session_id, **failing)

    assert detector_keys(conn, session_id) == []


def test_repeated_failure_requires_the_same_failure_signature() -> None:
    conn = memory_conn()
    session_id = add_session(conn)
    common = {
        "tool_name": "Bash",
        "arguments": {"command": "pytest -q"},
        "is_error": True,
    }
    add_receipt(conn, session_id, output="test_alpha failed", **common)
    add_receipt(conn, session_id, output="test_beta failed", **common)

    assert detector_keys(conn, session_id) == []


def test_successful_repeats_and_tdd_fail_edit_pass_do_not_match() -> None:
    conn = memory_conn()
    session_id = add_session(conn)
    for _ in range(2):
        add_receipt(
            conn,
            session_id,
            tool_name="Read",
            arguments={"file_path": "src/example.py"},
            output="file contents",
            is_error=False,
        )
    add_receipt(
        conn,
        session_id,
        tool_name="Bash",
        arguments={"command": "pytest -q"},
        output="one test failed",
        is_error=True,
    )
    add_receipt(
        conn,
        session_id,
        tool_name="Edit",
        arguments={"file_path": "src/example.py"},
        output="updated file",
        is_error=False,
    )
    add_receipt(
        conn,
        session_id,
        tool_name="Bash",
        arguments={"command": "pytest -q"},
        output="all tests passed",
        is_error=False,
    )

    assert detector_keys(conn, session_id) == []


def test_timeout_requires_narrow_observed_error_evidence() -> None:
    conn = memory_conn()
    session_id = add_session(conn)
    _call, result = add_receipt(
        conn,
        session_id,
        tool_name="Bash",
        arguments={"command": "pytest -q"},
        output="Command timed out after 120000 ms",
        is_error=True,
    )

    rebuild_session_findings(conn, session_ids=[session_id])

    row = findings(conn, session_id)[0]
    evidence = json.loads(row["evidence_json"])
    assert row["detector_key"] == "timeout"
    assert row["basis"] == "observed"
    assert row["recommendation"] is None
    assert evidence["event_ids"] == [result]
    assert evidence["match_type"] == "timed_out"


@pytest.mark.parametrize(
    ("output", "match_type"),
    [
        ("ModuleNotFoundError: No module named 'example_dep'", "module_not_found"),
        ("/bin/sh: example-command: command not found", "command_not_found"),
    ],
)
def test_missing_dependency_or_command_matches_specific_errors(output: str, match_type: str) -> None:
    conn = memory_conn()
    session_id = add_session(conn)
    _call, result = add_receipt(
        conn,
        session_id,
        tool_name="Bash",
        arguments={"command": "example-command"},
        output=output,
        is_error=True,
    )

    rebuild_session_findings(conn, session_ids=[session_id])

    row = findings(conn, session_id)[0]
    evidence = json.loads(row["evidence_json"])
    assert row["detector_key"] == "missing_dependency_or_command"
    assert row["basis"] == "observed"
    assert row["recommendation"] is None
    assert evidence["event_ids"] == [result]
    assert evidence["match_type"] == match_type


def test_permission_rejection_requires_narrow_observed_error_evidence() -> None:
    conn = memory_conn()
    session_id = add_session(conn)
    _call, result = add_receipt(
        conn,
        session_id,
        tool_name="Write",
        arguments={"file_path": "/protected/example.txt"},
        output="Permission denied: /protected/example.txt",
        is_error=True,
    )

    rebuild_session_findings(conn, session_ids=[session_id])

    row = findings(conn, session_id)[0]
    evidence = json.loads(row["evidence_json"])
    assert row["detector_key"] == "permission_rejected"
    assert row["basis"] == "observed"
    assert row["recommendation"] is None
    assert evidence["event_ids"] == [result]
    assert evidence["match_type"] == "permission_denied"


def test_error_keywords_in_unrelated_prose_and_successes_do_not_match() -> None:
    conn = memory_conn()
    session_id = add_session(conn)
    for output in (
        "AssertionError: documentation should mention timeout behavior",
        "ValidationError: permission label did not render",
        "ValueError: package selection is invalid",
    ):
        add_receipt(
            conn,
            session_id,
            tool_name="Bash",
            arguments={"command": output},
            output=output,
            is_error=True,
        )
    add_receipt(
        conn,
        session_id,
        tool_name="Read",
        arguments={"file_path": "README.md"},
        output="permission denied, command timed out, ModuleNotFoundError: No module named 'x'",
        is_error=False,
    )

    assert detector_keys(conn, session_id) == []


def test_large_tool_result_uses_observed_persisted_size_and_exact_threshold() -> None:
    conn = memory_conn()
    session_id = add_session(conn)
    _call, result = add_receipt(
        conn,
        session_id,
        tool_name="Read",
        arguments={"file_path": "build/large.log"},
        output="Full output saved",
        is_error=False,
        persisted_size=LARGE_TOOL_RESULT_THRESHOLD_BYTES,
    )
    add_receipt(
        conn,
        session_id,
        tool_name="Read",
        arguments={"file_path": "build/smaller.log"},
        output="Full output saved",
        is_error=False,
        persisted_size=LARGE_TOOL_RESULT_THRESHOLD_BYTES - 1,
    )

    rebuild_session_findings(conn, session_ids=[session_id])

    rows = findings(conn, session_id)
    assert len(rows) == 1
    row = rows[0]
    evidence = json.loads(row["evidence_json"])
    assert row["detector_key"] == "large_tool_result"
    assert row["basis"] == "estimated"
    assert row["recommendation"] is None
    assert row["start_event_id"] == result
    assert evidence["event_ids"] == [result]
    assert evidence["observed_size_bytes"] == LARGE_TOOL_RESULT_THRESHOLD_BYTES
    assert evidence["threshold_bytes"] == LARGE_TOOL_RESULT_THRESHOLD_BYTES


def test_long_session_and_high_subagent_fanout_are_not_findings() -> None:
    conn = memory_conn()
    session_id = add_session(conn)
    conn.execute(
        "UPDATE sessions SET first_ts = '2026-01-01', last_ts = '2026-01-03' WHERE id = ?",
        (session_id,),
    )
    for index in range(30):
        conn.execute(
            """
            INSERT INTO subagents(parent_session_id, agent_id, event_count)
            VALUES (?, ?, 1000)
            """,
            (session_id, f"agent-{index}"),
        )

    assert detector_keys(conn, session_id) == []


def test_rebuild_is_idempotent_and_can_target_one_session() -> None:
    conn = memory_conn()
    first_session = add_session(conn, "session-a")
    second_session = add_session(conn, "session-b")
    for _ in range(2):
        add_receipt(
            conn,
            first_session,
            tool_name="Bash",
            arguments={"command": "pytest -q"},
            output="same failure",
            is_error=True,
        )
    add_receipt(
        conn,
        second_session,
        tool_name="Bash",
        arguments={"command": "slow-command"},
        output="operation timed out after 30 seconds",
        is_error=True,
    )

    rebuild_session_findings(conn)
    first_snapshot = [
        tuple(row[key] for key in row.keys() if key != "id")
        for row in conn.execute("SELECT * FROM session_findings ORDER BY session_id, finding_key")
    ]
    rebuild_session_findings(conn)
    second_snapshot = [
        tuple(row[key] for key in row.keys() if key != "id")
        for row in conn.execute("SELECT * FROM session_findings ORDER BY session_id, finding_key")
    ]
    assert first_snapshot == second_snapshot

    second_finding_before = conn.execute(
        "SELECT * FROM session_findings WHERE session_id = ?", (second_session,)
    ).fetchone()
    conn.execute("UPDATE tool_results SET is_error = 0 WHERE session_id = ?", (first_session,))
    rebuild_session_findings(conn, session_ids=[first_session])

    assert findings(conn, first_session) == []
    second_finding_after = conn.execute(
        "SELECT * FROM session_findings WHERE session_id = ?", (second_session,)
    ).fetchone()
    assert dict(second_finding_after) == dict(second_finding_before)
