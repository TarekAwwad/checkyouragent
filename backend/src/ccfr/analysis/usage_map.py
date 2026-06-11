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
# boundaries so "pytest" never matches inside an unrelated word.
_VERIFY_COMMAND = re.compile(
    r"(?:^|[\s;&|(])("
    r"pytest|vitest|jest|mocha|tsc|eslint|ruff|mypy|flake8"
    r"|cargo\s+(?:test|check|clippy)|go\s+(?:test|vet)"
    r"|npm\s+(?:test|run\s+(?:test|lint|build|check)\S*)"
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
