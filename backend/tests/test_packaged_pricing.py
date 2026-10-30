from __future__ import annotations

import json
import re
import runpy
import shutil
from pathlib import Path

import pytest

from ccfr import config
from ccfr.analysis.pricing import load_price_timeline


def test_staged_history_is_available_to_installed_apps(tmp_path, monkeypatch):
    root = Path(__file__).resolve().parents[2]
    build = runpy.run_path(str(root / "scripts" / "build_webui.py"))
    stage = build["stage_data_assets"]
    assets = tmp_path / "assets"
    monkeypatch.setitem(stage.__globals__, "ASSETS", assets)
    stage()

    shipped = root / "pricing"
    snapshots = [shipped / name for name in json.loads((shipped / "manifest.json").read_text())]
    assert snapshots
    for snapshot in snapshots:
        assert (assets / "pricing" / snapshot.name).read_bytes() == snapshot.read_bytes()

    monkeypatch.setattr(config, "_source_checkout_root", lambda: None)
    monkeypatch.setattr(config, "_packaged_assets_dir", lambda: assets)
    monkeypatch.delenv("CCFR_PRICING_PATH", raising=False)
    monkeypatch.setenv("CCFR_PRICING_DIR", str(tmp_path / "missing-local-history"))
    timeline = load_price_timeline(config.pricing_path(), config.pricing_dir())
    assert timeline.price_for("claude-opus-5-5", "2026-10-29").base_input == 4
    assert timeline.price_for("claude-sonnet-5-5", "2026-10-06").cache_read == 0.20
    assert timeline.price_for("claude-sonnet-5-5", "2026-10-07").cache_read == 0.10


def test_local_files_are_not_staged_for_distribution(tmp_path, monkeypatch):
    root = Path(__file__).resolve().parents[2]
    checkout = tmp_path / "checkout"
    shutil.copytree(root / "pricing", checkout / "pricing")
    shutil.copy2(root / "pricing.csv", checkout / "pricing.csv")
    shutil.copytree(root / "demo", checkout / "demo")
    private_names = ["private-rates.xlsx", "pricing-2099-01-01.csv"]
    for name in private_names:
        (checkout / "pricing" / name).write_text("PRIVATE_SENTINEL")
    build = runpy.run_path(str(root / "scripts" / "build_webui.py"))
    stage = build["stage_data_assets"]
    assets = tmp_path / "assets"
    # Also ensure a prior build's files cannot survive restaging.
    (assets / "pricing").mkdir(parents=True)
    (assets / "pricing" / "old-private.csv").write_text("PRIVATE_SENTINEL")
    monkeypatch.setitem(stage.__globals__, "REPO", checkout)
    monkeypatch.setitem(stage.__globals__, "ASSETS", assets)
    stage()
    expected = set(json.loads((checkout / "pricing" / "manifest.json").read_text()))
    assert {p.name for p in (assets / "pricing").iterdir()} == expected
    assert all(b"PRIVATE_SENTINEL" not in p.read_bytes() for p in assets.rglob("*") if p.is_file())


def test_docker_only_copies_public_pricing_snapshots():
    root = Path(__file__).resolve().parents[2]
    expected = set(json.loads((root / "pricing" / "manifest.json").read_text()))
    dockerfile = (root / "Dockerfile").read_text().replace("\\\n", " ")
    copies = [line.split()[1:] for line in dockerfile.splitlines() if line.startswith("COPY ")]
    sources = [source for args in copies for source in args[:-1]]
    assert {s.removeprefix("pricing/") for s in sources if s.startswith("pricing/")} == expected
    assert not any(s in {".", "./", "pricing", "pricing/"} or "*" in s for s in sources)
    ignore = (root / ".dockerignore").read_text().splitlines()
    assert "pricing/*" in ignore
    assert {s.removeprefix("!pricing/") for s in ignore if s.startswith("!pricing/")} == expected
    assert "backend/src/ccfr/_assets/" in ignore


@pytest.mark.parametrize("name", ["../private.csv", "pricing-2026-10-29.csv"])
def test_rejects_traversal_and_symlinked_public_snapshots(tmp_path, monkeypatch, name):
    root = Path(__file__).resolve().parents[2]
    (tmp_path / "pricing").mkdir()
    (tmp_path / "private.csv").write_text("PRIVATE_SENTINEL")
    (tmp_path / "pricing" / "manifest.json").write_text(json.dumps([name]))
    if re.fullmatch(r"pricing-\d{4}-\d{2}-\d{2}\.csv", name):
        (tmp_path / "pricing" / name).symlink_to(tmp_path / "private.csv")
    stage = runpy.run_path(str(root / "scripts" / "build_webui.py"))["stage_data_assets"]
    monkeypatch.setitem(stage.__globals__, "REPO", tmp_path)
    monkeypatch.setitem(stage.__globals__, "ASSETS", tmp_path / "assets")
    with pytest.raises(ValueError):
        stage()
    assert not (tmp_path / "assets").exists()
