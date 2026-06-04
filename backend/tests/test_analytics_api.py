from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from ccfr.api import analytics
from ccfr.api.deps import get_db
from ccfr.main import create_app
from ccfr.storage import init_db
from tests.test_analytics import _seed  # reuse the deterministic seed


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    csv = tmp_path / "pricing.csv"
    csv.write_text(
        "model,base-input-tokens,5m-cache-writes,1h-cache-writes,cache-hits-&-refreshes,output-tokens\n"
        "claude-opus-4-8,5,6.25,10,0.50,25\n"
        "claude-sonnet-4-6,3,3.75,6,0.30,15\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(analytics, "pricing_path", lambda: csv)
    monkeypatch.setattr("ccfr.main.database_path", lambda: tmp_path / "startup.sqlite3")
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    init_db(conn)
    _seed(conn)
    app = create_app()
    app.dependency_overrides[get_db] = lambda: conn
    with TestClient(app) as c:
        yield c
    conn.close()


def test_cost_analytics_endpoint_returns_payload(client: TestClient) -> None:
    resp = client.get("/api/analytics/cost")
    assert resp.status_code == 200
    body = resp.json()
    assert body["meta"]["total_usd"] == 48.0
    assert body["meta"]["bucket"] == "day"
    assert len(body["treemap"]) == 2
    assert body["by_model"][0]["model"] == "claude-opus-4-8"


def test_cost_analytics_endpoint_applies_model_filter(client: TestClient) -> None:
    resp = client.get("/api/analytics/cost", params={"model": "claude-sonnet-4-6"})
    assert resp.status_code == 200
    assert resp.json()["meta"]["total_usd"] == 18.0


def test_session_turn_costs_endpoint_returns_breakdown(client: TestClient) -> None:
    resp = client.get("/api/sessions/1/turn-costs")
    assert resp.status_code == 200
    body = resp.json()
    assert body["session_id"] == 1
    assert body["turn_count"] == 1
    assert body["turns"][0]["title"] == "Turn 1"
