"""Shared privacy helpers for building and importing Team bundles.

Every free-form model, agent, stop-reason, and legacy sequence value is folded
into a closed vocabulary before it can enter the Team bundle cache.
"""
from __future__ import annotations

import sqlite3
from datetime import datetime

from ccfr.analysis.pricing import PUBLIC_MODEL_KEYS


KNOWN_MODELS = PUBLIC_MODEL_KEYS


KNOWN_AGENT_TYPES = frozenset(
    {
        "general-purpose",
        "claude",
        "claude-code-guide",
        "code-simplifier",
        "Explore",
        "Plan",
        "statusline-setup",
        "output-style-setup",
    }
)

INSPECT_TOOLS = frozenset({"Read", "Grep", "Glob"})
WRITE_TOOLS = frozenset({"Edit", "Write", "MultiEdit", "NotebookEdit"})
SHELL_TOOLS = frozenset({"Bash", "PowerShell"})
PASSTHROUGH_TOOLS = frozenset(
    {
        "WebFetch",
        "WebSearch",
        "TodoWrite",
        "Task",
        "Skill",
        "BashOutput",
        "KillShell",
        "ExitPlanMode",
    }
)
COMMAND_FAMILIES = frozenset(
    {
        "empty",
        "test",
        "lint_typecheck",
        "build",
        "git",
        "deps",
        "delete",
        "network",
        "script",
        "search",
        "list",
        "other",
    }
)
ERROR_CLASSES = frozenset(
    {
        "permission_denied",
        "user_rejected",
        "edit_without_read",
        "file_changed",
        "validation",
        "parallel_cancel",
        "timeout",
        "missing_module",
        "missing_command",
        "git",
        "test_failure",
        "exit2",
        "exit1",
        "unknown",
    }
)
KNOWN_STOP_REASONS = frozenset(
    {
        "tool_use",
        "end_turn",
        "max_tokens",
        "stop_sequence",
        "pause_turn",
        "refusal",
        "model_context_window_exceeded",
    }
)


def bucket_model(raw: str | None) -> str:
    if not raw:
        return "unknown"
    for known in sorted(KNOWN_MODELS, key=len, reverse=True):
        if raw == known or raw.startswith(known + "-"):
            return known
    return "other"


def bucket_agent_type(raw: str | None) -> str:
    return raw if raw in KNOWN_AGENT_TYPES else "custom"


def sanitize_symbol(symbol: str, family: str) -> str:
    """Re-bucket legacy v1/v2 sequence symbols without echoing free text."""
    if family == "tool_result":
        if symbol == "RESULT:ok":
            return symbol
        if symbol.startswith("RESULT:error:"):
            error_class = symbol.split(":", 2)[2]
            return symbol if error_class in ERROR_CLASSES else "RESULT:error:other"
        return "RESULT:other"
    if family != "tool_call":
        return ""
    parts = symbol.split(":")
    if len(parts) == 3 and parts[1] in SHELL_TOOLS:
        return symbol if parts[2] in COMMAND_FAMILIES else f"CALL:{parts[1]}:other"
    if len(parts) == 3 and parts[1] == "inspect" and parts[2] in INSPECT_TOOLS:
        return symbol
    if len(parts) == 3 and parts[1] == "write" and parts[2] in WRITE_TOOLS:
        return symbol
    if symbol == "CALL:Agent":
        return symbol
    if len(parts) == 2 and parts[1] in PASSTHROUGH_TOOLS:
        return symbol
    if len(parts) >= 2 and parts[1].startswith("mcp__"):
        return "CALL:mcp"
    return "CALL:other"


def date_only(timestamp: str | None) -> str | None:
    return timestamp.split("T", 1)[0] if timestamp else None


def _parse_timestamp(timestamp: str | None) -> datetime | None:
    if not timestamp:
        return None
    try:
        return datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except ValueError:
        return None


def duration_s(first_timestamp: str | None, last_timestamp: str | None) -> int:
    start = _parse_timestamp(first_timestamp)
    end = _parse_timestamp(last_timestamp)
    if start is None or end is None:
        return 0
    return max(0, int((end - start).total_seconds()))


def session_models(conn: sqlite3.Connection, session_id: int) -> list[str]:
    rows = conn.execute(
        """
        SELECT DISTINCT m.model
        FROM messages m JOIN events e ON e.id = m.event_id
        WHERE e.session_id = ? AND e.is_replay = 0 AND m.model IS NOT NULL
        """,
        (session_id,),
    ).fetchall()
    return sorted({bucket_model(row["model"]) for row in rows})


def session_tokens(conn: sqlite3.Connection, session_id: int) -> dict[str, int]:
    row = conn.execute(
        """
        SELECT
            COALESCE(SUM(m.input_tokens), 0)       AS input,
            COALESCE(SUM(m.output_tokens), 0)      AS output,
            COALESCE(SUM(m.base_input_tokens), 0)  AS base,
            COALESCE(SUM(m.cache_5m_tokens), 0)    AS cache_5m,
            COALESCE(SUM(m.cache_1h_tokens), 0)    AS cache_1h,
            COALESCE(SUM(m.cache_read_tokens), 0)  AS cache_read
        FROM messages m JOIN events e ON e.id = m.event_id
        WHERE e.session_id = ? AND e.is_replay = 0
        """,
        (session_id,),
    ).fetchone()
    keys = ("input", "output", "base", "cache_5m", "cache_1h", "cache_read")
    return {key: int(row[key]) for key in keys}


def session_stats(conn: sqlite3.Connection, session_id: int) -> dict[str, int]:
    row = conn.execute(
        """
        SELECT turn_count, tool_call_count, subagent_count, error_count,
               system_count, persisted_output_count
        FROM session_stats WHERE session_id = ?
        """,
        (session_id,),
    ).fetchone()
    keys = ("turns", "tool_calls", "subagents", "errors", "system", "persisted_outputs")
    if row is None:
        return {key: 0 for key in keys}
    return {
        "turns": int(row["turn_count"]),
        "tool_calls": int(row["tool_call_count"]),
        "subagents": int(row["subagent_count"]),
        "errors": int(row["error_count"]),
        "system": int(row["system_count"]),
        "persisted_outputs": int(row["persisted_output_count"]),
    }


def session_stop_reasons(conn: sqlite3.Connection, session_id: int) -> dict[str, int]:
    rows = conn.execute(
        """
        SELECT m.stop_reason AS stop_reason, COUNT(*) AS count
        FROM messages m JOIN events e ON e.id = m.event_id
        WHERE e.session_id = ? AND e.is_replay = 0
          AND m.stop_reason IS NOT NULL AND m.stop_reason != ''
        GROUP BY m.stop_reason
        """,
        (session_id,),
    ).fetchall()
    counts: dict[str, int] = {}
    for row in rows:
        raw_reason = str(row["stop_reason"])
        reason = raw_reason if raw_reason in KNOWN_STOP_REASONS else "other"
        counts[reason] = counts.get(reason, 0) + int(row["count"])
    return counts


def session_subagents(conn: sqlite3.Connection, session_id: int) -> list[dict[str, int | str]]:
    rows = conn.execute(
        """
        SELECT agent_type, event_count
        FROM subagents WHERE parent_session_id = ?
        ORDER BY id
        """,
        (session_id,),
    ).fetchall()
    return [
        {
            "agent_type": bucket_agent_type(row["agent_type"]),
            "event_count": int(row["event_count"]),
        }
        for row in rows
    ]
