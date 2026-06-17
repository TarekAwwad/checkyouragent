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
