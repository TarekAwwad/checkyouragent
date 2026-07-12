from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import ccfr.analysis.limits as limits_mod
from ccfr import settings as settings_mod
from ccfr.api.deps import get_db
from ccfr.main import create_app
from ccfr.storage import init_db
from tests.test_limits import HIT_TEXT, _add_limit_hit, _add_usage, _make_conn


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    csv = tmp_path / "pricing.csv"
    csv.write_text(
        "model,base-input-tokens,5m-cache-writes,1h-cache-writes,"
        "cache-hits-&-refreshes,output-tokens\n"
        "claude-opus-4-8,10,0,0,0,0\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(limits_mod, "pricing_path", lambda: csv)
    monkeypatch.setattr(limits_mod, "pricing_dir", lambda: tmp_path / "no-sheets")
    monkeypatch.setattr(settings_mod, "data_dir", lambda: tmp_path)
    monkeypatch.setattr("ccfr.main.database_path", lambda: tmp_path / "startup.sqlite3")
    # Create a file-based database (thread-safe) instead of in-memory.
    db_path = tmp_path / "test.sqlite3"
    conn = sqlite3.connect(str(db_path), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    init_db(conn)
    import_id = conn.execute(
        "INSERT INTO imports (source_path, imported_at, file_count, status, error_count)"
        " VALUES ('fx', '2026-01-01T00:00:00Z', 0, 'complete', 0)"
    ).lastrowid
    project = conn.execute(
        "INSERT INTO projects (import_id, export_name, inferred_cwd) VALUES (?, 'alpha', NULL)",
        (import_id,),
    ).lastrowid
    conn.execute(
        "INSERT INTO sessions (project_id, session_id, title, first_ts, last_ts)"
        " VALUES (?, 's1', 'Session One', '2026-07-03T00:00:00Z', '2026-07-03T12:00:00Z')",
        (project,),
    )
    app = create_app()
    app.dependency_overrides[get_db] = lambda: conn
    with TestClient(app) as c:
        yield c
    conn.close()


def test_limits_endpoint_returns_hits_windows_and_eras(client: TestClient) -> None:
    # Seed through the shared helpers: usage then a hit in the same window.
    conn = client.app.dependency_overrides[get_db]()
    _add_usage(conn, 1, "2026-07-03T08:00:00Z", 1_000_000)
    _add_limit_hit(conn, 1, "2026-07-03T09:40:00Z", HIT_TEXT)

    client.put("/api/settings", json={
        "historical_pricing": True, "privacy_mode": False,
        "team_export_prefs": {},
        "plan_history": [{"plan": "Max 5x", "start_date": "2026-06-10"}],
    })
    resp = client.get("/api/analytics/limits")
    assert resp.status_code == 200
    body = resp.json()
    assert body["meta"]["total_hits"] == 1
    assert body["meta"]["hit_counts"] == {"session": 1}
    assert body["meta"]["plan_history"] == [{"plan": "Max 5x", "start_date": "2026-06-10"}]
    assert body["windows"][0]["hit_kinds"] == ["session"]
    assert body["eras"][0]["era"] == "Max 5x"
    assert body["hits"][0]["usage_at_hit"] == 10.0
    assert body["hits"][0]["session_titles"] == ["Session One"]


def test_limits_endpoint_rejects_no_params_gracefully(client: TestClient) -> None:
    resp = client.get("/api/analytics/limits")
    assert resp.status_code == 200
    assert resp.json()["meta"]["total_hits"] == 0
