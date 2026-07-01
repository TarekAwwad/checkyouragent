"""Team-strict privacy bundle export/import and dashboard aggregation.

The bundle is built from an explicit structural allowlist and reuses the
contribution sanitizers for model/tool/subagent buckets. Imports are
canonicalized before persistence so the team tables never need raw Claude
export content, previews, paths, commands, prompts, model aliases, or MCP names.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

from ccfr.analysis.contribution import (
    KNOWN_STOP_REASONS,
    bucket_agent_type,
    bucket_model,
    sanitize_symbol,
)
from ccfr.analysis import contribution as contribution_helpers

SCHEMA_VERSION = 1
PROFILE = "team_strict"
DEFAULT_PROVIDER = "claude"

TOKEN_KEYS = ("input", "output", "base", "cache_5m", "cache_1h", "cache_read")
STAT_KEYS = (
    "turns",
    "tool_calls",
    "subagents",
    "errors",
    "system",
    "loops",
    "max_repeat",
    "persisted_outputs",
)
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
    "risk_categories",
    "subagents",
    "sequence",
}
TOP_LEVEL_KEYS = {
    "schema_version",
    "profile",
    "bundle_id",
    "member_id",
    "generated_at",
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
    bundle_id: str | None = None

    def base_dict(self) -> dict[str, Any]:
        return {
            "schema_version": SCHEMA_VERSION,
            "profile": PROFILE,
            "member_id": self.member_id,
            "generated_at": self.generated_at,
            "app_version": self.app_version,
            "sessions": self.sessions,
        }

    def to_dict(self) -> dict[str, Any]:
        data = self.base_dict()
        data["bundle_id"] = self.bundle_id or bundle_content_id(data)
        return data


@dataclass(frozen=True)
class TeamImportResult:
    bundle_id: str
    member_id: str
    session_count: int
    imported: bool


def _hash_id(salt: str, namespace: str, *parts: object) -> str:
    body = "\0".join([PROFILE, namespace, *[str(part) for part in parts]])
    return hashlib.sha256(f"{salt}\0{body}".encode()).hexdigest()


def bundle_content_id(bundle: dict[str, Any]) -> str:
    base = {key: bundle[key] for key in (
        "schema_version", "profile", "member_id", "generated_at", "app_version", "sessions",
    )}
    encoded = json.dumps(base, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


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
        WHERE e.session_id = ?
        GROUP BY m.model
        """,
        (session_pk,),
    ).fetchall()
    return _fold_tokens_by_model(
        (bucket_model(row["model"]), {key: int(row[key]) for key in TOKEN_KEYS}) for row in rows
    )


def build_team_bundle(
    conn: sqlite3.Connection,
    *,
    salt: str,
    member_id: str,
    app_version: str,
    generated_on: date,
) -> TeamBundle:
    sessions: list[dict[str, Any]] = []
    session_rows = conn.execute(
        """
        SELECT s.id, s.session_id, s.first_ts, s.last_ts, p.export_name
        FROM sessions s
        JOIN projects p ON p.id = s.project_id
        ORDER BY p.id, s.id
        """
    ).fetchall()

    for row in session_rows:
        session_pk = int(row["id"])
        export_name = str(row["export_name"])
        sessions.append(
            {
                "pid": _hash_id(salt, "project", export_name),
                "sid": _hash_id(salt, "session", export_name, row["session_id"]),
                "provider": DEFAULT_PROVIDER,
                "models": contribution_helpers._session_models(conn, session_pk),
                "first_date": contribution_helpers._date_only(row["first_ts"]),
                "last_date": contribution_helpers._date_only(row["last_ts"]),
                "duration_s": contribution_helpers._duration_s(row["first_ts"], row["last_ts"]),
                "tokens": contribution_helpers._session_tokens(conn, session_pk),
                "tokens_by_model": _session_tokens_by_model(conn, session_pk),
                "stats": contribution_helpers._session_stats(conn, session_pk),
                "stop_reasons": contribution_helpers._session_stop_reasons(conn, session_pk),
                "risk_categories": contribution_helpers._session_risk_categories(conn, session_pk),
                "subagents": contribution_helpers._session_subagents(conn, session_pk),
                "sequence": contribution_helpers._session_sequence(conn, session_pk),
            }
        )

    raw_bundle = TeamBundle(
        member_id=member_id,
        generated_at=generated_on.isoformat(),
        app_version=app_version,
        sessions=sessions,
    )
    canonical = validate_team_bundle(raw_bundle.base_dict())
    return TeamBundle(
        member_id=canonical["member_id"],
        generated_at=canonical["generated_at"],
        app_version=canonical["app_version"],
        sessions=canonical["sessions"],
        bundle_id=canonical["bundle_id"],
    )


def team_bundle_manifest(bundle: TeamBundle) -> dict[str, Any]:
    sessions = bundle.sessions
    return {
        "profile": PROFILE,
        "session_count": len(sessions),
        "sequence_step_count": sum(len(session["sequence"]) for session in sessions),
        "included_fields": [
            "Pseudonymous member, project, and session IDs",
            "Provider and bucketed model families",
            "Date-only session timing and structural per-step deltas",
            "Token counts with cache breakdowns, split per model family",
            "Session stats, stop reasons, risk categories",
            "Bucketed subagent types and structural event sequence",
        ],
        "excluded": [
            "Raw JSON and previews",
            "Prompts, assistant text, reasoning, titles, and free text",
            "Paths, cwd, branches, file names, shell commands, and tool IO",
            "Raw model aliases, MCP server names, and custom subagent names",
        ],
        "fingerprint_caveat": (
            "This bundle contains no content, but token counts and structural sequences "
            "can still be distinctive."
        ),
    }


def validate_team_bundle(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("team bundle must be a JSON object")
    unknown = set(payload) - TOP_LEVEL_KEYS
    if unknown:
        raise ValueError(f"unexpected team bundle field: {sorted(unknown)[0]}")
    if payload.get("profile") != PROFILE:
        raise ValueError("unsupported team bundle profile")
    if payload.get("schema_version") != SCHEMA_VERSION:
        raise ValueError("unsupported team bundle schema_version")

    member_id = _required_str(payload.get("member_id"), "member_id")
    generated_at = _date_or_string(payload.get("generated_at"), "generated_at")
    app_version = _required_str(payload.get("app_version"), "app_version")
    raw_sessions = payload.get("sessions")
    if not isinstance(raw_sessions, list):
        raise ValueError("sessions must be a list")

    raw_base = {
        "schema_version": SCHEMA_VERSION,
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
        session = _validate_session(raw_session, index)
        sid = session["sid"]
        if sid in seen_sids:
            raise ValueError("duplicate session id in team bundle")
        seen_sids.add(sid)
        sessions.append(session)

    canonical = {
        "schema_version": SCHEMA_VERSION,
        "profile": PROFILE,
        "member_id": member_id,
        "generated_at": generated_at,
        "app_version": app_version,
        "sessions": sessions,
    }
    computed_id = bundle_content_id(canonical)
    supplied_id = payload.get("bundle_id")
    if supplied_id is not None and str(supplied_id) not in {computed_id, legacy_export_id}:
        raise ValueError("bundle_id does not match bundle content")
    canonical["bundle_id"] = computed_id
    return canonical


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
        )

    imported_at = datetime.now(timezone.utc).isoformat()
    with conn:
        cur = conn.execute(
            """
            INSERT INTO team_bundles(
                bundle_id, profile, schema_version, member_id, generated_at,
                app_version, imported_at, source_path, session_count
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                bundle["bundle_id"],
                bundle["profile"],
                bundle["schema_version"],
                bundle["member_id"],
                bundle["generated_at"],
                bundle["app_version"],
                imported_at,
                str(source_path),
                len(bundle["sessions"]),
            ),
        )
        team_bundle_id = int(cur.lastrowid)
        conn.executemany(
            """
            INSERT INTO team_bundle_sessions(
                team_bundle_id, member_id, project_id, session_id, provider,
                first_date, last_date, duration_s, models_json, tokens_json,
                tokens_by_model_json, stats_json, stop_reasons_json,
                risk_categories_json, subagents_json, sequence_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    team_bundle_id,
                    bundle["member_id"],
                    session["pid"],
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
                    _json(session["risk_categories"]),
                    _json(session["subagents"]),
                    _json(session["sequence"]),
                )
                for session in bundle["sessions"]
            ],
        )

    return TeamImportResult(
        bundle_id=bundle["bundle_id"],
        member_id=bundle["member_id"],
        session_count=len(bundle["sessions"]),
        imported=True,
    )


def list_team_imports(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT id, bundle_id, profile, schema_version, member_id, generated_at,
               app_version, imported_at, source_path, session_count
        FROM team_bundles
        ORDER BY imported_at DESC, id DESC
        """
    ).fetchall()
    return [dict(row) for row in rows]


def reset_team_bundles(conn: sqlite3.Connection) -> None:
    with conn:
        conn.execute("DELETE FROM team_bundle_sessions")
        conn.execute("DELETE FROM team_bundles")


def team_dashboard(conn: sqlite3.Connection) -> dict[str, Any]:
    bundles = conn.execute(
        "SELECT bundle_id, member_id, session_count FROM team_bundles ORDER BY imported_at, id"
    ).fetchall()
    sessions = conn.execute(
        """
        SELECT tb.bundle_id, tbs.member_id, tbs.project_id, tbs.provider,
               tbs.first_date, tbs.last_date, tbs.duration_s, tbs.models_json,
               tbs.tokens_json, tbs.stats_json, tbs.stop_reasons_json,
               tbs.risk_categories_json, tbs.subagents_json, tbs.sequence_json
        FROM team_bundle_sessions tbs
        JOIN team_bundles tb ON tb.id = tbs.team_bundle_id
        ORDER BY tbs.first_date, tbs.id
        """
    ).fetchall()

    token_totals = {key: 0 for key in TOKEN_KEYS}
    stat_totals = {key: 0 for key in STAT_KEYS}
    provider_counts: Counter[str] = Counter()
    model_counts: Counter[str] = Counter()
    stop_reason_counts: Counter[str] = Counter()
    risk_counts: Counter[str] = Counter()
    sequence_counts: Counter[str] = Counter()
    subagent_events: Counter[str] = Counter()
    subagent_sessions: Counter[str] = Counter()
    over_time: dict[str, dict[str, int]] = defaultdict(lambda: {"session_count": 0, "tokens": 0})
    member_summary: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"bundle_ids": set(), "project_ids": set(), "session_count": 0, "tokens": 0}
    )
    project_ids: set[str] = set()
    first_dates: list[str] = []
    last_dates: list[str] = []

    for bundle in bundles:
        member_summary[str(bundle["member_id"])]["bundle_ids"].add(str(bundle["bundle_id"]))

    for row in sessions:
        member_id = str(row["member_id"])
        tokens = _loads_dict(row["tokens_json"])
        stats = _loads_dict(row["stats_json"])
        models = _loads_list(row["models_json"])
        stop_reasons = _loads_dict(row["stop_reasons_json"])
        risks = _loads_list(row["risk_categories_json"])
        subagents = _loads_list(row["subagents_json"])
        sequence = _loads_list(row["sequence_json"])

        for key in TOKEN_KEYS:
            token_totals[key] += _nonnegative_int(tokens.get(key))
        for key in STAT_KEYS:
            value = _nonnegative_int(stats.get(key))
            if key == "max_repeat":
                stat_totals[key] = max(stat_totals[key], value)
            else:
                stat_totals[key] += value

        provider_counts[str(row["provider"] or DEFAULT_PROVIDER)] += 1
        for model in models:
            model_counts[str(model)] += 1
        for reason, count in stop_reasons.items():
            stop_reason_counts[str(reason)] += _nonnegative_int(count)
        for category in risks:
            risk_counts[str(category)] += 1
        for subagent in subagents:
            if not isinstance(subagent, dict):
                continue
            agent_type = str(subagent.get("agent_type") or "custom")
            subagent_events[agent_type] += _nonnegative_int(subagent.get("event_count"))
            subagent_sessions[agent_type] += 1
        for step in sequence:
            if isinstance(step, dict) and step.get("sym"):
                sequence_counts[str(step["sym"])] += 1

        project_id = str(row["project_id"])
        project_ids.add(project_id)

        session_tokens = _nonnegative_int(tokens.get("input")) + _nonnegative_int(tokens.get("output"))
        member_summary[member_id]["project_ids"].add(project_id)
        member_summary[member_id]["session_count"] += 1
        member_summary[member_id]["tokens"] += session_tokens
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
        "providers": _count_entries(provider_counts, "provider"),
        "models": _count_entries(model_counts, "model"),
        "stop_reasons": _count_entries(stop_reason_counts, "reason", count_key="count"),
        "risk_categories": _count_entries(risk_counts, "category", count_key="session_count"),
        "subagents": [
            {
                "agent_type": agent_type,
                "event_count": subagent_events[agent_type],
                "session_count": subagent_sessions[agent_type],
            }
            for agent_type in sorted(subagent_events)
        ],
        "sequence": [
            {"sym": sym, "count": count}
            for sym, count in sequence_counts.most_common(20)
        ],
        "members": [
            {
                "member_id": member_id,
                "bundle_count": len(summary["bundle_ids"]),
                "project_count": len(summary["project_ids"]),
                "session_count": int(summary["session_count"]),
                "tokens": int(summary["tokens"]),
            }
            for member_id, summary in sorted(member_summary.items())
        ],
        "over_time": [
            {"date": bucket, **values}
            for bucket, values in sorted(over_time.items())
        ],
    }


def _validate_session(raw_session: Any, index: int) -> dict[str, Any]:
    if not isinstance(raw_session, dict):
        raise ValueError(f"sessions[{index}] must be an object")
    unknown = set(raw_session) - SESSION_KEYS
    if unknown:
        raise ValueError(f"unexpected session field: {sorted(unknown)[0]}")
    pid = _hex_id(raw_session.get("pid"), f"sessions[{index}].pid")
    sid = _hex_id(raw_session.get("sid"), f"sessions[{index}].sid")
    return {
        "pid": pid,
        "sid": sid,
        "provider": _provider(raw_session.get("provider")),
        "models": _models(raw_session.get("models")),
        "first_date": _optional_date(raw_session.get("first_date"), f"sessions[{index}].first_date"),
        "last_date": _optional_date(raw_session.get("last_date"), f"sessions[{index}].last_date"),
        "duration_s": _nonnegative_int(raw_session.get("duration_s")),
        "tokens": _number_map(raw_session.get("tokens"), TOKEN_KEYS),
        "tokens_by_model": _tokens_by_model(raw_session.get("tokens_by_model")),
        "stats": _number_map(raw_session.get("stats"), STAT_KEYS),
        "stop_reasons": _stop_reasons(raw_session.get("stop_reasons")),
        "risk_categories": _risk_categories(raw_session.get("risk_categories")),
        "subagents": _subagents(raw_session.get("subagents")),
        "sequence": _sequence(raw_session.get("sequence")),
    }


def _required_str(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be a non-empty string")
    return value


def _date_or_string(value: Any, name: str) -> str:
    text = _required_str(value, name)
    if "T" in text:
        raise ValueError(f"{name} must be date-only")
    return text


def _optional_date(value: Any, name: str) -> str | None:
    if value is None:
        return None
    return _date_or_string(value, name)


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


def _subagents(value: Any) -> list[dict[str, int | str]]:
    if not isinstance(value, list):
        return []
    result: list[dict[str, int | str]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        unknown = set(item) - {"agent_type", "event_count"}
        if unknown:
            raise ValueError(f"unexpected subagent field: {sorted(unknown)[0]}")
        result.append(
            {
                "agent_type": bucket_agent_type(item.get("agent_type")),
                "event_count": _nonnegative_int(item.get("event_count")),
            }
        )
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
    except (TypeError, ValueError):
        return 0
    return max(0, parsed)


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
