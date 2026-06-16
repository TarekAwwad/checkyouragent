from __future__ import annotations

from ccfr.analysis.usage_characteristics import (
    SUBAGENT_HEAVY_SESSION_RATIO,
    compute_characteristics,
    _span_hours,
)
from ccfr.analysis.usage_map import EventRec, ToolCallRec


def _ev(event_id: int, *, session: int, cost: float, agent_id: str | None = None,
        ctx: int = 0, tokens: int = 1000) -> EventRec:
    return EventRec(
        event_id=event_id, session_db_id=session, session_title="S",
        project_name="alpha", ts="2026-06-01T10:00:00Z", model="m",
        cost=cost, tokens=tokens, priced=True, tool_calls=(),
        agent_id=agent_id, input_context_tokens=ctx,
    )


def _by_key(chars: list[dict]) -> dict[str, dict]:
    return {c["key"]: c for c in chars}


def test_subagent_heavy_session_counts_full_cost() -> None:
    events = [
        _ev(1, session=1, cost=4.0),                       # main
        _ev(2, session=1, cost=6.0, agent_id="a1"),        # subagent (60% of session 1)
        _ev(3, session=2, cost=10.0),                      # main-only session
    ]
    chars = _by_key(compute_characteristics(
        events, session_spans={}, agent_types={}, use_cost=True))
    heavy = chars["subagent_sessions"]
    assert heavy["cost_usd"] == 10.0           # full cost of session 1
    assert heavy["share"] == round(10.0 / 20.0, 6)


def test_session_below_ratio_is_not_heavy() -> None:
    events = [
        _ev(1, session=1, cost=6.0),                       # main
        _ev(2, session=1, cost=4.0, agent_id="a1"),        # 40% subagent
    ]
    chars = _by_key(compute_characteristics(
        events, session_spans={}, agent_types={}, use_cost=True))
    assert chars["subagent_sessions"]["cost_usd"] == 0.0


def test_context_band_counts_only_large_calls() -> None:
    events = [
        _ev(1, session=1, cost=5.0, ctx=160_000),
        _ev(2, session=1, cost=5.0, ctx=100_000),
    ]
    chars = _by_key(compute_characteristics(
        events, session_spans={}, agent_types={}, use_cost=True))
    assert chars["context_gt_150k"]["cost_usd"] == 5.0
    assert chars["context_gt_150k"]["share"] == round(5.0 / 10.0, 6)


def test_duration_band_uses_full_session_span() -> None:
    events = [_ev(1, session=1, cost=8.0), _ev(2, session=2, cost=2.0)]
    spans = {
        1: ("2026-06-01T00:00:00Z", "2026-06-01T09:00:00Z"),  # 9h -> long
        2: ("2026-06-01T00:00:00Z", "2026-06-01T01:00:00Z"),  # 1h
    }
    chars = _by_key(compute_characteristics(
        events, session_spans=spans, agent_types={}, use_cost=True))
    assert chars["duration_gte_8h"]["cost_usd"] == 8.0


def test_agent_type_expansion_and_floor() -> None:
    events = [
        _ev(1, session=1, cost=20.0, agent_id="a1"),   # general-purpose
        _ev(2, session=1, cost=2.0, agent_id="a2"),    # rare -> below 5% floor
        _ev(3, session=1, cost=78.0),                  # main
    ]
    agent_types = {(1, "a1"): "general-purpose", (1, "a2"): "rare"}
    chars = _by_key(compute_characteristics(
        events, session_spans={}, agent_types=agent_types, use_cost=True))
    assert 'agent_type:general-purpose' in chars
    assert chars['agent_type:general-purpose']['headline'] == 'subagents under "general-purpose"'
    assert 'agent_type:rare' not in chars   # 2/100 = 2% < 5% floor


def test_shares_may_overlap_above_one() -> None:
    events = [_ev(1, session=1, cost=10.0, agent_id="a1", ctx=200_000)]
    chars = _by_key(compute_characteristics(
        events, session_spans={}, agent_types={}, use_cost=True))
    assert chars["subagent_sessions"]["share"] == 1.0
    assert chars["context_gt_150k"]["share"] == 1.0


def test_empty_events_yield_zero_shares() -> None:
    chars = compute_characteristics([], session_spans={}, agent_types={}, use_cost=True)
    assert all(c["share"] == 0.0 for c in chars)


def test_span_hours_handles_missing_timestamps() -> None:
    assert _span_hours(None, "2026-06-01T01:00:00Z") == 0.0
    assert _span_hours("2026-06-01T00:00:00Z", None) == 0.0
    assert _span_hours("2026-06-01T00:00:00Z", "2026-06-01T08:00:00Z") == 8.0
