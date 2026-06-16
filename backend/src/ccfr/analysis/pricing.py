"""Per-model token pricing and session cost estimation.

Prices come from a CSV (see :func:`ccfr.config.pricing_path`) whose columns are
US dollars **per million tokens** for each usage category. Token counts are stored
broken out per message (base input, 5m/1h cache writes, cache reads, output) so
cost can be recomputed at query time without re-importing when prices change.
"""

from __future__ import annotations

import csv
import re
from bisect import bisect_right
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path


@dataclass(frozen=True)
class ModelPrice:
    """Dollars per million tokens for each usage category."""

    base_input: float
    cache_write_5m: float
    cache_write_1h: float
    cache_read: float
    output: float


@dataclass(frozen=True)
class TokenBreakdown:
    """Token counts for one usage category split (summed across messages)."""

    base_input: int = 0
    cache_write_5m: int = 0
    cache_write_1h: int = 0
    cache_read: int = 0
    output: int = 0


# Maps a *normalized* pricing.csv column header to the ModelPrice field name. Headers are
# normalized (lowercased, non-alphanumerics dropped) before lookup so "Base Input Tokens",
# "Base-Input-Tokens", and "base_input_tokens" all resolve to the same field.
_HEADER_FIELDS = {
    "baseinputtokens": "base_input",
    "5mcachewrites": "cache_write_5m",
    "1hcachewrites": "cache_write_1h",
    "cachehitsrefreshes": "cache_read",
    "outputtokens": "output",
}

_PRICE_FIELDS = ("base_input", "cache_write_5m", "cache_write_1h", "cache_read", "output")


def _normalize_header(header: str) -> str:
    return re.sub(r"[^a-z0-9]", "", header.lower())

# Trailing "-YYYYMMDD" (or longer numeric) release suffix on a model id, e.g.
# "claude-haiku-4-5-20251001" -> "claude-haiku-4-5".
_DATE_SUFFIX = re.compile(r"-\d{6,}$")


def normalize_model_key(name: str) -> str:
    """Fold a display name ("Claude Opus 4.8") or id to a canonical id key.

    Lowercases, drops a trailing "(deprecated)" annotation, and turns spaces and
    dots into hyphens so "Claude Opus 4.8" and "claude-opus-4-8" collapse together.
    """
    text = name.strip().lower()
    text = re.sub(r"[\s-]*\(deprecated\)\s*$", "", text)
    text = text.strip()
    text = re.sub(r"[ .]+", "-", text)
    return text


def load_price_table(path: Path) -> dict[str, ModelPrice]:
    """Load pricing.csv into {normalized model key -> ModelPrice}.

    A missing file yields an empty table (cost estimation simply becomes unavailable
    rather than failing the request).
    """
    if not path.exists():
        return {}
    table: dict[str, ModelPrice] = {}
    # utf-8-sig strips a BOM if the CSV was saved from Excel, so the first header still matches.
    with path.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        # Resolve this file's actual headers to our fields, tolerant of spaces/hyphens/case.
        model_column: str | None = None
        field_by_column: dict[str, str] = {}
        for column in reader.fieldnames or []:
            normalized = _normalize_header(column)
            if normalized == "model":
                model_column = column
            elif normalized in _HEADER_FIELDS:
                field_by_column[column] = _HEADER_FIELDS[normalized]
        if model_column is None:
            return {}
        for row in reader:
            model = (row.get(model_column) or "").strip()
            if not model:
                continue
            values = {field: 0.0 for field in _PRICE_FIELDS}
            for column, field in field_by_column.items():
                values[field] = float(row.get(column) or 0)
            table[normalize_model_key(model)] = ModelPrice(**values)
    return table


def match_price(table: dict[str, ModelPrice], model_id: str | None) -> ModelPrice | None:
    """Resolve a model id to its price, tolerating dated release suffixes."""
    if not model_id:
        return None
    key = normalize_model_key(model_id)
    if key in table:
        return table[key]
    stripped = _DATE_SUFFIX.sub("", key)
    return table.get(stripped)


def cost_usd(price: ModelPrice, tokens: TokenBreakdown) -> float:
    """Cost in dollars for one model's token breakdown (prices are per million)."""
    total = (
        tokens.base_input * price.base_input
        + tokens.cache_write_5m * price.cache_write_5m
        + tokens.cache_write_1h * price.cache_write_1h
        + tokens.cache_read * price.cache_read
        + tokens.output * price.output
    )
    return total / 1_000_000


def _coerce_date(when: object) -> date | None:
    """Best-effort fold of a date / datetime / ISO string to a date; None when unknown."""
    if when is None:
        return None
    if isinstance(when, datetime):
        return when.date()
    if isinstance(when, date):
        return when
    text = str(when).strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).date()
    except ValueError:
        try:
            return date.fromisoformat(text[:10])
        except ValueError:
            return None


# A dated snapshot file: pricing-YYYY-MM-DD.csv (date parsed from the filename).
_SHEET_RE = re.compile(r"^pricing-(\d{4})-(\d{2})-(\d{2})\.csv$", re.IGNORECASE)


@dataclass(frozen=True)
class _Snapshot:
    date: date
    table: dict[str, ModelPrice]


class PriceTimeline:
    """Baseline prices plus dated snapshots, resolvable to a table for any date.

    The merged table for a date is the baseline overlaid with every snapshot whose
    effective date is <= that date, applied oldest-first (later snapshots win per model).
    """

    def __init__(self, baseline: dict[str, ModelPrice], snapshots: list[_Snapshot]) -> None:
        self._baseline = baseline
        self._snapshots = sorted(snapshots, key=lambda s: s.date)
        self._boundaries = [s.date for s in self._snapshots]
        self._period_cache: dict[int, dict[str, ModelPrice]] = {}
        self._current: dict[str, ModelPrice] | None = None

    @property
    def has_prices(self) -> bool:
        return bool(self._baseline) or any(snap.table for snap in self._snapshots)

    def boundaries(self) -> list[date]:
        return list(self._boundaries)

    def _merge_through(self, count: int) -> dict[str, ModelPrice]:
        merged = dict(self._baseline)
        for snap in self._snapshots[:count]:
            merged.update(snap.table)
        return merged

    def current_table(self) -> dict[str, ModelPrice]:
        if self._current is None:
            self._current = self._merge_through(len(self._snapshots))
        return self._current

    def table_for_period(self, period: int, *, historical: bool = True) -> dict[str, ModelPrice]:
        if not historical:
            return self.current_table()
        period = max(0, min(int(period), len(self._snapshots)))
        if period not in self._period_cache:
            self._period_cache[period] = self._merge_through(period)
        return self._period_cache[period]

    def period_index(self, when: object) -> int:
        day = _coerce_date(when)
        if day is None:
            return 0
        return bisect_right(self._boundaries, day)

    def table_for(self, when: object, *, historical: bool = True) -> dict[str, ModelPrice]:
        if not historical:
            return self.current_table()
        return self.table_for_period(self.period_index(when), historical=True)

    def price_for(self, model: str | None, when: object, *, historical: bool = True) -> ModelPrice | None:
        return match_price(self.table_for(when, historical=historical), model)

    def sql_period_expr(self, column: str = "e.timestamp", *, historical: bool = True) -> str:
        """SQL yielding the 0-based price-period index for a timestamp column.

        Booleans are 0/1 in SQLite, so summing `(date(col) >= 'd')` over the sorted
        boundaries gives exactly ``period_index``. Returns the constant ``0`` when
        historical is off or there are no snapshots (groups collapse to one period)."""
        if not historical or not self._boundaries:
            return "0"
        terms = " + ".join(f"(date({column}) >= '{d.isoformat()}')" for d in self._boundaries)
        return f"({terms})"


def load_price_timeline(baseline_path: Path, sheets_dir: Path) -> PriceTimeline:
    """Load the baseline CSV plus every pricing-YYYY-MM-DD.csv in ``sheets_dir``."""
    baseline = load_price_table(baseline_path)
    snapshots: list[_Snapshot] = []
    if sheets_dir.is_dir():
        for child in sorted(sheets_dir.iterdir()):
            if not child.is_file():
                continue
            match = _SHEET_RE.match(child.name)
            if not match:
                continue
            try:
                day = date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
            except ValueError:
                continue
            snapshots.append(_Snapshot(date=day, table=load_price_table(child)))
    return PriceTimeline(baseline, snapshots)
