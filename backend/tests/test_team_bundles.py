from __future__ import annotations

import copy
import datetime
import json
import sqlite3
from pathlib import Path

import pytest

from ccfr.analysis import team_bundles
from ccfr.analysis.contribution import bucket_model
from ccfr.ingest import import_export
from ccfr.storage import init_db
from tests.fixtures import ALPHA_SESSION_ID, BETA_SESSION_ID, sanitized_export
from tests.test_contribution import SENTINELS, _allowed_syms, _export_with_sentinels


def _bundle_from_sanitized(tmp_path):
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_db(conn)
    import_export(conn, sanitized_export(tmp_path))
    try:
        return team_bundles.build_team_bundle(
            conn,
            salt="00ff" * 16,
            member_id="22222222-2222-2222-2222-222222222222",
            app_version="0.1.0",
            generated_on=datetime.date(2026, 6, 18),
        )
    finally:
        conn.close()


def test_team_bundle_has_profile_and_pseudonymous_ids(tmp_path):
    bundle = _bundle_from_sanitized(tmp_path)
    data = bundle.to_dict()

    assert data["schema_version"] == 1
    assert data["profile"] == "team_strict"
    assert data["member_id"] == "22222222-2222-2222-2222-222222222222"
    assert data["generated_at"] == "2026-06-18"
    assert len(data["bundle_id"]) == 64

    blob = json.dumps(data)
    assert ALPHA_SESSION_ID not in blob
    assert BETA_SESSION_ID not in blob
    assert "d--Alpha" not in blob
    for session in data["sessions"]:
        assert len(session["pid"]) == 64
        assert len(session["sid"]) == 64
        int(session["pid"], 16)
        int(session["sid"], 16)
        assert session["provider"] == "claude"
        assert "T" not in session["first_date"]
        assert "T" not in session["last_date"]


def test_team_bundle_pseudonymous_ids_are_stable_for_same_salt(tmp_path):
    left = tmp_path / "left"
    right = tmp_path / "right"
    left.mkdir()
    right.mkdir()
    first = _bundle_from_sanitized(left).to_dict()
    second = _bundle_from_sanitized(right).to_dict()

    first_ids = [(session["pid"], session["sid"]) for session in first["sessions"]]
    second_ids = [(session["pid"], session["sid"]) for session in second["sessions"]]
    assert first_ids == second_ids
    assert first["bundle_id"] == second["bundle_id"]


def test_team_bundle_never_leaks_sentinels(tmp_path):
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_db(conn)
    import_export(conn, _export_with_sentinels(tmp_path))
    try:
        bundle = team_bundles.build_team_bundle(
            conn,
            salt="abcd" * 16,
            member_id="member",
            app_version="0.1.0",
            generated_on=datetime.date(2026, 6, 18),
        )
    finally:
        conn.close()

    blob = json.dumps(bundle.to_dict())
    for sentinel in SENTINELS:
        assert sentinel not in blob, f"leaked sentinel: {sentinel}"


def test_team_bundle_sequence_is_closed_vocabulary(tmp_path):
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_db(conn)
    import_export(conn, _export_with_sentinels(tmp_path))
    try:
        bundle = team_bundles.build_team_bundle(
            conn,
            salt="abcd" * 16,
            member_id="member",
            app_version="0.1.0",
            generated_on=datetime.date(2026, 6, 18),
        )
    finally:
        conn.close()

    allowed = _allowed_syms()
    steps = [step for session in bundle.to_dict()["sessions"] for step in session["sequence"]]
    assert steps
    for step in steps:
        assert step["fam"] in {"tool_call", "tool_result"}
        assert step["sym"] in allowed


def test_team_dashboard_date_to_includes_sessions_without_last_date():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_db(conn)
    cur = conn.execute(
        """
        INSERT INTO team_bundles(
            bundle_id, profile, schema_version, member_id, generated_at,
            app_version, imported_at, source_path, session_count
        )
        VALUES ('bundle', 'team_strict', 1, 'member', '2026-01-01',
                '0.1.0', '2026-01-01T00:00:00Z', 'bundle.json', 2)
        """
    )
    bundle_pk = cur.lastrowid
    conn.executemany(
        """
        INSERT INTO team_bundle_sessions(
            team_bundle_id, member_id, project_id, session_id, provider,
            first_date, last_date
        )
        VALUES (?, 'member', ?, ?, 'claude', ?, ?)
        """,
        [
            (bundle_pk, "p", "early", "2026-01-01", "2026-06-15"),
            (bundle_pk, "p", "late", "2027-01-01", None),
        ],
    )
    conn.commit()

    result = team_bundles.team_dashboard(conn)

    # The later session has no last_date; date_to must still reflect its first_date.
    assert result["meta"]["date_to"] == "2027-01-01"


def test_import_team_bundle_round_trips_tokens_by_model(tmp_path):
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_db(conn)
    import_export(conn, sanitized_export(tmp_path))
    bundle = team_bundles.build_team_bundle(
        conn,
        salt="00ff" * 16,
        member_id="member",
        app_version="0.1.0",
        generated_on=datetime.date(2026, 6, 18),
    )
    data = bundle.to_dict()

    team_bundles.import_team_bundle(conn, data, source_path=Path("bundle.json"))

    stored = {
        row["session_id"]: json.loads(row["tokens_by_model_json"])
        for row in conn.execute("SELECT session_id, tokens_by_model_json FROM team_bundle_sessions").fetchall()
    }
    assert any(stored.values())
    for session in data["sessions"]:
        assert stored[session["sid"]] == session["tokens_by_model"]
    conn.close()


def test_team_bundle_tokens_by_model_sum_to_session_tokens(tmp_path):
    data = _bundle_from_sanitized(tmp_path).to_dict()

    assert any(session["tokens_by_model"] for session in data["sessions"])
    for session in data["sessions"]:
        tbm = session["tokens_by_model"]
        for key in team_bundles.TOKEN_KEYS:
            assert sum(vals[key] for vals in tbm.values()) == session["tokens"][key]
        # Keys are bucketed model families (idempotent under bucket_model).
        for family in tbm:
            assert bucket_model(family) == family


def test_validate_team_bundle_accepts_legacy_without_tokens_by_model(tmp_path):
    data = _bundle_from_sanitized(tmp_path).to_dict()
    data.pop("bundle_id")
    for session in data["sessions"]:
        session.pop("tokens_by_model", None)

    canonical = team_bundles.validate_team_bundle(data)

    for session in canonical["sessions"]:
        assert session["tokens_by_model"] == {}


def test_validate_team_bundle_buckets_raw_tokens_by_model(tmp_path):
    data = _bundle_from_sanitized(tmp_path).to_dict()
    mutated = copy.deepcopy(data)
    mutated.pop("bundle_id")
    mutated["sessions"][0]["tokens_by_model"] = {
        "SECRET_MODEL_zzz": {"input": 5, "output": 3, "base": 5, "cache_5m": 0, "cache_1h": 0, "cache_read": 0}
    }

    canonical = team_bundles.validate_team_bundle(mutated)

    assert "SECRET_MODEL_zzz" not in json.dumps(canonical)
    assert canonical["sessions"][0]["tokens_by_model"] == {
        "other": {"input": 5, "output": 3, "base": 5, "cache_5m": 0, "cache_1h": 0, "cache_read": 0}
    }


def test_validate_team_bundle_rejects_invalid_profile_and_schema(tmp_path):
    data = _bundle_from_sanitized(tmp_path).to_dict()

    bad_profile = {**data, "profile": "loose"}
    with pytest.raises(ValueError, match="profile"):
        team_bundles.validate_team_bundle(bad_profile)

    bad_schema = {**data, "schema_version": 2}
    with pytest.raises(ValueError, match="schema_version"):
        team_bundles.validate_team_bundle(bad_schema)


def test_validate_team_bundle_canonicalizes_raw_symbol_and_model(tmp_path):
    data = _bundle_from_sanitized(tmp_path).to_dict()
    mutated = copy.deepcopy(data)
    mutated.pop("bundle_id")
    mutated["sessions"][0]["models"] = ["SECRET_MODEL_zzz"]
    mutated["sessions"][0]["sequence"] = [
        {"sym": "CALL:mcp__SECRET_SERVER__deploy", "fam": "tool_call", "dt_s": 1, "out_tok": 2}
    ]

    canonical = team_bundles.validate_team_bundle(mutated)

    blob = json.dumps(canonical)
    assert "SECRET_MODEL_zzz" not in blob
    assert "SECRET_SERVER" not in blob
    assert canonical["sessions"][0]["models"] == ["other"]
    assert canonical["sessions"][0]["sequence"][0]["sym"] == "CALL:mcp"


def _team_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_db(conn)
    return conn


def _redated(bundle_dict: dict, generated_at: str) -> dict:
    newer = copy.deepcopy(bundle_dict)
    newer.pop("bundle_id", None)
    newer["generated_at"] = generated_at
    newer["bundle_id"] = team_bundles.bundle_content_id(newer)
    return newer


def _reseq(bundle_dict: dict, generated_at: str, generated_seq: int) -> dict:
    updated = copy.deepcopy(bundle_dict)
    updated.pop("bundle_id", None)
    updated["generated_at"] = generated_at
    updated["generated_seq"] = generated_seq
    updated["bundle_id"] = team_bundles.bundle_content_id(updated)
    return updated


def test_team_dashboard_counts_subagent_sessions_once_per_session(tmp_path):
    bundle = _bundle_from_sanitized(tmp_path).to_dict()
    bundle.pop("bundle_id", None)
    bundle["sessions"][0]["subagents"] = [
        {"agent_type": "custom", "event_count": 3},
        {"agent_type": "custom", "event_count": 2},
    ]
    bundle["bundle_id"] = team_bundles.bundle_content_id(bundle)
    conn = _team_conn()

    team_bundles.import_team_bundle(conn, bundle, source_path=Path("a.json"))
    dashboard = team_bundles.team_dashboard(conn)

    custom = next(item for item in dashboard["subagents"] if item["agent_type"] == "custom")
    assert custom["session_count"] == 1
    assert custom["event_count"] == 5


def test_reimport_newer_bundle_replaces_members_previous_sessions(tmp_path):
    bundle = _bundle_from_sanitized(tmp_path).to_dict()
    newer = _redated(bundle, "2026-06-19")
    conn = _team_conn()

    first = team_bundles.import_team_bundle(conn, bundle, source_path=Path("a.json"))
    second = team_bundles.import_team_bundle(conn, newer, source_path=Path("b.json"))

    assert first.imported and first.status == "imported"
    assert second.imported and second.status == "replaced"
    # Exactly one bundle row for the member; sessions counted once.
    assert conn.execute("SELECT COUNT(*) FROM team_bundles").fetchone()[0] == 1
    assert (
        conn.execute("SELECT COUNT(*) FROM team_bundle_sessions").fetchone()[0]
        == len(bundle["sessions"])
    )
    dash = team_bundles.team_dashboard(conn)
    assert dash["meta"]["session_count"] == len(bundle["sessions"])
    assert dash["meta"]["bundle_count"] == 1
    assert len(dash["members"]) == 1


def test_import_stale_bundle_is_skipped(tmp_path):
    bundle = _bundle_from_sanitized(tmp_path).to_dict()   # generated 2026-06-18
    newer = _redated(bundle, "2026-06-19")
    conn = _team_conn()

    team_bundles.import_team_bundle(conn, newer, source_path=Path("b.json"))
    result = team_bundles.import_team_bundle(conn, bundle, source_path=Path("a.json"))

    assert not result.imported and result.status == "stale"
    assert conn.execute("SELECT COUNT(*) FROM team_bundles").fetchone()[0] == 1
    assert (
        conn.execute("SELECT generated_at FROM team_bundles").fetchone()[0]
        == "2026-06-19"
    )


def test_reimport_identical_bundle_stays_duplicate(tmp_path):
    bundle = _bundle_from_sanitized(tmp_path).to_dict()
    conn = _team_conn()
    team_bundles.import_team_bundle(conn, bundle, source_path=Path("a.json"))
    result = team_bundles.import_team_bundle(conn, bundle, source_path=Path("a.json"))
    assert not result.imported and result.status == "duplicate"
    assert conn.execute("SELECT COUNT(*) FROM team_bundle_sessions").fetchone()[0] == len(bundle["sessions"])


def _with_fewer_sessions(bundle_dict: dict) -> dict:
    """A distinct-content variant (drops one session) so its bundle_id differs.

    generated_seq is deliberately excluded from bundle_content_id's key tuple
    (two identical-content same-day bundles legitimately share an id, and the
    duplicate check handles that case) -- so tests that exercise the
    (generated_at, generated_seq) ordering must vary content, not just seq, to
    avoid tripping the duplicate check instead of the ordering logic.
    """
    thinned = copy.deepcopy(bundle_dict)
    thinned.pop("bundle_id", None)
    thinned["sessions"] = thinned["sessions"][:-1]
    thinned["bundle_id"] = team_bundles.bundle_content_id(thinned)
    return thinned


def test_same_day_out_of_order_import_marks_earlier_seq_as_stale(tmp_path):
    bundle = _bundle_from_sanitized(tmp_path).to_dict()
    assert len(bundle["sessions"]) > 1
    seq_two = _reseq(bundle, "2026-06-18", 2)
    seq_one = _reseq(_with_fewer_sessions(bundle), "2026-06-18", 1)
    conn = _team_conn()

    first = team_bundles.import_team_bundle(conn, seq_two, source_path=Path("a.json"))
    second = team_bundles.import_team_bundle(conn, seq_one, source_path=Path("b.json"))

    assert first.imported and first.status == "imported"
    assert not second.imported and second.status == "stale"
    # The first (higher-seq) bundle's row and sessions must be untouched.
    assert conn.execute("SELECT COUNT(*) FROM team_bundles").fetchone()[0] == 1
    assert conn.execute("SELECT generated_seq FROM team_bundles").fetchone()[0] == 2
    assert (
        conn.execute("SELECT COUNT(*) FROM team_bundle_sessions").fetchone()[0]
        == len(bundle["sessions"])
    )


def test_same_day_in_order_import_replaces(tmp_path):
    bundle = _bundle_from_sanitized(tmp_path).to_dict()
    assert len(bundle["sessions"]) > 1
    seq_one = _reseq(_with_fewer_sessions(bundle), "2026-06-18", 1)
    seq_two = _reseq(bundle, "2026-06-18", 2)
    conn = _team_conn()

    first = team_bundles.import_team_bundle(conn, seq_one, source_path=Path("a.json"))
    second = team_bundles.import_team_bundle(conn, seq_two, source_path=Path("b.json"))

    assert first.imported and first.status == "imported"
    assert second.imported and second.status == "replaced"
    assert conn.execute("SELECT COUNT(*) FROM team_bundles").fetchone()[0] == 1
    assert conn.execute("SELECT generated_seq FROM team_bundles").fetchone()[0] == 2
    assert (
        conn.execute("SELECT COUNT(*) FROM team_bundle_sessions").fetchone()[0]
        == len(bundle["sessions"])
    )


def test_legacy_bundle_without_generated_seq_validates_and_imports_as_zero(tmp_path):
    bundle = _bundle_from_sanitized(tmp_path).to_dict()
    assert len(bundle["sessions"]) > 1
    legacy = _with_fewer_sessions(bundle)
    legacy.pop("generated_seq", None)
    legacy.pop("bundle_id", None)
    legacy["bundle_id"] = team_bundles.bundle_content_id(legacy)

    canonical = team_bundles.validate_team_bundle(legacy)
    assert canonical["generated_seq"] == 0

    conn = _team_conn()
    result = team_bundles.import_team_bundle(conn, legacy, source_path=Path("a.json"))
    assert result.imported and result.status == "imported"
    assert conn.execute("SELECT generated_seq FROM team_bundles").fetchone()[0] == 0

    # A same-day bundle with seq 1 must beat the legacy (implicit seq 0) bundle.
    beats_legacy = _reseq(bundle, str(legacy["generated_at"]), 1)
    second = team_bundles.import_team_bundle(conn, beats_legacy, source_path=Path("b.json"))
    assert second.imported and second.status == "replaced"


def test_legacy_bundle_on_a_later_date_beats_an_earlier_high_seq_bundle(tmp_path):
    bundle = _bundle_from_sanitized(tmp_path).to_dict()
    earlier_high_seq = _reseq(bundle, "2026-06-18", 5)
    conn = _team_conn()
    first = team_bundles.import_team_bundle(conn, earlier_high_seq, source_path=Path("a.json"))
    assert first.imported and first.status == "imported"

    legacy_later = copy.deepcopy(bundle)
    legacy_later.pop("generated_seq", None)
    legacy_later.pop("bundle_id", None)
    legacy_later["generated_at"] = "2026-06-19"
    legacy_later["bundle_id"] = team_bundles.bundle_content_id(legacy_later)

    second = team_bundles.import_team_bundle(conn, legacy_later, source_path=Path("b.json"))
    assert second.imported and second.status == "replaced"


def test_validate_team_bundle_rejects_negative_generated_seq(tmp_path):
    data = _bundle_from_sanitized(tmp_path).to_dict()
    bad = {**data, "generated_seq": -1}
    with pytest.raises(ValueError, match="generated_seq"):
        team_bundles.validate_team_bundle(bad)


def test_validate_team_bundle_rejects_non_int_generated_seq(tmp_path):
    data = _bundle_from_sanitized(tmp_path).to_dict()
    bad = {**data, "generated_seq": "x"}
    with pytest.raises(ValueError, match="generated_seq"):
        team_bundles.validate_team_bundle(bad)


def test_delete_team_member_removes_only_that_member(tmp_path):
    bundle = _bundle_from_sanitized(tmp_path).to_dict()
    other = copy.deepcopy(bundle)
    other.pop("bundle_id", None)
    other["member_id"] = "33333333-3333-3333-3333-333333333333"
    other["bundle_id"] = team_bundles.bundle_content_id(other)
    conn = _team_conn()
    team_bundles.import_team_bundle(conn, bundle, source_path=Path("a.json"))
    team_bundles.import_team_bundle(conn, other, source_path=Path("b.json"))

    removed = team_bundles.delete_team_member(conn, bundle["member_id"])

    assert removed == 1
    members = [r[0] for r in conn.execute("SELECT DISTINCT member_id FROM team_bundles")]
    assert members == [other["member_id"]]
    assert (
        conn.execute("SELECT COUNT(*) FROM team_bundle_sessions").fetchone()[0]
        == len(other["sessions"])
    )
    assert team_bundles.delete_team_member(conn, bundle["member_id"]) == 0
