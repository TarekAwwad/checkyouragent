from __future__ import annotations

from collections.abc import Mapping
from datetime import date, datetime, time, timedelta, timezone
from statistics import median
from typing import Any, Literal, TypeVar

BucketSize = Literal["day", "week"]
MAX_TREND_BUCKETS = 3_660
_CalendarValue = TypeVar("_CalendarValue", date, datetime)
_CALENDAR_BOUNDS_MESSAGE = "date range exceeds supported calendar bounds (years 0001 through 9999)"


class CostTrendRangeError(ValueError):
    """An invalid or excessive requested trend range."""


def _calendar_add(value: _CalendarValue, delta: timedelta) -> _CalendarValue:
    try:
        return value + delta
    except OverflowError as exc:
        raise CostTrendRangeError(_CALENDAR_BOUNDS_MESSAGE) from exc


def _coerce_day(value: str | None) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


def _day_for_bucket_key(value: str, bucket_size: BucketSize) -> date | None:
    if bucket_size == "day":
        return _coerce_day(value)
    try:
        return datetime.strptime(f"{value}-1", "%Y-%W-%w").replace(tzinfo=timezone.utc).date()
    except ValueError:
        return None


def _bucket_key(day: date, bucket_size: BucketSize) -> str:
    return day.isoformat() if bucket_size == "day" else _period_start(day, bucket_size).strftime("%Y-%W")


def _period_start(day: date, bucket_size: BucketSize) -> date:
    return day if bucket_size == "day" else day - timedelta(days=day.weekday())


def lookback_bounds(
    range_start: str | None,
    bucket_size: BucketSize,
    *,
    data_start: str | None = None,
) -> tuple[str, str] | None:
    """Dates covering baseline history; the upper bound is exclusive.

    Clamp to imported history so a new dataset's first day is not compared with
    seven invented zero-spend days before any logs exist. If the selection
    clips its first period, also fetch that full period for later baselines.
    Its displayed spend still comes only from the selected range.
    """
    day = _coerce_day(range_start)
    if day is None:
        return None
    end = _period_start(day, bucket_size)
    lookback_days = min(7 * (1 if bucket_size == "day" else 7), (end - date.min).days)
    start = end - timedelta(days=lookback_days)
    lower = _bound_instant(range_start, end=False)
    if lower is not None and lower > datetime.combine(end, time.min, timezone.utc):
        end = _calendar_add(end, timedelta(days=1 if bucket_size == "day" else 7))
    first_day = _coerce_day(data_start)
    if first_day is not None:
        start = max(start, _period_start(first_day, bucket_size))
    return (start.isoformat(), end.isoformat()) if start < end else None


def _bound_instant(value: str | None, *, end: bool) -> datetime | None:
    if not value:
        return None
    day = _coerce_day(value)
    if day is None:
        return None
    if len(value) == 10:
        return datetime.combine(_calendar_add(day, timedelta(days=int(end))), time.min, timezone.utc)
    try:
        instant = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    try:
        instant = instant.replace(tzinfo=timezone.utc) if instant.tzinfo is None else instant.astimezone(timezone.utc)
    except OverflowError as exc:
        raise CostTrendRangeError(_CALENDAR_BOUNDS_MESSAGE) from exc
    # The date picker uses inclusive 23:59:59.999 boundaries. Normalize that
    # final millisecond to the following midnight when assessing completeness.
    return _calendar_add(instant, timedelta(milliseconds=1)) if end else instant


def _is_complete(
    start: date,
    bucket_size: BucketSize,
    range_start: str | None,
    range_end: str | None,
) -> bool:
    first = datetime.combine(start, time.min, timezone.utc)
    after = _calendar_add(first, timedelta(days=1 if bucket_size == "day" else 7))
    lower = _bound_instant(range_start, end=False)
    upper = _bound_instant(range_end, end=True)
    return bool(
        (lower is None or first >= lower)
        and (upper is None or after <= upper)
        and after <= datetime.now(timezone.utc)
    )


def _history_total(source: Mapping[str, Any], day: date | None, bucket_size: BucketSize) -> float | None:
    if source.get("unpriced_models") or day is None or not _is_complete(day, bucket_size, None, None):
        return None
    return round(sum(float(usd) for usd in dict(source.get("per_model", {})).values()), 6)


def _range_keys(
    observed: Mapping[str, Mapping[str, Any]],
    *,
    bucket_size: BucketSize,
    range_start: str | None,
    range_end: str | None,
) -> list[str]:
    start = _coerce_day(range_start)
    end = _coerce_day(range_end)
    if range_start is not None and start is None:
        raise CostTrendRangeError("date_from must begin with an ISO date (YYYY-MM-DD)")
    if range_end is not None and end is None:
        raise CostTrendRangeError("date_to must begin with an ISO date (YYYY-MM-DD)")
    observed_days = [
        day
        for key in observed
        if (day := _day_for_bucket_key(key, bucket_size)) is not None
    ]
    if start is None and observed_days:
        start = min(observed_days)
    if end is None and observed_days:
        end = max(observed_days)
    if start is None or end is None or end < start:
        return sorted(observed)

    start = _period_start(start, bucket_size)
    end = _period_start(end, bucket_size)
    step_days = 1 if bucket_size == "day" else 7
    bucket_count = ((end - start).days // step_days) + 1
    if bucket_count > MAX_TREND_BUCKETS:
        raise CostTrendRangeError(
            f"date range produces too many buckets (max {MAX_TREND_BUCKETS})"
        )

    keys: list[str] = []
    seen: set[str] = set()
    cursor = start
    while cursor <= end:
        key = _bucket_key(cursor, bucket_size)
        if key not in seen:
            keys.append(key)
            seen.add(key)
        if cursor == end:
            break
        cursor += timedelta(days=step_days)
    return keys


def build_cost_trend(
    observed: Mapping[str, Mapping[str, Any]],
    *,
    bucket_size: BucketSize,
    range_start: str | None,
    range_end: str | None,
    suppress_spikes: bool = False,
    max_spikes: int = 5,
    history: Mapping[str, Mapping[str, Any]] | None = None,
    history_start: str | None = None,
    coverage_start: str | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Zero-fill cost buckets and identify evidence-qualified spend spikes."""
    over_time: list[dict[str, Any]] = []
    totals: list[float | None] = []
    spikes: list[dict[str, Any]] = []
    history = history or {}
    coverage_day = _coerce_day(coverage_start)
    coverage_day = _period_start(coverage_day, bucket_size) if coverage_day is not None else None
    keys = _range_keys(
        observed,
        bucket_size=bucket_size,
        range_start=range_start,
        range_end=range_end,
    )
    if keys and (history or history_start):
        first_day = _day_for_bucket_key(keys[0], bucket_size)
        if first_day is not None and first_day > date.min:
            for history_key in _range_keys(
                history,
                bucket_size=bucket_size,
                range_start=history_start,
                range_end=(first_day - timedelta(days=1)).isoformat(),
            )[-7:]:
                source = history.get(history_key, {})
                history_day = _day_for_bucket_key(history_key, bucket_size)
                if history_day is not None and history_day < first_day:
                    totals.append(_history_total(source, history_day, bucket_size))

    for key in keys:
        source = observed.get(key, {})
        per_model = {
            str(model): round(float(usd), 6)
            for model, usd in dict(source.get("per_model", {})).items()
            if float(usd) != 0
        }
        total_usd = round(sum(per_model.values()), 6)
        session_ids = set(source.get("session_ids", set()))
        priced_session_ids = set(source.get("priced_session_ids", set()))
        unpriced_session_ids = set(source.get("unpriced_session_ids", set()))
        fully_priced_session_ids = priced_session_ids - unpriced_session_ids
        unpriced_models = sorted(str(model) for model in source.get("unpriced_models", set()))
        contributors = sorted(
            (dict(session) for session in source.get("sessions", [])),
            key=lambda session: float(session.get("usd", 0) or 0),
            reverse=True,
        )[:3]
        for contributor in contributors:
            contributor["usd"] = round(float(contributor.get("usd", 0) or 0), 6)

        start = _day_for_bucket_key(key, bucket_size)
        complete = start is not None and _is_complete(start, bucket_size, range_start, range_end)
        covered = coverage_day is None or (start is not None and start >= coverage_day)
        preceding = [total for total in totals[-7:] if total is not None]
        baseline_usd = round(float(median(preceding)), 6) if len(preceding) >= 3 else None
        delta_usd = round(total_usd - baseline_usd, 6) if baseline_usd is not None else None
        delta_pct = (
            round((delta_usd / baseline_usd) * 100, 2)
            if delta_usd is not None and baseline_usd > 0
            else None
        )
        is_spike = bool(
            not suppress_spikes
            and complete
            and covered
            and not unpriced_models
            and baseline_usd is not None
            and len(fully_priced_session_ids) >= 2
            and delta_usd is not None
            and delta_usd >= 5
            and (baseline_usd == 0 or (delta_pct is not None and delta_pct >= 50))
        )

        period_metadata = {
            "bucket_start": start.isoformat() if start is not None else None,
            "bucket_end": _calendar_add(start, timedelta(days=0 if bucket_size == "day" else 6)).isoformat() if start is not None else None,
            "baseline_period_count": len(preceding),
            "is_complete": complete,
        }
        row = {
            "bucket": key,
            **period_metadata,
            "per_model": per_model,
            "total_usd": total_usd,
            "session_count": len(session_ids),
            "priced_session_count": len(fully_priced_session_ids),
            "unpriced_models": unpriced_models,
            "costs_are_lower_bound": bool(unpriced_models),
            "baseline_usd": baseline_usd,
            "delta_usd": delta_usd,
            "delta_pct": delta_pct,
            "is_spike": is_spike,
            "sessions": contributors,
        }
        over_time.append(row)
        # A clipped first period cannot be a spike, but its complete historical
        # spend can still inform later periods without leaking into the chart.
        totals.append(
            total_usd if complete and covered and not unpriced_models
            else _history_total(history[key], start, bucket_size) if covered and key in history
            else None
        )
        if is_spike:
            spikes.append(
                {
                    "bucket": key,
                    **period_metadata,
                    "total_usd": total_usd,
                    "baseline_usd": baseline_usd,
                    "delta_usd": delta_usd,
                    "delta_pct": delta_pct,
                    "sessions": contributors,
                }
            )

    spikes.sort(key=lambda item: float(item["delta_usd"]), reverse=True)
    return over_time, spikes[:max_spikes]
