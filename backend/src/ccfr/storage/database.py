from __future__ import annotations

import json
import sqlite3
from pathlib import Path


SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_path TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    file_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    error_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id INTEGER NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
    export_name TEXT NOT NULL,
    inferred_cwd TEXT,
    source_signature TEXT
);

CREATE INDEX IF NOT EXISTS idx_projects_export_name ON projects(export_name);

CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    title TEXT,
    first_ts TEXT,
    last_ts TEXT,
    cwd TEXT,
    version TEXT,
    entrypoint TEXT,
    git_branch TEXT,
    UNIQUE(project_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions(project_id, id);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    source_path TEXT NOT NULL,
    line_no INTEGER NOT NULL,
    uuid TEXT,
    parent_uuid TEXT,
    type TEXT NOT NULL,
    timestamp TEXT,
    is_sidechain INTEGER NOT NULL DEFAULT 0,
    agent_id TEXT,
    raw_json TEXT NOT NULL,
    origin_session_id TEXT,
    is_replay INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_events_session_time ON events(session_id, timestamp, id);
CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id, id);
CREATE INDEX IF NOT EXISTS idx_events_timestamp_session ON events(timestamp, session_id, id);
CREATE INDEX IF NOT EXISTS idx_events_uuid ON events(uuid);
CREATE INDEX IF NOT EXISTS idx_events_parent_uuid ON events(parent_uuid);
CREATE INDEX IF NOT EXISTS idx_events_session_uuid ON events(session_id, uuid);
CREATE INDEX IF NOT EXISTS idx_events_session_parent_uuid ON events(session_id, parent_uuid);
CREATE INDEX IF NOT EXISTS idx_events_agent_id ON events(agent_id);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    role TEXT,
    model TEXT,
    stop_reason TEXT,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    -- Counted usage after project-wide replay/stream reconciliation. Copies have
    -- zero usage here; events.raw_json retains their recorded values. Input is
    -- base + 5m + 1h + read, priced separately (see pricing.csv).
    base_input_tokens INTEGER DEFAULT 0,
    cache_5m_tokens INTEGER DEFAULT 0,
    cache_1h_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    text_preview TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_event ON messages(event_id);
CREATE INDEX IF NOT EXISTS idx_messages_role_event ON messages(role, event_id);

CREATE TABLE IF NOT EXISTS content_blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    block_type TEXT NOT NULL,
    tool_use_id TEXT,
    tool_name TEXT,
    text_preview TEXT,
    raw_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_content_blocks_message ON content_blocks(message_id);

CREATE TABLE IF NOT EXISTS tool_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    tool_use_id TEXT,
    tool_name TEXT,
    input_preview TEXT,
    file_ext TEXT,
    raw_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_event ON tool_calls(event_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session_use ON tool_calls(session_id, tool_use_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_tool_use ON tool_calls(tool_use_id);

CREATE TABLE IF NOT EXISTS persisted_outputs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    first_line_preview TEXT
);

CREATE INDEX IF NOT EXISTS idx_persisted_outputs_session ON persisted_outputs(session_id);

CREATE TABLE IF NOT EXISTS tool_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    tool_use_id TEXT,
    is_error INTEGER NOT NULL DEFAULT 0,
    output_preview TEXT,
    persisted_output_id INTEGER REFERENCES persisted_outputs(id) ON DELETE SET NULL,
    raw_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_results_event ON tool_results(event_id);
CREATE INDEX IF NOT EXISTS idx_tool_results_session_use ON tool_results(session_id, tool_use_id);
CREATE INDEX IF NOT EXISTS idx_tool_results_tool_use ON tool_results(tool_use_id);
CREATE INDEX IF NOT EXISTS idx_tool_results_session_error ON tool_results(session_id, is_error);

CREATE TABLE IF NOT EXISTS subagents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    agent_type TEXT,
    description TEXT,
    name TEXT,
    tool_use_id TEXT,
    event_count INTEGER NOT NULL DEFAULT 0,
    first_ts TEXT,
    last_ts TEXT,
    UNIQUE(parent_session_id, agent_id)
);

CREATE TABLE IF NOT EXISTS event_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    source_event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    target_event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    edge_type TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_event_edges_session ON event_edges(session_id);
CREATE INDEX IF NOT EXISTS idx_event_edges_source ON event_edges(source_event_id);
CREATE INDEX IF NOT EXISTS idx_event_edges_target ON event_edges(target_event_id);

CREATE TABLE IF NOT EXISTS session_stats (
    session_id INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    event_count INTEGER NOT NULL DEFAULT 0,
    turn_count INTEGER NOT NULL DEFAULT 0,
    tool_call_count INTEGER NOT NULL DEFAULT 0,
    subagent_count INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    system_count INTEGER NOT NULL DEFAULT 0,
    persisted_output_count INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS import_errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id INTEGER NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    line_no INTEGER,
    message TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    finding_key TEXT NOT NULL,
    detector_key TEXT NOT NULL,
    basis TEXT NOT NULL CHECK (basis IN ('observed', 'estimated', 'inferred', 'associated')),
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    explanation TEXT NOT NULL,
    recommendation TEXT,
    start_event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
    end_event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
    evidence_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE(session_id, finding_key)
);

CREATE INDEX IF NOT EXISTS idx_session_findings_session
    ON session_findings(session_id);
CREATE INDEX IF NOT EXISTS idx_session_findings_detector
    ON session_findings(detector_key);

CREATE TABLE IF NOT EXISTS analysis_metadata (
    name TEXT PRIMARY KEY,
    version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS team_bundles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bundle_id TEXT NOT NULL UNIQUE,
    profile TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    member_id TEXT NOT NULL,
    member_name TEXT,
    generated_at TEXT NOT NULL,
    generated_seq INTEGER NOT NULL DEFAULT 0,
    app_version TEXT,
    imported_at TEXT NOT NULL,
    source_path TEXT NOT NULL,
    session_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_team_bundles_member ON team_bundles(member_id);
CREATE INDEX IF NOT EXISTS idx_team_bundles_imported_at ON team_bundles(imported_at);

CREATE TABLE IF NOT EXISTS team_bundle_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_bundle_id INTEGER NOT NULL REFERENCES team_bundles(id) ON DELETE CASCADE,
    member_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    project_name TEXT,
    session_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    first_date TEXT,
    last_date TEXT,
    duration_s INTEGER NOT NULL DEFAULT 0,
    models_json TEXT NOT NULL DEFAULT '[]',
    tokens_json TEXT NOT NULL DEFAULT '{}',
    tokens_by_model_json TEXT NOT NULL DEFAULT '{}',
    stats_json TEXT NOT NULL DEFAULT '{}',
    stop_reasons_json TEXT NOT NULL DEFAULT '{}',
    subagents_json TEXT NOT NULL DEFAULT '[]',
    tools_json TEXT NOT NULL DEFAULT '[]',
    file_types_json TEXT NOT NULL DEFAULT '[]',
    UNIQUE(team_bundle_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_team_bundle_sessions_bundle ON team_bundle_sessions(team_bundle_id);
CREATE INDEX IF NOT EXISTS idx_team_bundle_sessions_member ON team_bundle_sessions(member_id);
CREATE INDEX IF NOT EXISTS idx_team_bundle_sessions_first_date ON team_bundle_sessions(first_date);

CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
    kind,
    ref_id UNINDEXED,
    project_id UNINDEXED,
    session_id UNINDEXED,
    title,
    body
);
"""

DROP_TABLES = [
    "search_index",
    "analysis_metadata",
    "team_bundle_sessions",
    "team_bundles",
    "session_findings",
    "event_features",
    "sequence_slices",
    "import_errors",
    "session_stats",
    "event_edges",
    "memory_nodes",
    "subagents",
    "tool_results",
    "persisted_outputs",
    "tool_calls",
    "content_blocks",
    "messages",
    "events",
    "sessions",
    "projects",
    "imports",
]

TEAM_TABLES = {"team_bundle_sessions", "team_bundles"}
LOCAL_DATA_TABLES = [table for table in DROP_TABLES if table not in TEAM_TABLES]

MESSAGE_COST_COLUMNS = {
    "base_input_tokens": "INTEGER DEFAULT 0",
    "cache_5m_tokens": "INTEGER DEFAULT 0",
    "cache_1h_tokens": "INTEGER DEFAULT 0",
    "cache_read_tokens": "INTEGER DEFAULT 0",
}


def _column_names(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def migrate_db(conn: sqlite3.Connection) -> None:
    """Apply lightweight migrations for databases created by older app versions."""
    _drop_legacy_risk_tables(conn)
    _drop_unused_memory_index(conn)
    _drop_unused_sequence_cache(conn)
    _migrate_session_stats(conn)

    existing_message_columns = _column_names(conn, "messages")
    for name, definition in MESSAGE_COST_COLUMNS.items():
        if name not in existing_message_columns:
            conn.execute(f"ALTER TABLE messages ADD COLUMN {name} {definition}")

    conn.execute(
        """
        UPDATE messages
        SET base_input_tokens = COALESCE(input_tokens, 0)
        WHERE COALESCE(input_tokens, 0) > 0
          AND COALESCE(base_input_tokens, 0) = 0
          AND COALESCE(cache_5m_tokens, 0) = 0
          AND COALESCE(cache_1h_tokens, 0) = 0
          AND COALESCE(cache_read_tokens, 0) = 0
        """
    )

    _migrate_replay_accounting(conn)

    # Per-model token attribution for team bundles (sub-project B). Added to
    # older databases whose team_bundle_sessions predates the column.
    team_session_columns = _column_names(conn, "team_bundle_sessions")
    if team_session_columns and "tokens_by_model_json" not in team_session_columns:
        conn.execute(
            "ALTER TABLE team_bundle_sessions ADD COLUMN tokens_by_model_json TEXT NOT NULL DEFAULT '{}'"
        )

    # On-disk change detection for already-imported projects (sub-project A).
    project_columns = _column_names(conn, "projects")
    if project_columns and "source_signature" not in project_columns:
        conn.execute("ALTER TABLE projects ADD COLUMN source_signature TEXT")

    # Per-member export sequence for same-day bundle ordering (sub-project C). Added to
    # older databases whose team_bundles predates the column.
    team_bundle_columns = _column_names(conn, "team_bundles")
    if team_bundle_columns and "generated_seq" not in team_bundle_columns:
        conn.execute("ALTER TABLE team_bundles ADD COLUMN generated_seq INTEGER NOT NULL DEFAULT 0")

    # Team privacy levels (L2): member display name on bundles; cleartext project
    # name, tool mix, and file-type mix on imported sessions; extension-only file
    # types on local tool calls (derive-then-drop at ingest, never at export).
    team_bundle_columns = _column_names(conn, "team_bundles")
    if team_bundle_columns and "member_name" not in team_bundle_columns:
        conn.execute("ALTER TABLE team_bundles ADD COLUMN member_name TEXT")

    team_session_columns = _column_names(conn, "team_bundle_sessions")
    if team_session_columns and "project_name" not in team_session_columns:
        conn.execute("ALTER TABLE team_bundle_sessions ADD COLUMN project_name TEXT")
    if team_session_columns and "tools_json" not in team_session_columns:
        conn.execute("ALTER TABLE team_bundle_sessions ADD COLUMN tools_json TEXT NOT NULL DEFAULT '[]'")
    if team_session_columns and "file_types_json" not in team_session_columns:
        conn.execute("ALTER TABLE team_bundle_sessions ADD COLUMN file_types_json TEXT NOT NULL DEFAULT '[]'")

    _migrate_team_bundle_sessions(conn)

    tool_call_columns = _column_names(conn, "tool_calls")
    if tool_call_columns and "file_ext" not in tool_call_columns:
        conn.execute("ALTER TABLE tool_calls ADD COLUMN file_ext TEXT")
        _backfill_tool_call_file_ext(conn)


def _migrate_replay_accounting(conn: sqlite3.Connection) -> None:
    from ccfr.storage.replay import reconcile_replays, refresh_session_tokens

    columns = _column_names(conn, "events")
    if not columns:
        return
    changed = False
    if "origin_session_id" not in columns:
        conn.execute("ALTER TABLE events ADD COLUMN origin_session_id TEXT")
        conn.execute(
            "UPDATE events SET origin_session_id = json_extract(raw_json, '$.sessionId')"
            " WHERE json_valid(raw_json)"
        )
        changed = True
    if "is_replay" not in columns:
        conn.execute("ALTER TABLE events ADD COLUMN is_replay INTEGER NOT NULL DEFAULT 0")
        changed = True
    # The schema script runs before migration, so this index must be made here.
    conn.execute("CREATE INDEX IF NOT EXISTS idx_events_replay ON events(is_replay)")
    row = conn.execute(
        "SELECT version FROM analysis_metadata WHERE name = 'replay_accounting'"
    ).fetchone()
    if changed or row is None or row[0] < 1:
        reconcile_replays(conn)
        refresh_session_tokens(conn)
        conn.execute(
            "INSERT INTO analysis_metadata(name, version) VALUES ('replay_accounting', 1)"
            " ON CONFLICT(name) DO UPDATE SET version = excluded.version"
        )


def _drop_legacy_risk_tables(conn: sqlite3.Connection) -> None:
    """Remove obsolete inferred-pattern caches while preserving receipt findings."""
    for table in ("risk_findings", "pattern_hits", "sequence_patterns"):
        conn.execute(f"DROP TABLE IF EXISTS {table}")


def _drop_unused_memory_index(conn: sqlite3.Connection) -> None:
    """Remove the retired derived memory index without touching source files."""
    search_exists = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE name = 'search_index'"
    ).fetchone()
    if search_exists:
        conn.execute("DELETE FROM search_index WHERE kind = 'memory'")
    conn.execute("DROP TABLE IF EXISTS memory_nodes")


def _drop_unused_sequence_cache(conn: sqlite3.Connection) -> None:
    """Remove transitional structural rows no shipped analysis consumes."""
    conn.execute("DROP TABLE IF EXISTS event_features")
    conn.execute("DROP TABLE IF EXISTS sequence_slices")


def _migrate_session_stats(conn: sqlite3.Connection) -> None:
    columns = _column_names(conn, "session_stats")
    if not {"loop_count", "max_repeat"} & columns:
        return

    conn.execute("DROP TABLE IF EXISTS session_stats_without_loops")
    conn.execute(
        """
        CREATE TABLE session_stats_without_loops (
            session_id INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
            event_count INTEGER NOT NULL DEFAULT 0,
            turn_count INTEGER NOT NULL DEFAULT 0,
            tool_call_count INTEGER NOT NULL DEFAULT 0,
            subagent_count INTEGER NOT NULL DEFAULT 0,
            error_count INTEGER NOT NULL DEFAULT 0,
            system_count INTEGER NOT NULL DEFAULT 0,
            persisted_output_count INTEGER NOT NULL DEFAULT 0,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    conn.execute(
        """
        INSERT INTO session_stats_without_loops(
            session_id, event_count, turn_count, tool_call_count, subagent_count,
            error_count, system_count, persisted_output_count, input_tokens, output_tokens
        )
        SELECT session_id, event_count, turn_count, tool_call_count, subagent_count,
               error_count, system_count, persisted_output_count, input_tokens, output_tokens
        FROM session_stats
        """
    )
    conn.execute("DROP TABLE session_stats")
    conn.execute("ALTER TABLE session_stats_without_loops RENAME TO session_stats")


def _migrate_team_bundle_sessions(conn: sqlite3.Connection) -> None:
    """Drop v1/v2 risk/sequence columns while preserving imported core aggregates."""
    columns = _column_names(conn, "team_bundle_sessions")
    if not {"risk_categories_json", "sequence_json"} & columns:
        return

    conn.execute("DROP TABLE IF EXISTS team_bundle_sessions_v3")
    conn.execute(
        """
        CREATE TABLE team_bundle_sessions_v3 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            team_bundle_id INTEGER NOT NULL REFERENCES team_bundles(id) ON DELETE CASCADE,
            member_id TEXT NOT NULL,
            project_id TEXT NOT NULL,
            project_name TEXT,
            session_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            first_date TEXT,
            last_date TEXT,
            duration_s INTEGER NOT NULL DEFAULT 0,
            models_json TEXT NOT NULL DEFAULT '[]',
            tokens_json TEXT NOT NULL DEFAULT '{}',
            tokens_by_model_json TEXT NOT NULL DEFAULT '{}',
            stats_json TEXT NOT NULL DEFAULT '{}',
            stop_reasons_json TEXT NOT NULL DEFAULT '{}',
            subagents_json TEXT NOT NULL DEFAULT '[]',
            tools_json TEXT NOT NULL DEFAULT '[]',
            file_types_json TEXT NOT NULL DEFAULT '[]',
            UNIQUE(team_bundle_id, session_id)
        )
        """
    )
    conn.execute(
        """
        INSERT INTO team_bundle_sessions_v3(
            id, team_bundle_id, member_id, project_id, project_name, session_id,
            provider, first_date, last_date, duration_s, models_json, tokens_json,
            tokens_by_model_json, stats_json, stop_reasons_json, subagents_json,
            tools_json, file_types_json
        )
        SELECT id, team_bundle_id, member_id, project_id, project_name, session_id,
               provider, first_date, last_date, duration_s, models_json, tokens_json,
               tokens_by_model_json, stats_json, stop_reasons_json, subagents_json,
               tools_json, file_types_json
        FROM team_bundle_sessions
        """
    )
    conn.execute("DROP TABLE team_bundle_sessions")
    conn.execute("ALTER TABLE team_bundle_sessions_v3 RENAME TO team_bundle_sessions")
    conn.execute(
        "CREATE INDEX idx_team_bundle_sessions_bundle ON team_bundle_sessions(team_bundle_id)"
    )
    conn.execute(
        "CREATE INDEX idx_team_bundle_sessions_member ON team_bundle_sessions(member_id)"
    )
    conn.execute(
        "CREATE INDEX idx_team_bundle_sessions_first_date ON team_bundle_sessions(first_date)"
    )


def _backfill_tool_call_file_ext(conn: sqlite3.Connection) -> None:
    """One-time backfill after adding tool_calls.file_ext.

    Parses raw_json in the LOCAL index only (never at export time) to derive the
    extension-only file type for rows imported before the column existed.
    """
    # Imported lazily: at call time both modules are fully loaded, so the
    # storage <- ingest import cannot bite during package initialization.
    from ccfr.ingest.file_ext import FILE_ARG_TOOLS, file_ext_from_tool_input

    placeholders = ",".join("?" * len(FILE_ARG_TOOLS))
    rows = conn.execute(
        f"SELECT id, tool_name, raw_json FROM tool_calls WHERE tool_name IN ({placeholders})",
        sorted(FILE_ARG_TOOLS),
    ).fetchall()
    updates: list[tuple[str, int]] = []
    for row in rows:
        try:
            block = json.loads(row["raw_json"] or "{}")
        except json.JSONDecodeError:
            continue
        input_obj = block.get("input") if isinstance(block, dict) else None
        ext = file_ext_from_tool_input(row["tool_name"], input_obj)
        if ext:
            updates.append((ext, int(row["id"])))
    conn.executemany("UPDATE tool_calls SET file_ext = ? WHERE id = ?", updates)


def connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    # check_same_thread=False: FastAPI serves sync routes/deps from a threadpool, so a
    # per-request connection may be opened and used on different worker threads. Each
    # request still gets its own connection (used sequentially), so this is safe.
    conn = sqlite3.connect(path, timeout=30.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    # WAL lets readers run concurrently with a writer (e.g. serving the UI while an
    # import writes); busy_timeout makes a contended write wait instead of failing
    # immediately with "database is locked".
    conn.execute("PRAGMA busy_timeout = 30000")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    try:
        conn.executescript(SCHEMA)
        migrate_db(conn)
        _backfill_session_findings_once(conn)
        conn.commit()
    except Exception:
        conn.rollback()
        raise


_SESSION_FINDINGS_ANALYSIS_VERSION = 2


def _backfill_session_findings_once(conn: sqlite3.Connection) -> None:
    row = conn.execute(
        "SELECT version FROM analysis_metadata WHERE name = 'session_findings'"
    ).fetchone()
    if row is not None and int(row[0]) >= _SESSION_FINDINGS_ANALYSIS_VERSION:
        return

    from ccfr.analysis.session_findings import rebuild_session_findings

    rebuild_session_findings(conn)
    conn.execute(
        """
        INSERT INTO analysis_metadata(name, version) VALUES ('session_findings', 2)
        ON CONFLICT(name) DO UPDATE SET version = excluded.version
        """
    )


def _reset_tables(conn: sqlite3.Connection, tables: list[str]) -> None:
    conn.execute("PRAGMA foreign_keys = OFF")
    for table in tables:
        conn.execute(f"DROP TABLE IF EXISTS {table}")
    conn.commit()
    conn.execute("PRAGMA foreign_keys = ON")
    init_db(conn)


def reset_local_data(conn: sqlite3.Connection) -> None:
    """Clear imported local analytics while preserving imported team bundles."""
    _reset_tables(conn, LOCAL_DATA_TABLES)


def reset_db(conn: sqlite3.Connection) -> None:
    """Clear all application data, including imported team bundles."""
    _reset_tables(conn, DROP_TABLES)
