from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import ccfr.analysis.limits as limits_mod
from ccfr import settings as settings_mod
from ccfr.api.deps import get_db
from ccfr.main import create_app
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
    conn = _make_conn()
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
    assert body["hits"][0]["usage_at_hit_tokens"] == 1_000_000
    assert body["eras"][0]["cap_median_tokens"] == 1_000_000
    assert body["hits"][0]["session_titles"] == ["Session One"]


def test_limits_endpoint_empty_corpus_returns_zeroes(client: TestClient) -> None:
    resp = client.get("/api/analytics/limits")
    assert resp.status_code == 200
    assert resp.json()["meta"]["total_hits"] == 0
