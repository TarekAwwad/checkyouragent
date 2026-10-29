from __future__ import annotations

import runpy
from pathlib import Path

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
    snapshots = list(shipped.glob("pricing-*.csv"))
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
