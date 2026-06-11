from __future__ import annotations

import json
import sqlite3

import pytest
from fastapi.testclient import TestClient

from ccfr.analysis.usage_map import classify_tool_call


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


from ccfr.analysis.usage_map import (
    EventRec,
    ToolCallRec,
    aggregate_phases,
    event_phase_weights,
)


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
