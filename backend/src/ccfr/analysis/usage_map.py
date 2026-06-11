"""Usage Mindmap: corpus-wide workflow-phase and habit aggregation.

Classifies every assistant event into workflow phases via deterministic tool
rules, attributes real message cost to those phases (every dollar in the
filtered corpus lands in exactly one phase, so the map always sums to the true
total), and runs a registry of habit detectors whose findings hang off the
phases as good/anti leaves.

Computation is on-demand from the rebuildable SQLite cache, like discovery.py.
Design doc: docs/superpowers/specs/2026-06-11-usage-mindmap-design.md
"""

from __future__ import annotations

import json
import logging
import re
import sqlite3
from collections import defaultdict
from dataclasses import dataclass
from typing import Any, Callable

from ccfr.analysis.context_economics import accrue_tax, load_threads, run_detectors
from ccfr.analysis.pricing import (
    ModelPrice,
    TokenBreakdown,
    cost_usd,
    load_price_table,
    match_price,
)
from ccfr.config import pricing_path
from ccfr.naming import project_display_name

logger = logging.getLogger(__name__)

# --- Phase taxonomy ----------------------------------------------------------

PHASES: list[dict[str, str]] = [
    {"key": "explore", "label": "Explore"},
    {"key": "plan", "label": "Plan"},
    {"key": "implement", "label": "Implement"},
    {"key": "verify", "label": "Verify"},
    {"key": "operate", "label": "Operate"},
    {"key": "delegate", "label": "Delegate"},
    {"key": "converse", "label": "Converse"},
]
PHASE_KEYS = [p["key"] for p in PHASES]

_TOOL_PHASE: dict[str, str] = {
    "Read": "explore", "Grep": "explore", "Glob": "explore", "LS": "explore",
    "WebFetch": "explore", "WebSearch": "explore", "NotebookRead": "explore",
    "TodoWrite": "plan", "EnterPlanMode": "plan", "ExitPlanMode": "plan",
    "AskUserQuestion": "plan",
    "Edit": "implement", "Write": "implement", "MultiEdit": "implement",
    "NotebookEdit": "implement",
    "Task": "delegate", "Agent": "delegate",
}

# Test/build/lint commands that mark a Bash call as Verify. Anchored to token
# boundaries so "pytest" never matches inside an unrelated word; a leading
# "/" or "." also counts as a boundary so path-prefixed runners ("./pytest",
# "/usr/bin/pytest") are recognized. npm script names only count when the
# known prefix is the whole name or is followed by -, :, or . ("test:unit",
# "lint-fix", "build.prod") so "buildstories"/"linting" stay Operate.
_VERIFY_COMMAND = re.compile(
    r"(?:^|[\s;&|(./])("
    r"pytest|vitest|jest|mocha|tsc|eslint|ruff|mypy|flake8"
    r"|cargo\s+(?:test|check|clippy)|go\s+(?:test|vet)"
    r"|npm\s+(?:test|run\s+(?:test|lint|build|check)(?:[-:.]\S*)?)"
    r"|npx\s+(?:vitest|jest|tsc|eslint)"
    r"|make\s+(?:test|check|lint)|tox|gradle\s+test|mvn\s+test"
    r")(?:$|[\s;&|)])"
)


def classify_tool_call(tool_name: str | None, command: str | None = None) -> str:
    """Phase for one tool call. Unknown tools are Converse — never dropped, so
    phase totals always cover the whole corpus."""
    if not tool_name:
        return "converse"
    if tool_name == "Bash":
        return "verify" if command and _VERIFY_COMMAND.search(command) else "operate"
    return _TOOL_PHASE.get(tool_name, "converse")


# --- Event records and cost attribution --------------------------------------

@dataclass(frozen=True)
class ToolCallRec:
    tool_name: str | None
    command: str | None = None    # Bash command text when present
    detail: str | None = None     # file_path for file tools when present
    signature: str | None = None  # stable identity of the call's input
    is_error: bool = False


@dataclass(frozen=True)
class EventRec:
    event_id: int
    session_db_id: int
    session_title: str
    project_name: str
    ts: str | None
    model: str
    cost: float            # USD for this message; 0.0 when the model is unpriced
    tokens: int            # total billed tokens on the message
    priced: bool
    tool_calls: tuple[ToolCallRec, ...] = ()


def event_phase_weights(event: EventRec) -> dict[str, float]:
    """Equal split of an event across its tool calls' phases; text-only events
    are Converse. Weights always sum to 1.0 so attribution conserves cost."""
    if not event.tool_calls:
        return {"converse": 1.0}
    weights: dict[str, float] = defaultdict(float)
    share = 1.0 / len(event.tool_calls)
    for call in event.tool_calls:
        weights[classify_tool_call(call.tool_name, call.command)] += share
    return dict(weights)


def aggregate_phases(events: list[EventRec]) -> dict[str, dict[str, Any]]:
    """Per-phase accumulation of cost, tokens, tool counts and sessions."""
    acc: dict[str, dict[str, Any]] = {
        key: {"cost_usd": 0.0, "tokens": 0.0, "tool_count": 0, "sessions": set()}
        for key in PHASE_KEYS
    }
    for event in events:
        for phase, weight in event_phase_weights(event).items():
            bucket = acc[phase]
            bucket["cost_usd"] += event.cost * weight
            bucket["tokens"] += event.tokens * weight
            bucket["sessions"].add(event.session_db_id)
        for call in event.tool_calls:
            acc[classify_tool_call(call.tool_name, call.command)]["tool_count"] += 1
    return acc
