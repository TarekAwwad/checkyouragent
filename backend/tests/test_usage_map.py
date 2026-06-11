from __future__ import annotations

import json
import sqlite3

import pytest
from fastapi.testclient import TestClient

from ccfr.analysis.pricing import ModelPrice
from ccfr.analysis import usage_map
from ccfr.analysis.usage_map import (
    HABIT_BY_KEY,
    EventRec,
    HabitFinding,
    ToolCallRec,
    _in_window,
    aggregate_habits,
    aggregate_phases,
    classify_tool_call,
    detect_blind_retry,
    detect_context_habits,
    detect_delegation,
    detect_plan_before_burst,
    detect_tdd_loop,
    event_phase_weights,
    load_events,
    run_habit_detectors,
)
from ccfr.storage import init_db


# ---------------------------------------------------------------------------
# Phase classifier
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("tool,phase", [
    ("Read", "explore"), ("Grep", "explore"), ("Glob", "explore"), ("LS", "explore"),
    ("WebFetch", "explore"), ("WebSearch", "explore"), ("NotebookRead", "explore"),
    ("TodoWrite", "plan"), ("EnterPlanMode", "plan"), ("ExitPlanMode", "plan"),
    ("AskUserQuestion", "plan"),
    ("Edit", "implement"), ("Write", "implement"), ("MultiEdit", "implement"),
    ("NotebookEdit", "implement"),
    ("Task", "delegate"), ("Agent", "delegate"),
])
def test_classify_known_tools(tool: str, phase: str) -> None:
    assert classify_tool_call(tool) == phase


@pytest.mark.parametrize("command", [
    "uv run pytest tests/test_x.py",
    "npx vitest run",
    "npm test",
    "npm run test:unit",
    "cd backend; pytest -x",
    "tsc --noEmit",
    "ruff check src",
    "cargo test",
    "go test ./...",
    "./pytest -x",
    "/usr/local/bin/pytest",
    "npm run build",
    "npm run lint-fix",
])
def test_classify_bash_verify_commands(command: str) -> None:
    assert classify_tool_call("Bash", command) == "verify"


@pytest.mark.parametrize("command", [
    "git status",
    "ls -la",
    "mkdir build",
    "python script.py",       # plain run, not a test runner
    "echo pytestish",         # word boundary: not a verify command
    "npm run buildstories",   # script-name prefix only counts before -, :, or .
    "npm run linting",
])
def test_classify_bash_other_commands_are_operate(command: str) -> None:
    assert classify_tool_call("Bash", command) == "operate"


def test_classify_unknown_and_missing_tools_are_converse() -> None:
    assert classify_tool_call("mcp__some__tool") == "converse"
    assert classify_tool_call(None) == "converse"
    assert classify_tool_call("") == "converse"


def _event(event_id: int, tools: list[ToolCallRec], cost: float = 2.0,
           tokens: int = 1000, session: int = 1) -> EventRec:
    return EventRec(
        event_id=event_id, session_db_id=session, session_title="S",
        project_name="alpha", ts="2026-06-01T10:00:00Z", model="m",
        cost=cost, tokens=tokens, priced=True, tool_calls=tuple(tools),
    )


# ---------------------------------------------------------------------------
# Phase weights + aggregation
# ---------------------------------------------------------------------------

def test_text_only_event_is_all_converse() -> None:
    assert event_phase_weights(_event(1, [])) == {"converse": 1.0}


def test_weights_split_equally_across_tool_calls() -> None:
    event = _event(1, [
        ToolCallRec(tool_name="Read"),
        ToolCallRec(tool_name="Edit"),
    ])
    assert event_phase_weights(event) == {"explore": 0.5, "implement": 0.5}


def test_weights_merge_same_phase() -> None:
    event = _event(1, [ToolCallRec(tool_name="Read"), ToolCallRec(tool_name="Grep")])
    assert event_phase_weights(event) == {"explore": 1.0}


def test_aggregate_phases_sums_to_total_cost() -> None:
    events = [
        _event(1, [ToolCallRec(tool_name="Read")], cost=3.0),
        _event(2, [ToolCallRec(tool_name="Edit"), ToolCallRec(tool_name="Bash", command="git add .")],
               cost=2.0),
        _event(3, [], cost=1.0),
    ]
    acc = aggregate_phases(events)
    assert sum(bucket["cost_usd"] for bucket in acc.values()) == pytest.approx(6.0)
    assert acc["explore"]["cost_usd"] == pytest.approx(3.0)
    assert acc["implement"]["cost_usd"] == pytest.approx(1.0)
    assert acc["operate"]["cost_usd"] == pytest.approx(1.0)
    assert acc["converse"]["cost_usd"] == pytest.approx(1.0)


def test_aggregate_phases_counts_tools_and_sessions() -> None:
    events = [
        _event(1, [ToolCallRec(tool_name="Read")], session=1),
        _event(2, [ToolCallRec(tool_name="Read")], session=2),
    ]
    acc = aggregate_phases(events)
    assert acc["explore"]["tool_count"] == 2
    assert acc["explore"]["sessions"] == {1, 2}
    assert acc["plan"]["tool_count"] == 0


PRICE_TABLE = {
    "claude-opus-4-8": ModelPrice(base_input=5, cache_write_5m=6.25,
                                  cache_write_1h=10, cache_read=0.5, output=25),
}


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    init_db(conn)
    return conn


def _seed_base(conn: sqlite3.Connection) -> None:
    conn.execute("INSERT INTO imports (id, source_path, imported_at, file_count, status) "
                 "VALUES (1, '/exports', '2026-06-01T00:00:00Z', 2, 'complete')")
    conn.execute("INSERT INTO projects (id, import_id, export_name, inferred_cwd) "
                 "VALUES (1, 1, 'd--Alpha', '/workspace/alpha')")
    conn.execute("INSERT INTO projects (id, import_id, export_name, inferred_cwd) "
                 "VALUES (2, 1, 'd--Beta', '/workspace/beta')")
    conn.execute("INSERT INTO sessions (id, project_id, session_id, title) "
                 "VALUES (1, 1, 's-alpha', 'Alpha work')")
    conn.execute("INSERT INTO sessions (id, project_id, session_id, title) "
                 "VALUES (2, 2, 's-beta', 'Beta work')")
    conn.commit()


def _add_assistant_event(conn: sqlite3.Connection, event_id: int, session_id: int,
                         ts: str, tools: list[tuple[str, dict, bool]],
                         *, base: int = 200_000, out: int = 40_000,
                         model: str = "claude-opus-4-8") -> None:
    """tools: list of (tool_name, input_dict, is_error). With PRICE_TABLE the
    default token mix costs exactly $2.00 (200k*$5 + 40k*$25, per million)."""
    conn.execute(
        "INSERT INTO events (id, session_id, source_path, line_no, uuid, type, timestamp, raw_json) "
        "VALUES (?, ?, 'x.jsonl', 1, ?, 'assistant', ?, '{}')",
        (event_id, session_id, f"uuid-{event_id}", ts),
    )
    conn.execute(
        "INSERT INTO messages (event_id, role, model, base_input_tokens, output_tokens) "
        "VALUES (?, 'assistant', ?, ?, ?)",
        (event_id, model, base, out),
    )
    for i, (name, input_data, is_error) in enumerate(tools):
        tool_use_id = f"tu-{event_id}-{i}"
        conn.execute(
            "INSERT INTO tool_calls (event_id, session_id, tool_use_id, tool_name, input_preview, raw_json) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (event_id, session_id, tool_use_id, name,
             json.dumps(input_data, sort_keys=True), json.dumps({"input": input_data})),
        )
        # In real exports the result lives on a later user-type event; the loader
        # joins on (session_id, tool_use_id) only, so attaching it here is fine.
        conn.execute(
            "INSERT INTO tool_results (event_id, session_id, tool_use_id, is_error, raw_json) "
            "VALUES (?, ?, ?, ?, '{}')",
            (event_id, session_id, tool_use_id, 1 if is_error else 0),
        )
    conn.commit()


# ---------------------------------------------------------------------------
# DB loader
# ---------------------------------------------------------------------------

def test_load_events_builds_records_with_costs() -> None:
    conn = _conn()
    _seed_base(conn)
    _add_assistant_event(conn, 1, 1, "2026-06-01T10:00:00Z",
                         [("Read", {"file_path": "a.py"}, False)])
    _add_assistant_event(conn, 2, 1, "2026-06-01T10:01:00Z", [])  # text-only

    events = load_events(conn, PRICE_TABLE)

    assert [e.event_id for e in events] == [1, 2]
    first = events[0]
    assert first.cost == pytest.approx(2.0)
    assert first.tokens == 240_000
    assert first.priced is True
    assert first.project_name  # display name resolved, non-empty
    assert len(first.tool_calls) == 1
    call = first.tool_calls[0]
    assert (call.tool_name, call.detail, call.is_error) == ("Read", "a.py", False)
    assert call.signature  # input_preview captured
    assert events[1].tool_calls == ()


def test_load_events_captures_bash_command_and_error_flag() -> None:
    conn = _conn()
    _seed_base(conn)
    _add_assistant_event(conn, 1, 1, "2026-06-01T10:00:00Z",
                         [("Bash", {"command": "uv run pytest"}, True)])
    events = load_events(conn, PRICE_TABLE)
    call = events[0].tool_calls[0]
    assert call.command == "uv run pytest"
    assert call.is_error is True


def test_load_events_project_filter() -> None:
    conn = _conn()
    _seed_base(conn)
    _add_assistant_event(conn, 1, 1, "2026-06-01T10:00:00Z", [])
    _add_assistant_event(conn, 2, 2, "2026-06-01T10:00:00Z", [])
    assert [e.session_db_id for e in load_events(conn, PRICE_TABLE, project_id=2)] == [2]


def test_load_events_date_window_filter() -> None:
    conn = _conn()
    _seed_base(conn)
    _add_assistant_event(conn, 1, 1, "2026-05-20T10:00:00Z", [])
    _add_assistant_event(conn, 2, 1, "2026-06-01T10:00:00Z", [])
    _add_assistant_event(conn, 3, 1, "2026-06-10T10:00:00Z", [])
    events = load_events(conn, PRICE_TABLE, date_from="2026-06-01", date_to="2026-06-05")
    assert [e.event_id for e in events] == [2]


def test_load_events_unpriced_model_costs_zero_and_flags() -> None:
    conn = _conn()
    _seed_base(conn)
    _add_assistant_event(conn, 1, 1, "2026-06-01T10:00:00Z", [], model="mystery-model")
    event = load_events(conn, PRICE_TABLE)[0]
    assert event.cost == 0.0
    assert event.priced is False
    assert event.tokens == 240_000


def test_load_events_duplicate_tool_results_do_not_fan_out() -> None:
    conn = _conn()
    _seed_base(conn)
    _add_assistant_event(conn, 1, 1, "2026-06-01T10:00:00Z",
                         [("Bash", {"command": "git push"}, False)])
    # A second result row for the same tool_use_id (e.g. odd re-import) must not
    # duplicate the call; is_error folds with MAX.
    conn.execute(
        "INSERT INTO tool_results (event_id, session_id, tool_use_id, is_error, raw_json) "
        "VALUES (1, 1, 'tu-1-0', 1, '{}')",
    )
    conn.commit()
    events = load_events(conn, PRICE_TABLE)
    assert len(events[0].tool_calls) == 1
    assert events[0].tool_calls[0].is_error is True


def test_load_events_null_tool_use_id_results_are_ignored() -> None:
    conn = _conn()
    _seed_base(conn)
    _add_assistant_event(conn, 1, 1, "2026-06-01T10:00:00Z",
                         [("Read", {"file_path": "a.py"}, False)])
    conn.execute(
        "INSERT INTO tool_results (event_id, session_id, tool_use_id, is_error, raw_json) "
        "VALUES (1, 1, NULL, 1, '{}')",
    )
    conn.commit()
    events = load_events(conn, PRICE_TABLE)
    assert len(events[0].tool_calls) == 1
    assert events[0].tool_calls[0].is_error is False


def _flat_event(event_id: int, tool: str, input_data: dict, is_error: bool,
                cost: float = 2.0) -> EventRec:
    sig = json.dumps(input_data, sort_keys=True)
    command = input_data.get("command")
    return _event(event_id, [ToolCallRec(tool_name=tool, command=command,
                                         detail=input_data.get("file_path"),
                                         signature=sig, is_error=is_error)],
                  cost=cost)


# ---------------------------------------------------------------------------
# Detector: blind retry
# ---------------------------------------------------------------------------

def test_blind_retry_flags_three_identical_failures() -> None:
    events = [
        _flat_event(1, "Bash", {"command": "git push"}, True),
        _flat_event(2, "Bash", {"command": "git push"}, True),
        _flat_event(3, "Bash", {"command": "git push"}, True),
    ]
    findings = detect_blind_retry(events)
    assert len(findings) == 1
    finding = findings[0]
    assert finding.habit_key == "blind-retry"
    assert finding.phase == "operate"        # phase of the retried tool
    assert finding.count == 3
    assert finding.cost_usd == pytest.approx(4.0)  # every attempt after the first
    assert finding.exemplar_event_ids == (1,)


def test_blind_retry_requires_identical_input() -> None:
    events = [
        _flat_event(1, "Bash", {"command": "git push"}, True),
        _flat_event(2, "Bash", {"command": "git push --force-with-lease"}, True),
        _flat_event(3, "Bash", {"command": "git push -u origin main"}, True),
    ]
    assert detect_blind_retry(events) == []


def test_blind_retry_requires_every_attempt_to_fail() -> None:
    events = [
        _flat_event(1, "Bash", {"command": "git push"}, True),
        _flat_event(2, "Bash", {"command": "git push"}, True),
        _flat_event(3, "Bash", {"command": "git push"}, False),  # finally worked
    ]
    assert detect_blind_retry(events) == []


def test_blind_retry_two_failures_is_below_threshold() -> None:
    events = [
        _flat_event(1, "Bash", {"command": "x"}, True),
        _flat_event(2, "Bash", {"command": "x"}, True),
    ]
    assert detect_blind_retry(events) == []


def test_blind_retry_empty_session() -> None:
    assert detect_blind_retry([]) == []


def test_blind_retry_two_distinct_runs_yield_two_findings() -> None:
    events = [
        _flat_event(1, "Bash", {"command": "a"}, True),
        _flat_event(2, "Bash", {"command": "a"}, True),
        _flat_event(3, "Bash", {"command": "a"}, True),
        _flat_event(4, "Edit", {"file_path": "x.py"}, True),
        _flat_event(5, "Edit", {"file_path": "x.py"}, True),
        _flat_event(6, "Edit", {"file_path": "x.py"}, True),
    ]
    findings = detect_blind_retry(events)
    assert [f.exemplar_event_ids for f in findings] == [(1,), (4,)]
    assert [f.phase for f in findings] == ["operate", "implement"]


def test_blind_retry_counts_longer_runs() -> None:
    events = [_flat_event(i, "Bash", {"command": "x"}, True) for i in range(1, 5)]
    findings = detect_blind_retry(events)
    assert findings[0].count == 4
    assert findings[0].cost_usd == pytest.approx(6.0)  # 3 repeats x $2


# ---------------------------------------------------------------------------
# Detector: TDD loop (fail -> edit -> same command passes)
# ---------------------------------------------------------------------------

def test_tdd_loop_detects_fail_edit_pass_cycle() -> None:
    events = [
        _flat_event(1, "Bash", {"command": "uv run pytest tests/test_a.py"}, True),
        _flat_event(2, "Edit", {"file_path": "a.py"}, False),
        _flat_event(3, "Bash", {"command": "uv run pytest tests/test_a.py"}, False),
    ]
    findings = detect_tdd_loop(events)
    assert len(findings) == 1
    finding = findings[0]
    assert finding.habit_key == "tdd-loop"
    assert finding.phase == "verify"
    assert finding.count == 1
    assert finding.cost_usd == pytest.approx(4.0)  # the two verify turns
    assert finding.exemplar_event_ids == (1,)


def test_tdd_loop_requires_an_edit_between_fail_and_pass() -> None:
    events = [
        _flat_event(1, "Bash", {"command": "uv run pytest"}, True),
        _flat_event(2, "Bash", {"command": "uv run pytest"}, False),  # flaky rerun
    ]
    assert detect_tdd_loop(events) == []


def test_tdd_loop_requires_same_command_to_pass() -> None:
    events = [
        _flat_event(1, "Bash", {"command": "uv run pytest tests/test_a.py"}, True),
        _flat_event(2, "Edit", {"file_path": "a.py"}, False),
        _flat_event(3, "Bash", {"command": "uv run pytest tests/test_b.py"}, False),
    ]
    assert detect_tdd_loop(events) == []


def test_tdd_loop_counts_multiple_cycles_in_one_finding() -> None:
    cycle = lambda n: [  # noqa: E731 - terse fixture builder
        _flat_event(n, "Bash", {"command": f"uv run pytest tests/t{n}.py"}, True),
        _flat_event(n + 1, "Edit", {"file_path": "a.py"}, False),
        _flat_event(n + 2, "Bash", {"command": f"uv run pytest tests/t{n}.py"}, False),
    ]
    findings = detect_tdd_loop(cycle(1) + cycle(10))
    assert len(findings) == 1
    assert findings[0].count == 2


def test_tdd_loop_refail_resets_the_edit_gate() -> None:
    # fail -> edit -> fail again -> pass: the second failure resets the edited
    # flag, so this conservatively counts no cycle.
    events = [
        _flat_event(1, "Bash", {"command": "uv run pytest"}, True),
        _flat_event(2, "Edit", {"file_path": "a.py"}, False),
        _flat_event(3, "Bash", {"command": "uv run pytest"}, True),
        _flat_event(4, "Bash", {"command": "uv run pytest"}, False),
    ]
    assert detect_tdd_loop(events) == []


def test_tdd_loop_refail_then_edit_counts_one_cycle() -> None:
    events = [
        _flat_event(1, "Bash", {"command": "uv run pytest"}, True),
        _flat_event(2, "Edit", {"file_path": "a.py"}, False),
        _flat_event(3, "Bash", {"command": "uv run pytest"}, True),
        _flat_event(4, "Edit", {"file_path": "a.py"}, False),
        _flat_event(5, "Bash", {"command": "uv run pytest"}, False),
    ]
    findings = detect_tdd_loop(events)
    assert len(findings) == 1
    assert findings[0].count == 1
    assert findings[0].exemplar_event_ids == (3,)  # the failure that got fixed


# ---------------------------------------------------------------------------
# Detectors: delegation, plan-before-burst
# ---------------------------------------------------------------------------

def test_delegation_counts_dispatches() -> None:
    events = [
        _flat_event(1, "Task", {"prompt": "explore the codebase"}, False),
        _flat_event(2, "Read", {"file_path": "a.py"}, False),
        _flat_event(3, "Agent", {"prompt": "review the diff"}, False),
    ]
    findings = detect_delegation(events)
    assert len(findings) == 1
    finding = findings[0]
    assert (finding.habit_key, finding.phase) == ("delegation", "delegate")
    assert finding.count == 2
    assert finding.cost_usd == pytest.approx(4.0)  # the two dispatch turns
    assert finding.exemplar_event_ids == (1, 3)


def test_delegation_absent_without_dispatches() -> None:
    assert detect_delegation([_flat_event(1, "Read", {"file_path": "a.py"}, False)]) == []


def test_plan_before_burst_flags_planned_edit_run() -> None:
    events = [_flat_event(1, "TodoWrite", {"todos": "..."}, False)]
    events += [_flat_event(i, "Edit", {"file_path": f"f{i}.py"}, False)
               for i in range(2, 8)]  # 6 edits after the plan step
    findings = detect_plan_before_burst(events)
    assert len(findings) == 1
    finding = findings[0]
    assert (finding.habit_key, finding.phase) == ("plan-before-burst", "plan")
    assert finding.count == 6
    # plan turn ($2) + six edit turns ($12)
    assert finding.cost_usd == pytest.approx(14.0)
    assert finding.exemplar_event_ids == (1,)


def test_plan_before_burst_needs_enough_edits() -> None:
    events = [_flat_event(1, "TodoWrite", {"todos": "..."}, False),
              _flat_event(2, "Edit", {"file_path": "a.py"}, False)]
    assert detect_plan_before_burst(events) == []


def test_plan_before_burst_needs_a_plan_step() -> None:
    events = [_flat_event(i, "Edit", {"file_path": f"f{i}.py"}, False)
              for i in range(1, 8)]
    assert detect_plan_before_burst(events) == []


def test_delegation_empty_session() -> None:
    assert detect_delegation([]) == []


def test_plan_before_burst_empty_session() -> None:
    assert detect_plan_before_burst([]) == []


# ---------------------------------------------------------------------------
# Context-economics adapter
# ---------------------------------------------------------------------------

def test_in_window_filters_by_day() -> None:
    assert _in_window("2026-06-03T10:00:00Z", "2026-06-01", "2026-06-05") is True
    assert _in_window("2026-05-30T10:00:00Z", "2026-06-01", None) is False
    assert _in_window("2026-06-09T10:00:00Z", None, "2026-06-05") is False
    assert _in_window(None, None, None) is True
    assert _in_window(None, "2026-06-01", None) is False  # undated: excluded by a window
    assert _in_window("2026-06-01T00:00:00Z", "2026-06-01", "2026-06-01") is True
    assert _in_window("2026-06-05T23:59:00Z", "2026-06-01", "2026-06-05") is True


def _seed_reread_session(conn: sqlite3.Connection) -> None:
    """Three growing assistant calls; gaps 1 and 2 each carry a Read result for
    the SAME file with no intervening edit -> one re-reads finding. Context
    growth is large so the carry cost clears the $0.01 findings floor."""
    _seed_base(conn)
    for i, (event_id, base) in enumerate([(1, 200_000), (3, 400_000), (5, 600_000)]):
        _add_assistant_event(
            conn, event_id, 1, f"2026-06-01T10:0{i * 2}:00Z",
            [("Read", {"file_path": "big.py"}, False)] if event_id != 5 else [],
            base=base,
            out=1_000,  # small output: context growth comes from the base escalation, not output
        )
    for event_id, ts, tool_use in [(2, "2026-06-01T10:01:00Z", "tu-1-0"),
                                   (4, "2026-06-01T10:03:00Z", "tu-3-0")]:
        conn.execute(
            "INSERT INTO events (id, session_id, source_path, line_no, uuid, type, timestamp, raw_json) "
            "VALUES (?, 1, 'x.jsonl', 1, ?, 'user', ?, ?)",
            (event_id, f"uuid-{event_id}", ts, json.dumps({"big": "x" * 400_000})),
        )
        conn.execute(
            "UPDATE tool_results SET event_id = ? WHERE tool_use_id = ?",
            (event_id, tool_use),
        )
    conn.commit()


def test_detect_context_habits_maps_rereads() -> None:
    conn = _conn()
    _seed_reread_session(conn)
    findings = detect_context_habits(conn, PRICE_TABLE)
    rereads = [f for f in findings if f.habit_key == "re-reads"]
    assert len(rereads) == 1
    assert rereads[0].phase == "explore"
    assert rereads[0].cost_usd > 0
    assert rereads[0].session_db_id == 1


def test_detect_context_habits_respects_window() -> None:
    conn = _conn()
    _seed_reread_session(conn)
    assert detect_context_habits(conn, PRICE_TABLE, date_from="2026-06-02") == []


def test_detect_context_habits_respects_project_filter() -> None:
    conn = _conn()
    _seed_reread_session(conn)  # finding lives in project 1
    assert detect_context_habits(conn, PRICE_TABLE, project_id=2) == []


# ---------------------------------------------------------------------------
# Registry + runner + leaf aggregation
# ---------------------------------------------------------------------------

def test_registry_covers_the_v1_catalog() -> None:
    assert set(HABIT_BY_KEY) == {
        "tdd-loop", "delegation", "plan-before-burst",
        "blind-retry", "re-reads", "oversized-context", "late-compaction",
    }
    for spec in HABIT_BY_KEY.values():
        assert spec["polarity"] in ("good", "anti")
        assert spec["rule"]  # every leaf can show why it exists


def test_run_habit_detectors_finds_session_habits() -> None:
    conn = _conn()
    _seed_base(conn)
    _add_assistant_event(conn, 1, 1, "2026-06-01T10:00:00Z",
                         [("Task", {"prompt": "go"}, False)])
    events = load_events(conn, PRICE_TABLE)
    findings = run_habit_detectors(conn, PRICE_TABLE, events)
    assert any(f.habit_key == "delegation" for f in findings)


def test_run_habit_detectors_survives_a_broken_detector(monkeypatch) -> None:
    def boom(_events):
        raise RuntimeError("broken detector")
    monkeypatch.setattr(usage_map, "SESSION_DETECTORS",
                        [boom, usage_map.detect_delegation])
    conn = _conn()
    _seed_base(conn)
    _add_assistant_event(conn, 1, 1, "2026-06-01T10:00:00Z",
                         [("Task", {"prompt": "go"}, False)])
    events = load_events(conn, PRICE_TABLE)
    findings = run_habit_detectors(conn, PRICE_TABLE, events)  # must not raise
    assert any(f.habit_key == "delegation" for f in findings)


def test_aggregate_habits_groups_by_key_and_phase() -> None:
    def finding(session: int, key: str = "blind-retry", phase: str = "operate",
                cost: float = 1.0) -> HabitFinding:
        return HabitFinding(habit_key=key, phase=phase, session_db_id=session,
                            session_title="S", project_name="alpha",
                            cost_usd=cost, count=2, exemplar_event_ids=(1,),
                            detail="d")
    leaves = aggregate_habits([
        finding(1), finding(2),
        finding(1, phase="explore"),       # same habit, different home phase
        finding(3, key="tdd-loop", phase="verify"),
    ])
    by_id = {(leaf["key"], leaf["phase"]): leaf for leaf in leaves}
    assert by_id[("blind-retry", "operate")]["cost_usd"] == pytest.approx(2.0)
    assert by_id[("blind-retry", "operate")]["session_count"] == 2
    assert by_id[("blind-retry", "operate")]["count"] == 4
    assert by_id[("blind-retry", "operate")]["polarity"] == "anti"
    assert by_id[("blind-retry", "explore")]["cost_usd"] == pytest.approx(1.0)
    assert by_id[("tdd-loop", "verify")]["polarity"] == "good"
    assert all(leaf["status"] == "confirmed" for leaf in leaves)


def test_aggregate_habits_skips_unknown_keys() -> None:
    rogue = HabitFinding(habit_key="not-registered", phase="plan",
                         session_db_id=1, session_title="S", project_name="a",
                         cost_usd=1.0, count=1, exemplar_event_ids=(), detail="d")
    assert aggregate_habits([rogue]) == []
