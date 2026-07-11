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


@pytest.fixture(autouse=True)
def allow_testclient_host(monkeypatch):
    """Permit the Host that TestClient sends so the Host-header guard added in
    create_app() does not 400 every request.

    Starlette's TestClient talks to ``http://testserver`` by default, so its
    requests carry ``Host: testserver``. Add it (plus the real loopback names)
    to the allow-list for the whole suite; tests that exercise the guard itself
    override CCFR_ALLOWED_HOSTS afterward, and the later monkeypatch wins.
    """
    monkeypatch.setenv("CCFR_ALLOWED_HOSTS", "testserver,localhost,127.0.0.1")
