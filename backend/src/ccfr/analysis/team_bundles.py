"""Team-strict privacy bundle export/import and dashboard aggregation.

The bundle is built from an explicit structural allowlist and uses shared
bundle sanitizers for model/tool/subagent buckets. Imports are
canonicalized before persistence so the team tables never need raw Claude
export content, previews, paths, commands, prompts, model aliases, or MCP names.
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

from ccfr.analysis.bundle_sanitization import (
    KNOWN_STOP_REASONS,
    bucket_agent_type,
    bucket_model,
    date_only,
    duration_s,
    sanitize_symbol,
    session_models,
    session_stats,
    session_stop_reasons,
    session_subagents,
    session_tokens,
)
from ccfr.naming import project_display_name

SCHEMA_VERSION = 3
PREVIOUS_SCHEMA_VERSION = 2
LEGACY_SCHEMA_VERSION = 1
PROFILE = "team_strict"  # legacy v1 wire profile == the structural level
DEFAULT_PROVIDER = "claude"

LEVEL_STRUCTURAL = "structural"
LEVEL_TEAM = "team"
BUILD_LEVELS = (LEVEL_STRUCTURAL, LEVEL_TEAM)
# Ladder rungs reserved for raw-session sharing (separate sub-project).
RESERVED_LEVELS = ("sessions", "raw")

_EXT_RE = re.compile(r"^[a-z0-9_+-]{1,12}\Z")
_MAX_TOOLS_PER_SESSION = 300
_MAX_FILE_TYPES_PER_SESSION = 100
MAX_SESSIONS_PER_BUNDLE = 50_000
MAX_GENERATED_SEQ = (1 << 63) - 1
MAX_COUNTER_VALUE = (1 << 63) - 1


def privacy_level_of(profile: str | None) -> str:
    """Level for a stored profile string ("team_strict" is legacy structural)."""
    return LEVEL_TEAM if profile == LEVEL_TEAM else LEVEL_STRUCTURAL


TOKEN_KEYS = ("input", "output", "base", "cache_5m", "cache_1h", "cache_read")
STAT_KEYS = (
    "turns",
    "tool_calls",
    "subagents",
    "errors",
    "system",
    "persisted_outputs",
)
LEGACY_STAT_KEYS = (*STAT_KEYS, "loops", "max_repeat")
DASHBOARD_STAT_KEYS = STAT_KEYS
SESSION_KEYS = {
    "pid",
    "sid",
    "provider",
    "models",
    "first_date",
    "last_date",
    "duration_s",
    "tokens",
    "tokens_by_model",
    "stats",
    "stop_reasons",
    "subagents",
}
LEGACY_SESSION_KEYS = SESSION_KEYS | {"risk_categories", "sequence"}
TOP_LEVEL_KEYS = {
    "schema_version",
    "profile",
    "bundle_id",
    "member_id",
    "generated_at",
    "generated_seq",
    "app_version",
    "sessions",
}
SESSION_KEYS_TEAM = (SESSION_KEYS - {"pid"}) | {"project_name", "tools", "file_types"}
LEGACY_SESSION_KEYS_TEAM = (LEGACY_SESSION_KEYS - {"pid"}) | {
    "project_name",
    "tools",
    "file_types",
}
TOP_LEVEL_KEYS_MODERN = {
    "schema_version",
    "privacy_level",
    "bundle_id",
    "member_id",
    "member_name",
    "generated_at",
    "generated_seq",
    "app_version",
    "sessions",
}
RISK_CATEGORIES = frozenset(
    {
        "cost_context_blowup",
        "environment_mismatch",
        "failed_verification_repair_loop",
        "fanout_overload",
        "permission_friction",
        "rare_workflow_deviation",
        "subagent_failure_propagation",
        "unsafe_write_attempt",
    }
)


@dataclass
class TeamBundle:
    member_id: str
    generated_at: str
    app_version: str
    sessions: list[dict[str, Any]] = field(default_factory=list)
    # Per-member monotonic export counter (defaults to 0 for legacy bundles).
    # Not part of bundle_content_id's key tuple: two identical-content same-day
    # bundles legitimately share a content id (the duplicate check handles them).
    generated_seq: int = 0
    privacy_level: str = LEVEL_STRUCTURAL
    member_name: str | None = None
    bundle_id: str | None = None

    def base_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "schema_version": SCHEMA_VERSION,
            "privacy_level": self.privacy_level,
            "member_id": self.member_id,
            "generated_at": self.generated_at,
            "generated_seq": self.generated_seq,
            "app_version": self.app_version,
            "sessions": self.sessions,
        }
        if self.privacy_level == LEVEL_TEAM:
            data["member_name"] = self.member_name
        return data

    def to_dict(self) -> dict[str, Any]:
        data = self.base_dict()
        data["bundle_id"] = self.bundle_id or bundle_content_id_v3(data)
        return data


@dataclass(frozen=True)
class TeamImportResult:
    bundle_id: str
    member_id: str
    session_count: int
    imported: bool
    status: str  # "imported" | "replaced" | "duplicate" | "stale"


def _hash_id(salt: str, namespace: str, *parts: object) -> str:
    body = "\0".join([PROFILE, namespace, *[str(part) for part in parts]])
    return hashlib.sha256(f"{salt}\0{body}".encode()).hexdigest()


def bundle_content_id(bundle: dict[str, Any]) -> str:
    base = {key: bundle[key] for key in (
        "schema_version", "profile", "member_id", "generated_at", "app_version", "sessions",
    )}
    encoded = json.dumps(base, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def bundle_content_id_v2(bundle: dict[str, Any]) -> str:
    base = {key: bundle[key] for key in (
        "schema_version", "privacy_level", "member_id", "generated_at", "app_version", "sessions",
    )}
    if bundle.get("privacy_level") == LEVEL_TEAM:
        base["member_name"] = bundle.get("member_name")
    encoded = json.dumps(base, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def bundle_content_id_v3(bundle: dict[str, Any]) -> str:
    """Hash a v3 bundle; the modern envelope matches v2 but the session allowlist does not."""
    return bundle_content_id_v2(bundle)


def normalize_project_key(name: str) -> str:
    """Cross-member grouping key: casefold, collapse non-alphanumeric runs to '-'."""
    folded = "".join(ch if ch.isalnum() else "-" for ch in name.casefold())
    key = re.sub("-+", "-", folded).strip("-")
    if not key:
        raise ValueError(f"project name has no usable characters: {name!r}")
    return key


def _fold_tokens_by_model(pairs: Any) -> dict[str, dict[str, int]]:
    """Merge (family, token-map) pairs into per-family totals, dropping empties."""
    out: dict[str, dict[str, int]] = {}
    for family, tokens in pairs:
        bucket = out.setdefault(family, {key: 0 for key in TOKEN_KEYS})
        for key in TOKEN_KEYS:
            bucket[key] += tokens[key]
    return {family: vals for family, vals in out.items() if any(vals.values())}


def _session_tokens_by_model(conn: sqlite3.Connection, session_pk: int) -> dict[str, dict[str, int]]:
    rows = conn.execute(
        """
        SELECT m.model AS model,
               COALESCE(SUM(m.input_tokens), 0)      AS input,
               COALESCE(SUM(m.output_tokens), 0)     AS output,
               COALESCE(SUM(m.base_input_tokens), 0) AS base,
               COALESCE(SUM(m.cache_5m_tokens), 0)   AS cache_5m,
               COALESCE(SUM(m.cache_1h_tokens), 0)   AS cache_1h,
               COALESCE(SUM(m.cache_read_tokens), 0) AS cache_read
        FROM messages m JOIN events e ON e.id = m.event_id
        WHERE e.session_id = ? AND e.is_replay = 0
        GROUP BY m.model
        """,
        (session_pk,),
    ).fetchall()
    return _fold_tokens_by_model(
        (bucket_model(row["model"]), {key: int(row[key]) for key in TOKEN_KEYS}) for row in rows
    )


def _session_tools(conn: sqlite3.Connection, session_pk: int) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT tool_name, COUNT(*) AS calls
        FROM tool_calls
        WHERE session_id = ? AND tool_name IS NOT NULL AND TRIM(tool_name) != ''
        GROUP BY tool_name
        ORDER BY tool_name
        """,
        (session_pk,),
    ).fetchall()
    return [{"name": str(row["tool_name"])[:120], "calls": int(row["calls"])} for row in rows]


def _session_file_types(conn: sqlite3.Connection, session_pk: int) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT file_ext, COUNT(*) AS count
        FROM tool_calls
        WHERE session_id = ? AND file_ext IS NOT NULL
        GROUP BY file_ext
        ORDER BY file_ext
        """,
        (session_pk,),
    ).fetchall()
    return [{"ext": str(row["file_ext"]), "count": int(row["count"])} for row in rows]


def _session_subagents_raw(conn: sqlite3.Connection, session_pk: int) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT agent_type, event_count FROM subagents WHERE parent_session_id = ? ORDER BY id",
        (session_pk,),
    ).fetchall()
    return [
        {
            "agent_type": (str(row["agent_type"]).strip()[:80] or "custom") if row["agent_type"] else "custom",
            "event_count": int(row["event_count"]),
        }
        for row in rows
    ]


def build_team_bundle(
    conn: sqlite3.Connection,
    *,
    salt: str,
    member_id: str,
    app_version: str,
    generated_on: date,
    generated_seq: int = 0,
    privacy_level: str = LEVEL_STRUCTURAL,
    member_name: str | None = None,
    projects: list[dict[str, Any]] | None = None,
) -> TeamBundle:
    if privacy_level not in BUILD_LEVELS:
        raise ValueError(f"unsupported privacy_level: {privacy_level}")
    if privacy_level == LEVEL_TEAM and not (member_name or "").strip():
        raise ValueError("member_name is required at the team level")
    if privacy_level == LEVEL_STRUCTURAL and member_name:
        raise ValueError("member_name is not allowed at the structural level")

    label_overrides: dict[str, str] = {}
    selected: list[str] | None = None
    if projects is not None:
        selected = []
        for item in projects:
            export_name = str(item["export_name"])
            selected.append(export_name)
            label = str(item.get("label") or "").strip()
            if label:
                label_overrides[export_name] = label
        if not selected:
            raise ValueError("projects selection must not be empty")
        known = {str(row["export_name"]) for row in conn.execute("SELECT export_name FROM projects")}
        unknown_projects = sorted(name for name in selected if name not in known)
        if unknown_projects:
            raise ValueError(f"unknown project: {unknown_projects[0]}")

    where = ""
    params: list[Any] = []
    if selected is not None:
        placeholders = ",".join("?" * len(selected))
        where = f"WHERE p.export_name IN ({placeholders})"
        params = selected
    session_rows = conn.execute(
        f"""
        SELECT s.id, s.session_id, s.first_ts, s.last_ts, p.export_name, p.inferred_cwd
        FROM sessions s
        JOIN projects p ON p.id = s.project_id
        {where}
        ORDER BY p.id, s.id
        """,
        params,
    ).fetchall()

    sessions: list[dict[str, Any]] = []
    for row in session_rows:
        session_pk = int(row["id"])
        export_name = str(row["export_name"])
        observed_stats = session_stats(conn, session_pk)
        session: dict[str, Any] = {
            "sid": _hash_id(salt, "session", export_name, row["session_id"]),
            "provider": DEFAULT_PROVIDER,
            "models": session_models(conn, session_pk),
            "first_date": date_only(row["first_ts"]),
            "last_date": date_only(row["last_ts"]),
            "duration_s": duration_s(row["first_ts"], row["last_ts"]),
            "tokens": session_tokens(conn, session_pk),
            "tokens_by_model": _session_tokens_by_model(conn, session_pk),
            "stats": {key: observed_stats.get(key, 0) for key in STAT_KEYS},
            "stop_reasons": session_stop_reasons(conn, session_pk),
        }
        if privacy_level == LEVEL_TEAM:
            default_label = project_display_name(export_name, row["inferred_cwd"])
            session["project_name"] = label_overrides.get(export_name, default_label)
            session["subagents"] = _session_subagents_raw(conn, session_pk)
            session["tools"] = _session_tools(conn, session_pk)
            session["file_types"] = _session_file_types(conn, session_pk)
        else:
            session["pid"] = _hash_id(salt, "project", export_name)
            session["subagents"] = session_subagents(conn, session_pk)
        sessions.append(session)

    raw_bundle = TeamBundle(
        member_id=member_id,
        generated_at=generated_on.isoformat(),
        app_version=app_version,
        sessions=sessions,
        generated_seq=generated_seq,
        privacy_level=privacy_level,
        member_name=(member_name or "").strip() or None,
    )
    canonical = validate_team_bundle(raw_bundle.base_dict())
    return TeamBundle(
        member_id=canonical["member_id"],
        generated_at=canonical["generated_at"],
        app_version=canonical["app_version"],
        sessions=canonical["sessions"],
        generated_seq=canonical["generated_seq"],
        privacy_level=canonical["privacy_level"],
        member_name=canonical["member_name"],
        bundle_id=canonical["bundle_id"],
    )


def team_bundle_manifest(bundle: TeamBundle) -> dict[str, Any]:
    sessions = bundle.sessions
    manifest: dict[str, Any] = {
        "privacy_level": bundle.privacy_level,
        "session_count": len(sessions),
    }
    if bundle.privacy_level == LEVEL_TEAM:
        manifest["included_fields"] = [
            "Your member name and the selected projects' names (editable labels)",
            "Real tool, MCP server, and subagent names with call counts",
            "File-type mix (extensions only — never paths or file names)",
            "Provider and bucketed model families",
            "Date-only session timing and duration",
            "Token counts with cache breakdowns, split per model family",
            "Observed session counts and stop reasons",
        ]
        manifest["excluded"] = [
            "Prompts, assistant text, reasoning, titles, and free text",
            "Paths, cwd, branches, file names, shell commands, and tool IO",
            "Risk categories, inferred patterns, loop/max-repeat scores, and event sequences",
            "Raw JSON and previews",
        ]
        manifest["fingerprint_caveat"] = (
            "Team level: your name, project names, tool names, and file types are visible "
            "to everyone who imports this bundle. Conversation content never leaves this machine."
        )
    else:
        manifest["included_fields"] = [
            "Pseudonymous member, project, and session IDs",
            "Provider and bucketed model families",
            "Date-only session timing and duration",
            "Token counts with cache breakdowns, split per model family",
            "Observed session counts and stop reasons",
            "Bucketed subagent types and event counts",
        ]
        manifest["excluded"] = [
            "Raw JSON and previews",
            "Prompts, assistant text, reasoning, titles, and free text",
            "Paths, cwd, branches, file names, shell commands, and tool IO",
            "Raw model aliases, MCP server names, and custom subagent names",
            "Risk categories, inferred patterns, loop/max-repeat scores, and event sequences",
        ]
        manifest["fingerprint_caveat"] = (
            "This bundle contains no content, but exact token counts and date-only timing "
            "can still be distinctive."
        )
    return manifest


def validate_team_bundle(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("team bundle must be a JSON object")
    version = payload.get("schema_version")
    if version == LEGACY_SCHEMA_VERSION:
        return _validate_v1(payload)
    if version == PREVIOUS_SCHEMA_VERSION:
        return _validate_v2(payload)
    if version == SCHEMA_VERSION:
        return _validate_v3(payload)
    raise ValueError("unsupported team bundle schema_version")


def _validate_v1(payload: dict[str, Any]) -> dict[str, Any]:
    unknown = set(payload) - TOP_LEVEL_KEYS
    if unknown:
        raise ValueError(f"unexpected team bundle field: {sorted(unknown)[0]}")
    if payload.get("profile") != PROFILE:
        raise ValueError("unsupported team bundle profile")
    if payload.get("schema_version") != LEGACY_SCHEMA_VERSION:
        raise ValueError("unsupported team bundle schema_version")

    member_id = _required_str(payload.get("member_id"), "member_id")
    generated_at = _date_or_string(payload.get("generated_at"), "generated_at")
    generated_seq = _generated_seq(payload.get("generated_seq"))
    app_version = _required_str(payload.get("app_version"), "app_version")
    raw_sessions = payload.get("sessions")
    if not isinstance(raw_sessions, list):
        raise ValueError("sessions must be a list")
    if len(raw_sessions) > MAX_SESSIONS_PER_BUNDLE:
        raise ValueError(
            f"sessions list is too long (max {MAX_SESSIONS_PER_BUNDLE})"
        )

    raw_base = {
        "schema_version": LEGACY_SCHEMA_VERSION,
        "profile": PROFILE,
        "member_id": member_id,
        "generated_at": generated_at,
        "app_version": app_version,
        "sessions": raw_sessions,
    }
    legacy_export_id = bundle_content_id(raw_base)

    sessions: list[dict[str, Any]] = []
    seen_sids: set[str] = set()
    for index, raw_session in enumerate(raw_sessions):
        session = _validate_session(raw_session, index, LEVEL_STRUCTURAL, legacy=True)
        sid = session["sid"]
        if sid in seen_sids:
            raise ValueError("duplicate session id in team bundle")
        seen_sids.add(sid)
        sessions.append(session)

    legacy_canonical: dict[str, Any] = {
        "schema_version": LEGACY_SCHEMA_VERSION,
        "profile": PROFILE,
        "privacy_level": LEVEL_STRUCTURAL,
        "member_id": member_id,
        "member_name": None,
        "generated_at": generated_at,
        "generated_seq": generated_seq,
        "app_version": app_version,
        "sessions": sessions,
    }
    computed_id = bundle_content_id(legacy_canonical)
    supplied_id = payload.get("bundle_id")
    if supplied_id is not None and str(supplied_id) not in {computed_id, legacy_export_id}:
        raise ValueError("bundle_id does not match bundle content")
    canonical = dict(legacy_canonical)
    canonical["sessions"] = [_strip_deprecated_session(session) for session in sessions]
    canonical["bundle_id"] = computed_id
    return canonical


def _validate_v2(payload: dict[str, Any]) -> dict[str, Any]:
    return _validate_modern(payload, PREVIOUS_SCHEMA_VERSION, legacy=True)


def _validate_v3(payload: dict[str, Any]) -> dict[str, Any]:
    return _validate_modern(payload, SCHEMA_VERSION, legacy=False)


def _validate_modern(
    payload: dict[str, Any], version: int, *, legacy: bool
) -> dict[str, Any]:
    unknown = set(payload) - TOP_LEVEL_KEYS_MODERN
    if unknown:
        raise ValueError(f"unexpected team bundle field: {sorted(unknown)[0]}")
    if payload.get("schema_version") != version:
        raise ValueError("unsupported team bundle schema_version")
    level = payload.get("privacy_level")
    if level in RESERVED_LEVELS:
        raise ValueError(f"privacy_level not yet supported: {level}")
    if level not in BUILD_LEVELS:
        raise ValueError("unsupported team bundle privacy_level")

    member_id = _required_str(payload.get("member_id"), "member_id")
    if level == LEVEL_TEAM:
        member_name = _member_name(payload.get("member_name"))
    else:
        if payload.get("member_name") is not None:
            raise ValueError("member_name is not allowed at the structural level")
        member_name = None
    generated_at = _date_or_string(payload.get("generated_at"), "generated_at")
    generated_seq = _generated_seq(payload.get("generated_seq"))
    app_version = _required_str(payload.get("app_version"), "app_version")
    raw_sessions = payload.get("sessions")
    if not isinstance(raw_sessions, list):
        raise ValueError("sessions must be a list")
    if len(raw_sessions) > MAX_SESSIONS_PER_BUNDLE:
        raise ValueError(
            f"sessions list is too long (max {MAX_SESSIONS_PER_BUNDLE})"
        )

    sessions: list[dict[str, Any]] = []
    seen_sids: set[str] = set()
    for index, raw_session in enumerate(raw_sessions):
        session = _validate_session(raw_session, index, level, legacy=legacy)
        sid = session["sid"]
        if sid in seen_sids:
            raise ValueError("duplicate session id in team bundle")
        seen_sids.add(sid)
        sessions.append(session)

    hash_canonical: dict[str, Any] = {
        "schema_version": version,
        "privacy_level": level,
        "profile": level,  # stored in the team_bundles.profile column
        "member_id": member_id,
        "member_name": member_name,
        "generated_at": generated_at,
        "generated_seq": generated_seq,
        "app_version": app_version,
        "sessions": sessions,
    }
    if level == LEVEL_TEAM:
        canonical_for_id = dict(hash_canonical)
    else:
        canonical_for_id = {k: v for k, v in hash_canonical.items() if k != "member_name"}
    computed_id = (
        bundle_content_id_v2(canonical_for_id)
        if legacy
        else bundle_content_id_v3(canonical_for_id)
    )
    supplied_id = payload.get("bundle_id")
    if supplied_id is not None and str(supplied_id) != computed_id:
        raise ValueError("bundle_id does not match bundle content")
    canonical = dict(hash_canonical)
    if legacy:
        canonical["sessions"] = [_strip_deprecated_session(session) for session in sessions]
    canonical["bundle_id"] = computed_id
    return canonical


def _member_name(value: Any) -> str:
    name = _required_str(value, "member_name").strip()
    if not name:
        raise ValueError("member_name must be a non-empty string")
    if len(name) > 80:
        raise ValueError("member_name is too long (max 80 characters)")
    return name


def _project_label(value: Any, name: str) -> str:
    label = _required_str(value, name).strip()
    if not label:
        raise ValueError(f"{name} must be a non-empty string")
    if len(label) > 120:
        raise ValueError(f"{name} is too long (max 120 characters)")
    if "/" in label or "\\" in label:
        raise ValueError(f"{name} must not contain path separators")
    normalize_project_key(label)  # reject labels that normalize to nothing
    return label


def import_team_bundle(
    conn: sqlite3.Connection,
    payload: Any,
    *,
    source_path: Path,
) -> TeamImportResult:
    bundle = validate_team_bundle(payload)
    existing = conn.execute(
        "SELECT session_count, member_id FROM team_bundles WHERE bundle_id = ?",
        (bundle["bundle_id"],),
    ).fetchone()
    if existing is not None:
        return TeamImportResult(
            bundle_id=bundle["bundle_id"],
            member_id=str(existing["member_id"]),
            session_count=int(existing["session_count"]),
            imported=False,
            status="duplicate",
        )

    # Ordered by (generated_at, generated_seq) so two different bundles from the
    # same member on the same day are ordered by export sequence rather than
    # silently replacing each other based on import order.
    newest_row = conn.execute(
        """
        SELECT generated_at, generated_seq FROM team_bundles
        WHERE member_id = ?
        ORDER BY generated_at DESC, generated_seq DESC
        LIMIT 1
        """,
        (bundle["member_id"],),
    ).fetchone()
    if newest_row is not None:
        newest_tuple = (str(newest_row["generated_at"]), int(newest_row["generated_seq"] or 0))
        incoming_tuple = (str(bundle["generated_at"]), int(bundle["generated_seq"]))
        if incoming_tuple < newest_tuple:
            return TeamImportResult(
                bundle_id=bundle["bundle_id"],
                member_id=bundle["member_id"],
                session_count=0,
                imported=False,
                status="stale",
            )

    imported_at = datetime.now(timezone.utc).isoformat()
    with conn:
        # A bundle is a full snapshot of one member's sessions, so a newer
        # bundle supersedes everything previously imported for that member.
        replaced = int(conn.execute(
            "SELECT COUNT(*) FROM team_bundles WHERE member_id = ?",
            (bundle["member_id"],),
        ).fetchone()[0])
        conn.execute("DELETE FROM team_bundle_sessions WHERE member_id = ?", (bundle["member_id"],))
        conn.execute("DELETE FROM team_bundles WHERE member_id = ?", (bundle["member_id"],))
        cur = conn.execute(
            """
            INSERT INTO team_bundles(
                bundle_id, profile, schema_version, member_id, member_name, generated_at,
                generated_seq, app_version, imported_at, source_path, session_count
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                bundle["bundle_id"],
                bundle["profile"],
                bundle["schema_version"],
                bundle["member_id"],
                bundle["member_name"],
                bundle["generated_at"],
                bundle["generated_seq"],
                bundle["app_version"],
                imported_at,
                str(source_path),
                len(bundle["sessions"]),
            ),
        )
        team_bundle_id = int(cur.lastrowid)
        session_rows = []
        for session in bundle["sessions"]:
            if bundle["privacy_level"] == LEVEL_TEAM:
                project_key = normalize_project_key(session["project_name"])
                project_name = session["project_name"]
            else:
                project_key = session["pid"]
                project_name = None
            session_rows.append(
                (
                    team_bundle_id,
                    bundle["member_id"],
                    project_key,
                    project_name,
                    session["sid"],
                    session["provider"],
                    session["first_date"],
                    session["last_date"],
                    session["duration_s"],
                    _json(session["models"]),
                    _json(session["tokens"]),
                    _json(session["tokens_by_model"]),
                    _json(session["stats"]),
                    _json(session["stop_reasons"]),
                    _json(session["subagents"]),
                    _json(session.get("tools", [])),
                    _json(session.get("file_types", [])),
                )
            )
        conn.executemany(
            """
            INSERT INTO team_bundle_sessions(
                team_bundle_id, member_id, project_id, project_name, session_id, provider,
                first_date, last_date, duration_s, models_json, tokens_json,
                tokens_by_model_json, stats_json, stop_reasons_json,
                subagents_json, tools_json, file_types_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            session_rows,
        )

    return TeamImportResult(
        bundle_id=bundle["bundle_id"],
        member_id=bundle["member_id"],
        session_count=len(bundle["sessions"]),
        imported=True,
        status="replaced" if replaced else "imported",
    )


def list_team_imports(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT id, bundle_id, profile, schema_version, member_id, member_name, generated_at,
               app_version, imported_at, source_path, session_count
        FROM team_bundles
        ORDER BY imported_at DESC, id DESC
        """
    ).fetchall()
    return [dict(row) | {"privacy_level": privacy_level_of(row["profile"])} for row in rows]


def delete_team_member(conn: sqlite3.Connection, member_id: str) -> int:
    """Remove every imported bundle (and its sessions) for one member."""
    with conn:
        removed = int(conn.execute(
            "SELECT COUNT(*) FROM team_bundles WHERE member_id = ?", (member_id,)
        ).fetchone()[0])
        conn.execute("DELETE FROM team_bundle_sessions WHERE member_id = ?", (member_id,))
        conn.execute("DELETE FROM team_bundles WHERE member_id = ?", (member_id,))
    return removed


def reset_team_bundles(conn: sqlite3.Connection) -> None:
    with conn:
        conn.execute("DELETE FROM team_bundle_sessions")
        conn.execute("DELETE FROM team_bundles")


def team_dashboard(conn: sqlite3.Connection) -> dict[str, Any]:
    bundles = conn.execute(
        "SELECT bundle_id, member_id, member_name, session_count FROM team_bundles ORDER BY imported_at, id"
    ).fetchall()
    sessions = conn.execute(
        """
        SELECT tb.bundle_id, tbs.member_id, tbs.project_id, tbs.project_name, tbs.provider,
               tbs.first_date, tbs.last_date, tbs.duration_s,
               tbs.tokens_json, tbs.tokens_by_model_json, tbs.stats_json,
               tbs.stop_reasons_json, tbs.subagents_json, tbs.tools_json,
               tbs.file_types_json
        FROM team_bundle_sessions tbs
        JOIN team_bundles tb ON tb.id = tbs.team_bundle_id
        ORDER BY tbs.first_date, tbs.id
        """
    ).fetchall()

    token_totals = {key: 0 for key in TOKEN_KEYS}
    stat_totals = {key: 0 for key in DASHBOARD_STAT_KEYS}
    provider_counts: Counter[str] = Counter()
    model_token_totals: Counter[str] = Counter()
    stop_reason_counts: Counter[str] = Counter()
    subagent_events: Counter[str] = Counter()
    subagent_sessions: Counter[str] = Counter()
    over_time: dict[str, dict[str, int]] = defaultdict(lambda: {"session_count": 0, "tokens": 0})

    name_by_member: dict[str, str | None] = {
        str(bundle["member_id"]): bundle["member_name"] for bundle in bundles
    }

    def _member_key(member_id: str) -> str:
        return name_by_member.get(member_id) or f"id:{member_id}"

    def _member_label(member_id: str) -> str:
        return name_by_member.get(member_id) or f"member-{member_id[:8]}"

    member_summary: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"label": "", "member_ids": set(), "bundle_ids": set(), "project_ids": set(),
                 "session_count": 0, "tokens": 0, "error_count": 0}
    )
    project_summary: dict[str, dict[str, Any]] = {}
    tool_calls_total: Counter[str] = Counter()
    tool_sessions: Counter[str] = Counter()
    file_type_counts: Counter[str] = Counter()
    file_type_sessions: Counter[str] = Counter()
    project_ids: set[str] = set()
    first_dates: list[str] = []
    last_dates: list[str] = []

    for bundle in bundles:
        member_id = str(bundle["member_id"])
        summary = member_summary[_member_key(member_id)]
        summary["label"] = _member_label(member_id)
        summary["member_ids"].add(member_id)
        summary["bundle_ids"].add(str(bundle["bundle_id"]))

    for row in sessions:
        member_id = str(row["member_id"])
        tokens = _loads_dict(row["tokens_json"])
        tokens_by_model = _loads_dict(row["tokens_by_model_json"])
        stats = _loads_dict(row["stats_json"])
        stop_reasons = _loads_dict(row["stop_reasons_json"])
        subagents = _loads_list(row["subagents_json"])

        for key in TOKEN_KEYS:
            token_totals[key] += _nonnegative_int(tokens.get(key))
        for key in DASHBOARD_STAT_KEYS:
            stat_totals[key] += _nonnegative_int(stats.get(key))

        provider_counts[str(row["provider"] or DEFAULT_PROVIDER)] += 1
        for model, model_tokens in tokens_by_model.items():
            if not isinstance(model_tokens, dict):
                continue
            observed_tokens = _nonnegative_int(model_tokens.get("input")) + _nonnegative_int(
                model_tokens.get("output")
            )
            if observed_tokens > 0:
                model_token_totals[str(model)] += observed_tokens
        for reason, count in stop_reasons.items():
            stop_reason_counts[str(reason)] += _nonnegative_int(count)
        seen_types: set[str] = set()
        for subagent in subagents:
            if not isinstance(subagent, dict):
                continue
            agent_type = str(subagent.get("agent_type") or "custom")
            subagent_events[agent_type] += _nonnegative_int(subagent.get("event_count"))
            seen_types.add(agent_type)
        for agent_type in seen_types:
            subagent_sessions[agent_type] += 1
        session_tokens = _nonnegative_int(tokens.get("input")) + _nonnegative_int(tokens.get("output"))

        project_key = str(row["project_id"])
        project_ids.add(project_key)
        project = project_summary.setdefault(
            project_key,
            {"project_key": project_key, "project_name": row["project_name"] or project_key[:8],
             "members": set(), "session_count": 0, "tokens": 0},
        )
        if row["project_name"] and project["project_name"] == project_key[:8]:
            project["project_name"] = str(row["project_name"])
        project["members"].add(_member_key(member_id))
        project["session_count"] += 1
        project["tokens"] += session_tokens

        tools = _loads_list(row["tools_json"])
        seen_tools: set[str] = set()
        for tool in tools:
            if not isinstance(tool, dict) or not tool.get("name"):
                continue
            name = str(tool["name"])
            tool_calls_total[name] += _nonnegative_int(tool.get("calls"))
            seen_tools.add(name)
        for name in seen_tools:
            tool_sessions[name] += 1

        file_types = _loads_list(row["file_types_json"])
        seen_exts: set[str] = set()
        for entry in file_types:
            if not isinstance(entry, dict) or not entry.get("ext"):
                continue
            ext = str(entry["ext"])
            file_type_counts[ext] += _nonnegative_int(entry.get("count"))
            seen_exts.add(ext)
        for ext in seen_exts:
            file_type_sessions[ext] += 1

        member_summary[_member_key(member_id)]["project_ids"].add(project_key)
        member_summary[_member_key(member_id)]["session_count"] += 1
        member_summary[_member_key(member_id)]["tokens"] += session_tokens
        member_summary[_member_key(member_id)]["error_count"] += _nonnegative_int(
            stats.get("errors")
        )
        if row["first_date"]:
            bucket = str(row["first_date"])
            first_dates.append(bucket)
            over_time[bucket]["session_count"] += 1
            over_time[bucket]["tokens"] += session_tokens
        if row["last_date"]:
            last_dates.append(str(row["last_date"]))

    return {
        "meta": {
            "bundle_count": len(bundles),
            "member_count": len(member_summary),
            "project_count": len(project_ids),
            "session_count": len(sessions),
            "date_from": min(first_dates) if first_dates else None,
            "date_to": max([*last_dates, *first_dates]) if (last_dates or first_dates) else None,
        },
        "tokens": {**token_totals, "total": token_totals["input"] + token_totals["output"]},
        "stats": stat_totals,
        "reliability": {
            "error_count": stat_totals["errors"],
            "session_count": len(sessions),
            "errors_per_session": stat_totals["errors"] / len(sessions) if sessions else 0.0,
        },
        "providers": _count_entries(provider_counts, "provider"),
        "models": [
            {"model": model, "tokens": tokens}
            for model, tokens in sorted(
                model_token_totals.items(), key=lambda item: (-item[1], item[0])
            )
        ],
        "stop_reasons": _count_entries(stop_reason_counts, "reason", count_key="count"),
        "subagents": [
            {
                "agent_type": agent_type,
                "event_count": subagent_events[agent_type],
                "session_count": subagent_sessions[agent_type],
            }
            for agent_type in sorted(subagent_events)
        ],
        "members": [
            {
                "member_name": summary["label"],
                "member_ids": sorted(summary["member_ids"]),
                "bundle_count": len(summary["bundle_ids"]),
                "project_count": len(summary["project_ids"]),
                "session_count": int(summary["session_count"]),
                "tokens": int(summary["tokens"]),
                "error_count": int(summary["error_count"]),
                "errors_per_session": (
                    int(summary["error_count"]) / int(summary["session_count"])
                    if summary["session_count"]
                    else 0.0
                ),
            }
            for _key, summary in sorted(member_summary.items(), key=lambda item: item[1]["label"])
        ],
        "projects": [
            {
                "project_key": project["project_key"],
                "project_name": project["project_name"],
                "member_count": len(project["members"]),
                "session_count": int(project["session_count"]),
                "tokens": int(project["tokens"]),
            }
            for project in sorted(
                project_summary.values(), key=lambda item: (-item["tokens"], item["project_name"])
            )
        ],
        "tools": [
            {"name": name, "call_count": tool_calls_total[name], "session_count": tool_sessions[name]}
            for name, _count in sorted(tool_calls_total.items(), key=lambda item: (-item[1], item[0]))
        ],
        "file_types": [
            {"ext": ext, "count": file_type_counts[ext], "session_count": file_type_sessions[ext]}
            for ext, _count in sorted(file_type_counts.items(), key=lambda item: (-item[1], item[0]))
        ],
        "over_time": [
            {"date": bucket, **values}
            for bucket, values in sorted(over_time.items())
        ],
    }


def _validate_session(
    raw_session: Any, index: int, level: str, *, legacy: bool
) -> dict[str, Any]:
    if not isinstance(raw_session, dict):
        raise ValueError(f"sessions[{index}] must be an object")
    if legacy:
        allowed = LEGACY_SESSION_KEYS_TEAM if level == LEVEL_TEAM else LEGACY_SESSION_KEYS
        stat_keys = LEGACY_STAT_KEYS
    else:
        allowed = SESSION_KEYS_TEAM if level == LEVEL_TEAM else SESSION_KEYS
        stat_keys = STAT_KEYS
    unknown = set(raw_session) - allowed
    if unknown:
        raise ValueError(f"unexpected session field: {sorted(unknown)[0]}")
    session: dict[str, Any] = {
        "sid": _hex_id(raw_session.get("sid"), f"sessions[{index}].sid"),
        "provider": _provider(raw_session.get("provider")),
        "models": _models(raw_session.get("models")),
        "first_date": _optional_date(raw_session.get("first_date"), f"sessions[{index}].first_date"),
        "last_date": _optional_date(raw_session.get("last_date"), f"sessions[{index}].last_date"),
        "duration_s": _nonnegative_int(raw_session.get("duration_s")),
        "tokens": _number_map(raw_session.get("tokens"), TOKEN_KEYS),
        "tokens_by_model": _tokens_by_model(raw_session.get("tokens_by_model")),
        "stats": _number_map(raw_session.get("stats"), stat_keys),
        "stop_reasons": _stop_reasons(raw_session.get("stop_reasons")),
        "subagents": _subagents(raw_session.get("subagents"), raw=(level == LEVEL_TEAM)),
    }
    if legacy:
        session["risk_categories"] = _risk_categories(raw_session.get("risk_categories"))
        session["sequence"] = _sequence(raw_session.get("sequence"))
    if level == LEVEL_TEAM:
        session["project_name"] = _project_label(
            raw_session.get("project_name"), f"sessions[{index}].project_name"
        )
        session["tools"] = _tools(raw_session.get("tools"))
        session["file_types"] = _file_types(raw_session.get("file_types"))
    else:
        session["pid"] = _hex_id(raw_session.get("pid"), f"sessions[{index}].pid")
    return session


def _strip_deprecated_session(session: dict[str, Any]) -> dict[str, Any]:
    stripped = {
        key: value
        for key, value in session.items()
        if key not in {"risk_categories", "sequence"}
    }
    stats = stripped.get("stats")
    stripped["stats"] = {
        key: _nonnegative_int(stats.get(key) if isinstance(stats, dict) else 0)
        for key in STAT_KEYS
    }
    return stripped


def _required_str(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be a non-empty string")
    return value


def _date_or_string(value: Any, name: str) -> str:
    text = _required_str(value, name)
    try:
        parsed = date.fromisoformat(text)
    except ValueError as exc:
        raise ValueError(f"{name} must be an ISO date (YYYY-MM-DD)") from exc
    if parsed.isoformat() != text:
        raise ValueError(f"{name} must be an ISO date (YYYY-MM-DD)")
    return text


def _optional_date(value: Any, name: str) -> str | None:
    if value is None:
        return None
    return _date_or_string(value, name)


def _generated_seq(value: Any) -> int:
    # Missing generated_seq means a legacy (pre-sequence) bundle: treat as 0.
    if value is None:
        return 0
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("generated_seq must be a non-negative integer")
    if value < 0 or value > MAX_GENERATED_SEQ:
        raise ValueError(
            f"generated_seq must be between 0 and {MAX_GENERATED_SEQ}"
        )
    return value


def _hex_id(value: Any, name: str) -> str:
    text = _required_str(value, name)
    if len(text) != 64:
        raise ValueError(f"{name} must be a 64-character pseudonymous id")
    try:
        int(text, 16)
    except ValueError as exc:
        raise ValueError(f"{name} must be hex") from exc
    return text


def _provider(value: Any) -> str:
    if value in (None, ""):
        return DEFAULT_PROVIDER
    provider = str(value)
    return provider if provider == DEFAULT_PROVIDER else "other"


def _models(value: Any) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError("models must be a list")
    return sorted({bucket_model(str(item)) for item in value})


def _number_map(value: Any, keys: tuple[str, ...]) -> dict[str, int]:
    if not isinstance(value, dict):
        value = {}
    return {key: _nonnegative_int(value.get(key)) for key in keys}


def _tokens_by_model(value: Any) -> dict[str, dict[str, int]]:
    if not isinstance(value, dict):
        return {}
    return _fold_tokens_by_model(
        (bucket_model(str(model)), _number_map(tokens, TOKEN_KEYS)) for model, tokens in value.items()
    )


def _stop_reasons(value: Any) -> dict[str, int]:
    if not isinstance(value, dict):
        return {}
    counts: dict[str, int] = {}
    for raw_key, raw_count in value.items():
        key = str(raw_key) if str(raw_key) in KNOWN_STOP_REASONS else "other"
        count = _nonnegative_int(raw_count)
        if count:
            counts[key] = counts.get(key, 0) + count
    return counts


def _risk_categories(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return sorted({str(item) if str(item) in RISK_CATEGORIES else "other" for item in value})


def _tools(value: Any) -> list[dict[str, Any]]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError("tools must be a list")
    if len(value) > _MAX_TOOLS_PER_SESSION:
        raise ValueError("tools list is too long")
    result: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict):
            raise ValueError("tools entries must be objects")
        unknown = set(item) - {"name", "calls"}
        if unknown:
            raise ValueError(f"unexpected tool field: {sorted(unknown)[0]}")
        name = _required_str(item.get("name"), "tools[].name").strip()
        if len(name) > 120:
            raise ValueError("tool name is too long (max 120 characters)")
        result.append({"name": name, "calls": _nonnegative_int(item.get("calls"))})
    return sorted(result, key=lambda entry: entry["name"])


def _file_types(value: Any) -> list[dict[str, Any]]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError("file_types must be a list")
    if len(value) > _MAX_FILE_TYPES_PER_SESSION:
        raise ValueError("file_types list is too long")
    result: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict):
            raise ValueError("file_types entries must be objects")
        unknown = set(item) - {"ext", "count"}
        if unknown:
            raise ValueError(f"unexpected file_types field: {sorted(unknown)[0]}")
        ext = _required_str(item.get("ext"), "file_types[].ext")
        if not _EXT_RE.match(ext):
            raise ValueError(f"invalid file extension: {ext!r}")
        result.append({"ext": ext, "count": _nonnegative_int(item.get("count"))})
    return sorted(result, key=lambda entry: entry["ext"])


def _subagents(value: Any, *, raw: bool = False) -> list[dict[str, int | str]]:
    if not isinstance(value, list):
        return []
    result: list[dict[str, int | str]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        unknown = set(item) - {"agent_type", "event_count"}
        if unknown:
            raise ValueError(f"unexpected subagent field: {sorted(unknown)[0]}")
        if raw:
            agent_type = str(item.get("agent_type") or "").strip() or "custom"
            if len(agent_type) > 80:
                raise ValueError("subagent agent_type is too long (max 80 characters)")
        else:
            agent_type = bucket_agent_type(item.get("agent_type"))
        result.append({"agent_type": agent_type, "event_count": _nonnegative_int(item.get("event_count"))})
    return result


def _sequence(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    result: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        unknown = set(item) - {"sym", "fam", "dt_s", "out_tok"}
        if unknown:
            raise ValueError(f"unexpected sequence field: {sorted(unknown)[0]}")
        family = str(item.get("fam") or "")
        if family not in {"tool_call", "tool_result"}:
            raise ValueError("sequence family must be tool_call or tool_result")
        step: dict[str, Any] = {
            "sym": sanitize_symbol(str(item.get("sym") or ""), family),
            "fam": family,
            "dt_s": _nonnegative_int(item.get("dt_s")),
        }
        if family == "tool_call":
            step["out_tok"] = _nonnegative_int(item.get("out_tok"))
        result.append(step)
    return result


def _nonnegative_int(value: Any) -> int:
    try:
        parsed = int(value or 0)
    except (OverflowError, TypeError, ValueError):
        return 0
    return min(MAX_COUNTER_VALUE, max(0, parsed))


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _loads_dict(value: Any) -> dict[str, Any]:
    loaded = _loads(value)
    return loaded if isinstance(loaded, dict) else {}


def _loads_list(value: Any) -> list[Any]:
    loaded = _loads(value)
    return loaded if isinstance(loaded, list) else []


def _loads(value: Any) -> Any:
    if not value:
        return None
    try:
        return json.loads(str(value))
    except json.JSONDecodeError:
        return None


def _count_entries(counter: Counter[str], key_name: str, *, count_key: str = "session_count") -> list[dict[str, Any]]:
    return [
        {key_name: key, count_key: count}
        for key, count in sorted(counter.items(), key=lambda item: (-item[1], item[0]))
    ]
