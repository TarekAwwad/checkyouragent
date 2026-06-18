"""Privacy-preserving usage-contribution bundle.

Pure functions over a sqlite3.Connection. Builds a bundle field-by-field from an
explicit allowlist of structural columns — never SELECT *, never raw_json/previews.
Every symbolic value is re-derived into a closed enum with unknowns bucketed, so no
user-authored free text (MCP server names, model aliases, custom agent names) leaks.
"""
from __future__ import annotations

import hashlib
import sqlite3
from dataclasses import dataclass, field
from datetime import date, datetime

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
    # Longest (most specific) id first so a family that is a prefix of another
    # can't shadow it under frozenset's nondeterministic iteration order.
    for known in sorted(KNOWN_MODELS, key=len, reverse=True):
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


def _sid(salt: str, project_id: int, session_id: str) -> str:
    return hashlib.sha256(f"{salt}|{project_id}|{session_id}".encode()).hexdigest()


def _date_only(ts: str | None) -> str | None:
    if not ts:
        return None
    return ts.split("T", 1)[0]


def _parse_ts(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None


def _duration_s(first_ts: str | None, last_ts: str | None) -> int:
    start, end = _parse_ts(first_ts), _parse_ts(last_ts)
    if start is None or end is None:
        return 0
    return max(0, int((end - start).total_seconds()))


@dataclass
class ContributionBundle:
    contributor_id: str
    generated_at: str
    app_version: str
    sessions: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "schema_version": SCHEMA_VERSION,
            "contributor_id": self.contributor_id,
            "generated_at": self.generated_at,
            "app_version": self.app_version,
            "sessions": self.sessions,
        }


def build_contribution(
    conn: sqlite3.Connection,
    *,
    salt: str,
    contributor_id: str,
    app_version: str,
    generated_on: date,
) -> ContributionBundle:
    sessions: list[dict] = []
    session_rows = conn.execute(
        """
        SELECT s.id, s.project_id, s.session_id, s.first_ts, s.last_ts
        FROM sessions s
        ORDER BY s.id
        """
    ).fetchall()

    for s in session_rows:
        session_pk = int(s["id"])
        sessions.append({
            "sid": _sid(salt, int(s["project_id"]), str(s["session_id"])),
            "models": _session_models(conn, session_pk),
            "first_date": _date_only(s["first_ts"]),
            "duration_s": _duration_s(s["first_ts"], s["last_ts"]),
            "tokens": _session_tokens(conn, session_pk),
            "stats": _session_stats(conn, session_pk),
            "risk_categories": _session_risk_categories(conn, session_pk),
            "subagents": _session_subagents(conn, session_pk),
            "sequence": [],  # populated in Task 4
        })

    return ContributionBundle(
        contributor_id=contributor_id,
        generated_at=generated_on.isoformat(),
        app_version=app_version,
        sessions=sessions,
    )


def _session_models(conn: sqlite3.Connection, session_pk: int) -> list[str]:
    rows = conn.execute(
        """
        SELECT DISTINCT m.model
        FROM messages m JOIN events e ON e.id = m.event_id
        WHERE e.session_id = ? AND m.model IS NOT NULL
        """,
        (session_pk,),
    ).fetchall()
    return sorted({bucket_model(r["model"]) for r in rows})


def _session_tokens(conn: sqlite3.Connection, session_pk: int) -> dict:
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
        WHERE e.session_id = ?
        """,
        (session_pk,),
    ).fetchone()
    return {k: int(row[k]) for k in ("input", "output", "base", "cache_5m", "cache_1h", "cache_read")}


def _session_stats(conn: sqlite3.Connection, session_pk: int) -> dict:
    row = conn.execute(
        """
        SELECT turn_count, tool_call_count, subagent_count, error_count,
               system_count, loop_count, max_repeat, persisted_output_count
        FROM session_stats WHERE session_id = ?
        """,
        (session_pk,),
    ).fetchone()
    if row is None:
        return {k: 0 for k in (
            "turns", "tool_calls", "subagents", "errors",
            "system", "loops", "max_repeat", "persisted_outputs",
        )}
    return {
        "turns": int(row["turn_count"]),
        "tool_calls": int(row["tool_call_count"]),
        "subagents": int(row["subagent_count"]),
        "errors": int(row["error_count"]),
        "system": int(row["system_count"]),
        "loops": int(row["loop_count"]),
        "max_repeat": int(row["max_repeat"]),
        "persisted_outputs": int(row["persisted_output_count"]),
    }


def _session_risk_categories(conn: sqlite3.Connection, session_pk: int) -> list[str]:
    rows = conn.execute(
        "SELECT DISTINCT category FROM risk_findings WHERE session_id = ? ORDER BY category",
        (session_pk,),
    ).fetchall()
    return [str(r["category"]) for r in rows]


def _session_subagents(conn: sqlite3.Connection, session_pk: int) -> list[dict]:
    rows = conn.execute(
        """
        SELECT agent_type, event_count
        FROM subagents WHERE parent_session_id = ?
        ORDER BY id
        """,
        (session_pk,),
    ).fetchall()
    return [
        {"agent_type": bucket_agent_type(r["agent_type"]), "event_count": int(r["event_count"])}
        for r in rows
    ]
