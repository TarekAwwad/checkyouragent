from __future__ import annotations

import sqlite3

from ccfr.storage import init_db


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
