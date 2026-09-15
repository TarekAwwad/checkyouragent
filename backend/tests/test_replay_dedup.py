"""Resumed/forked sessions replay prior history; those copies must not be re-counted."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from ccfr.analysis import context_economics, discovery, team_bundles, usage_map
from ccfr.analysis.pricing import load_price_timeline
from ccfr.api import analytics, repository
from ccfr.config import pricing_dir, pricing_path
from ccfr.ingest import import_export
from ccfr.storage import init_db
from ccfr.storage.database import mark_replay_events


def memory_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_db(conn)
    return conn


def _turn(
    uuid: str,
    parent: str | None,
    minute: int,
    *,
    output_tokens: int = 100,
    session_id: str = "",
) -> list[str]:
    """One user turn plus its priced assistant reply, as two JSONL lines."""
    ts = f"2026-01-01T00:{minute:02d}"
    user = {
        "type": "user",
        "uuid": f"u{uuid}",
        "parentUuid": parent,
        "sessionId": session_id,
        "timestamp": f"{ts}:00Z",
        "message": {"role": "user", "content": "hi"},
    }
    assistant = {
        "type": "assistant",
        "uuid": f"a{uuid}",
        "parentUuid": f"u{uuid}",
        "sessionId": session_id,
        "timestamp": f"{ts}:01Z",
        "message": {
            "id": f"msg_{uuid}",
            "role": "assistant",
            "model": "claude-opus-4-8",
            "content": [{"type": "text", "text": "ok"}],
            "usage": {
                "input_tokens": 1000,
                "cache_read_input_tokens": 5000,
                "cache_creation_input_tokens": 200,
                "output_tokens": output_tokens,
            },
        },
    }
    return [json.dumps(user), json.dumps(assistant)]


def _write_session(
    project: Path,
    session_id: str,
    turns: list[str],
    *,
    origin: str | None = None,
    start_minute: int = 0,
) -> None:
    """Write one session file.

    ``origin`` is the sessionId stamped on every record. A resume preserves the original
    session's id there; a fork re-stamps it as its own. Defaults to self-claiming.
    """
    project.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    parent: str | None = None
    for turn in turns:
        lines.extend(
            _turn(turn, parent, start_minute + len(lines), session_id=origin or session_id)
        )
        parent = f"a{turn}"
    (project / f"{session_id}.jsonl").write_text("\n".join(lines), encoding="utf-8")


ORIGINAL = "11111111-1111-1111-1111-111111111111"
RESUMED = "22222222-2222-2222-2222-222222222222"


def _export_with_resume(root: Path, *, reverse_filenames: bool = False) -> Path:
    """Original session with 2 turns; a resume replaying both and adding a third.

    ``reverse_filenames`` swaps the two session uuids so the resume sorts (and therefore
    imports) first. Ownership must not move as a result.
    """
    original, resumed = (RESUMED, ORIGINAL) if reverse_filenames else (ORIGINAL, RESUMED)
    project = root / "d--Alpha"
    _write_session(project, original, ["1", "2"], start_minute=0)
    # A resume replays the original's records verbatim, sessionId included.
    _write_session(project, resumed, ["1", "2", "3"], origin=original, start_minute=0)
    return root


def _session_pks(conn: sqlite3.Connection) -> dict[str, int]:
    return {r["session_id"]: r["id"] for r in conn.execute("SELECT id, session_id FROM sessions")}


def _flagged_session_uuids(conn: sqlite3.Connection) -> set[str]:
    return {
        r[0]
        for r in conn.execute(
            "SELECT DISTINCT s.session_id FROM events e JOIN sessions s ON s.id = e.session_id"
            " WHERE e.is_replay = 1"
        )
    }


def test_replayed_events_are_flagged_and_originals_are_not(tmp_path: Path) -> None:
    conn = memory_conn()
    import_export(conn, _export_with_resume(tmp_path))

    # 5 turns imported across both files, but only 3 distinct ones.
    assert conn.execute("SELECT COUNT(*) FROM events").fetchone()[0] == 10
    assert conn.execute("SELECT COUNT(*) FROM events WHERE is_replay = 0").fetchone()[0] == 6
    assert conn.execute("SELECT COUNT(*) FROM events WHERE is_replay = 1").fetchone()[0] == 4

    # The replay names the original in its records, so the original keeps its own
    # events and the resume owns only the turn it actually added.
    assert _flagged_session_uuids(conn) == {RESUMED}

    # Every uuid survives exactly once.
    dupes = conn.execute(
        "SELECT COUNT(*) FROM (SELECT uuid FROM events WHERE is_replay = 0 AND uuid IS NOT NULL"
        " GROUP BY uuid HAVING COUNT(*) > 1)"
    ).fetchone()[0]
    assert dupes == 0


def test_ownership_does_not_depend_on_import_order(tmp_path: Path) -> None:
    """Swapping the filenames swaps import order; ownership must not follow it.

    The uuids decide which file is read first, so with the names reversed the resume is
    imported before the original. Attribution has to stay with the session the records
    name as their origin, not with whichever row landed in the table first.
    """
    conn = memory_conn()
    import_export(conn, _export_with_resume(tmp_path, reverse_filenames=True))

    # ORIGINAL/RESUMED are now swapped, so the resume carries the ORIGINAL uuid.
    assert _flagged_session_uuids(conn) == {ORIGINAL}
    assert conn.execute("SELECT COUNT(*) FROM events WHERE is_replay = 1").fetchone()[0] == 4

    pks = _session_pks(conn)
    owner = repository.session_cost(conn, pks[RESUMED])   # the original run
    replay = repository.session_cost(conn, pks[ORIGINAL])  # the resume
    assert owner["usd"] == round(2 * replay["usd"], 6)


def test_fork_that_restamps_history_still_yields_one_owner(tmp_path: Path) -> None:
    """A fork rewrites sessionId to its own, so both sessions claim the shared turns.

    The origination claim cannot separate them, so the earlier-starting session wins and
    exactly one copy of each uuid is still counted.
    """
    project = tmp_path / "d--Alpha"
    _write_session(project, ORIGINAL, ["1", "2"], start_minute=0)
    # No origin= -> the fork stamps every replayed record as its own, and starts later.
    _write_session(project, RESUMED, ["1", "2", "3"], start_minute=10)

    conn = memory_conn()
    import_export(conn, project.parent)

    assert conn.execute("SELECT COUNT(*) FROM events WHERE is_replay = 1").fetchone()[0] == 4
    assert _flagged_session_uuids(conn) == {RESUMED}
    dupes = conn.execute(
        "SELECT COUNT(*) FROM (SELECT uuid FROM events WHERE is_replay = 0 AND uuid IS NOT NULL"
        " GROUP BY uuid HAVING COUNT(*) > 1)"
    ).fetchone()[0]
    assert dupes == 0


def test_resumed_session_does_not_inflate_cost(tmp_path: Path) -> None:
    conn = memory_conn()
    import_export(conn, _export_with_resume(tmp_path))

    pks = _session_pks(conn)
    original = repository.session_cost(conn, pks[ORIGINAL])
    resumed = repository.session_cost(conn, pks[RESUMED])

    # Two turns are attributed to the original and only the new one to the resume,
    # so the pair sums to three turns, not five.
    assert original["usd"] > 0
    assert resumed["usd"] > 0
    assert original["usd"] == round(2 * resumed["usd"], 6)

    cost = analytics.cost_analytics(conn)
    assert cost["meta"]["total_usd"] == round(original["usd"] + resumed["usd"], 6)


def test_events_without_uuid_are_never_flagged(tmp_path: Path) -> None:
    project = tmp_path / "d--Alpha"
    project.mkdir(parents=True)
    line = '{"type":"summary","timestamp":"2026-01-01T00:00:00Z","summary":"s"}'
    (project / f"{ORIGINAL}.jsonl").write_text("\n".join([line, line]), encoding="utf-8")

    conn = memory_conn()
    import_export(conn, tmp_path)

    assert conn.execute("SELECT COUNT(*) FROM events WHERE uuid IS NULL").fetchone()[0] == 2
    assert conn.execute("SELECT COUNT(*) FROM events WHERE is_replay = 1").fetchone()[0] == 0


def test_same_uuid_in_two_projects_is_not_cross_flagged(tmp_path: Path) -> None:
    _write_session(tmp_path / "d--Alpha", ORIGINAL, ["1"])
    _write_session(tmp_path / "d--Beta", RESUMED, ["1"])

    conn = memory_conn()
    import_export(conn, tmp_path)

    # Same uuids, different projects: both are canonical for their own project.
    assert conn.execute("SELECT COUNT(*) FROM events WHERE is_replay = 1").fetchone()[0] == 0


def test_reimport_recomputes_flags(tmp_path: Path) -> None:
    conn = memory_conn()
    import_export(conn, _export_with_resume(tmp_path))
    assert conn.execute("SELECT COUNT(*) FROM events WHERE is_replay = 1").fetchone()[0] == 4

    # Drop the resume and re-import: nothing is a replay any more.
    (tmp_path / "d--Alpha" / f"{RESUMED}.jsonl").unlink()
    import_export(conn, tmp_path)

    assert conn.execute("SELECT COUNT(*) FROM events WHERE is_replay = 1").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM events").fetchone()[0] == 4


def test_marking_is_idempotent(tmp_path: Path) -> None:
    conn = memory_conn()
    import_export(conn, _export_with_resume(tmp_path))

    before = conn.execute("SELECT id, is_replay FROM events ORDER BY id").fetchall()
    mark_replay_events(conn)
    mark_replay_events(conn)
    after = conn.execute("SELECT id, is_replay FROM events ORDER BY id").fetchall()

    assert [tuple(r) for r in before] == [tuple(r) for r in after]


def test_migration_backfills_existing_database(tmp_path: Path) -> None:
    """A cache built before the column exists gets flagged on open, without re-import."""
    conn = memory_conn()
    import_export(conn, _export_with_resume(tmp_path))

    # Simulate the pre-migration shape: neither the index nor the column exists.
    conn.execute("DROP INDEX idx_events_replay")
    conn.execute("ALTER TABLE events DROP COLUMN is_replay")
    assert "is_replay" not in {
        r[1] for r in conn.execute("PRAGMA table_info(events)").fetchall()
    }

    init_db(conn)  # runs migrate_db

    assert conn.execute("SELECT COUNT(*) FROM events WHERE is_replay = 1").fetchone()[0] == 4


# One turn bills 1000 base + 5000 cache-read + 200 cache-write + 100 output.
TOKENS_PER_TURN = 6300
DISTINCT_TURNS = 3   # the resume adds one turn on top of the original's two
RAW_TURNS = 5        # what a naive per-file count would see


def test_every_cost_and_token_view_counts_each_event_once(tmp_path: Path) -> None:
    """The corpus has 3 distinct turns recorded across 2 files holding 5 turns total.

    Each view reaches the tokens by a different query, so this pins them to the same
    answer rather than checking a filter is present in any one of them.
    """
    conn = memory_conn()
    import_export(conn, _export_with_resume(tmp_path))

    expected_tokens = DISTINCT_TURNS * TOKENS_PER_TURN
    naive_tokens = RAW_TURNS * TOKENS_PER_TURN

    # 1. Cost page
    cost = analytics.cost_analytics(conn)
    assert cost["meta"]["total_tokens"] == expected_tokens

    # 2. Per-session costs, summed
    pks = _session_pks(conn)
    session_total = sum(repository.session_cost(conn, pk)["usd"] for pk in pks.values())
    assert round(session_total, 6) == cost["meta"]["total_usd"]

    # 3. Context economics corpus currency
    assert context_economics._corpus_total_tokens(conn, None) == expected_tokens
    economics = context_economics.context_economics_analytics(conn)
    assert economics["meta"]["recorded_api_equivalent_usd"] == cost["meta"]["total_usd"]

    # 4. Usage map / limits share load_events
    timeline = load_price_timeline(pricing_path(), pricing_dir())
    loaded = usage_map.load_events(conn, timeline)
    assert sum(event.tokens for event in loaded) == DISTINCT_TURNS * TOKENS_PER_TURN

    # 5. Team export token rollup
    bundle_tokens = 0
    for pk in pks.values():
        for bucket in team_bundles._session_tokens_by_model(conn, pk).values():
            bundle_tokens += bucket["base"] + bucket["cache_5m"] + bucket["cache_1h"]
            bundle_tokens += bucket["cache_read"] + bucket["output"]
    assert bundle_tokens == expected_tokens

    # 6. Discovery per-session costs
    discovery_costs, _, _ = discovery._scoped_session_costs(conn, project_id=None)
    assert round(sum(discovery_costs.values()), 6) == cost["meta"]["total_usd"]

    # Guard: every figure above is genuinely below the un-deduplicated count.
    assert expected_tokens < naive_tokens


def test_migration_recomputes_flags_when_origin_claim_is_added(tmp_path: Path) -> None:
    """A cache flagged before origin_session_id existed is re-flagged, not left stale."""
    conn = memory_conn()
    import_export(conn, _export_with_resume(tmp_path, reverse_filenames=True))

    # Roll back to the older shape: keep is_replay, drop the origin claim, and
    # deliberately flag the wrong side so a stale result would be visible.
    conn.execute("ALTER TABLE events DROP COLUMN origin_session_id")
    conn.execute("UPDATE events SET is_replay = 0")
    conn.execute(
        "UPDATE events SET is_replay = 1 WHERE session_id ="
        " (SELECT id FROM sessions WHERE session_id = ?)",
        (RESUMED,),
    )
    assert _flagged_session_uuids(conn) == {RESUMED}

    init_db(conn)  # runs migrate_db

    # Recomputed with the origin claim available, ownership flips back to correct.
    assert _flagged_session_uuids(conn) == {ORIGINAL}
    assert conn.execute("SELECT COUNT(*) FROM events WHERE is_replay = 1").fetchone()[0] == 4
