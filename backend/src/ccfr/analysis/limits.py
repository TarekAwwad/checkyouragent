"""Limit hits and 5-hour-window economics, computed on read.

Subscription limit hits are already ingested: each one is an assistant event
whose raw_json carries error == "rate_limit" (HTTP 429) and whose message row
has model '<synthetic>' with the limit text in text_preview. This module
detects those events, folds all assistant usage into 5-hour windows priced by
the shared pricing timeline, and derives observed session-hit levels.

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
from collections.abc import Callable, Sequence
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
RECENT_DAYS = 28
_DEDUP_BUCKET_S = 300  # fallback dedup bucket for hits without a reset stamp

METHOD_NOTE = (
    "Account-level view: 5-hour windows are shared across every project and "
    "Claude surface, so this page always covers the whole corpus. Dollars are "
    "API-equivalent value, not an invoice. Hit counts are a lower bound (only "
    "hits recorded inside exported sessions are visible), and usage outside "
    "Claude Code shares the same pool but is invisible here. Time until reset "
    "is the parsed reset timestamp minus the recorded hit timestamp, not "
    "observed downtime."
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
    stamp is ambiguous and we return None (the hit still counts, but remaining
    time until reset is unknown). Rolls to the next day when the parsed time is
    not after the hit.
    """
    match = _RESET_RE.search(text or "")
    if not match or not match.group("tz"):
        return None
    try:
        tz = ZoneInfo(match.group("tz").strip())
    except Exception:  # unknown/garbled zone name: treat as unparsed
        return None
    # hour is bounded by the % 12, but the minute group is \d{2}: "resets 5:99pm"
    # is as garbled as an unknown zone, so it reads as unparsed rather than raising.
    hour = int(match.group("hour")) % 12
    if match.group("ampm").lower() == "pm":
        hour += 12
    minute = int(match.group("minute") or 0)
    if minute > 59:
        return None
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
    usage_at_hit: float | None = None  # API-equivalent USD, filled by fold_windows
    usage_at_hit_tokens: int | None = None  # raw billed-token volume at the hit
    window_index: int | None = None  # filled by fold_windows

    @property
    def minutes_until_reset(self) -> float | None:
        if self.reset_at is None:
            return None
        minutes = (self.reset_at - self.ts).total_seconds() / 60
        return minutes if minutes >= 0 else None


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
    where = ["m.model = ?", "e.is_replay = 0"]
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
    later events open the next window. Fills usage_at_hit and
    usage_at_hit_tokens (window usage up to the hit, not the whole window),
    plus window_index, on the hits in place.
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
        hit.usage_at_hit_tokens = current.tokens
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


@dataclass(frozen=True)
class _PlanPeriod:
    """One stint on a plan: a plan-history entry until the next one starts.

    Keyed by entry, not plan name, so Pro -> Max -> Pro is three periods. The
    leading period (plan "", no start) holds windows logged before the first
    entry; with no history at all it is the only period and has no bounds.
    """

    plan: str
    start_date: str | None  # YYYY-MM-DD, inclusive
    end_date: str | None  # next entry's start_date, exclusive


def _plan_periods(history: list[dict[str, str]]) -> list[_PlanPeriod]:
    periods = [_PlanPeriod("", None, history[0]["start_date"] if history else None)]
    for i, row in enumerate(history):
        end = history[i + 1]["start_date"] if i + 1 < len(history) else None
        periods.append(_PlanPeriod(row["plan"], row["start_date"], end))
    return periods


def _period_index_for(ts: datetime, periods: list[_PlanPeriod]) -> int:
    """Index of the last period whose start_date is on or before ts's UTC day.

    Plan dates are UTC calendar days, the same boundaries _period_weeks uses,
    so the timestamp is read in UTC whatever offset it was logged with.
    """
    day = ts.astimezone(timezone.utc).date().isoformat()
    index = 0
    for i, period in enumerate(periods):
        if period.start_date is not None and period.start_date <= day:
            index = i
    return index


def _day_start(day: str) -> datetime:
    return datetime.fromisoformat(day).replace(tzinfo=timezone.utc)


def _period_weeks(
    period: _PlanPeriod, logs_from: datetime, logs_to: datetime,
) -> float:
    """Calendar weeks the period overlaps the logs, floored at one week.

    Clipped to the logged span: hits before the first export or after the last
    one are invisible, so that time must not dilute the rate. The floor keeps
    a young period from extrapolating a single day into a wild weekly rate.
    """
    start = logs_from
    if period.start_date is not None:
        start = max(start, _day_start(period.start_date))
    end = logs_to
    if period.end_date is not None:
        end = min(end, _day_start(period.end_date))
    return max((end - start) / timedelta(weeks=1), 1.0)


def _hit_payload(hit: LimitHit) -> dict[str, Any]:
    minutes_until_reset = hit.minutes_until_reset
    return {
        "ts": hit.ts.isoformat(),
        "kind": hit.kind,
        "reset_at": hit.reset_at.isoformat() if hit.reset_at else None,
        "minutes_until_reset": (
            round(minutes_until_reset, 1) if minutes_until_reset is not None else None
        ),
        "usage_at_hit": round(hit.usage_at_hit, 4) if hit.usage_at_hit is not None else None,
        "usage_at_hit_tokens": hit.usage_at_hit_tokens,
        "occurrence_count": hit.occurrence_count,
        "window_index": hit.window_index,
        "session_ids": list(hit.session_ids),
        "session_titles": list(hit.session_titles),
    }


@dataclass(frozen=True)
class _HitLevelStats:
    median: float | None
    percentile: float | None


def _hit_level_stats(
    observed_levels: Sequence[float],
    windows: Sequence[UsageWindow],
    value_of: Callable[[UsageWindow], float],
) -> _HitLevelStats:
    """Observed median hit level and its window percentile for one basis.

    A zero median means the recorded hits carried no visible usage (the shared
    pool may have filled elsewhere), so its percentile is not informative.
    """
    if not observed_levels:
        return _HitLevelStats(None, None)
    observed_median = median(observed_levels)
    if observed_median <= 0 or not windows:
        return _HitLevelStats(observed_median, None)
    below = sum(1 for window in windows if value_of(window) <= observed_median)
    return _HitLevelStats(observed_median, round(below / len(windows), 4))


def limits_analytics(
    conn: sqlite3.Connection,
    *,
    historical: bool = True,
    date_from: str | None = None,
    date_to: str | None = None,
    plan_history: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    """Limit receipts, priced five-hour windows, and observed hit levels."""
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
        if event.model == SYNTHETIC_MODEL:
            continue
        if not event.priced:
            costs_partial = True
        usage.append(UsageEvent(ts=ts, cost=event.cost, tokens=event.tokens))
    usage.sort(key=lambda u: u.ts)

    hits = detect_limit_hits(conn, date_from=date_from, date_to=date_to)
    session_hits = [hit for hit in hits if hit.kind == "session"]
    windows = fold_windows(usage, session_hits)
    periods = _plan_periods(history)
    # A window belongs to the plan in force at its first session hit (the cap
    # that was hit), else at its start. Moving the whole window keeps its
    # band, its hits and its percentile pool in one period; hits never reach
    # into the next window, so periods stay in time order.
    first_hit_at: dict[int, datetime] = {}
    for hit in session_hits:
        if hit.window_index is not None:
            first_hit_at.setdefault(hit.window_index, hit.ts)
    window_periods = [
        _period_index_for(first_hit_at.get(i, window.start), periods)
        for i, window in enumerate(windows)
    ]
    for window, period_index in zip(windows, window_periods):
        window.era = periods[period_index].plan

    # Only periods with logged windows become eras; era_index on a window
    # points into the eras list, not into the plan history.
    used_periods = sorted(set(window_periods)) or [0]
    era_index_of = {period_index: i for i, period_index in enumerate(used_periods)}
    window_era_indices = [era_index_of[p] for p in window_periods]
    # The observed span is everything the logs prove was covered: windows,
    # plus hits outside them (a weekly-limit hit after the last usage).
    observed = [w.start for w in windows] + [w.end for w in windows] + [h.ts for h in hits]
    logs_from = min(observed, default=None)
    logs_to = max(observed, default=None)

    eras_payload: list[dict[str, Any]] = []
    for era_index, period_index in enumerate(used_periods):
        period = periods[period_index]
        era = period.plan
        era_windows = [
            w for w, idx in zip(windows, window_era_indices) if idx == era_index
        ]
        era_session_hits = [
            hit for hit in session_hits
            if hit.window_index is not None
            and window_era_indices[hit.window_index] == era_index
        ]
        weeks = (
            _period_weeks(period, logs_from, logs_to)
            if logs_from is not None and logs_to is not None else 1.0
        )
        observed_hit_levels_usd = sorted(
            hit.usage_at_hit
            for hit in era_session_hits
            if hit.usage_at_hit is not None
        )
        observed_hit_levels_tokens = sorted(
            hit.usage_at_hit_tokens
            for hit in era_session_hits
            if hit.usage_at_hit_tokens is not None
        )
        usd = _hit_level_stats(
            observed_hit_levels_usd, era_windows, lambda window: window.value_usd,
        )
        tokens = _hit_level_stats(
            observed_hit_levels_tokens, era_windows, lambda window: window.tokens,
        )
        minutes_until_reset = sum(
            hit.minutes_until_reset or 0.0 for hit in era_session_hits
        )
        eras_payload.append({
            "era": era,
            "window_count": len(era_windows),
            "session_hit_count": len(era_session_hits),
            "minutes_until_reset": round(minutes_until_reset, 1),
            "hit_level_median_usd": (
                round(usd.median, 4) if usd.median is not None else None
            ),
            "hit_level_min_usd": (
                round(observed_hit_levels_usd[0], 4) if observed_hit_levels_usd else None
            ),
            "hit_level_max_usd": (
                round(observed_hit_levels_usd[-1], 4) if observed_hit_levels_usd else None
            ),
            "hit_level_median_tokens": tokens.median,
            "hit_level_min_tokens": (
                observed_hit_levels_tokens[0] if observed_hit_levels_tokens else None
            ),
            "hit_level_max_tokens": (
                observed_hit_levels_tokens[-1] if observed_hit_levels_tokens else None
            ),
            "hit_level_percentile": usd.percentile,
            "hit_level_percentile_tokens": tokens.percentile,
            "usage_at_hit_usd": [round(value, 4) for value in observed_hit_levels_usd],
            "usage_at_hit_tokens": observed_hit_levels_tokens,
            "start_date": period.start_date,
            "end_date": period.end_date,
            "weeks": round(weeks, 2),
            "hits_per_week": round(len(era_session_hits) / weeks, 2),
        })

    minutes_until_reset_total = sum(hit.minutes_until_reset or 0.0 for hit in hits)
    last_ts = max(
        (sequence[-1].ts for sequence in (usage, hits) if sequence),
        default=None,
    )
    recent = [h for h in hits
              if last_ts is not None and h.ts >= last_ts - timedelta(days=RECENT_DAYS)]
    return {
        "meta": {
            "window": {"date_from": date_from, "date_to": date_to},
            "cost_available": timeline.has_prices,
            "costs_partial": costs_partial,
            "total_hits": len(hits),
            "total_windows": len(windows),
            "minutes_until_reset": round(minutes_until_reset_total, 1),
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
                "era_index": era_index,
                "hit_kinds": list(w.hit_kinds),
            }
            for w, era_index in zip(windows, window_era_indices)
        ],
        "eras": eras_payload,
    }
