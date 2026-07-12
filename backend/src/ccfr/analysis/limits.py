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


@dataclass
class LimitHit:
    """One deduplicated cap hit (possibly seen as several retry events)."""

    ts: datetime
    kind: str  # session | weekly | org | unknown
    reset_at: datetime | None
    session_ids: list[int] = field(default_factory=list)
    session_titles: list[str] = field(default_factory=list)
    occurrence_count: int = 1
    usage_at_hit: float | None = None  # filled by fold_windows
    window_index: int | None = None  # filled by fold_windows

    @property
    def blocked_minutes(self) -> float | None:
        if self.reset_at is None:
            return None
        return max(0.0, (self.reset_at - self.ts).total_seconds() / 60)


def _hit_text(preview: str, raw: dict) -> str:
    """The limit message text: text_preview when stored, else the raw block."""
    if preview:
        return preview
    content = (raw.get("message") or {}).get("content")
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                return str(block.get("text") or "")
    return ""


def detect_limit_hits(
    conn: sqlite3.Connection,
    *,
    date_from: str | None = None,
    date_to: str | None = None,
) -> list[LimitHit]:
    """All deduplicated limit hits in the corpus, sorted by time.

    Detection is structured-first: '<synthetic>' messages whose event raw_json
    carries error == "rate_limit" (or apiErrorStatus == 429 on older logs).
    Events sharing (kind, reset stamp) are one hit; without a parsed stamp the
    fallback key buckets timestamps into 5-minute slots.
    """
    where = ["m.model = ?"]
    params: list[Any] = [SYNTHETIC_MODEL]
    if date_from:
        where.append("date(e.timestamp) >= date(?)")
        params.append(date_from)
    if date_to:
        where.append("date(e.timestamp) <= date(?)")
        params.append(date_to)
    rows = conn.execute(
        f"""
        SELECT e.timestamp AS ts, e.raw_json AS raw_json,
               COALESCE(m.text_preview, '') AS text,
               s.id AS session_db_id, COALESCE(s.title, '') AS title
        FROM messages m
        JOIN events e ON e.id = m.event_id
        JOIN sessions s ON s.id = e.session_id
        WHERE {' AND '.join(where)}
        ORDER BY e.timestamp, e.id
        """,
        params,
    ).fetchall()

    merged: dict[tuple[str, Any], LimitHit] = {}
    for row in rows:
        try:
            raw = json.loads(row["raw_json"])
        except (json.JSONDecodeError, TypeError):
            raw = {}
        if not isinstance(raw, dict):
            raw = {}
        if raw.get("error") != "rate_limit" and raw.get("apiErrorStatus") != 429:
            continue
        ts = _parse_ts(row["ts"])
        if ts is None:
            continue
        text = _hit_text(row["text"], raw)
        kind = classify_hit_text(text)
        reset_at = parse_reset_at(text, ts)
        key: tuple[str, Any]
        if reset_at is not None:
            key = (kind, reset_at.isoformat())
        else:
            key = (kind, int(ts.timestamp()) // _DEDUP_BUCKET_S)
        hit = merged.get(key)
        if hit is None:
            merged[key] = LimitHit(
                ts=ts, kind=kind, reset_at=reset_at,
                session_ids=[row["session_db_id"]],
                session_titles=[row["title"]],
            )
        else:
            hit.occurrence_count += 1
            hit.ts = min(hit.ts, ts)
            if row["session_db_id"] not in hit.session_ids:
                hit.session_ids.append(row["session_db_id"])
                hit.session_titles.append(row["title"])
    return sorted(merged.values(), key=lambda h: h.ts)


@dataclass(frozen=True)
class UsageEvent:
    """One assistant message reduced to what window folding needs."""

    ts: datetime
    cost: float
    tokens: int


@dataclass
class UsageWindow:
    """One reconstructed 5-hour rate-limit window."""

    start: datetime
    end: datetime
    value_usd: float = 0.0
    tokens: int = 0
    era: str = ""
    hit_kinds: list[str] = field(default_factory=list)


def fold_windows(events: list[UsageEvent], hits: list[LimitHit]) -> list[UsageWindow]:
    """Fold time-sorted events into non-overlapping 5-hour windows.

    A window opens at its first message and ends 5 hours later, except when a
    session hit inside it carries a parsed reset stamp within tolerance: then
    the end snaps to the stamp (measured ground truth beats inference), and
    later events open the next window. Fills usage_at_hit (window value up to
    the hit, not the whole window) and window_index on the hits in place.
    Hits are merged into the event stream by timestamp, so a hit with no
    matching event row still lands in the window that contains it; a hit in
    an activity gap opens its own window (an attempted call is activity).
    `events` and `hits` must both be sorted by ts.
    """
    windows: list[UsageWindow] = []
    current: UsageWindow | None = None
    hit_idx = 0

    def open_window(ts: datetime) -> UsageWindow:
        window = UsageWindow(start=ts, end=ts + WINDOW_SPAN)
        windows.append(window)
        return window

    def attach(hit: LimitHit) -> None:
        hit.window_index = len(windows) - 1
        hit.usage_at_hit = round(current.value_usd, 6)
        current.hit_kinds.append(hit.kind)
        if (
            hit.kind == "session"
            and hit.reset_at is not None
            and current.start < hit.reset_at <= current.start + WINDOW_SPAN + SNAP_TOLERANCE
        ):
            current.end = hit.reset_at

    for event in events:
        while hit_idx < len(hits) and hits[hit_idx].ts < event.ts:
            hit = hits[hit_idx]
            hit_idx += 1
            if current is None or hit.ts >= current.end:
                current = open_window(hit.ts)
            attach(hit)
        if current is None or event.ts >= current.end:
            current = open_window(event.ts)
        current.value_usd += event.cost
        current.tokens += event.tokens
        while hit_idx < len(hits) and hits[hit_idx].ts <= event.ts:
            hit = hits[hit_idx]
            hit_idx += 1
            attach(hit)
    while hit_idx < len(hits):
        hit = hits[hit_idx]
        hit_idx += 1
        if current is None or hit.ts >= current.end:
            current = open_window(hit.ts)
        attach(hit)
    for window in windows:
        window.value_usd = round(window.value_usd, 6)
    return windows


def _era_for(ts: datetime, history: list[dict[str, str]]) -> str:
    """Label for the last plan whose start_date is on or before ts (else "")."""
    day = ts.date().isoformat()
    label = ""
    for row in history:
        if row["start_date"] <= day:
            label = row["plan"]
    return label


def _hit_payload(hit: LimitHit) -> dict[str, Any]:
    blocked = hit.blocked_minutes
    return {
        "ts": hit.ts.isoformat(),
        "kind": hit.kind,
        "reset_at": hit.reset_at.isoformat() if hit.reset_at else None,
        "blocked_minutes": round(blocked, 1) if blocked is not None else None,
        "usage_at_hit": round(hit.usage_at_hit, 4) if hit.usage_at_hit is not None else None,
        "occurrence_count": hit.occurrence_count,
        "window_index": hit.window_index,
        "session_ids": list(hit.session_ids),
        "session_titles": list(hit.session_titles),
    }


def limits_analytics(
    conn: sqlite3.Connection,
    *,
    historical: bool = True,
    date_from: str | None = None,
    date_to: str | None = None,
    plan_history: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    """Limit hits, priced 5-hour windows, and per-era cap zones."""
    history = sorted(
        (
            row for row in (plan_history or [])
            if isinstance(row, dict) and row.get("plan") and row.get("start_date")
        ),
        key=lambda row: row["start_date"],
    )
    timeline = load_price_timeline(pricing_path(), pricing_dir())
    events = load_events(conn, timeline, historical=historical,
                         date_from=date_from, date_to=date_to)
    usage: list[UsageEvent] = []
    costs_partial = False
    for event in events:
        ts = _parse_ts(event.ts)
        if ts is None:
            continue
        if event.model != SYNTHETIC_MODEL and not event.priced:
            costs_partial = True
        usage.append(UsageEvent(ts=ts, cost=event.cost, tokens=event.tokens))
    usage.sort(key=lambda u: u.ts)

    hits = detect_limit_hits(conn, date_from=date_from, date_to=date_to)
    windows = fold_windows(usage, hits)
    for window in windows:
        window.era = _era_for(window.start, history)

    era_order: list[str] = []
    for window in windows:
        if window.era not in era_order:
            era_order.append(window.era)
    if not era_order:
        era_order = [""]

    eras_payload: list[dict[str, Any]] = []
    for era in era_order:
        era_indices = [i for i, w in enumerate(windows) if w.era == era]
        era_windows = [windows[i] for i in era_indices]
        era_hits = [h for h in hits
                    if h.window_index is not None and windows[h.window_index].era == era]
        session_hits = [h for h in era_hits if h.kind == "session"]
        zone = sorted(h.usage_at_hit for h in session_hits if h.usage_at_hit is not None)
        cap_median = round(median(zone), 4) if zone else None
        near_miss = 0
        percentile = None
        if cap_median:
            hit_window_indices = {h.window_index for h in session_hits}
            near_miss = sum(
                1 for i in era_indices
                if i not in hit_window_indices
                and windows[i].value_usd >= NEAR_MISS_RATIO * cap_median
            )
            below = sum(1 for w in era_windows if w.value_usd <= cap_median)
            percentile = round(below / len(era_windows), 4)
        blocked = sum(h.blocked_minutes or 0.0 for h in era_hits)
        eras_payload.append({
            "era": era,
            "window_count": len(era_windows),
            "session_hit_count": len(session_hits),
            "blocked_minutes": round(blocked, 1),
            "cap_median_usd": cap_median,
            "cap_min_usd": round(zone[0], 4) if zone else None,
            "cap_max_usd": round(zone[-1], 4) if zone else None,
            "near_miss_count": near_miss,
            "cap_percentile": percentile,
            "usage_at_hit_usd": [round(v, 4) for v in zone],
        })

    blocked_total = sum(h.blocked_minutes or 0.0 for h in hits)
    last_ts = usage[-1].ts if usage else None
    recent = [h for h in hits
              if last_ts is not None and h.ts >= last_ts - timedelta(days=RECENT_DAYS)]
    return {
        "meta": {
            "window": {"date_from": date_from, "date_to": date_to},
            "cost_available": timeline.has_prices,
            "costs_partial": costs_partial,
            "total_hits": len(hits),
            "total_windows": len(windows),
            "blocked_minutes": round(blocked_total, 1),
            "hits_per_week_recent": round(len(recent) / (RECENT_DAYS / 7), 2),
            "hit_counts": dict(Counter(h.kind for h in hits)),
            "plan_history": history,
            "method_note": METHOD_NOTE,
        },
        "hits": [_hit_payload(h) for h in hits],
        "windows": [
            {
                "start": w.start.isoformat(),
                "end": w.end.isoformat(),
                "value_usd": round(w.value_usd, 4),
                "tokens": w.tokens,
                "era": w.era,
                "hit_kinds": list(w.hit_kinds),
            }
            for w in windows
        ],
        "eras": eras_payload,
    }
