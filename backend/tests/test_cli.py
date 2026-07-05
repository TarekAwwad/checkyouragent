from __future__ import annotations

from pathlib import Path


def test_default_import_root_prefers_env(tmp_path):
    from ccfr import cli

    result = cli.default_import_root(env={"CCFR_IMPORT_ROOT": "/mnt/exports"}, home=tmp_path)
    assert result == "/mnt/exports"


def test_default_import_root_detects_claude_projects(tmp_path):
    from ccfr import cli

    (tmp_path / ".claude" / "projects").mkdir(parents=True)
    result = cli.default_import_root(env={}, home=tmp_path)
    assert result == str(tmp_path / ".claude" / "projects")


def test_default_import_root_falls_back_to_data(tmp_path):
    from ccfr import cli

    result = cli.default_import_root(env={}, home=tmp_path)
    assert result == "./Data"


def test_serve_is_the_default_command(monkeypatch):
    from ccfr import cli

    captured: dict = {}
    monkeypatch.setattr(cli, "_serve", lambda args: captured.update(vars(args)) or 0)
    assert cli.main([]) == 0
    assert captured["command"] == "serve"
    assert captured["host"] == "127.0.0.1"
    assert captured["port"] == 8000


def test_bare_flags_route_to_serve(monkeypatch):
    from ccfr import cli

    captured: dict = {}
    monkeypatch.setattr(cli, "_serve", lambda args: captured.update(vars(args)) or 0)
    cli.main(["--port", "9100", "--demo"])
    assert captured["port"] == 9100
    assert captured["demo"] is True


def test_explicit_serve_flags_parse(monkeypatch):
    from ccfr import cli

    captured: dict = {}
    monkeypatch.setattr(cli, "_serve", lambda args: captured.update(vars(args)) or 0)
    cli.main(["serve", "--host", "0.0.0.0", "--port", "8123", "--no-browser", "--data-dir", "/tmp/d"])
    assert captured["host"] == "0.0.0.0"
    assert captured["port"] == 8123
    assert captured["no_browser"] is True
    assert captured["data_dir"] == "/tmp/d"
