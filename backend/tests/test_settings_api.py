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
    assert got.json() == {"historical_pricing": True, "privacy_mode": False, "team_export_prefs": {}}

    put = client.put("/api/settings", json={"historical_pricing": False})
    assert put.status_code == 200
    assert put.json() == {"historical_pricing": False, "privacy_mode": False, "team_export_prefs": {}}

    assert client.get("/api/settings").json() == {
        "historical_pricing": False, "privacy_mode": False, "team_export_prefs": {}
    }
