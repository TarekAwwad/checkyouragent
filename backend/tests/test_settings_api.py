from fastapi.testclient import TestClient

from ccfr import settings as settings_mod
from ccfr.main import create_app


def test_settings_get_default_and_put_round_trip(monkeypatch, tmp_path):
    monkeypatch.setattr(settings_mod, "data_dir", lambda: tmp_path)
    # Build the app fresh (not the import-time module singleton) so it reads the
    # test Host allow-list from conftest rather than a frozen import-time value.
    client = TestClient(create_app())

    got = client.get("/api/settings")
    assert got.status_code == 200
    assert got.json() == {"historical_pricing": True, "privacy_mode": False, "team_export_prefs": {},
                          "plan_history": []}

    put = client.put("/api/settings", json={"historical_pricing": False})
    assert put.status_code == 200
    assert put.json() == {"historical_pricing": False, "privacy_mode": False, "team_export_prefs": {},
                          "plan_history": []}

    assert client.get("/api/settings").json() == {
        "historical_pricing": False, "privacy_mode": False, "team_export_prefs": {}, "plan_history": []
    }


def test_settings_api_round_trips_plan_history(monkeypatch, tmp_path):
    monkeypatch.setattr(settings_mod, "data_dir", lambda: tmp_path)
    client = TestClient(create_app())
    put = client.put("/api/settings", json={
        "historical_pricing": True,
        "privacy_mode": False,
        "team_export_prefs": {},
        "plan_history": [{"plan": "Pro", "start_date": "2026-05-01"}],
    })
    assert put.status_code == 200
    assert put.json()["plan_history"] == [{"plan": "Pro", "start_date": "2026-05-01"}]
    assert client.get("/api/settings").json()["plan_history"] == [
        {"plan": "Pro", "start_date": "2026-05-01"}
    ]


def test_partial_settings_put_preserves_plan_history(monkeypatch, tmp_path):
    monkeypatch.setattr(settings_mod, "data_dir", lambda: tmp_path)
    client = TestClient(create_app())
    client.put("/api/settings", json={
        "historical_pricing": True,
        "privacy_mode": False,
        "team_export_prefs": {},
        "plan_history": [{"plan": "Pro", "start_date": "2026-05-01"}],
    })
    # The shell's toggles send partial payloads; they must not wipe history.
    put = client.put("/api/settings", json={"historical_pricing": False})
    assert put.status_code == 200
    assert put.json()["plan_history"] == [{"plan": "Pro", "start_date": "2026-05-01"}]
    assert client.get("/api/settings").json()["plan_history"] == [
        {"plan": "Pro", "start_date": "2026-05-01"}
    ]
    # An explicit empty list still clears it.
    client.put("/api/settings", json={"historical_pricing": False, "privacy_mode": False,
                                      "team_export_prefs": {}, "plan_history": []})
    assert client.get("/api/settings").json()["plan_history"] == []
