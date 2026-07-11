from __future__ import annotations

from ccfr import config
from ccfr.main import create_app


def test_app_version_is_single_sourced_from_config(monkeypatch):
    # Pins the FastAPI app version to ccfr.config.app_version() so a future
    # release bump (which only touches pyproject.toml / package metadata)
    # can't drift from a stale hardcoded string in main.py.
    monkeypatch.setattr(config, "_pkg_version", lambda _name: "9.9.9-test")
    app = create_app()
    assert app.version == config.app_version()
    assert app.version == "9.9.9-test"
