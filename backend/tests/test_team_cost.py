from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest
from ccfr.analysis import team_bundles, team_cost
from ccfr.analysis.team_cost import team_cost_analytics
from ccfr.storage import init_db

from tests.test_team_bundles import _team_level_bundle

OPUS = {"input": 1_000_000, "output": 1_000_000, "base": 1_000_000, "cache_5m": 0, "cache_1h": 0, "cache_read": 0}
SONNET = {"input": 1_000_000, "output": 1_000_000, "base": 1_000_000, "cache_5m": 0, "cache_1h": 0, "cache_read": 0}


def _seed_team(conn: sqlite3.Connection) -> None:
    tb = conn.execute(
        """
        INSERT INTO team_bundles(
            bundle_id, profile, schema_version, member_id, generated_at,
            app_version, imported_at, source_path, session_count
        )
        VALUES ('b', 'team_strict', 1, 'm', '2026-05-01', '0.1.0', '2026-05-01T00:00:00Z', 'b.json', 2)
        """
    ).lastrowid
    conn.executemany(
        """
        INSERT INTO team_bundle_sessions(
            team_bundle_id, member_id, project_id, session_id, provider,
            first_date, last_date, tokens_by_model_json
        )
        VALUES (?, 'm', ?, ?, 'claude', ?, ?, ?)
        """,
        [
            (tb, "projectA" * 8, "sidA", "2026-05-01", "2026-05-01", json.dumps({"claude-opus-4-8": OPUS})),
            (tb, "projectB" * 8, "sidB", "2026-05-02", "2026-05-02", json.dumps({"claude-sonnet-4-6": SONNET})),
        ],
    )
    conn.commit()


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_db(conn)
    _seed_team(conn)
    return conn


@pytest.fixture()
def seeded(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> sqlite3.Connection:
    csv = tmp_path / "pricing.csv"
    csv.write_text(
        "model,base-input-tokens,5m-cache-writes,1h-cache-writes,cache-hits-&-refreshes,output-tokens\n"
        "claude-opus-4-8,5,6.25,10,0.50,25\n"
        "claude-sonnet-4-6,3,3.75,6,0.30,15\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(team_cost, "pricing_path", lambda: csv)
    return _conn()


def test_team_cost_totals_and_by_model(seeded: sqlite3.Connection) -> None:
    payload = team_cost.team_cost_analytics(seeded)

    assert payload["meta"]["available"] is True
    assert payload["meta"]["costs_partial"] is False
    assert payload["meta"]["costs_are_lower_bound"] is False
    # opus: 1M base*5 + 1M output*25 = $30 ; sonnet: 1M*3 + 1M*15 = $18 ; total $48
    assert payload["meta"]["total_usd"] == 48.0
    assert payload["meta"]["total_tokens"] == 4_000_000
    assert payload["sessions"] == []

    by_model = {m["model"]: m for m in payload["by_model"]}
    assert round(by_model["claude-opus-4-8"]["usd"], 2) == 30.0
    assert round(by_model["claude-sonnet-4-6"]["usd"], 2) == 18.0
    assert len(payload["treemap"]) == 2
    assert payload["over_time"]
    assert sorted(payload["meta"]["available_models"]) == ["claude-opus-4-8", "claude-sonnet-4-6"]


def test_team_cost_unavailable_without_price_table(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(team_cost, "pricing_path", lambda: tmp_path / "missing.csv")
    conn = _conn()

    payload = team_cost.team_cost_analytics(conn)

    assert payload["meta"]["available"] is False
    assert payload["meta"]["costs_partial"] is False
    assert payload["meta"]["costs_are_lower_bound"] is False
    assert payload["meta"]["total_usd"] == 0
    assert set(payload["meta"]["unpriced_models"]) == {"claude-opus-4-8", "claude-sonnet-4-6"}
    conn.close()


def test_team_cost_marks_partial_costs_and_suppresses_spikes(
    seeded: sqlite3.Connection,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    csv = tmp_path / "partial-pricing.csv"
    csv.write_text(
        "model,base-input-tokens,5m-cache-writes,1h-cache-writes,cache-hits-&-refreshes,output-tokens\n"
        "claude-opus-4-8,5,6.25,10,0.50,25\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(team_cost, "pricing_path", lambda: csv)

    payload = team_cost.team_cost_analytics(seeded)

    assert payload["meta"]["available"] is True
    assert payload["meta"]["costs_partial"] is True
    assert payload["meta"]["costs_are_lower_bound"] is True
    assert payload["meta"]["unpriced_models"] == ["claude-sonnet-4-6"]
    assert payload["spikes"] == []
    may2 = next(bucket for bucket in payload["over_time"] if bucket["bucket"] == "2026-05-02")
    assert may2["costs_are_lower_bound"] is True
    assert may2["unpriced_models"] == ["claude-sonnet-4-6"]


def test_team_cost_filters_by_project_id(seeded: sqlite3.Connection) -> None:
    baseline = team_cost.team_cost_analytics(seeded)
    pid_by_name = {p["name"]: p["id"] for p in baseline["meta"]["available_projects"]}
    assert set(pid_by_name) == {"projectA", "projectB"}

    filtered = team_cost.team_cost_analytics(seeded, project_id=pid_by_name["projectA"])

    # Only projectA's opus spend ($30) should remain; projectB's sonnet spend is excluded.
    assert round(filtered["meta"]["total_usd"], 2) == 30.0
    assert len(filtered["treemap"]) == 1
    assert filtered["treemap"][0]["project_id"] == pid_by_name["projectA"]
    # The selector still offers both projects even while one is filtered.
    assert {p["name"] for p in filtered["meta"]["available_projects"]} == {"projectA", "projectB"}


def test_team_cost_unknown_project_id_returns_zero(seeded: sqlite3.Connection) -> None:
    filtered = team_cost.team_cost_analytics(seeded, project_id=9999)

    assert filtered["meta"]["total_usd"] == 0
    assert filtered["treemap"] == []
    # An unknown id must not silently fall back to unfiltered totals.
    assert filtered["meta"]["total_usd"] != team_cost.team_cost_analytics(seeded)["meta"]["total_usd"]


def test_team_cost_project_ids_stable_across_date_filter(seeded: sqlite3.Connection) -> None:
    baseline = team_cost.team_cost_analytics(seeded)
    pid_by_name_baseline = {p["name"]: p["id"] for p in baseline["meta"]["available_projects"]}

    # Restrict the date window to exclude projectB's session (2026-05-02).
    filtered = team_cost.team_cost_analytics(seeded, date_from="2026-05-01", date_to="2026-05-01")
    pid_by_name_filtered = {p["name"]: p["id"] for p in filtered["meta"]["available_projects"]}

    assert pid_by_name_filtered == pid_by_name_baseline


def test_team_cost_uses_baseline_history_without_including_its_tokens(seeded: sqlite3.Connection) -> None:
    bundle_id = seeded.execute("SELECT id FROM team_bundles LIMIT 1").fetchone()["id"]
    rows = [
        (bundle_id, "projectA" * 8, "history-only", "2026-05-03", "2026-05-03", json.dumps({"claude-opus-4-8": OPUS})),
        (bundle_id, "projectA" * 8, "spike-a", "2026-05-04", "2026-05-04", json.dumps({"claude-opus-4-8": OPUS})),
        (bundle_id, "projectA" * 8, "spike-b", "2026-05-04", "2026-05-04", json.dumps({"claude-opus-4-8": OPUS})),
    ]
    seeded.executemany(
        "INSERT INTO team_bundle_sessions(team_bundle_id, member_id, project_id, session_id, provider, first_date, last_date, tokens_by_model_json) VALUES (?, 'm', ?, ?, 'claude', ?, ?, ?)",
        rows,
    )
    seeded.commit()

    wide = team_cost_analytics(seeded, date_from="2026-05-01", date_to="2026-05-04")
    narrow = team_cost_analytics(seeded, date_from="2026-05-04", date_to="2026-05-04")

    assert narrow["meta"]["total_usd"] == 60
    assert narrow["meta"]["total_tokens"] == 4_000_000
    assert narrow["categories"]["base_input"]["tokens"] == 2_000_000
    assert len(narrow["by_model"]) == 1
    assert narrow["by_model"][0]["usd"] == 60
    assert len(narrow["over_time"]) == 1
    assert narrow["spikes"] == wide["spikes"]
    assert narrow["spikes"][0]["baseline_usd"] == 30
    assert narrow["spikes"][0]["baseline_period_count"] == 3


def test_team_cost_merges_new_year_into_one_week(seeded: sqlite3.Connection) -> None:
    bundle_id = seeded.execute("SELECT id FROM team_bundles LIMIT 1").fetchone()["id"]
    for day in ("2025-12-30", "2026-01-01"):
        seeded.execute(
            "INSERT INTO team_bundle_sessions(team_bundle_id, member_id, project_id, session_id, provider, first_date, last_date, tokens_by_model_json) VALUES (?, 'm', ?, ?, 'claude', ?, ?, ?)",
            (bundle_id, "projectA" * 8, f"new-year-{day}", day, day, json.dumps({"claude-opus-4-8": OPUS})),
        )
    seeded.commit()

    payload = team_cost_analytics(seeded, date_from="2025-09-25", date_to="2026-01-03")

    assert payload["meta"]["bucket"] == "week"
    nonzero = [row for row in payload["over_time"] if row["total_usd"]]
    assert len(nonzero) == 1
    assert nonzero[0]["bucket"] == "2025-52"
    assert nonzero[0]["bucket_start"] == "2025-12-29"
    assert nonzero[0]["bucket_end"] == "2026-01-04"
    assert nonzero[0]["total_usd"] == 60
    assert sum(row["total_usd"] for row in payload["over_time"]) == payload["meta"]["total_usd"] == 60


def _team_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_db(conn)
    return conn


def _team_level_bundle_for_cost(tmp_path: Path, label: str | None = None) -> dict:
    return _team_level_bundle(tmp_path, label=label).to_dict()


def test_team_cost_uses_project_names_for_named_bundles(tmp_path):
    conn = _team_conn()
    # A label longer than 8 chars whose display form ("Payments API") differs
    # from its normalized grouping key ("payments-api") makes this test
    # discriminate: the old pid[:8] fallback could only ever surface
    # "payments", never the real display name.
    bundle = _team_level_bundle_for_cost(tmp_path, label="Payments API")
    team_bundles.import_team_bundle(conn, bundle, source_path=Path("a.json"))

    result = team_cost_analytics(conn)
    names = {project["name"] for project in result["meta"]["available_projects"]}
    assert "Payments API" in names
    assert "payments" not in names  # the old pid[:8]-style prefix must not appear
    if result["treemap"]:
        assert result["treemap"][0]["project_name"] == "Payments API"
