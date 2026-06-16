from __future__ import annotations

import sqlite3

from fastapi.testclient import TestClient

from ccfr.analysis import usage_map as um
from ccfr.analysis.usage_characteristics import (
    SUBAGENT_HEAVY_SESSION_RATIO,
    compute_characteristics,
    usage_characteristics_analytics,
    _span_hours,
)
from ccfr.analysis.usage_map import EventRec, ToolCallRec
from ccfr.api.deps import get_db
from ccfr.main import create_app
from ccfr.storage import init_db


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


def test_token_basis_weights_by_tokens_not_cost() -> None:
    # With use_cost=False, shares weight by tokens; cost_usd still reports USD.
    events = [
        _ev(1, session=1, cost=1.0, tokens=300, agent_id="a1"),  # subagent
        _ev(2, session=2, cost=99.0, tokens=100),                # main-only
    ]
    chars = _by_key(compute_characteristics(
        events, session_spans={}, agent_types={}, use_cost=False))
    heavy = chars["subagent_sessions"]
    # session 1 is 100% subagent -> heavy. Token share = 300 / 400.
    assert heavy["share"] == round(300 / 400, 6)
    # cost_usd is still the USD sum of the heavy session, not the token weight.
    assert heavy["cost_usd"] == 1.0


def test_span_hours_handles_missing_timestamps() -> None:
    assert _span_hours(None, "2026-06-01T01:00:00Z") == 0.0
    assert _span_hours("2026-06-01T00:00:00Z", None) == 0.0
    assert _span_hours("2026-06-01T00:00:00Z", "2026-06-01T08:00:00Z") == 8.0


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    init_db(conn)
    return conn


def _seed(conn: sqlite3.Connection) -> None:
    conn.execute("INSERT INTO imports (id, source_path, imported_at, file_count, status) "
                 "VALUES (1, '/x', '2026-06-01T00:00:00Z', 1, 'complete')")
    conn.execute("INSERT INTO projects (id, import_id, export_name, inferred_cwd) "
                 "VALUES (1, 1, 'd--Alpha', '/workspace/alpha')")
    conn.execute("INSERT INTO sessions (id, project_id, session_id, title, first_ts, last_ts) "
                 "VALUES (1, 1, 's1', 'S1', '2026-06-01T00:00:00Z', '2026-06-01T10:00:00Z')")
    conn.commit()


def _add(conn, event_id, session_id, *, agent_id=None, base=200_000, out=40_000,
         model="claude-opus-4-8") -> None:
    conn.execute(
        "INSERT INTO events (id, session_id, source_path, line_no, uuid, type, timestamp, agent_id, raw_json) "
        "VALUES (?, ?, 'x.jsonl', 1, ?, 'assistant', '2026-06-01T10:00:00Z', ?, '{}')",
        (event_id, session_id, f"u{event_id}", agent_id))
    conn.execute(
        "INSERT INTO messages (event_id, role, model, base_input_tokens, output_tokens) "
        "VALUES (?, 'assistant', ?, ?, ?)", (event_id, model, base, out))
    conn.commit()


PRICE = {"claude-opus-4-8": um.ModelPrice(base_input=5, cache_write_5m=6.25,
                                          cache_write_1h=10, cache_read=0.5, output=25)}


def test_analytics_total_matches_usage_map(monkeypatch) -> None:
    conn = _conn()
    _seed(conn)
    _add(conn, 1, 1)
    _add(conn, 2, 1, agent_id="a1")
    monkeypatch.setattr("ccfr.analysis.usage_characteristics.load_price_table", lambda _p: PRICE)
    monkeypatch.setattr("ccfr.analysis.usage_map.load_price_table", lambda _p: PRICE)

    chars_total = usage_characteristics_analytics(conn)["meta"]["total_usd"]
    map_total = um.usage_map_analytics(conn)["meta"]["total_usd"]
    assert chars_total == map_total


def test_analytics_token_basis_when_no_pricing(monkeypatch) -> None:
    conn = _conn()
    _seed(conn)
    _add(conn, 1, 1)
    monkeypatch.setattr("ccfr.analysis.usage_characteristics.load_price_table", lambda _p: {})
    payload = usage_characteristics_analytics(conn)
    assert payload["meta"]["share_basis"] == "tokens"
    assert payload["meta"]["cost_available"] is False


def test_analytics_reads_agent_type_from_subagents(monkeypatch) -> None:
    conn = _conn()
    _seed(conn)
    _add(conn, 1, 1, agent_id="a1")
    conn.execute("INSERT INTO subagents (parent_session_id, agent_id, agent_type) "
                 "VALUES (1, 'a1', 'general-purpose')")
    conn.commit()
    monkeypatch.setattr("ccfr.analysis.usage_characteristics.load_price_table", lambda _p: PRICE)
    keys = [c["key"] for c in usage_characteristics_analytics(conn)["characteristics"]]
    assert "agent_type:general-purpose" in keys


def test_endpoint_returns_characteristics(monkeypatch) -> None:
    conn = _conn()
    _seed(conn)
    _add(conn, 1, 1)
    _add(conn, 2, 1, agent_id="a1")
    monkeypatch.setattr("ccfr.analysis.usage_characteristics.load_price_table", lambda _p: PRICE)
    app = create_app()
    app.dependency_overrides[get_db] = lambda: conn
    client = TestClient(app)
    resp = client.get("/api/analytics/usage-characteristics")
    assert resp.status_code == 200
    body = resp.json()
    assert "characteristics" in body
    assert body["meta"]["basis_note"]
    keys = [c["key"] for c in body["characteristics"]]
    assert "subagent_sessions" in keys
