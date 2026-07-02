from __future__ import annotations

import sqlite3
from datetime import datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from ccfr.analysis.context_economics import (
    CallRec,
    EpochRec,
    RawItem,
    _percentile,
    _raw_item,
    calibrate_contributors,
    split_epochs,
)


# ---------------------------------------------------------------------------
# Epoch splitting
# ---------------------------------------------------------------------------

def test_split_epochs_single_growing_series_is_one_epoch() -> None:
    epochs = split_epochs([10_000, 12_000, 15_000, 15_500])
    assert epochs == [EpochRec(start=0, end=3, ended_by="end")]


def test_split_epochs_detects_compaction_drop() -> None:
    # 100k -> 30k is below the 60% drop ratio: epoch boundary.
    epochs = split_epochs([80_000, 100_000, 30_000, 45_000])
    assert epochs == [
        EpochRec(start=0, end=1, ended_by="compaction"),
        EpochRec(start=2, end=3, ended_by="end"),
    ]


def test_split_epochs_small_shrink_is_not_compaction() -> None:
    # 100k -> 90k (90%) stays in the same epoch (context edits shrink slightly).
    epochs = split_epochs([100_000, 90_000, 95_000])
    assert epochs == [EpochRec(start=0, end=2, ended_by="end")]


def test_split_epochs_empty() -> None:
    assert split_epochs([]) == []


# ---------------------------------------------------------------------------
# Percentile helper (nearest-rank on a sorted copy)
# ---------------------------------------------------------------------------

def test_percentile_basics() -> None:
    values = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0]
    assert _percentile(values, 0.5) == 5.0
    assert _percentile(values, 0.95) == 10.0
    assert _percentile([42.0], 0.9) == 42.0
    assert _percentile([], 0.9) == 0.0


# ---------------------------------------------------------------------------
# Contributor calibration
# ---------------------------------------------------------------------------

def _call(event_id: int, context: int, output: int = 0, ts: str = "2026-01-01T00:00:00Z") -> CallRec:
    return CallRec(event_id=event_id, ts=ts, model="claude-sonnet-4-6",
                   context_tokens=context, output_tokens=output)


def test_calibrate_scales_raw_items_to_exact_delta() -> None:
    calls = [_call(1, 10_000), _call(2, 22_000)]
    epochs = split_epochs([c.context_tokens for c in calls])
    # Two raw items of 24k and 8k chars (6k and 2k raw tokens) must be scaled
    # to sum exactly to the 12k delta: 9k and 3k.
    items = {1: [
        RawItem(kind="tool_result", label="Read a.py", raw_chars=24_000, event_id=11,
                tool_name="Read", detail="a.py"),
        RawItem(kind="user", label="User message", raw_chars=8_000, event_id=12),
    ]}
    contributors = calibrate_contributors(calls, epochs, items)

    baseline = [c for c in contributors if c.kind == "baseline"]
    assert len(baseline) == 1 and baseline[0].est_tokens == 10_000
    scaled = {c.label: c.est_tokens for c in contributors if c.kind != "baseline"}
    assert scaled == {"Read a.py": 9_000, "User message": 3_000}
    assert all(c.end_call == 1 for c in contributors)


def test_calibrate_unexplained_delta_becomes_unattributed() -> None:
    calls = [_call(1, 10_000), _call(2, 15_000)]
    epochs = split_epochs([c.context_tokens for c in calls])
    contributors = calibrate_contributors(calls, epochs, {})
    unattributed = [c for c in contributors if c.kind == "unattributed"]
    assert len(unattributed) == 1 and unattributed[0].est_tokens == 5_000


def test_calibrate_previous_output_is_a_contributor() -> None:
    calls = [_call(1, 10_000, output=2_000), _call(2, 12_000)]
    epochs = split_epochs([c.context_tokens for c in calls])
    contributors = calibrate_contributors(calls, epochs, {})
    outputs = [c for c in contributors if c.kind == "assistant_output"]
    # Only candidate in the gap, so calibration assigns it the whole 2k delta.
    assert len(outputs) == 1 and outputs[0].est_tokens == 2_000


def test_calibrate_epoch_boundary_resets_baseline_and_clips_lifetimes() -> None:
    calls = [_call(1, 100_000), _call(2, 120_000), _call(3, 30_000), _call(4, 35_000)]
    epochs = split_epochs([c.context_tokens for c in calls])
    items = {1: [RawItem(kind="tool_result", label="Big read", raw_chars=80_000, event_id=9)]}
    contributors = calibrate_contributors(calls, epochs, items)

    big = next(c for c in contributors if c.label == "Big read")
    assert (big.entry_call, big.end_call, big.epoch) == (1, 1, 0)  # dies at compaction
    baselines = [c for c in contributors if c.kind == "baseline"]
    assert [(b.entry_call, b.end_call, b.est_tokens) for b in baselines] == [
        (0, 1, 100_000), (2, 3, 30_000),
    ]


def test_calibrate_negative_delta_adds_nothing() -> None:
    calls = [_call(1, 100_000), _call(2, 95_000)]
    epochs = split_epochs([c.context_tokens for c in calls])
    items = {1: [RawItem(kind="user", label="msg", raw_chars=4_000)]}
    contributors = calibrate_contributors(calls, epochs, items)
    assert [c.kind for c in contributors] == ["baseline"]


def test_calibrate_sums_exactly_to_delta_under_rounding() -> None:
    # delta=5 split across two equal items: scale is non-integer, so naive
    # round() would give 2+2=4. Largest-remainder must yield 3+2 (sum 5).
    calls = [_call(1, 10_000), _call(2, 10_005)]
    epochs = split_epochs([c.context_tokens for c in calls])
    items = {1: [
        RawItem(kind="user", label="a", raw_chars=4_000),
        RawItem(kind="user", label="b", raw_chars=4_000),
    ]}
    contributors = [c for c in calibrate_contributors(calls, epochs, items) if c.kind != "baseline"]
    assert sum(c.est_tokens for c in contributors) == 5
    assert sorted(c.est_tokens for c in contributors) == [2, 3]


def test_calibrate_many_items_still_sum_to_delta() -> None:
    # 7 equal items, delta=10 -> shares 1.428..., must still total exactly 10.
    calls = [_call(1, 100_000), _call(2, 100_010)]
    epochs = split_epochs([c.context_tokens for c in calls])
    items = {1: [RawItem(kind="user", label=f"m{n}", raw_chars=4_000) for n in range(7)]}
    contributors = [c for c in calibrate_contributors(calls, epochs, items) if c.kind != "baseline"]
    assert sum(c.est_tokens for c in contributors) == 10


# ---------------------------------------------------------------------------
# _raw_item: sizing individual tool results
# ---------------------------------------------------------------------------

def test_raw_item_sizes_parallel_results_by_their_own_length() -> None:
    # One user event carrying two parallel tool_results: the event JSON is 20k
    # chars, but this result's own payload is only 400 chars.
    row = {
        "tool_result_id": 1, "tool_name": "Read", "call_json": None,
        "size_bytes": None, "raw_len": 20_000, "result_raw_len": 400,
        "event_id": 7, "type": "user",
    }
    item = _raw_item(row)
    assert item.kind == "tool_result"
    assert item.raw_chars == 400


def test_raw_item_persisted_output_still_wins() -> None:
    row = {
        "tool_result_id": 1, "tool_name": "Bash", "call_json": None,
        "size_bytes": 12_345, "raw_len": 20_000, "result_raw_len": 400,
        "event_id": 7, "type": "user",
    }
    assert _raw_item(row).raw_chars == 12_345


def test_raw_item_user_message_uses_event_length() -> None:
    row = {
        "tool_result_id": None, "tool_name": None, "call_json": None,
        "size_bytes": None, "raw_len": 5_000, "result_raw_len": None,
        "event_id": 8, "type": "user",
    }
    item = _raw_item(row)
    assert item.kind == "user"
    assert item.raw_chars == 5_000


# ---------------------------------------------------------------------------
# Tax accrual (pricing)
# ---------------------------------------------------------------------------

from ccfr.analysis.context_economics import ThreadRec, _carry_usd, accrue_tax
from ccfr.analysis.pricing import ModelPrice, PriceTimeline


PRICE_TABLE = {
    # $1/M for every category keeps the arithmetic in tests trivial:
    # carry cost of T tokens over N calls = T*N / 1e6 dollars.
    "claude-sonnet-4-6": ModelPrice(base_input=1, cache_write_5m=1, cache_write_1h=1,
                                    cache_read=1, output=1),
}

# Wrap the flat table in a no-snapshot timeline for use with the updated API.
PRICE_TIMELINE = PriceTimeline(PRICE_TABLE, [])


def _thread(calls: list[CallRec], items: dict[int, list[RawItem]] | None = None) -> ThreadRec:
    epochs = split_epochs([c.context_tokens for c in calls])
    contributors = calibrate_contributors(calls, epochs, items or {})
    return ThreadRec(session_db_id=1, session_title="t", project_name="p",
                     agent_id=None, calls=calls, epochs=epochs, contributors=contributors)


def test_accrue_tax_is_write_once_plus_read_per_carried_call() -> None:
    calls = [_call(1, 10_000), _call(2, 16_000), _call(3, 16_000), _call(4, 16_000)]
    items = {1: [RawItem(kind="tool_result", label="Read a.py", raw_chars=24_000)]}
    thread = _thread(calls, items)
    priced = accrue_tax(thread, PRICE_TIMELINE)

    assert priced is True
    read = next(c for c in thread.contributors if c.label == "Read a.py")
    # 6k tokens: one 5m write at entry (call 1) + reads at calls 2 and 3.
    assert read.est_tokens == 6_000
    assert read.accrued_usd == pytest.approx((6_000 + 6_000 + 6_000) / 1e6)
    baseline = next(c for c in thread.contributors if c.kind == "baseline")
    # 10k tokens: write at call 0 + reads at calls 1, 2, 3.
    assert baseline.accrued_usd == pytest.approx(40_000 / 1e6)


def test_accrue_tax_unknown_model_reports_unpriced() -> None:
    calls = [CallRec(event_id=1, ts=None, model="mystery-model", context_tokens=5_000,
                     output_tokens=0)]
    thread = _thread(calls)
    assert accrue_tax(thread, PRICE_TIMELINE) is False
    assert thread.contributors[0].accrued_usd == 0.0


def test_accrue_tax_mixed_pricing_keeps_known_costs() -> None:
    # Calls 0-1 priced, call 2 on an unpriced model: fully_priced is False but
    # the baseline still accrues real cost over the priced calls (write at 0,
    # reads at 1, plus a $0 read at the unpriced call 2).
    calls = [
        _call(1, 10_000), _call(2, 14_000),
        CallRec(event_id=3, ts="2026-01-01T00:00:00Z", model="mystery-model",
                context_tokens=14_000, output_tokens=0),
    ]
    thread = _thread(calls)
    assert accrue_tax(thread, PRICE_TIMELINE) is False
    assert thread.read_prices == [1 / 1e6, 1 / 1e6, 0.0]
    baseline = next(c for c in thread.contributors if c.kind == "baseline")
    # 10k tokens: write at 0 + read at 1 + $0 read at the unpriced call 2.
    assert baseline.accrued_usd == pytest.approx(20_000 / 1e6)


def test_carry_usd_is_reads_only_over_the_span() -> None:
    calls = [_call(1, 10_000), _call(2, 12_000), _call(3, 13_000), _call(4, 14_000)]
    thread = _thread(calls)
    accrue_tax(thread, PRICE_TIMELINE)
    # 1000 tokens carried from after call 0 through call 2 = reads at calls 1,2
    # only (no entry write): 1000 * (1 + 1) / 1e6.
    assert _carry_usd(thread, 1_000, 0, 2) == pytest.approx(2_000 / 1e6)
    # A single-call span has no reads after entry: $0.
    assert _carry_usd(thread, 1_000, 2, 2) == 0.0


# ---------------------------------------------------------------------------
# load_threads — DB integration
# ---------------------------------------------------------------------------

import json

from ccfr.analysis import context_economics
from ccfr.analysis.context_economics import load_threads
from ccfr.storage import init_db


def _ts(minute: int, second: int = 0) -> str:
    return f"2026-01-01T{minute // 60:02d}:{minute % 60:02d}:{second:02d}Z"


@pytest.fixture()
def conn() -> sqlite3.Connection:
    connection = sqlite3.connect(":memory:", check_same_thread=False)
    connection.row_factory = sqlite3.Row
    init_db(connection)
    connection.execute(
        "INSERT INTO imports(source_path, imported_at, file_count, status, error_count)"
        " VALUES ('fixture', '2026-01-01T00:00:00Z', 0, 'completed', 0)"
    )
    connection.execute(
        "INSERT INTO projects(import_id, export_name, inferred_cwd) VALUES (1, 'alpha', NULL)"
    )
    return connection


def add_session(
    conn: sqlite3.Connection,
    *,
    project_id: int = 1,
    uuid: str,
    title: str = "Fixture session",
    calls: list[dict],
    gap_items: dict[int, list[dict]] | None = None,
) -> int:
    """Insert a session whose assistant calls and gap events drive the loader.

    calls: [{"context": int, "output": int, "model": str, "minute": int}]
    gap_items: gap index -> [{"kind": "tool_result"|"user"|"attachment",
                              "chars": int, "tool_name": str|None,
                              "path": str|None, "persisted_bytes": int|None}]
    Gap g events are timestamped between call g-1 and call g.
    """
    session_id = int(conn.execute(
        "INSERT INTO sessions(project_id, session_id, title, first_ts, last_ts)"
        " VALUES (?, ?, ?, ?, ?)",
        (project_id, uuid, title, _ts(calls[0]["minute"]), _ts(calls[-1]["minute"])),
    ).lastrowid)
    line = 0
    call_event_ids: list[int] = []
    for index, call in enumerate(calls):
        for item in (gap_items or {}).get(index, []):
            line += 1
            # Gap events sit 30s before their call.
            event_id = int(conn.execute(
                "INSERT INTO events(session_id, source_path, line_no, type, timestamp, raw_json)"
                " VALUES (?, 'fixture.jsonl', ?, ?, ?, ?)",
                (session_id, line, "attachment" if item["kind"] == "attachment" else "user",
                 _ts(call["minute"] - 1, 30), "x" * item["chars"]),
            ).lastrowid)
            if item["kind"] == "tool_result":
                tool_use_id = f"{uuid}-tu-{line}"
                persisted_id = None
                if item.get("persisted_bytes"):
                    persisted_id = int(conn.execute(
                        "INSERT INTO persisted_outputs(session_id, path, size_bytes)"
                        " VALUES (?, 'out.txt', ?)",
                        (session_id, item["persisted_bytes"]),
                    ).lastrowid)
                conn.execute(
                    "INSERT INTO tool_results(event_id, session_id, tool_use_id, is_error,"
                    " persisted_output_id, raw_json) VALUES (?, ?, ?, 0, ?, '{}')",
                    (event_id, session_id, tool_use_id, persisted_id),
                )
                if item.get("tool_name"):
                    call_raw = json.dumps({"input": {"file_path": item.get("path")}})
                    anchor = call_event_ids[-1] if call_event_ids else event_id
                    conn.execute(
                        "INSERT INTO tool_calls(event_id, session_id, tool_use_id, tool_name, raw_json)"
                        " VALUES (?, ?, ?, ?, ?)",
                        (anchor, session_id, tool_use_id, item["tool_name"], call_raw),
                    )
        line += 1
        event_id = int(conn.execute(
            "INSERT INTO events(session_id, source_path, line_no, type, timestamp, raw_json)"
            " VALUES (?, 'fixture.jsonl', ?, 'assistant', ?, '{}')",
            (session_id, line, _ts(call["minute"])),
        ).lastrowid)
        call_event_ids.append(event_id)
        context = call["context"]
        conn.execute(
            "INSERT INTO messages(event_id, role, model, input_tokens, output_tokens,"
            " base_input_tokens, cache_5m_tokens, cache_1h_tokens, cache_read_tokens)"
            " VALUES (?, 'assistant', ?, ?, ?, 0, ?, 0, ?)",
            (event_id, call.get("model", "claude-sonnet-4-6"), context,
             call.get("output", 0), max(0, context - call.get("cached", context - 1000)),
             call.get("cached", context - 1000) if context else 0),
        )
    conn.commit()
    return session_id


def test_load_threads_reconstructs_calls_and_contributors(conn: sqlite3.Connection) -> None:
    add_session(conn, uuid="s1", calls=[
        {"context": 10_000, "output": 500, "minute": 1},
        {"context": 22_000, "output": 0, "minute": 2},
    ], gap_items={1: [
        {"kind": "tool_result", "chars": 40_000, "tool_name": "Read", "path": "src/a.py"},
    ]})
    threads, skipped = load_threads(conn)

    assert skipped == 0
    assert len(threads) == 1
    thread = threads[0]
    assert [c.context_tokens for c in thread.calls] == [10_000, 22_000]
    read = next(c for c in thread.contributors if c.kind == "tool_result")
    assert read.tool_name == "Read" and read.detail == "src/a.py"
    reply = next(c for c in thread.contributors if c.kind == "assistant_output")
    # 40k chars = 10k raw + 500 output raw -> scaled to 12k delta.
    assert read.est_tokens + reply.est_tokens == 12_000


def test_load_threads_uses_persisted_size_when_available(conn: sqlite3.Connection) -> None:
    add_session(conn, uuid="s2", calls=[
        {"context": 10_000, "minute": 1},
        {"context": 30_000, "minute": 2},
    ], gap_items={1: [
        {"kind": "tool_result", "chars": 10, "tool_name": "Bash", "persisted_bytes": 400_000},
        {"kind": "user", "chars": 4_000},
    ]})
    threads, _ = load_threads(conn)
    tool = next(c for c in threads[0].contributors if c.kind == "tool_result")
    user = next(c for c in threads[0].contributors if c.kind == "user")
    # Persisted 400k chars dominates the 4k user message ~100:1 after calibration.
    assert tool.est_tokens > user.est_tokens * 50


def test_load_threads_skips_sessions_without_usage(conn: sqlite3.Connection) -> None:
    conn.execute(
        "INSERT INTO sessions(project_id, session_id, title) VALUES (1, 'empty', 'Empty')"
    )
    conn.commit()
    threads, skipped = load_threads(conn)
    assert threads == [] and skipped == 1


def test_load_threads_filters_by_project(conn: sqlite3.Connection) -> None:
    conn.execute("INSERT INTO projects(import_id, export_name, inferred_cwd) VALUES (1, 'beta', NULL)")
    add_session(conn, uuid="s3", calls=[{"context": 5_000, "minute": 1}])
    add_session(conn, project_id=2, uuid="s4", calls=[{"context": 5_000, "minute": 1}])
    threads, _ = load_threads(conn, project_id=2)
    assert len(threads) == 1 and threads[0].project_name


def test_load_threads_separates_sidechain_from_main(conn: sqlite3.Connection) -> None:
    session_id = add_session(conn, uuid="multi", calls=[
        {"context": 10_000, "minute": 1},
        {"context": 14_000, "minute": 2},
    ])
    # Two sidechain (agent_id='sub-1') assistant calls in the same session.
    for n, (minute, context) in enumerate([(1, 8_000), (2, 9_000)]):
        event_id = int(conn.execute(
            "INSERT INTO events(session_id, source_path, line_no, type, timestamp,"
            " agent_id, raw_json) VALUES (?, 'side.jsonl', ?, 'assistant', ?, 'sub-1', '{}')",
            (session_id, 100 + n, _ts(minute, 15)),
        ).lastrowid)
        conn.execute(
            "INSERT INTO messages(event_id, role, model, input_tokens, output_tokens,"
            " base_input_tokens, cache_5m_tokens, cache_1h_tokens, cache_read_tokens)"
            " VALUES (?, 'assistant', 'claude-sonnet-4-6', ?, 0, 0, 0, 0, ?)",
            (event_id, context, context),
        )
    conn.commit()

    threads, skipped = load_threads(conn)
    assert skipped == 0
    by_agent = {t.agent_id: t for t in threads}
    assert set(by_agent) == {None, "sub-1"}
    assert [c.context_tokens for c in by_agent[None].calls] == [10_000, 14_000]
    assert [c.context_tokens for c in by_agent["sub-1"].calls] == [8_000, 9_000]


# ---------------------------------------------------------------------------
# Claims bookkeeping + redundant re-read detector
# ---------------------------------------------------------------------------

from ccfr.analysis.context_economics import Claims, detect_rereads


def _priced_thread(calls, items=None) -> ThreadRec:
    thread = _thread(calls, items)
    accrue_tax(thread, PRICE_TIMELINE)
    return thread


def test_detect_rereads_flags_duplicate_reads_of_same_path() -> None:
    calls = [_call(1, 10_000), _call(2, 20_000), _call(3, 30_000), _call(4, 30_500)]
    items = {
        1: [RawItem(kind="tool_result", label="Read result: src/a.py", raw_chars=40_000,
                    event_id=11, tool_name="Read", detail="src/a.py")],
        2: [RawItem(kind="tool_result", label="Read result: src/a.py", raw_chars=40_000,
                    event_id=12, tool_name="Read", detail="src/a.py")],
    }
    thread = _priced_thread(calls, items)
    claims = Claims.for_threads([thread])
    findings = detect_rereads([thread], claims)

    assert len(findings) == 1
    finding = findings[0]
    assert finding.archetype == "rereads"
    assert "src/a.py" in finding.label and "2×" in finding.label
    duplicate = next(c for c in thread.contributors if c.entry_call == 2 and c.kind == "tool_result")
    # The duplicate (second) copy is fully avoidable: its whole accrued tax.
    assert finding.savings_tokens == duplicate.est_tokens
    assert finding.savings_usd == pytest.approx(duplicate.accrued_usd)
    # Claimed: the duplicate contributor and its token-carry per call.
    assert (0, thread.contributors.index(duplicate)) in claims.contributors
    assert claims.tokens_by_call[0][3] == duplicate.est_tokens
    assert claims.tokens_by_call[0][2] == duplicate.est_tokens


def test_detect_rereads_ignores_reads_in_different_epochs() -> None:
    calls = [_call(1, 100_000), _call(2, 120_000), _call(3, 30_000), _call(4, 40_000)]
    items = {
        1: [RawItem(kind="tool_result", label="Read result: a.py", raw_chars=40_000,
                    tool_name="Read", detail="a.py")],
        3: [RawItem(kind="tool_result", label="Read result: a.py", raw_chars=40_000,
                    tool_name="Read", detail="a.py")],
    }
    thread = _priced_thread(calls, items)
    findings = detect_rereads([thread], Claims.for_threads([thread]))
    assert findings == []


def test_detect_rereads_ignores_read_after_edit() -> None:
    # Read a.py, Edit a.py, then Read a.py again to verify the change: the second
    # read is legitimate (content changed), so nothing is flagged.
    calls = [_call(1, 10_000), _call(2, 20_000), _call(3, 30_000), _call(4, 40_000)]
    items = {
        1: [RawItem(kind="tool_result", label="Read result: a.py", raw_chars=40_000,
                    tool_name="Read", detail="a.py")],
        2: [RawItem(kind="tool_result", label="Edit result: a.py", raw_chars=200,
                    tool_name="Edit", detail="a.py")],
        3: [RawItem(kind="tool_result", label="Read result: a.py", raw_chars=40_000,
                    tool_name="Read", detail="a.py")],
    }
    thread = _priced_thread(calls, items)
    findings = detect_rereads([thread], Claims.for_threads([thread]))
    assert findings == []


# ---------------------------------------------------------------------------
# Detector 2: oversized tool results
# ---------------------------------------------------------------------------

from ccfr.analysis.context_economics import OVERSIZED_FLOOR_TOKENS, detect_oversized


def _corpus_with_one_giant() -> list[ThreadRec]:
    threads = []
    # 20 threads with modest 1k results -> p95 stays low but the floor governs.
    for n in range(20):
        calls = [_call(1, 10_000), _call(2, 11_000), _call(3, 11_200)]
        items = {1: [RawItem(kind="tool_result", label=f"Read result: f{n}.py",
                             raw_chars=4_000, tool_name="Read", detail=f"f{n}.py")]}
        threads.append(_priced_thread(calls, items))
    giant_calls = [_call(1, 10_000), _call(2, 60_000), _call(3, 60_100), _call(4, 60_200)]
    giant_items = {1: [RawItem(kind="tool_result", label="Bash result", raw_chars=200_000,
                               event_id=99, tool_name="Bash")]}
    threads.append(_priced_thread(giant_calls, giant_items))
    return threads


def test_detect_oversized_flags_only_the_giant_result() -> None:
    threads = _corpus_with_one_giant()
    claims = Claims.for_threads(threads)
    findings, thresholds = detect_oversized(threads, claims)

    assert len(findings) == 1
    finding = findings[0]
    assert finding.archetype == "oversized"
    giant = next(c for c in threads[-1].contributors if c.kind == "tool_result")
    cap = next(t for t in thresholds if t["name"] == "cap_tokens")["value"]
    assert finding.savings_tokens == giant.est_tokens - cap
    # Savings = saved tokens carried over calls 2..3 plus the entry write, all at $1/M.
    assert finding.savings_usd == pytest.approx((giant.est_tokens - cap) * 3 / 1e6)
    assert any(t["name"] == "oversized_tokens" and "p95" in t["provenance"] for t in thresholds)


def test_detect_oversized_skips_contributors_claimed_by_rereads() -> None:
    threads = _corpus_with_one_giant()
    claims = Claims.for_threads(threads)
    giant_index = len(threads) - 1
    contributor_index = next(
        i for i, c in enumerate(threads[giant_index].contributors) if c.kind == "tool_result"
    )
    claims.claim_contributor(
        giant_index, contributor_index,
        threads[giant_index].contributors[contributor_index],
        threads[giant_index].contributors[contributor_index].est_tokens,
    )
    findings, _ = detect_oversized(threads, claims)
    assert findings == []


def test_detect_oversized_floor_prevents_findings_on_small_corpora() -> None:
    # Every result is tiny: p95 < floor, nothing flagged.
    threads = []
    for n in range(10):
        calls = [_call(1, 5_000), _call(2, 5_400)]
        items = {1: [RawItem(kind="tool_result", label="Read result: t.py",
                             raw_chars=1_600, tool_name="Read", detail="t.py")]}
        threads.append(_priced_thread(calls, items))
    findings, _ = detect_oversized(threads, Claims.for_threads(threads))
    assert findings == []


def test_detect_oversized_adaptive_threshold_governs_above_floor() -> None:
    # Most results are 8k tokens (corpus p95 ~8k, above the 5k floor); a control
    # result is 6k. The 6k result is above the floor but below the corpus p95,
    # so the ADAPTIVE threshold keeps it unflagged while a 50k giant is flagged.
    # Proves the detector adapts to the corpus rather than relying on the floor.
    threads = []
    for n in range(20):
        calls = [_call(1, 10_000), _call(2, 18_000), _call(3, 18_100)]
        items = {1: [RawItem(kind="tool_result", label=f"Bash {n}", raw_chars=32_000,
                             tool_name="Bash")]}
        threads.append(_priced_thread(calls, items))
    control = {1: [RawItem(kind="tool_result", label="Control 6k", raw_chars=24_000,
                           event_id=77, tool_name="Bash")]}
    threads.append(_priced_thread([_call(1, 10_000), _call(2, 16_000), _call(3, 16_100)], control))
    giant = {1: [RawItem(kind="tool_result", label="Giant", raw_chars=200_000,
                         event_id=99, tool_name="Bash")]}
    threads.append(_priced_thread([_call(1, 10_000), _call(2, 60_000), _call(3, 60_100)], giant))

    findings, thresholds = detect_oversized(threads, Claims.for_threads(threads))
    threshold = next(t for t in thresholds if t["name"] == "oversized_tokens")["value"]
    assert threshold > OVERSIZED_FLOOR_TOKENS  # corpus p95 governs, not the floor
    labels = [f.label for f in findings]
    assert any("Giant" in label for label in labels)
    assert not any("Control 6k" in label for label in labels)


# ---------------------------------------------------------------------------
# Detector 3: late compaction
# ---------------------------------------------------------------------------

from ccfr.analysis.context_economics import detect_late_compaction


def test_detect_late_compaction_flags_long_high_context_tail() -> None:
    # 12 calls; context crosses 50% of the 200k window (100k) at call 2 and
    # stays high for 9 more calls.
    calls = [_call(i + 1, c) for i, c in enumerate(
        [60_000, 90_000, 110_000, 112_000, 114_000, 116_000, 118_000,
         120_000, 122_000, 124_000, 126_000, 128_000]
    )]
    thread = _priced_thread(calls)
    claims = Claims.for_threads([thread])
    findings, thresholds = detect_late_compaction([thread], claims)

    assert len(findings) == 1
    finding = findings[0]
    assert finding.archetype == "late_compaction"
    assert finding.entry_turn == 2
    retained = 110_000 * 0.3
    dropped = 110_000 - retained
    expected = sum(dropped / 1e6 for k in range(3, 12)) - retained / 1e6
    assert finding.savings_usd == pytest.approx(expected, rel=1e-6)
    assert claims.calls[0] == set(range(3, 12))
    assert any(t["name"] == "pressure_tokens" for t in thresholds)


def test_detect_late_compaction_short_tail_not_flagged() -> None:
    calls = [_call(i + 1, c) for i, c in enumerate([60_000, 110_000, 112_000, 114_000])]
    thread = _priced_thread(calls)
    findings, _ = detect_late_compaction([thread], Claims.for_threads([thread]))
    assert findings == []


def test_detect_late_compaction_subtracts_contributor_claims() -> None:
    calls = [_call(i + 1, c) for i, c in enumerate(
        [60_000, 90_000, 110_000, 112_000, 114_000, 116_000, 118_000,
         120_000, 122_000, 124_000, 126_000, 128_000]
    )]
    thread = _priced_thread(calls)
    claims = Claims.for_threads([thread])
    claims.tokens_by_call[0] = [10_000] * len(calls)  # pretend earlier detectors claimed 10k/call
    findings, _ = detect_late_compaction([thread], claims)
    retained = 110_000 * 0.3
    dropped = 110_000 - retained
    expected = sum((dropped - 10_000) / 1e6 for k in range(3, 12)) - retained / 1e6
    assert findings[0].savings_usd == pytest.approx(expected, rel=1e-6)


def test_detect_late_compaction_skips_fully_claimed_tail_calls() -> None:
    calls = [_call(i + 1, c) for i, c in enumerate(
        [60_000, 90_000, 110_000, 112_000, 114_000, 116_000, 118_000,
         120_000, 122_000, 124_000, 126_000, 128_000]
    )]
    thread = _priced_thread(calls)
    claims = Claims.for_threads([thread])
    # dropped = 0.7*110k = 77k. Claim 80k at call 5 only, so its residual <= 0:
    # it must be excluded from savings AND not added to claims.calls.
    claims.tokens_by_call[0][5] = 80_000
    findings, _ = detect_late_compaction([thread], claims)
    assert 5 not in claims.calls[0]
    assert claims.calls[0] == set(range(3, 12)) - {5}


# ---------------------------------------------------------------------------
# Detector 4: stale session continuation
# ---------------------------------------------------------------------------

from ccfr.analysis.context_economics import detect_stale_continuation


def _gapped_thread() -> ThreadRec:
    # 8 calls 1 minute apart with a large context, then a 2-hour gap before
    # 2 short follow-up calls that still pay the full context.
    calls = []
    for i in range(8):
        calls.append(CallRec(event_id=i + 1, ts=_ts(i + 1), model="claude-sonnet-4-6",
                             context_tokens=20_000 + i * 20_000, output_tokens=0))
    for j, minute in enumerate([130, 131]):
        calls.append(CallRec(event_id=9 + j, ts=_ts(minute), model="claude-sonnet-4-6",
                             context_tokens=161_000 + j * 1_000, output_tokens=0))
    thread = _thread(calls)
    accrue_tax(thread, PRICE_TIMELINE)
    return thread


def test_detect_stale_continuation_flags_gap_resume() -> None:
    threads = [_gapped_thread()]
    # Pad the corpus with gapless threads so the p90 gap threshold is small.
    for n in range(9):
        threads.append(_priced_thread(
            [_call(1, 50_000), _call(2, 52_000), _call(3, 54_000)]
        ))
    claims = Claims.for_threads(threads)
    findings, thresholds = detect_stale_continuation(threads, claims)

    assert len(findings) == 1
    finding = findings[0]
    assert finding.archetype == "stale_continuation"
    assert finding.entry_turn == 8
    baseline = 20_000
    avoidable = 160_000 - baseline  # context just before the gap, minus baseline
    expected = (avoidable + avoidable) / 1e6  # constant per tail call, 2 tail calls
    assert finding.savings_usd == pytest.approx(expected, rel=1e-6)
    assert claims.calls[0] == {8, 9}
    assert any(t["name"] == "gap_seconds" for t in thresholds)


def test_detect_stale_continuation_skips_calls_claimed_by_compaction() -> None:
    threads = [_gapped_thread()]
    claims = Claims.for_threads(threads)
    claims.calls[0].update({8, 9})
    findings, _ = detect_stale_continuation(threads, claims)
    assert findings == []


def test_detect_stale_continuation_skips_small_resumed_context() -> None:
    # Long gap but a small resumed context (below corpus p75): not flagged.
    small = _thread([
        CallRec(event_id=1, ts=_ts(1), model="claude-sonnet-4-6",
                context_tokens=5_000, output_tokens=0),
        CallRec(event_id=2, ts=_ts(200), model="claude-sonnet-4-6",
                context_tokens=6_000, output_tokens=0),
    ])
    accrue_tax(small, PRICE_TIMELINE)
    threads = [small]
    for n in range(9):  # pad so corpus p75 context is large
        threads.append(_priced_thread([_call(1, 200_000), _call(2, 200_000)]))
    findings, _ = detect_stale_continuation(threads, Claims.for_threads(threads))
    assert findings == []


def _flat_priced_thread(calls: list[CallRec]) -> ThreadRec:
    # Named distinctly from _priced_thread (line 459 above), which already has
    # a different signature (calls, items) and derives prices via accrue_tax.
    # A same-named redefinition here would silently replace that binding for
    # every earlier test in this module (Python module-level defs are resolved
    # at call time), breaking the many `_priced_thread(calls, items)` callers.
    thread = ThreadRec(
        session_db_id=1, session_title="t", project_name="p", agent_id=None,
        calls=calls, epochs=split_epochs([c.context_tokens for c in calls]),
        contributors=[],
    )
    thread.read_prices = [1e-6] * len(calls)      # $1/MTok read
    thread.write_prices = [1.25e-6] * len(calls)  # $1.25/MTok write
    return thread


def test_late_compaction_savings_tokens_is_a_footprint_not_token_turns() -> None:
    # 10 calls pinned at 120k context: eligible at call 0, tail of 9 calls.
    calls = [_call(i + 1, 120_000, ts=f"2026-01-01T00:{i:02d}:00Z") for i in range(10)]
    thread = _flat_priced_thread(calls)
    claims = Claims.for_threads([thread])

    findings, _ = detect_late_compaction([thread], claims)

    assert len(findings) == 1
    f = findings[0]
    dropped = int(120_000 * (1 - 0.3))            # 84_000 ballast tokens
    assert f.savings_tokens == dropped            # once — NOT dropped * 9 tail calls
    assert f.carried_tokens == dropped
    assert f.carried_turns == 9
    # USD is per-call carry and stays cumulative: 9 * 84k * $1/MTok - rewrite cost.
    assert f.savings_usd == pytest.approx(9 * 84_000 * 1e-6 - 36_000 * 1.25e-6)


def test_stale_continuation_savings_tokens_is_a_footprint() -> None:
    # 8 calls: minute-spaced ramp to 90k, then a 2h gap before two tail calls.
    contexts = [10_000, 30_000, 50_000, 70_000, 80_000, 90_000, 90_000, 90_000]
    times = ["00:00", "00:01", "00:02", "00:03", "00:04", "00:05", "02:05", "02:06"]
    calls = [
        _call(i + 1, ctx, ts=f"2026-01-01T{t}:00Z")
        for i, (ctx, t) in enumerate(zip(contexts, times))
    ]
    thread = _flat_priced_thread(calls)
    claims = Claims.for_threads([thread])

    findings, _ = detect_stale_continuation([thread], claims)

    assert len(findings) == 1
    f = findings[0]
    avoidable = 90_000 - 10_000                   # pre-gap context minus baseline
    assert f.savings_tokens == avoidable          # once — NOT avoidable * 2 tail calls
    assert f.carried_tokens == avoidable
    assert f.carried_turns == 2
    assert f.savings_usd == pytest.approx(2 * avoidable * 1e-6)


# ---------------------------------------------------------------------------
# Corpus aggregation: context_economics_analytics
# ---------------------------------------------------------------------------

from ccfr.analysis.context_economics import context_economics_analytics


@pytest.fixture()
def economics_conn(conn: sqlite3.Connection, tmp_path: Path,
                   monkeypatch: pytest.MonkeyPatch) -> sqlite3.Connection:
    csv = tmp_path / "pricing.csv"
    csv.write_text(
        "model,base-input-tokens,5m-cache-writes,1h-cache-writes,cache-hits-&-refreshes,output-tokens\n"
        "claude-sonnet-4-6,1,1,1,1,1\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(context_economics, "pricing_path", lambda: csv)
    monkeypatch.setattr(context_economics, "pricing_dir", lambda: tmp_path / "pricing")
    # Three sessions that each re-read the same file once (clears min_support=3).
    for n in range(3):
        add_session(conn, uuid=f"re-{n}", title=f"Re-reader {n}", calls=[
            {"context": 10_000, "minute": 1}, {"context": 30_000, "minute": 2},
            {"context": 50_000, "minute": 3}, {"context": 50_500, "minute": 4},
        ], gap_items={
            1: [{"kind": "tool_result", "chars": 80_000, "tool_name": "Read", "path": "big.py"}],
            2: [{"kind": "tool_result", "chars": 80_000, "tool_name": "Read", "path": "big.py"}],
        })
    return conn


def test_corpus_payload_hero_math_is_consistent(economics_conn: sqlite3.Connection) -> None:
    payload = context_economics_analytics(economics_conn, min_support=3)
    meta = payload["meta"]

    assert meta["cost_available"] is True
    assert meta["sessions_analyzed"] == 3 and meta["sessions_skipped"] == 0
    assert meta["total_usd"] > 0
    assert meta["avoidable_usd"] == pytest.approx(
        sum(a["savings_usd"] for a in payload["archetypes"] if a["meets_support"])
    )
    assert meta["necessary_usd"] == pytest.approx(meta["total_usd"] - meta["avoidable_usd"])
    assert meta["avoidable_usd"] <= meta["total_usd"]

    keys = [a["key"] for a in payload["archetypes"]]
    assert keys == ["rereads", "oversized", "late_compaction", "stale_continuation"]
    rereads = payload["archetypes"][0]
    assert rereads["meets_support"] is True
    assert rereads["findings_count"] == 3
    assert all(f["savings_usd"] > 0 for f in rereads["findings"])
    assert rereads["exemplar"] is not None
    assert 0 < len(rereads["exemplar"]["series"]) <= 40
    assert all("provenance" in t for t in rereads["thresholds"])


def test_corpus_payload_gates_archetypes_below_support(economics_conn: sqlite3.Connection) -> None:
    payload = context_economics_analytics(economics_conn, min_support=10)
    rereads = payload["archetypes"][0]
    assert rereads["meets_support"] is False
    assert rereads["findings"] == [] and rereads["savings_usd"] == 0
    assert payload["meta"]["avoidable_usd"] == 0


def test_corpus_payload_weekly_trend_buckets_total_and_avoidable(
    economics_conn: sqlite3.Connection,
) -> None:
    payload = context_economics_analytics(economics_conn, min_support=3)
    trend = payload["meta"]["trend"]
    assert trend, "expected at least one weekly bucket"
    for bucket in trend:
        # week_start is the Monday of an ISO week
        assert datetime.fromisoformat(bucket["week_start"]).weekday() == 0
        assert 0 <= bucket["avoidable_usd"] <= bucket["total_usd"] + 1e-9
    # weekly totals partition the corpus total (same pricing + skip rules)
    assert sum(b["total_usd"] for b in trend) == pytest.approx(payload["meta"]["total_usd"])
    assert sum(b["avoidable_usd"] for b in trend) > 0


def test_corpus_payload_without_pricing_is_token_only(
    conn: sqlite3.Connection, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(context_economics, "pricing_path", lambda: tmp_path / "missing.csv")
    monkeypatch.setattr(context_economics, "pricing_dir", lambda: tmp_path / "pricing")
    add_session(conn, uuid="np", calls=[{"context": 10_000, "minute": 1}])
    payload = context_economics_analytics(conn)
    assert payload["meta"]["cost_available"] is False
    assert payload["meta"]["total_usd"] == 0
    assert payload["meta"]["trend"] == []


def test_corpus_payload_empty_db_is_stable(conn: sqlite3.Connection, tmp_path: Path,
                                           monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(context_economics, "pricing_path", lambda: tmp_path / "missing.csv")
    monkeypatch.setattr(context_economics, "pricing_dir", lambda: tmp_path / "pricing")
    payload = context_economics_analytics(conn)
    assert payload["meta"]["sessions_analyzed"] == 0
    assert [a["findings"] for a in payload["archetypes"]] == [[], [], [], []]


from ccfr.analysis.context_economics import run_detectors


def test_run_detectors_composition_is_conservative() -> None:
    # One thread that triggers BOTH a re-read (big.py read twice in one epoch) and
    # late compaction (context above the pressure point for a long tail). Run all
    # four detectors over the shared claims ledger and assert the summed savings
    # never exceed the thread's actual accrued carry cost — the disjointness
    # guarantee that keeps the hero's "avoidable" honest when archetypes overlap.
    contexts = [60_000, 110_000, 150_000, 152_000, 154_000, 156_000, 158_000,
                160_000, 162_000, 164_000, 166_000, 168_000]
    calls = [_call(i + 1, c) for i, c in enumerate(contexts)]
    items = {
        2: [RawItem(kind="tool_result", label="Read result: big.py", raw_chars=160_000,
                    event_id=21, tool_name="Read", detail="big.py")],
        4: [RawItem(kind="tool_result", label="Read result: big.py", raw_chars=8_000,
                    event_id=22, tool_name="Read", detail="big.py")],
    }
    thread = _priced_thread(calls, items)
    results = run_detectors([thread])

    fired = {key for key, (findings, _) in results.items() if findings}
    assert {"rereads", "late_compaction"} <= fired  # both overlapping archetypes fire

    total_savings = sum(f.savings_usd for findings, _ in results.values() for f in findings)
    total_accrued = sum(c.accrued_usd for c in thread.contributors)
    assert total_savings <= total_accrued + 1e-9


from ccfr.analysis.context_economics import session_context_economics


def test_session_payload_serializes_threads(economics_conn: sqlite3.Connection) -> None:
    session_id = int(economics_conn.execute(
        "SELECT id FROM sessions ORDER BY id LIMIT 1"
    ).fetchone()[0])
    payload = session_context_economics(economics_conn, session_id)

    assert payload["cost_available"] is True
    assert len(payload["threads"]) == 1
    thread = payload["threads"][0]
    assert thread["agent_id"] is None
    assert [c["turn"] for c in thread["calls"]] == [0, 1, 2, 3]
    assert all(c["context_tokens"] > 0 for c in thread["calls"])
    assert thread["epochs"] == [{"start_turn": 0, "end_turn": 3, "ended_by": "end"}]
    kinds = {c["kind"] for c in thread["contributors"]}
    assert "baseline" in kinds and "tool_result" in kinds
    assert all(c["accrued_usd"] >= 0 for c in thread["contributors"])
    # Session-local detection still finds the re-read (thresholds use floors).
    assert any(f["label"].startswith("big.py read") for f in thread["findings"])


def test_session_payload_unknown_session_is_empty(economics_conn: sqlite3.Connection) -> None:
    payload = session_context_economics(economics_conn, 999_999)
    assert payload["threads"] == []


def test_session_payload_without_pricing_is_token_only(
    conn: sqlite3.Connection, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(context_economics, "pricing_path", lambda: tmp_path / "missing.csv")
    monkeypatch.setattr(context_economics, "pricing_dir", lambda: tmp_path / "pricing")
    sid = add_session(conn, uuid="nz", calls=[
        {"context": 10_000, "minute": 1}, {"context": 20_000, "minute": 2},
    ])
    payload = session_context_economics(conn, sid)
    assert payload["cost_available"] is False
    assert all(c["accrued_usd"] == 0.0
               for t in payload["threads"] for c in t["contributors"])


def test_session_payload_routes_findings_to_owning_thread(economics_conn: sqlite3.Connection) -> None:
    # Add a sidechain assistant call to the first re-reader session; its thread
    # must not carry the main thread's big.py re-read finding.
    sid = int(economics_conn.execute("SELECT id FROM sessions ORDER BY id LIMIT 1").fetchone()[0])
    event_id = int(economics_conn.execute(
        "INSERT INTO events(session_id, source_path, line_no, type, timestamp, agent_id, raw_json)"
        " VALUES (?, 'side.jsonl', 999, 'assistant', ?, 'sub-1', '{}')",
        (sid, _ts(5)),
    ).lastrowid)
    economics_conn.execute(
        "INSERT INTO messages(event_id, role, model, input_tokens, output_tokens,"
        " base_input_tokens, cache_5m_tokens, cache_1h_tokens, cache_read_tokens)"
        " VALUES (?, 'assistant', 'claude-sonnet-4-6', 8000, 0, 0, 0, 0, 8000)",
        (event_id,),
    )
    economics_conn.commit()
    payload = session_context_economics(economics_conn, sid)
    by_agent = {t["agent_id"]: t for t in payload["threads"]}
    assert set(by_agent) == {None, "sub-1"}
    assert any(f["label"].startswith("big.py read") for f in by_agent[None]["findings"])
    assert by_agent["sub-1"]["findings"] == []  # sidechain owns no re-read finding


# ---------------------------------------------------------------------------
# API endpoints
# ---------------------------------------------------------------------------

from ccfr.api.deps import get_db
from ccfr.main import create_app


def test_context_economics_endpoints(economics_conn: sqlite3.Connection, tmp_path: Path,
                                     monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("ccfr.main.database_path", lambda: tmp_path / "startup.sqlite3")
    app = create_app()
    app.dependency_overrides[get_db] = lambda: economics_conn
    with TestClient(app) as client:
        corpus = client.get("/api/analytics/context-economics", params={"min_support": 3})
        session_id = int(economics_conn.execute(
            "SELECT id FROM sessions ORDER BY id LIMIT 1"
        ).fetchone()[0])
        session = client.get(f"/api/sessions/{session_id}/context-economics")

    assert corpus.status_code == 200
    body = corpus.json()
    assert body["meta"]["min_support"] == 3
    assert [a["key"] for a in body["archetypes"]] == [
        "rereads", "oversized", "late_compaction", "stale_continuation",
    ]
    assert session.status_code == 200
    assert session.json()["threads"][0]["calls"]


# ---------------------------------------------------------------------------
# Historical pricing: period-aware cost totals
# ---------------------------------------------------------------------------

def _conn_two_dated_opus(tmp_path):
    """One project, two assistant messages (1M base-input each) on claude-opus-4-1,
    dated Jan 2026 and Aug 2026 — straddling a 2026-07-01 price change."""
    from ccfr.storage import connect, init_db
    conn = connect(tmp_path / "ce.sqlite3")
    init_db(conn)
    conn.execute("INSERT INTO imports(source_path, imported_at, status) VALUES('x','x','done')")
    conn.execute("INSERT INTO projects(import_id, export_name) VALUES(1,'proj')")
    for sid, ts in enumerate(["2026-01-15T10:00:00Z", "2026-08-15T10:00:00Z"], start=1):
        conn.execute("INSERT INTO sessions(project_id, session_id, first_ts, last_ts) VALUES(1,?,?,?)",
                     (f"s{sid}", ts, ts))
        conn.execute("INSERT INTO events(session_id, source_path, line_no, type, timestamp, raw_json) "
                     "VALUES(?,?,?,?,?,'{}')", (sid, "f", sid, "assistant", ts))
        conn.execute("INSERT INTO messages(event_id, role, model, base_input_tokens, output_tokens) "
                     "VALUES(?, 'assistant', 'claude-opus-4-1', 1000000, 0)", (sid,))
    conn.commit()
    return conn


def test_corpus_total_prices_by_period(monkeypatch, tmp_path):
    from ccfr.analysis import context_economics as ce

    conn = _conn_two_dated_opus(tmp_path)
    baseline = tmp_path / "pricing.csv"
    baseline.write_text(
        "model,base-input-tokens,5m-cache-writes,1h-cache-writes,cache-hits-&-refreshes,output-tokens\n"
        "Claude-Opus-4.1,15,0,0,0,75\n",
        encoding="utf-8",
    )
    sheets = tmp_path / "pricing"
    sheets.mkdir()
    (sheets / "pricing-2026-07-01.csv").write_text(
        "model,base-input-tokens,5m-cache-writes,1h-cache-writes,cache-hits-&-refreshes,output-tokens\n"
        "Claude-Opus-4.1,5,0,0,0,25\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(ce, "pricing_path", lambda: baseline)
    monkeypatch.setattr(ce, "pricing_dir", lambda: sheets)

    timeline = ce.load_price_timeline(baseline, sheets)
    assert round(ce._corpus_total_usd(conn, None, timeline, historical=True), 2) == 20.0
    assert round(ce._corpus_total_usd(conn, None, timeline, historical=False), 2) == 10.0
