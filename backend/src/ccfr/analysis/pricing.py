"""Per-model token pricing and session cost estimation.

Prices come from a CSV (see :func:`ccfr.config.pricing_path`) whose columns are
US dollars **per million tokens** for each usage category. Token counts are stored
broken out per message (base input, 5m/1h cache writes, cache reads, output) so
cost can be recomputed at query time without re-importing when prices change.
"""

from __future__ import annotations

import csv
import re
from dataclasses import dataclass
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
