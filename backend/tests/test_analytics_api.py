from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from ccfr.api import analytics
from ccfr.api.deps import get_db
from ccfr import settings as settings_mod
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


@pytest.fixture()
def toggle_client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Client seeded with two claude-opus-4-1 messages straddling a 2026-07-01 price change."""
    # --- pricing setup ---
    baseline = tmp_path / "pricing.csv"
    baseline.write_text(
        "model,base-input-tokens,5m-cache-writes,1h-cache-writes,cache-hits-&-refreshes,output-tokens\n"
        "Claude-Opus-4.1,15,0,0,0,0\n",
        encoding="utf-8",
    )
    sheets = tmp_path / "pricing"
    sheets.mkdir()
    (sheets / "pricing-2026-07-01.csv").write_text(
        "model,base-input-tokens,5m-cache-writes,1h-cache-writes,cache-hits-&-refreshes,output-tokens\n"
        "Claude-Opus-4.1,5,0,0,0,0\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(analytics, "pricing_path", lambda: baseline)
    monkeypatch.setattr(analytics, "pricing_dir", lambda: sheets)

    # --- settings isolation: write_settings → tmp_path/settings.json ---
    monkeypatch.setattr(settings_mod, "data_dir", lambda: tmp_path)

    # --- DB setup: two sessions, 1M base-input each, Jan + Aug 2026, claude-opus-4-1 ---
    monkeypatch.setattr("ccfr.main.database_path", lambda: tmp_path / "startup.sqlite3")
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    init_db(conn)

    conn.execute(
        "INSERT INTO imports(source_path, imported_at, status) VALUES('x','2026-01-01T00:00:00Z','done')"
    )
    conn.execute("INSERT INTO projects(import_id, export_name) VALUES(1,'proj')")
    for sid, ts in enumerate(["2026-01-15T10:00:00Z", "2026-08-15T10:00:00Z"], start=1):
        conn.execute(
            "INSERT INTO sessions(project_id, session_id, first_ts, last_ts) VALUES(1,?,?,?)",
            (f"s{sid}", ts, ts),
        )
        conn.execute(
            "INSERT INTO events(session_id, source_path, line_no, type, timestamp, raw_json)"
            " VALUES(?,?,?,?,?,'{}') ",
            (sid, "f", sid, "assistant", ts),
        )
        conn.execute(
            "INSERT INTO messages(event_id, role, model, base_input_tokens, output_tokens)"
            " VALUES(?, 'assistant', 'claude-opus-4-1', 1000000, 0)",
            (sid,),
        )
    conn.commit()

    app = create_app()
    app.dependency_overrides[get_db] = lambda: conn
    with TestClient(app) as c:
        yield c
    conn.close()


def test_cost_analytics_toggle_honors_historical_setting(toggle_client: TestClient) -> None:
    toggle_client.put("/api/settings", json={"historical_pricing": True})
    on = toggle_client.get("/api/analytics/cost").json()
    toggle_client.put("/api/settings", json={"historical_pricing": False})
    off = toggle_client.get("/api/analytics/cost").json()
    # historical ON: Jan @ $15 + Aug @ $5 = $20; OFF: both at current $5 = $10
    assert round(on["meta"]["total_usd"], 2) == 20.0
    assert round(off["meta"]["total_usd"], 2) == 10.0
