"""Small persisted app settings (data_dir/settings.json).

Lives outside the rebuildable SQLite DB so it survives `reset_db`. The only
setting today is the historical-pricing toggle.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path

from ccfr.config import data_dir


@dataclass
class Settings:
    historical_pricing: bool = True


def _settings_path() -> Path:
    return data_dir() / "settings.json"


def read_settings() -> Settings:
    path = _settings_path()
    if not path.exists():
        return Settings()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return Settings()
    if not isinstance(raw, dict):
        return Settings()
    return Settings(historical_pricing=bool(raw.get("historical_pricing", True)))


def write_settings(settings: Settings) -> Settings:
    path = _settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(asdict(settings), indent=2), encoding="utf-8")
    return settings
