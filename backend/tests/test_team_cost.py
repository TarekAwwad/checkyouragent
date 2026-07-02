from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from ccfr.analysis import team_cost
from ccfr.storage import init_db

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
    assert payload["meta"]["total_usd"] == 0
    assert set(payload["meta"]["unpriced_models"]) == {"claude-opus-4-8", "claude-sonnet-4-6"}
    conn.close()


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
