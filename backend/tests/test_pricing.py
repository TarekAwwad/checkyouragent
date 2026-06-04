from __future__ import annotations

from pathlib import Path

from ccfr.analysis.pricing import (
    ModelPrice,
    TokenBreakdown,
    cost_usd,
    load_price_table,
    match_price,
    normalize_model_key,
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


def test_normalize_model_key_maps_display_names_to_ids() -> None:
    assert normalize_model_key("Claude Opus 4.8") == "claude-opus-4-8"
    assert normalize_model_key("Claude Sonnet 4.6") == "claude-sonnet-4-6"
    # trailing "(deprecated)" annotation is dropped
    assert normalize_model_key("Claude Sonnet 4 (deprecated)") == "claude-sonnet-4"
    # already-an-id passes through unchanged
    assert normalize_model_key("claude-opus-4-8") == "claude-opus-4-8"
    # a dated model id keeps its key; date stripping happens at match time
    assert normalize_model_key("claude-haiku-4-5-20251001") == "claude-haiku-4-5-20251001"


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
