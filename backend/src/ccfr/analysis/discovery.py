from __future__ import annotations

import json
import math
import sqlite3
from collections import Counter, defaultdict
from dataclasses import dataclass
from statistics import NormalDist
from typing import Any

from ccfr.analysis.pricing import TokenBreakdown, cost_usd, load_price_timeline, match_price
from ccfr.naming import project_display_name
from ccfr.config import pricing_dir, pricing_path


SECTION_LIMIT = 8
EXAMPLE_LIMIT = 3
MAX_PAIR_DESCRIPTORS = 80

# Family-wise error rate for the Wilson significance gate. The gate applies a
# Bonferroni correction — dividing ALPHA by the number of candidates actually
# scored — so the per-section false-positive probability stays at most ALPHA
# regardless of how many conditions are tested.
ALPHA = 0.05


def _adjusted_z(num_candidates: int) -> float:
    """One-sided z for a Bonferroni-corrected Wilson gate over num_candidates tests.

    Divides ALPHA by the candidate count so the family-wise false-positive rate
    stays at ALPHA. For num_candidates=1 the result equals the classic 1.6449
    (inv_cdf(0.95)); for larger counts it grows, making the gate strictly more
    conservative.
    """
    return NormalDist().inv_cdf(1 - ALPHA / max(1, num_candidates))


@dataclass(frozen=True)
class Descriptor:
    key: str
    family: str
    label: str


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
    historical: bool = True,
) -> dict[str, Any]:
    """Return on-demand driver discovery results from the rebuildable SQLite cache."""
    min_support = max(1, int(min_support or 1))
    sessions, cost_available, unpriced_models = _session_subjects(
        conn, project_id=project_id, historical=historical
    )
    tool_calls = _tool_call_subjects(conn, project_id=project_id)

    cost_section = _section(
        key="cost_associations",
        title="Cost associations",
        target_label="High estimated API-equivalent cost",
        description=(
            "Session attributes associated with the observed top estimated-cost band. "
            "This is observational, not causal."
        ),
        subjects=sessions,
        min_support=min_support,
        observation_unit="session",
        available=cost_available,
        unavailable_reason=(
            None
            if cost_available
            else "Complete pricing coverage is required for cost associations."
        ),
    )
    tool_error_section = _section(
        key="tool_error_associations",
        title="Tool error associations",
        target_label="Tool calls with errors",
        description=(
            "Tool-call attributes associated with observed error results. "
            "Each observation is one tool call."
        ),
        subjects=tool_calls,
        min_support=min_support,
        observation_unit="tool_call",
    )

    return {
        "meta": {
            "project_id": project_id,
            "min_support": min_support,
            "total_sessions": len(sessions),
            "total_tool_calls": len(tool_calls),
            "cost_available": cost_available,
            "unpriced_models": unpriced_models,
        },
        "sections": {
            "cost_associations": cost_section,
            "tool_error_associations": tool_error_section,
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
    observation_unit: str,
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
            "observation_unit": observation_unit,
            "available": False,
            "unavailable_reason": unavailable_reason,
            "baseline_count": len(subjects),
            "positive_count": positives,
            "results": [],
        }

    candidates = _candidate_groups(subjects, min_support=min_support)
    scored_candidates = candidates
    z = _adjusted_z(len(scored_candidates))
    results = []
    for descriptors, indexes in scored_candidates:
        result = _score_group(subjects, descriptors, indexes, z=z)
        if result is None:
            continue
        results.append(result)

    results.sort(
        key=lambda item: (-item["effect_size"], -item["support"], item["title"])
    )
    return {
        "key": key,
        "title": title,
        "target_label": target_label,
        "description": description,
        "observation_unit": observation_unit,
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
    *,
    z: float,
) -> dict[str, Any] | None:
    total = len(subjects)
    positives = sum(1 for subject in subjects if subject.positive)
    support = len(indexes)
    complement_count = total - support
    if total == 0 or positives == 0 or support == 0 or complement_count == 0:
        return None
    positive_support = sum(1 for index in indexes if subjects[index].positive)
    if positive_support == 0:
        return None
    complement_positive_count = positives - positive_support
    baseline_rate = positives / total
    subgroup_rate = positive_support / support
    complement_rate = complement_positive_count / complement_count
    if subgroup_rate <= complement_rate:
        return None
    effect_size = subgroup_rate - complement_rate
    # Significance gate: require the Bonferroni-adjusted Wilson score lower bound
    # of the subgroup rate to clear the observed complement rate. The caller derives z from
    # _adjusted_z(m) where m is the number of candidates scored in this section,
    # so the family-wise false-positive rate stays at ALPHA across all tests.
    subgroup_rate_low = _wilson_lower_bound(positive_support, support, z)
    if subgroup_rate_low <= complement_rate:
        return None

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
        "summary": _summary(labels, effect_size),
        "selectors": labels,
        "support": support,
        "positive_support": positive_support,
        "complement_count": complement_count,
        "complement_positive_count": complement_positive_count,
        "baseline_rate": round(baseline_rate, 4),
        "subgroup_rate": round(subgroup_rate, 4),
        "complement_rate": round(complement_rate, 4),
        "effect_size": round(effect_size, 4),
        "subgroup_rate_low": round(subgroup_rate_low, 4),
        "examples": examples,
    }


def _wilson_lower_bound(positives: int, total: int, z: float) -> float:
    """One-sided Wilson score lower bound for a binomial proportion.

    Unlike the raw rate ``positives / total``, this shrinks toward 0 as the
    sample shrinks, so a 1/1 or 3/3 subgroup does not look as confident as a
    600/1000 one. We compare it against the baseline to decide significance.
    Callers derive z from _adjusted_z(m).
    """
    if total <= 0:
        return 0.0
    phat = positives / total
    z2 = z * z
    denom = 1.0 + z2 / total
    center = phat + z2 / (2 * total)
    margin = z * math.sqrt((phat * (1.0 - phat) + z2 / (4 * total)) / total)
    return max(0.0, (center - margin) / denom)


def _summary(labels: list[str], effect_size: float) -> str:
    conditions = labels[0] if len(labels) == 1 else " and ".join(labels)
    points = effect_size * 100
    return (
        f"{conditions} is associated with a {points:.1f} percentage-point higher "
        "observed rate than the complement."
    )


def _session_subjects(
    conn: sqlite3.Connection,
    *,
    project_id: int | None,
    historical: bool = True,
) -> tuple[list[Subject], bool, list[str]]:
    costs, available, unpriced_models = _scoped_session_costs(
        conn, project_id=project_id, historical=historical
    )
    rows = conn.execute(
        f"""
        SELECT
            s.id,
            s.session_id,
            s.title,
            p.export_name,
            p.inferred_cwd,
            COALESCE(ss.tool_call_count, 0) AS tool_call_count,
            COALESCE(ss.subagent_count, 0) AS subagent_count
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
    return subjects, available, unpriced_models


def _session_descriptors(
    row: sqlite3.Row,
    *,
    project: str,
    model_counts: Counter[str],
    tool_counts: Counter[str],
) -> set[Descriptor]:
    descriptors = {
        _descriptor("project", project, f"Project {project}"),
    }
    if int(row["subagent_count"] or 0) > 0:
        descriptors.add(_descriptor("fanout", "has_subagents", "Has subagents"))
    else:
        descriptors.add(_descriptor("fanout", "no_subagents", "No subagents"))
    top_model = model_counts.most_common(1)[0][0] if model_counts else "none"
    descriptors.add(_descriptor("top_model", top_model, f"Top model {top_model}"))
    for model in model_counts:
        descriptors.add(_descriptor("model", model, f"Uses {model}"))
    for tool, _count in tool_counts.most_common(8):
        descriptors.add(_descriptor("tool", tool, f"Uses {tool}"))
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
            tc.event_id,
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
                    "event_id": int(row["event_id"]),
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


def _scoped_session_costs(
    conn: sqlite3.Connection,
    *,
    project_id: int | None,
    historical: bool = True,
) -> tuple[dict[int, float], bool, list[str]]:
    timeline = load_price_timeline(pricing_path(), pricing_dir())
    if not timeline.has_prices:
        models = conn.execute(
            f"""
            SELECT DISTINCT m.model
            FROM messages m
            JOIN events e ON e.id = m.event_id
            JOIN sessions s ON s.id = e.session_id
            WHERE e.is_replay = 0 AND m.model IS NOT NULL AND m.model != ''
            {_project_and(project_id, "s")}
            ORDER BY m.model
            """,
            _project_params(project_id),
        ).fetchall()
        return {}, False, [str(row["model"]) for row in models]
    period_expr = timeline.sql_period_expr("e.timestamp", historical=historical)
    rows = conn.execute(
        f"""
        SELECT
            e.session_id,
            m.model,
            ({period_expr}) AS price_period,
            COALESCE(SUM(m.base_input_tokens), 0) AS base_input,
            COALESCE(SUM(m.cache_5m_tokens), 0) AS cache_write_5m,
            COALESCE(SUM(m.cache_1h_tokens), 0) AS cache_write_1h,
            COALESCE(SUM(m.cache_read_tokens), 0) AS cache_read,
            COALESCE(SUM(m.output_tokens), 0) AS output
        FROM messages m
        JOIN events e ON e.id = m.event_id
        JOIN sessions s ON s.id = e.session_id
        WHERE e.is_replay = 0 AND m.model IS NOT NULL AND m.model != ''
        {_project_and(project_id, "s")}
        GROUP BY e.session_id, m.model, price_period
        """,
        _project_params(project_id),
    ).fetchall()
    costs: dict[int, float] = {}
    unpriced_models: set[str] = set()
    for row in rows:
        table = timeline.table_for_period(row["price_period"], historical=historical)
        price = match_price(table, row["model"])
        if price is None:
            unpriced_models.add(str(row["model"] or "unknown"))
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
    return (
        {session_id: round(usd, 6) for session_id, usd in costs.items()},
        not unpriced_models,
        sorted(unpriced_models),
    )


def _models_by_session(conn: sqlite3.Connection, *, project_id: int | None) -> dict[int, Counter[str]]:
    rows = conn.execute(
        f"""
        SELECT e.session_id, m.model, COUNT(*) AS n
        FROM messages m
        JOIN events e ON e.id = m.event_id
        JOIN sessions s ON s.id = e.session_id
        WHERE e.is_replay = 0 AND m.model IS NOT NULL AND m.model != ''
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


def _command_family(command: str) -> str:
    """Classify command intent directly from a tool-call receipt."""
    cmd = command.lower().strip()
    if not cmd:
        return "empty"
    if any(token in cmd for token in (
        "pytest", "vitest", "npm test", "pnpm test", "yarn test",
        "cargo test", "go test",
    )):
        return "test"
    if any(token in cmd for token in (
        "ruff", "mypy", "eslint", "tsc", "biome", "prettier --check",
    )):
        return "lint_typecheck"
    if any(token in cmd for token in (
        "npm run build", "pnpm build", "yarn build", "cargo build",
        "docker compose",
    )):
        return "build"
    if cmd.startswith("git ") or " git " in cmd:
        return "git"
    if any(token in cmd for token in (
        "npm install", "pnpm install", "yarn add", "uv add", "pip install",
    )):
        return "deps"
    if any(token in cmd for token in ("remove-item", " rm ", "rm -", " del ", " rmdir ")):
        return "delete"
    if any(token in cmd for token in ("curl ", "wget ", "invoke-webrequest", "webfetch")):
        return "network"
    if "python" in cmd or "node " in cmd:
        return "script"
    if any(token in cmd for token in ("rg ", "grep ", "findstr", "select-string")):
        return "search"
    if cmd in {"ls", "dir"} or any(token in cmd for token in ("get-childitem", " ls ", " dir ")):
        return "list"
    return "other"


def _descriptor(family: str, value: Any, label: str) -> Descriptor:
    return Descriptor(f"{family}={value}", family, label)


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


def _title(value: Any) -> str:
    return str(value).replace("_", " ").replace("-", " ").title()
