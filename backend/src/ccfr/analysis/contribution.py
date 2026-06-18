"""Privacy-preserving usage-contribution bundle.

Pure functions over a sqlite3.Connection. Builds a bundle field-by-field from an
explicit allowlist of structural columns — never SELECT *, never raw_json/previews.
Every symbolic value is re-derived into a closed enum with unknowns bucketed, so no
user-authored free text (MCP server names, model aliases, custom agent names) leaks.
"""
from __future__ import annotations

from ccfr.analysis.risk_patterns import _command_family, _error_class

SCHEMA_VERSION = 1

# Closed model vocabulary. Extend as public model ids are added; a dated suffix
# (e.g. "-20251001") folds to its family id. Anything else -> "other".
KNOWN_MODELS = frozenset({
    "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-1",
    "claude-sonnet-4-6", "claude-sonnet-4-5", "claude-haiku-4-5",
    "claude-fable-5",
    "claude-3-5-sonnet", "claude-3-5-haiku", "claude-3-opus",
})

# Built-in subagent types. Anything else (user-defined agents) -> "custom".
KNOWN_AGENT_TYPES = frozenset({
    "general-purpose", "claude", "claude-code-guide", "code-simplifier",
    "Explore", "Plan", "statusline-setup", "output-style-setup",
})

INSPECT_TOOLS = frozenset({"Read", "Grep", "Glob"})
WRITE_TOOLS = frozenset({"Edit", "Write", "MultiEdit", "NotebookEdit"})
SHELL_TOOLS = frozenset({"Bash", "PowerShell"})
PASSTHROUGH_TOOLS = frozenset({
    "WebFetch", "WebSearch", "TodoWrite", "Task", "Skill",
    "BashOutput", "KillShell", "ExitPlanMode",
})


def bucket_model(raw: str | None) -> str:
    if not raw:
        return "unknown"
    for known in KNOWN_MODELS:
        if raw == known or raw.startswith(known + "-"):
            return known
    return "other"


def bucket_agent_type(raw: str | None) -> str:
    return raw if raw in KNOWN_AGENT_TYPES else "custom"


def call_symbol(tool_name: str | None, command: str | None) -> str:
    name = tool_name or "unknown"
    if name in SHELL_TOOLS:
        return f"CALL:{name}:{_command_family(command or '')}"
    if name in INSPECT_TOOLS:
        return f"CALL:inspect:{name}"
    if name in WRITE_TOOLS:
        return f"CALL:write:{name}"
    if name == "Agent":
        return "CALL:Agent"
    if name in PASSTHROUGH_TOOLS:
        return f"CALL:{name}"
    if name.startswith("mcp__"):
        return "CALL:mcp"
    return "CALL:other"


def result_symbol(is_error: bool, output: str | None) -> str:
    if not is_error:
        return "RESULT:ok"
    return f"RESULT:error:{_error_class(output or '')}"
