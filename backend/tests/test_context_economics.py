from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from ccfr.analysis.context_economics import (
    CallRec,
    EpochRec,
    _percentile,
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
