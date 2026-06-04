from __future__ import annotations

import sqlite3
from pathlib import Path

from ccfr.analysis.metrics import compute_loop_stats, loop_contexts, loop_indices
from ccfr.analysis.trace import build_trace
from ccfr.ingest import import_export
from ccfr.storage import init_db
from tests.fixtures import sanitized_export


def test_compute_loop_stats_counts_runs_and_longest() -> None:
    names = ["Read", "Read", "Read", "Bash", "Bash", "Grep"]
    loop_count, max_repeat = compute_loop_stats(names, min_run=3)
    assert loop_count == 1          # only the Read run reaches min_run
    assert max_repeat == 3          # longest consecutive identical run


def test_compute_loop_stats_ignores_none_and_handles_empty() -> None:
    assert compute_loop_stats([], min_run=3) == (0, 0)
    assert compute_loop_stats([None, None, None], min_run=3) == (0, 0)
    assert compute_loop_stats(["X"], min_run=3) == (0, 1)


def test_loop_indices_marks_only_long_runs() -> None:
    names = ["A", "A", "A", "B", "A", "A"]
    assert loop_indices(names, min_run=3) == {0, 1, 2}


def test_compute_loop_stats_counts_multiple_qualifying_runs() -> None:
    names = ["A", "A", "A", "B", "B", "B"]
    assert compute_loop_stats(names, min_run=3) == (2, 3)


def test_loop_indices_handles_none_gap_and_multiple_runs() -> None:
    assert loop_indices(["A", "A", "A", None, "A", "A", "A"], min_run=3) == {0, 1, 2, 4, 5, 6}
    assert loop_indices(["A", "A", "A", "B", "B", "B"], min_run=3) == {0, 1, 2, 3, 4, 5}


def test_loop_contexts_explains_position_and_run_bounds() -> None:
    contexts = loop_contexts(["Read", "Read", "Read", "Bash"], min_run=3)

    assert contexts[0]["run_index"] == 1
    assert contexts[1]["position"] == 2
    assert contexts[2]["count"] == 3
    assert contexts[2]["start_index"] == 0
    assert contexts[2]["end_index"] == 2
    assert contexts[2]["tool_name"] == "Read"
    assert 3 not in contexts


def test_session_stats_has_loop_columns_after_import(tmp_path: Path) -> None:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_db(conn)
    import_export(conn, sanitized_export(tmp_path))
    row = conn.execute(
        "SELECT loop_count, max_repeat FROM session_stats LIMIT 1"
    ).fetchone()
    assert row is not None
    assert row["loop_count"] >= 0
    assert row["max_repeat"] >= 0
    counts = conn.execute(
        "SELECT (SELECT COUNT(*) FROM sessions) AS sessions, (SELECT COUNT(*) FROM session_stats) AS stats"
    ).fetchone()
    assert counts["stats"] == counts["sessions"]


def test_build_trace_assigns_lanes_pairs_tools_and_marks_loops() -> None:
    rows = [
        {"event_id": 1, "kind": "user_turn", "timestamp": "t0", "tool_name": None,
         "tool_use_id": None, "agent_id": None, "is_sidechain": False},
        {"event_id": 2, "kind": "tool_call", "timestamp": "t1", "tool_name": "Read",
         "tool_use_id": "u1", "agent_id": None, "is_sidechain": False},
        {"event_id": 3, "kind": "tool_call", "timestamp": "t2", "tool_name": "Read",
         "tool_use_id": "u2", "agent_id": None, "is_sidechain": False},
        {"event_id": 4, "kind": "tool_call", "timestamp": "t3", "tool_name": "Read",
         "tool_use_id": "u3", "agent_id": None, "is_sidechain": False},
        {"event_id": 5, "kind": "subagent_event", "timestamp": "t4", "tool_name": None,
         "tool_use_id": None, "agent_id": "a1", "is_sidechain": True},
    ]
    result_ts = {"u1": "t1b"}
    trace = build_trace(session_id=7, rows=rows, result_ts_by_use_id=result_ts)

    assert trace["session_id"] == 7
    assert trace["first_ts"] == "t0" and trace["last_ts"] == "t4"
    lane_ids = [lane["lane_id"] for lane in trace["lanes"]]
    assert lane_ids == ["main", "a1"]
    spans = {s["event_id"]: s for s in trace["spans"]}
    assert spans[2]["end_ts"] == "t1b"          # paired tool cycle
    assert spans[2]["tool_name"] == "Read"
    assert spans[3]["end_ts"] is None           # unpaired
    assert spans[2]["is_loop"] and spans[3]["is_loop"] and spans[4]["is_loop"]
    assert spans[2]["loop_run_id"] == "main-tool-loop-1"
    assert spans[3]["loop_position"] == 2
    assert spans[4]["loop_count"] == 3
    assert spans[4]["loop_start_event_id"] == 2
    assert spans[4]["loop_end_event_id"] == 4
    assert spans[5]["lane"] == "a1"
