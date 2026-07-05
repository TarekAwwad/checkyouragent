from __future__ import annotations

import importlib.util
import sqlite3
import sys
from pathlib import Path

import pytest

from ccfr.storage import init_db
from ccfr.ingest import import_export

REPO = Path(__file__).resolve().parents[2]
GENERATOR = REPO / "demo" / "generate_demo_data.py"


def _load_generator():
    spec = importlib.util.spec_from_file_location("demo_generate_demo_data", GENERATOR)
    module = importlib.util.module_from_spec(spec)
    # Register before exec so dataclasses can resolve the module's annotations.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _generate(tmp_path: Path) -> Path:
    out = tmp_path / "claude-export"
    _load_generator().generate(out)
    return out


def _import(out: Path):
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_db(conn)
    summary = import_export(conn, out)
    return conn, summary


def test_generated_tree_imports_without_errors(tmp_path):
    conn, summary = _import(_generate(tmp_path))
    assert summary.error_count == 0
    assert summary.project_count == 3
    assert summary.session_count == 46
    assert summary.memory_count == 6
    assert summary.subagent_count >= 24
    names = {row["export_name"] for row in conn.execute("SELECT export_name FROM projects")}
    assert names == {"demo-web-shop", "demo-mobile-app", "demo-data-pipeline"}


def test_generation_is_deterministic(tmp_path):
    a = _generate(tmp_path / "a")
    b = _generate(tmp_path / "b")

    def snapshot(root: Path) -> dict[str, bytes]:
        return {
            str(p.relative_to(root)).replace("\\", "/"): p.read_bytes()
            for p in sorted(root.rglob("*")) if p.is_file()
        }

    assert snapshot(a) == snapshot(b)


def _priced_conn(tmp_path, monkeypatch):
    monkeypatch.setenv("CCFR_PRICING_PATH", str(REPO / "pricing.csv"))
    monkeypatch.setenv("CCFR_PRICING_DIR", str(tmp_path / "no-snapshots"))
    conn, _summary = _import(_generate(tmp_path))
    return conn


def test_all_four_context_archetypes_meet_support(tmp_path, monkeypatch):
    from ccfr.analysis.context_economics import context_economics_analytics

    conn = _priced_conn(tmp_path, monkeypatch)
    payload = context_economics_analytics(conn, min_support=3)

    assert payload["meta"]["cost_available"] is True
    assert payload["meta"]["avoidable_usd"] > 0
    by_key = {a["key"]: a for a in payload["archetypes"]}
    for key in ("rereads", "oversized", "late_compaction", "stale_continuation"):
        assert by_key[key]["meets_support"] is True, key
        assert by_key[key]["findings_count"] >= 3, key


def test_discovery_finds_a_significant_subgroup(tmp_path, monkeypatch):
    from ccfr.analysis.discovery import discovery_analytics

    conn = _priced_conn(tmp_path, monkeypatch)
    payload = discovery_analytics(conn, min_support=5)

    assert payload["meta"]["cost_available"] is True
    assert any(section["results"] for section in payload["sections"].values())


def test_triage_signals_present(tmp_path, monkeypatch):
    conn = _priced_conn(tmp_path, monkeypatch)
    assert conn.execute("SELECT MAX(loop_count) FROM session_stats").fetchone()[0] >= 1
    assert conn.execute("SELECT MAX(error_count) FROM session_stats").fetchone()[0] >= 1
    assert conn.execute("SELECT COUNT(*) FROM subagents").fetchone()[0] >= 24
