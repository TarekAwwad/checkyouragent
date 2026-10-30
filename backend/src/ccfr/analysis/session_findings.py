from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from dataclasses import dataclass
from typing import Any, Iterable


LARGE_TOOL_RESULT_THRESHOLD_BYTES = 1_000_000

_ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
_WHITESPACE_RE = re.compile(r"\s+")

_TIMEOUT_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("timed_out", re.compile(r"\btimed?\s+out\b", re.IGNORECASE)),
    ("deadline_exceeded", re.compile(r"\bdeadline exceeded\b", re.IGNORECASE)),
    ("etimedout", re.compile(r"\betimedout\b", re.IGNORECASE)),
    (
        "timeout_after",
        re.compile(r"\btimeout(?: error)?\s+(?:after|while|waiting|reached|exceeded)\b", re.IGNORECASE),
    ),
)

_MISSING_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "module_not_found",
        re.compile(
            r"\b(?:modulenotfounderror\s*:\s*)?no module named\s+['\"]?[^'\"\s]+|"
            r"\bcannot find module\s+['\"]?[^'\"\s]+|\berr_module_not_found\b",
            re.IGNORECASE,
        ),
    ),
    (
        "command_not_found",
        re.compile(
            r"\bcommand not found\b|\bis not recognized as an internal or external command\b",
            re.IGNORECASE,
        ),
    ),
)

_PERMISSION_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("permission_denied", re.compile(r"\bpermission denied\b", re.IGNORECASE)),
    ("operation_not_permitted", re.compile(r"\boperation not permitted\b", re.IGNORECASE)),
    ("access_denied", re.compile(r"\baccess is denied\b", re.IGNORECASE)),
    ("eacces", re.compile(r"\beacces\b", re.IGNORECASE)),
    ("eperm", re.compile(r"\beperm\b", re.IGNORECASE)),
    (
        "user_rejected",
        re.compile(
            r"\b(?:user rejected (?:the )?tool use|tool use was rejected|permission (?:request )?(?:was )?rejected)\b",
            re.IGNORECASE,
        ),
    ),
)


@dataclass(frozen=True)
class SessionFinding:
    session_id: int
    finding_key: str
    detector_key: str
    basis: str
    category: str
    title: str
    explanation: str
    recommendation: str | None
    start_event_id: int | None
    end_event_id: int | None
    evidence: dict[str, Any]


@dataclass(frozen=True)
class _ToolCall:
    event_id: int
    tool_use_id: str | None
    tool_name: str
    arguments: Any


@dataclass(frozen=True)
class _ToolReceipt:
    session_id: int
    result_id: int
    result_event_id: int
    tool_use_id: str | None
    is_error: bool
    output: str
    persisted_output_id: int | None
    persisted_size_bytes: int | None
    call: _ToolCall | None


def normalize_tool_name(value: str | None) -> str:
    return _WHITESPACE_RE.sub(" ", str(value or "")).strip().casefold()


def _normalize_argument_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _normalize_argument_value(value[key]) for key in sorted(value, key=str)}
    if isinstance(value, list):
        return [_normalize_argument_value(item) for item in value]
    if isinstance(value, str):
        return _WHITESPACE_RE.sub(" ", value).strip()
    return value


def normalize_tool_arguments(value: Any) -> str:
    normalized = _normalize_argument_value(value)
    return json.dumps(normalized, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def normalize_failure_signature(value: str) -> str:
    without_ansi = _ANSI_ESCAPE_RE.sub("", value)
    return _WHITESPACE_RE.sub(" ", without_ansi).strip().casefold()


def _json_value(raw_json: str | None) -> Any:
    try:
        return json.loads(raw_json or "{}")
    except (json.JSONDecodeError, TypeError):
        return {}


def _tool_arguments(raw_json: str | None, input_preview: str | None) -> Any:
    raw = _json_value(raw_json)
    if isinstance(raw, dict) and "input" in raw:
        return raw["input"]
    preview = _json_value(input_preview)
    if preview != {} or str(input_preview or "").strip() in {"{}", "[]", "null"}:
        return preview
    return str(input_preview or "")


def _result_output(raw_json: str | None, output_preview: str | None) -> str:
    raw = _json_value(raw_json)
    if isinstance(raw, dict) and "content" in raw:
        content = raw["content"]
        if isinstance(content, str):
            return content
        if isinstance(content, dict) and content.get("_truncated") and "preview" in content:
            return str(content["preview"])
        return json.dumps(content, ensure_ascii=False, sort_keys=True)
    return str(output_preview or "")


def _rows_as_dicts(cursor: sqlite3.Cursor) -> list[dict[str, Any]]:
    names = [str(description[0]) for description in cursor.description or ()]
    return [dict(zip(names, row, strict=True)) for row in cursor.fetchall()]


def _load_receipts(conn: sqlite3.Connection, session_id: int) -> list[_ToolReceipt]:
    call_rows = _rows_as_dicts(
        conn.execute(
            """
            SELECT id, event_id, tool_use_id, tool_name, input_preview, raw_json
            FROM tool_calls
            WHERE session_id = ?
            ORDER BY event_id, id
            """,
            (session_id,),
        )
    )
    calls_by_use: dict[str, list[_ToolCall]] = {}
    for row in call_rows:
        tool_use_id = str(row["tool_use_id"]) if row["tool_use_id"] is not None else None
        call = _ToolCall(
            event_id=int(row["event_id"]),
            tool_use_id=tool_use_id,
            tool_name=str(row["tool_name"] or ""),
            arguments=_tool_arguments(row["raw_json"], row["input_preview"]),
        )
        if tool_use_id:
            calls_by_use.setdefault(tool_use_id, []).append(call)

    result_rows = _rows_as_dicts(
        conn.execute(
            """
            SELECT tr.id, tr.event_id, tr.tool_use_id, tr.is_error,
                   tr.output_preview, tr.persisted_output_id, tr.raw_json,
                   po.size_bytes AS persisted_size_bytes
            FROM tool_results tr
            LEFT JOIN persisted_outputs po ON po.id = tr.persisted_output_id
            WHERE tr.session_id = ?
            ORDER BY tr.event_id, tr.id
            """,
            (session_id,),
        )
    )
    receipts: list[_ToolReceipt] = []
    for row in result_rows:
        tool_use_id = str(row["tool_use_id"]) if row["tool_use_id"] is not None else None
        candidates = calls_by_use.get(tool_use_id or "", [])
        earlier = [call for call in candidates if call.event_id <= int(row["event_id"])]
        call = earlier[-1] if earlier else (candidates[-1] if candidates else None)
        receipts.append(
            _ToolReceipt(
                session_id=session_id,
                result_id=int(row["id"]),
                result_event_id=int(row["event_id"]),
                tool_use_id=tool_use_id,
                is_error=bool(row["is_error"]),
                output=_result_output(row["raw_json"], row["output_preview"]),
                persisted_output_id=(
                    int(row["persisted_output_id"])
                    if row["persisted_output_id"] is not None
                    else None
                ),
                persisted_size_bytes=(
                    int(row["persisted_size_bytes"])
                    if row["persisted_size_bytes"] is not None
                    else None
                ),
                call=call,
            )
        )
    return receipts


def _finding_key(detector_key: str, *parts: Any) -> str:
    payload = json.dumps(parts, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:20]
    return f"{detector_key}:{digest}"


def _match_type(
    value: str,
    patterns: Iterable[tuple[str, re.Pattern[str]]],
) -> str | None:
    for match_type, pattern in patterns:
        if pattern.search(value):
            return match_type
    return None


def _repeated_failure_findings(
    session_id: int,
    receipts: list[_ToolReceipt],
) -> list[SessionFinding]:
    findings: list[SessionFinding] = []
    segment: list[_ToolReceipt] = []

    def inspect_segment(failed_receipts: list[_ToolReceipt]) -> None:
        grouped: dict[tuple[str, str, str], list[_ToolReceipt]] = {}
        for receipt in failed_receipts:
            if receipt.call is None:
                continue
            tool_name = normalize_tool_name(receipt.call.tool_name)
            arguments = normalize_tool_arguments(receipt.call.arguments)
            signature = normalize_failure_signature(receipt.output)
            if not tool_name or not signature:
                continue
            grouped.setdefault((tool_name, arguments, signature), []).append(receipt)

        for (tool_name, arguments, signature), matches in grouped.items():
            if len(matches) < 2:
                continue
            first = matches[0]
            last = matches[-1]
            event_ids: list[int] = []
            for match in matches:
                if match.call is not None:
                    event_ids.append(match.call.event_id)
                event_ids.append(match.result_event_id)
            findings.append(
                SessionFinding(
                    session_id=session_id,
                    finding_key=_finding_key(
                        "repeated_identical_failure",
                        first.result_id,
                        last.result_id,
                        tool_name,
                        arguments,
                        signature,
                    ),
                    detector_key="repeated_identical_failure",
                    basis="observed",
                    category="execution",
                    title="Repeated identical tool failure",
                    explanation=(
                        f"{matches[0].call.tool_name.strip() or 'Tool'} returned the same observed "
                        f"failure {len(matches)} times with unchanged arguments and no intervening "
                        "successful tool result."
                    ),
                    recommendation=None,
                    start_event_id=first.result_event_id,
                    end_event_id=last.result_event_id,
                    evidence={
                        "event_ids": event_ids,
                        "occurrence_count": len(matches),
                        "normalized_tool_name": tool_name,
                        "normalized_arguments": arguments,
                        "failure_signature": signature,
                    },
                )
            )

    for receipt in receipts:
        if receipt.is_error:
            segment.append(receipt)
            continue
        inspect_segment(segment)
        segment = []
    inspect_segment(segment)
    return findings


def _observed_error_findings(
    session_id: int,
    receipts: list[_ToolReceipt],
    *,
    detector_key: str,
    patterns: tuple[tuple[str, re.Pattern[str]], ...],
    category: str,
    title: str,
    explanation: str,
) -> list[SessionFinding]:
    findings: list[SessionFinding] = []
    for receipt in receipts:
        if not receipt.is_error:
            continue
        signature = normalize_failure_signature(receipt.output)
        match_type = _match_type(signature, patterns)
        if match_type is None:
            continue
        tool_name = receipt.call.tool_name.strip() if receipt.call else "Tool"
        findings.append(
            SessionFinding(
                session_id=session_id,
                finding_key=_finding_key(detector_key, receipt.result_id, match_type),
                detector_key=detector_key,
                basis="observed",
                category=category,
                title=title,
                explanation=f"{tool_name or 'Tool'} {explanation}",
                recommendation=None,
                start_event_id=receipt.result_event_id,
                end_event_id=receipt.result_event_id,
                evidence={
                    "event_ids": [receipt.result_event_id],
                    "match_type": match_type,
                    "tool_name": tool_name or "Tool",
                    "failure_signature": signature,
                },
            )
        )
    return findings


def _large_tool_result_findings(
    session_id: int,
    receipts: list[_ToolReceipt],
) -> list[SessionFinding]:
    findings: list[SessionFinding] = []
    for receipt in receipts:
        size = receipt.persisted_size_bytes
        if size is None or size < LARGE_TOOL_RESULT_THRESHOLD_BYTES:
            continue
        tool_name = receipt.call.tool_name.strip() if receipt.call else "Tool"
        findings.append(
            SessionFinding(
                session_id=session_id,
                finding_key=_finding_key("large_tool_result", receipt.result_id, size),
                detector_key="large_tool_result",
                basis="estimated",
                category="context",
                title="Large persisted tool result",
                explanation=(
                    f"{tool_name or 'Tool'} produced an observed persisted output of "
                    f"{size:,} bytes; its context impact depends on how much is later inspected."
                ),
                recommendation=None,
                start_event_id=receipt.result_event_id,
                end_event_id=receipt.result_event_id,
                evidence={
                    "event_ids": [receipt.result_event_id],
                    "observed_size_bytes": size,
                    "threshold_bytes": LARGE_TOOL_RESULT_THRESHOLD_BYTES,
                    "persisted_output_id": receipt.persisted_output_id,
                    "tool_name": tool_name or "Tool",
                },
            )
        )
    return findings


def detect_session_findings(conn: sqlite3.Connection, session_id: int) -> list[SessionFinding]:
    receipts = _load_receipts(conn, session_id)
    detected: list[SessionFinding] = []
    detected.extend(_repeated_failure_findings(session_id, receipts))
    detected.extend(
        _observed_error_findings(
            session_id,
            receipts,
            detector_key="timeout",
            patterns=_TIMEOUT_PATTERNS,
            category="execution",
            title="Tool call timed out",
            explanation="produced an observed timeout error.",
        )
    )
    detected.extend(
        _observed_error_findings(
            session_id,
            receipts,
            detector_key="missing_dependency_or_command",
            patterns=_MISSING_PATTERNS,
            category="environment",
            title="Missing dependency or command",
            explanation="reported a missing dependency or command.",
        )
    )
    detected.extend(
        _observed_error_findings(
            session_id,
            receipts,
            detector_key="permission_rejected",
            patterns=_PERMISSION_PATTERNS,
            category="permissions",
            title="Permission rejected",
            explanation="reported an explicit permission rejection.",
        )
    )
    detected.extend(_large_tool_result_findings(session_id, receipts))
    return detected


def rebuild_session_findings(
    conn: sqlite3.Connection,
    session_ids: list[int] | None = None,
) -> None:
    if session_ids is None:
        target_ids = [int(row[0]) for row in conn.execute("SELECT id FROM sessions ORDER BY id")]
    else:
        target_ids = sorted(set(int(session_id) for session_id in session_ids))
    if not target_ids:
        return

    placeholders = ",".join("?" * len(target_ids))
    conn.execute(
        f"DELETE FROM session_findings WHERE session_id IN ({placeholders})",
        target_ids,
    )
    for session_id in target_ids:
        for finding in detect_session_findings(conn, session_id):
            conn.execute(
                """
                INSERT INTO session_findings(
                    session_id, finding_key, detector_key, basis, category, title,
                    explanation, recommendation, start_event_id, end_event_id, evidence_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    finding.session_id,
                    finding.finding_key,
                    finding.detector_key,
                    finding.basis,
                    finding.category,
                    finding.title,
                    finding.explanation,
                    finding.recommendation,
                    finding.start_event_id,
                    finding.end_event_id,
                    json.dumps(
                        finding.evidence,
                        ensure_ascii=False,
                        sort_keys=True,
                        separators=(",", ":"),
                    ),
                ),
            )
