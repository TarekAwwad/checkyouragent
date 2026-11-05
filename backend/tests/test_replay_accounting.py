"""Cross-session replay accounting, including the gaps found while reviewing #42."""
from __future__ import annotations

import json
import sqlite3
import time
from copy import deepcopy
from pathlib import Path

import pytest

from ccfr.analysis import (
    bundle_sanitization,
    context_economics,
    discovery,
    limits,
    team_bundles,
    usage_map,
)
from ccfr.analysis.pricing import load_price_timeline
from ccfr.api import analytics, repository, routes
from ccfr.config import pricing_dir, pricing_path
from ccfr.ingest import import_all_new, import_export
from ccfr.storage import init_db
from ccfr.storage.replay import TOKEN_COLUMNS, reconcile_replays, token_usage

ORIGINAL = "11111111-1111-1111-1111-111111111111"
RESUMED = "22222222-2222-2222-2222-222222222222"


def turn(n: int, owner: str = ORIGINAL) -> list[dict]:
    return [
        {"type": "user", "uuid": f"u{n}", "sessionId": owner,
         "timestamp": f"2026-01-01T00:0{n}:00Z", "message": {"role": "user", "content": "hello"}},
        {"type": "assistant", "uuid": f"a{n}", "parentUuid": f"u{n}", "sessionId": owner,
         "timestamp": f"2026-01-01T00:0{n}:01Z",
         "message": {"id": f"msg{n}", "role": "assistant", "model": "claude-opus-4-8",
                     "content": [{"type": "text", "text": "ok"}],
                     "usage": {"input_tokens": 1000, "cache_read_input_tokens": 5000,
                               "cache_creation_input_tokens": 200, "output_tokens": 100}}},
    ]


def write_sessions(root: Path, sessions: dict[str, list[dict]], project_name: str = "d--Synthetic") -> Path:
    project = root / project_name
    project.mkdir(parents=True, exist_ok=True)
    for sid, rows in sessions.items():
        (project / f"{sid}.jsonl").write_text("\n".join(json.dumps(row) for row in rows), encoding="utf-8")
    return project


def imported(root: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_db(conn)
    assert import_export(conn, root).error_count == 0
    return conn


def replay_export(root: Path, *, reverse: bool = False) -> Path:
    original, resumed = (RESUMED, ORIGINAL) if reverse else (ORIGINAL, RESUMED)
    return write_sessions(root, {
        original: turn(1, original) + turn(2, original),
        resumed: turn(1, original) + turn(2, original) + turn(3, resumed),
    })


def session_pk(conn, sid):
    return conn.execute("SELECT id FROM sessions WHERE session_id = ?", (sid,)).fetchone()[0]


def counted_tokens(conn):
    return analytics.cost_analytics(conn)["meta"]["total_tokens"]


def assert_views_agree(conn, expected_tokens):
    meta = analytics.cost_analytics(conn)["meta"]
    assert meta["total_tokens"] == expected_tokens
    assert conn.execute(
        "SELECT COALESCE(SUM(m.input_tokens + m.output_tokens), 0) FROM messages m"
        " JOIN events e ON e.id=m.event_id WHERE e.is_replay=1"
    ).fetchone()[0] == 0
    sessions = repository.list_sessions(conn)
    assert sum(s["input_tokens"] + s["output_tokens"] for s in sessions) == expected_tokens
    assert round(sum(s["cost_usd"] for s in sessions), 6) == meta["total_usd"]
    assert sum(p.tokens for p in routes.team_projects(conn).projects) == expected_tokens
    assert context_economics._corpus_total_tokens(conn, None) == expected_tokens
    assert context_economics.context_economics_analytics(conn)["meta"]["recorded_api_equivalent_usd"] == meta["total_usd"]
    timeline = load_price_timeline(pricing_path(), pricing_dir())
    assert sum(e.tokens for e in usage_map.load_events(conn, timeline)) == expected_tokens
    costs, _, _ = discovery._scoped_session_costs(conn, project_id=None)
    assert round(sum(costs.values()), 6) == meta["total_usd"]
    assert round(sum(repository.project_cost_map(conn)[0].values()), 6) == meta["total_usd"]
    bundles = 0
    sanitized = 0
    for session in sessions:
        pk = session["id"]
        token_buckets = team_bundles._session_tokens_by_model(conn, pk)
        bundles += sum(b["input"] + b["output"] for b in token_buckets.values())
        tokens = bundle_sanitization.session_tokens(conn, pk)
        sanitized += tokens["input"] + tokens["output"]
        turns = analytics.session_turn_cost_breakdown(conn, pk)["turns"]
        assert round(sum(t["usd"] for t in turns), 6) == session["cost_usd"]
    assert bundles == sanitized == expected_tokens


@pytest.mark.parametrize("reverse", [False, True])
def test_replayed_prefix_is_counted_once_across_views(tmp_path, reverse):
    replay_export(tmp_path, reverse=reverse)
    conn = imported(tmp_path)
    assert_views_agree(conn, 18900)
    original, resumed = (RESUMED, ORIGINAL) if reverse else (ORIGINAL, RESUMED)
    assert repository.session_cost(conn, session_pk(conn, original))["usd"] == 0.0225
    assert repository.session_cost(conn, session_pk(conn, resumed))["usd"] == 0.01125
    assert analytics.session_turn_cost_breakdown(conn, session_pk(conn, resumed))["turn_count"] == 1
    cost_sessions = analytics.cost_analytics(conn)["sessions"]
    assert next(s for s in cost_sessions if s["session_id"] == resumed)["turn_cost_stats"]["turn_count"] == 1
    assert repository.cache_stats(conn)["event_count"] == 6
    assert repository.list_projects(conn)[0]["event_count"] == 6
    # Raw session activity, history and source records remain intact.
    assert conn.execute("SELECT COUNT(*) FROM events").fetchone()[0] == 10
    assert len(repository.get_timeline(conn, session_pk(conn, resumed))) == 6
    assert len(repository.get_trace(conn, session_pk(conn, resumed))["spans"]) == 6
    assert conn.execute("SELECT COUNT(*) FROM events WHERE is_replay = 1").fetchone()[0] == 4


@pytest.mark.parametrize("has_new_turn", [False, True])
def test_copied_file_snapshots_do_not_keep_replayed_cost_turns(tmp_path, has_new_turn):
    history = []
    for n in (1, 2):
        history.extend(turn(n))
        history.append({
            "type": "file-history-snapshot",
            "messageId": f"u{n}",
            "snapshot": {
                "messageId": f"u{n}",
                "trackedFileBackups": {},
                "timestamp": f"2026-01-01T00:0{n}:02Z",
            },
            "isSnapshotUpdate": True,
        })
    resumed = history + turn(3, RESUMED) if has_new_turn else history
    write_sessions(tmp_path, {ORIGINAL: history, RESUMED: resumed})
    conn = imported(tmp_path)
    pk = session_pk(conn, RESUMED)

    detail = analytics.session_turn_cost_breakdown(conn, pk)
    summary = next(
        s["turn_cost_stats"] for s in analytics.cost_analytics(conn)["sessions"]
        if s["session_id"] == RESUMED
    )
    assert detail["turn_count"] == int(has_new_turn)
    assert detail["median_usd"] == (0.01125 if has_new_turn else 0.0)
    assert {key: detail[key] for key in summary} == summary
    assert sum(t["usd"] for t in detail["turns"]) == repository.session_cost(conn, pk)["usd"]
    # Snapshots remain in the retained transcript even though they cannot keep
    # an otherwise replayed turn in the cost distribution.
    assert len(repository.get_timeline(conn, pk)) == len(resumed)


@pytest.mark.parametrize("activity", ["unanswered_prompt", "zero_usage_response", "unpriced_response"])
def test_new_conversation_activity_keeps_turn_without_priced_cost(tmp_path, activity):
    history = turn(1)
    if activity == "unanswered_prompt":
        continuation = turn(2, RESUMED)[0]
    else:
        continuation = turn(2, RESUMED)[1]
        continuation["parentUuid"] = "u1"
        if activity == "zero_usage_response":
            continuation["message"]["usage"] = {}
        else:
            continuation["message"]["model"] = "unpriced-test-model"
    write_sessions(tmp_path, {ORIGINAL: history, RESUMED: history + [continuation]})
    conn = imported(tmp_path)

    detail = analytics.session_turn_cost_breakdown(conn, session_pk(conn, RESUMED))
    assert detail["turn_count"] == 1
    assert detail["turns"][0]["usd"] == 0
    assert detail["turns"][0]["event_count"] == 1
    assert detail["turns"][0]["assistant_message_count"] == int(activity != "unanswered_prompt")


@pytest.mark.parametrize("same_uuid", [False, True])
@pytest.mark.parametrize("missing_early_id", [False, True])
def test_partial_stream_and_event_copies_keep_most_complete_usage(tmp_path, same_uuid, missing_early_id):
    start = turn(1)
    later = deepcopy(start[1])
    later["uuid"] = "a1" if same_uuid else "a1-final"
    later["timestamp"] = "2026-01-01T00:01:02Z"
    later["message"]["usage"]["output_tokens"] = 200
    early = deepcopy(start)
    if missing_early_id:
        early[1]["message"].pop("id")
    write_sessions(tmp_path, {ORIGINAL: early, RESUMED: start + [later]})
    conn = imported(tmp_path)
    assert_views_agree(conn, 6400)
    assert analytics.cost_analytics(conn)["meta"]["total_usd"] == 0.01375
    # Reconciliation must restore records that the previous run zeroed.
    reconcile_replays(conn)
    assert_views_agree(conn, 6400)


def test_continuation_after_replayed_prompt_keeps_turn_cost(tmp_path):
    history = turn(1)
    continued = turn(2, RESUMED)[1]
    continued["parentUuid"] = "u1"
    write_sessions(tmp_path, {ORIGINAL: history, RESUMED: history + [continued]})
    conn = imported(tmp_path)
    assert_views_agree(conn, 12600)
    turns = analytics.session_turn_cost_breakdown(conn, session_pk(conn, RESUMED))["turns"]
    assert len(turns) == 1
    assert turns[0]["usd"] == 0.01125


def test_restamped_fork_with_identical_timestamps_has_stable_ownership(tmp_path):
    write_sessions(tmp_path, {RESUMED: turn(1, RESUMED), ORIGINAL: turn(1)})
    conn = imported(tmp_path)
    assert counted_tokens(conn) == 6300
    assert repository.session_cost(conn, session_pk(conn, ORIGINAL))["usd"] == 0.01125
    before = [tuple(r) for r in conn.execute("SELECT id, is_replay FROM events ORDER BY id")]
    reconcile_replays(conn)
    assert [tuple(r) for r in conn.execute("SELECT id, is_replay FROM events ORDER BY id")] == before
    conn.commit()
    assert import_all_new(conn, tmp_path).project_count == 0
    assert counted_tokens(conn) == 6300


def test_same_ids_in_separate_projects_are_not_collapsed(tmp_path):
    write_sessions(tmp_path, {ORIGINAL: turn(1)}, "d--First")
    write_sessions(tmp_path, {RESUMED: turn(1)}, "d--Second")
    conn = imported(tmp_path)
    assert_views_agree(conn, 12600)
    assert conn.execute("SELECT SUM(is_replay) FROM events").fetchone()[0] == 0
    pid = conn.execute("SELECT id FROM projects ORDER BY id LIMIT 1").fetchone()[0]
    reconcile_replays(conn, project_ids=[pid])
    reconcile_replays(conn, project_ids=[])
    assert_views_agree(conn, 12600)


@pytest.mark.parametrize("uuid_value", [None, ""])
def test_no_identities_means_no_deduplication(tmp_path, uuid_value):
    rows = turn(1)
    for row in rows:
        row["uuid"] = uuid_value
        row["message"].pop("id", None)
    write_sessions(tmp_path, {ORIGINAL: rows, RESUMED: rows})
    conn = imported(tmp_path)
    assert counted_tokens(conn) == 12600
    assert conn.execute("SELECT SUM(is_replay) FROM events").fetchone()[0] == 0


def test_event_uuid_fallback_and_copied_subagent_history(tmp_path):
    rows = turn(1)
    rows[1]["message"].pop("id")
    project = write_sessions(tmp_path, {ORIGINAL: rows})
    subagents = project / ORIGINAL / "subagents"
    subagents.mkdir(parents=True)
    (subagents / "agent-test.jsonl").write_text("\n".join(json.dumps(r) for r in rows))
    conn = imported(tmp_path)
    assert counted_tokens(conn) == 6300
    assert conn.execute("SELECT COUNT(*) FROM events").fetchone()[0] == 4
    assert conn.execute("SELECT SUM(m.input_tokens+m.output_tokens) FROM messages m JOIN events e ON e.id=m.event_id WHERE e.is_sidechain=1").fetchone()[0] == 0


def test_removing_original_reimports_and_restores_resumed_usage(tmp_path):
    project = replay_export(tmp_path)
    conn = imported(tmp_path)
    (project / f"{ORIGINAL}.jsonl").unlink()
    assert import_all_new(conn, tmp_path).project_count == 1
    assert_views_agree(conn, 18900)
    assert conn.execute("SELECT SUM(is_replay) FROM events").fetchone()[0] == 0


@pytest.mark.parametrize("existing_flags", [False, True])
def test_migration_repairs_old_cache_and_cached_summaries_without_sources(tmp_path, existing_flags):
    project = replay_export(tmp_path)
    conn = imported(tmp_path)
    # Emulate the old importer, which retained these five independent messages.
    for row in conn.execute("SELECT m.id, e.raw_json FROM messages m JOIN events e ON e.id=m.event_id").fetchall():
        usage = json.loads(row["raw_json"]).get("message", {}).get("usage", {})
        conn.execute(f"UPDATE messages SET {','.join(c+'=?' for c in TOKEN_COLUMNS)} WHERE id=?", (*token_usage(usage), row["id"]))
    conn.execute("UPDATE session_stats SET input_tokens=99999, output_tokens=99999")
    conn.execute("DELETE FROM analysis_metadata WHERE name='replay_accounting'")
    if not existing_flags:
        conn.execute("DROP INDEX idx_events_replay")
        conn.execute("ALTER TABLE events DROP COLUMN is_replay")
        conn.execute("ALTER TABLE events DROP COLUMN origin_session_id")
    for file in project.glob("*.jsonl"):
        file.unlink()
    assert conn.execute("SELECT SUM(input_tokens + output_tokens) FROM messages").fetchone()[0] == 31500
    init_db(conn)
    assert_views_agree(conn, 18900)
    before = conn.total_changes
    init_db(conn)
    # Reopening need not rescan/reset all usage rows.
    assert conn.total_changes == before
    assert_views_agree(conn, 18900)


def test_replayed_limit_hit_does_not_list_duplicate_sessions(tmp_path):
    hit = turn(1)[1]
    hit["error"] = "rate_limit"
    hit["message"].update(model="<synthetic>", content=[{"type": "text", "text": "You've hit your limit"}], usage={})
    write_sessions(tmp_path, {ORIGINAL: [hit], RESUMED: [hit]})
    conn = imported(tmp_path)
    hits = limits.detect_limit_hits(conn)
    assert len(hits) == 1
    assert len(hits[0].session_ids) == hits[0].occurrence_count == 1


def test_failed_migration_rolls_back_usage_and_retries(tmp_path, monkeypatch):
    from ccfr.storage import replay

    replay_export(tmp_path)
    conn = imported(tmp_path)
    conn.execute("DELETE FROM analysis_metadata WHERE name='replay_accounting'")
    conn.commit()

    def fail_reconciliation(conn):
        conn.execute("UPDATE messages SET input_tokens=99999")
        raise RuntimeError("interrupted replay migration")

    with monkeypatch.context() as patch:
        patch.setattr(replay, "reconcile_replays", fail_reconciliation)
        with pytest.raises(RuntimeError, match="interrupted replay migration"):
            init_db(conn)
    assert conn.execute("SELECT version FROM analysis_metadata WHERE name='replay_accounting'").fetchone() is None
    assert_views_agree(conn, 18900)
    init_db(conn)
    assert_views_agree(conn, 18900)


def test_killed_import_never_leaves_unreconciled_usage(tmp_path, monkeypatch):
    from ccfr.ingest import importer

    source = tmp_path / "source"
    replay_export(source)
    db = tmp_path / "cache.sqlite3"
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    init_db(conn)

    def killed(*args):
        raise SystemExit("killed during rebuild")

    with monkeypatch.context() as patch:
        patch.setattr(importer, "_rebuild_derived", killed)
        with pytest.raises(SystemExit):
            import_all_new(conn, source)
    conn.close()

    # The project's signature was committed, so no later import revisits it: its
    # committed usage must already be reconciled.
    reopened = sqlite3.connect(db)
    reopened.row_factory = sqlite3.Row
    init_db(reopened)
    assert import_all_new(reopened, source).project_count == 0
    assert reopened.execute("SELECT SUM(input_tokens + output_tokens) FROM messages").fetchone()[0] == 18900
    assert reopened.execute("SELECT SUM(is_replay) FROM events").fetchone()[0] == 4
    reopened.close()


def string_usage_rows(value) -> list[dict]:
    rows = turn(1)
    rows[1]["message"]["usage"] = json.dumps(value)
    return rows


@pytest.mark.parametrize("value", [{"input_tokens": 12345}, {"input_tokens": "abc"}])
def test_string_encoded_usage_is_empty_as_in_the_importer(tmp_path, value):
    write_sessions(tmp_path, {ORIGINAL: string_usage_rows(value)})
    conn = imported(tmp_path)
    assert conn.execute("SELECT SUM(input_tokens + output_tokens) FROM messages").fetchone()[0] == 0


def test_string_encoded_usage_does_not_block_opening_an_existing_cache(tmp_path):
    write_sessions(tmp_path, {ORIGINAL: string_usage_rows({"input_tokens": "abc"})})
    conn = imported(tmp_path)
    conn.execute("DELETE FROM analysis_metadata WHERE name='replay_accounting'")
    conn.commit()
    init_db(conn)
    assert conn.execute(
        "SELECT version FROM analysis_metadata WHERE name='replay_accounting'"
    ).fetchone()[0] == 1


def test_reconciliation_stays_fast_on_a_large_cache():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_db(conn)
    conn.execute(
        "INSERT INTO imports(source_path, imported_at, file_count, status, error_count)"
        " VALUES ('fixture', '2026-01-01T00:00:00Z', 0, 'completed', 0)"
    )
    conn.execute("INSERT INTO projects(import_id, export_name) VALUES (1, 'large')")
    conn.executemany(
        "INSERT INTO sessions(id, project_id, session_id) VALUES (?, 1, ?)",
        [(sid, f"s{sid}") for sid in range(1, 11)],
    )
    # Half of the events copy an event from another session.
    count = 40_000
    conn.executemany(
        "INSERT INTO events(id, session_id, source_path, line_no, uuid, type, raw_json)"
        " VALUES (?, ?, 'f.jsonl', ?, ?, 'assistant', '{}')",
        [(i, i % 10 + 1, i, f"u{i // 2}") for i in range(1, count + 1)],
    )
    conn.executemany(
        "INSERT INTO messages(event_id, role, model, input_tokens, output_tokens, base_input_tokens)"
        " VALUES (?, 'assistant', 'claude-opus-4-8', 10, 5, 10)",
        [(i,) for i in range(1, count + 1)],
    )
    started = time.perf_counter()
    reconcile_replays(conn)
    assert time.perf_counter() - started < 10
    assert conn.execute("SELECT SUM(is_replay) FROM events").fetchone()[0] == count // 2 - 1


def assistant_call(n: int, context: int, *tools: dict, owner: str = ORIGINAL, message_id: str | None = None) -> dict:
    return {
        "type": "assistant", "uuid": f"a{n}", "sessionId": owner, "timestamp": f"2026-01-01T00:{n:02d}:00Z",
        "message": {"id": message_id or f"msg{n}", "role": "assistant", "model": "claude-opus-4-8",
                    "content": list(tools) or [{"type": "text", "text": "ok"}],
                    "usage": {"input_tokens": 0, "cache_read_input_tokens": context, "output_tokens": 0}},
    }


def tool_result(n: int, tool_id: str, content: str, owner: str = ORIGINAL) -> dict:
    return {
        "type": "user", "uuid": f"r{n}", "sessionId": owner, "timestamp": f"2026-01-01T00:{n:02d}:30Z",
        "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": tool_id, "content": content}]},
    }


def read_use(tool_id: str) -> dict:
    return {"type": "tool_use", "id": tool_id, "name": "Read", "input": {"file_path": "/src/a.py"}}


def reread_history() -> list[dict]:
    """A prompt followed by the same large Read twice: one rereads finding."""
    content = "x" * 3000
    return [
        {"type": "user", "uuid": "u1", "sessionId": ORIGINAL, "timestamp": "2026-01-01T00:00:00Z",
         "message": {"role": "user", "content": "go"}},
        assistant_call(1, 10_000, read_use("t1")),
        tool_result(1, "t1", content),
        assistant_call(2, 60_000, read_use("t2")),
        tool_result(2, "t2", content),
        assistant_call(3, 110_000),
    ]


def economics(conn):
    threads, _ = context_economics.load_threads(conn)
    timeline = load_price_timeline(pricing_path(), pricing_dir())
    for thread in threads:
        context_economics.accrue_tax(thread, timeline)
    return threads, context_economics.run_detectors(threads), timeline


def contexts(threads, conn, sid):
    pk = session_pk(conn, sid)
    return [c.context_tokens for t in threads if t.session_db_id == pk for c in t.calls]


def test_resumed_thread_keeps_replayed_context_shape(tmp_path):
    alone = tmp_path / "alone"
    both = tmp_path / "both"
    write_sessions(alone, {RESUMED: reread_history()})
    write_sessions(both, {ORIGINAL: reread_history(), RESUMED: reread_history()})
    alone_conn, both_conn = imported(alone), imported(both)

    alone_threads = economics(alone_conn)[0]
    both_threads = economics(both_conn)[0]
    assert contexts(both_threads, both_conn, RESUMED) == contexts(alone_threads, alone_conn, RESUMED)
    assert contexts(both_threads, both_conn, RESUMED) == [10_000, 60_000, 110_000]


def test_full_copy_adds_no_context_findings_or_carry_cost(tmp_path):
    only = tmp_path / "only"
    both = tmp_path / "both"
    write_sessions(only, {ORIGINAL: reread_history()})
    write_sessions(both, {ORIGINAL: reread_history(), RESUMED: reread_history()})
    only_conn, both_conn = imported(only), imported(both)

    only_results = economics(only_conn)[1]
    both_threads, both_results, _ = economics(both_conn)
    expected = only_results["rereads"][0]
    assert len(expected) == 1 and expected[0].savings_usd > 0
    found = both_results["rereads"][0]
    assert [f.session_id for f in found] == [session_pk(both_conn, ORIGINAL)]
    assert found[0].savings_usd == expected[0].savings_usd

    pk = session_pk(both_conn, RESUMED)
    copy = next(t for t in both_threads if t.session_db_id == pk)
    assert sum(c.accrued_usd for c in copy.contributors) == 0


def test_new_call_after_resume_only_pays_its_own_carry(tmp_path):
    resumed = reread_history() + [assistant_call(4, 120_000, owner=RESUMED)]
    write_sessions(tmp_path, {ORIGINAL: reread_history(), RESUMED: resumed})
    conn = imported(tmp_path)
    threads, results, timeline = economics(conn)

    pk = session_pk(conn, RESUMED)
    finding = next(f for f in results["rereads"][0] if f.session_id == pk)
    new_call = next(t for t in threads if t.session_db_id == pk).calls[-1]
    read_price = timeline.price_for(new_call.model, new_call.ts).cache_read / 1_000_000
    assert finding.savings_usd == pytest.approx(finding.savings_tokens * read_price)


def test_copied_results_do_not_widen_oversized_baseline(tmp_path):
    bash = lambda tool_id: {"type": "tool_use", "id": tool_id, "name": "Bash", "input": {"command": tool_id}}
    history = [
        {"type": "user", "uuid": "u1", "sessionId": ORIGINAL, "timestamp": "2026-01-01T00:00:00Z",
         "message": {"role": "user", "content": "go"}},
        assistant_call(1, 10_000, bash("t1")),
        tool_result(1, "t1", "x" * 4000),
        assistant_call(2, 11_000, bash("t2")),
        tool_result(2, "t2", "y" * 4000),
        assistant_call(3, 12_000, bash("t3")),
        tool_result(3, "t3", "z" * 4000),
        assistant_call(4, 72_000),
    ]
    write_sessions(tmp_path, {ORIGINAL: history, RESUMED: history})
    conn = imported(tmp_path)
    findings = economics(conn)[1]["oversized"][0]
    assert [f.session_id for f in findings] == [session_pk(conn, ORIGINAL)]
    assert findings[0].counterfactual["params"]["tool_sample_size"] == 3


def test_streamed_partials_stay_one_call_in_each_session(tmp_path):
    def history():
        partial = assistant_call(1, 10_000)
        partial["message"]["usage"]["output_tokens"] = 1
        final = assistant_call(2, 10_000, message_id="msg1")
        final["message"]["usage"]["output_tokens"] = 50
        return [partial, final, assistant_call(3, 20_000)]

    write_sessions(tmp_path, {ORIGINAL: history(), RESUMED: history()})
    conn = imported(tmp_path)
    threads = economics(conn)[0]
    assert contexts(threads, conn, ORIGINAL) == [10_000, 20_000]
    assert contexts(threads, conn, RESUMED) == [10_000, 20_000]


def test_expensive_session_threshold_ignores_replay_only_sessions(tmp_path):
    def session(owner, usage_scale, prefix):
        rows = turn(1, owner)
        rows[0]["uuid"], rows[1]["uuid"] = f"{prefix}-u", f"{prefix}-a"
        rows[1]["parentUuid"] = f"{prefix}-u"
        rows[1]["message"]["id"] = f"{prefix}-m"
        rows[1]["message"]["usage"] = {"input_tokens": usage_scale, "output_tokens": 0}
        return rows

    expensive = session(ORIGINAL, 100_000, "big")
    sessions = {ORIGINAL: expensive, RESUMED: session(RESUMED, 50_000, "mid")}
    # Enough $0 copies to pull an unfiltered p90 below the mid-priced session.
    for n in range(10):
        snapshot = {"type": "file-history-snapshot", "messageId": "big-u",
                    "snapshot": {"messageId": "big-u", "trackedFileBackups": {}}}
        sessions[f"3333333{n}-3333-3333-3333-333333333333"] = expensive + [snapshot]
    write_sessions(tmp_path, sessions)
    conn = imported(tmp_path)

    subjects, _, _ = discovery._session_subjects(conn, project_id=None)
    positive = {subject.id for subject in subjects if subject.positive}
    assert positive == {session_pk(conn, ORIGINAL)}


def test_subagent_keeps_context_inherited_from_its_parent(tmp_path):
    project = write_sessions(tmp_path, {ORIGINAL: reread_history()})
    subagents = project / ORIGINAL / "subagents"
    subagents.mkdir(parents=True)
    inherited = reread_history() + [assistant_call(4, 120_000)]
    (subagents / "agent-test.jsonl").write_text("\n".join(json.dumps(row) for row in inherited))
    conn = imported(tmp_path)

    threads = economics(conn)[0]
    curves = {thread.agent_id: [c.context_tokens for c in thread.calls] for thread in threads}
    assert curves == {None: [10_000, 60_000, 110_000], "test": [10_000, 60_000, 110_000, 120_000]}


def discovery_sessions(with_copies: bool) -> dict[str, list[dict]]:
    def session(owner, usage, prefix):
        rows = turn(1, owner)
        rows[0]["uuid"], rows[1]["uuid"] = f"{prefix}-u", f"{prefix}-a"
        rows[1]["parentUuid"] = f"{prefix}-u"
        rows[1]["message"]["id"] = f"{prefix}-m"
        rows[1]["message"]["usage"] = {"input_tokens": usage, "output_tokens": 0}
        return rows

    expensive = session(ORIGINAL, 100_000, "big")
    sessions = {ORIGINAL: expensive, RESUMED: session(RESUMED, 50_000, "mid")}
    if with_copies:
        for n in range(10):
            sessions[f"3333333{n}-3333-3333-3333-333333333333"] = expensive
    return sessions


def test_replay_only_sessions_do_not_dilute_the_discovery_sample(tmp_path):
    baseline, copied = tmp_path / "baseline", tmp_path / "copied"
    write_sessions(baseline, discovery_sessions(with_copies=False))
    write_sessions(copied, discovery_sessions(with_copies=True))

    expected = discovery.discovery_analytics(imported(baseline), min_support=1)
    found = discovery.discovery_analytics(imported(copied), min_support=1)
    assert found["meta"]["total_sessions"] == expected["meta"]["total_sessions"] == 2
    assert found["sections"]["cost_associations"] == expected["sections"]["cost_associations"]


def test_session_without_messages_is_not_treated_as_a_replay(tmp_path):
    sessions = discovery_sessions(with_copies=False)
    sessions["44444444-4444-4444-4444-444444444444"] = [
        {"type": "file-history-snapshot", "messageId": "x",
         "snapshot": {"messageId": "x", "trackedFileBackups": {}}},
    ]
    write_sessions(tmp_path, sessions)
    conn = imported(tmp_path)
    assert discovery.discovery_analytics(conn, min_support=1)["meta"]["total_sessions"] == 3
