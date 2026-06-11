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
