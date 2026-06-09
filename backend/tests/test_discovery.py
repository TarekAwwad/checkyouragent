from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from ccfr.analysis import discovery
from ccfr.analysis.discovery import discovery_analytics
from ccfr.api.deps import get_db
from ccfr.main import create_app
from ccfr.storage import init_db


def _add_session(
    conn: sqlite3.Connection,
    *,
    project_id: int,
    session_uuid: str,
    title: str,
    model: str,
    base_tokens: int,
    subagents: int,
    tool_name: str | None = None,
) -> int:
    session_id = int(conn.execute(
        """
        INSERT INTO sessions(project_id, session_id, title, first_ts, last_ts)
        VALUES (?, ?, ?, '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z')
        """,
        (project_id, session_uuid, title),
    ).lastrowid)
    event_id = int(conn.execute(
        """
        INSERT INTO events(session_id, source_path, line_no, type, timestamp, raw_json)
        VALUES (?, 'fixture.jsonl', 1, 'assistant', '2026-01-01T00:01:00Z', '{}')
        """,
        (session_id,),
    ).lastrowid)
    conn.execute(
        """
        INSERT INTO messages(
            event_id, role, model, input_tokens, output_tokens,
            base_input_tokens, cache_5m_tokens, cache_1h_tokens, cache_read_tokens
        )
        VALUES (?, 'assistant', ?, ?, 0, ?, 0, 0, 0)
        """,
        (event_id, model, base_tokens, base_tokens),
    )
    if tool_name:
        conn.execute(
            """
            INSERT INTO tool_calls(event_id, session_id, tool_use_id, tool_name, raw_json)
            VALUES (?, ?, ?, ?, ?)
            """,
            (event_id, session_id, f"{session_uuid}-tool", tool_name, "{}"),
        )
    conn.execute(
        """
        INSERT INTO session_stats(
            session_id, event_count, turn_count, tool_call_count, subagent_count,
            error_count, system_count, persisted_output_count, input_tokens, output_tokens,
            loop_count, max_repeat
        )
        VALUES (?, 4, 2, ?, ?, 0, 0, 0, ?, 0, 0, 0)
        """,
        (session_id, 1 if tool_name else 0, subagents, base_tokens),
    )
    return session_id


def _seed(conn: sqlite3.Connection) -> tuple[int, int]:
    import_id = int(conn.execute(
        """
        INSERT INTO imports(source_path, imported_at, file_count, status, error_count)
        VALUES ('fixture', '2026-01-01T00:00:00Z', 0, 'completed', 0)
        """
    ).lastrowid)
    alpha = int(conn.execute(
        "INSERT INTO projects(import_id, export_name, inferred_cwd) VALUES (?, 'alpha', NULL)",
        (import_id,),
    ).lastrowid)
    beta = int(conn.execute(
        "INSERT INTO projects(import_id, export_name, inferred_cwd) VALUES (?, 'beta', NULL)",
        (import_id,),
    ).lastrowid)

    for index, tokens in enumerate((120_000_000, 10_000_000, 8_000_000), start=1):
        _add_session(
            conn,
            project_id=alpha,
            session_uuid=f"alpha-high-{index}",
            title=f"Alpha fanout {index}",
            model="claude-sonnet-4-6",
            base_tokens=tokens,
            subagents=12,
            tool_name="Agent",
        )
    for index in range(1, 4):
        _add_session(
            conn,
            project_id=alpha if index < 3 else beta,
            session_uuid=f"quiet-{index}",
            title=f"Quiet {index}",
            model="claude-haiku-4-5",
            base_tokens=1_000_000,
            subagents=0,
            tool_name="Read",
        )

    sessions = [row["id"] for row in conn.execute("SELECT id FROM sessions ORDER BY id").fetchall()]
    for index in range(12):
        session_id = sessions[index % len(sessions)]
        event_id = int(conn.execute(
            """
            INSERT INTO events(session_id, source_path, line_no, type, timestamp, raw_json)
            VALUES (?, 'tools.jsonl', ?, 'assistant', '2026-01-01T00:10:00Z', '{}')
            """,
            (session_id, index + 1),
        ).lastrowid)
        is_test = index < 6
        tool_use_id = f"call-{index}"
        command = "uv run pytest tests" if is_test else ""
        raw_json = f'{{"input": {{"command": "{command}"}}}}' if is_test else "{}"
        conn.execute(
            """
            INSERT INTO tool_calls(event_id, session_id, tool_use_id, tool_name, input_preview, raw_json)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (event_id, session_id, tool_use_id, "Bash" if is_test else "Read", command, raw_json),
        )
        conn.execute(
            """
            INSERT INTO tool_results(event_id, session_id, tool_use_id, is_error, raw_json)
            VALUES (?, ?, ?, ?, '{}')
            """,
            (event_id, session_id, tool_use_id, 1 if index < 3 else 0),
        )

    for index in range(12):
        session_id = sessions[index % len(sessions)]
        event_id = int(conn.execute(
            """
            INSERT INTO events(session_id, source_path, line_no, type, timestamp, raw_json)
            VALUES (?, 'slices.jsonl', ?, 'assistant', '2026-01-01T00:20:00Z', '{}')
            """,
            (session_id, index + 1),
        ).lastrowid)
        is_git = index < 6
        slice_id = int(conn.execute(
            """
            INSERT INTO sequence_slices(session_id, kind, lane, start_event_id, end_event_id, outcome, length, duration_seconds)
            VALUES (?, 'turn', 'main', ?, ?, ?, 4, 60)
            """,
            (session_id, event_id, event_id, "rejected" if index < 3 else "clean"),
        ).lastrowid)
        symbol = "CALL:Bash:git" if is_git else "CALL:inspect:Read"
        conn.execute(
            """
            INSERT INTO event_features(event_id, session_id, sequence_slice_id, position, symbol, family, attributes_json)
            VALUES (?, ?, ?, 0, ?, 'tool_call', '{}')
            """,
            (event_id, session_id, slice_id, symbol),
        )
    conn.commit()
    return alpha, beta


@pytest.fixture()
def seeded(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[sqlite3.Connection, int, int]:
    csv = tmp_path / "pricing.csv"
    csv.write_text(
        "model,base-input-tokens,5m-cache-writes,1h-cache-writes,cache-hits-&-refreshes,output-tokens\n"
        "claude-sonnet-4-6,1,1,1,1,1\n"
        "claude-haiku-4-5,1,1,1,1,1\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(discovery, "pricing_path", lambda: csv)
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    init_db(conn)
    alpha, beta = _seed(conn)
    return conn, alpha, beta


def test_discovery_returns_ranked_driver_sections(seeded: tuple[sqlite3.Connection, int, int]) -> None:
    conn, _alpha, _beta = seeded
    payload = discovery_analytics(conn, min_support=3)

    assert set(payload["sections"]) == {"cost", "fanout_cost", "tool_errors", "rejections"}
    cost = payload["sections"]["cost"]
    fanout = payload["sections"]["fanout_cost"]
    tool_errors = payload["sections"]["tool_errors"]
    rejections = payload["sections"]["rejections"]

    assert cost["available"] is True
    assert any("subagents" in result["title"] or "Uses Agent" in result["title"] for result in fanout["results"])
    assert any("Bash Test commands" in result["title"] for result in tool_errors["results"])
    assert any("Bash git activity" in result["title"] for result in rejections["results"])
    assert all("cost" not in selector.lower() for result in cost["results"] for selector in result["selectors"])


def test_discovery_applies_project_and_support_filters(seeded: tuple[sqlite3.Connection, int, int]) -> None:
    conn, alpha, beta = seeded

    alpha_payload = discovery_analytics(conn, project_id=alpha, min_support=3)
    beta_payload = discovery_analytics(conn, project_id=beta, min_support=3)
    strict_payload = discovery_analytics(conn, project_id=alpha, min_support=99)

    assert alpha_payload["meta"]["total_sessions"] == 5
    assert beta_payload["meta"]["total_sessions"] == 1
    assert alpha_payload["sections"]["cost"]["results"]
    assert not strict_payload["sections"]["cost"]["results"]


def test_discovery_empty_db_is_stable(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    csv = tmp_path / "pricing.csv"
    csv.write_text(
        "model,base-input-tokens,5m-cache-writes,1h-cache-writes,cache-hits-&-refreshes,output-tokens\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(discovery, "pricing_path", lambda: csv)
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_db(conn)

    payload = discovery_analytics(conn)

    assert payload["meta"]["total_sessions"] == 0
    assert payload["sections"]["tool_errors"]["results"] == []
    assert payload["sections"]["rejections"]["baseline_count"] == 0


def test_discovery_endpoint_returns_payload(seeded: tuple[sqlite3.Connection, int, int], tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    conn, alpha, _beta = seeded
    monkeypatch.setattr("ccfr.main.database_path", lambda: tmp_path / "startup.sqlite3")
    app = create_app()
    app.dependency_overrides[get_db] = lambda: conn
    with TestClient(app) as client:
        response = client.get("/api/analytics/discovery", params={"project_id": alpha, "min_support": 3})

    assert response.status_code == 200
    body = response.json()
    assert body["meta"]["project_id"] == alpha
    assert body["sections"]["cost"]["available"] is True
    assert "tool_errors" in body["sections"]
