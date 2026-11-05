from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from ccfr import settings as settings_mod
from ccfr.analysis import usage_map
from ccfr.api import analytics, repository
from ccfr.api.deps import get_db
from ccfr.main import create_app
from ccfr.storage import init_db
from fastapi.testclient import TestClient

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
    assert body["meta"]["costs_partial"] is False
    assert body["meta"]["costs_are_lower_bound"] is False
    assert len(body["treemap"]) == 2
    assert body["by_model"][0]["model"] == "claude-opus-4-8"
    assert body["over_time"][0]["total_usd"] == 30.0
    assert body["over_time"][0]["session_count"] == 1
    assert body["over_time"][0]["priced_session_count"] == 1


def test_cost_analytics_endpoint_rejects_oversized_or_invalid_date_range(
    client: TestClient,
) -> None:
    oversized = client.get(
        "/api/analytics/cost",
        params={"date_from": "1900-01-01", "date_to": "2100-12-31"},
    )
    invalid = client.get(
        "/api/analytics/cost",
        params={"date_from": "not-a-date"},
    )

    assert oversized.status_code == 400
    assert "too many buckets" in oversized.json()["detail"]
    assert invalid.status_code == 400
    assert "date_from" in invalid.json()["detail"]


@pytest.mark.parametrize("endpoint", ["/api/analytics/cost", "/api/team/analytics/cost"])
def test_cost_endpoints_accept_representable_early_dates(client: TestClient, endpoint: str) -> None:
    response = client.get(endpoint, params={"date_from": "0001-01-01", "date_to": "0001-01-02"})

    assert response.status_code == 200
    assert [row["bucket"] for row in response.json()["over_time"]] == ["0001-01-01", "0001-01-02"]
    assert response.json()["meta"]["total_usd"] == 0


@pytest.mark.parametrize("endpoint", ["/api/analytics/cost", "/api/team/analytics/cost"])
@pytest.mark.parametrize(
    ("date_from", "date_to"),
    [("2026-05-01", "2026-05-03T00:00:00Z"), ("2026-05-01T00:00:00Z", "2026-05-03")],
)
def test_cost_endpoints_accept_mixed_date_and_timestamp_bounds(
    client: TestClient, endpoint: str, date_from: str, date_to: str,
) -> None:
    response = client.get(endpoint, params={"date_from": date_from, "date_to": date_to})

    assert response.status_code == 200
    assert response.json()["meta"]["bucket"] == "day"


@pytest.mark.parametrize("endpoint", ["/api/analytics/cost", "/api/team/analytics/cost"])
@pytest.mark.parametrize(
    ("date_from", "date_to"),
    [
        ("9999-12-30", "9999-12-31"),
        ("9999-12-31T12:00:00Z", "9999-12-31T23:59:59.999Z"),
        ("9999-09-01", "9999-12-30"),
        ("0001-01-01T00:00:00+01:00", "0001-01-02T00:00:00Z"),
        ("0001-01-01T00:00:00+01:00", "0001-01-02"),
    ],
)
def test_cost_endpoints_reject_unrepresentable_calendar_arithmetic(
    client: TestClient, endpoint: str, date_from: str, date_to: str,
) -> None:
    response = client.get(endpoint, params={"date_from": date_from, "date_to": date_to})

    assert response.status_code == 400
    assert "calendar bounds" in response.json()["detail"]


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


def test_session_findings_endpoint_uses_exact_score_free_contract(client: TestClient) -> None:
    response = client.get("/api/sessions/1/findings")

    assert response.status_code == 200
    assert response.json() == [
        {
            "id": 1,
            "session_id": 1,
            "detector_key": "timeout",
            "basis": "observed",
            "category": "execution_failure",
            "title": "Tool call timed out",
            "explanation": "The tool exceeded its time limit.",
            "recommendation": None,
            "start_event_id": 2,
            "end_event_id": 2,
            "evidence_event_ids": [2],
            "evidence": {"event_ids": [2, 2], "tool_name": "Bash"},
        }
    ]
    forbidden = {"score", "risk_score", "lift", "support", "pattern", "severity"}
    assert forbidden.isdisjoint(response.json()[0])


def test_session_card_exposes_score_free_finding_summary(client: TestClient) -> None:
    response = client.get("/api/sessions")

    assert response.status_code == 200
    session = next(item for item in response.json() if item["id"] == 1)
    assert session["finding_count"] == 1
    assert session["top_finding_title"] == "Tool call timed out"
    assert session["top_finding_basis"] == "observed"
    assert "pattern_risk_score" not in session
    assert "top_finding_severity" not in session
    assert "loop_count" not in session
    assert "max_repeat" not in session


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
    monkeypatch.setattr(repository, "pricing_path", lambda: baseline)
    monkeypatch.setattr(repository, "pricing_dir", lambda: sheets)

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
            "INSERT INTO messages(event_id, role, model, input_tokens, base_input_tokens, output_tokens)"
            " VALUES(?, 'assistant', 'claude-opus-4-1', 1000000, 1000000, 0)",
            (sid,),
        )
    conn.execute("UPDATE events SET agent_id = 'agent-a' WHERE session_id = 1")
    conn.execute(
        "INSERT INTO subagents(parent_session_id, agent_id, agent_type, event_count, first_ts, last_ts) "
        "VALUES(1, 'agent-a', 'Explore', 2, '2026-01-15T10:00:00Z', '2026-01-15T10:05:00Z')"
    )
    call_event_id = conn.execute("SELECT id FROM events WHERE session_id = 1").fetchone()[0]
    result_event_id = conn.execute(
        "INSERT INTO events(session_id, source_path, line_no, type, timestamp, agent_id, raw_json) "
        "VALUES(1, 'f', 100, 'user', '2026-01-15T10:05:00Z', 'agent-a', '{}')"
    ).lastrowid
    conn.execute(
        "INSERT INTO tool_calls(event_id, session_id, tool_use_id, tool_name, raw_json) "
        "VALUES(?, 1, 'read-1', 'Read', '{}')",
        (call_event_id,),
    )
    persisted_id = conn.execute(
        "INSERT INTO persisted_outputs(session_id, path, size_bytes) VALUES(1, 'large-output.txt', 4321)"
    ).lastrowid
    conn.execute(
        "INSERT INTO tool_results(event_id, session_id, tool_use_id, is_error, persisted_output_id, raw_json) "
        "VALUES(?, 1, 'read-1', 1, ?, '{\"content\":\"abc\"}')",
        (result_event_id, persisted_id),
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


def test_cost_analytics_query_param_overrides_persisted_setting(toggle_client: TestClient) -> None:
    # An explicit ?historical= wins over the persisted setting so the request URL
    # itself encodes the mode (no two modes share a cacheable URL).
    toggle_client.put("/api/settings", json={"historical_pricing": True})
    off = toggle_client.get("/api/analytics/cost", params={"historical": "false"}).json()
    on = toggle_client.get("/api/analytics/cost", params={"historical": "true"}).json()
    assert round(off["meta"]["total_usd"], 2) == 10.0  # current rate for both
    assert round(on["meta"]["total_usd"], 2) == 20.0  # date-effective
    # No param → falls back to the persisted setting (ON → 20).
    assert round(toggle_client.get("/api/analytics/cost").json()["meta"]["total_usd"], 2) == 20.0


def test_session_activity_endpoints_expose_receipt_backed_fields_and_pricing_mode(
    toggle_client: TestClient,
) -> None:
    historical = toggle_client.get("/api/sessions/1/subagents", params={"historical": "true"})
    current = toggle_client.get("/api/sessions/1/subagents", params={"historical": "false"})

    assert historical.status_code == 200
    assert current.status_code == 200
    assert historical.json()[0] == {
        "id": 1,
        "agent_id": "agent-a",
        "agent_type": "Explore",
        "description": None,
        "name": None,
        "tool_use_id": None,
        "event_count": 2,
        "first_ts": "2026-01-15T10:00:00Z",
        "last_ts": "2026-01-15T10:05:00Z",
        "input_tokens": 1_000_000,
        "output_tokens": 0,
        "error_count": 1,
        "api_equivalent_usd": 15.0,
        "cost_available": True,
        "unpriced_models": [],
    }
    assert current.json()[0]["api_equivalent_usd"] == 5.0

    tools = toggle_client.get("/api/sessions/1/tool-activity")
    assert tools.status_code == 200
    assert tools.json() == [
        {
            "tool_name": "Read",
            "call_count": 1,
            "error_count": 1,
            "observed_result_bytes": len('{"content":"abc"}'.encode("utf-8")),
            "persisted_result_bytes": 4321,
        }
    ]


@pytest.fixture()
def usage_map_toggle_client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Client seeded identically to toggle_client but with usage_map pricing monkeypatched."""
    # --- pricing setup: baseline $15/M, post-2026-07-01 sheet $5/M ---
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
    # Monkeypatch the usage_map module's imported callables (it does
    # `from ccfr.config import pricing_path, pricing_dir` so we must patch
    # the names on the usage_map module, not on ccfr.config).
    monkeypatch.setattr(usage_map, "pricing_path", lambda: baseline)
    monkeypatch.setattr(usage_map, "pricing_dir", lambda: sheets)
    # Also patch analytics for routes that still call analytics.*
    monkeypatch.setattr(analytics, "pricing_path", lambda: baseline)
    monkeypatch.setattr(analytics, "pricing_dir", lambda: sheets)

    # --- settings isolation ---
    monkeypatch.setattr(settings_mod, "data_dir", lambda: tmp_path)

    # --- DB: two sessions, 1M base-input each, Jan + Aug 2026, claude-opus-4-1 ---
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


def test_usage_map_endpoint_respects_historical_toggle(
    usage_map_toggle_client: TestClient,
) -> None:
    usage_map_toggle_client.put("/api/settings", json={"historical_pricing": True})
    on = usage_map_toggle_client.get("/api/analytics/usage-map").json()
    usage_map_toggle_client.put("/api/settings", json={"historical_pricing": False})
    off = usage_map_toggle_client.get("/api/analytics/usage-map").json()
    # historical ON: Jan @ $15 + Aug @ $5 = $20; OFF: both at current $5 = $10
    assert round(on["meta"]["total_usd"], 2) == 20.0
    assert round(off["meta"]["total_usd"], 2) == 10.0
