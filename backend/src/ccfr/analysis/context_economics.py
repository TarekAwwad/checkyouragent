"""Context Economics: attribute context-carry cost to the content that caused it.

Reconstructs per-call context sizes from stored usage, attributes per-turn
growth to the events between calls (calibrated so estimates sum exactly to the
observed growth), prices the carry cost of each contributor, and runs two
corpus-adaptive opportunity detectors with disjoint counterfactual estimates.

Computation is on-demand from the rebuildable SQLite cache, like discovery.py.
Design doc: docs/superpowers/specs/2026-06-10-context-economics-design.md
"""

from __future__ import annotations

import hashlib
import json
import math
import posixpath
import re
import sqlite3
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from ccfr.analysis.pricing import PriceTimeline, load_price_timeline, match_price
from ccfr.config import pricing_dir, pricing_path
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
    tool_input: dict[str, Any] | None = None
    result_signature: str | None = None


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
    tool_input: dict[str, Any] | None = None
    result_signature: str | None = None
    source_size: int = 0


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
    evidence_event_ids: list[int] = field(default_factory=list)
    ts: str | None = None  # entry-call timestamp, used for the weekly trend


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
                tool_input=item.tool_input,
                result_signature=item.result_signature,
                source_size=item.raw_chars,
            ))
    return contributors


def accrue_tax(thread: ThreadRec, timeline: PriceTimeline, *, historical: bool = True) -> bool:
    """Price each contributor's carry: one 5m cache write at entry, then one
    cache read per subsequent call until its epoch ends. Returns False when any
    call's model has no price row (those calls contribute $0 and the payload
    flags cost as partially unavailable).
    """
    fully_priced = True
    thread.read_prices = []
    thread.write_prices = []
    for call in thread.calls:
        price = timeline.price_for(call.model, call.ts, historical=historical)
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


def _has_price_signal(thread: ThreadRec) -> bool:
    """True when at least one call in this thread has a price row.

    The MIN_FINDING_USD noise floor is only meaningful when a cost signal
    exists; without prices every finding accrues $0 and the floor would
    silently discard the token-only findings that unpriced (subscription)
    corpora rely on. Each detector's structural thresholds still gate
    token-level noise on their own.
    """
    return any(thread.write_prices) or any(thread.read_prices)


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
            WHERE e.session_id = ? AND e.is_replay = 0 AND m.role = 'assistant'
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
                   length(tr.raw_json) AS result_raw_len,
                   tr.id AS tool_result_id, po.size_bytes,
                   tr.raw_json AS result_json,
                   tc.tool_name, tc.raw_json AS call_json
            FROM events e
            LEFT JOIN tool_results tr ON tr.event_id = e.id
            LEFT JOIN persisted_outputs po ON po.id = tr.persisted_output_id
            LEFT JOIN tool_calls tc
                ON tc.session_id = e.session_id AND tc.tool_use_id = tr.tool_use_id
            -- tool_result content blocks live on user-type events in the export, so the
            -- type filter still captures them via the tool_results join below.
            WHERE e.session_id = ? AND e.is_replay = 0 AND e.type IN ('user', 'attachment')
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


def _contains_truncated_value(value: Any) -> bool:
    if isinstance(value, dict):
        if value.get("_truncated") is True:
            return True
        return any(_contains_truncated_value(item) for item in value.values())
    if isinstance(value, list):
        return any(_contains_truncated_value(item) for item in value)
    return False


def tool_result_signature(raw_json: str | None) -> str | None:
    """Stable signature of stored result content, excluding per-call receipt IDs."""
    if not raw_json:
        return None
    try:
        parsed = json.loads(raw_json)
    except (json.JSONDecodeError, TypeError):
        return None
    if isinstance(parsed, dict):
        if "content" not in parsed:
            return None
        content = parsed["content"]
    else:
        content = parsed
    if _contains_truncated_value(content):
        return None
    canonical = json.dumps(
        content, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _raw_item(row: sqlite3.Row) -> RawItem:
    if row["tool_result_id"] is not None:
        tool_name = row["tool_name"] or "Tool"
        tool_input = None
        detail = None
        if row["call_json"]:
            try:
                parsed_call = json.loads(row["call_json"])
                parsed_input = parsed_call.get("input") if isinstance(parsed_call, dict) else None
                if isinstance(parsed_input, dict):
                    tool_input = parsed_input
                    detail = parsed_input.get("file_path")
            except (json.JSONDecodeError, AttributeError):
                detail = None
        label = f"{tool_name} result" + (f": {detail}" if detail else "")
        # `is not None`, not truthiness: a genuinely empty (0-byte) persisted output
        # must not fall back to the result length. Size by THIS result's own JSON,
        # not the whole event's — parallel sibling results must not share one size.
        chars = row["size_bytes"] if row["size_bytes"] is not None else row["result_raw_len"]
        result_json = row["result_json"] if "result_json" in row.keys() else None
        return RawItem(kind="tool_result", label=label, raw_chars=chars or 0,
                       event_id=row["event_id"], tool_name=tool_name, detail=detail,
                       tool_input=tool_input,
                       result_signature=tool_result_signature(result_json))
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


@dataclass(frozen=True)
class ReadSignature:
    path: str
    offset: int
    limit: int | None
    result_signature: str | None


def normalize_tool_path(value: Any) -> str | None:
    """Canonicalize a tool path without resolving it against the local machine."""
    if not isinstance(value, str) or not value.strip():
        return None
    normalized = posixpath.normpath(value.strip().replace("\\", "/"))
    if normalized in ("", "."):
        return None
    if re.match(r"^[A-Za-z]:/", normalized) or normalized.startswith("//"):
        normalized = normalized.casefold()
    return normalized


def _normalized_read_bound(
    tool_input: dict[str, Any], key: str, *, default: int | None,
) -> tuple[bool, int | None]:
    value = tool_input.get(key)
    if value is None:
        return True, default
    if isinstance(value, bool):
        return False, None
    if isinstance(value, float) and not value.is_integer():
        return False, None
    if isinstance(value, str) and not re.fullmatch(r"[+-]?\d+", value.strip()):
        return False, None
    try:
        normalized = int(value)
    except (TypeError, ValueError):
        return False, None
    if normalized < 0 or (key == "limit" and normalized == 0):
        return False, None
    return True, normalized


def normalize_read_signature(
    tool_input: dict[str, Any] | None,
    *,
    fallback_path: str | None = None,
    result_signature: str | None = None,
) -> ReadSignature | None:
    """Pure normalized identity for one Read request and its stored result."""
    inputs = tool_input if isinstance(tool_input, dict) else {}
    path = normalize_tool_path(inputs.get("file_path") or fallback_path)
    if path is None:
        return None
    offset_ok, offset = _normalized_read_bound(inputs, "offset", default=0)
    limit_ok, limit = _normalized_read_bound(inputs, "limit", default=None)
    if not offset_ok or not limit_ok or offset is None:
        return None
    return ReadSignature(
        path=path,
        offset=offset,
        limit=limit,
        result_signature=result_signature or None,
    )


def split_read_runs(
    indexes: list[int],
    contributors: list[ContributorRec],
    mutation_calls: list[int],
) -> list[list[int]]:
    """Pure partition of equal-signature reads at intervening mutations."""
    ordered = sorted(indexes, key=lambda i: contributors[i].entry_call)
    runs: list[list[int]] = []
    current: list[int] = []
    for index in ordered:
        entry = contributors[index].entry_call
        if current:
            previous_entry = contributors[current[-1]].entry_call
            if any(previous_entry < mutation <= entry for mutation in mutation_calls):
                runs.append(current)
                current = []
        current.append(index)
    if current:
        runs.append(current)
    return runs


def detect_rereads(threads: list[ThreadRec], claims: Claims) -> list[FindingRec]:
    """Repeated identical Read requests/results in one epoch, without an edit."""
    findings: list[FindingRec] = []
    for thread_index, thread in enumerate(threads):
        reads: dict[tuple[int, ReadSignature], list[int]] = defaultdict(list)
        mutations: dict[tuple[int, str], list[int]] = defaultdict(list)
        for contributor_index, contributor in enumerate(thread.contributors):
            if contributor.kind != "tool_result":
                continue
            if contributor.tool_name == "Read":
                signature = normalize_read_signature(
                    contributor.tool_input,
                    fallback_path=contributor.detail,
                    result_signature=contributor.result_signature,
                )
                if signature is not None:
                    reads[(contributor.epoch, signature)].append(contributor_index)
            elif contributor.tool_name in ("Write", "Edit"):
                tool_input = contributor.tool_input or {}
                path = normalize_tool_path(tool_input.get("file_path") or contributor.detail)
                if path is not None:
                    mutations[(contributor.epoch, path)].append(contributor.entry_call)
        for (epoch, signature), indexes in reads.items():
            if len(indexes) < 2:
                continue
            mutation_calls = sorted(mutations.get((epoch, signature.path), []))
            runs = split_read_runs(indexes, thread.contributors, mutation_calls)
            for run in (candidate for candidate in runs if len(candidate) >= 2):
                duplicate_indexes = run[1:]
                duplicates = [thread.contributors[i] for i in duplicate_indexes]
                savings_tokens = sum(duplicate.est_tokens for duplicate in duplicates)
                savings_usd = sum(duplicate.accrued_usd for duplicate in duplicates)
                if _has_price_signal(thread) and savings_usd < MIN_FINDING_USD:
                    continue
                for i in duplicate_indexes:
                    claims.claim_contributor(
                        thread_index, i, thread.contributors[i],
                        thread.contributors[i].est_tokens,
                    )
                first = thread.contributors[run[0]]
                params: dict[str, float] = {
                    "copies": len(run),
                    "first_entry_turn": first.entry_call,
                    "offset": signature.offset,
                    "result_signature_match": int(signature.result_signature is not None),
                }
                if signature.limit is not None:
                    params["limit"] = signature.limit
                if signature.result_signature is not None:
                    model = (
                        "Estimated carry reduction if the repeated matching-result copy "
                        "is removed."
                    )
                else:
                    model = (
                        "Estimated carry reduction if the repeated same-range read was "
                        "unnecessary; full result content was unavailable for comparison."
                    )
                findings.append(FindingRec(
                    archetype="rereads",
                    session_id=thread.session_db_id,
                    session_title=thread.session_title,
                    project_name=thread.project_name,
                    epoch=epoch,
                    entry_turn=duplicates[0].entry_call,
                    label=f"{signature.path} same range read {len(run)}× in one epoch",
                    carried_turns=max(d.end_call - d.entry_call for d in duplicates),
                    carried_tokens=savings_tokens,
                    savings_tokens=savings_tokens,
                    savings_usd=savings_usd,
                    counterfactual={"model": model, "params": params},
                    event_id=duplicates[0].event_id,
                    evidence_event_ids=[
                        event_id
                        for i in run
                        if (event_id := thread.contributors[i].event_id) is not None
                    ],
                    ts=thread.calls[duplicates[0].entry_call].ts,
                ))
    return findings


# ---------------------------------------------------------------------------
# Detector 2: oversized tool results (corpus-adaptive)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ResultSizeBaseline:
    tool_name: str
    sample_size: int
    threshold_tokens: float
    cap_tokens: float


def result_size_baseline(tool_name: str, sizes: list[float]) -> ResultSizeBaseline:
    """Pure tool-specific threshold and conservative median-cap model."""
    return ResultSizeBaseline(
        tool_name=tool_name,
        sample_size=len(sizes),
        threshold_tokens=max(
            _percentile(sizes, OVERSIZED_PERCENTILE), float(OVERSIZED_FLOOR_TOKENS),
        ),
        cap_tokens=max(_percentile(sizes, 0.5), float(CAP_FLOOR_TOKENS)),
    )


def _baseline_thresholds(baseline: ResultSizeBaseline) -> list[dict[str, Any]]:
    return [
        {
            "name": f"{baseline.tool_name} large-result threshold",
            "value": baseline.threshold_tokens,
            "provenance": (
                f"{baseline.tool_name} p95 of {baseline.sample_size} results; "
                f"floor {OVERSIZED_FLOOR_TOKENS:,} tok"
            ),
        },
        {
            "name": f"{baseline.tool_name} baseline cap",
            "value": baseline.cap_tokens,
            "provenance": (
                f"{baseline.tool_name} median result; floor {CAP_FLOOR_TOKENS:,} tok"
            ),
        },
    ]


def detect_oversized(
    threads: list[ThreadRec], claims: Claims,
) -> tuple[list[FindingRec], list[dict[str, Any]]]:
    """Results large relative to other results produced by the same tool."""
    sizes_by_tool: dict[str, list[float]] = defaultdict(list)
    for thread in threads:
        for contributor in thread.contributors:
            if contributor.kind == "tool_result":
                sizes_by_tool[contributor.tool_name or "Unknown tool"].append(
                    float(contributor.est_tokens)
                )
    baselines = {
        tool_name: result_size_baseline(tool_name, sizes)
        for tool_name, sizes in sizes_by_tool.items()
    }
    flagged_tools: set[str] = set()
    findings: list[FindingRec] = []
    for thread_index, thread in enumerate(threads):
        for contributor_index, contributor in enumerate(thread.contributors):
            if contributor.kind != "tool_result":
                continue
            tool_name = contributor.tool_name or "Unknown tool"
            baseline = baselines[tool_name]
            if (
                contributor.est_tokens < baseline.threshold_tokens
                or contributor.est_tokens <= baseline.cap_tokens
            ):
                continue
            if (thread_index, contributor_index) in claims.contributors:
                continue
            saved_tokens = int(contributor.est_tokens - baseline.cap_tokens)
            savings_usd = (
                _carry_usd(thread, saved_tokens, contributor.entry_call, contributor.end_call)
                + saved_tokens * thread.write_prices[contributor.entry_call]
            )
            if _has_price_signal(thread) and savings_usd < MIN_FINDING_USD:
                continue
            claims.claim_contributor(thread_index, contributor_index, contributor, saved_tokens)
            flagged_tools.add(tool_name)
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
                    "model": (
                        f"Estimated carry reduction using the {tool_name} result median as a cap; "
                        "token size is calibrated from observed context growth."
                    ),
                    "params": {
                        "observed_size": contributor.source_size,
                        "estimated_tokens": contributor.est_tokens,
                        "tool_baseline_tokens": baseline.cap_tokens,
                        "threshold_tokens": baseline.threshold_tokens,
                        "modeled_reduction_tokens": saved_tokens,
                        "tool_sample_size": baseline.sample_size,
                    },
                },
                event_id=contributor.event_id,
                evidence_event_ids=[contributor.event_id] if contributor.event_id is not None else [],
                ts=thread.calls[contributor.entry_call].ts,
            ))
    thresholds = [
        threshold
        for tool_name in sorted(flagged_tools)
        for threshold in _baseline_thresholds(baselines[tool_name])
    ]
    return findings, thresholds


# ---------------------------------------------------------------------------
# Corpus aggregation
# ---------------------------------------------------------------------------

ARCHETYPES: list[dict[str, str]] = [
    {"key": "rereads", "title": "Repeated same-range reads",
     "description": "The same normalized file range was requested more than once in one context epoch; stored results were compared when complete content was available.",
     "recommendation": "Re-read only the changed region (offset/limit) or rely on the copy already in context."},
    {"key": "oversized", "title": "Large result carry opportunity",
     "description": "A result was unusually large relative to other results from the same tool, so carrying it may have increased context cost.",
     "recommendation": "Read large files with limit/offset, filter command output, or offload to a subagent and keep only its summary."},
]


def _thumbnail(thread: ThreadRec, finding: FindingRec) -> dict[str, Any]:
    """Downsampled context series with the finding contributor highlighted."""
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


def _corpus_total_tokens(conn: sqlite3.Connection, project_id: int | None) -> int:
    """Total billed tokens across the scoped corpus.

    Sums the five priced token buckets (base input, 5m/1h cache writes, cache
    read, output), matching the Cost page's ``total_tokens`` definition. This is
    price-independent on purpose: the token currency must exist even when no
    price table is loaded.
    """
    # Replayed copies are excluded so corpus totals match the Cost page.
    where, params = "WHERE e.is_replay = 0", []
    if project_id is not None:
        where += " AND s.project_id = ?"
        params.append(project_id)
    row = conn.execute(
        f"""
        SELECT COALESCE(SUM(
            m.base_input_tokens + m.cache_5m_tokens + m.cache_1h_tokens
            + m.cache_read_tokens + m.output_tokens), 0) AS total
        FROM messages m
        JOIN events e ON e.id = m.event_id
        JOIN sessions s ON s.id = e.session_id
        {where}
        """,
        params,
    ).fetchone()
    return int(row["total"] or 0)


def _corpus_cost_summary(
    conn: sqlite3.Connection,
    project_id: int | None,
    timeline: PriceTimeline,
    *,
    historical: bool = True,
) -> tuple[float, list[str]]:
    """Known corpus cost and models whose used messages could not be priced."""
    # Replayed copies are excluded so corpus totals match the Cost page.
    where, params = "WHERE e.is_replay = 0", []
    if project_id is not None:
        where += " AND s.project_id = ?"
        params.append(project_id)
    period_expr = timeline.sql_period_expr("e.timestamp", historical=historical)
    rows = conn.execute(
        f"""
        SELECT m.model, ({period_expr}) AS price_period,
               SUM(m.base_input_tokens) AS base, SUM(m.cache_5m_tokens) AS c5,
               SUM(m.cache_1h_tokens) AS c1, SUM(m.cache_read_tokens) AS cr,
               SUM(m.output_tokens) AS out
        FROM messages m
        JOIN events e ON e.id = m.event_id
        JOIN sessions s ON s.id = e.session_id
        {where} GROUP BY m.model, price_period
        """,
        params,
    ).fetchall()
    total = 0.0
    unpriced_models: set[str] = set()
    for row in rows:
        used_tokens = sum(
            int(row[key] or 0) for key in ("base", "c5", "c1", "cr", "out")
        )
        if used_tokens <= 0:
            continue
        table = timeline.table_for_period(row["price_period"], historical=historical)
        price = match_price(table, row["model"])
        if price is None:
            unpriced_models.add(str(row["model"] or "unknown"))
            continue
        total += (
            (row["base"] or 0) * price.base_input
            + (row["c5"] or 0) * price.cache_write_5m
            + (row["c1"] or 0) * price.cache_write_1h
            + (row["cr"] or 0) * price.cache_read
            + (row["out"] or 0) * price.output
        ) / 1_000_000
    return total, sorted(unpriced_models)


def _corpus_total_usd(conn: sqlite3.Connection, project_id: int | None,
                      timeline: PriceTimeline, *, historical: bool = True) -> float:
    """Compatibility helper for callers that only need the known priced total."""
    return _corpus_cost_summary(
        conn, project_id, timeline, historical=historical,
    )[0]


TREND_WEEKS = 12


def _week_start(ts: str | None) -> str | None:
    """ISO date of the Monday of ts's week; None for missing/unparseable input."""
    if not ts:
        return None
    try:
        day = datetime.fromisoformat(ts.replace("Z", "+00:00")).date()
    except ValueError:
        return None
    return (day - timedelta(days=day.weekday())).isoformat()


def _corpus_weekly_usd(conn: sqlite3.Connection, project_id: int | None,
                       timeline: PriceTimeline, *, historical: bool = True) -> dict[str, float]:
    """Total billed spend bucketed by ISO week (Monday start).

    Grouped by model+day in SQL to keep the row count small, then folded into
    weeks in Python so the week logic matches _week_start exactly.
    """
    # Replayed copies are excluded so corpus totals match the Cost page.
    where, params = "WHERE e.is_replay = 0", []
    if project_id is not None:
        where += " AND s.project_id = ?"
        params.append(project_id)
    rows = conn.execute(
        f"""
        SELECT m.model, date(e.timestamp) AS day,
               SUM(m.base_input_tokens) AS base, SUM(m.cache_5m_tokens) AS c5,
               SUM(m.cache_1h_tokens) AS c1, SUM(m.cache_read_tokens) AS cr,
               SUM(m.output_tokens) AS out
        FROM messages m
        JOIN events e ON e.id = m.event_id
        JOIN sessions s ON s.id = e.session_id
        {where} GROUP BY m.model, day
        """,
        params,
    ).fetchall()
    weekly: dict[str, float] = defaultdict(float)
    for row in rows:
        week = _week_start(row["day"])
        price = timeline.price_for(row["model"], row["day"], historical=historical)
        if week is None or price is None:
            continue
        weekly[week] += (
            (row["base"] or 0) * price.base_input
            + (row["c5"] or 0) * price.cache_write_5m
            + (row["c1"] or 0) * price.cache_write_1h
            + (row["cr"] or 0) * price.cache_read
            + (row["out"] or 0) * price.output
        ) / 1_000_000
    return dict(weekly)


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
        "evidence_event_ids": finding.evidence_event_ids,
    }


def run_detectors(threads: list[ThreadRec]) -> dict[str, tuple[list[FindingRec], list[dict[str, Any]]]]:
    """Supported production detectors in claim-priority order."""
    claims = Claims.for_threads(threads)
    rereads = detect_rereads(threads, claims)
    oversized, oversized_thresholds = detect_oversized(threads, claims)
    return {
        "rereads": (rereads, []),
        "oversized": (oversized, oversized_thresholds),
    }


def context_economics_analytics(
    conn: sqlite3.Connection,
    *,
    project_id: int | None = None,
    min_support: int = 3,
    historical: bool = True,
) -> dict[str, Any]:
    """Corpus-level Context Economics payload (Discover landing view)."""
    min_support = max(1, int(min_support or 1))
    timeline = load_price_timeline(pricing_path(), pricing_dir())
    cost_available = timeline.has_prices
    threads, skipped = load_threads(conn, project_id=project_id)
    for thread in threads:
        accrue_tax(thread, timeline, historical=historical)
    results = run_detectors(threads)
    thread_by_session: dict[tuple[int, str | None], ThreadRec] = {
        (t.session_db_id, t.agent_id): t for t in threads
    }

    archetypes = []
    opportunity = 0.0
    opportunity_weekly: dict[str, float] = defaultdict(float)
    for spec in ARCHETYPES:
        findings, thresholds = results[spec["key"]]
        findings = sorted(findings, key=lambda f: f.savings_usd, reverse=True)
        meets = len(findings) >= min_support
        savings_usd = sum(f.savings_usd for f in findings) if meets else 0.0
        savings_tokens = sum(f.savings_tokens for f in findings) if meets else 0
        if meets:
            opportunity += savings_usd
            for finding in findings:
                week = _week_start(finding.ts)
                if week is not None:
                    opportunity_weekly[week] += finding.savings_usd
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

    recorded_usd, unpriced_models = _corpus_cost_summary(
        conn, project_id, timeline, historical=historical,
    )
    costs_partial = cost_available and bool(unpriced_models)
    # Detected opportunity is modeled from a subset of recorded carry costs. The
    # clamp protects the headline from estimate-vs-recorded calibration drift.
    opportunity = min(opportunity, recorded_usd) if cost_available else 0.0
    unattributed_usd = max(0.0, recorded_usd - opportunity)
    trend: list[dict[str, Any]] = []
    if cost_available:
        weekly_total = _corpus_weekly_usd(conn, project_id, timeline, historical=historical)
        weeks = sorted(set(weekly_total) | set(opportunity_weekly))[-TREND_WEEKS:]
        trend = [
            {
                "week_start": week,
                "total_usd": round(weekly_total.get(week, 0.0), 6),
                # Keep the existing trend wire format while presenting this as
                # estimated opportunity in the UI.
                "avoidable_usd": round(
                    min(opportunity_weekly.get(week, 0.0), weekly_total.get(week, 0.0)), 6),
            }
            for week in weeks
        ]
    total_tokens = _corpus_total_tokens(conn, project_id)
    opportunity_tokens = min(
        sum(a["savings_tokens"] for a in archetypes), total_tokens
    )
    return {
        "meta": {
            "project_id": project_id,
            "min_support": min_support,
            "recorded_api_equivalent_usd": round(recorded_usd, 6),
            "opportunity_usd": round(opportunity, 6),
            "unattributed_usd": round(unattributed_usd, 6),
            "opportunity_tokens": opportunity_tokens,
            "cost_available": cost_available,
            "costs_partial": costs_partial,
            "unpriced_models": unpriced_models,
            "sessions_analyzed": len({t.session_db_id for t in threads}),
            "sessions_skipped": skipped,
            "trend": trend,
        },
        "archetypes": archetypes,
    }


def session_context_economics(conn: sqlite3.Connection, session_db_id: int, *,
                              historical: bool = True) -> dict[str, Any]:
    """Drill-down payload for one session.

    Detection runs session-locally: corpus-relative thresholds are computed
    over this session only, with the absolute floors still applying. Findings
    can therefore differ slightly from the corpus view; the corpus payload is
    the authority for aggregate numbers.

    Findings are routed to the thread that owns their event_id, so sidechain
    findings stay on the sidechain thread.
    """
    timeline = load_price_timeline(pricing_path(), pricing_dir())
    threads, _skipped = load_threads(conn, session_db_id=session_db_id)
    for thread in threads:
        accrue_tax(thread, timeline, historical=historical)
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
    return {"threads": payload_threads, "cost_available": timeline.has_prices}
