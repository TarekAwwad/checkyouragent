from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient


def _make_webui(directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "index.html").write_text(
        "<!doctype html><title>Demo SPA</title><div id=root></div>", encoding="utf-8")
    assets = directory / "assets"
    assets.mkdir()
    (assets / "app.js").write_text("console.log('demo-spa');", encoding="utf-8")


@pytest.fixture()
def spa_client(tmp_path, monkeypatch):
    webui = tmp_path / "webui"
    _make_webui(webui)
    # A file sitting just outside the webui root -- a traversal must not reach it.
    (tmp_path / "secret.txt").write_text("TOP-SECRET", encoding="utf-8")
    monkeypatch.setenv("CCFR_WEBUI_DIR", str(webui))
    monkeypatch.setenv("CCFR_DB_PATH", str(tmp_path / "static.sqlite3"))
    monkeypatch.setenv("CCFR_DATA_DIR", str(tmp_path / "data"))
    from ccfr.main import create_app

    with TestClient(create_app()) as client:
        yield client


def test_root_serves_index(spa_client):
    resp = spa_client.get("/")
    assert resp.status_code == 200
    assert "Demo SPA" in resp.text


def test_client_route_falls_back_to_index(spa_client):
    resp = spa_client.get("/cost")
    assert resp.status_code == 200
    assert "Demo SPA" in resp.text


def test_assets_are_served(spa_client):
    resp = spa_client.get("/assets/app.js")
    assert resp.status_code == 200
    assert "demo-spa" in resp.text


def test_api_is_not_shadowed(spa_client):
    resp = spa_client.get("/api/config")
    assert resp.status_code == 200
    assert "import_root" in resp.json()


def test_encoded_traversal_does_not_escape_webui_root(spa_client):
    # Percent-encoded ``..`` segments survive httpx normalization and reach the
    # handler as ``../secret.txt``; the containment check must fall back to the
    # SPA shell instead of serving the file above the webui root.
    resp = spa_client.get("/%2e%2e/secret.txt")
    assert resp.status_code == 200
    assert "TOP-SECRET" not in resp.text
    assert "Demo SPA" in resp.text


def test_api_only_when_webui_absent(tmp_path, monkeypatch):
    monkeypatch.setenv("CCFR_WEBUI_DIR", str(tmp_path / "absent"))
    monkeypatch.setenv("CCFR_DB_PATH", str(tmp_path / "static2.sqlite3"))
    monkeypatch.setenv("CCFR_DATA_DIR", str(tmp_path / "data2"))
    from ccfr.main import create_app

    with TestClient(create_app()) as client:
        assert client.get("/api/config").status_code == 200
        # No SPA fallback registered -> an unknown path 404s (not index.html).
        assert client.get("/definitely-not-a-route").status_code == 404
