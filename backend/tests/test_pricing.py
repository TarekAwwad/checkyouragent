from __future__ import annotations

from datetime import date
from pathlib import Path

import pytest

from ccfr.analysis.pricing import (
    ModelPrice,
    TokenBreakdown,
    cost_usd,
    load_price_table,
    load_price_timeline,
    match_price,
    normalize_model_key,
    PUBLIC_MODEL_KEYS,
)


def _write_pricing(tmp_path: Path) -> Path:
    csv = tmp_path / "pricing.csv"
    csv.write_text(
        "Model,Base Input Tokens,5m Cache Writes,1h Cache Writes,Cache Hits & Refreshes,Output Tokens\n"
        "Claude Opus 4.8,5,6.25,10,0.50,25\n"
        "Claude Sonnet 4.6,3,3.75,6,0.30,15\n"
        "Claude Haiku 4.5,1,1.25,2,0.10,5\n"
        "Claude Sonnet 4 (deprecated),3,3.75,6,0.30,15\n",
        encoding="utf-8",
    )
    return csv


def test_shipped_pricing_models_are_safe_team_model_families() -> None:
    shipped_pricing = Path(__file__).resolve().parents[2] / "pricing.csv"
    assert set(load_price_table(shipped_pricing)) <= PUBLIC_MODEL_KEYS
    for snapshot in (shipped_pricing.parent / "pricing").glob("pricing-*.csv"):
        assert set(load_price_table(snapshot)) <= PUBLIC_MODEL_KEYS


@pytest.mark.parametrize(
    ("model", "expected"),
    [
        ("claude-opus-5-5", ModelPrice(4, 5, 8, 0.20, 20)),
        ("claude-sonnet-5-5", ModelPrice(2, 2.50, 4, 0.10, 10)),
        ("claude-haiku-5-5", ModelPrice(0.10, 0.125, 0.20, 0.01, 0.50)),
        ("claude-fable-5-1", ModelPrice(10, 12.50, 20, 0.25, 50)),
        ("claude-mythos-5-1", ModelPrice(10, 12.50, 20, 0.25, 50)),
        ("claude-sonnet-5", ModelPrice(2, 2.50, 4, 0.20, 10)),
        ("claude-3-5-haiku-20241022", ModelPrice(0.80, 1, 1.60, 0.08, 4)),
    ],
)
def test_shipped_prices_match_anthropic_2026_10_29(model: str, expected: ModelPrice) -> None:
    root = Path(__file__).resolve().parents[2]
    assert match_price(load_price_table(root / "pricing.csv"), model) == expected
    timeline = load_price_timeline(root / "pricing.csv", root / "pricing")
    assert match_price(timeline.current_table(), model) == expected


def test_current_csv_and_latest_shipped_history_agree() -> None:
    root = Path(__file__).resolve().parents[2]
    table = load_price_table(root / "pricing.csv")
    timeline = load_price_timeline(root / "pricing.csv", root / "pricing")
    assert table == timeline.current_table()


def test_shipped_sonnet_prices_respect_effective_dates() -> None:
    root = Path(__file__).resolve().parents[2]
    baseline = root / "pricing.csv"
    timeline = load_price_timeline(baseline, root / "pricing")
    assert match_price(load_price_table(baseline), "claude-sonnet-5").base_input == 2
    assert timeline.price_for("claude-sonnet-5", "2026-06-30").base_input == 2
    assert timeline.price_for("claude-sonnet-5", "2026-09-01").base_input == 2
    old = timeline.price_for("claude-sonnet-5-5", "2026-10-06T23:59:59Z")
    new = timeline.price_for("claude-sonnet-5-5", "2026-10-07T00:00:00Z")
    tokens = TokenBreakdown(cache_read=1_000_000)
    assert cost_usd(old, tokens) == 0.20
    assert cost_usd(new, tokens) == 0.10
    assert timeline.price_for("claude-sonnet-5-5", "2026-09-28", historical=False) == new


def test_bundled_and_local_history_merge_with_local_rows_winning(tmp_path: Path) -> None:
    baseline = _write_pricing(tmp_path)
    bundled = tmp_path / "pricing"
    bundled.mkdir()
    local = tmp_path / "local"
    local.mkdir()
    _write_sheet(bundled / "pricing-2026-07-01.csv", {"Claude-Opus-4.8": 4, "Claude-Sonnet-4.6": 2})
    _write_sheet(local / "pricing-2026-07-01.csv", {"Claude-Opus-4.8": 1})
    _write_sheet(local / "pricing-2026-08-01.csv", {"Claude-Opus-4.8": 0.5})
    timeline = load_price_timeline(baseline, local)
    assert timeline.boundaries() == [date(2026, 7, 1), date(2026, 8, 1)]
    assert timeline.price_for("claude-opus-4-8", "2026-06-30").base_input == 5
    assert timeline.price_for("claude-opus-4-8", "2026-07-01").base_input == 1
    assert timeline.price_for("claude-sonnet-4-6", "2026-07-01").base_input == 2
    assert timeline.price_for("claude-opus-4-8", "2026-08-01").base_input == 0.5


def test_normalize_model_key_maps_display_names_to_ids() -> None:
    assert normalize_model_key("Claude Opus 4.8") == "claude-opus-4-8"
    assert normalize_model_key("Claude Sonnet 4.6") == "claude-sonnet-4-6"
    # trailing "(deprecated)" annotation is dropped
    assert normalize_model_key("Claude Sonnet 4 (deprecated)") == "claude-sonnet-4"
    # already-an-id passes through unchanged
    assert normalize_model_key("claude-opus-4-8") == "claude-opus-4-8"
    # a dated model id keeps its key; date stripping happens at match time
    assert normalize_model_key("claude-haiku-4-5-20251001") == "claude-haiku-4-5-20251001"
    # hyphen before "(deprecated)" must not leave a trailing hyphen
    assert normalize_model_key("Claude-Opus-4.1-(deprecated)") == "claude-opus-4-1"


def test_cost_usd_prices_each_category_per_million() -> None:
    price = ModelPrice(base_input=5, cache_write_5m=6.25, cache_write_1h=10, cache_read=0.5, output=25)
    tokens = TokenBreakdown(
        base_input=1_000_000,
        cache_write_5m=1_000_000,
        cache_write_1h=0,
        cache_read=2_000_000,
        output=400_000,
    )
    # 5 + 6.25 + 0 + (0.5*2) + (25*0.4) = 5 + 6.25 + 1 + 10 = 22.25
    assert cost_usd(price, tokens) == 22.25


def test_load_and_match_resolves_models_including_dated_ids(tmp_path: Path) -> None:
    table = load_price_table(_write_pricing(tmp_path))
    opus = match_price(table, "claude-opus-4-8")
    assert opus is not None and opus.base_input == 5 and opus.cache_read == 0.5
    # a dated haiku id resolves by stripping the date suffix
    haiku = match_price(table, "claude-haiku-4-5-20251001")
    assert haiku is not None and haiku.output == 5
    # unknown models return None rather than guessing
    assert match_price(table, "gpt-4o") is None
    assert match_price(table, None) is None


def test_synthetic_pseudo_model_is_always_non_billable() -> None:
    price = match_price({}, "<synthetic>")

    assert price == ModelPrice(
        base_input=0,
        cache_write_5m=0,
        cache_write_1h=0,
        cache_read=0,
        output=0,
    )
    assert cost_usd(
        price,
        TokenBreakdown(base_input=1_000_000, output=1_000_000),
    ) == 0


def test_load_tolerates_hyphenated_headers_and_id_style_models(tmp_path: Path) -> None:
    # Header punctuation (hyphens vs spaces) and id-style model names must still resolve.
    csv = tmp_path / "pricing.csv"
    csv.write_text(
        "Model,Base-Input-Tokens,5m-Cache-Writes,1h-Cache-Writes,Cache-Hits-&-Refreshes,Output-Tokens\n"
        "claude-opus-4-7,5,6.25,10,0.50,25\n",
        encoding="utf-8",
    )
    table = load_price_table(csv)
    price = match_price(table, "claude-opus-4-7")
    assert price is not None
    assert price.base_input == 5 and price.cache_read == 0.5 and price.output == 25


def test_missing_pricing_file_yields_empty_table(tmp_path: Path) -> None:
    table = load_price_table(tmp_path / "does-not-exist.csv")
    assert table == {}
    assert match_price(table, "claude-opus-4-8") is None


def _write_sheet(path, model_to_input):
    lines = ["model,base-input-tokens,5m-cache-writes,1h-cache-writes,cache-hits-&-refreshes,output-tokens"]
    for model, base in model_to_input.items():
        lines.append(f"{model},{base},0,0,0,{base * 5}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def test_timeline_with_no_dir_is_just_baseline(tmp_path):
    baseline = tmp_path / "pricing.csv"
    _write_sheet(baseline, {"Claude-Opus-4.1": 15})
    timeline = load_price_timeline(baseline, tmp_path / "missing")
    assert timeline.boundaries() == []
    assert match_price(timeline.table_for("2026-01-01"), "claude-opus-4-1").base_input == 15
    assert match_price(timeline.current_table(), "claude-opus-4-1").base_input == 15


def test_timeline_resolves_by_date(tmp_path):
    baseline = tmp_path / "pricing.csv"
    _write_sheet(baseline, {"Claude-Opus-4.1": 15})
    sheets = tmp_path / "pricing"
    sheets.mkdir()
    _write_sheet(sheets / "pricing-2026-07-01.csv", {"Claude-Opus-4.1": 5})
    timeline = load_price_timeline(baseline, sheets)

    assert timeline.boundaries() == [date(2026, 7, 1)]
    assert match_price(timeline.table_for("2026-06-30T23:00:00Z"), "claude-opus-4-1").base_input == 15
    assert match_price(timeline.table_for("2026-07-01T00:00:00Z"), "claude-opus-4-1").base_input == 5
    assert match_price(timeline.current_table(), "claude-opus-4-1").base_input == 5


def test_timeline_partial_snapshot_inherits_baseline(tmp_path):
    baseline = tmp_path / "pricing.csv"
    _write_sheet(baseline, {"Claude-Opus-4.1": 15, "Claude-Sonnet-4.5": 3})
    sheets = tmp_path / "pricing"
    sheets.mkdir()
    _write_sheet(sheets / "pricing-2026-07-01.csv", {"Claude-Opus-4.1": 5})
    timeline = load_price_timeline(baseline, sheets)
    table = timeline.table_for("2026-08-01")
    assert match_price(table, "claude-opus-4-1").base_input == 5
    assert match_price(table, "claude-sonnet-4-5").base_input == 3


def test_timeline_historical_false_uses_current(tmp_path):
    baseline = tmp_path / "pricing.csv"
    _write_sheet(baseline, {"Claude-Opus-4.1": 15})
    sheets = tmp_path / "pricing"
    sheets.mkdir()
    _write_sheet(sheets / "pricing-2026-07-01.csv", {"Claude-Opus-4.1": 5})
    timeline = load_price_timeline(baseline, sheets)
    assert match_price(timeline.table_for("2026-01-01", historical=False), "claude-opus-4-1").base_input == 5


def test_timeline_skips_malformed_filenames(tmp_path):
    baseline = tmp_path / "pricing.csv"
    _write_sheet(baseline, {"Claude-Opus-4.1": 15})
    sheets = tmp_path / "pricing"
    sheets.mkdir()
    (sheets / "notes.txt").write_text("ignore me", encoding="utf-8")
    _write_sheet(sheets / "pricing-bad.csv", {"Claude-Opus-4.1": 1})
    timeline = load_price_timeline(baseline, sheets)
    assert timeline.boundaries() == []


def test_sql_period_expr(tmp_path):
    baseline = tmp_path / "pricing.csv"
    _write_sheet(baseline, {"Claude-Opus-4.1": 15})
    sheets = tmp_path / "pricing"
    sheets.mkdir()
    _write_sheet(sheets / "pricing-2026-07-01.csv", {"Claude-Opus-4.1": 5})
    timeline = load_price_timeline(baseline, sheets)
    assert timeline.sql_period_expr("e.timestamp") == "((date(e.timestamp) >= '2026-07-01'))"
    assert timeline.sql_period_expr("e.timestamp", historical=False) == "0"
    assert match_price(timeline.table_for_period(0), "claude-opus-4-1").base_input == 15
    assert match_price(timeline.table_for_period(1), "claude-opus-4-1").base_input == 5


def test_table_for_period_none_falls_back_to_baseline(tmp_path):
    # A NULL event timestamp yields a NULL price_period from sql_period_expr; table_for_period
    # must treat None as period 0 (the oldest/baseline table) rather than crashing on int(None).
    baseline = tmp_path / "pricing.csv"
    _write_sheet(baseline, {"Claude-Opus-4.1": 15})
    sheets = tmp_path / "pricing"
    sheets.mkdir()
    _write_sheet(sheets / "pricing-2026-07-01.csv", {"Claude-Opus-4.1": 5})
    timeline = load_price_timeline(baseline, sheets)
    price = match_price(timeline.table_for_period(None), "claude-opus-4-1")
    assert price is not None and price.base_input == 15


def test_timeline_resolves_across_multiple_snapshots(tmp_path):
    baseline = tmp_path / "pricing.csv"
    _write_sheet(baseline, {"Claude-Opus-4.1": 15})
    sheets = tmp_path / "pricing"
    sheets.mkdir()
    _write_sheet(sheets / "pricing-2026-07-01.csv", {"Claude-Opus-4.1": 5})
    _write_sheet(sheets / "pricing-2026-09-01.csv", {"Claude-Opus-4.1": 2})
    timeline = load_price_timeline(baseline, sheets)

    # (a) boundaries in chronological order
    assert timeline.boundaries() == [date(2026, 7, 1), date(2026, 9, 1)]

    # (b) before / between / after the two boundaries
    assert match_price(timeline.table_for("2026-06-01"), "claude-opus-4-1").base_input == 15
    assert match_price(timeline.table_for("2026-08-01"), "claude-opus-4-1").base_input == 5
    assert match_price(timeline.table_for("2026-10-01"), "claude-opus-4-1").base_input == 2

    # (c) SQL expr sums both boundary terms
    expr = timeline.sql_period_expr("e.timestamp")
    assert "(date(e.timestamp) >= '2026-07-01')" in expr
    assert "(date(e.timestamp) >= '2026-09-01')" in expr
    assert " + " in expr
