from __future__ import annotations

import pytest

import ccfr.settings as settings_mod


@pytest.fixture(autouse=True)
def isolate_ambient_pricing_state(tmp_path, monkeypatch):
    """Keep tests independent of real on-disk pricing/settings state.

    Cost-bearing tests historically patched ``pricing_path`` but not
    ``pricing_dir``, so a real ``pricing/`` snapshot directory (or a
    ``.ccfr-data/settings.json`` written by the running app) silently changed
    their results. Default both to throwaway locations; a test that needs dated
    snapshots or a specific setting overrides these afterward (later monkeypatch
    wins), so opt-in behavior is unaffected.
    """
    monkeypatch.setenv("CCFR_PRICING_DIR", str(tmp_path / "_ambient_no_pricing"))
    monkeypatch.setattr(settings_mod, "data_dir", lambda: tmp_path / "_ambient_data")
