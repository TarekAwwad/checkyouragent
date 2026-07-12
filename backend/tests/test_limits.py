from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone

from ccfr.analysis.limits import (
    classify_hit_text,
    parse_reset_at,
)


def _utc(text: str) -> datetime:
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------

def test_classify_session_weekly_org_unknown() -> None:
    assert classify_hit_text(
        "You've hit your session limit · resets 12:30pm (Europe/Paris)") == "session"
    assert classify_hit_text("You've hit your weekly limit · resets Tuesday") == "weekly"
    assert classify_hit_text("Your org has hit its monthly usage limit") == "org"
    assert classify_hit_text("Something rate-limited happened") == "unknown"
    assert classify_hit_text("") == "unknown"


# ---------------------------------------------------------------------------
# Reset-stamp parsing
# ---------------------------------------------------------------------------

def test_parse_reset_same_day() -> None:
    # Hit at 09:40:44 UTC = 11:40 in Paris (July, UTC+2). Reset 12:30pm Paris = 10:30 UTC.
    hit = _utc("2026-07-03T09:40:44Z")
    reset = parse_reset_at(
        "You've hit your session limit · resets 12:30pm (Europe/Paris)", hit)
    assert reset == _utc("2026-07-03T10:30:00Z")


def test_parse_reset_rolls_to_next_day() -> None:
    # Hit at 22:00 UTC = 00:00 Paris next day; "resets 2am" is 2h later, not 22h earlier.
    hit = _utc("2026-07-03T22:00:00Z")
    reset = parse_reset_at("You've hit your session limit · resets 2am (Europe/Paris)", hit)
    assert reset == _utc("2026-07-04T00:00:00Z")


def test_parse_reset_hour_only_and_capitalized() -> None:
    hit = _utc("2026-05-20T14:00:00Z")
    reset = parse_reset_at("You've hit your session limit. Resets 5pm (UTC)", hit)
    assert reset == _utc("2026-05-20T17:00:00Z")


def test_parse_reset_without_timezone_returns_none() -> None:
    hit = _utc("2026-05-20T14:00:00Z")
    assert parse_reset_at("You've hit your session limit — resets 5pm", hit) is None


def test_parse_reset_unknown_timezone_or_garbage_returns_none() -> None:
    hit = _utc("2026-05-20T14:00:00Z")
    assert parse_reset_at("resets 5pm (Middle/Nowhere)", hit) is None
    assert parse_reset_at("You've hit your session limit", hit) is None
    assert parse_reset_at("", hit) is None
