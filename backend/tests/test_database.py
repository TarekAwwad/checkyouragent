from __future__ import annotations

import json
import sqlite3

from ccfr.storage import init_db, reset_db


def test_init_db_migrates_legacy_message_cost_columns() -> None:
    conn = sqlite3.connect(":memory:")
    conn.execute(
        """
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id INTEGER NOT NULL,
            role TEXT,
            model TEXT,
            stop_reason TEXT,
            input_tokens INTEGER DEFAULT 0,
            output_tokens INTEGER DEFAULT 0,
            text_preview TEXT
        )
        """
    )
    conn.execute(
        "INSERT INTO messages(event_id, role, model, input_tokens, output_tokens) VALUES (1, 'assistant', 'm', 123, 45)"
    )

    init_db(conn)

    columns = {row[1] for row in conn.execute("PRAGMA table_info(messages)").fetchall()}
    assert {"base_input_tokens", "cache_5m_tokens", "cache_1h_tokens", "cache_read_tokens"} <= columns
    assert conn.execute("SELECT base_input_tokens FROM messages").fetchone()[0] == 123


def test_init_db_creates_analytics_indexes() -> None:
    conn = sqlite3.connect(":memory:")
    init_db(conn)

    project_indexes = {row[1] for row in conn.execute("PRAGMA index_list(projects)").fetchall()}
    event_indexes = {row[1] for row in conn.execute("PRAGMA index_list(events)").fetchall()}
    message_indexes = {row[1] for row in conn.execute("PRAGMA index_list(messages)").fetchall()}
    tool_call_indexes = {row[1] for row in conn.execute("PRAGMA index_list(tool_calls)").fetchall()}
    persisted_indexes = {row[1] for row in conn.execute("PRAGMA index_list(persisted_outputs)").fetchall()}
    edge_indexes = {row[1] for row in conn.execute("PRAGMA index_list(event_edges)").fetchall()}

    assert {"idx_projects_export_name"} <= project_indexes
    assert {
        "idx_events_session_id",
        "idx_events_timestamp_session",
        "idx_events_session_uuid",
        "idx_events_session_parent_uuid",
    } <= event_indexes
    assert {"idx_messages_event", "idx_messages_role_event"} <= message_indexes
    assert {"idx_tool_calls_event", "idx_tool_calls_session", "idx_tool_calls_session_use"} <= tool_call_indexes
    tool_result_indexes = {row[1] for row in conn.execute("PRAGMA index_list(tool_results)").fetchall()}
    assert {"idx_tool_results_event", "idx_tool_results_session_use"} <= tool_result_indexes
    assert {"idx_persisted_outputs_session"} <= persisted_indexes
    assert {"idx_event_edges_session", "idx_event_edges_source", "idx_event_edges_target"} <= edge_indexes


def test_init_db_and_reset_cover_team_bundle_tables() -> None:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_db(conn)

    tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()}
    assert {"team_bundles", "team_bundle_sessions"} <= tables

    cur = conn.execute(
        """
        INSERT INTO team_bundles(
            bundle_id, profile, schema_version, member_id, generated_at,
            app_version, imported_at, source_path, session_count
        )
        VALUES ('bundle', 'team_strict', 1, 'member', '2026-06-18', '0.1.0',
                '2026-06-18T00:00:00Z', 'bundle.json', 1)
        """
    )
    conn.execute(
        """
        INSERT INTO team_bundle_sessions(
            team_bundle_id, member_id, project_id, session_id, provider
        )
        VALUES (?, 'member', 'pid', 'sid', 'claude')
        """,
        (cur.lastrowid,),
    )

    reset_db(conn)

    assert conn.execute("SELECT COUNT(*) FROM team_bundles").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM team_bundle_sessions").fetchone()[0] == 0


def test_init_db_creates_tokens_by_model_column() -> None:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_db(conn)

    columns = {row[1] for row in conn.execute("PRAGMA table_info(team_bundle_sessions)").fetchall()}
    assert "tokens_by_model_json" in columns


def test_migrate_db_adds_tokens_by_model_to_legacy_team_table() -> None:
    from ccfr.storage.database import migrate_db

    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    # A database created before per-model tokens: messages exists (the message
    # migration needs it), team_bundle_sessions lacks the new column.
    conn.executescript(
        """
        CREATE TABLE messages (id INTEGER PRIMARY KEY, input_tokens INTEGER DEFAULT 0);
        CREATE TABLE team_bundle_sessions (id INTEGER PRIMARY KEY, session_id TEXT);
        """
    )

    migrate_db(conn)

    columns = {row[1] for row in conn.execute("PRAGMA table_info(team_bundle_sessions)").fetchall()}
    assert "tokens_by_model_json" in columns


def test_migrate_adds_and_backfills_file_ext_on_legacy_tool_calls():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    # Legacy shape: tool_calls without file_ext, holding an already-imported Read call.
    conn.execute(
        """
        CREATE TABLE tool_calls (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id INTEGER NOT NULL,
            session_id INTEGER NOT NULL,
            tool_use_id TEXT,
            tool_name TEXT,
            input_preview TEXT,
            raw_json TEXT NOT NULL
        )
        """
    )
    conn.execute(
        "INSERT INTO tool_calls(event_id, session_id, tool_use_id, tool_name, input_preview, raw_json)"
        " VALUES (1, 1, 't1', 'Read', 'preview', ?)",
        (json.dumps({"type": "tool_use", "name": "Read", "input": {"file_path": "src/App.TSX"}}),),
    )
    init_db(conn)

    row = conn.execute("SELECT file_ext FROM tool_calls").fetchone()
    assert row["file_ext"] == "tsx"


def test_migrate_adds_team_privacy_level_columns():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_db(conn)
    bundle_cols = {r[1] for r in conn.execute("PRAGMA table_info(team_bundles)")}
    session_cols = {r[1] for r in conn.execute("PRAGMA table_info(team_bundle_sessions)")}
    assert "member_name" in bundle_cols
    assert {"project_name", "tools_json", "file_types_json"} <= session_cols
