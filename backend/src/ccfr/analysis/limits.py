"""Limit hits and 5-hour-window economics, computed on read.

Subscription limit hits are already ingested: each one is an assistant event
whose raw_json carries error == "rate_limit" (HTTP 429) and whose message row
has model '<synthetic>' with the limit text in text_preview. This module
detects those events, folds all assistant usage into 5-hour windows priced by
the shared pricing timeline, and derives the measured cap zones.

Corpus-wide by design: limits are account-level, so there is no project
filter. Computation is on-demand from the rebuildable SQLite cache, like
usage_characteristics.py.
Design doc: docs/superpowers/specs/2026-07-12-limit-hits-explore-design.md
"""

from __future__ import annotations

import json
import re
import sqlite3
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from statistics import median
from typing import Any
from zoneinfo import ZoneInfo

from ccfr.analysis.pricing import load_price_timeline
from ccfr.analysis.usage_map import load_events
from ccfr.config import pricing_dir, pricing_path

SYNTHETIC_MODEL = "<synthetic>"
WINDOW_SPAN = timedelta(hours=5)
# A parsed reset stamp may sit slightly past start+5h (stamps are rounded and
# the window start is inferred from the first logged call). Snap within this.
SNAP_TOLERANCE = timedelta(minutes=30)
NEAR_MISS_RATIO = 0.6
RECENT_DAYS = 28
_DEDUP_BUCKET_S = 300  # fallback dedup bucket for hits without a reset stamp

METHOD_NOTE = (
    "Account-level view: 5-hour windows are shared across every project and "
    "Claude surface, so this page always covers the whole corpus. Dollars are "
    "API-equivalent value, not an invoice. Hit counts are a lower bound (only "
    "hits recorded inside exported sessions are visible), and usage outside "
    "Claude Code shares the same pool but is invisible here. Fable 5 usage "
    "after 2026-07-12 bills as usage credits and no longer counts against "
    "these caps."
)


def classify_hit_text(text: str) -> str:
    """Bucket a rate-limit message by which cap it reports."""
    lowered = (text or "").lower()
    if "session limit" in lowered:
        return "session"
    if "weekly" in lowered:
        return "weekly"
    if "monthly" in lowered or "org" in lowered:
        return "org"
    return "unknown"


_RESET_RE = re.compile(
    r"resets\s+(?P<hour>\d{1,2})(?::(?P<minute>\d{2}))?\s*(?P<ampm>am|pm)"
    r"(?:\s*\((?P<tz>[^)]+)\))?",
    re.IGNORECASE,
)


def parse_reset_at(text: str, hit_at: datetime) -> datetime | None:
    """Absolute reset time from "resets 12:30pm (Europe/Paris)"-style text.

    The wall-clock time is anchored in the named timezone; without one the
    stamp is ambiguous and we return None (the hit still counts, its blocked
    time is just unknown). Rolls to the next day when the parsed time is not
    after the hit.
    """
    match = _RESET_RE.search(text or "")
    if not match or not match.group("tz"):
        return None
    try:
        tz = ZoneInfo(match.group("tz").strip())
    except Exception:  # unknown/garbled zone name: treat as unparsed
        return None
    hour = int(match.group("hour")) % 12
    if match.group("ampm").lower() == "pm":
        hour += 12
    minute = int(match.group("minute") or 0)
    local_hit = hit_at.astimezone(tz)
    candidate = local_hit.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if candidate <= local_hit:
        candidate += timedelta(days=1)
    return candidate.astimezone(timezone.utc)


def _parse_ts(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        parsed = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed
