from __future__ import annotations

import json
import sqlite3

import pytest
from fastapi.testclient import TestClient

from ccfr.api.deps import get_db
from ccfr.ingest import import_export
from ccfr.main import create_app
from ccfr.storage import init_db
from tests.fixtures import sanitized_export


@pytest.fixture
def client(tmp_path, monkeypatch):
    import ccfr.settings as settings_mod
    import ccfr.config as config_mod
    monkeypatch.setattr(settings_mod, "data_dir", lambda: tmp_path)
    monkeypatch.setattr(config_mod, "data_dir", lambda: tmp_path)

    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    init_db(conn)
    import_export(conn, sanitized_export(tmp_path))

    app = create_app()
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app)
    conn.close()


def test_preview_returns_manifest_and_bundle(client):
    resp = client.get("/api/contribution/preview")
    assert resp.status_code == 200
    body = resp.json()
    assert body["manifest"]["session_count"] == 3
    assert len(body["bundle"]["sessions"]) == 3
    # No sentinel-style content; spot-check a fixture path is absent.
    assert "/workspace/alpha" not in json.dumps(body)


def test_export_writes_local_file(client, tmp_path):
    resp = client.post("/api/contribution/export")
    assert resp.status_code == 200
    path = resp.json()["path"]
    written = (tmp_path / "contributions")
    assert written.is_dir()
    files = list(written.glob("contribution-*.json"))
    assert len(files) == 1 and str(files[0]) == path
    parsed = json.loads(files[0].read_text(encoding="utf-8"))
    assert parsed["schema_version"] == 1


@pytest.mark.skip(
    reason=(
        "socket.socket cannot be patched on Windows+asyncio: the ProactorEventLoop "
        "calls socket.socketpair() during self-pipe setup BEFORE the ASGI handler runs, "
        "so the guard fires against the TestClient infrastructure, not the export code. "
        "See review fix-D report: a narrower guard (e.g. httpx-level or urllib3-level) "
        "is needed on this platform."
    )
)
def test_export_makes_no_network_calls(client, tmp_path, monkeypatch):
    import socket
    def _no_socket(*args, **kwargs):
        raise AssertionError("contribution export must not open a network socket")
    monkeypatch.setattr(socket, "socket", _no_socket)
    resp = client.post("/api/contribution/export")
    assert resp.status_code == 200
    written = list((tmp_path / "contributions").glob("contribution-*.json"))
    assert len(written) >= 1
