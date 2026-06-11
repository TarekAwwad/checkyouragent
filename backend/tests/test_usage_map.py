from __future__ import annotations

import json
import sqlite3

import pytest
from fastapi.testclient import TestClient

from ccfr.analysis.pricing import ModelPrice
from ccfr.analysis.usage_map import (
    EventRec,
    ToolCallRec,
    aggregate_phases,
    classify_tool_call,
    event_phase_weights,
    load_events,
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
