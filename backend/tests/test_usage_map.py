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
])
def test_classify_bash_verify_commands(command: str) -> None:
    assert classify_tool_call("Bash", command) == "verify"


@pytest.mark.parametrize("command", [
    "git status",
    "ls -la",
    "mkdir build",
    "python script.py",       # plain run, not a test runner
    "echo pytestish",         # word boundary: not a verify command
])
def test_classify_bash_other_commands_are_operate(command: str) -> None:
    assert classify_tool_call("Bash", command) == "operate"


def test_classify_unknown_and_missing_tools_are_converse() -> None:
    assert classify_tool_call("mcp__some__tool") == "converse"
    assert classify_tool_call(None) == "converse"
    assert classify_tool_call("") == "converse"
