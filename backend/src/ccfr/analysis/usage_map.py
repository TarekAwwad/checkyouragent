"""Experimental activity map: corpus-wide workflow-phase observations.

Classifies every assistant event into workflow phases via deterministic tool
rules. Every tool call counts as one observed activity in its classified phase;
a text-only assistant step counts once as Synthesize. Pattern detectors hang
neutral observations off those phases. No message cost is allocated to phases.

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
    PriceTimeline,
    TokenBreakdown,
    cost_usd,
    load_price_timeline,
)
from ccfr.config import pricing_dir, pricing_path
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
    {"key": "converse", "label": "Synthesize"},
]
PHASE_KEYS = [p["key"] for p in PHASES]
ACTIVITY_BASIS = "tool_calls_and_assistant_steps"
ACTIVITY_METHODOLOGY = (
    "Each tool call counts once in its classified phase; a text-only assistant "
    "step counts once as Synthesize. This is observed activity, not cost attribution."
)

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


# --- Event records and observed activity -------------------------------------

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
    agent_id: str | None = None
    input_context_tokens: int = 0  # base + 5m + 1h + read (no output)


def event_phase_activity(event: EventRec) -> dict[str, int]:
    """Observed activity counts by phase for one assistant event.

    Each real tool call counts once. An assistant event without tool calls is
    one text-only Synthesize step. Message cost and token volume play no role.
    """
    if not event.tool_calls:
        return {"converse": 1}
    counts: dict[str, int] = defaultdict(int)
    for call in event.tool_calls:
        counts[classify_tool_call(call.tool_name, call.command)] += 1
    return dict(counts)


def aggregate_phases(events: list[EventRec]) -> dict[str, dict[str, Any]]:
    """Accumulate integer activity, call, session, and origin counts by phase."""
    acc: dict[str, dict[str, Any]] = {
        key: {"activity_count": 0, "tool_count": 0,
              "text_assistant_step_count": 0, "sessions": set(), "tools": {},
              "main_activity_count": 0, "subagent_activity_count": 0}
        for key in PHASE_KEYS
    }
    for event in events:
        for phase, count in event_phase_activity(event).items():
            bucket = acc[phase]
            bucket["activity_count"] += count
            bucket["sessions"].add(event.session_db_id)
            if event.agent_id is None:
                bucket["main_activity_count"] += count
            else:
                bucket["subagent_activity_count"] += count
        if not event.tool_calls:
            acc["converse"]["text_assistant_step_count"] += 1
        for call in event.tool_calls:
            bucket = acc[classify_tool_call(call.tool_name, call.command)]
            bucket["tool_count"] += 1
            if call.tool_name is None:
                continue
            tool = bucket["tools"].setdefault(call.tool_name, {
                "activity_count": 0, "sessions": set()})
            tool["activity_count"] += 1
            tool["sessions"].add(event.session_db_id)
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
    timeline: PriceTimeline,
    *,
    historical: bool = True,
    project_id: int | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
) -> list[EventRec]:
    """All assistant events in the filtered corpus, with their tool calls,
    result error flags, and priced cost. Order: session, then time."""
    # Replayed copies are excluded here, which also keeps limits_analytics (the other
    # caller) from counting a resumed session's history toward its usage windows.
    where = ["m.role = 'assistant'", "e.is_replay = 0"]
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
               e.agent_id AS agent_id,
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
    call_where = ["e.is_replay = 0"]
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
        # Real exports occasionally carry structured (non-string) values here;
        # coerce to None so the classifier never sees a non-string command.
        command = input_data.get("command")
        detail = input_data.get("file_path")
        calls_by_event[row["event_id"]].append(ToolCallRec(
            tool_name=row["tool_name"],
            command=command if isinstance(command, str) else None,
            detail=detail if isinstance(detail, str) else None,
            signature=signature,
            is_error=bool(row["is_error"]),
        ))

    events: list[EventRec] = []
    for row in rows:
        price = timeline.price_for(row["model"], row["ts"], historical=historical)
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
            agent_id=row["agent_id"],
            input_context_tokens=row["base"] + row["c5"] + row["c1"] + row["cr"],
        ))
    return events


# --- Habit detectors ----------------------------------------------------------
# Each detector is a pure function over one session's ordered EventRecs and
# returns HabitFindings. SESSION_DETECTORS below is the explicit registry.

BLIND_RETRY_MIN = 3   # identical failing attempts in a row to flag
PLAN_BURST_MIN = 5    # edit calls after a plan step to count as a planned burst


@dataclass(frozen=True)
class HabitFinding:
    habit_key: str
    phase: str
    session_db_id: int
    session_title: str
    project_name: str
    count: int
    exemplar_event_ids: tuple[int, ...]
    detail: str


@dataclass(frozen=True)
class FlatCall:
    """One observed tool call with its classified phase and evidence fields."""
    event_id: int
    phase: str
    tool_name: str | None
    signature: str | None
    is_error: bool


def _flatten(events: list[EventRec]) -> list[FlatCall]:
    calls: list[FlatCall] = []
    for event in events:
        if not event.tool_calls:
            continue
        for call in event.tool_calls:
            calls.append(FlatCall(
                event_id=event.event_id,
                phase=classify_tool_call(call.tool_name, call.command),
                tool_name=call.tool_name,
                signature=call.signature,
                is_error=call.is_error,
            ))
    return calls


def detect_blind_retry(session_events: list[EventRec]) -> list[HabitFinding]:
    """Same tool, identical input, >= BLIND_RETRY_MIN consecutive attempts, all
    failing. The strict identical-input and all-failing evidence gates keep the
    observation distinct from ordinary iterative recovery."""
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
                count=len(run),
                exemplar_event_ids=(run[0].event_id,),
                detail=(f"{run[0].tool_name} retried {len(run)}x "
                        "with identical input, all failing"),
            ))

    for call in _flatten(session_events):
        same_run = (run and call.tool_name is not None
                    and call.tool_name == run[0].tool_name
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


def detect_tdd_loop(session_events: list[EventRec]) -> list[HabitFinding]:
    """Fail -> edit -> the same verify command passes. One finding per session
    aggregating all observed cycles."""
    if not session_events:
        return []
    head = session_events[0]
    pending: dict[str, dict[str, Any]] = {}  # verify signature -> failing state;
    # stale entries for commands that never re-run are harmless (sessions are bounded).
    cycles = 0
    exemplars: list[int] = []
    for call in _flatten(session_events):
        if call.phase == "implement":
            for state in pending.values():
                state["edited"] = True
        elif call.phase == "verify" and call.signature:
            if call.is_error:
                # Re-failing overwrites the state: the edit gate resets, and
                # only the latest failing turn is retained.
                pending[call.signature] = {
                    "edited": False, "event_id": call.event_id,
                }
            else:
                state = pending.pop(call.signature, None)
                if state and state["edited"]:
                    cycles += 1
                    exemplars.append(state["event_id"])
    if cycles == 0:
        return []
    return [HabitFinding(
        habit_key="tdd-loop",
        phase="verify",
        session_db_id=head.session_db_id,
        session_title=head.session_title,
        project_name=head.project_name,
        count=cycles,
        exemplar_event_ids=tuple(exemplars[:5]),
        detail=f"{cycles} fail-edit-pass cycle{'s' if cycles != 1 else ''}",
    )]


def detect_delegation(session_events: list[EventRec]) -> list[HabitFinding]:
    """Observed Task/Agent calls that dispatched work to subagents."""
    if not session_events:
        return []
    head = session_events[0]
    dispatches = [c for c in _flatten(session_events) if c.phase == "delegate"]
    if not dispatches:
        return []
    return [HabitFinding(
        habit_key="delegation",
        phase="delegate",
        session_db_id=head.session_db_id,
        session_title=head.session_title,
        project_name=head.project_name,
        count=len(dispatches),
        exemplar_event_ids=tuple(dict.fromkeys(c.event_id for c in dispatches))[:5],
        detail=(f"{len(dispatches)} subagent "
                f"dispatch{'es' if len(dispatches) != 1 else ''}"),
    )]


def detect_plan_before_burst(session_events: list[EventRec]) -> list[HabitFinding]:
    """A planning step (TodoWrite / plan mode) precedes at least PLAN_BURST_MIN
    edit calls anywhere later in the session."""
    if not session_events:
        return []
    head = session_events[0]
    calls = _flatten(session_events)
    first_plan = next((i for i, c in enumerate(calls) if c.phase == "plan"), None)
    if first_plan is None:
        return []
    implements = [c for c in calls[first_plan + 1:] if c.phase == "implement"]
    if len(implements) < PLAN_BURST_MIN:
        return []
    return [HabitFinding(
        habit_key="plan-before-burst",
        phase="plan",
        session_db_id=head.session_db_id,
        session_title=head.session_title,
        project_name=head.project_name,
        count=len(implements),
        exemplar_event_ids=(calls[first_plan].event_id,),
        detail=f"planning preceded {len(implements)} edit calls",
    )]


# Context-economics archetypes surfaced as usage-map habit leaves.
# Home phases per the spec: re-reads are Read-dominated (Explore); the other
# two concern the whole context, so they live on Converse.
# stale_continuation is intentionally excluded — the usage-map spec surfaces
# only these three as habit leaves.
_CONTEXT_HABIT_MAP: dict[str, tuple[str, str]] = {
    "rereads": ("re-reads", "explore"),
    "oversized": ("oversized-context", "converse"),
    "late_compaction": ("late-compaction", "converse"),
}


def _in_window(ts: str | None, date_from: str | None, date_to: str | None) -> bool:
    """Day-granular window test on an ISO timestamp. Undated items only pass
    when no window is set (a window must never smuggle in undatable findings)."""
    if not ts:
        return not date_from and not date_to
    day = ts[:10]
    if date_from and day < date_from[:10]:
        return False
    if date_to and day > date_to[:10]:
        return False
    return True


def detect_context_habits(
    conn: sqlite3.Connection,
    timeline: PriceTimeline,
    *,
    historical: bool = True,
    project_id: int | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
) -> list[HabitFinding]:
    """Adapter over the Context Economics detectors. Threads are loaded for the
    whole project corpus (load_threads has no date filter — thresholds stay
    corpus-calibrated); findings are then filtered to the window by their entry
    timestamp.
    Performance: runs the full context-economics pipeline on every call;
    memoise at the call site if this ends up on a hot path."""
    threads, _skipped = load_threads(conn, project_id=project_id)
    for thread in threads:
        accrue_tax(thread, timeline, historical=historical)
    results = run_detectors(threads)
    findings: list[HabitFinding] = []
    for archetype, (recs, _thresholds) in results.items():
        mapped = _CONTEXT_HABIT_MAP.get(archetype)
        if mapped is None:
            continue
        habit_key, phase = mapped
        for rec in recs:
            if not _in_window(rec.ts, date_from, date_to):
                continue
            findings.append(HabitFinding(
                habit_key=habit_key,
                phase=phase,
                session_db_id=rec.session_id,
                session_title=rec.session_title,
                project_name=rec.project_name,
                count=1,
                exemplar_event_ids=(rec.event_id,) if rec.event_id is not None else (),
                detail=rec.label,
            ))
    return findings


HABITS: list[dict[str, str]] = [
    {"key": "tdd-loop", "label": "Test-driven loops",
     "rule": "Observed sequence: a test command fails, edits follow, and the "
             "same command later passes."},
    {"key": "delegation", "label": "Subagent delegation",
     "rule": "Observed Task/Agent calls dispatching work to subagents."},
    {"key": "plan-before-burst", "label": "Plan before implementing",
     "rule": f"A planning step (TodoWrite, plan mode) precedes at least "
             f"{PLAN_BURST_MIN} observed edit calls later in the session."},
    {"key": "blind-retry", "label": "Repeated identical failures",
     "rule": f"The same tool called with identical input at least "
             f"{BLIND_RETRY_MIN} times in a row, with every attempt failing."},
    {"key": "re-reads", "label": "Repeated file re-reads",
     "rule": "The same file read into the context repeatedly in one epoch "
             "without an intervening edit (from Context Economics)."},
    {"key": "oversized-context", "label": "Large tool results",
     "rule": "Single tool results far above this corpus's norm entered the "
             "context (from Context Economics)."},
    {"key": "late-compaction", "label": "Extended high context",
     "rule": "Context stayed near the window limit for many turns without "
             "compaction (from Context Economics)."},
]
HABIT_BY_KEY: dict[str, dict[str, str]] = {h["key"]: h for h in HABITS}

# Per-session detector registry.
SESSION_DETECTORS: list[Callable[[list[EventRec]], list[HabitFinding]]] = [
    detect_tdd_loop,
    detect_delegation,
    detect_plan_before_burst,
    detect_blind_retry,
]


def run_habit_detectors(
    conn: sqlite3.Connection,
    timeline: PriceTimeline,
    events: list[EventRec],
    *,
    historical: bool = True,
    project_id: int | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
) -> list[HabitFinding]:
    """All detectors over the filtered corpus. Each detector is isolated: one
    failure logs and skips, it never breaks the endpoint."""
    by_session: dict[int, list[EventRec]] = defaultdict(list)
    for event in events:
        by_session[event.session_db_id].append(event)
    findings: list[HabitFinding] = []
    for detector in SESSION_DETECTORS:
        for session_events in by_session.values():
            try:
                findings.extend(detector(session_events))
            except Exception:
                logger.exception("usage-map detector %s failed",
                                 getattr(detector, "__name__", repr(detector)))
    try:
        findings.extend(detect_context_habits(
            conn, timeline, historical=historical, project_id=project_id,
            date_from=date_from, date_to=date_to,
        ))
    except Exception:
        logger.exception("usage-map context-economics adapter failed")
    return findings


def aggregate_habits(findings: list[HabitFinding]) -> list[dict[str, Any]]:
    """Fold findings into leaves keyed by (habit, home phase). A habit whose
    findings span phases (e.g. blind-retry) yields one leaf per phase."""
    grouped: dict[tuple[str, str], list[HabitFinding]] = defaultdict(list)
    for finding in findings:
        grouped[(finding.habit_key, finding.phase)].append(finding)
    leaves: list[dict[str, Any]] = []
    for (habit_key, phase), recs in sorted(grouped.items()):
        spec = HABIT_BY_KEY.get(habit_key)
        if spec is None:
            continue
        leaves.append({
            "key": habit_key,
            "phase": phase,
            "label": spec["label"],
            "activity_count": sum(r.count for r in recs),
            "session_count": len({r.session_db_id for r in recs}),
        })
    return leaves


# --- Corpus aggregation -------------------------------------------------------

def usage_map_analytics(
    conn: sqlite3.Connection,
    *,
    historical: bool = True,
    project_id: int | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
) -> dict[str, Any]:
    """The activity tree for the filtered corpus; phase counts partition it."""
    timeline = load_price_timeline(pricing_path(), pricing_dir())
    cost_available = timeline.has_prices
    events = load_events(conn, timeline, historical=historical, project_id=project_id,
                         date_from=date_from, date_to=date_to)
    phase_acc = aggregate_phases(events)
    leaves = aggregate_habits(run_habit_detectors(
        conn, timeline, events, historical=historical, project_id=project_id,
        date_from=date_from, date_to=date_to,
    )) if events else []

    total_usd = sum(event.cost for event in events)
    total_tokens = sum(event.tokens for event in events)
    total_activity = sum(bucket["activity_count"] for bucket in phase_acc.values())
    tool_call_count = sum(len(event.tool_calls) for event in events)
    text_step_count = sum(1 for event in events if not event.tool_calls)

    phases: list[dict[str, Any]] = []
    for spec in PHASES:
        bucket = phase_acc[spec["key"]]
        tools = sorted(
            (
                {
                    "key": name,
                    "label": name,
                    "activity_count": tool["activity_count"],
                    "session_count": len(tool["sessions"]),
                }
                for name, tool in bucket["tools"].items()
            ),
            key=lambda t: (-t["activity_count"], t["key"]),
        )
        phases.append({
            "key": spec["key"],
            "label": spec["label"],
            "activity_count": bucket["activity_count"],
            "main_activity_count": bucket["main_activity_count"],
            "subagent_activity_count": bucket["subagent_activity_count"],
            "text_assistant_step_count": bucket["text_assistant_step_count"],
            "activity_share": (
                round(bucket["activity_count"] / total_activity, 6)
                if total_activity > 0 else 0.0
            ),
            "tool_count": bucket["tool_count"],
            "session_count": len(bucket["sessions"]),
            "habits": [leaf for leaf in leaves if leaf["phase"] == spec["key"]],
            "tools": tools,
        })
    return {
        "meta": {
            "project_id": project_id,
            "window": {"date_from": date_from, "date_to": date_to},
            "total_usd": round(total_usd, 6),
            "total_tokens": int(round(total_tokens)),
            "cost_available": cost_available,
            "costs_partial": any(not e.priced for e in events),
            "sessions_analyzed": len({e.session_db_id for e in events}),
            "events_classified": len(events),
            "total_activity_count": total_activity,
            "tool_call_count": tool_call_count,
            "text_assistant_step_count": text_step_count,
            "activity_basis": ACTIVITY_BASIS,
            "methodology": ACTIVITY_METHODOLOGY,
        },
        "phases": phases,
    }


EVIDENCE_SESSIONS_LIMIT = 50
EVIDENCE_EXEMPLARS = 5


def usage_map_evidence(
    conn: sqlite3.Connection,
    *,
    node: str,
    historical: bool = True,
    project_id: int | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
) -> dict[str, Any]:
    """Receipts for one map node: the rule that put it there, and the sessions
    that fed it (activity-descending). Raises KeyError for unknown nodes."""
    kind, _, key = node.partition(":")
    timeline = load_price_timeline(pricing_path(), pricing_dir())
    events = load_events(conn, timeline, historical=historical, project_id=project_id,
                         date_from=date_from, date_to=date_to)

    session_costs: dict[int, float] = defaultdict(float)
    for event in events:
        session_costs[event.session_db_id] += event.cost
    sessions: dict[int, dict[str, Any]] = {}

    def entry_for(session_id: int, title: str, project: str) -> dict[str, Any]:
        return sessions.setdefault(session_id, {
            "session_id": session_id, "title": title, "project_name": project,
            "activity_count": 0,
            "session_cost_usd": round(session_costs[session_id], 6),
            "exemplar_event_ids": [], "detail": None,
        })

    if kind == "phase":
        spec = next((p for p in PHASES if p["key"] == key), None)
        if spec is None:
            raise KeyError(node)
        label, rule = spec["label"], (
            f"Observed tool calls classified as {spec['label']}; text-only "
            "assistant steps classify as Synthesize."
        )
        for event in events:
            count = event_phase_activity(event).get(key, 0)
            if count <= 0:
                continue
            entry = entry_for(event.session_db_id, event.session_title,
                              event.project_name)
            entry["activity_count"] += count
            if len(entry["exemplar_event_ids"]) < EVIDENCE_EXEMPLARS:
                entry["exemplar_event_ids"].append(event.event_id)
    elif kind == "habit":
        # Habit leaves are keyed (habit, home phase) on the map, so the node
        # may carry a phase qualifier ("habit:<key>@<phase>") to scope the
        # receipts to exactly the clicked leaf. Bare "habit:<key>" spans phases.
        habit_key, _, phase_filter = key.partition("@")
        spec = HABIT_BY_KEY.get(habit_key)
        if spec is None:
            raise KeyError(node)
        label, rule = spec["label"], spec["rule"]
        findings = [
            f for f in run_habit_detectors(
                conn, timeline, events, historical=historical, project_id=project_id,
                date_from=date_from, date_to=date_to,
            )
            if f.habit_key == habit_key
            and (not phase_filter or f.phase == phase_filter)
        ]
        for finding in findings:
            entry = entry_for(finding.session_db_id, finding.session_title,
                              finding.project_name)
            entry["activity_count"] += finding.count
            merged = entry["exemplar_event_ids"] + list(finding.exemplar_event_ids)
            entry["exemplar_event_ids"] = list(dict.fromkeys(merged))[:EVIDENCE_EXEMPLARS]
            entry["detail"] = finding.detail
    elif kind == "tool":
        # Tool leaves are always phase-scoped on the map: "tool:<name>@<phase>".
        tool_name, sep, phase_key = key.partition("@")
        spec = next((p for p in PHASES if p["key"] == phase_key), None)
        if not sep or not tool_name or spec is None:
            raise KeyError(node)
        label, rule = tool_name, (
            f"Observed {tool_name} calls classified as {spec['label']}."
        )
        for event in events:
            if not event.tool_calls:
                continue
            matched = sum(
                1 for call in event.tool_calls
                if call.tool_name == tool_name
                and classify_tool_call(call.tool_name, call.command) == phase_key
            )
            if matched == 0:
                continue
            entry = entry_for(event.session_db_id, event.session_title,
                              event.project_name)
            entry["activity_count"] += matched
            if len(entry["exemplar_event_ids"]) < EVIDENCE_EXEMPLARS:
                entry["exemplar_event_ids"].append(event.event_id)
    else:
        raise KeyError(node)

    rows = sorted(
        sessions.values(),
        key=lambda session: (-session["activity_count"], session["session_id"]),
    )
    return {
        "node": node,
        "label": label,
        "rule": rule,
        "activity_count": sum(e["activity_count"] for e in rows),
        "sessions": rows[:EVIDENCE_SESSIONS_LIMIT],
    }
