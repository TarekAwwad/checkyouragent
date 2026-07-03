from pathlib import Path

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
