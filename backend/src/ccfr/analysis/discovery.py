from __future__ import annotations

import json
import math
import sqlite3
from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import Any

from ccfr.analysis.pricing import TokenBreakdown, cost_usd, load_price_table, match_price
from ccfr.analysis.risk_patterns import _command_family
from ccfr.naming import project_display_name
from ccfr.config import pricing_path


SECTION_LIMIT = 8
EXAMPLE_LIMIT = 3
MAX_PAIR_DESCRIPTORS = 80

# z-score for a one-sided 95% Wilson score bound. Used to require that a
# subgroup's enrichment clears the baseline with statistical confidence rather
# than by chance on a handful of matching items.
CONFIDENCE_Z = 1.645
MIN_LIFT = 1.15


@dataclass(frozen=True)
class Descriptor:
    key: str
    family: str
    label: str
    fanout: bool = False


@dataclass
class Subject:
    id: int
    descriptors: set[Descriptor]
    positive: bool
    metric: float = 0.0
    example: dict[str, Any] | None = None


def discovery_analytics(
    conn: sqlite3.Connection,
    *,
    project_id: int | None = None,
    min_support: int = 5,
) -> dict[str, Any]:
    """Return on-demand driver discovery results from the rebuildable SQLite cache."""
    min_support = max(1, int(min_support or 1))
    sessions, cost_available = _session_subjects(conn, project_id=project_id)
    tool_calls = _tool_call_subjects(conn, project_id=project_id)
    rejection_slices = _rejection_slice_subjects(conn, project_id=project_id)

    cost_section = _section(
        key="cost",
        title="Cost drivers",
        target_label="High-cost sessions",
        description="Conditions that make a session more likely to land in the top cost band.",
        subjects=sessions,
        min_support=min_support,
        available=cost_available,
        unavailable_reason=None if cost_available else "Price table unavailable.",
    )
    fanout_section = _section(
        key="fanout_cost",
        title="Fanout cost drivers",
        target_label="High-cost sessions",
        description="Cost drivers that include subagent fanout or Agent orchestration.",
        subjects=sessions,
        min_support=min_support,
        require_fanout=True,
        available=cost_available,
        unavailable_reason=None if cost_available else "Price table unavailable.",
    )
    tool_error_section = _section(
        key="tool_errors",
        title="Tool error drivers",
        target_label="Tool calls with errors",
        description="Tool-call conditions that are more likely to end in an error result.",
        subjects=tool_calls,
        min_support=min_support,
    )
    rejection_section = _section(
        key="rejections",
        title="Rejection drivers",
        target_label="Rejected slices",
        description="Workflow features that are more likely to appear in rejected slices.",
        subjects=rejection_slices,
        min_support=min_support,
    )

    return {
        "meta": {
            "project_id": project_id,
            "min_support": min_support,
            "total_sessions": len(sessions),
            "cost_available": cost_available,
        },
        "sections": {
            "cost": cost_section,
            "fanout_cost": fanout_section,
            "tool_errors": tool_error_section,
            "rejections": rejection_section,
        },
    }


def _section(
    *,
    key: str,
    title: str,
    target_label: str,
    description: str,
    subjects: list[Subject],
    min_support: int,
    require_fanout: bool = False,
    available: bool = True,
    unavailable_reason: str | None = None,
) -> dict[str, Any]:
    positives = sum(1 for subject in subjects if subject.positive)
    if not available:
        return {
            "key": key,
            "title": title,
            "target_label": target_label,
            "description": description,
            "available": False,
            "unavailable_reason": unavailable_reason,
            "baseline_count": len(subjects),
            "positive_count": positives,
            "results": [],
        }

    candidates = _candidate_groups(subjects, min_support=min_support)
    results = []
    for descriptors, indexes in candidates:
        if require_fanout and not any(descriptor.fanout for descriptor in descriptors):
            continue
        result = _score_group(subjects, descriptors, indexes)
        if result is None:
            continue
        results.append(result)

    results.sort(key=lambda item: (-item["score"], -item["support"], item["title"]))
    return {
        "key": key,
        "title": title,
        "target_label": target_label,
        "description": description,
        "available": True,
        "unavailable_reason": None,
        "baseline_count": len(subjects),
        "positive_count": positives,
        "results": results[:SECTION_LIMIT],
    }


def _candidate_groups(
    subjects: list[Subject],
    *,
    min_support: int,
) -> list[tuple[tuple[Descriptor, ...], set[int]]]:
    by_descriptor: dict[Descriptor, set[int]] = defaultdict(set)
    for index, subject in enumerate(subjects):
        for descriptor in subject.descriptors:
            by_descriptor[descriptor].add(index)

    candidates: list[tuple[tuple[Descriptor, ...], set[int]]] = [
        ((descriptor,), indexes)
        for descriptor, indexes in by_descriptor.items()
        if len(indexes) >= min_support
    ]
    ranked = sorted(
        by_descriptor.items(),
        key=lambda item: (-len(item[1]), item[0].family, item[0].key),
    )[:MAX_PAIR_DESCRIPTORS]
    for left_index, (left, left_indexes) in enumerate(ranked):
        for right, right_indexes in ranked[left_index + 1:]:
            if left.family == right.family:
                continue
            indexes = left_indexes & right_indexes
            if len(indexes) >= min_support:
                ordered = tuple(sorted((left, right), key=lambda item: (item.family, item.key)))
                candidates.append((ordered, indexes))
    return candidates


def _score_group(
    subjects: list[Subject],
    descriptors: tuple[Descriptor, ...],
    indexes: set[int],
) -> dict[str, Any] | None:
    total = len(subjects)
    positives = sum(1 for subject in subjects if subject.positive)
    support = len(indexes)
    if total == 0 or positives == 0 or support == 0:
        return None
    positive_support = sum(1 for index in indexes if subjects[index].positive)
    if positive_support == 0:
        return None
    baseline_rate = positives / total
    subgroup_rate = positive_support / support
    if subgroup_rate <= baseline_rate:
        return None
    lift = subgroup_rate / baseline_rate if baseline_rate > 0 else 0.0
    if lift < MIN_LIFT:
        return None
    # Significance gate: require the Wilson score lower bound of the subgroup
    # rate to clear the baseline. The lower bound shrinks toward the rate only
    # as support grows, so a modest lift measured on a handful of matching items
    # no longer qualifies the way a raw rate or lift comparison would.
    subgroup_rate_low = _wilson_lower_bound(positive_support, support)
    if subgroup_rate_low <= baseline_rate:
        return None
    score = (support / total) * (subgroup_rate - baseline_rate)

    labels = [descriptor.label for descriptor in descriptors]
    examples = [
        subject.example
        for subject in sorted(
            (subjects[index] for index in indexes),
            key=lambda item: (not item.positive, -item.metric, item.id),
        )
        if subject.example is not None
    ][:EXAMPLE_LIMIT]
    title = " + ".join(labels)
    return {
        "id": "|".join(descriptor.key for descriptor in descriptors),
        "title": title,
        "summary": _summary(labels, lift),
        "selectors": labels,
        "support": support,
        "positive_support": positive_support,
        "baseline_rate": round(baseline_rate, 4),
        "subgroup_rate": round(subgroup_rate, 4),
        "subgroup_rate_low": round(subgroup_rate_low, 4),
        "lift": round(lift, 3),
        "score": round(score, 6),
        "examples": examples,
    }


def _wilson_lower_bound(positives: int, total: int, z: float = CONFIDENCE_Z) -> float:
    """One-sided Wilson score lower bound for a binomial proportion.

    Unlike the raw rate ``positives / total``, this shrinks toward 0 as the
    sample shrinks, so a 1/1 or 3/3 subgroup does not look as confident as a
    600/1000 one. We compare it against the baseline to decide significance.
    """
    if total <= 0:
        return 0.0
    phat = positives / total
    z2 = z * z
    denom = 1.0 + z2 / total
    center = phat + z2 / (2 * total)
    margin = z * math.sqrt((phat * (1.0 - phat) + z2 / (4 * total)) / total)
    return max(0.0, (center - margin) / denom)


def _summary(labels: list[str], lift: float) -> str:
    if len(labels) == 1:
        return f"{labels[0]} is {lift:.1f}x more likely than baseline."
    return f"{' and '.join(labels)} is {lift:.1f}x more likely than baseline."


def _session_subjects(conn: sqlite3.Connection, *, project_id: int | None) -> tuple[list[Subject], bool]:
    costs, available = _scoped_session_costs(conn, project_id=project_id)
    rows = conn.execute(
        f"""
        SELECT
            s.id,
            s.session_id,
            s.title,
            p.export_name,
            p.inferred_cwd,
            COALESCE(ss.event_count, 0) AS event_count,
            COALESCE(ss.turn_count, 0) AS turn_count,
            COALESCE(ss.tool_call_count, 0) AS tool_call_count,
            COALESCE(ss.subagent_count, 0) AS subagent_count,
            COALESCE(ss.loop_count, 0) AS loop_count,
            CAST(
                ROUND(COALESCE((julianday(s.last_ts) - julianday(s.first_ts)) * 86400, 0)) AS INTEGER
            ) AS duration_seconds
        FROM sessions s
        JOIN projects p ON p.id = s.project_id
        LEFT JOIN session_stats ss ON ss.session_id = s.id
        {_project_where(project_id, "s")}
        ORDER BY s.id
        """,
        _project_params(project_id),
    ).fetchall()
    model_counts = _models_by_session(conn, project_id=project_id)
    tool_counts = _tools_by_session(conn, project_id=project_id)
    threshold = _percentile([costs.get(int(row["id"]), 0.0) for row in rows], 0.9)

    subjects: list[Subject] = []
    for row in rows:
        session_id = int(row["id"])
        project = project_display_name(row["export_name"], row["inferred_cwd"])
        cost = costs.get(session_id, 0.0)
        descriptors = _session_descriptors(
            row,
            project=project,
            model_counts=model_counts.get(session_id, Counter()),
            tool_counts=tool_counts.get(session_id, Counter()),
        )
        subjects.append(
            Subject(
                id=session_id,
                descriptors=descriptors,
                positive=available and threshold > 0 and cost >= threshold,
                metric=cost,
                example={
                    "id": session_id,
                    "kind": "session",
                    "session_id": row["session_id"],
                    "title": row["title"],
                    "project_name": project,
                    "metric": round(cost, 6),
                    "metric_label": "estimated cost",
                    "detail": f"{int(row['subagent_count'] or 0)} subagents, {int(row['tool_call_count'] or 0)} tools",
                },
            )
        )
    return subjects, available


def _session_descriptors(
    row: sqlite3.Row,
    *,
    project: str,
    model_counts: Counter[str],
    tool_counts: Counter[str],
) -> set[Descriptor]:
    descriptors = {
        _descriptor("project", project, f"Project {project}"),
        _descriptor("turns", _count_bin(row["turn_count"]), f"{_count_bin(row['turn_count'])} turns"),
        _descriptor("tools", _count_bin(row["tool_call_count"]), f"{_count_bin(row['tool_call_count'])} tool calls"),
        _descriptor("subagents", _count_bin(row["subagent_count"]), f"{_count_bin(row['subagent_count'])} subagents", fanout=True),
        _descriptor("loops", _count_bin(row["loop_count"]), f"{_count_bin(row['loop_count'])} loop runs"),
        _descriptor("duration", _duration_bin(row["duration_seconds"]), _duration_label(row["duration_seconds"])),
    }
    if int(row["subagent_count"] or 0) > 0:
        descriptors.add(_descriptor("fanout", "has_subagents", "Has subagents", fanout=True))
    else:
        descriptors.add(_descriptor("fanout", "no_subagents", "No subagents"))
    if int(row["loop_count"] or 0) > 0:
        descriptors.add(_descriptor("loop_presence", "has_loops", "Has loop activity"))
    else:
        descriptors.add(_descriptor("loop_presence", "no_loops", "No loop activity"))

    top_model = model_counts.most_common(1)[0][0] if model_counts else "none"
    descriptors.add(_descriptor("top_model", top_model, f"Top model {top_model}"))
    for model in model_counts:
        descriptors.add(_descriptor("model", model, f"Uses {model}"))
    for tool, _count in tool_counts.most_common(8):
        descriptors.add(
            _descriptor("tool", tool, f"Uses {tool}", fanout=tool == "Agent")
        )
    return descriptors


def _tool_call_subjects(conn: sqlite3.Connection, *, project_id: int | None) -> list[Subject]:
    result_errors: dict[tuple[int, str], bool] = {}
    for row in conn.execute(
        f"""
        SELECT tr.session_id, tr.tool_use_id, MAX(tr.is_error) AS is_error
        FROM tool_results tr
        JOIN sessions s ON s.id = tr.session_id
        WHERE tr.tool_use_id IS NOT NULL
        {_project_and(project_id, "s")}
        GROUP BY tr.session_id, tr.tool_use_id
        """,
        _project_params(project_id),
    ).fetchall():
        result_errors[(int(row["session_id"]), str(row["tool_use_id"]))] = bool(row["is_error"])

    rows = conn.execute(
        f"""
        SELECT
            tc.id,
            tc.session_id,
            tc.tool_use_id,
            tc.tool_name,
            tc.input_preview,
            tc.raw_json,
            e.is_sidechain,
            s.session_id AS session_uuid,
            s.title,
            p.export_name,
            p.inferred_cwd
        FROM tool_calls tc
        JOIN events e ON e.id = tc.event_id
        JOIN sessions s ON s.id = tc.session_id
        JOIN projects p ON p.id = s.project_id
        {_project_where(project_id, "s")}
        ORDER BY tc.id
        """,
        _project_params(project_id),
    ).fetchall()

    subjects: list[Subject] = []
    for row in rows:
        tool_name = str(row["tool_name"] or "unknown")
        project = project_display_name(row["export_name"], row["inferred_cwd"])
        descriptors = {
            _descriptor("project", project, f"Project {project}"),
            _descriptor("tool", tool_name, f"{tool_name} calls"),
            _descriptor("chain", "sidechain" if row["is_sidechain"] else "main", "Sidechain calls" if row["is_sidechain"] else "Main-chain calls"),
        }
        family = _call_command_family(tool_name, row["raw_json"], row["input_preview"])
        if family is not None:
            descriptors.add(_descriptor("command_family", family, f"{_title(family)} commands"))
            descriptors.add(_descriptor("tool_family", f"{tool_name}:{family}", f"{tool_name} {_title(family)} commands"))
        positive = result_errors.get((int(row["session_id"]), str(row["tool_use_id"])), False)
        subjects.append(
            Subject(
                id=int(row["id"]),
                descriptors=descriptors,
                positive=positive,
                metric=1.0 if positive else 0.0,
                example={
                    "id": int(row["session_id"]),
                    "kind": "tool_call",
                    "session_id": row["session_uuid"],
                    "title": row["title"],
                    "project_name": project,
                    "metric": 1.0 if positive else 0.0,
                    "metric_label": "tool error" if positive else "tool call",
                    "detail": f"{tool_name} on {'sidechain' if row['is_sidechain'] else 'main chain'}",
                },
            )
        )
    return subjects


def _rejection_slice_subjects(conn: sqlite3.Connection, *, project_id: int | None) -> list[Subject]:
    rows = conn.execute(
        f"""
        SELECT
            ss.id,
            ss.session_id,
            ss.kind,
            ss.outcome,
            ss.length,
            s.session_id AS session_uuid,
            s.title,
            p.export_name,
            p.inferred_cwd
        FROM sequence_slices ss
        JOIN sessions s ON s.id = ss.session_id
        JOIN projects p ON p.id = s.project_id
        {_project_where(project_id, "s")}
        ORDER BY ss.id
        """,
        _project_params(project_id),
    ).fetchall()
    features = _features_by_slice(conn, project_id=project_id)

    subjects: list[Subject] = []
    for row in rows:
        project = project_display_name(row["export_name"], row["inferred_cwd"])
        descriptors = {
            _descriptor("project", project, f"Project {project}"),
            _descriptor("slice_kind", row["kind"], f"{_title(row['kind'])} slices"),
            _descriptor("slice_length", _slice_length_bin(row["length"]), f"{_slice_length_label(row['length'])} slices"),
        }
        descriptors.update(features.get(int(row["id"]), set()))
        positive = row["outcome"] == "rejected"
        subjects.append(
            Subject(
                id=int(row["id"]),
                descriptors=descriptors,
                positive=positive,
                metric=1.0 if positive else 0.0,
                example={
                    "id": int(row["session_id"]),
                    "kind": "slice",
                    "session_id": row["session_uuid"],
                    "title": row["title"],
                    "project_name": project,
                    "metric": 1.0 if positive else 0.0,
                    "metric_label": row["outcome"],
                    "detail": f"{row['kind']} slice, {int(row['length'] or 0)} features",
                },
            )
        )
    return subjects


def _features_by_slice(conn: sqlite3.Connection, *, project_id: int | None) -> dict[int, set[Descriptor]]:
    rows = conn.execute(
        f"""
        SELECT ef.sequence_slice_id, ef.symbol, ef.family
        FROM event_features ef
        JOIN sessions s ON s.id = ef.session_id
        {_project_where(project_id, "s")}
        GROUP BY ef.sequence_slice_id, ef.symbol, ef.family
        """,
        _project_params(project_id),
    ).fetchall()
    by_slice: dict[int, set[Descriptor]] = defaultdict(set)
    for row in rows:
        symbol = str(row["symbol"])
        if _skip_rejection_symbol(symbol):
            continue
        family = str(row["family"] or "feature")
        by_slice[int(row["sequence_slice_id"])].add(
            _descriptor(f"feature_{family}", symbol, _feature_label(symbol))
        )
    return by_slice


def _skip_rejection_symbol(symbol: str) -> bool:
    return (
        symbol == "RESULT:ok"
        or symbol.startswith("TEXT:")
        or symbol.startswith("STOP:")
        or "user_rejected" in symbol
        or "permission_denied" in symbol
    )


def _feature_label(symbol: str) -> str:
    if symbol.startswith("CALL:"):
        parts = symbol.split(":")
        if len(parts) >= 3:
            return f"{parts[1]} {parts[2]} activity".replace("inspect ", "")
    if symbol.startswith("EVENT:attachment:"):
        return f"{_title(symbol.removeprefix('EVENT:attachment:'))} attachments"
    if symbol.startswith("RESULT:error:"):
        return f"{_title(symbol.removeprefix('RESULT:error:'))} results"
    return _title(symbol.replace(":", " "))


def _scoped_session_costs(conn: sqlite3.Connection, *, project_id: int | None) -> tuple[dict[int, float], bool]:
    table = load_price_table(pricing_path())
    if not table:
        return {}, False
    rows = conn.execute(
        f"""
        SELECT
            e.session_id,
            m.model,
            COALESCE(SUM(m.base_input_tokens), 0) AS base_input,
            COALESCE(SUM(m.cache_5m_tokens), 0) AS cache_write_5m,
            COALESCE(SUM(m.cache_1h_tokens), 0) AS cache_write_1h,
            COALESCE(SUM(m.cache_read_tokens), 0) AS cache_read,
            COALESCE(SUM(m.output_tokens), 0) AS output
        FROM messages m
        JOIN events e ON e.id = m.event_id
        JOIN sessions s ON s.id = e.session_id
        {_project_where(project_id, "s")}
        GROUP BY e.session_id, m.model
        """,
        _project_params(project_id),
    ).fetchall()
    costs: dict[int, float] = {}
    for row in rows:
        price = match_price(table, row["model"])
        if price is None:
            continue
        breakdown = TokenBreakdown(
            base_input=int(row["base_input"]),
            cache_write_5m=int(row["cache_write_5m"]),
            cache_write_1h=int(row["cache_write_1h"]),
            cache_read=int(row["cache_read"]),
            output=int(row["output"]),
        )
        session_id = int(row["session_id"])
        costs[session_id] = costs.get(session_id, 0.0) + cost_usd(price, breakdown)
    return {session_id: round(usd, 6) for session_id, usd in costs.items()}, True


def _models_by_session(conn: sqlite3.Connection, *, project_id: int | None) -> dict[int, Counter[str]]:
    rows = conn.execute(
        f"""
        SELECT e.session_id, m.model, COUNT(*) AS n
        FROM messages m
        JOIN events e ON e.id = m.event_id
        JOIN sessions s ON s.id = e.session_id
        WHERE m.model IS NOT NULL AND m.model != ''
        {_project_and(project_id, "s")}
        GROUP BY e.session_id, m.model
        """,
        _project_params(project_id),
    ).fetchall()
    result: dict[int, Counter[str]] = defaultdict(Counter)
    for row in rows:
        result[int(row["session_id"])][str(row["model"])] += int(row["n"])
    return result


def _tools_by_session(conn: sqlite3.Connection, *, project_id: int | None) -> dict[int, Counter[str]]:
    rows = conn.execute(
        f"""
        SELECT tc.session_id, COALESCE(tc.tool_name, 'unknown') AS tool_name, COUNT(*) AS n
        FROM tool_calls tc
        JOIN sessions s ON s.id = tc.session_id
        {_project_where(project_id, "s")}
        GROUP BY tc.session_id, tc.tool_name
        """,
        _project_params(project_id),
    ).fetchall()
    result: dict[int, Counter[str]] = defaultdict(Counter)
    for row in rows:
        result[int(row["session_id"])][str(row["tool_name"])] += int(row["n"])
    return result


def _call_command_family(tool_name: str, raw_json: Any, input_preview: str | None) -> str | None:
    if tool_name not in {"Bash", "PowerShell"}:
        return None
    try:
        raw = json.loads(str(raw_json or "{}"))
    except json.JSONDecodeError:
        raw = {}
    input_obj = raw.get("input") if isinstance(raw.get("input"), dict) else {}
    command = str(input_obj.get("command") or input_preview or "")
    return _command_family(command)


def _descriptor(family: str, value: Any, label: str, *, fanout: bool = False) -> Descriptor:
    return Descriptor(f"{family}={value}", family, label, fanout=fanout)


def _project_where(project_id: int | None, alias: str) -> str:
    return f"WHERE {alias}.project_id = ?" if project_id is not None else ""


def _project_and(project_id: int | None, alias: str) -> str:
    return f"AND {alias}.project_id = ?" if project_id is not None else ""


def _project_params(project_id: int | None) -> list[int]:
    return [project_id] if project_id is not None else []


def _percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    pos = (len(ordered) - 1) * pct
    lower = int(pos)
    upper = min(lower + 1, len(ordered) - 1)
    if lower == upper:
        return ordered[lower]
    weight = pos - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def _count_bin(value: Any) -> str:
    value = int(value or 0)
    if value == 0:
        return "0"
    if value == 1:
        return "1"
    if value <= 3:
        return "2-3"
    if value <= 10:
        return "4-10"
    return ">10"


def _duration_bin(value: Any) -> str:
    seconds = int(value or 0)
    if seconds == 0:
        return "0"
    if seconds < 600:
        return "<10m"
    if seconds < 3600:
        return "10m-1h"
    return ">=1h"


def _duration_label(value: Any) -> str:
    return f"Duration {_duration_bin(value)}"


def _slice_length_bin(value: Any) -> str:
    length = int(value or 0)
    if length < 10:
        return "<10"
    if length < 40:
        return "10-39"
    if length < 120:
        return "40-119"
    return ">=120"


def _slice_length_label(value: Any) -> str:
    return f"{_slice_length_bin(value)} feature"


def _title(value: Any) -> str:
    return str(value).replace("_", " ").replace("-", " ").title()
