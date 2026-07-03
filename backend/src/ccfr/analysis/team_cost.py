"""Cost analytics over imported team bundles.

Mirrors the per-model cost math in ``api/analytics`` but reads per-model token
attribution from ``team_bundle_sessions`` (there is no raw message data for
team bundles). Produces the same ``CostAnalyticsResponse`` shape the local Cost
view renders, so the existing frontend components render team data unchanged.
Team bundles carry no per-session detail, so ``sessions`` is always empty.

The small input/cache token-math helpers mirror ``api.analytics`` deliberately
(kept here to avoid an analysis -> api import); the core ``cost_usd`` formula is
reused from ``analysis.pricing``.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import date
from typing import Any

from ccfr.analysis.pricing import (
    ModelPrice,
    TokenBreakdown,
    cost_usd,
    load_price_timeline,
    normalize_model_key,
)
from ccfr.config import pricing_dir, pricing_path

# Priced categories (order matches api.analytics._CATEGORIES). The map turns a
# team bundle's token keys into pricing TokenBreakdown fields.
_CATEGORIES = ("base_input", "cache_write_5m", "cache_write_1h", "cache_read", "output")
_BUNDLE_TO_BREAKDOWN = {
    "base": "base_input",
    "cache_5m": "cache_write_5m",
    "cache_1h": "cache_write_1h",
    "cache_read": "cache_read",
    "output": "output",
}
_WEEKLY_THRESHOLD_DAYS = 92


def _breakdown_from_tokens(tokens: dict[str, Any]) -> TokenBreakdown:
    return TokenBreakdown(
        **{field: max(0, int(tokens.get(bundle_key, 0) or 0)) for bundle_key, field in _BUNDLE_TO_BREAKDOWN.items()}
    )


def _input_tokens_total(b: TokenBreakdown) -> int:
    return b.base_input + b.cache_write_5m + b.cache_write_1h + b.cache_read


def _cache_write_tokens_total(b: TokenBreakdown) -> int:
    return b.cache_write_5m + b.cache_write_1h


def _observed_input_usd(price: ModelPrice, b: TokenBreakdown) -> float:
    return (
        b.base_input * price.base_input
        + b.cache_write_5m * price.cache_write_5m
        + b.cache_write_1h * price.cache_write_1h
        + b.cache_read * price.cache_read
    ) / 1_000_000


def _no_cache_input_usd(price: ModelPrice, b: TokenBreakdown) -> float:
    return _input_tokens_total(b) * price.base_input / 1_000_000


def _coerce_day(value: str | None) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


def _bucket_for_range(lo: str | None, hi: str | None) -> str:
    a, b = _coerce_day(lo), _coerce_day(hi)
    if a is None or b is None:
        return "day"
    return "week" if abs((b - a).days) > _WEEKLY_THRESHOLD_DAYS else "day"


def _bucket_key(first_date: str | None, bucket: str) -> str | None:
    day = _coerce_day(first_date)
    if day is None:
        return None
    return day.isoformat() if bucket == "day" else day.strftime("%Y-%W")


def team_cost_analytics(
    conn: sqlite3.Connection,
    *,
    date_from: str | None = None,
    date_to: str | None = None,
    model: str | None = None,
    project_id: int | None = None,
    historical: bool = True,
) -> dict[str, Any]:
    timeline = load_price_timeline(pricing_path(), pricing_dir())
    price_available = timeline.has_prices

    # Stable across filter changes: ids depend only on the imported bundle
    # set, not on the date/project filters applied below.
    project_rows = conn.execute(
        """
        SELECT project_id, MAX(project_name) AS project_name
        FROM team_bundle_sessions
        GROUP BY project_id
        ORDER BY project_id
        """
    ).fetchall()
    all_pids = [str(row["project_id"]) for row in project_rows]
    name_by_pid = {
        str(row["project_id"]): (str(row["project_name"]) if row["project_name"] else str(row["project_id"])[:8])
        for row in project_rows
    }
    pid_id = {pid: index for index, pid in enumerate(all_pids, start=1)}

    where: list[str] = []
    params: list[Any] = []
    if date_from:
        where.append("first_date >= ?")
        params.append(date_from[:10])
    if date_to:
        where.append("first_date <= ?")
        params.append(date_to[:10])
    if project_id is not None:
        id_pid = {index: pid for pid, index in pid_id.items()}
        where.append("project_id = ?")
        params.append(id_pid.get(project_id, ""))  # unknown/stale id matches nothing
    clause = (" WHERE " + " AND ".join(where)) if where else ""
    rows = conn.execute(
        f"SELECT project_id, first_date, tokens_by_model_json FROM team_bundle_sessions{clause} ORDER BY first_date, id",
        params,
    ).fetchall()

    target = normalize_model_key(model) if model else None

    def matches(family: str) -> bool:
        return target is None or normalize_model_key(family) == target

    first_dates = [row["first_date"] for row in rows if row["first_date"]]
    bucket = _bucket_for_range(date_from or (min(first_dates) if first_dates else None), date_to or (max(first_dates) if first_dates else None))

    treemap: dict[int, dict[str, Any]] = {}
    by_model: dict[str, dict[str, Any]] = {}
    categories = {cat: {"tokens": 0, "usd": 0.0} for cat in _CATEGORIES}
    cache_economics: dict[str, Any] = {
        "observed_input_usd": 0.0,
        "no_cache_input_usd": 0.0,
        "net_savings_usd": 0.0,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
        "by_model": {},
    }
    over_time: dict[str, dict[str, Any]] = {}
    available_models: set[str] = set()
    unpriced: set[str] = set()
    total_usd = 0.0
    total_tokens = 0

    for row in rows:
        pid = str(row["project_id"])
        first_date = row["first_date"]
        try:
            tokens_by_model = json.loads(row["tokens_by_model_json"]) if row["tokens_by_model_json"] else {}
        except json.JSONDecodeError:
            tokens_by_model = {}
        if not isinstance(tokens_by_model, dict):
            continue
        for raw_family, tokens in tokens_by_model.items():
            if not isinstance(tokens, dict):
                continue
            family = str(raw_family)
            available_models.add(family)
            if not matches(family):
                continue
            breakdown = _breakdown_from_tokens(tokens)
            used = any(getattr(breakdown, cat) for cat in _CATEGORIES)
            price = timeline.price_for(family, first_date, historical=historical)
            usd = cost_usd(price, breakdown) if price else 0.0
            if price is None and used:
                unpriced.add(family)

            for cat in _CATEGORIES:
                tok = getattr(breakdown, cat)
                categories[cat]["tokens"] += tok
                total_tokens += tok
                if price is not None:
                    categories[cat]["usd"] += tok * getattr(price, cat) / 1_000_000

            if price is not None:
                observed = _observed_input_usd(price, breakdown)
                no_cache = _no_cache_input_usd(price, breakdown)
                cache_economics["observed_input_usd"] += observed
                cache_economics["no_cache_input_usd"] += no_cache
                model_cache = cache_economics["by_model"].setdefault(
                    family,
                    {
                        "model": family,
                        "observed_input_usd": 0.0,
                        "no_cache_input_usd": 0.0,
                        "net_savings_usd": 0.0,
                        "input_tokens": 0,
                        "cache_read_tokens": 0,
                        "cache_write_tokens": 0,
                    },
                )
                model_cache["observed_input_usd"] += observed
                model_cache["no_cache_input_usd"] += no_cache
                model_cache["input_tokens"] += _input_tokens_total(breakdown)
                model_cache["cache_read_tokens"] += breakdown.cache_read
                model_cache["cache_write_tokens"] += _cache_write_tokens_total(breakdown)
            cache_economics["cache_read_tokens"] += breakdown.cache_read
            cache_economics["cache_write_tokens"] += _cache_write_tokens_total(breakdown)
            total_usd += usd

            proj = treemap.setdefault(
                pid_id[pid],
                {"project_id": pid_id[pid], "project_name": name_by_pid[pid], "usd": 0.0, "children": {}},
            )
            proj["usd"] += usd
            proj["children"][family] = proj["children"].get(family, 0.0) + usd

            bm = by_model.setdefault(
                family,
                {
                    "model": family,
                    "usd": 0.0,
                    "tokens": 0,
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "cache_read_tokens": 0,
                    "cache_write_tokens": 0,
                },
            )
            bm["usd"] += usd
            bm["tokens"] += sum(getattr(breakdown, cat) for cat in _CATEGORIES)
            bm["input_tokens"] += _input_tokens_total(breakdown)
            bm["output_tokens"] += breakdown.output
            bm["cache_read_tokens"] += breakdown.cache_read
            bm["cache_write_tokens"] += _cache_write_tokens_total(breakdown)

            if price is not None and usd != 0:
                key = _bucket_key(first_date, bucket)
                if key is not None:
                    over = over_time.setdefault(key, {"bucket": key, "per_model": {}})
                    over["per_model"][family] = round(over["per_model"].get(family, 0.0) + usd, 6)

    treemap_out = [
        {
            "project_id": proj["project_id"],
            "project_name": proj["project_name"],
            "usd": round(proj["usd"], 6),
            "children": [
                {"model": mdl, "usd": round(usd, 6)}
                for mdl, usd in sorted(proj["children"].items(), key=lambda kv: kv[1], reverse=True)
            ],
        }
        for proj in sorted(treemap.values(), key=lambda x: x["usd"], reverse=True)
    ]
    by_model_out = [
        {
            "model": bm["model"],
            "usd": round(bm["usd"], 6),
            "tokens": bm["tokens"],
            "input_tokens": bm["input_tokens"],
            "output_tokens": bm["output_tokens"],
            "cache_read_tokens": bm["cache_read_tokens"],
            "cache_write_tokens": bm["cache_write_tokens"],
            "effective_usd_per_million": round((bm["usd"] / bm["tokens"]) * 1_000_000, 6) if bm["tokens"] > 0 else 0.0,
        }
        for bm in sorted(by_model.values(), key=lambda x: x["usd"], reverse=True)
    ]
    categories_out = {
        cat: {"tokens": categories[cat]["tokens"], "usd": round(categories[cat]["usd"], 6)} for cat in _CATEGORIES
    }
    over_time_out = [over_time[key] for key in sorted(over_time)]
    cache_economics_out = {
        "observed_input_usd": round(cache_economics["observed_input_usd"], 6),
        "no_cache_input_usd": round(cache_economics["no_cache_input_usd"], 6),
        "net_savings_usd": round(cache_economics["no_cache_input_usd"] - cache_economics["observed_input_usd"], 6),
        "cache_read_tokens": cache_economics["cache_read_tokens"],
        "cache_write_tokens": cache_economics["cache_write_tokens"],
        "by_model": [
            {
                **model_cache,
                "observed_input_usd": round(model_cache["observed_input_usd"], 6),
                "no_cache_input_usd": round(model_cache["no_cache_input_usd"], 6),
                "net_savings_usd": round(model_cache["no_cache_input_usd"] - model_cache["observed_input_usd"], 6),
            }
            for model_cache in sorted(
                cache_economics["by_model"].values(),
                key=lambda item: abs(item["no_cache_input_usd"] - item["observed_input_usd"]),
                reverse=True,
            )
        ],
    }

    bucket_totals = {item["bucket"]: round(sum(item["per_model"].values()), 6) for item in over_time_out}
    spikes = []
    bucket_keys = sorted(bucket_totals)
    for index, key in enumerate(bucket_keys):
        if index == 0:
            continue
        delta = round(bucket_totals[key] - bucket_totals[bucket_keys[index - 1]], 6)
        if delta <= 0:
            continue
        spikes.append({"bucket": key, "total_usd": bucket_totals[key], "delta_usd": delta, "sessions": []})
    spikes_out = sorted(spikes, key=lambda item: item["delta_usd"], reverse=True)[:5]

    available_projects = sorted(
        ({"id": pid_id[pid], "name": name_by_pid[pid]} for pid in all_pids), key=lambda item: item["name"]
    )

    return {
        "meta": {
            "available": price_available,
            "unpriced_models": sorted(unpriced),
            "total_usd": round(total_usd, 6),
            "total_tokens": total_tokens,
            "available_projects": available_projects,
            "available_models": sorted(available_models),
            "bucket": bucket,
        },
        "treemap": treemap_out,
        "over_time": over_time_out,
        "categories": categories_out,
        "by_model": by_model_out,
        "sessions": [],
        "cache_economics": cache_economics_out,
        "spikes": spikes_out,
    }
