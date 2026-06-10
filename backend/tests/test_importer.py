from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from ccfr.api import repository
from ccfr.ingest import import_export
from ccfr.storage import init_db
from tests.fixtures import ALPHA_SESSION_ID, SANITIZED_EXPORT_COUNTS, sanitized_export


def memory_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_db(conn)
    return conn


def test_import_fixture_counts(tmp_path: Path) -> None:
    conn = memory_conn()
    summary = import_export(conn, sanitized_export(tmp_path))

    assert summary.project_count == SANITIZED_EXPORT_COUNTS["project_count"]
    assert summary.session_count == SANITIZED_EXPORT_COUNTS["session_count"]
    assert summary.event_count == SANITIZED_EXPORT_COUNTS["event_count"]
    assert summary.subagent_count == SANITIZED_EXPORT_COUNTS["subagent_count"]
    assert summary.memory_count == SANITIZED_EXPORT_COUNTS["memory_count"]
    assert summary.persisted_output_count == SANITIZED_EXPORT_COUNTS["persisted_output_count"]
    assert summary.error_count == 0
    assert conn.execute("SELECT COUNT(*) FROM tool_calls").fetchone()[0] == SANITIZED_EXPORT_COUNTS["tool_call_count"]
    assert (
        conn.execute("SELECT COUNT(*) FROM events WHERE is_sidechain = 1").fetchone()[0]
        == SANITIZED_EXPORT_COUNTS["sidechain_event_count"]
    )


def test_import_fixture_links_tool_cycles_and_search(tmp_path: Path) -> None:
    conn = memory_conn()
    import_export(conn, sanitized_export(tmp_path))

    tool_edges = conn.execute("SELECT COUNT(*) FROM event_edges WHERE edge_type = 'tool_cycle'").fetchone()[0]
    parent_edges = conn.execute("SELECT COUNT(*) FROM event_edges WHERE edge_type = 'parent'").fetchone()[0]
    search_hits = conn.execute(
        "SELECT COUNT(*) FROM search_index WHERE search_index MATCH ?",
        ('"Explore"',),
    ).fetchone()[0]

    assert tool_edges > 0
    assert parent_edges > 0
    assert search_hits > 0


def test_malformed_jsonl_is_reported_without_aborting(tmp_path: Path) -> None:
    project = tmp_path / "d--Sample"
    project.mkdir()
    session_id = "11111111-1111-1111-1111-111111111111"
    (project / f"{session_id}.jsonl").write_text(
        "\n".join(
            [
                '{"type":"user","uuid":"u1","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"hello"}}',
                "{bad json",
                '{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-01-01T00:00:01Z","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}',
            ]
        ),
        encoding="utf-8",
    )

    conn = memory_conn()
    summary = import_export(conn, tmp_path)

    assert summary.project_count == 1
    assert summary.session_count == 1
    assert summary.event_count == 2
    assert summary.error_count == 1
    assert conn.execute("SELECT COUNT(*) FROM import_errors").fetchone()[0] == 1


def _write_project(root: Path, name: str, session_id: str, text: str = "hello") -> None:
    project = root / name
    project.mkdir(parents=True, exist_ok=True)
    (project / f"{session_id}.jsonl").write_text(
        "\n".join(
            [
                f'{{"type":"user","uuid":"u1","timestamp":"2026-01-01T00:00:00Z","message":{{"role":"user","content":"{text}"}}}}',
                '{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-01-01T00:00:01Z","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}',
            ]
        ),
        encoding="utf-8",
    )


def test_import_all_new_is_additive(tmp_path: Path) -> None:
    from ccfr.ingest import import_all_new

    _write_project(tmp_path, "d--Alpha", "11111111-1111-1111-1111-111111111111")
    conn = memory_conn()
    import_all_new(conn, tmp_path)
    assert conn.execute("SELECT COUNT(*) FROM projects").fetchone()[0] == 1

    _write_project(tmp_path, "d--Beta", "22222222-2222-2222-2222-222222222222")
    import_all_new(conn, tmp_path)

    names = [r[0] for r in conn.execute("SELECT export_name FROM projects ORDER BY export_name")]
    assert names == ["d--Alpha", "d--Beta"]
    # Alpha was already present and not re-imported; Beta added -> two sessions total.
    assert conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 2


def test_reimport_replaces_without_orphaning_derived_rows(tmp_path: Path) -> None:
    from ccfr.ingest import import_export

    _write_project(tmp_path, "d--Alpha", "11111111-1111-1111-1111-111111111111")
    conn = memory_conn()
    import_export(conn, tmp_path)

    counts_after_first = {
        t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        for t in (
            "sessions",
            "events",
            "event_edges",
            "search_index",
            "event_features",
            "sequence_slices",
            "sequence_patterns",
            "risk_findings",
            "projects",
        )
    }

    # Re-import the same source unchanged -> everything replaced, no growth, no orphans.
    import_export(conn, tmp_path)

    counts_after_second = {
        t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        for t in (
            "sessions",
            "events",
            "event_edges",
            "search_index",
            "event_features",
            "sequence_slices",
            "sequence_patterns",
            "risk_findings",
            "projects",
        )
    }
    assert counts_after_first == counts_after_second

    live_projects = {r[0] for r in conn.execute("SELECT id FROM projects")}
    search_projects = {
        r[0] for r in conn.execute("SELECT DISTINCT project_id FROM search_index WHERE project_id IS NOT NULL")
    }
    assert search_projects <= live_projects


def test_import_project_replaces_only_that_project(tmp_path: Path) -> None:
    from ccfr.ingest import import_all_new, import_project

    _write_project(tmp_path, "d--Alpha", "11111111-1111-1111-1111-111111111111")
    _write_project(tmp_path, "d--Beta", "22222222-2222-2222-2222-222222222222")
    conn = memory_conn()
    import_all_new(conn, tmp_path)
    assert conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 2

    # Add a second session to Alpha on disk, then re-import only Alpha.
    _write_project(tmp_path, "d--Alpha", "33333333-3333-3333-3333-333333333333")
    summary = import_project(conn, tmp_path, "d--Alpha")

    alpha_id = conn.execute("SELECT id FROM projects WHERE export_name = 'd--Alpha'").fetchone()[0]
    alpha_sessions = conn.execute("SELECT COUNT(*) FROM sessions WHERE project_id = ?", (alpha_id,)).fetchone()[0]
    project_count = conn.execute("SELECT COUNT(*) FROM projects").fetchone()[0]
    beta_sessions = conn.execute(
        "SELECT COUNT(*) FROM sessions s JOIN projects p ON p.id = s.project_id WHERE p.export_name = 'd--Beta'"
    ).fetchone()[0]

    assert summary.project_count == 1
    assert summary.session_count == 2          # Alpha now has two sessions
    assert alpha_sessions == 2
    assert project_count == 2                   # no duplicate Alpha row
    assert beta_sessions == 1                   # Beta untouched


def test_import_progress_callback_sees_projected_counts(tmp_path: Path) -> None:
    from ccfr.ingest import import_project

    _write_project(tmp_path, "d--Alpha", "11111111-1111-1111-1111-111111111111")
    conn = memory_conn()
    snapshots: list[tuple[str, dict[str, int], dict[str, int]]] = []

    def progress(summary, status: str) -> None:
        snapshots.append((
            status,
            repository.cache_stats(conn),
            repository.import_summary_stats(conn, summary.import_id),
        ))

    import_project(conn, tmp_path, "d--Alpha", progress_callback=progress)

    statuses = [status for status, _totals, _summary in snapshots]
    assert statuses[0] == "running"
    assert "importing" in statuses
    assert statuses[-1] == "completed"
    assert any(
        status == "importing" and totals["event_count"] > 0 and summary["event_count"] > 0
        for status, totals, summary in snapshots
    )


def test_reimport_progress_does_not_double_count_replaced_project(tmp_path: Path) -> None:
    from ccfr.ingest import import_project

    _write_project(tmp_path, "d--Alpha", "11111111-1111-1111-1111-111111111111")
    conn = memory_conn()
    import_project(conn, tmp_path, "d--Alpha")

    _write_project(tmp_path, "d--Alpha", "33333333-3333-3333-3333-333333333333")
    snapshots: list[dict[str, int]] = []

    def progress(summary, status: str) -> None:
        if status == "importing":
            snapshots.append(repository.cache_stats(conn))

    import_project(conn, tmp_path, "d--Alpha", progress_callback=progress)

    assert snapshots
    assert max(snapshot["project_count"] for snapshot in snapshots) == 1
    assert repository.cache_stats(conn)["session_count"] == 2


def test_import_project_keeps_unrelated_risk_analysis(tmp_path: Path) -> None:
    from ccfr.ingest import import_all_new, import_project

    _write_project(tmp_path, "d--Alpha", "11111111-1111-1111-1111-111111111111")
    _write_project(tmp_path, "d--Beta", "22222222-2222-2222-2222-222222222222")
    conn = memory_conn()
    import_all_new(conn, tmp_path)

    beta_session = conn.execute(
        """
        SELECT s.id
        FROM sessions s
        JOIN projects p ON p.id = s.project_id
        WHERE p.export_name = 'd--Beta'
        """
    ).fetchone()[0]
    beta_feature_count = conn.execute(
        "SELECT COUNT(*) FROM event_features WHERE session_id = ?",
        (beta_session,),
    ).fetchone()[0]
    assert beta_feature_count > 0

    _write_project(tmp_path, "d--Alpha", "33333333-3333-3333-3333-333333333333")
    import_project(conn, tmp_path, "d--Alpha")

    assert conn.execute(
        "SELECT COUNT(*) FROM event_features WHERE session_id = ?",
        (beta_session,),
    ).fetchone()[0] == beta_feature_count


def test_import_project_unknown_name_raises(tmp_path: Path) -> None:
    from ccfr.ingest import import_project

    (tmp_path / "d--Alpha").mkdir()
    conn = memory_conn()
    import pytest
    with pytest.raises(FileNotFoundError):
        import_project(conn, tmp_path, "d--Missing")


def test_import_project_raw_event_reads_from_disk_not_truncated_db(tmp_path: Path) -> None:
    """Project-scoped imports must serve raw events from the source file, untruncated."""
    from ccfr.ingest import import_project

    project = tmp_path / "d--Alpha"
    project.mkdir()
    event_uuid = "u-long"

    # Must exceed the _compact_for_storage string_limit (4000) to trigger truncation.
    long_value = "X" * 5000
    row = {
        "type": "user",
        "uuid": event_uuid,
        "timestamp": "2026-01-01T00:00:00Z",
        "message": {"role": "user", "content": long_value},
    }
    (project / f"{ALPHA_SESSION_ID}.jsonl").write_text(
        json.dumps(row, separators=(",", ":")),
        encoding="utf-8",
    )

    conn = memory_conn()
    import_project(conn, tmp_path, "d--Alpha")

    event_row = conn.execute("SELECT id FROM events WHERE uuid = ?", (event_uuid,)).fetchone()
    assert event_row is not None, "event not ingested"
    event = repository.get_event(conn, event_row["id"], include_raw=True)
    assert event is not None

    raw = event["raw_json"]
    # The full content must be present — this fails before the fix because _load_raw_event
    # resolves to the wrong path and falls back to the truncated raw_json column.
    assert isinstance(raw, dict), f"expected dict, got {type(raw)}"
    actual_content = raw.get("message", {}).get("content", "")
    assert actual_content == long_value, (
        f"raw_json content length {len(actual_content)} != {len(long_value)}; "
        "likely fell back to truncated DB copy"
    )


def test_discover_projects_reports_status(tmp_path: Path) -> None:
    from ccfr.ingest import discover_projects, import_project

    _write_project(tmp_path, "d--Alpha", "11111111-1111-1111-1111-111111111111")
    (tmp_path / "d--Beta").mkdir()  # exists on disk, not imported
    conn = memory_conn()

    before = {p.name: p for p in discover_projects(conn, tmp_path)}
    assert before["d--Alpha"].imported is False
    assert before["d--Alpha"].session_count == 0
    assert before["d--Beta"].imported is False

    import_project(conn, tmp_path, "d--Alpha")

    after = {p.name: p for p in discover_projects(conn, tmp_path)}
    assert after["d--Alpha"].imported is True
    assert after["d--Alpha"].session_count == 1
    assert after["d--Alpha"].last_imported_at is not None
    assert after["d--Beta"].imported is False


def test_session_error_count_excludes_system_events(tmp_path: Path) -> None:
    project = tmp_path / "d--Sample"
    project.mkdir()
    session_id = "11111111-1111-1111-1111-111111111111"
    (project / f"{session_id}.jsonl").write_text(
        "\n".join(
            [
                '{"type":"system","uuid":"s1","timestamp":"2026-01-01T00:00:00Z"}',
                '{"type":"user","uuid":"u1","parentUuid":"s1","timestamp":"2026-01-01T00:00:01Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-1","is_error":true,"content":"command failed"}]}}',
            ]
        ),
        encoding="utf-8",
    )

    conn = memory_conn()
    import_export(conn, tmp_path)

    session = repository.list_sessions(conn)[0]
    assert session["error_count"] == 1
    assert session["system_count"] == 1

    timeline = repository.get_timeline(conn, session["id"])
    assert [item["title"] for item in timeline] == ["System event", "Tool error"]


def test_repeated_assistant_message_usage_is_counted_once(tmp_path: Path) -> None:
    project = tmp_path / "d--Sample"
    project.mkdir()
    session_id = "11111111-1111-1111-1111-111111111111"
    rows = [
        {
            "type": "user",
            "uuid": "u1",
            "timestamp": "2026-01-01T00:00:00Z",
            "message": {"role": "user", "content": "hello"},
        },
        {
            "type": "assistant",
            "uuid": "a1",
            "parentUuid": "u1",
            "timestamp": "2026-01-01T00:00:01Z",
            "message": {
                "id": "msg-1",
                "role": "assistant",
                "model": "claude-sonnet",
                "content": [{"type": "text", "text": "I will call a tool"}],
                "usage": {
                    "input_tokens": 3,
                    "cache_creation_input_tokens": 100,
                    "cache_read_input_tokens": 7,
                    "output_tokens": 5,
                },
            },
        },
        {
            "type": "assistant",
            "uuid": "a2",
            "parentUuid": "a1",
            "timestamp": "2026-01-01T00:00:02Z",
            "message": {
                "id": "msg-1",
                "role": "assistant",
                "model": "claude-sonnet",
                "content": [
                    {
                        "type": "tool_use",
                        "id": "tool-1",
                        "name": "Read",
                        "input": {"file_path": "x"},
                    }
                ],
                "usage": {
                    "input_tokens": 3,
                    "cache_creation_input_tokens": 100,
                    "cache_read_input_tokens": 7,
                    "output_tokens": 50,
                },
            },
        },
    ]
    (project / f"{session_id}.jsonl").write_text(
        "\n".join(json.dumps(row) for row in rows),
        encoding="utf-8",
    )

    conn = memory_conn()
    import_export(conn, tmp_path)

    session = repository.list_sessions(conn)[0]
    assert session["input_tokens"] == 110
    assert session["output_tokens"] == 50

    trace = repository.get_trace(conn, session["id"])
    token_spans = [
        span
        for span in trace["spans"]
        if span["input_tokens"] > 0 or span["output_tokens"] > 0
    ]
    assert len(token_spans) == 1
    assert token_spans[0]["input_tokens"] == 110
    assert token_spans[0]["output_tokens"] == 50


def test_import_stores_cache_breakdown_and_costs_per_model(tmp_path: Path, monkeypatch) -> None:
    project = tmp_path / "d--Sample"
    project.mkdir()
    session_id = "22222222-2222-2222-2222-222222222222"
    rows = [
        {"type": "user", "uuid": "u1", "timestamp": "2026-01-01T00:00:00Z",
         "message": {"role": "user", "content": "hi"}},
        {
            "type": "assistant",
            "uuid": "a1",
            "parentUuid": "u1",
            "timestamp": "2026-01-01T00:00:01Z",
            "message": {
                "id": "msg-1",
                "role": "assistant",
                "model": "claude-opus-4-8",
                "content": [{"type": "text", "text": "hello"}],
                "usage": {
                    "input_tokens": 1_000_000,
                    "cache_read_input_tokens": 2_000_000,
                    "cache_creation_input_tokens": 1_000_000,
                    # explicit 5m/1h split should be preserved verbatim
                    "cache_creation": {
                        "ephemeral_5m_input_tokens": 600_000,
                        "ephemeral_1h_input_tokens": 400_000,
                    },
                    "output_tokens": 400_000,
                },
            },
        },
    ]
    (project / f"{session_id}.jsonl").write_text(
        "\n".join(json.dumps(row) for row in rows),
        encoding="utf-8",
    )

    conn = memory_conn()
    import_export(conn, tmp_path)

    breakdown = conn.execute(
        """
        SELECT base_input_tokens, cache_5m_tokens, cache_1h_tokens, cache_read_tokens, input_tokens
        FROM messages WHERE input_tokens > 0
        """
    ).fetchone()
    assert breakdown["base_input_tokens"] == 1_000_000
    assert breakdown["cache_5m_tokens"] == 600_000
    assert breakdown["cache_1h_tokens"] == 400_000
    assert breakdown["cache_read_tokens"] == 2_000_000
    # input_tokens stays the folded sum of all four categories
    assert breakdown["input_tokens"] == 4_000_000

    pricing = tmp_path / "pricing.csv"
    pricing.write_text(
        "Model,Base Input Tokens,5m Cache Writes,1h Cache Writes,Cache Hits & Refreshes,Output Tokens\n"
        "Claude Opus 4.8,5,6.25,10,0.50,25\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("CCFR_PRICING_PATH", str(pricing))

    session = repository.list_sessions(conn)[0]
    cost = repository.session_cost(conn, session["id"])
    assert cost["available"] is True
    assert cost["unpriced_models"] == []
    # base 5 + 5m 3.75 + 1h 4 + read 1.0 + output 10 = 23.75
    assert cost["usd"] == 23.75
    assert cost["tokens"]["cache_read"] == 2_000_000
