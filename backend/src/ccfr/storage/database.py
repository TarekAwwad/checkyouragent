from __future__ import annotations

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
    inferred_cwd TEXT
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
    raw_json TEXT NOT NULL
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
    -- Cost breakdown of input_tokens (which is base + 5m + 1h + read). These are priced
    -- separately (see pricing.csv): cache hits are ~10x cheaper than fresh input.
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

CREATE TABLE IF NOT EXISTS memory_nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    name TEXT,
    type TEXT,
    description TEXT,
    origin_session_id TEXT,
    text_preview TEXT
);

CREATE INDEX IF NOT EXISTS idx_memory_nodes_project ON memory_nodes(project_id);

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
    output_tokens INTEGER NOT NULL DEFAULT 0,
    loop_count INTEGER NOT NULL DEFAULT 0,
    max_repeat INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS import_errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id INTEGER NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    line_no INTEGER,
    message TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sequence_slices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    lane TEXT NOT NULL,
    start_event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
    end_event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
    outcome TEXT NOT NULL,
    length INTEGER NOT NULL DEFAULT 0,
    duration_seconds INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sequence_slices_session ON sequence_slices(session_id);
CREATE INDEX IF NOT EXISTS idx_sequence_slices_kind ON sequence_slices(kind);

CREATE TABLE IF NOT EXISTS event_features (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    sequence_slice_id INTEGER NOT NULL REFERENCES sequence_slices(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    family TEXT NOT NULL,
    attributes_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_event_features_session ON event_features(session_id);
CREATE INDEX IF NOT EXISTS idx_event_features_slice_pos ON event_features(sequence_slice_id, position);
CREATE INDEX IF NOT EXISTS idx_event_features_symbol ON event_features(symbol);

CREATE TABLE IF NOT EXISTS sequence_patterns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    pattern_json TEXT NOT NULL,
    support INTEGER NOT NULL DEFAULT 0,
    positive_support INTEGER NOT NULL DEFAULT 0,
    negative_support INTEGER NOT NULL DEFAULT 0,
    lift REAL NOT NULL DEFAULT 0,
    score REAL NOT NULL DEFAULT 0,
    label TEXT,
    explanation TEXT
);

CREATE INDEX IF NOT EXISTS idx_sequence_patterns_kind ON sequence_patterns(kind);
CREATE INDEX IF NOT EXISTS idx_sequence_patterns_score ON sequence_patterns(score);

CREATE TABLE IF NOT EXISTS pattern_hits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern_id INTEGER NOT NULL REFERENCES sequence_patterns(id) ON DELETE CASCADE,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    sequence_slice_id INTEGER NOT NULL REFERENCES sequence_slices(id) ON DELETE CASCADE,
    start_event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
    end_event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
    evidence_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_pattern_hits_session ON pattern_hits(session_id);
CREATE INDEX IF NOT EXISTS idx_pattern_hits_pattern ON pattern_hits(pattern_id);

CREATE TABLE IF NOT EXISTS risk_findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    severity TEXT NOT NULL,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    explanation TEXT NOT NULL,
    pattern_id INTEGER REFERENCES sequence_patterns(id) ON DELETE SET NULL,
    start_event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
    end_event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
    score REAL NOT NULL DEFAULT 0,
    evidence_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_risk_findings_session ON risk_findings(session_id);
CREATE INDEX IF NOT EXISTS idx_risk_findings_category ON risk_findings(category);
CREATE INDEX IF NOT EXISTS idx_risk_findings_score ON risk_findings(score);

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
    "risk_findings",
    "pattern_hits",
    "event_features",
    "sequence_patterns",
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
    conn.executescript(SCHEMA)
    migrate_db(conn)
    conn.commit()


def reset_db(conn: sqlite3.Connection) -> None:
    conn.execute("PRAGMA foreign_keys = OFF")
    for table in DROP_TABLES:
        conn.execute(f"DROP TABLE IF EXISTS {table}")
    conn.commit()
    conn.execute("PRAGMA foreign_keys = ON")
    init_db(conn)
