from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from ccfr.analysis.context_economics import (
    CallRec,
    EpochRec,
    RawItem,
    _percentile,
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
# Tax accrual (pricing)
# ---------------------------------------------------------------------------

from ccfr.analysis.context_economics import ThreadRec, _carry_usd, accrue_tax
from ccfr.analysis.pricing import ModelPrice


PRICE_TABLE = {
    # $1/M for every category keeps the arithmetic in tests trivial:
    # carry cost of T tokens over N calls = T*N / 1e6 dollars.
    "claude-sonnet-4-6": ModelPrice(base_input=1, cache_write_5m=1, cache_write_1h=1,
                                    cache_read=1, output=1),
}


def _thread(calls: list[CallRec], items: dict[int, list[RawItem]] | None = None) -> ThreadRec:
    epochs = split_epochs([c.context_tokens for c in calls])
    contributors = calibrate_contributors(calls, epochs, items or {})
    return ThreadRec(session_db_id=1, session_title="t", project_name="p",
                     agent_id=None, calls=calls, epochs=epochs, contributors=contributors)


def test_accrue_tax_is_write_once_plus_read_per_carried_call() -> None:
    calls = [_call(1, 10_000), _call(2, 16_000), _call(3, 16_000), _call(4, 16_000)]
    items = {1: [RawItem(kind="tool_result", label="Read a.py", raw_chars=24_000)]}
    thread = _thread(calls, items)
    priced = accrue_tax(thread, PRICE_TABLE)

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
    assert accrue_tax(thread, PRICE_TABLE) is False
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
    assert accrue_tax(thread, PRICE_TABLE) is False
    assert thread.read_prices == [1 / 1e6, 1 / 1e6, 0.0]
    baseline = next(c for c in thread.contributors if c.kind == "baseline")
    # 10k tokens: write at 0 + read at 1 + $0 read at the unpriced call 2.
    assert baseline.accrued_usd == pytest.approx(20_000 / 1e6)


def test_carry_usd_is_reads_only_over_the_span() -> None:
    calls = [_call(1, 10_000), _call(2, 12_000), _call(3, 13_000), _call(4, 14_000)]
    thread = _thread(calls)
    accrue_tax(thread, PRICE_TABLE)
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
