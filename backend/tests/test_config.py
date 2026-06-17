from pathlib import Path

from ccfr import config


def test_pricing_dir_defaults_beside_pricing_csv(monkeypatch):
    monkeypatch.delenv("CCFR_PRICING_DIR", raising=False)
    assert config.pricing_dir() == config.repository_root() / "pricing"


def test_pricing_dir_env_override(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("CCFR_PRICING_DIR", str(tmp_path / "sheets"))
    assert config.pricing_dir() == tmp_path / "sheets"
