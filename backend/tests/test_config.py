from pathlib import Path

import pytest

from ccfr import config


def test_pricing_dir_defaults_beside_pricing_csv(monkeypatch):
    monkeypatch.delenv("CCFR_PRICING_DIR", raising=False)
    assert config.pricing_dir() == config.repository_root() / "pricing"


def test_pricing_dir_env_override(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("CCFR_PRICING_DIR", str(tmp_path / "sheets"))
    assert config.pricing_dir() == tmp_path / "sheets"


def test_team_bundle_root_defaults_under_data_dir(monkeypatch, tmp_path: Path):
    monkeypatch.delenv("CCFR_TEAM_BUNDLE_ROOT", raising=False)
    monkeypatch.setenv("CCFR_DATA_DIR", str(tmp_path / "data"))
    assert config.team_bundle_root() == tmp_path / "data" / "team-bundles"


def test_team_bundle_root_env_override(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("CCFR_TEAM_BUNDLE_ROOT", str(tmp_path / "team"))
    assert config.team_bundle_root() == tmp_path / "team"


def test_resolve_within_team_bundle_root_rejects_escape(tmp_path: Path):
    root = tmp_path / "team"
    root.mkdir()
    inside = root / "bundle.json"
    outside = tmp_path / "outside.json"
    inside.write_text("{}", encoding="utf-8")
    outside.write_text("{}", encoding="utf-8")

    assert config.resolve_within_team_bundle_root(str(inside), root) == inside.resolve()
    try:
        config.resolve_within_team_bundle_root(str(outside), root)
    except ValueError as exc:
        assert "team bundle root" in str(exc)
    else:
        raise AssertionError("expected path escape to fail")


def test_demo_dir_defaults_to_repo_demo_export(monkeypatch):
    monkeypatch.delenv("CCFR_DEMO_DIR", raising=False)
    assert config.demo_dir() == config.repository_root() / "demo" / "claude-export"


def test_demo_dir_honors_env_override(monkeypatch, tmp_path):
    monkeypatch.setenv("CCFR_DEMO_DIR", str(tmp_path / "custom-demo"))
    assert config.demo_dir() == tmp_path / "custom-demo"


def test_webui_dir_defaults_to_package_webui(monkeypatch):
    monkeypatch.delenv("CCFR_WEBUI_DIR", raising=False)
    expected = Path(config.__file__).resolve().parent / "webui"
    assert config.webui_dir() == expected


def test_webui_dir_honors_env_override(monkeypatch, tmp_path):
    monkeypatch.setenv("CCFR_WEBUI_DIR", str(tmp_path / "ui"))
    assert config.webui_dir() == tmp_path / "ui"


def _installed_mode(monkeypatch, tmp_path: Path) -> None:
    """Simulate running from an installed wheel: repository_root() resolves to a
    directory that is not a source checkout (no backend/pyproject.toml)."""
    monkeypatch.setattr(config, "repository_root", lambda: tmp_path / "not-a-checkout")


def _packaged_assets() -> Path:
    return Path(config.__file__).resolve().parent / "_assets"


def test_pricing_path_defaults_to_repo_csv_in_checkout(monkeypatch):
    monkeypatch.delenv("CCFR_PRICING_PATH", raising=False)
    assert config.pricing_path() == config.repository_root() / "pricing.csv"


def test_pricing_path_falls_back_to_packaged_asset_when_installed(monkeypatch, tmp_path):
    monkeypatch.delenv("CCFR_PRICING_PATH", raising=False)
    _installed_mode(monkeypatch, tmp_path)
    assert config.pricing_path() == _packaged_assets() / "pricing.csv"


def test_pricing_dir_falls_back_to_data_dir_when_installed(monkeypatch, tmp_path):
    monkeypatch.delenv("CCFR_PRICING_DIR", raising=False)
    monkeypatch.delenv("CCFR_DATA_DIR", raising=False)
    _installed_mode(monkeypatch, tmp_path)
    monkeypatch.setattr(config.Path, "home", staticmethod(lambda: tmp_path / "home"))
    assert config.pricing_dir() == tmp_path / "home" / ".checkyouragent" / "pricing"


def test_demo_dir_falls_back_to_packaged_assets_when_installed(monkeypatch, tmp_path):
    monkeypatch.delenv("CCFR_DEMO_DIR", raising=False)
    _installed_mode(monkeypatch, tmp_path)
    assert config.demo_dir() == _packaged_assets() / "claude-export"


def test_data_dir_defaults_to_repo_dir_in_checkout(monkeypatch):
    monkeypatch.delenv("CCFR_DATA_DIR", raising=False)
    assert config.data_dir() == config.repository_root() / ".ccfr-data"


def test_data_dir_defaults_to_home_dir_when_installed(monkeypatch, tmp_path):
    monkeypatch.delenv("CCFR_DATA_DIR", raising=False)
    _installed_mode(monkeypatch, tmp_path)
    monkeypatch.setattr(config.Path, "home", staticmethod(lambda: tmp_path / "home"))
    assert config.data_dir() == tmp_path / "home" / ".checkyouragent"


def test_data_dir_reports_clear_error_when_home_is_unresolvable(monkeypatch, tmp_path):
    monkeypatch.delenv("CCFR_DATA_DIR", raising=False)
    _installed_mode(monkeypatch, tmp_path)

    def _no_home() -> Path:
        raise RuntimeError("Could not determine home directory.")

    monkeypatch.setattr(config.Path, "home", staticmethod(_no_home))
    with pytest.raises(RuntimeError, match="CCFR_DATA_DIR"):
        config.data_dir()


def test_app_version_reads_from_package_metadata(monkeypatch):
    monkeypatch.setattr(config, "_pkg_version", lambda _name: "9.9.9-test")
    assert config.app_version() == "9.9.9-test"


def test_app_version_falls_back_when_package_missing(monkeypatch):
    from importlib.metadata import PackageNotFoundError

    def _raise(_name):
        raise PackageNotFoundError("checkyouragent")

    monkeypatch.setattr(config, "_pkg_version", _raise)
    assert config.app_version() == "0.1.0"
