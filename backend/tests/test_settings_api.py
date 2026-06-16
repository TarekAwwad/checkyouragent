from fastapi.testclient import TestClient

from ccfr import settings as settings_mod
from ccfr.main import app


def test_settings_get_default_and_put_round_trip(monkeypatch, tmp_path):
    monkeypatch.setattr(settings_mod, "data_dir", lambda: tmp_path)
    client = TestClient(app)

    got = client.get("/api/settings")
    assert got.status_code == 200
    assert got.json() == {"historical_pricing": True}

    put = client.put("/api/settings", json={"historical_pricing": False})
    assert put.status_code == 200
    assert put.json() == {"historical_pricing": False}

    assert client.get("/api/settings").json() == {"historical_pricing": False}
