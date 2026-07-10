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


def test_cya_banner_plain_is_ascii_with_no_escapes():
    from ccfr import cli

    banner = cli._cya_banner(color=False)
    assert banner == (
        "CYA - Check Your Agent  //  Cover Your Assets\n"
        "Source-available forensics for AI coding-agent spend. Runs local; "
        "nothing leaves this machine.\n"
        "https://checkyouragent.dev"
    )
    assert banner.isascii()
    assert "\x1b" not in banner


def test_cya_banner_color_wraps_only_cya_and_cover_your_assets():
    from ccfr import cli

    banner = cli._cya_banner(color=True)
    assert "\x1b[92mCYA\x1b[0m" in banner
    assert "\x1b[92mCover Your Assets\x1b[0m" in banner
    # the connective text between the two colored spans stays plain
    assert " - Check Your Agent  //  " in banner


def test_serve_prints_the_cya_banner(monkeypatch, tmp_path, capsys):
    from ccfr import cli

    monkeypatch.setenv("CCFR_IMPORT_ROOT", str(tmp_path / "imports"))
    monkeypatch.setenv("CCFR_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr("uvicorn.run", lambda *a, **k: None)
    assert cli.main(["serve", "--no-browser"]) == 0
    assert "Cover Your Assets" in capsys.readouterr().out


def test_export_bundle_does_not_print_the_cya_banner(monkeypatch, capsys):
    from ccfr import cli, cli_export

    monkeypatch.setattr(cli_export, "run_export_bundle", lambda args: 0)
    assert cli.main(["export-bundle"]) == 0
    assert "Cover Your Assets" not in capsys.readouterr().out


class _FakeTty:
    def __init__(self, tty: bool) -> None:
        self._tty = tty

    def isatty(self) -> bool:
        return self._tty


def _color_probe_env(monkeypatch, *, tty: bool, platform: str) -> None:
    """Pin stdout/platform and clear every env var _supports_color() reads."""
    import sys

    monkeypatch.setattr(sys, "stdout", _FakeTty(tty))
    monkeypatch.setattr(sys, "platform", platform)
    for name in ("NO_COLOR", "WT_SESSION", "ANSICON", "TERM"):
        monkeypatch.delenv(name, raising=False)


def test_supports_color_requires_a_tty(monkeypatch):
    from ccfr import cli

    _color_probe_env(monkeypatch, tty=False, platform="linux")
    assert cli._supports_color() is False


def test_supports_color_honors_no_color_even_when_empty(monkeypatch):
    from ccfr import cli

    _color_probe_env(monkeypatch, tty=True, platform="linux")
    monkeypatch.setenv("NO_COLOR", "")
    assert cli._supports_color() is False


def test_supports_color_survives_a_detached_stdout(monkeypatch):
    import sys

    from ccfr import cli

    monkeypatch.setattr(sys, "stdout", None)
    assert cli._supports_color() is False


def test_supports_color_on_win32_needs_a_vt_terminal(monkeypatch):
    from ccfr import cli

    _color_probe_env(monkeypatch, tty=True, platform="win32")
    assert cli._supports_color() is False
    monkeypatch.setenv("WT_SESSION", "guid")
    assert cli._supports_color() is True


def test_supports_color_on_non_win32_needs_only_a_tty(monkeypatch):
    from ccfr import cli

    _color_probe_env(monkeypatch, tty=True, platform="linux")
    assert cli._supports_color() is True
