from ccfr import settings as settings_mod
from ccfr.settings import Settings, read_settings, write_settings


def test_defaults_when_file_absent(monkeypatch, tmp_path):
    monkeypatch.setattr(settings_mod, "data_dir", lambda: tmp_path)
    assert read_settings() == Settings(historical_pricing=True)


def test_round_trip(monkeypatch, tmp_path):
    monkeypatch.setattr(settings_mod, "data_dir", lambda: tmp_path)
    write_settings(Settings(historical_pricing=False))
    assert read_settings().historical_pricing is False
    assert (tmp_path / "settings.json").exists()


def test_corrupt_file_falls_back_to_defaults(monkeypatch, tmp_path):
    monkeypatch.setattr(settings_mod, "data_dir", lambda: tmp_path)
    (tmp_path / "settings.json").write_text("{not json", encoding="utf-8")
    assert read_settings() == Settings(historical_pricing=True)


def test_contributor_identity_mints_and_persists(tmp_path, monkeypatch):
    import ccfr.settings as settings_mod
    monkeypatch.setattr(settings_mod, "data_dir", lambda: tmp_path)

    salt1, cid1 = settings_mod.contributor_identity()
    # 32 bytes hex = 64 chars (>=128-bit); UUID4 has 4 dashes.
    assert len(salt1) == 64
    assert cid1.count("-") == 4

    # Stable across calls (persisted, not regenerated).
    salt2, cid2 = settings_mod.contributor_identity()
    assert (salt1, cid1) == (salt2, cid2)

    # Survives an unrelated settings write (e.g. toggling historical pricing).
    settings_mod.write_settings(settings_mod.Settings(historical_pricing=False))
    loaded = settings_mod.read_settings()
    assert loaded.contributor_salt == salt1
    assert loaded.contributor_id == cid1


def test_write_settings_does_not_mutate_input(tmp_path, monkeypatch):
    import ccfr.settings as settings_mod
    monkeypatch.setattr(settings_mod, "data_dir", lambda: tmp_path)
    # Persist an identity first.
    salt, cid = settings_mod.contributor_identity()
    # A bare write should preserve identity on disk WITHOUT mutating the arg.
    arg = settings_mod.Settings(historical_pricing=False)
    settings_mod.write_settings(arg)
    assert arg.contributor_salt is None and arg.contributor_id is None  # input untouched
    reloaded = settings_mod.read_settings()
    assert reloaded.contributor_salt == salt and reloaded.contributor_id == cid  # disk preserved
