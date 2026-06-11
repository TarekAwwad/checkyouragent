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
        if not items:
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
        # Floor of 1.0 raw-token keeps tiny items from vanishing before apportionment.
        raw_tokens = [max(1.0, item.raw_chars / CHARS_PER_TOKEN) for item in items]
        total_raw = sum(raw_tokens)
        # Largest-remainder (Hare) apportionment: floor every share, then hand
        # the leftover tokens to the largest fractional remainders so the
        # integer ests sum EXACTLY to delta (naive round() does not).
        shares = [raw * delta / total_raw for raw in raw_tokens]
        ests = [int(share) for share in shares]
        leftover = delta - sum(ests)
        order = sorted(range(len(items)), key=lambda k: (-(shares[k] - ests[k]), k))
        for k in order[:leftover]:
            ests[k] += 1
        for j, (item, est) in enumerate(zip(items, ests)):
            if est <= 0:
                continue
            contributors.append(ContributorRec(
                key=f"{item.kind}-{i}-{j}",
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


def accrue_tax(thread: ThreadRec, table: dict[str, Any]) -> bool:
    """Price each contributor's carry: one 5m cache write at entry, then one
    cache read per subsequent call until its epoch ends. Returns False when any
    call's model has no price row (those calls contribute $0 and the payload
    flags cost as partially unavailable)."""
    fully_priced = True
    thread.read_prices = []
    thread.write_prices = []
    for call in thread.calls:
        price = match_price(table, call.model)
        if price is None:
            fully_priced = False
            thread.read_prices.append(0.0)
            thread.write_prices.append(0.0)
        else:
            thread.read_prices.append(price.cache_read / 1_000_000)
            thread.write_prices.append(price.cache_write_5m / 1_000_000)
    for contributor in thread.contributors:
        usd = contributor.est_tokens * thread.write_prices[contributor.entry_call]
        for i in range(contributor.entry_call + 1, contributor.end_call + 1):
            usd += contributor.est_tokens * thread.read_prices[i]
        contributor.accrued_usd = usd
    return fully_priced


def _carry_usd(thread: ThreadRec, tokens: int, entry_call: int, end_call: int) -> float:
    """Read-cost of carrying `tokens` from after entry_call through end_call.

    Reads only — excludes the entry-call write, which is a sunk cost. Detectors
    want the marginal forward cost that compaction/capping could have avoided.
    """
    return tokens * sum(thread.read_prices[entry_call + 1: end_call + 1])


_SYNTHETIC_MODELS = {"<synthetic>"}


def _order_key(row: sqlite3.Row) -> tuple[str, int]:
    return (row["timestamp"] or "", row["event_id"])


def load_threads(
    conn: sqlite3.Connection,
    *,
    project_id: int | None = None,
    session_db_id: int | None = None,
) -> tuple[list[ThreadRec], int]:
    """Build calibrated, taxed-later threads for every qualifying session.

    Returns (threads, sessions_skipped) where skipped sessions had no
    assistant call with usable usage (e.g. synthetic-only models).
    """
    where = ["1=1"]
    params: list[Any] = []
    if project_id is not None:
        where.append("s.project_id = ?")
        params.append(project_id)
    if session_db_id is not None:
        where.append("s.id = ?")
        params.append(session_db_id)
    sessions = conn.execute(
        f"""
        SELECT s.id, s.title, p.export_name, p.inferred_cwd
        FROM sessions s JOIN projects p ON p.id = s.project_id
        WHERE {' AND '.join(where)} ORDER BY s.id
        """,
        params,
    ).fetchall()

    threads: list[ThreadRec] = []
    skipped = 0
    for session in sessions:
        calls_by_agent: dict[str | None, list[CallRec]] = defaultdict(list)
        call_rows = conn.execute(
            """
            SELECT e.id AS event_id, e.agent_id, e.timestamp, m.model, m.output_tokens,
                   m.base_input_tokens + m.cache_5m_tokens + m.cache_1h_tokens
                     + m.cache_read_tokens AS context_tokens
            FROM events e JOIN messages m ON m.event_id = e.id
            WHERE e.session_id = ? AND m.role = 'assistant'
            ORDER BY e.timestamp, e.id
            """,
            (session["id"],),
        ).fetchall()
        call_keys_by_agent: dict[str | None, list[tuple[str, int]]] = defaultdict(list)
        for row in call_rows:
            model = row["model"] or ""
            if row["context_tokens"] <= 0 or not model or model in _SYNTHETIC_MODELS:
                continue
            calls_by_agent[row["agent_id"]].append(CallRec(
                event_id=row["event_id"],
                ts=row["timestamp"],
                model=model,
                context_tokens=row["context_tokens"],
                output_tokens=row["output_tokens"] or 0,
            ))
            call_keys_by_agent[row["agent_id"]].append(_order_key(row))
        if not calls_by_agent:
            skipped += 1
            continue

        item_rows = conn.execute(
            """
            SELECT e.id AS event_id, e.agent_id, e.timestamp, e.type,
                   length(e.raw_json) AS raw_len,
                   tr.id AS tool_result_id, po.size_bytes,
                   tc.tool_name, tc.raw_json AS call_json
            FROM events e
            LEFT JOIN tool_results tr ON tr.event_id = e.id
            LEFT JOIN persisted_outputs po ON po.id = tr.persisted_output_id
            LEFT JOIN tool_calls tc
                ON tc.session_id = e.session_id AND tc.tool_use_id = tr.tool_use_id
            -- tool_result content blocks live on user-type events in the export, so the
            -- type filter still captures them via the tool_results join below.
            WHERE e.session_id = ? AND e.type IN ('user', 'attachment')
            ORDER BY e.timestamp, e.id
            """,
            (session["id"],),
        ).fetchall()

        title = session["title"] or "Untitled session"
        name = project_display_name(session["export_name"], session["inferred_cwd"])
        for agent_id, calls in calls_by_agent.items():
            call_keys = call_keys_by_agent[agent_id]
            items_by_gap: dict[int, list[RawItem]] = defaultdict(list)
            for row in item_rows:
                if row["agent_id"] != agent_id:
                    continue
                key = _order_key(row)
                gap = None
                for index, call_key in enumerate(call_keys):
                    if key <= call_key:
                        gap = index
                        break
                if gap is None or gap == 0:
                    # gap 0 = before the first call (no delta to explain); gap None = after the
                    # last call (no later call re-pays it). Both are intentionally dropped.
                    continue
                items_by_gap[gap].append(_raw_item(row))
            epochs = split_epochs([c.context_tokens for c in calls])
            contributors = calibrate_contributors(calls, epochs, items_by_gap)
            threads.append(ThreadRec(
                session_db_id=session["id"],
                session_title=title,
                project_name=name,
                agent_id=agent_id,
                calls=calls,
                epochs=epochs,
                contributors=contributors,
            ))
    return threads, skipped


def _raw_item(row: sqlite3.Row) -> RawItem:
    if row["tool_result_id"] is not None:
        tool_name = row["tool_name"] or "Tool"
        detail = None
        if row["call_json"]:
            try:
                detail = json.loads(row["call_json"]).get("input", {}).get("file_path")
            except (json.JSONDecodeError, AttributeError):
                detail = None
        label = f"{tool_name} result" + (f": {detail}" if detail else "")
        # `is not None`, not truthiness: a genuinely empty (0-byte) persisted output
        # must not fall back to the raw_json wrapper length.
        chars = row["size_bytes"] if row["size_bytes"] is not None else row["raw_len"]
        return RawItem(kind="tool_result", label=label, raw_chars=chars or 0,
                       event_id=row["event_id"], tool_name=tool_name, detail=detail)
    kind = "attachment" if row["type"] == "attachment" else "user"
    label = "Attachment" if kind == "attachment" else "User message"
    return RawItem(kind=kind, label=label, raw_chars=row["raw_len"] or 0,
                   event_id=row["event_id"])


# ---------------------------------------------------------------------------
# Claims bookkeeping (disjoint findings ledger)
# ---------------------------------------------------------------------------

@dataclass
class Claims:
    """Disjointness bookkeeping: a token-carry belongs to at most one finding.

    contributors: (thread_index, contributor_index) pairs fully/partially claimed.
    tokens_by_call: per thread, token counts already claimed by contributor-level
        findings, indexed by call. Context-level detectors (compaction, stale)
        subtract these priced at the per-call cache-read rate. The small
        write-vs-read price premium at a contributor's entry call is an accepted
        approximation and keeps those detectors' savings conservative.
    calls: per thread, call indexes claimed by a context-level finding.
    """

    contributors: set[tuple[int, int]] = field(default_factory=set)
    tokens_by_call: dict[int, list[int]] = field(default_factory=dict)
    calls: dict[int, set[int]] = field(default_factory=dict)

    @classmethod
    def for_threads(cls, threads: list[ThreadRec]) -> "Claims":
        claims = cls()
        for index, thread in enumerate(threads):
            claims.tokens_by_call[index] = [0] * len(thread.calls)
            claims.calls[index] = set()
        return claims

    def claim_contributor(self, thread_index: int, contributor_index: int,
                          contributor: ContributorRec, tokens: int) -> None:
        """Idempotent: re-claiming the same contributor is a no-op, so the four
        detectors compose without double-incrementing tokens_by_call."""
        if (thread_index, contributor_index) in self.contributors:
            return
        self.contributors.add((thread_index, contributor_index))
        per_call = self.tokens_by_call[thread_index]
        for i in range(contributor.entry_call, contributor.end_call + 1):
            per_call[i] += tokens


# ---------------------------------------------------------------------------
# Detector 1: redundant re-reads
# ---------------------------------------------------------------------------

def detect_rereads(threads: list[ThreadRec], claims: Claims) -> list[FindingRec]:
    """Same file Read repeatedly in one epoch without an intervening edit: every
    copy after the first (since the last edit) is waste. A Read that follows a
    Write/Edit of the same path is a legitimate verify-read and is not flagged."""
    findings: list[FindingRec] = []
    for thread_index, thread in enumerate(threads):
        reads: dict[tuple[int, str], list[int]] = defaultdict(list)
        mutations: dict[tuple[int, str], list[int]] = defaultdict(list)
        for contributor_index, contributor in enumerate(thread.contributors):
            if contributor.kind != "tool_result" or not contributor.detail:
                continue
            key = (contributor.epoch, contributor.detail)
            if contributor.tool_name == "Read":
                reads[key].append(contributor_index)
            elif contributor.tool_name in ("Write", "Edit"):
                mutations[key].append(contributor.entry_call)
        for (epoch, path), indexes in reads.items():
            if len(indexes) < 2:
                continue
            indexes.sort(key=lambda i: thread.contributors[i].entry_call)
            mutation_calls = sorted(mutations.get((epoch, path), []))
            duplicate_indexes: list[int] = []
            anchor_entry = thread.contributors[indexes[0]].entry_call
            for i in indexes[1:]:
                entry = thread.contributors[i].entry_call
                if any(anchor_entry < m <= entry for m in mutation_calls):
                    anchor_entry = entry  # legitimate re-read after an edit
                else:
                    duplicate_indexes.append(i)
            if not duplicate_indexes:
                continue
            duplicates = [thread.contributors[i] for i in duplicate_indexes]
            savings_tokens = sum(d.est_tokens for d in duplicates)
            savings_usd = sum(d.accrued_usd for d in duplicates)
            if savings_usd < MIN_FINDING_USD:
                continue
            for i in duplicate_indexes:
                claims.claim_contributor(thread_index, i, thread.contributors[i],
                                         thread.contributors[i].est_tokens)
            first = thread.contributors[indexes[0]]
            findings.append(FindingRec(
                archetype="rereads",
                session_id=thread.session_db_id,
                session_title=thread.session_title,
                project_name=thread.project_name,
                epoch=epoch,
                entry_turn=duplicates[0].entry_call,
                label=f"{path} read {len(indexes)}× in one epoch",
                carried_turns=max(d.end_call - d.entry_call for d in duplicates),
                carried_tokens=savings_tokens,
                savings_tokens=savings_tokens,
                savings_usd=savings_usd,
                counterfactual={
                    "model": "drop duplicate copies; only the first read is kept",
                    "params": {"copies": len(indexes), "first_entry_turn": first.entry_call},
                },
                event_id=duplicates[0].event_id,
            ))
    return findings


# ---------------------------------------------------------------------------
# Detector 2: oversized tool results (corpus-adaptive)
# ---------------------------------------------------------------------------

def detect_oversized(
    threads: list[ThreadRec], claims: Claims,
) -> tuple[list[FindingRec], list[dict[str, Any]]]:
    """Single tool results above the corpus p95 (and an absolute floor).

    Counterfactual: the result is capped at the corpus median result size
    (a limit/offset read or persisted output); the difference stops being
    carried from its entry call onward.
    """
    sizes = [
        float(c.est_tokens)
        for thread in threads for c in thread.contributors
        if c.kind == "tool_result"
    ]
    threshold = max(_percentile(sizes, OVERSIZED_PERCENTILE), float(OVERSIZED_FLOOR_TOKENS))
    cap = max(_percentile(sizes, 0.5), float(CAP_FLOOR_TOKENS))
    thresholds = [
        {"name": "oversized_tokens", "value": threshold,
         "provenance": f"p95 of {len(sizes)} tool results, floor {OVERSIZED_FLOOR_TOKENS:,} tok"},
        {"name": "cap_tokens", "value": cap,
         "provenance": f"median tool result size, floor {CAP_FLOOR_TOKENS:,} tok"},
    ]
    findings: list[FindingRec] = []
    for thread_index, thread in enumerate(threads):
        for contributor_index, contributor in enumerate(thread.contributors):
            if contributor.kind != "tool_result" or contributor.est_tokens < threshold:
                continue
            if (thread_index, contributor_index) in claims.contributors:
                continue
            saved_tokens = int(contributor.est_tokens - cap)
            savings_usd = (
                _carry_usd(thread, saved_tokens, contributor.entry_call, contributor.end_call)
                + saved_tokens * thread.write_prices[contributor.entry_call]
            )
            if savings_usd < MIN_FINDING_USD:
                continue
            claims.claim_contributor(thread_index, contributor_index, contributor, saved_tokens)
            findings.append(FindingRec(
                archetype="oversized",
                session_id=thread.session_db_id,
                session_title=thread.session_title,
                project_name=thread.project_name,
                epoch=contributor.epoch,
                entry_turn=contributor.entry_call,
                label=f"{contributor.label} ({contributor.est_tokens:,} tok)",
                carried_turns=contributor.end_call - contributor.entry_call,
                carried_tokens=contributor.est_tokens,
                savings_tokens=saved_tokens,
                savings_usd=savings_usd,
                counterfactual={
                    "model": "result capped at the corpus median size (limit/offset or persisted output)",
                    "params": {"cap_tokens": cap, "actual_tokens": contributor.est_tokens},
                },
                event_id=contributor.event_id,
            ))
    return findings, thresholds


# ---------------------------------------------------------------------------
# Detector 3: late compaction
# ---------------------------------------------------------------------------

def detect_late_compaction(
    threads: list[ThreadRec], claims: Claims,
) -> tuple[list[FindingRec], list[dict[str, Any]]]:
    """Context stayed above the compaction pressure point for a long tail.

    Counterfactual: compaction at the first eligible call retains
    COMPACTION_RETAINED_RATIO of that call's context and drops the rest. The
    dropped tokens are a FIXED count — post-compaction work would regrow context
    identically in both worlds, so only the dropped ballast is avoidable, not the
    later growth. Savings = dropped tokens (minus any already claimed by
    contributor-level findings) read-priced over the tail, minus the one-off
    re-write of the retained content.
    """
    pressure = CONTEXT_WINDOW_TOKENS * COMPACTION_PRESSURE_RATIO
    thresholds = [
        {"name": "pressure_tokens", "value": pressure,
         "provenance": f"{int(COMPACTION_PRESSURE_RATIO * 100)}% of an assumed "
                       f"{CONTEXT_WINDOW_TOKENS:,}-token context window"},
        {"name": "min_tail_calls", "value": float(COMPACTION_MIN_TAIL),
         "provenance": "minimum calls after the pressure point to flag"},
    ]
    findings: list[FindingRec] = []
    for thread_index, thread in enumerate(threads):
        claimed = claims.tokens_by_call[thread_index]
        for epoch_index, epoch in enumerate(thread.epochs):
            eligible = next(
                (i for i in range(epoch.start, epoch.end + 1)
                 if thread.calls[i].context_tokens >= pressure),
                None,
            )
            if eligible is None or epoch.end - eligible < COMPACTION_MIN_TAIL:
                continue
            eligible_ctx = thread.calls[eligible].context_tokens
            retained = eligible_ctx * COMPACTION_RETAINED_RATIO
            dropped = eligible_ctx - retained  # fixed avoidable tokens per tail call
            savings_usd = -retained * thread.write_prices[eligible]
            savings_tokens = 0
            covered: list[int] = []
            for k in range(eligible + 1, epoch.end + 1):
                residual = dropped - claimed[k]
                if residual > 0:
                    savings_usd += residual * thread.read_prices[k]
                    savings_tokens += int(residual)
                    covered.append(k)
            if savings_usd < MIN_FINDING_USD:
                continue
            for k in covered:
                claims.calls[thread_index].add(k)
            findings.append(FindingRec(
                archetype="late_compaction",
                session_id=thread.session_db_id,
                session_title=thread.session_title,
                project_name=thread.project_name,
                epoch=epoch_index,
                entry_turn=eligible,
                label=(f"Context above {int(pressure / 1000)}k tokens for "
                       f"{epoch.end - eligible} more turns without compaction"),
                carried_turns=epoch.end - eligible,
                carried_tokens=savings_tokens,
                savings_tokens=savings_tokens,
                savings_usd=savings_usd,
                counterfactual={
                    "model": "compact at the first eligible turn, retaining "
                             f"{int(COMPACTION_RETAINED_RATIO * 100)}% of the context",
                    "params": {"eligible_turn": eligible, "retained_tokens": retained},
                },
                event_id=thread.calls[eligible].event_id,
            ))
    return findings, thresholds


# ---------------------------------------------------------------------------
# Detector 4: stale session continuation
# ---------------------------------------------------------------------------

def _gap_seconds(a: str | None, b: str | None) -> float:
    if not a or not b:
        return 0.0
    try:
        start = datetime.fromisoformat(a.replace("Z", "+00:00"))
        end = datetime.fromisoformat(b.replace("Z", "+00:00"))
        return max(0.0, (end - start).total_seconds())
    except (ValueError, TypeError):
        return 0.0


def detect_stale_continuation(
    threads: list[ThreadRec], claims: Claims,
) -> tuple[list[FindingRec], list[dict[str, Any]]]:
    """A short follow-up burst after a long idle gap re-pays a huge context.

    Counterfactual: the follow-up runs in a fresh session whose context is the
    thread's first-call baseline; savings = residual context above baseline for
    each follow-up call. Calls already claimed by late-compaction are skipped.

    Must run AFTER detect_late_compaction so compaction-claimed calls (in
    claims.calls) are excluded here.
    """
    all_gaps = [
        _gap_seconds(thread.calls[i - 1].ts, thread.calls[i].ts)
        for thread in threads for i in range(1, len(thread.calls))
    ]
    all_contexts = [float(c.context_tokens) for t in threads for c in t.calls]
    gap_threshold = max(_percentile(all_gaps, STALE_GAP_PERCENTILE),
                        float(STALE_GAP_FLOOR_SECONDS))
    context_threshold = _percentile(all_contexts, STALE_CONTEXT_PERCENTILE)
    thresholds = [
        {"name": "gap_seconds", "value": gap_threshold,
         "provenance": f"p90 of {len(all_gaps)} call gaps, floor "
                       f"{STALE_GAP_FLOOR_SECONDS // 60} min"},
        {"name": "context_tokens", "value": context_threshold,
         "provenance": f"p75 of {len(all_contexts)} call context sizes"},
    ]
    findings: list[FindingRec] = []
    for thread_index, thread in enumerate(threads):
        n = len(thread.calls)
        claimed_tokens = claims.tokens_by_call[thread_index]
        for i in range(1, n):
            tail = n - i
            if tail > max(1, int(n * STALE_MAX_TAIL_FRACTION)):
                continue
            if _gap_seconds(thread.calls[i - 1].ts, thread.calls[i].ts) < gap_threshold:
                continue
            if thread.calls[i - 1].context_tokens < context_threshold:
                continue
            tail_calls = [k for k in range(i, n) if k not in claims.calls[thread_index]]
            if not tail_calls:
                continue
            baseline = thread.calls[0].context_tokens
            # Avoidable = the stale ballast carried across the gap (context just
            # before the gap, minus the fresh-session baseline). Constant across
            # tail calls: the follow-up's own new work happens in both worlds, so
            # only the pre-gap ballast is avoidable — crediting later growth would
            # inflate the headline. Exact when context grows through the tail (the
            # usual case); conservative if context shrinks mildly between tail calls.
            avoidable_ctx = thread.calls[i - 1].context_tokens - baseline
            savings_usd = 0.0
            savings_tokens = 0
            for k in tail_calls:
                residual = avoidable_ctx - claimed_tokens[k]
                if residual > 0:
                    savings_usd += residual * thread.read_prices[k]
                    savings_tokens += int(residual)
            if savings_usd < MIN_FINDING_USD:
                continue
            claims.calls[thread_index].update(tail_calls)
            gap_minutes = int(_gap_seconds(thread.calls[i - 1].ts, thread.calls[i].ts) // 60)
            findings.append(FindingRec(
                archetype="stale_continuation",
                session_id=thread.session_db_id,
                session_title=thread.session_title,
                project_name=thread.project_name,
                epoch=next((e for e, ep in enumerate(thread.epochs) if ep.start <= i <= ep.end), 0),
                entry_turn=i,
                label=(f"Resumed a {thread.calls[i - 1].context_tokens // 1000}k-token "
                       f"context after {gap_minutes} min for {tail} short turns"),
                carried_turns=tail,
                carried_tokens=savings_tokens,
                savings_tokens=savings_tokens,
                savings_usd=savings_usd,
                counterfactual={
                    "model": "run the follow-up in a fresh session at the thread's baseline context",
                    "params": {"baseline_tokens": baseline, "gap_minutes": gap_minutes},
                },
                event_id=thread.calls[i].event_id,
            ))
            break  # one stale-continuation finding per thread
    return findings, thresholds


# ---------------------------------------------------------------------------
# Corpus aggregation
# ---------------------------------------------------------------------------

ARCHETYPES: list[dict[str, str]] = [
    {"key": "rereads", "title": "Redundant re-reads",
     "description": "The same file was read into the context more than once in one epoch.",
     "recommendation": "Re-read only the changed region (offset/limit) or rely on the copy already in context."},
    {"key": "oversized", "title": "Oversized tool results",
     "description": "Single tool results far above this corpus's norm entered the context and were re-paid every turn.",
     "recommendation": "Read large files with limit/offset, filter command output, or offload to a subagent and keep only its summary."},
    {"key": "late_compaction", "title": "Late compaction",
     "description": "The context stayed near the window limit for many turns without compaction.",
     "recommendation": "Compact (or let auto-compact run) once the context stops earning its keep."},
    {"key": "stale_continuation", "title": "Stale continuation",
     "description": "A short follow-up after a long break re-paid a huge accumulated context.",
     "recommendation": "Start short follow-ups in a fresh session instead of resuming a heavyweight one."},
]


def _thumbnail(thread: ThreadRec, finding: FindingRec) -> dict[str, Any]:
    """Downsampled context series for an archetype card, with the finding's
    contributor (when contributor-level) highlighted.

    Context-level findings (late_compaction, stale_continuation) carry a call's
    event_id rather than a contributor's, so no contributor matches and the
    series renders without a highlight band — the curve alone is the evidence.
    """
    highlight_entry, highlight_end, highlight_tokens = None, None, 0
    for contributor in thread.contributors:
        if contributor.event_id is not None and contributor.event_id == finding.event_id:
            highlight_entry, highlight_end = contributor.entry_call, contributor.end_call
            highlight_tokens = contributor.est_tokens
            break
    n = len(thread.calls)
    step = max(1, math.ceil(n / THUMBNAIL_POINTS))
    series = []
    for i in range(0, n, step):
        call = thread.calls[i]
        alive = (highlight_entry is not None and highlight_entry <= i <= highlight_end)
        series.append({
            "turn": i,
            "context_tokens": call.context_tokens,
            "highlight_tokens": highlight_tokens if alive else 0,
        })
    return {"session_id": thread.session_db_id, "series": series}


def _corpus_total_usd(conn: sqlite3.Connection, project_id: int | None,
                      table: dict[str, Any]) -> float:
    where, params = "", []
    if project_id is not None:
        where = "WHERE s.project_id = ?"
        params.append(project_id)
    rows = conn.execute(
        f"""
        SELECT m.model, SUM(m.base_input_tokens) AS base, SUM(m.cache_5m_tokens) AS c5,
               SUM(m.cache_1h_tokens) AS c1, SUM(m.cache_read_tokens) AS cr,
               SUM(m.output_tokens) AS out
        FROM messages m
        JOIN events e ON e.id = m.event_id
        JOIN sessions s ON s.id = e.session_id
        {where} GROUP BY m.model
        """,
        params,
    ).fetchall()
    total = 0.0
    for row in rows:
        price = match_price(table, row["model"])
        if price is None:
            continue
        total += (
            (row["base"] or 0) * price.base_input
            + (row["c5"] or 0) * price.cache_write_5m
            + (row["c1"] or 0) * price.cache_write_1h
            + (row["cr"] or 0) * price.cache_read
            + (row["out"] or 0) * price.output
        ) / 1_000_000
    return total


def _finding_payload(finding: FindingRec) -> dict[str, Any]:
    return {
        "archetype": finding.archetype,
        "session_id": finding.session_id,
        "session_title": finding.session_title,
        "project_name": finding.project_name,
        "epoch": finding.epoch,
        "entry_turn": finding.entry_turn,
        "label": finding.label,
        "carried_turns": finding.carried_turns,
        "carried_tokens": finding.carried_tokens,
        "savings_tokens": finding.savings_tokens,
        "savings_usd": round(finding.savings_usd, 6),
        "counterfactual": finding.counterfactual,
        "event_id": finding.event_id,
    }


def run_detectors(threads: list[ThreadRec]) -> dict[str, tuple[list[FindingRec], list[dict[str, Any]]]]:
    """All four detectors in claim-priority order over already-taxed threads."""
    claims = Claims.for_threads(threads)
    rereads = detect_rereads(threads, claims)
    oversized, oversized_thresholds = detect_oversized(threads, claims)
    compaction, compaction_thresholds = detect_late_compaction(threads, claims)
    stale, stale_thresholds = detect_stale_continuation(threads, claims)
    return {
        "rereads": (rereads, []),
        "oversized": (oversized, oversized_thresholds),
        "late_compaction": (compaction, compaction_thresholds),
        "stale_continuation": (stale, stale_thresholds),
    }


def context_economics_analytics(
    conn: sqlite3.Connection,
    *,
    project_id: int | None = None,
    min_support: int = 3,
) -> dict[str, Any]:
    """Corpus-level Context Economics payload (Discover landing view)."""
    min_support = max(1, int(min_support or 1))
    table = load_price_table(pricing_path())
    cost_available = bool(table)
    threads, skipped = load_threads(conn, project_id=project_id)
    for thread in threads:
        accrue_tax(thread, table)
    results = run_detectors(threads)
    thread_by_session: dict[tuple[int, str | None], ThreadRec] = {
        (t.session_db_id, t.agent_id): t for t in threads
    }

    archetypes = []
    avoidable = 0.0
    for spec in ARCHETYPES:
        findings, thresholds = results[spec["key"]]
        findings = sorted(findings, key=lambda f: f.savings_usd, reverse=True)
        meets = len(findings) >= min_support
        savings_usd = sum(f.savings_usd for f in findings) if meets else 0.0
        savings_tokens = sum(f.savings_tokens for f in findings) if meets else 0
        if meets:
            avoidable += savings_usd
        exemplar = None
        if meets and findings:
            top = findings[0]
            thread = next(
                (t for (sid, _aid), t in thread_by_session.items() if sid == top.session_id),
                None,
            )
            if thread is not None:
                exemplar = _thumbnail(thread, top)
        archetypes.append({
            "key": spec["key"],
            "title": spec["title"],
            "description": spec["description"],
            "recommendation": spec["recommendation"],
            "meets_support": meets,
            "findings_count": len(findings),
            "savings_usd": round(savings_usd, 6) if cost_available else 0.0,
            "savings_tokens": savings_tokens,
            "thresholds": thresholds,
            "exemplar": exemplar,
            "findings": [_finding_payload(f) for f in findings[:FINDINGS_LIMIT]] if meets else [],
        })

    total_usd = _corpus_total_usd(conn, project_id, table) if cost_available else 0.0
    # avoidable is a subset of carry reads/writes that are themselves part of
    # total, so it should not exceed total. The clamp is defense-in-depth against
    # the estimate-vs-actual gap (savings use calibrated token estimates; total
    # uses billed counts), keeping the headline honest if they ever disagree.
    avoidable = min(avoidable, total_usd) if cost_available else 0.0
    unattributed = sum(
        c.est_tokens for t in threads for c in t.contributors if c.kind == "unattributed"
    )
    return {
        "meta": {
            "project_id": project_id,
            "min_support": min_support,
            "total_usd": round(total_usd, 6),
            "necessary_usd": round(max(0.0, total_usd - avoidable), 6),
            "avoidable_usd": round(avoidable, 6),
            "unattributed_tokens": unattributed,
            "cost_available": cost_available,
            "sessions_analyzed": len({t.session_db_id for t in threads}),
            "sessions_skipped": skipped,
        },
        "archetypes": archetypes,
    }


def session_context_economics(conn: sqlite3.Connection, session_db_id: int) -> dict[str, Any]:
    """Drill-down payload for one session.

    Detection runs session-locally: corpus-relative thresholds are computed
    over this session only, with the absolute floors still applying. Findings
    can therefore differ slightly from the corpus view; the corpus payload is
    the authority for aggregate numbers.

    Findings are routed to the thread that owns their event_id, so sidechain
    findings stay on the sidechain thread.
    """
    table = load_price_table(pricing_path())
    threads, _skipped = load_threads(conn, session_db_id=session_db_id)
    for thread in threads:
        accrue_tax(thread, table)
    results = run_detectors(threads)

    payload_threads = []
    for thread in threads:
        thread_event_ids = {call.event_id for call in thread.calls}
        thread_event_ids.update(
            c.event_id for c in thread.contributors if c.event_id is not None
        )
        payload_threads.append({
            "agent_id": thread.agent_id,
            "calls": [
                {"turn": i, "ts": call.ts, "context_tokens": call.context_tokens,
                 "model": call.model}
                for i, call in enumerate(thread.calls)
            ],
            "epochs": [
                {"start_turn": e.start, "end_turn": e.end, "ended_by": e.ended_by}
                for e in thread.epochs
            ],
            "contributors": [
                {"id": c.key, "kind": c.kind, "label": c.label,
                 "entry_turn": c.entry_call, "end_turn": c.end_call,
                 "est_tokens": c.est_tokens, "accrued_usd": round(c.accrued_usd, 6),
                 "event_id": c.event_id}
                for c in thread.contributors
            ],
            "findings": [
                _finding_payload(f)
                for findings, _ in results.values() for f in findings
                if f.session_id == thread.session_db_id and f.event_id in thread_event_ids
            ],
        })
    return {"threads": payload_threads, "cost_available": bool(table)}
