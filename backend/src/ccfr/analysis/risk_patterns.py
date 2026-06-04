from __future__ import annotations

import json
import math
import re
import sqlite3
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any


MIN_PATTERN_SUPPORT = 2
MIN_LIFT = 1.15
MAX_PATTERN_LEN = 4
HIGH_COST_TOKENS = 120_000
HIGH_COST_EVENTS = 800
HIGH_COST_DURATION = 60 * 60
FANOUT_SUBAGENTS = 8
FANOUT_AGENT_EVENTS = 150

RISK_TABLES = [
    "risk_findings",
    "pattern_hits",
    "event_features",
    "sequence_patterns",
    "sequence_slices",
]


@dataclass(frozen=True)
class Feature:
    event_id: int
    symbol: str
    family: str
    attributes: dict[str, Any] = field(default_factory=dict)


@dataclass
class EventFeatures:
    event_id: int
    session_id: int
    timestamp: str | None
    is_sidechain: bool
    agent_id: str | None
    role: str | None
    input_tokens: int
    output_tokens: int
    features: list[Feature]


@dataclass
class Slice:
    id: int | None
    session_id: int
    kind: str
    lane: str
    events: list[EventFeatures]
    features: list[Feature]
    outcome: str
    duration_seconds: int


@dataclass(frozen=True)
class PatternStats:
    pattern: tuple[str, ...]
    kind: str
    support: int
    positive_support: int
    negative_support: int
    lift: float
    score: float
    category: str | None
    title: str | None
    explanation: str | None


def clear_risk_pattern_tables(conn: sqlite3.Connection, session_ids: list[int] | None = None) -> None:
    if session_ids is None:
        for table in RISK_TABLES:
            conn.execute(f"DELETE FROM {table}")
        return

    session_ids = sorted(set(session_ids))
    if not session_ids:
        return
    sp = ",".join("?" * len(session_ids))
    conn.execute(f"DELETE FROM risk_findings WHERE session_id IN ({sp})", session_ids)
    conn.execute(f"DELETE FROM pattern_hits WHERE session_id IN ({sp})", session_ids)
    conn.execute(f"DELETE FROM event_features WHERE session_id IN ({sp})", session_ids)
    conn.execute(f"DELETE FROM sequence_slices WHERE session_id IN ({sp})", session_ids)
    conn.execute(
        """
        DELETE FROM sequence_patterns
        WHERE id NOT IN (SELECT pattern_id FROM pattern_hits WHERE pattern_id IS NOT NULL)
          AND id NOT IN (SELECT pattern_id FROM risk_findings WHERE pattern_id IS NOT NULL)
        """
    )


def rebuild_risk_patterns(conn: sqlite3.Connection, session_ids: list[int] | None = None) -> None:
    clear_risk_pattern_tables(conn, session_ids=session_ids)
    events = _load_event_features(conn, session_ids=session_ids)
    slices = _build_slices(events)
    if not slices:
        return
    _insert_slices_and_features(conn, slices)
    patterns, occurrences = _mine_patterns(slices)
    pattern_ids = _insert_patterns(conn, patterns)
    _insert_hits_and_findings(conn, slices, patterns, occurrences, pattern_ids)
    _insert_heuristic_findings(conn, session_ids=session_ids)


def _load_event_features(
    conn: sqlite3.Connection,
    session_ids: list[int] | None = None,
) -> dict[int, list[EventFeatures]]:
    session_ids = sorted(set(session_ids)) if session_ids is not None else None
    session_filter = ""
    session_params: list[int] = []
    if session_ids is not None:
        if not session_ids:
            return {}
        session_filter = f"WHERE e.session_id IN ({','.join('?' * len(session_ids))})"
        session_params = session_ids

    rows = conn.execute(
        f"""
        SELECT
            e.id AS event_id,
            e.session_id,
            e.type AS event_type,
            e.timestamp,
            e.is_sidechain,
            e.agent_id,
            e.raw_json,
            m.role,
            m.stop_reason,
            COALESCE(m.input_tokens, 0) AS input_tokens,
            COALESCE(m.output_tokens, 0) AS output_tokens,
            m.text_preview
        FROM events e
        LEFT JOIN messages m ON m.event_id = e.id
        {session_filter}
        ORDER BY e.session_id, COALESCE(e.timestamp, ''), e.id
        """,
        session_params,
    ).fetchall()

    tool_filter = ""
    tool_params: list[int] = []
    if session_ids is not None:
        tool_filter = f"WHERE session_id IN ({','.join('?' * len(session_ids))})"
        tool_params = session_ids

    calls_by_event: dict[int, list[sqlite3.Row]] = defaultdict(list)
    for row in conn.execute(
        f"SELECT event_id, tool_name, input_preview, raw_json FROM tool_calls {tool_filter} ORDER BY id",
        tool_params,
    ).fetchall():
        calls_by_event[int(row["event_id"])].append(row)

    results_by_event: dict[int, list[sqlite3.Row]] = defaultdict(list)
    for row in conn.execute(
        f"SELECT event_id, is_error, output_preview, raw_json FROM tool_results {tool_filter} ORDER BY id",
        tool_params,
    ).fetchall():
        results_by_event[int(row["event_id"])].append(row)

    by_session: dict[int, list[EventFeatures]] = defaultdict(list)
    for row in rows:
        event_id = int(row["event_id"])
        features = _features_for_event(row, calls_by_event[event_id], results_by_event[event_id])
        if not features:
            continue
        event = EventFeatures(
            event_id=event_id,
            session_id=int(row["session_id"]),
            timestamp=row["timestamp"],
            is_sidechain=bool(row["is_sidechain"]),
            agent_id=row["agent_id"],
            role=row["role"],
            input_tokens=int(row["input_tokens"] or 0),
            output_tokens=int(row["output_tokens"] or 0),
            features=features,
        )
        by_session[event.session_id].append(event)
    return by_session


def _features_for_event(
    row: sqlite3.Row,
    calls: list[sqlite3.Row],
    results: list[sqlite3.Row],
) -> list[Feature]:
    event_id = int(row["event_id"])
    features: list[Feature] = []
    raw = _loads(row["raw_json"])
    event_type = str(row["event_type"] or "unknown")

    if event_type == "queue-operation":
        operation = str(raw.get("operation") or "unknown")
        features.append(Feature(event_id, f"EVENT:queue:{operation}", "event", {"operation": operation}))
    elif event_type == "attachment":
        attachment = raw.get("attachment") if isinstance(raw.get("attachment"), dict) else {}
        attachment_type = str(attachment.get("type") or "unknown")
        features.append(Feature(event_id, f"EVENT:attachment:{attachment_type}", "event", {"attachment_type": attachment_type}))
    elif event_type in {"system", "mode", "pr-link", "file-history-snapshot"}:
        features.append(Feature(event_id, f"EVENT:{event_type}", "event", {"event_type": event_type}))

    role = row["role"]
    text_preview = row["text_preview"]
    if role and text_preview:
        features.append(Feature(event_id, f"TEXT:{role}", "text", {"role": role}))

    for call in calls:
        symbol, family, attributes = _call_symbol(call)
        features.append(Feature(event_id, symbol, family, attributes))

    for result in results:
        symbol, family, attributes = _result_symbol(result)
        features.append(Feature(event_id, symbol, family, attributes))

    stop_reason = row["stop_reason"]
    if stop_reason:
        features.append(Feature(event_id, f"STOP:{stop_reason}", "stop", {"stop_reason": stop_reason}))

    return features


def _call_symbol(row: sqlite3.Row) -> tuple[str, str, dict[str, Any]]:
    tool_name = str(row["tool_name"] or "unknown")
    raw = _loads(row["raw_json"])
    input_obj = raw.get("input") if isinstance(raw.get("input"), dict) else {}
    attributes: dict[str, Any] = {"tool_name": tool_name}
    if isinstance(input_obj, dict):
        attributes["input_keys"] = sorted(str(key) for key in input_obj.keys())
        target = input_obj.get("file_path") or input_obj.get("path")
        if target:
            attributes["target"] = _short(str(target), 180)

    if tool_name in {"Bash", "PowerShell"}:
        command = str(input_obj.get("command") or row["input_preview"] or "")
        family = _command_family(command)
        attributes["command_family"] = family
        attributes["command_preview"] = _short(command, 260)
        return f"CALL:{tool_name}:{family}", "tool_call", attributes

    if tool_name in {"Read", "Grep", "Glob"}:
        return f"CALL:inspect:{tool_name}", "tool_call", attributes
    if tool_name in {"Edit", "Write", "MultiEdit", "NotebookEdit"}:
        return f"CALL:write:{tool_name}", "tool_call", attributes
    if tool_name == "Agent":
        subagent_type = input_obj.get("subagent_type") or input_obj.get("model")
        if subagent_type:
            attributes["subagent_type"] = str(subagent_type)
        return "CALL:Agent", "tool_call", attributes
    return f"CALL:{tool_name}", "tool_call", attributes


def _result_symbol(row: sqlite3.Row) -> tuple[str, str, dict[str, Any]]:
    output = str(row["output_preview"] or "")
    raw = _loads(row["raw_json"])
    if not output and isinstance(raw, dict):
        output = json.dumps(raw, ensure_ascii=False, sort_keys=True)
    is_error = bool(row["is_error"])
    attributes = {
        "is_error": is_error,
        "output_preview": _short(output, 260),
        "error_class": None,
    }
    if not is_error:
        return "RESULT:ok", "tool_result", attributes

    error_class = _error_class(output)
    attributes["error_class"] = error_class
    return f"RESULT:error:{error_class}", "tool_result", attributes


def _command_family(command: str) -> str:
    cmd = command.lower().strip()
    if not cmd:
        return "empty"
    if any(token in cmd for token in ["pytest", "vitest", "npm test", "pnpm test", "yarn test", "cargo test", "go test"]):
        return "test"
    if any(token in cmd for token in ["ruff", "mypy", "eslint", "tsc", "biome", "prettier --check"]):
        return "lint_typecheck"
    if any(token in cmd for token in ["npm run build", "pnpm build", "yarn build", "cargo build", "docker compose"]):
        return "build"
    if cmd.startswith("git ") or " git " in cmd:
        return "git"
    if any(token in cmd for token in ["npm install", "pnpm install", "yarn add", "uv add", "pip install"]):
        return "deps"
    if any(token in cmd for token in ["remove-item", " rm ", "rm -", " del ", " rmdir "]):
        return "delete"
    if any(token in cmd for token in ["curl ", "wget ", "invoke-webrequest", "webfetch"]):
        return "network"
    if "python" in cmd or "node " in cmd:
        return "script"
    if any(token in cmd for token in ["rg ", "grep ", "findstr", "select-string"]):
        return "search"
    if cmd in {"ls", "dir"} or any(token in cmd for token in ["get-childitem", " ls ", " dir "]):
        return "list"
    return "other"


def _error_class(output: str) -> str:
    low = output.lower()
    if "permission to use" in low and "denied" in low:
        return "permission_denied"
    if "denied by user" in low or "rejected" in low:
        return "user_rejected"
    if "file has not been read yet" in low:
        return "edit_without_read"
    if "file has been modified since read" in low:
        return "file_changed"
    if "inputvalidationerror" in low:
        return "validation"
    if "cancelled: parallel tool call" in low:
        return "parallel_cancel"
    if "timed out" in low or "timeout" in low:
        return "timeout"
    if "modulenotfounderror" in low or "module not found" in low:
        return "missing_module"
    if "exit code 126" in low or "exit code 127" in low or "command not found" in low:
        return "missing_command"
    if "exit code 128" in low:
        return "git"
    if "pytest" in low and (" failed" in low or "failures" in low):
        return "test_failure"
    if "exit code 2" in low:
        return "exit2"
    if "exit code 1" in low:
        return "exit1"
    return "unknown"


def _build_slices(events_by_session: dict[int, list[EventFeatures]]) -> list[Slice]:
    slices: list[Slice] = []
    for session_id, events in events_by_session.items():
        main_events = [event for event in events if not event.is_sidechain]
        if main_events:
            slices.append(_make_slice(session_id, "session_main", "main", main_events))
            slices.extend(_turn_slices(session_id, main_events))

        sidechain_by_agent: dict[str, list[EventFeatures]] = defaultdict(list)
        for event in events:
            if event.is_sidechain:
                sidechain_by_agent[event.agent_id or "sidechain"].append(event)
        for agent_id, agent_events in sidechain_by_agent.items():
            if agent_events:
                slices.append(_make_slice(session_id, "sidechain", agent_id, agent_events))
    return [entry for entry in slices if entry.features]


def _turn_slices(session_id: int, main_events: list[EventFeatures]) -> list[Slice]:
    starts = [index for index, event in enumerate(main_events) if event.role == "user"]
    if not starts:
        return []
    slices: list[Slice] = []
    for pos, start in enumerate(starts):
        end = starts[pos + 1] if pos + 1 < len(starts) else len(main_events)
        turn_events = main_events[start:end]
        if turn_events:
            slices.append(_make_slice(session_id, "turn", "main", turn_events))
    return slices


def _make_slice(session_id: int, kind: str, lane: str, events: list[EventFeatures]) -> Slice:
    features = [feature for event in events for feature in event.features]
    return Slice(
        id=None,
        session_id=session_id,
        kind=kind,
        lane=lane,
        events=events,
        features=features,
        outcome=_slice_outcome(events, features),
        duration_seconds=_duration_seconds(events),
    )


def _slice_outcome(events: list[EventFeatures], features: list[Feature]) -> str:
    symbols = [feature.symbol for feature in features]
    if any(symbol.endswith(":user_rejected") or symbol.endswith(":permission_denied") for symbol in symbols):
        return "rejected"
    if any(symbol.startswith("RESULT:error") for symbol in symbols):
        return "error"
    token_total = sum(event.input_tokens + event.output_tokens for event in events)
    if token_total >= HIGH_COST_TOKENS or len(features) >= 120 or _duration_seconds(events) >= HIGH_COST_DURATION:
        return "high_cost"
    return "clean"


def _duration_seconds(events: list[EventFeatures]) -> int:
    if not events:
        return 0
    timestamps = [_parse_ts(event.timestamp) for event in events if event.timestamp]
    timestamps = [ts for ts in timestamps if ts is not None]
    if len(timestamps) < 2:
        return 0
    return max(0, round((max(timestamps) - min(timestamps)).total_seconds()))


def _insert_slices_and_features(conn: sqlite3.Connection, slices: list[Slice]) -> None:
    for sequence in slices:
        cur = conn.execute(
            """
            INSERT INTO sequence_slices(
                session_id, kind, lane, start_event_id, end_event_id, outcome, length, duration_seconds
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                sequence.session_id,
                sequence.kind,
                sequence.lane,
                sequence.events[0].event_id if sequence.events else None,
                sequence.events[-1].event_id if sequence.events else None,
                sequence.outcome,
                len(sequence.features),
                sequence.duration_seconds,
            ),
        )
        sequence.id = int(cur.lastrowid)
        conn.executemany(
            """
            INSERT INTO event_features(
                event_id, session_id, sequence_slice_id, position, symbol, family, attributes_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    feature.event_id,
                    sequence.session_id,
                    sequence.id,
                    position,
                    feature.symbol,
                    feature.family,
                    json.dumps(feature.attributes, ensure_ascii=False, sort_keys=True),
                )
                for position, feature in enumerate(sequence.features)
            ],
        )


def _mine_patterns(
    slices: list[Slice],
) -> tuple[list[PatternStats], dict[tuple[str, tuple[str, ...]], list[tuple[Slice, int, int]]]]:
    by_kind: dict[str, list[Slice]] = defaultdict(list)
    for sequence in slices:
        by_kind[sequence.kind].append(sequence)

    all_patterns: list[PatternStats] = []
    occurrences: dict[tuple[str, tuple[str, ...]], list[tuple[Slice, int, int]]] = defaultdict(list)

    for kind, kind_slices in by_kind.items():
        total = len(kind_slices)
        positive_total = sum(1 for sequence in kind_slices if sequence.outcome != "clean")
        support_by_pattern: dict[tuple[str, ...], set[int]] = defaultdict(set)
        positive_by_pattern: dict[tuple[str, ...], set[int]] = defaultdict(set)
        first_occurrence: dict[tuple[int, tuple[str, ...]], tuple[int, int]] = {}

        for index, sequence in enumerate(kind_slices):
            symbols = [feature.symbol for feature in sequence.features]
            for size in range(2, MAX_PATTERN_LEN + 1):
                if len(symbols) < size:
                    continue
                for start in range(0, len(symbols) - size + 1):
                    pattern = tuple(symbols[start:start + size])
                    if _skip_pattern(pattern):
                        continue
                    support_by_pattern[pattern].add(index)
                    if sequence.outcome != "clean":
                        positive_by_pattern[pattern].add(index)
                    first_occurrence.setdefault((index, pattern), (start, start + size - 1))

        for pattern, support_set in support_by_pattern.items():
            support = len(support_set)
            positive_support = len(positive_by_pattern.get(pattern, set()))
            negative_support = support - positive_support
            category, title, explanation = _classify_pattern(kind, pattern)
            if positive_support == 0:
                continue
            lift = _lift(positive_support, support, positive_total, total)
            if category is None and (support < MIN_PATTERN_SUPPORT or lift < MIN_LIFT):
                continue
            if category is None:
                category, title, explanation = _rare_pattern(pattern)
            score = _pattern_score(pattern, support, positive_support, lift, category)
            stats = PatternStats(
                pattern=pattern,
                kind=kind,
                support=support,
                positive_support=positive_support,
                negative_support=negative_support,
                lift=lift,
                score=score,
                category=category,
                title=title,
                explanation=explanation,
            )
            all_patterns.append(stats)
            for slice_index in positive_by_pattern.get(pattern, set()):
                start, end = first_occurrence[(slice_index, pattern)]
                occurrences[(kind, pattern)].append((kind_slices[slice_index], start, end))

    all_patterns.sort(key=lambda item: (-item.score, item.kind, item.pattern))
    return all_patterns, occurrences


def _skip_pattern(pattern: tuple[str, ...]) -> bool:
    return all(symbol.startswith("TEXT:") or symbol.startswith("STOP:") for symbol in pattern)


def _lift(positive_support: int, support: int, positive_total: int, total: int) -> float:
    if support <= 0 or total <= 0 or positive_total <= 0:
        return 0.0
    pattern_rate = positive_support / support
    base_rate = positive_total / total
    return pattern_rate / base_rate if base_rate > 0 else 0.0


def _classify_pattern(kind: str, pattern: tuple[str, ...]) -> tuple[str | None, str | None, str | None]:
    joined = " -> ".join(pattern)
    has_test = any(symbol.startswith(("CALL:Bash:test", "CALL:PowerShell:test")) for symbol in pattern)
    has_lint = any(symbol.startswith(("CALL:Bash:lint_typecheck", "CALL:PowerShell:lint_typecheck")) for symbol in pattern)
    has_write = any(symbol.startswith("CALL:write:") for symbol in pattern)
    has_agent = "CALL:Agent" in pattern
    has_error = any(symbol.startswith("RESULT:error") for symbol in pattern)

    if any(symbol.endswith(":edit_without_read") or symbol.endswith(":file_changed") for symbol in pattern):
        return (
            "unsafe_write_attempt",
            "Unsafe write attempt",
            f"Write/edit workflow hit a tool safety error: {joined}.",
        )
    if any(symbol.endswith(":permission_denied") or symbol.endswith(":user_rejected") for symbol in pattern):
        return (
            "permission_friction",
            "Permission friction",
            f"Tool use encountered denial or user rejection: {joined}.",
        )
    if any(symbol.endswith((":missing_module", ":missing_command", ":timeout", ":validation")) for symbol in pattern):
        return (
            "environment_mismatch",
            "Environment mismatch",
            f"Tool output indicates an environment, validation, or timeout failure: {joined}.",
        )
    if kind == "sidechain" and has_error:
        return (
            "subagent_failure_propagation",
            "Subagent failure pattern",
            f"A subagent sequence contains an error-bearing motif: {joined}.",
        )
    if has_agent and has_error:
        return (
            "subagent_failure_propagation",
            "Delegation failure pattern",
            f"Delegation is adjacent to an error-bearing motif: {joined}.",
        )
    if (has_test or has_lint) and has_error:
        return (
            "failed_verification_repair_loop",
            "Failed verification",
            f"Verification tooling produced an error-bearing sequence: {joined}.",
        )
    if has_write and any(symbol.startswith("RESULT:error:exit") or symbol.endswith(":test_failure") for symbol in pattern):
        return (
            "failed_verification_repair_loop",
            "Repair after failed verification",
            f"A write/edit action is adjacent to a failed verification result: {joined}.",
        )
    if any(symbol.endswith(":parallel_cancel") for symbol in pattern):
        return (
            "environment_mismatch",
            "Parallel tool cancellation",
            f"Parallel tool execution produced a cancellation motif: {joined}.",
        )
    return None, None, None


def _rare_pattern(pattern: tuple[str, ...]) -> tuple[str, str, str]:
    joined = " -> ".join(pattern)
    return (
        "rare_workflow_deviation",
        "Rare risky workflow",
        f"This risky sequence is uncommon compared with the local cache baseline: {joined}.",
    )


def _pattern_score(
    pattern: tuple[str, ...],
    support: int,
    positive_support: int,
    lift: float,
    category: str | None,
) -> float:
    category_weight = {
        "unsafe_write_attempt": 2.5,
        "failed_verification_repair_loop": 2.2,
        "permission_friction": 2.0,
        "subagent_failure_propagation": 1.8,
        "environment_mismatch": 1.6,
        "rare_workflow_deviation": 1.2,
    }.get(category or "", 1.0)
    length_weight = 1 + (len(pattern) - 2) * 0.15
    support_weight = 1 + math.log1p(max(positive_support, support - 1)) * 0.3
    return round(category_weight * length_weight * support_weight * max(lift, 1.0), 3)


def _insert_patterns(conn: sqlite3.Connection, patterns: list[PatternStats]) -> dict[tuple[str, tuple[str, ...]], int]:
    pattern_ids: dict[tuple[str, tuple[str, ...]], int] = {}
    for stats in patterns:
        cur = conn.execute(
            """
            INSERT INTO sequence_patterns(
                kind, pattern_json, support, positive_support, negative_support,
                lift, score, label, explanation
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                stats.kind,
                json.dumps(list(stats.pattern), ensure_ascii=False),
                stats.support,
                stats.positive_support,
                stats.negative_support,
                stats.lift,
                stats.score,
                stats.category,
                stats.explanation,
            ),
        )
        pattern_ids[(stats.kind, stats.pattern)] = int(cur.lastrowid)
    return pattern_ids


def _insert_hits_and_findings(
    conn: sqlite3.Connection,
    slices: list[Slice],
    patterns: list[PatternStats],
    occurrences: dict[tuple[str, tuple[str, ...]], list[tuple[Slice, int, int]]],
    pattern_ids: dict[tuple[str, tuple[str, ...]], int],
) -> None:
    _ = slices
    finding_keys: set[tuple[int, int]] = set()
    for stats in patterns:
        pattern_id = pattern_ids[(stats.kind, stats.pattern)]
        for sequence, start, end in occurrences.get((stats.kind, stats.pattern), []):
            if sequence.id is None:
                continue
            start_feature = sequence.features[start]
            end_feature = sequence.features[end]
            evidence = {
                "sequence_kind": sequence.kind,
                "lane": sequence.lane,
                "outcome": sequence.outcome,
                "start_position": start,
                "end_position": end,
                "symbols": list(stats.pattern),
            }
            conn.execute(
                """
                INSERT INTO pattern_hits(
                    pattern_id, session_id, sequence_slice_id, start_event_id, end_event_id, evidence_json
                )
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    pattern_id,
                    sequence.session_id,
                    sequence.id,
                    start_feature.event_id,
                    end_feature.event_id,
                    json.dumps(evidence, ensure_ascii=False, sort_keys=True),
                ),
            )
            if stats.category is None:
                continue
            finding_key = (sequence.session_id, pattern_id)
            if finding_key in finding_keys:
                continue
            finding_keys.add(finding_key)
            conn.execute(
                """
                INSERT INTO risk_findings(
                    session_id, severity, category, title, explanation,
                    pattern_id, start_event_id, end_event_id, score, evidence_json
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    sequence.session_id,
                    _severity(stats.score, stats.category),
                    stats.category,
                    stats.title or "Risk pattern",
                    stats.explanation or "Risk-bearing sequence detected.",
                    pattern_id,
                    start_feature.event_id,
                    end_feature.event_id,
                    stats.score,
                    json.dumps(evidence, ensure_ascii=False, sort_keys=True),
                ),
            )


def _insert_heuristic_findings(conn: sqlite3.Connection, session_ids: list[int] | None = None) -> None:
    session_ids = sorted(set(session_ids)) if session_ids is not None else None
    session_filter = ""
    session_params: list[int] = []
    if session_ids is not None:
        if not session_ids:
            return
        session_filter = f"WHERE s.id IN ({','.join('?' * len(session_ids))})"
        session_params = session_ids

    rows = conn.execute(
        f"""
        SELECT
            s.id AS session_id,
            ss.event_count,
            ss.subagent_count,
            ss.input_tokens,
            ss.output_tokens,
            CAST(ROUND(COALESCE((julianday(s.last_ts) - julianday(s.first_ts)) * 86400, 0)) AS INTEGER)
                AS duration_seconds,
            COALESCE((SELECT MAX(event_count) FROM subagents WHERE parent_session_id = s.id), 0)
                AS max_agent_events,
            (SELECT MIN(id) FROM events WHERE session_id = s.id) AS start_event_id,
            (SELECT MAX(id) FROM events WHERE session_id = s.id) AS end_event_id
        FROM sessions s
        JOIN session_stats ss ON ss.session_id = s.id
        {session_filter}
        """,
        session_params,
    ).fetchall()
    for row in rows:
        token_total = int(row["input_tokens"] or 0) + int(row["output_tokens"] or 0)
        if int(row["subagent_count"] or 0) >= FANOUT_SUBAGENTS or int(row["max_agent_events"] or 0) >= FANOUT_AGENT_EVENTS:
            _insert_heuristic_finding(
                conn,
                int(row["session_id"]),
                "fanout_overload",
                "Fanout overload",
                "Session fanout is high relative to the local investigation baseline.",
                ["HEURISTIC:fanout_overload"],
                2.2,
                row["start_event_id"],
                row["end_event_id"],
                {"subagent_count": row["subagent_count"], "max_agent_events": row["max_agent_events"]},
            )
        if (
            token_total >= HIGH_COST_TOKENS
            or int(row["event_count"] or 0) >= HIGH_COST_EVENTS
            or int(row["duration_seconds"] or 0) >= HIGH_COST_DURATION
        ):
            _insert_heuristic_finding(
                conn,
                int(row["session_id"]),
                "cost_context_blowup",
                "Cost/context blowup",
                "Session size, duration, or token usage is high enough to deserve review.",
                ["HEURISTIC:cost_context_blowup"],
                1.8,
                row["start_event_id"],
                row["end_event_id"],
                {
                    "event_count": row["event_count"],
                    "duration_seconds": row["duration_seconds"],
                    "token_total": token_total,
                },
            )


def _insert_heuristic_finding(
    conn: sqlite3.Connection,
    session_id: int,
    category: str,
    title: str,
    explanation: str,
    pattern: list[str],
    score: float,
    start_event_id: int | None,
    end_event_id: int | None,
    evidence: dict[str, Any],
) -> None:
    cur = conn.execute(
        """
        INSERT INTO sequence_patterns(
            kind, pattern_json, support, positive_support, negative_support,
            lift, score, label, explanation
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "session_heuristic",
            json.dumps(pattern, ensure_ascii=False),
            1,
            1,
            0,
            1.0,
            score,
            category,
            explanation,
        ),
    )
    pattern_id = int(cur.lastrowid)
    conn.execute(
        """
        INSERT INTO risk_findings(
            session_id, severity, category, title, explanation,
            pattern_id, start_event_id, end_event_id, score, evidence_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            session_id,
            _severity(score, category),
            category,
            title,
            explanation,
            pattern_id,
            start_event_id,
            end_event_id,
            score,
            json.dumps(evidence, ensure_ascii=False, sort_keys=True),
        ),
    )


def _severity(score: float, category: str | None) -> str:
    if category in {"unsafe_write_attempt", "failed_verification_repair_loop"} and score >= 3.5:
        return "high"
    if score >= 4.5:
        return "high"
    if score >= 2:
        return "medium"
    return "low"


def _loads(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not value:
        return {}
    try:
        loaded = json.loads(str(value))
    except json.JSONDecodeError:
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _short(value: str, limit: int) -> str:
    value = re.sub(r"\s+", " ", value).strip()
    if len(value) <= limit:
        return value
    return value[: limit - 3] + "..."


def _parse_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        normalized = value.replace("Z", "+00:00")
        return datetime.fromisoformat(normalized)
    except ValueError:
        return None
