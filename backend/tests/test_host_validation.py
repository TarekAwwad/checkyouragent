from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from ccfr.main import create_app


def _client(monkeypatch, tmp_path: Path, allowed: str, base_url: str) -> TestClient:
    # Overrides the suite-wide allow-list from conftest (later monkeypatch wins).
    monkeypatch.setenv("CCFR_ALLOWED_HOSTS", allowed)
    monkeypatch.setenv("CCFR_DB_PATH", str(tmp_path / "host.sqlite3"))
    monkeypatch.setenv("CCFR_DATA_DIR", str(tmp_path / "data"))
    return TestClient(create_app(), base_url=base_url)


def test_loopback_host_is_accepted(monkeypatch, tmp_path):
    with _client(monkeypatch, tmp_path, "localhost,127.0.0.1", "http://localhost:8000") as client:
        assert client.get("/api/config").status_code == 200


def test_foreign_host_is_rejected(monkeypatch, tmp_path):
    # DNS-rebinding shape: a page the user visited rebinds its domain to
    # 127.0.0.1, so the request reaches the app but still carries the attacker's
    # Host header. The guard must refuse it before any handler runs.
    with _client(monkeypatch, tmp_path, "localhost,127.0.0.1", "http://evil.example:8000") as client:
        assert client.get("/api/config").status_code == 400


def test_wildcard_disables_the_guard(monkeypatch, tmp_path):
    # The escape hatch for deliberate network exposure (serve --host sets this).
    with _client(monkeypatch, tmp_path, "*", "http://evil.example:8000") as client:
        assert client.get("/api/config").status_code == 200
