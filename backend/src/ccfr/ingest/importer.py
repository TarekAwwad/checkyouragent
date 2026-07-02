from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from ccfr.analysis.metrics import compute_loop_stats
from ccfr.analysis.risk_patterns import clear_risk_pattern_tables, rebuild_risk_patterns
from ccfr.storage.database import init_db


PERSISTED_RE = re.compile(r"Full output saved to:\s*(?P<path>.+?)(?:\r?\n|$)")
ProgressCallback = Callable[["ImportSummary", str], None]


@dataclass
class ImportSummary:
    import_id: int
    source_path: str
    project_count: int = 0
    session_count: int = 0
    event_count: int = 0
    subagent_count: int = 0
    memory_count: int = 0
    persisted_output_count: int = 0
    file_count: int = 0
    error_count: int = 0
    errors: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class DiscoveredProject:
    name: str
    imported: bool
    session_count: int
    last_imported_at: str | None
    stale: bool = False


@dataclass
class MessageUsageOwner:
    message_row_id: int
    input_tokens: int
    output_tokens: int

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens


def import_export(conn: sqlite3.Connection, source_root: Path) -> ImportSummary:
    """Backward-compatible: (re)build every project under the root, additively."""
    return import_all_new(conn, source_root, include_existing=True)


def import_all_new(
    conn: sqlite3.Connection,
    source_root: Path,
    *,
    include_existing: bool = False,
    progress_callback: ProgressCallback | None = None,
) -> ImportSummary:
    source_root = _validate_root(source_root)
    _prepare_conn(conn)
    file_count = sum(1 for p in source_root.rglob("*") if p.is_file())
    import_id, summary = _create_import_row(conn, source_root, file_count)
    conn.commit()  # the imports row must survive a later project rollback
    _notify_progress(progress_callback, summary, "running")

    session_ids: list[int] = []
    project_ids: list[int] = []
    for project_dir in sorted(p for p in source_root.iterdir() if p.is_dir()):
        if not include_existing and not _project_needs_import(conn, project_dir):
            continue
        project_count_before = summary.project_count
        errors_before = len(summary.errors)
        try:
            pid, sids = _import_one_project(
                conn, import_id, source_root, project_dir, summary,
                progress_callback=progress_callback,
            )
            conn.commit()  # project is all-or-nothing: delete+rebuild in one txn
        except Exception as exc:  # a broken project must not poison the rest
            conn.rollback()
            # Restore pre-project truth: the rollback erased this project's rows,
            # including any import_errors it recorded along the way.
            summary.project_count = project_count_before
            del summary.errors[errors_before:]
            _record_error(conn, summary, project_dir.name, None, f"Project import failed: {exc}")
            conn.commit()
            continue
        project_ids.append(pid)
        session_ids.extend(sids)
        _notify_progress(progress_callback, summary, "importing")

    _finish_import_or_strand(
        conn, summary, import_id, session_ids, project_ids, progress_callback=progress_callback
    )
    return summary


def import_project(
    conn: sqlite3.Connection,
    source_root: Path,
    project_name: str,
    *,
    progress_callback: ProgressCallback | None = None,
) -> ImportSummary:
    source_root = _validate_root(source_root)
    project_dir = source_root / project_name
    if not project_dir.is_dir():
        raise FileNotFoundError(f"Project not found under import root: {project_name}")
    _prepare_conn(conn)
    file_count = sum(1 for p in project_dir.rglob("*") if p.is_file())
    import_id, summary = _create_import_row(conn, source_root, file_count)
    conn.commit()
    _notify_progress(progress_callback, summary, "running")

    project_ids: list[int] = []
    sids: list[int] = []
    project_count_before = summary.project_count
    errors_before = len(summary.errors)
    try:
        pid, sids = _import_one_project(
            conn, import_id, source_root, project_dir, summary,
            progress_callback=progress_callback,
        )
        conn.commit()
        project_ids = [pid]
    except Exception as exc:
        conn.rollback()
        # Restore pre-project truth: the rollback erased this project's rows,
        # including any import_errors it recorded along the way.
        summary.project_count = project_count_before
        del summary.errors[errors_before:]
        _record_error(conn, summary, project_dir.name, None, f"Project import failed: {exc}")
        conn.commit()
    _finish_import_or_strand(
        conn, summary, import_id, sids, project_ids, progress_callback=progress_callback
    )
    return summary


def discover_projects(conn: sqlite3.Connection, source_root: Path) -> list[DiscoveredProject]:
    source_root = _validate_root(source_root)
    init_db(conn)
    result: list[DiscoveredProject] = []
    for project_dir in sorted(p for p in source_root.iterdir() if p.is_dir()):
        row = conn.execute(
            """
            SELECT COUNT(DISTINCT s.id) AS session_count, MAX(i.imported_at) AS last_imported_at,
                   MAX(p.source_signature) AS source_signature
            FROM projects p
            LEFT JOIN sessions s ON s.project_id = p.id
            LEFT JOIN imports i ON i.id = p.import_id
            WHERE p.export_name = ?
            """,
            (project_dir.name,),
        ).fetchone()
        last_imported_at = row["last_imported_at"]
        imported = last_imported_at is not None
        stale = imported and row["source_signature"] != _project_source_signature(project_dir)
        result.append(
            DiscoveredProject(
                name=project_dir.name,
                imported=imported,
                session_count=int(row["session_count"] or 0),
                last_imported_at=last_imported_at,
                stale=stale,
            )
        )
    return result


def _validate_root(source_root: Path) -> Path:
    source_root = Path(source_root).resolve()
    if not source_root.exists():
        raise FileNotFoundError(f"Import root does not exist: {source_root}")
    if not source_root.is_dir():
        raise NotADirectoryError(f"Import root is not a directory: {source_root}")
    return source_root


def _prepare_conn(conn: sqlite3.Connection) -> None:
    # storage.connect() sets WAL. NORMAL keeps bulk inserts fast while a crash
    # mid-import can still roll back to the last per-project commit; the old
    # journal_mode=OFF setting could corrupt the whole DB on a failed import.
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA temp_store = MEMORY")
    init_db(conn)


def _create_import_row(conn: sqlite3.Connection, source_path: Path, file_count: int) -> tuple[int, ImportSummary]:
    imported_at = datetime.now(timezone.utc).isoformat()
    cur = conn.execute(
        "INSERT INTO imports(source_path, imported_at, file_count, status) VALUES (?, ?, ?, ?)",
        (str(source_path), imported_at, file_count, "running"),
    )
    import_id = int(cur.lastrowid)
    summary = ImportSummary(import_id=import_id, source_path=str(source_path), file_count=file_count)
    return import_id, summary


def _project_source_signature(project_dir: Path) -> str:
    """Fingerprint of the project's on-disk file set (relpath, size, mtime)."""
    digest = hashlib.sha256()
    for path in sorted(project_dir.rglob("*")):
        if not path.is_file():
            continue
        stat = path.stat()
        digest.update(
            f"{path.relative_to(project_dir).as_posix()}\0{stat.st_size}\0{stat.st_mtime_ns}\0".encode()
        )
    return digest.hexdigest()


def _project_needs_import(conn: sqlite3.Connection, project_dir: Path) -> bool:
    row = conn.execute(
        "SELECT source_signature FROM projects WHERE export_name = ? ORDER BY id DESC LIMIT 1",
        (project_dir.name,),
    ).fetchone()
    if row is None:
        return True
    # NULL signature (pre-migration DB) counts as changed: re-import once, self-heals.
    return row["source_signature"] != _project_source_signature(project_dir)


def _import_one_project(
    conn: sqlite3.Connection,
    import_id: int,
    source_root: Path,
    project_dir: Path,
    summary: ImportSummary,
    *,
    progress_callback: ProgressCallback | None = None,
) -> tuple[int, list[int]]:
    _delete_project_by_name(conn, project_dir.name)
    project_id = _insert_project(conn, import_id, project_dir.name)
    conn.execute(
        "UPDATE projects SET source_signature = ? WHERE id = ?",
        (_project_source_signature(project_dir), project_id),
    )
    summary.project_count += 1
    _notify_progress(progress_callback, summary, "importing")

    persisted_by_export_path = _index_persisted_outputs(conn, source_root, project_dir, project_id)
    _notify_progress(progress_callback, summary, "importing")
    message_usage_owner: dict[tuple[int, str], MessageUsageOwner] = {}

    for session_file in sorted(project_dir.glob("*.jsonl")):
        session_pk = _ensure_session(conn, project_id, session_file.stem)
        _parse_jsonl(
            conn, summary, source_root, session_file, session_pk,
            is_sidechain=False, persisted_by_export_path=persisted_by_export_path,
            message_usage_owner=message_usage_owner,
        )
        _notify_progress(progress_callback, summary, "importing")

    for session_dir in sorted(p for p in project_dir.iterdir() if p.is_dir() and _looks_like_uuid(p.name)):
        session_pk = _ensure_session(conn, project_id, session_dir.name)
        subagents_dir = session_dir / "subagents"
        if subagents_dir.exists():
            for meta_file in sorted(subagents_dir.glob("agent-*.meta.json")):
                _insert_subagent_meta(conn, summary, source_root, meta_file, session_pk)
                _notify_progress(progress_callback, summary, "importing")
            for agent_file in sorted(subagents_dir.glob("agent-*.jsonl")):
                agent_id = agent_file.stem.removeprefix("agent-")
                _parse_jsonl(
                    conn, summary, source_root, agent_file, session_pk,
                    is_sidechain=True, agent_id=agent_id, persisted_by_export_path=persisted_by_export_path,
                    message_usage_owner=message_usage_owner,
                )
                _notify_progress(progress_callback, summary, "importing")

    memory_dir = project_dir / "memory"
    if memory_dir.exists():
        for memory_file in sorted(memory_dir.glob("*.md")):
            _insert_memory(conn, summary, source_root, memory_file, project_id)
            _notify_progress(progress_callback, summary, "importing")

    session_ids = [int(r["id"]) for r in conn.execute(
        "SELECT id FROM sessions WHERE project_id = ?", (project_id,)
    ).fetchall()]
    return project_id, session_ids


def _delete_project_by_name(conn: sqlite3.Connection, export_name: str) -> None:
    row = conn.execute("SELECT id FROM projects WHERE export_name = ?", (export_name,)).fetchone()
    if row is None:
        return
    project_id = int(row["id"])
    session_ids = [int(r["id"]) for r in conn.execute(
        "SELECT id FROM sessions WHERE project_id = ?", (project_id,)
    ).fetchall()]
    if session_ids:
        clear_risk_pattern_tables(conn, session_ids=session_ids)
        sp = ",".join("?" * len(session_ids))
        conn.execute(
            f"""DELETE FROM content_blocks WHERE message_id IN (
                    SELECT m.id FROM messages m JOIN events e ON e.id = m.event_id
                    WHERE e.session_id IN ({sp}))""",
            session_ids,
        )
        conn.execute(
            f"""DELETE FROM messages WHERE event_id IN (
                    SELECT id FROM events WHERE session_id IN ({sp}))""",
            session_ids,
        )
        for table, col in [
            ("event_edges", "session_id"),
            ("tool_calls", "session_id"),
            ("tool_results", "session_id"),
            ("persisted_outputs", "session_id"),
            ("subagents", "parent_session_id"),
            ("session_stats", "session_id"),
            ("events", "session_id"),
        ]:
            conn.execute(f"DELETE FROM {table} WHERE {col} IN ({sp})", session_ids)
    conn.execute("DELETE FROM memory_nodes WHERE project_id = ?", (project_id,))
    conn.execute("DELETE FROM search_index WHERE project_id = ?", (project_id,))
    conn.execute("DELETE FROM sessions WHERE project_id = ?", (project_id,))
    conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))


def _finalize_import(
    conn: sqlite3.Connection,
    summary: ImportSummary,
    import_id: int,
    session_ids: list[int],
    project_ids: list[int],
    *,
    progress_callback: ProgressCallback | None = None,
) -> None:
    summary.session_count = len(session_ids)
    if session_ids:
        sp = ",".join("?" * len(session_ids))
        summary.event_count = int(conn.execute(
            f"SELECT COUNT(*) FROM events WHERE session_id IN ({sp})", session_ids).fetchone()[0])
        summary.subagent_count = int(conn.execute(
            f"SELECT COUNT(*) FROM subagents WHERE parent_session_id IN ({sp})", session_ids).fetchone()[0])
        summary.persisted_output_count = int(conn.execute(
            f"SELECT COUNT(*) FROM persisted_outputs WHERE session_id IN ({sp})", session_ids).fetchone()[0])
    if project_ids:
        pp = ",".join("?" * len(project_ids))
        summary.memory_count = int(conn.execute(
            f"SELECT COUNT(*) FROM memory_nodes WHERE project_id IN ({pp})", project_ids).fetchone()[0])
    summary.error_count = len(summary.errors)
    status = "completed_with_errors" if summary.errors else "completed"
    conn.execute(
        "UPDATE imports SET status = ?, error_count = ? WHERE id = ?",
        (status, summary.error_count, import_id),
    )
    conn.commit()
    _notify_progress(progress_callback, summary, status)


def _finish_import_or_strand(
    conn: sqlite3.Connection,
    summary: ImportSummary,
    import_id: int,
    session_ids: list[int],
    project_ids: list[int],
    *,
    progress_callback: ProgressCallback | None = None,
) -> None:
    """Run the rebuild/finalize tail, guarding against stranding projects.

    Each project above is committed WITH its fresh source_signature before we get
    here. If _rebuild_derived/_finalize_import then raises, those signatures
    already match what's on disk, so the next import_all_new() run's skip check
    (_project_needs_import) would treat these projects as unchanged and never
    retry them — even though their derived tables (event_edges, session_stats,
    search_index, risk_findings/patterns) never got rebuilt. Roll back any
    partial derived writes, null the signatures so the projects are re-imported
    on the next run, and mark the import failed before re-raising so callers
    (e.g. the API route) see the failure instead of a silently-stuck "running" row.
    """
    try:
        _notify_progress(progress_callback, summary, "rebuilding")
        _rebuild_derived(conn, session_ids, project_ids)
        _finalize_import(conn, summary, import_id, session_ids, project_ids, progress_callback=progress_callback)
    except Exception:
        conn.rollback()
        if project_ids:
            sp = ",".join("?" * len(project_ids))
            conn.execute(f"UPDATE projects SET source_signature = NULL WHERE id IN ({sp})", project_ids)
        conn.execute(
            "UPDATE imports SET status = 'failed', error_count = ? WHERE id = ?",
            (len(summary.errors), import_id),
        )
        conn.commit()
        raise


def _notify_progress(
    progress_callback: ProgressCallback | None,
    summary: ImportSummary,
    status: str,
) -> None:
    if progress_callback is not None:
        progress_callback(summary, status)


def _rebuild_derived(conn: sqlite3.Connection, session_ids: list[int], project_ids: list[int]) -> None:
    _build_edges(conn, session_ids)
    _refresh_subagent_stats(conn, session_ids)
    _refresh_session_stats(conn, session_ids)
    _refresh_project_cwd(conn, project_ids)
    _populate_search(conn, project_ids)
    rebuild_risk_patterns(conn, session_ids=session_ids)


def _looks_like_uuid(value: str) -> bool:
    return bool(re.match(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", value, re.I))


def _rel(root: Path, path: Path) -> str:
    return str(path.resolve().relative_to(root)).replace("\\", "/")


def _shorten(value: Any, limit: int = 600) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        value = json.dumps(value, ensure_ascii=False, sort_keys=True)
    value = re.sub(r"\s+", " ", value).strip()
    if len(value) <= limit:
        return value
    return value[: limit - 1] + "…"


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _insert_project(conn: sqlite3.Connection, import_id: int, export_name: str) -> int:
    cur = conn.execute(
        "INSERT INTO projects(import_id, export_name) VALUES (?, ?)",
        (import_id, export_name),
    )
    return int(cur.lastrowid)


def _ensure_session(conn: sqlite3.Connection, project_id: int, session_id: str) -> int:
    row = conn.execute(
        "SELECT id FROM sessions WHERE project_id = ? AND session_id = ?",
        (project_id, session_id),
    ).fetchone()
    if row:
        return int(row["id"])
    cur = conn.execute(
        "INSERT INTO sessions(project_id, session_id) VALUES (?, ?)",
        (project_id, session_id),
    )
    return int(cur.lastrowid)


def _parse_jsonl(
    conn: sqlite3.Connection,
    summary: ImportSummary,
    root: Path,
    path: Path,
    session_pk: int,
    *,
    is_sidechain: bool,
    persisted_by_export_path: dict[str, int],
    message_usage_owner: dict[tuple[int, str], MessageUsageOwner],
    agent_id: str | None = None,
) -> None:
    rel_path = _rel(root, path)
    with path.open("r", encoding="utf-8", errors="replace") as fh:
        for line_no, line in enumerate(fh, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as exc:
                _record_error(conn, summary, rel_path, line_no, f"Invalid JSONL: {exc}")
                continue
            if not isinstance(obj, dict):
                _record_error(conn, summary, rel_path, line_no, "Invalid JSONL: line is not a JSON object")
                continue
            event_id = _insert_event(conn, session_pk, rel_path, line_no, obj, is_sidechain, agent_id)
            _update_session_from_event(conn, session_pk, obj)
            _insert_message_content(conn, session_pk, event_id, obj, persisted_by_export_path, message_usage_owner)


def _insert_event(
    conn: sqlite3.Connection,
    session_pk: int,
    source_path: str,
    line_no: int,
    obj: dict[str, Any],
    is_sidechain: bool,
    fallback_agent_id: str | None,
) -> int:
    agent_id = obj.get("agentId") or fallback_agent_id
    cur = conn.execute(
        """
        INSERT INTO events(
            session_id, source_path, line_no, uuid, parent_uuid, type, timestamp,
            is_sidechain, agent_id, raw_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            session_pk,
            source_path,
            line_no,
            obj.get("uuid"),
            obj.get("parentUuid"),
            obj.get("type") or "unknown",
            obj.get("timestamp"),
            1 if is_sidechain else 0,
            agent_id,
            _json(_compact_for_storage(obj)),
        ),
    )
    return int(cur.lastrowid)


def _update_session_from_event(conn: sqlite3.Connection, session_pk: int, obj: dict[str, Any]) -> None:
    timestamp = obj.get("timestamp")
    if timestamp:
        conn.execute(
            """
            UPDATE sessions
            SET first_ts = CASE WHEN first_ts IS NULL OR ? < first_ts THEN ? ELSE first_ts END,
                last_ts = CASE WHEN last_ts IS NULL OR ? > last_ts THEN ? ELSE last_ts END
            WHERE id = ?
            """,
            (timestamp, timestamp, timestamp, timestamp, session_pk),
        )
    if obj.get("cwd") or obj.get("version") or obj.get("entrypoint") or obj.get("gitBranch"):
        conn.execute(
            """
            UPDATE sessions
            SET cwd = COALESCE(cwd, ?),
                version = COALESCE(version, ?),
                entrypoint = COALESCE(entrypoint, ?),
                git_branch = COALESCE(git_branch, ?)
            WHERE id = ?
            """,
            (obj.get("cwd"), obj.get("version"), obj.get("entrypoint"), obj.get("gitBranch"), session_pk),
        )
    if obj.get("type") == "ai-title" and obj.get("aiTitle"):
        conn.execute("UPDATE sessions SET title = ? WHERE id = ?", (obj["aiTitle"], session_pk))


def _insert_message_content(
    conn: sqlite3.Connection,
    session_pk: int,
    event_id: int,
    obj: dict[str, Any],
    persisted_by_export_path: dict[str, int],
    message_usage_owner: dict[tuple[int, str], MessageUsageOwner],
) -> None:
    message = obj.get("message")
    if not isinstance(message, dict):
        if obj.get("type") in {"system", "attachment"}:
            _insert_non_message_searchable_content(conn, session_pk, event_id, obj, persisted_by_export_path)
        return

    usage = message.get("usage") if isinstance(message.get("usage"), dict) else {}
    # The bulk of input lives in the cache fields; the bare `input_tokens` is only the
    # uncached new tokens (often a handful). Sum all four so "input" reflects the real
    # context size the model processed (otherwise total ~= output). Keep each category
    # broken out so cost can be priced separately (cache hits are ~10x cheaper).
    base_input_tokens = int(usage.get("input_tokens") or 0)
    cache_read_tokens = int(usage.get("cache_read_input_tokens") or 0)
    cache_creation_total = int(usage.get("cache_creation_input_tokens") or 0)
    cache_creation = usage.get("cache_creation") if isinstance(usage.get("cache_creation"), dict) else {}
    cache_5m_tokens = int(cache_creation.get("ephemeral_5m_input_tokens") or 0)
    cache_1h_tokens = int(cache_creation.get("ephemeral_1h_input_tokens") or 0)
    # Older exports lack the 5m/1h split; attribute the whole creation total to 5m
    # (Claude Code's default ephemeral cache) so the categories still sum to input_tokens.
    if cache_5m_tokens == 0 and cache_1h_tokens == 0:
        cache_5m_tokens = cache_creation_total
    input_tokens = base_input_tokens + cache_5m_tokens + cache_1h_tokens + cache_read_tokens
    output_tokens = int(usage.get("output_tokens") or 0)
    raw_input_tokens = input_tokens
    raw_output_tokens = output_tokens
    message_usage_key = _message_usage_key(session_pk, message)
    previous_usage_owner = (
        message_usage_owner.get(message_usage_key)
        if message_usage_key is not None
        else None
    )
    replaces_previous_usage = False
    if previous_usage_owner is not None:
        current_total = raw_input_tokens + raw_output_tokens
        if current_total > previous_usage_owner.total_tokens:
            replaces_previous_usage = True
        else:
            input_tokens = 0
            output_tokens = 0
            base_input_tokens = 0
            cache_5m_tokens = 0
            cache_1h_tokens = 0
            cache_read_tokens = 0

    text_preview = _message_text_preview(message.get("content"))
    cur = conn.execute(
        """
        INSERT INTO messages(
            event_id, role, model, stop_reason, input_tokens, output_tokens,
            base_input_tokens, cache_5m_tokens, cache_1h_tokens, cache_read_tokens, text_preview
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            event_id,
            message.get("role"),
            message.get("model"),
            message.get("stop_reason"),
            input_tokens,
            output_tokens,
            base_input_tokens,
            cache_5m_tokens,
            cache_1h_tokens,
            cache_read_tokens,
            text_preview,
        ),
    )
    message_id = int(cur.lastrowid)
    if message_usage_key is not None and previous_usage_owner is None:
        message_usage_owner[message_usage_key] = MessageUsageOwner(
            message_row_id=message_id,
            input_tokens=raw_input_tokens,
            output_tokens=raw_output_tokens,
        )
    elif message_usage_key is not None and replaces_previous_usage:
        assert previous_usage_owner is not None
        conn.execute(
            """
            UPDATE messages
            SET input_tokens = 0, output_tokens = 0, base_input_tokens = 0,
                cache_5m_tokens = 0, cache_1h_tokens = 0, cache_read_tokens = 0
            WHERE id = ?
            """,
            (previous_usage_owner.message_row_id,),
        )
        message_usage_owner[message_usage_key] = MessageUsageOwner(
            message_row_id=message_id,
            input_tokens=raw_input_tokens,
            output_tokens=raw_output_tokens,
        )

    for block in _content_blocks(message.get("content")):
        _insert_content_block(conn, session_pk, event_id, message_id, block, persisted_by_export_path)

    if obj.get("toolUseResult") is not None:
        _insert_tool_use_result_object(conn, session_pk, event_id, obj["toolUseResult"])


def _insert_non_message_searchable_content(
    conn: sqlite3.Connection,
    session_pk: int,
    event_id: int,
    obj: dict[str, Any],
    persisted_by_export_path: dict[str, int],
) -> None:
    if obj.get("type") == "attachment" and isinstance(obj.get("attachment"), dict):
        attachment = obj["attachment"]
        content = _shorten(attachment.get("content") or attachment.get("stdout") or attachment.get("stderr"))
        cur = conn.execute(
            "INSERT INTO messages(event_id, role, text_preview) VALUES (?, ?, ?)",
            (event_id, "attachment", content),
        )
        message_id = int(cur.lastrowid)
        _insert_content_block(conn, session_pk, event_id, message_id, {"type": "attachment", "content": attachment}, persisted_by_export_path)


def _message_usage_key(session_pk: int, message: dict[str, Any]) -> tuple[int, str] | None:
    message_id = message.get("id")
    if not isinstance(message_id, str) or not message_id:
        return None
    return (session_pk, message_id)


def _content_blocks(content: Any) -> list[Any]:
    if content is None:
        return []
    if isinstance(content, list):
        return content
    return [content]


def _message_text_preview(content: Any) -> str:
    parts: list[str] = []
    for block in _content_blocks(content):
        if isinstance(block, str):
            parts.append(block)
        elif isinstance(block, dict):
            if block.get("type") == "text" and block.get("text"):
                parts.append(str(block["text"]))
            elif block.get("type") == "tool_result" and block.get("content"):
                parts.append(str(block["content"]))
            elif block.get("type") == "thinking" and block.get("thinking"):
                parts.append(str(block["thinking"]))
    return _shorten(" ".join(parts), 800)


def _insert_content_block(
    conn: sqlite3.Connection,
    session_pk: int,
    event_id: int,
    message_id: int,
    block: Any,
    persisted_by_export_path: dict[str, int],
) -> None:
    if isinstance(block, str):
        block_obj = {"type": "text", "text": block}
    elif isinstance(block, dict):
        block_obj = block
    else:
        block_obj = {"type": "unknown", "value": block}

    block_type = str(block_obj.get("type") or "unknown")
    tool_use_id = block_obj.get("id") if block_type == "tool_use" else block_obj.get("tool_use_id")
    tool_name = block_obj.get("name") if block_type == "tool_use" else None
    preview = _block_preview(block_obj)
    conn.execute(
        """
        INSERT INTO content_blocks(message_id, block_type, tool_use_id, tool_name, text_preview, raw_json)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (message_id, block_type, tool_use_id, tool_name, preview, _json(_compact_for_storage(block_obj))),
    )

    if block_type == "tool_use":
        conn.execute(
            """
            INSERT INTO tool_calls(event_id, session_id, tool_use_id, tool_name, input_preview, raw_json)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (event_id, session_pk, tool_use_id, tool_name, _shorten(block_obj.get("input")), _json(_compact_for_storage(block_obj))),
        )
    elif block_type == "tool_result":
        persisted_id = _find_persisted_id(str(block_obj.get("content") or ""), persisted_by_export_path)
        conn.execute(
            """
            INSERT INTO tool_results(event_id, session_id, tool_use_id, is_error, output_preview, persisted_output_id, raw_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                event_id,
                session_pk,
                tool_use_id,
                1 if block_obj.get("is_error") else 0,
                _shorten(block_obj.get("content"), 800),
                persisted_id,
                _json(_compact_for_storage(block_obj)),
            ),
        )


def _block_preview(block: dict[str, Any]) -> str:
    block_type = block.get("type")
    if block_type == "text":
        return _shorten(block.get("text"), 600)
    if block_type == "thinking":
        return _shorten(block.get("thinking"), 600)
    if block_type == "tool_use":
        return _shorten({"name": block.get("name"), "input": block.get("input")}, 600)
    if block_type == "tool_result":
        return _shorten(block.get("content"), 600)
    if block_type == "image":
        return "[image]"
    return _shorten(block, 600)


def _insert_tool_use_result_object(conn: sqlite3.Connection, session_pk: int, event_id: int, result: Any) -> None:
    text = _shorten(result, 800)
    if isinstance(result, dict):
        is_error = bool(result.get("is_error")) or bool(result.get("error"))
    else:
        is_error = False
    conn.execute(
        """
        INSERT INTO tool_results(event_id, session_id, is_error, output_preview, raw_json)
        VALUES (?, ?, ?, ?, ?)
        """,
        (event_id, session_pk, 1 if is_error else 0, text, _json(_compact_for_storage(result))),
    )


def _compact_for_storage(value: Any, *, string_limit: int = 4000) -> Any:
    if isinstance(value, str):
        if len(value) <= string_limit:
            return value
        return {
            "_truncated": True,
            "preview": value[:string_limit],
            "original_length": len(value),
        }
    if isinstance(value, list):
        return [_compact_for_storage(item, string_limit=string_limit) for item in value]
    if isinstance(value, dict):
        return {key: _compact_for_storage(item, string_limit=string_limit) for key, item in value.items()}
    return value


def _find_persisted_id(content: str, persisted_by_export_path: dict[str, int]) -> int | None:
    match = PERSISTED_RE.search(content)
    if not match:
        return None
    exported = match.group("path").strip()
    normalized = exported.replace("\\", "/")
    for key, persisted_id in persisted_by_export_path.items():
        if normalized.endswith(key):
            return persisted_id
    return None


def _index_persisted_outputs(
    conn: sqlite3.Connection,
    root: Path,
    project_dir: Path,
    project_id: int,
) -> dict[str, int]:
    by_export_path: dict[str, int] = {}
    for output in sorted(project_dir.glob("*/tool-results/*.txt")):
        session_id = output.parent.parent.name
        session_pk = _ensure_session(conn, project_id, session_id)
        first_line = ""
        try:
            with output.open("r", encoding="utf-8", errors="replace") as fh:
                first_line = _shorten(fh.readline(), 300)
        except OSError:
            first_line = ""
        rel_path = _rel(root, output)
        cur = conn.execute(
            """
            INSERT INTO persisted_outputs(session_id, path, size_bytes, first_line_preview)
            VALUES (?, ?, ?, ?)
            """,
            (session_pk, rel_path, output.stat().st_size, first_line),
        )
        by_export_path[rel_path] = int(cur.lastrowid)
    return by_export_path


def _insert_subagent_meta(
    conn: sqlite3.Connection,
    summary: ImportSummary,
    root: Path,
    meta_file: Path,
    session_pk: int,
) -> None:
    rel_path = _rel(root, meta_file)
    try:
        meta = json.loads(meta_file.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        _record_error(conn, summary, rel_path, None, f"Invalid subagent metadata: {exc}")
        return
    agent_id = meta_file.name.removeprefix("agent-").removesuffix(".meta.json")
    conn.execute(
        """
        INSERT INTO subagents(parent_session_id, agent_id, agent_type, description, name, tool_use_id)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(parent_session_id, agent_id) DO UPDATE SET
            agent_type = excluded.agent_type,
            description = excluded.description,
            name = excluded.name,
            tool_use_id = excluded.tool_use_id
        """,
        (
            session_pk,
            agent_id,
            meta.get("agentType"),
            meta.get("description"),
            meta.get("name"),
            meta.get("toolUseId"),
        ),
    )


def _insert_memory(
    conn: sqlite3.Connection,
    summary: ImportSummary,
    root: Path,
    memory_file: Path,
    project_id: int,
) -> None:
    rel_path = _rel(root, memory_file)
    try:
        text = memory_file.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        _record_error(conn, summary, rel_path, None, f"Could not read memory file: {exc}")
        return
    frontmatter, body = _parse_frontmatter(text)
    conn.execute(
        """
        INSERT INTO memory_nodes(project_id, path, name, type, description, origin_session_id, text_preview)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            project_id,
            rel_path,
            frontmatter.get("name") or memory_file.stem,
            frontmatter.get("type") or frontmatter.get("node_type"),
            frontmatter.get("description"),
            frontmatter.get("originSessionId"),
            _shorten(body or text, 800),
        ),
    )


def _parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, text
    meta: dict[str, str] = {}
    end = 0
    for idx, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            end = idx
            break
        if ":" in line and not line.startswith(" "):
            key, value = line.split(":", 1)
            meta[key.strip()] = value.strip().strip('"')
    body = "\n".join(lines[end + 1 :]) if end else text
    return meta, body


def _record_error(
    conn: sqlite3.Connection,
    summary: ImportSummary,
    path: str,
    line_no: int | None,
    message: str,
) -> None:
    summary.errors.append({"path": path, "line_no": line_no, "message": message})
    conn.execute(
        "INSERT INTO import_errors(import_id, path, line_no, message) VALUES (?, ?, ?, ?)",
        (summary.import_id, path, line_no, message),
    )


def _build_edges(conn: sqlite3.Connection, session_ids: list[int]) -> None:
    if not session_ids:
        return
    sp = ",".join("?" * len(session_ids))
    conn.execute(f"DELETE FROM event_edges WHERE session_id IN ({sp})", session_ids)
    rows = conn.execute(
        f"""
        SELECT child.session_id, parent.id AS source_id, child.id AS target_id
        FROM events child
        JOIN events parent ON parent.session_id = child.session_id AND parent.uuid = child.parent_uuid
        WHERE child.parent_uuid IS NOT NULL AND child.session_id IN ({sp})
        """,
        session_ids,
    ).fetchall()
    conn.executemany(
        "INSERT INTO event_edges(session_id, source_event_id, target_event_id, edge_type) VALUES (?, ?, ?, ?)",
        [(row["session_id"], row["source_id"], row["target_id"], "parent") for row in rows],
    )
    tool_rows = conn.execute(
        f"""
        SELECT tc.session_id, tc.event_id AS source_id, tr.event_id AS target_id
        FROM tool_calls tc
        JOIN tool_results tr ON tr.session_id = tc.session_id AND tr.tool_use_id = tc.tool_use_id
        WHERE tc.tool_use_id IS NOT NULL AND tc.session_id IN ({sp})
        """,
        session_ids,
    ).fetchall()
    conn.executemany(
        "INSERT INTO event_edges(session_id, source_event_id, target_event_id, edge_type) VALUES (?, ?, ?, ?)",
        [(row["session_id"], row["source_id"], row["target_id"], "tool_cycle") for row in tool_rows],
    )


def _refresh_subagent_stats(conn: sqlite3.Connection, session_ids: list[int]) -> None:
    if not session_ids:
        return
    sp = ",".join("?" * len(session_ids))
    rows = conn.execute(
        f"""
        SELECT session_id, agent_id, COUNT(*) AS event_count, MIN(timestamp) AS first_ts, MAX(timestamp) AS last_ts
        FROM events
        WHERE is_sidechain = 1 AND agent_id IS NOT NULL AND session_id IN ({sp})
        GROUP BY session_id, agent_id
        """,
        session_ids,
    ).fetchall()
    for row in rows:
        conn.execute(
            """
            UPDATE subagents
            SET event_count = ?, first_ts = ?, last_ts = ?
            WHERE parent_session_id = ? AND agent_id = ?
            """,
            (row["event_count"], row["first_ts"], row["last_ts"], row["session_id"], row["agent_id"]),
        )


def _refresh_session_stats(conn: sqlite3.Connection, session_ids: list[int]) -> None:
    if not session_ids:
        return
    sp = ",".join("?" * len(session_ids))
    sessions = conn.execute(f"SELECT id FROM sessions WHERE id IN ({sp})", session_ids).fetchall()
    for row in sessions:
        session_pk = int(row["id"])
        event_count = conn.execute("SELECT COUNT(*) FROM events WHERE session_id = ?", (session_pk,)).fetchone()[0]
        turn_count = conn.execute(
            """
            SELECT COUNT(*)
            FROM events e
            JOIN messages m ON m.event_id = e.id
            WHERE e.session_id = ? AND e.type = 'user' AND m.role = 'user'
            """,
            (session_pk,),
        ).fetchone()[0]
        tool_call_count = conn.execute("SELECT COUNT(*) FROM tool_calls WHERE session_id = ?", (session_pk,)).fetchone()[0]
        subagent_count = conn.execute("SELECT COUNT(*) FROM subagents WHERE parent_session_id = ?", (session_pk,)).fetchone()[0]
        error_count = conn.execute(
            """
            SELECT COUNT(*)
            FROM tool_results
            WHERE session_id = ? AND is_error = 1
            """,
            (session_pk,),
        ).fetchone()[0]
        system_count = conn.execute("SELECT COUNT(*) FROM events WHERE session_id = ? AND type = 'system'", (session_pk,)).fetchone()[0]
        persisted_output_count = conn.execute("SELECT COUNT(*) FROM persisted_outputs WHERE session_id = ?", (session_pk,)).fetchone()[0]
        tokens = conn.execute(
            """
            SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens
            FROM messages m
            JOIN events e ON e.id = m.event_id
            WHERE e.session_id = ?
            """,
            (session_pk,),
        ).fetchone()
        # Main-chain only: repeated tool calls inside sub-agents are a separate concern.
        tool_name_rows = conn.execute(
            """
            SELECT tc.tool_name
            FROM tool_calls tc
            JOIN events e ON e.id = tc.event_id
            WHERE tc.session_id = ? AND e.is_sidechain = 0
            ORDER BY COALESCE(e.timestamp, ''), e.id
            """,
            (session_pk,),
        ).fetchall()
        loop_count, max_repeat = compute_loop_stats([r["tool_name"] for r in tool_name_rows])
        conn.execute(
            """
            INSERT INTO session_stats(
                session_id, event_count, turn_count, tool_call_count, subagent_count,
                error_count, system_count, persisted_output_count, input_tokens, output_tokens,
                loop_count, max_repeat
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
                event_count = excluded.event_count,
                turn_count = excluded.turn_count,
                tool_call_count = excluded.tool_call_count,
                subagent_count = excluded.subagent_count,
                error_count = excluded.error_count,
                system_count = excluded.system_count,
                persisted_output_count = excluded.persisted_output_count,
                input_tokens = excluded.input_tokens,
                output_tokens = excluded.output_tokens,
                loop_count = excluded.loop_count,
                max_repeat = excluded.max_repeat
            """,
            (
                session_pk,
                event_count,
                turn_count,
                tool_call_count,
                subagent_count,
                error_count,
                system_count,
                persisted_output_count,
                int(tokens["input_tokens"]),
                int(tokens["output_tokens"]),
                loop_count,
                max_repeat,
            ),
        )


def _refresh_project_cwd(conn: sqlite3.Connection, project_ids: list[int]) -> None:
    if not project_ids:
        return
    pp = ",".join("?" * len(project_ids))
    rows = conn.execute(
        f"""
        SELECT p.id, (
            SELECT cwd FROM sessions s WHERE s.project_id = p.id AND s.cwd IS NOT NULL LIMIT 1
        ) AS cwd
        FROM projects p
        WHERE p.id IN ({pp})
        """,
        project_ids,
    ).fetchall()
    for row in rows:
        conn.execute("UPDATE projects SET inferred_cwd = ? WHERE id = ?", (row["cwd"], row["id"]))


def _populate_search(conn: sqlite3.Connection, project_ids: list[int]) -> None:
    if not project_ids:
        return
    pp = ",".join("?" * len(project_ids))
    conn.execute(f"DELETE FROM search_index WHERE project_id IN ({pp})", project_ids)

    session_rows = conn.execute(
        f"""
        SELECT s.id, s.project_id, s.title, s.session_id, s.cwd, s.git_branch,
               ss.event_count, ss.tool_call_count, ss.subagent_count
        FROM sessions s
        LEFT JOIN session_stats ss ON ss.session_id = s.id
        WHERE s.project_id IN ({pp})
        """,
        project_ids,
    ).fetchall()
    conn.executemany(
        "INSERT INTO search_index(kind, ref_id, project_id, session_id, title, body) VALUES (?, ?, ?, ?, ?, ?)",
        [
            (
                "session",
                row["id"],
                row["project_id"],
                row["id"],
                row["title"] or row["session_id"],
                _shorten(
                    {
                        "session_id": row["session_id"],
                        "cwd": row["cwd"],
                        "branch": row["git_branch"],
                        "events": row["event_count"],
                        "tools": row["tool_call_count"],
                        "subagents": row["subagent_count"],
                    },
                    1000,
                ),
            )
            for row in session_rows
        ],
    )
    message_rows = conn.execute(
        f"""
        SELECT e.id, e.session_id, s.project_id, m.role, m.text_preview
        FROM messages m
        JOIN events e ON e.id = m.event_id
        JOIN sessions s ON s.id = e.session_id
        WHERE s.project_id IN ({pp}) AND m.text_preview IS NOT NULL AND m.text_preview != ''
        """,
        project_ids,
    ).fetchall()
    conn.executemany(
        "INSERT INTO search_index(kind, ref_id, project_id, session_id, title, body) VALUES (?, ?, ?, ?, ?, ?)",
        [("message", row["id"], row["project_id"], row["session_id"], row["role"], row["text_preview"]) for row in message_rows],
    )
    tool_rows = conn.execute(
        f"""
        SELECT tc.event_id AS id, tc.session_id, s.project_id, tc.tool_name, tc.input_preview
        FROM tool_calls tc
        JOIN sessions s ON s.id = tc.session_id
        WHERE s.project_id IN ({pp})
        """,
        project_ids,
    ).fetchall()
    conn.executemany(
        "INSERT INTO search_index(kind, ref_id, project_id, session_id, title, body) VALUES (?, ?, ?, ?, ?, ?)",
        [("tool_call", row["id"], row["project_id"], row["session_id"], row["tool_name"], row["input_preview"]) for row in tool_rows],
    )
    subagent_rows = conn.execute(
        f"""
        SELECT sa.id, sa.parent_session_id, s.project_id, sa.agent_type, sa.description, sa.name
        FROM subagents sa
        JOIN sessions s ON s.id = sa.parent_session_id
        WHERE s.project_id IN ({pp})
        """,
        project_ids,
    ).fetchall()
    conn.executemany(
        "INSERT INTO search_index(kind, ref_id, project_id, session_id, title, body) VALUES (?, ?, ?, ?, ?, ?)",
        [
            (
                "subagent",
                row["id"],
                row["project_id"],
                row["parent_session_id"],
                row["agent_type"] or row["name"],
                row["description"] or "",
            )
            for row in subagent_rows
        ],
    )
    memory_rows = conn.execute(
        f"SELECT id, project_id, name, description, text_preview FROM memory_nodes WHERE project_id IN ({pp})",
        project_ids,
    ).fetchall()
    conn.executemany(
        "INSERT INTO search_index(kind, ref_id, project_id, session_id, title, body) VALUES (?, ?, ?, ?, ?, ?)",
        [("memory", row["id"], row["project_id"], None, row["name"], f"{row['description'] or ''} {row['text_preview'] or ''}") for row in memory_rows],
    )
