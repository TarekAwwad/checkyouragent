"""Usage Mindmap: corpus-wide workflow-phase and habit aggregation.

Classifies every assistant event into workflow phases via deterministic tool
rules, attributes real message cost to those phases (every dollar in the
filtered corpus lands in exactly one phase, so the map always sums to the true
total), and runs a registry of habit detectors whose findings hang off the
phases as good/anti leaves.

Computation is on-demand from the rebuildable SQLite cache, like discovery.py.
Design doc: docs/superpowers/specs/2026-06-11-usage-mindmap-design.md
"""

from __future__ import annotations

import json
import logging
import re
import sqlite3
from collections import defaultdict
from dataclasses import dataclass
from typing import Any, Callable

from ccfr.analysis.context_economics import accrue_tax, load_threads, run_detectors
from ccfr.analysis.pricing import (
    ModelPrice,
    TokenBreakdown,
    cost_usd,
    load_price_table,
    match_price,
)
from ccfr.config import pricing_path
from ccfr.naming import project_display_name

logger = logging.getLogger(__name__)

# --- Phase taxonomy ----------------------------------------------------------

PHASES: list[dict[str, str]] = [
    {"key": "explore", "label": "Explore"},
    {"key": "plan", "label": "Plan"},
    {"key": "implement", "label": "Implement"},
    {"key": "verify", "label": "Verify"},
    {"key": "operate", "label": "Operate"},
    {"key": "delegate", "label": "Delegate"},
    {"key": "converse", "label": "Converse"},
]
PHASE_KEYS = [p["key"] for p in PHASES]

_TOOL_PHASE: dict[str, str] = {
    "Read": "explore", "Grep": "explore", "Glob": "explore", "LS": "explore",
    "WebFetch": "explore", "WebSearch": "explore", "NotebookRead": "explore",
    "TodoWrite": "plan", "EnterPlanMode": "plan", "ExitPlanMode": "plan",
    "AskUserQuestion": "plan",
    "Edit": "implement", "Write": "implement", "MultiEdit": "implement",
    "NotebookEdit": "implement",
    "Task": "delegate", "Agent": "delegate",
}

# Test/build/lint commands that mark a Bash call as Verify. Anchored to token
# boundaries so "pytest" never matches inside an unrelated word; a leading
# "/" or "." also counts as a boundary so path-prefixed runners ("./pytest",
# "/usr/bin/pytest") are recognized. npm script names only count when the
# known prefix is the whole name or is followed by -, :, or . ("test:unit",
# "lint-fix", "build.prod") so "buildstories"/"linting" stay Operate.
_VERIFY_COMMAND = re.compile(
    r"(?:^|[\s;&|(./])("
    r"pytest|vitest|jest|mocha|tsc|eslint|ruff|mypy|flake8"
    r"|cargo\s+(?:test|check|clippy)|go\s+(?:test|vet)"
    r"|npm\s+(?:test|run\s+(?:test|lint|build|check)(?:[-:.]\S*)?)"
    r"|npx\s+(?:vitest|jest|tsc|eslint)"
    r"|make\s+(?:test|check|lint)|tox|gradle\s+test|mvn\s+test"
    r")(?:$|[\s;&|)])"
)


def classify_tool_call(tool_name: str | None, command: str | None = None) -> str:
    """Phase for one tool call. Unknown tools are Converse — never dropped, so
    phase totals always cover the whole corpus."""
    if not tool_name:
        return "converse"
    if tool_name == "Bash":
        return "verify" if command and _VERIFY_COMMAND.search(command) else "operate"
    return _TOOL_PHASE.get(tool_name, "converse")


# --- Event records and cost attribution --------------------------------------

@dataclass(frozen=True)
class ToolCallRec:
    tool_name: str | None
    command: str | None = None    # Bash command text when present
    detail: str | None = None     # file_path for file tools when present
    signature: str | None = None  # stable identity of the call's input
    is_error: bool = False


@dataclass(frozen=True)
class EventRec:
    event_id: int
    session_db_id: int
    session_title: str
    project_name: str
    ts: str | None
    model: str
    cost: float            # USD for this message; 0.0 when the model is unpriced
    tokens: int            # total billed tokens on the message
    priced: bool
    tool_calls: tuple[ToolCallRec, ...] = ()


def event_phase_weights(event: EventRec) -> dict[str, float]:
    """Equal split of an event across its tool calls' phases; text-only events
    are Converse. Weights always sum to 1.0 so attribution conserves cost."""
    if not event.tool_calls:
        return {"converse": 1.0}
    weights: dict[str, float] = defaultdict(float)
    share = 1.0 / len(event.tool_calls)
    for call in event.tool_calls:
        weights[classify_tool_call(call.tool_name, call.command)] += share
    return dict(weights)


def aggregate_phases(events: list[EventRec]) -> dict[str, dict[str, Any]]:
    """Per-phase accumulation of cost, tokens, tool counts and sessions.

    `sessions` is the set of session ids with at least one event touching the
    phase; `tokens` is a float (weighted sum) — callers round at presentation.
    """
    acc: dict[str, dict[str, Any]] = {
        key: {"cost_usd": 0.0, "tokens": 0.0, "tool_count": 0, "sessions": set()}
        for key in PHASE_KEYS
    }
    for event in events:
        for phase, weight in event_phase_weights(event).items():
            bucket = acc[phase]
            bucket["cost_usd"] += event.cost * weight
            bucket["tokens"] += event.tokens * weight
            bucket["sessions"].add(event.session_db_id)
        for call in event.tool_calls:
            acc[classify_tool_call(call.tool_name, call.command)]["tool_count"] += 1
    return acc


def _parse_input(raw_json: str | None) -> dict[str, Any]:
    if not raw_json:
        return {}
    try:
        data = json.loads(raw_json)
    except json.JSONDecodeError:
        return {}
    input_data = data.get("input")
    return input_data if isinstance(input_data, dict) else {}


def load_events(
    conn: sqlite3.Connection,
    table: dict[str, ModelPrice],
    *,
    project_id: int | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
) -> list[EventRec]:
    """All assistant events in the filtered corpus, with their tool calls,
    result error flags, and priced cost. Order: session, then time."""
    where = ["m.role = 'assistant'"]
    params: list[Any] = []
    if project_id is not None:
        where.append("s.project_id = ?")
        params.append(project_id)
    if date_from:
        where.append("date(e.timestamp) >= date(?)")
        params.append(date_from)
    if date_to:
        where.append("date(e.timestamp) <= date(?)")
        params.append(date_to)
    clause = " AND ".join(where)

    rows = conn.execute(
        f"""
        SELECT e.id AS event_id, e.session_id AS session_db_id, e.timestamp AS ts,
               m.model,
               COALESCE(m.base_input_tokens, 0) AS base,
               COALESCE(m.cache_5m_tokens, 0) AS c5,
               COALESCE(m.cache_1h_tokens, 0) AS c1,
               COALESCE(m.cache_read_tokens, 0) AS cr,
               COALESCE(m.output_tokens, 0) AS out,
               s.title, p.export_name, p.inferred_cwd
        FROM events e
        JOIN messages m ON m.event_id = e.id
        JOIN sessions s ON s.id = e.session_id
        JOIN projects p ON p.id = s.project_id
        WHERE {clause}
        ORDER BY e.session_id, e.timestamp, e.id
        """,
        params,
    ).fetchall()

    # tool_calls rows exist only for assistant events, so the messages/projects
    # joins from the events query add nothing here — filter on the optional
    # project/date terms only. tool_results is pre-aggregated per
    # (session_id, tool_use_id) so duplicate result rows never fan out calls.
    call_where = ["1=1"]
    call_params: list[Any] = []
    if project_id is not None:
        call_where.append("s.project_id = ?")
        call_params.append(project_id)
    if date_from:
        call_where.append("date(e.timestamp) >= date(?)")
        call_params.append(date_from)
    if date_to:
        call_where.append("date(e.timestamp) <= date(?)")
        call_params.append(date_to)
    call_clause = " AND ".join(call_where)

    call_rows = conn.execute(
        f"""
        SELECT tc.event_id, tc.tool_name, tc.input_preview, tc.raw_json,
               COALESCE(tr.is_error, 0) AS is_error
        FROM tool_calls tc
        JOIN events e ON e.id = tc.event_id
        JOIN sessions s ON s.id = e.session_id
        LEFT JOIN (
            SELECT session_id, tool_use_id, MAX(is_error) AS is_error
            FROM tool_results
            WHERE tool_use_id IS NOT NULL
            GROUP BY session_id, tool_use_id
        ) tr ON tr.session_id = tc.session_id AND tr.tool_use_id = tc.tool_use_id
        WHERE {call_clause}
        ORDER BY tc.event_id, tc.id
        """,
        call_params,
    ).fetchall()

    calls_by_event: dict[int, list[ToolCallRec]] = defaultdict(list)
    for row in call_rows:
        input_data = _parse_input(row["raw_json"])
        signature = row["input_preview"] or (
            json.dumps(input_data, sort_keys=True) if input_data else None
        )
        calls_by_event[row["event_id"]].append(ToolCallRec(
            tool_name=row["tool_name"],
            command=input_data.get("command"),
            detail=input_data.get("file_path"),
            signature=signature,
            is_error=bool(row["is_error"]),
        ))

    events: list[EventRec] = []
    for row in rows:
        price = match_price(table, row["model"])
        # Total billed tokens (all four input categories + output) — same definition
        # as context_economics' context_tokens; used for the token-fallback shares.
        tokens = row["base"] + row["c5"] + row["c1"] + row["cr"] + row["out"]
        usd = 0.0
        if price is not None:
            usd = cost_usd(price, TokenBreakdown(
                base_input=row["base"], cache_write_5m=row["c5"],
                cache_write_1h=row["c1"], cache_read=row["cr"], output=row["out"],
            ))
        events.append(EventRec(
            event_id=row["event_id"],
            session_db_id=row["session_db_id"],
            session_title=row["title"] or "Untitled session",
            project_name=project_display_name(row["export_name"], row["inferred_cwd"]),
            ts=row["ts"],
            model=row["model"] or "",
            cost=usd,
            tokens=tokens,
            priced=price is not None or tokens == 0,
            tool_calls=tuple(calls_by_event.get(row["event_id"], [])),
        ))
    return events


# --- Habit detectors ----------------------------------------------------------
# Each detector is a pure function over one session's ordered EventRecs and
# returns HabitFindings. New detectors (including future sequence-mining
# proposals, which should emit status "candidate") register in
# SESSION_DETECTORS below — the engine and API need no other change.

BLIND_RETRY_MIN = 3   # identical failing attempts in a row to flag
PLAN_BURST_MIN = 5    # edit calls after a plan step to count as a planned burst


@dataclass(frozen=True)
class HabitFinding:
    habit_key: str
    phase: str
    session_db_id: int
    session_title: str
    project_name: str
    cost_usd: float
    count: int
    exemplar_event_ids: tuple[int, ...]
    detail: str


@dataclass(frozen=True)
class FlatCall:
    """One tool call with its phase and equal share of its event's cost."""
    event_id: int
    phase: str
    tool_name: str | None
    signature: str | None
    is_error: bool
    cost_share: float


def _flatten(events: list[EventRec]) -> list[FlatCall]:
    calls: list[FlatCall] = []
    for event in events:
        if not event.tool_calls:
            continue
        share = event.cost / len(event.tool_calls)
        for call in event.tool_calls:
            calls.append(FlatCall(
                event_id=event.event_id,
                phase=classify_tool_call(call.tool_name, call.command),
                tool_name=call.tool_name,
                signature=call.signature,
                is_error=call.is_error,
                cost_share=share,
            ))
    return calls


def detect_blind_retry(session_events: list[EventRec]) -> list[HabitFinding]:
    """Same tool, identical input, >= BLIND_RETRY_MIN consecutive attempts, all
    failing. Cost counts every attempt after the first (the first failure is
    legitimate discovery; the repeats are the waste)."""
    if not session_events:
        return []
    head = session_events[0]
    findings: list[HabitFinding] = []
    run: list[FlatCall] = []

    def close_run() -> None:
        if len(run) >= BLIND_RETRY_MIN:
            findings.append(HabitFinding(
                habit_key="blind-retry",
                phase=run[0].phase,
                session_db_id=head.session_db_id,
                session_title=head.session_title,
                project_name=head.project_name,
                cost_usd=sum(c.cost_share for c in run[1:]),
                count=len(run),
                exemplar_event_ids=(run[0].event_id,),
                detail=(f"{run[0].tool_name} retried {len(run)}x "
                        "with identical input, all failing"),
            ))

    for call in _flatten(session_events):
        same_run = (run and call.tool_name == run[0].tool_name
                    and call.signature is not None
                    and call.signature == run[0].signature
                    and call.is_error)
        if same_run:
            run.append(call)
        else:
            close_run()
            run = [call] if (call.is_error and call.signature is not None) else []
    close_run()
    return findings
