from __future__ import annotations

import argparse
import json
from pathlib import Path

import pytest

from ccfr.analysis.team_bundles import validate_team_bundle
from ccfr.cli_export import add_export_bundle_parser, run_export_bundle
from tests.fixtures import sanitized_export


def _parse(argv: list[str]) -> argparse.Namespace:
    """Build a throwaway parser so these tests don't depend on P07's cli.py."""
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    add_export_bundle_parser(sub)
    return parser.parse_args(argv)


@pytest.fixture()
def cli_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point every CCFR path at tmp dirs and lay down a synthetic export root."""
    imports = tmp_path / "imports"
    imports.mkdir()
    export_root = sanitized_export(imports)  # -> imports/sanitized-claude-export
    data_dir = tmp_path / "data"
    monkeypatch.setenv("CCFR_IMPORT_ROOT", str(export_root))
    monkeypatch.setenv("CCFR_DATA_DIR", str(data_dir))
    monkeypatch.setenv("CCFR_DB_PATH", str(data_dir / "ccfr.sqlite3"))
    return export_root


def test_level_choice_is_validated() -> None:
    with pytest.raises(SystemExit):
        _parse(["export-bundle", "--level", "everything"])


def test_team_level_requires_member_name(
    cli_env: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    out = tmp_path / "team.json"
    args = _parse(["export-bundle", "--level", "team", "--out", str(out), "--yes"])
    assert run_export_bundle(args) == 2
    assert "--member-name" in capsys.readouterr().err
    assert not out.exists()  # refused before writing anything


def test_structural_export_writes_a_valid_bundle(
    cli_env: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    out = tmp_path / "bundle.json"
    args = _parse(["export-bundle", "--out", str(out), "--yes"])
    assert run_export_bundle(args) == 0

    data = json.loads(out.read_text(encoding="utf-8"))
    canonical = validate_team_bundle(data)  # reuse the real validator
    assert canonical["privacy_level"] == "structural"
    assert data["schema_version"] == 2
    # the privacy ledger is printed before the write
    assert "NOT included" in capsys.readouterr().out


def test_projects_filter_limits_the_selection(cli_env: Path, tmp_path: Path) -> None:
    out = tmp_path / "alpha.json"
    args = _parse(["export-bundle", "--out", str(out), "--projects", "d--Alpha", "--yes"])
    assert run_export_bundle(args) == 0

    data = json.loads(out.read_text(encoding="utf-8"))
    # d--Alpha has two sessions; d--Beta is excluded.
    assert len(data["sessions"]) == 2


def test_team_level_export_writes_named_bundle(cli_env: Path, tmp_path: Path) -> None:
    out = tmp_path / "team.json"
    args = _parse([
        "export-bundle", "--level", "team", "--member-name", "Avery",
        "--projects", "d--Alpha", "--out", str(out), "--yes",
    ])
    assert run_export_bundle(args) == 0

    data = json.loads(out.read_text(encoding="utf-8"))
    assert data["privacy_level"] == "team"
    assert data["member_name"] == "Avery"
    assert validate_team_bundle(data)["member_name"] == "Avery"


def test_refuses_to_overwrite_without_force(cli_env: Path, tmp_path: Path) -> None:
    out = tmp_path / "exists.json"
    out.write_text("SENTINEL", encoding="utf-8")

    blocked = _parse(["export-bundle", "--out", str(out), "--yes"])
    assert run_export_bundle(blocked) == 1
    assert out.read_text(encoding="utf-8") == "SENTINEL"  # untouched

    forced = _parse(["export-bundle", "--out", str(out), "--yes", "--force"])
    assert run_export_bundle(forced) == 0
    assert "SENTINEL" not in out.read_text(encoding="utf-8")
