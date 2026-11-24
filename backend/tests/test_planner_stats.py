from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

import ccfr.ingest.importer as importer_mod
from ccfr.analysis.context_economics import load_threads
from ccfr.ingest import import_all_new, import_export
from ccfr.storage import connect, init_db, refresh_planner_stats, reset_local_data
from tests.fixtures import sanitized_export


def _events_stat_rows(conn: sqlite3.Connection) -> int:
    if not conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'"
    ).fetchone():
        return 0
    return int(conn.execute("SELECT COUNT(*) FROM sqlite_stat1 WHERE tbl = 'events'").fetchone()[0])


def _imported_db(tmp_path: Path) -> Path:
    db = tmp_path / "ccfr.sqlite3"
    conn = connect(db)
    try:
        init_db(conn)
        import_export(conn, sanitized_export(tmp_path))
    finally:
        conn.close()
    return db


def test_import_refreshes_planner_statistics(tmp_path: Path) -> None:
    conn = connect(_imported_db(tmp_path))
    try:
        assert _events_stat_rows(conn) > 0
        assert not conn.in_transaction
    finally:
        conn.close()


def test_unchanged_import_skips_analyze(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = sanitized_export(tmp_path)
    conn = connect(tmp_path / "ccfr.sqlite3")
    try:
        init_db(conn)
        import_all_new(conn, root)
        calls: list[sqlite3.Connection] = []
        monkeypatch.setattr(importer_mod, "refresh_planner_stats", calls.append)

        assert import_all_new(conn, root).project_count == 0
        assert calls == []

        assert import_export(conn, root).project_count == 2
        assert calls == [conn]
    finally:
        conn.close()


def test_next_import_after_local_reset_reanalyzes(tmp_path: Path) -> None:
    root = sanitized_export(tmp_path)
    conn = connect(tmp_path / "ccfr.sqlite3")
    try:
        init_db(conn)
        import_all_new(conn, root)
        assert _events_stat_rows(conn) > 0

        # Dropping the events table drops its statistics; the empty database is
        # not analyzed on init, so the import that refills it must do it.
        reset_local_data(conn)
        assert _events_stat_rows(conn) == 0

        import_all_new(conn, root)
        assert _events_stat_rows(conn) > 0
    finally:
        conn.close()


@pytest.mark.parametrize("stats_state", ["missing", "empty"])
def test_init_db_analyzes_populated_database_without_statistics(
    tmp_path: Path, stats_state: str
) -> None:
    db = _imported_db(tmp_path)
    conn = connect(db)
    if stats_state == "missing":
        conn.execute("DROP TABLE sqlite_stat1")
    else:
        conn.execute("DELETE FROM sqlite_stat1")
    conn.commit()
    conn.close()

    conn = connect(db)
    try:
        assert _events_stat_rows(conn) == 0
        init_db(conn)
        assert _events_stat_rows(conn) > 0
        assert not conn.in_transaction
    finally:
        conn.close()


def test_init_db_does_not_analyze_empty_database(tmp_path: Path) -> None:
    conn = connect(tmp_path / "ccfr.sqlite3")
    try:
        init_db(conn)
        assert not conn.execute(
            "SELECT 1 FROM sqlite_master WHERE name = 'sqlite_stat1'"
        ).fetchone()
    finally:
        conn.close()


def test_refresh_planner_stats_refuses_an_open_transaction() -> None:
    conn = sqlite3.connect(":memory:")
    init_db(conn)
    conn.execute("INSERT INTO imports(source_path, imported_at, status) VALUES ('x', 'y', 'running')")
    with pytest.raises(RuntimeError, match="after the data commit"):
        refresh_planner_stats(conn)


def test_load_threads_seeks_session_events_after_import(tmp_path: Path) -> None:
    # A fresh connection plans from the persisted statistics, as every
    # per-request API connection does.
    conn = connect(_imported_db(tmp_path))
    try:
        statements: list[str] = []
        conn.set_trace_callback(statements.append)
        load_threads(conn)
        conn.set_trace_callback(None)
        call_queries = [
            sql for sql in statements
            if "m.role = 'assistant'" in sql and "ORDER BY e.timestamp, e.id" in sql
        ]
        assert call_queries
        plan = [row[-1] for row in conn.execute("EXPLAIN QUERY PLAN " + call_queries[0])]
        # Without statistics SQLite drives this join from every assistant
        # message (idx_messages_role_event) and sorts; it must seek the session.
        assert "idx_events_session_time" in plan[0], plan
        assert not any("TEMP B-TREE" in step for step in plan), plan
    finally:
        conn.close()
