"""Date-window terms for event filters.

A bound with a time component (``2026-11-23T23:00:00.000Z``) is an instant and
is compared as one, inclusively, so a local-day window sent by the frontend
selects exactly the events inside it. A bare ``YYYY-MM-DD`` keeps the original
behavior: the event's UTC calendar date is compared inclusively. Both sides are
parsed (``julianday``), so ``…00Z``, ``…00.000Z`` and ``+00:00`` forms agree.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


def is_instant(value: str) -> bool:
    return "T" in value


def sql_terms(column: str, date_from: str | None, date_to: str | None) -> tuple[list[str], list[Any]]:
    """WHERE terms (to AND together) and their parameters for a date window."""
    terms: list[str] = []
    params: list[Any] = []
    if date_from:
        terms.append(
            f"julianday({column}) >= julianday(?)" if is_instant(date_from)
            else f"date({column}) >= date(?)"
        )
        params.append(date_from)
    if date_to:
        terms.append(
            f"julianday({column}) <= julianday(?)" if is_instant(date_to)
            else f"date({column}) <= date(?)"
        )
        params.append(date_to)
    return terms, params


def _parse(value: str) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _utc_day(value: str) -> str:
    parsed = _parse(value)
    return parsed.astimezone(timezone.utc).date().isoformat() if parsed else value[:10]


def in_window(ts: str | None, date_from: str | None, date_to: str | None) -> bool:
    """Python twin of ``sql_terms`` for timestamps already loaded. Undated
    items only pass when no window is set (a window must never smuggle in
    undatable findings)."""
    if not ts:
        return not date_from and not date_to
    moment = _parse(ts)
    if date_from:
        if is_instant(date_from):
            start = _parse(date_from)
            if moment is None or start is None or moment < start:
                return False
        elif _utc_day(ts) < date_from[:10]:
            return False
    if date_to:
        if is_instant(date_to):
            end = _parse(date_to)
            if moment is None or end is None or moment > end:
                return False
        elif _utc_day(ts) > date_to[:10]:
            return False
    return True
