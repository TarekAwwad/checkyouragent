"""Context Economics: attribute context-carry cost to the content that caused it.

Reconstructs per-call context sizes from stored usage, attributes per-turn
growth to the events between calls (calibrated so estimates sum exactly to the
observed growth), prices the carry cost of each contributor, and runs four
corpus-adaptive waste detectors with disjoint counterfactual savings claims.

Computation is on-demand from the rebuildable SQLite cache, like discovery.py.
Design doc: docs/superpowers/specs/2026-06-10-context-economics-design.md
"""

from __future__ import annotations

import json
import math
import sqlite3
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from ccfr.analysis.pricing import load_price_table, match_price
from ccfr.config import pricing_path
from ccfr.naming import project_display_name

# --- Estimation and detection constants -------------------------------------
# Thresholds marked "corpus-relative" are computed from the loaded data with
# these values acting only as floors, so the detectors generalize to any
# imported corpus (spec: "Adaptive thresholds").
CHARS_PER_TOKEN = 4
COMPACTION_DROP_RATIO = 0.6      # context below 60% of previous call = epoch boundary

OVERSIZED_PERCENTILE = 0.95      # corpus-relative threshold for "oversized"
OVERSIZED_FLOOR_TOKENS = 5_000   # never flag results smaller than this
CAP_FLOOR_TOKENS = 500           # counterfactual cap is corpus median, at least this

CONTEXT_WINDOW_TOKENS = 200_000  # assumed model context window (documented assumption)
COMPACTION_PRESSURE_RATIO = 0.5  # eligible to compact above 50% of the window
COMPACTION_RETAINED_RATIO = 0.3  # assumed fraction retained by a compaction
COMPACTION_MIN_TAIL = 5          # calls that must follow eligibility to flag

STALE_GAP_PERCENTILE = 0.90      # corpus-relative wall-clock gap threshold
STALE_GAP_FLOOR_SECONDS = 1_800
STALE_CONTEXT_PERCENTILE = 0.75  # context must be corpus-large at the gap
STALE_MAX_TAIL_FRACTION = 0.25   # follow-up burst must be short

MIN_FINDING_USD = 0.01           # findings cheaper than this are noise
FINDINGS_LIMIT = 20              # per archetype in the corpus payload
THUMBNAIL_POINTS = 40            # exemplar series is downsampled to this many


@dataclass(frozen=True)
class CallRec:
    event_id: int
    ts: str | None
    model: str
    context_tokens: int
    output_tokens: int


@dataclass(frozen=True)
class EpochRec:
    start: int          # call index, inclusive
    end: int            # call index, inclusive
    ended_by: str       # "compaction" | "end"


@dataclass(frozen=True)
class RawItem:
    """Un-calibrated contributor candidate found in a gap between two calls."""

    kind: str           # tool_result | user | attachment | assistant_output
    label: str
    raw_chars: int
    event_id: int | None = None
    tool_name: str | None = None
    detail: str | None = None    # e.g. file path for Read results


@dataclass
class ContributorRec:
    key: str
    kind: str           # baseline | tool_result | user | attachment | assistant_output | unattributed
    label: str
    entry_call: int
    end_call: int       # last call index it is carried through (its epoch's end)
    est_tokens: int
    epoch: int
    accrued_usd: float = 0.0
    event_id: int | None = None
    tool_name: str | None = None
    detail: str | None = None


@dataclass
class ThreadRec:
    session_db_id: int
    session_title: str
    project_name: str
    agent_id: str | None
    calls: list[CallRec]
    epochs: list[EpochRec]
    contributors: list[ContributorRec]
    read_prices: list[float] = field(default_factory=list)   # $/token per call
    write_prices: list[float] = field(default_factory=list)  # $/token per call


@dataclass
class FindingRec:
    archetype: str
    session_id: int
    session_title: str
    project_name: str
    epoch: int
    entry_turn: int
    label: str
    carried_turns: int
    carried_tokens: int
    savings_tokens: int
    savings_usd: float
    counterfactual: dict[str, Any]
    event_id: int | None


def _percentile(values: list[float], pct: float) -> float:
    """Nearest-rank percentile on an unsorted list; 0.0 for empty input.

    Nearest-rank, not the interpolating variant in discovery.py — same name,
    deliberately different semantics.
    """
    if not values:
        return 0.0
    ordered = sorted(values)
    rank = max(0, min(len(ordered) - 1, math.ceil(pct * len(ordered)) - 1))
    return ordered[rank]


def split_epochs(context_sizes: list[int]) -> list[EpochRec]:
    """Split a call series into epochs at compaction-sized context drops."""
    if not context_sizes:
        return []
    epochs: list[EpochRec] = []
    start = 0
    for i in range(1, len(context_sizes)):
        if context_sizes[i] < context_sizes[i - 1] * COMPACTION_DROP_RATIO:
            epochs.append(EpochRec(start=start, end=i - 1, ended_by="compaction"))
            start = i
    epochs.append(EpochRec(start=start, end=len(context_sizes) - 1, ended_by="end"))
    return epochs


def calibrate_contributors(
    calls: list[CallRec],
    epochs: list[EpochRec],
    items_by_gap: dict[int, list[RawItem]],
) -> list[ContributorRec]:
    """Turn raw gap items into contributors whose sizes sum to observed growth.

    Per positive delta, raw char-based estimates are scaled proportionally so
    they sum exactly to the delta (the honesty calibration from the spec). A
    positive delta with no candidates becomes an explicit "unattributed"
    contributor that detectors must never claim.
    """
    if not calls:
        return []
    epoch_of: dict[int, int] = {}
    end_of: dict[int, int] = {}
    for index, epoch in enumerate(epochs):
        for i in range(epoch.start, epoch.end + 1):
            epoch_of[i] = index
            end_of[i] = epoch.end
    epoch_starts = {epoch.start for epoch in epochs}

    contributors: list[ContributorRec] = []
    for i, call in enumerate(calls):
        if i in epoch_starts:
            contributors.append(ContributorRec(
                key=f"baseline-{i}",
                kind="baseline",
                label="System prompt + initial context" if i == 0 else "Context kept after compaction",
                entry_call=i,
                end_call=end_of[i],
                est_tokens=call.context_tokens,
                epoch=epoch_of[i],
            ))
            continue
        delta = call.context_tokens - calls[i - 1].context_tokens
        if delta <= 0:
            continue
        items = list(items_by_gap.get(i, []))
        previous = calls[i - 1]
        if previous.output_tokens > 0:
            items.append(RawItem(
                kind="assistant_output",
                label="Assistant reply",
                raw_chars=previous.output_tokens * CHARS_PER_TOKEN,
                event_id=previous.event_id,
            ))
        raw_tokens = [max(1.0, item.raw_chars / CHARS_PER_TOKEN) for item in items]
        total_raw = sum(raw_tokens)
        if total_raw <= 0:
            contributors.append(ContributorRec(
                key=f"unattributed-{i}",
                kind="unattributed",
                label="Unattributed growth",
                entry_call=i,
                end_call=end_of[i],
                est_tokens=delta,
                epoch=epoch_of[i],
            ))
            continue
        scale = delta / total_raw
        for item, raw in zip(items, raw_tokens):
            est = int(round(raw * scale))
            if est <= 0:
                continue
            contributors.append(ContributorRec(
                key=f"{item.kind}-{i}-{len(contributors)}",
                kind=item.kind,
                label=item.label,
                entry_call=i,
                end_call=end_of[i],
                est_tokens=est,
                epoch=epoch_of[i],
                event_id=item.event_id,
                tool_name=item.tool_name,
                detail=item.detail,
            ))
    return contributors
