"""Small persisted app settings (data_dir/settings.json).

Lives outside the rebuildable SQLite DB so it survives `reset_db`.
"""
from __future__ import annotations

import json
import secrets
import uuid
from dataclasses import asdict, dataclass, replace
from pathlib import Path

from ccfr.config import data_dir


@dataclass
class Settings:
    historical_pricing: bool = True
    privacy_mode: bool = False
    contributor_salt: str | None = None
    contributor_id: str | None = None
    # Monotonic per-member counter for team bundle exports, used to order
    # same-day bundles (generated_at alone is date-only). Incremented on
    # /team/export, never on the preview endpoint.
    team_bundle_seq: int = 0


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
    return Settings(
        historical_pricing=bool(raw.get("historical_pricing", True)),
        privacy_mode=bool(raw.get("privacy_mode", False)),
        contributor_salt=raw.get("contributor_salt"),
        contributor_id=raw.get("contributor_id"),
        team_bundle_seq=int(raw.get("team_bundle_seq", 0) or 0),
    )


def write_settings(settings: Settings) -> Settings:
    path = _settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    # Preserve existing contributor identity if the incoming settings omits it.
    # Use replace() to create a copy so we don't mutate the caller's object.
    to_write = settings
    if settings.contributor_salt is None or settings.contributor_id is None:
        existing = read_settings()
        to_write = replace(
            settings,
            contributor_salt=settings.contributor_salt or existing.contributor_salt,
            contributor_id=settings.contributor_id or existing.contributor_id,
        )
    path.write_text(json.dumps(asdict(to_write), indent=2), encoding="utf-8")
    return to_write


def contributor_identity() -> tuple[str, str]:
    """Return (salt, contributor_id), minting and persisting them once.

    salt: 256-bit CSPRNG hex (never leaves the machine, never bundled).
    contributor_id: random UUID4 (not derived from any machine attribute).
    """
    settings = read_settings()
    changed = False
    if not settings.contributor_salt:
        settings.contributor_salt = secrets.token_hex(32)
        changed = True
    if not settings.contributor_id:
        settings.contributor_id = str(uuid.uuid4())
        changed = True
    if changed:
        write_settings(settings)
    return settings.contributor_salt, settings.contributor_id
