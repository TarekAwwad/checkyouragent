from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from ccfr.analysis.limits import (
    LimitHit,
    UsageEvent,
    classify_hit_text,
    detect_limit_hits,
    fold_windows,
    limits_analytics,
    parse_reset_at,
)
from ccfr.storage import init_db


def _utc(text: str) -> datetime:
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------

def test_classify_session_weekly_org_unknown() -> None:
    assert classify_hit_text(
        "You've hit your session limit · resets 12:30pm (Europe/Paris)") == "session"
    assert classify_hit_text("You've hit your weekly limit · resets Tuesday") == "weekly"
    assert classify_hit_text("Your org has hit its monthly usage limit") == "org"
    assert classify_hit_text("Something rate-limited happened") == "unknown"
    assert classify_hit_text("") == "unknown"


# ---------------------------------------------------------------------------
# Reset-stamp parsing
# ---------------------------------------------------------------------------

def test_parse_reset_same_day() -> None:
    # Hit at 09:40:44 UTC = 11:40 in Paris (July, UTC+2). Reset 12:30pm Paris = 10:30 UTC.
    hit = _utc("2026-07-03T09:40:44Z")
    reset = parse_reset_at(
        "You've hit your session limit · resets 12:30pm (Europe/Paris)", hit)
    assert reset == _utc("2026-07-03T10:30:00Z")


def test_parse_reset_rolls_to_next_day() -> None:
    # Hit at 22:00 UTC = 00:00 Paris next day; "resets 2am" is 2h later, not 22h earlier.
    hit = _utc("2026-07-03T22:00:00Z")
    reset = parse_reset_at("You've hit your session limit · resets 2am (Europe/Paris)", hit)
    assert reset == _utc("2026-07-04T00:00:00Z")


def test_parse_reset_hour_only_and_capitalized() -> None:
    hit = _utc("2026-05-20T14:00:00Z")
    reset = parse_reset_at("You've hit your session limit. Resets 5pm (UTC)", hit)
    assert reset == _utc("2026-05-20T17:00:00Z")


def test_parse_reset_without_timezone_returns_none() -> None:
    hit = _utc("2026-05-20T14:00:00Z")
    assert parse_reset_at("You've hit your session limit — resets 5pm", hit) is None


def test_parse_reset_unknown_timezone_or_garbage_returns_none() -> None:
    hit = _utc("2026-05-20T14:00:00Z")
    assert parse_reset_at("resets 5pm (Middle/Nowhere)", hit) is None
    assert parse_reset_at("You've hit your session limit", hit) is None
    assert parse_reset_at("", hit) is None


def test_parse_reset_out_of_range_minute_returns_none() -> None:
    # The minute group is \d{2}, so a garbled stamp can carry 60-99. It must
    # read as unparsed, not raise out of the analytics endpoint.
    hit = _utc("2026-05-20T14:00:00Z")
    assert parse_reset_at("resets 5:99pm (UTC)", hit) is None
    assert parse_reset_at("resets 5:60pm (UTC)", hit) is None
    assert parse_reset_at("resets 5:59pm (UTC)", hit) == _utc("2026-05-20T17:59:00Z")


def _make_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    init_db(conn)
    import_id = conn.execute(
        "INSERT INTO imports (source_path, imported_at, file_count, status, error_count)"
        " VALUES ('fx', '2026-01-01T00:00:00Z', 0, 'complete', 0)"
    ).lastrowid
    project = conn.execute(
        "INSERT INTO projects (import_id, export_name, inferred_cwd) VALUES (?, 'alpha', NULL)",
        (import_id,),
    ).lastrowid
    conn.execute(
        "INSERT INTO sessions (project_id, session_id, title, first_ts, last_ts)"
        " VALUES (?, 's1', 'Session One', '2026-07-03T00:00:00Z', '2026-07-03T12:00:00Z')",
        (project,),
    )
    return conn


HIT_TEXT = "You've hit your session limit · resets 12:30pm (Europe/Paris)"


def _add_limit_hit(conn: sqlite3.Connection, session_id: int, ts: str,
                   text: str = HIT_TEXT, *, error: str | None = "rate_limit",
                   extra: dict | None = None, source_path: str = "f.jsonl") -> int:
    raw: dict = {"isApiErrorMessage": True,
                 "message": {"model": "<synthetic>",
                             "content": [{"type": "text", "text": text}]}}
    if error is not None:
        raw["error"] = error
        raw["apiErrorStatus"] = 429
    raw.update(extra or {})
    ev = conn.execute(
        "INSERT INTO events (session_id, source_path, line_no, type, timestamp, raw_json)"
        " VALUES (?, ?, 1, 'assistant', ?, ?)",
        (session_id, source_path, ts, json.dumps(raw)),
    ).lastrowid
    conn.execute(
        "INSERT INTO messages (event_id, role, model, text_preview)"
        " VALUES (?, 'assistant', '<synthetic>', ?)",
        (ev, text),
    )
    return int(ev)


# ---------------------------------------------------------------------------
# Detection and dedup
# ---------------------------------------------------------------------------

def test_detect_merges_same_reset_stamp_and_keeps_earliest_ts() -> None:
    conn = _make_conn()
    _add_limit_hit(conn, 1, "2026-07-03T09:40:44Z")
    _add_limit_hit(conn, 1, "2026-07-03T09:52:00Z")  # retry against the same cap
    hits = detect_limit_hits(conn)
    assert len(hits) == 1
    assert hits[0].kind == "session"
    assert hits[0].occurrence_count == 2
    assert hits[0].ts == _utc("2026-07-03T09:40:44Z")
    assert hits[0].reset_at == _utc("2026-07-03T10:30:00Z")
    assert hits[0].minutes_until_reset is not None
    assert round(hits[0].minutes_until_reset, 1) == 49.3
    assert hits[0].session_ids == [1]
    assert hits[0].session_titles == ["Session One"]


def test_detect_limit_hits_instant_window() -> None:
    conn = _make_conn()
    _add_limit_hit(conn, 1, "2026-11-23T22:30:00Z",
                   "You've hit your session limit · resets 1am (Europe/Paris)")
    _add_limit_hit(conn, 1, "2026-11-23T23:30:00Z",
                   "You've hit your session limit · resets 4am (Europe/Paris)")
    _add_limit_hit(conn, 1, "2026-11-24T23:30:00Z",
                   "You've hit your session limit · resets 5am (Europe/Paris)")
    hits = detect_limit_hits(conn, date_from="2026-11-23T23:00:00.000Z",
                             date_to="2026-11-24T22:59:59.999Z")
    assert [hit.ts for hit in hits] == [_utc("2026-11-23T23:30:00Z")]


# Claude Code's newer limit message, logged with structured quota fields.
FIVE_HOUR_TEXT = "You've hit your 5-hour limit · resets 2:50pm (Europe/Paris)"
FIVE_HOUR_HIT_TS = "2026-11-24T13:30:20.855Z"  # 14:30 in Paris (November, UTC+1)
FIVE_HOUR_RESETS_AT = 1795528200  # 2026-11-24T13:50:00Z = 2:50pm Paris


def _quota_fields(resets_at: object = FIVE_HOUR_RESETS_AT,
                  limit_type: object = "five_hour") -> dict:
    """The structured fields as Claude Code logs them on a usage-limit 429."""
    return {
        "apiError": "usage_limit_reached",
        "apiErrorParams": {"rate_limit_info": {
            "status": "rejected", "resetsAt": resets_at, "rateLimitType": limit_type,
            "overageStatus": "rejected", "isUsingOverage": False,
        }},
        "quotaLimits": {
            "status": "rejected", "resetsAt": resets_at, "rateLimitType": limit_type,
            "isUsingOverage": False,
        },
    }


def test_classify_five_hour_text_as_session() -> None:
    assert classify_hit_text(FIVE_HOUR_TEXT) == "session"
    assert classify_hit_text("You've hit your five-hour limit") == "session"
    assert classify_hit_text("You've hit your 5 hour limit") == "session"
    assert classify_hit_text("You've hit your 5-hour usage limit") == "session"


def test_detect_five_hour_hit_from_structured_fields() -> None:
    conn = _make_conn()
    _add_limit_hit(conn, 1, FIVE_HOUR_HIT_TS, FIVE_HOUR_TEXT, extra=_quota_fields())
    hits = detect_limit_hits(conn)
    assert len(hits) == 1
    assert hits[0].kind == "session"
    assert hits[0].reset_at == _utc("2026-11-24T13:50:00Z")
    assert round(hits[0].minutes_until_reset, 1) == 19.7


def test_detect_five_hour_text_without_structured_fields() -> None:
    conn = _make_conn()
    _add_limit_hit(conn, 1, FIVE_HOUR_HIT_TS, FIVE_HOUR_TEXT)
    hits = detect_limit_hits(conn)
    assert len(hits) == 1
    assert hits[0].kind == "session"
    assert hits[0].reset_at == _utc("2026-11-24T13:50:00Z")


def test_structured_limit_type_wins_and_unknown_types_fall_back_to_text() -> None:
    conn = _make_conn()
    vague = "You've hit your limit"  # no cap named in the text
    _add_limit_hit(conn, 1, "2026-11-20T08:00:00Z", vague, extra=_quota_fields(
        resets_at=1795600000, limit_type="seven_day"))
    _add_limit_hit(conn, 1, "2026-11-21T08:00:00Z", vague, extra=_quota_fields(
        resets_at=1795700000, limit_type="seven_day_opus"))
    _add_limit_hit(conn, 1, "2026-11-22T08:00:00Z", vague, extra=_quota_fields(
        resets_at=1795800000, limit_type="weekly"))
    # A type this code does not know defers to the text, then to "unknown".
    _add_limit_hit(conn, 1, "2026-11-23T08:00:00Z", "You've hit your session limit",
                   extra=_quota_fields(resets_at=1795900000, limit_type="new_cap"))
    _add_limit_hit(conn, 1, "2026-11-23T20:00:00Z", vague,
                   extra=_quota_fields(resets_at=1796000000, limit_type="new_cap"))
    kinds = [hit.kind for hit in detect_limit_hits(conn)]
    assert kinds == ["weekly", "weekly", "weekly", "session", "unknown"]


def test_structured_reset_takes_precedence_over_the_text_stamp() -> None:
    conn = _make_conn()
    # The text rounds to "2:50pm"; resetsAt carries the exact instant.
    _add_limit_hit(conn, 1, FIVE_HOUR_HIT_TS, FIVE_HOUR_TEXT,
                   extra=_quota_fields(resets_at=FIVE_HOUR_RESETS_AT + 25))
    # Without a zone the text stamp is unparseable; resetsAt still gives one.
    _add_limit_hit(conn, 1, "2026-11-25T09:00:00Z", "You've hit your 5-hour limit · resets 1pm",
                   extra=_quota_fields(resets_at=1795611600))  # 2026-11-25T13:00:00Z
    # A garbled resetsAt is ignored, and the text stamp is used instead.
    _add_limit_hit(conn, 1, "2026-11-26T13:30:00Z", FIVE_HOUR_TEXT,
                   extra=_quota_fields(resets_at="soon"))
    hits = detect_limit_hits(conn)
    assert [hit.reset_at for hit in hits] == [
        _utc("2026-11-24T13:50:25Z"),
        _utc("2026-11-25T13:00:00Z"),
        _utc("2026-11-26T13:50:00Z"),
    ]


def test_main_and_subagent_records_of_one_hit_dedupe() -> None:
    conn = _make_conn()
    # The same 429 logged by the main session and by its subagent, 0.6s apart.
    _add_limit_hit(conn, 1, "2026-11-24T13:30:20.855Z", FIVE_HOUR_TEXT,
                   extra=_quota_fields(), source_path="s1.jsonl")
    _add_limit_hit(conn, 1, "2026-11-24T13:30:20.215Z", FIVE_HOUR_TEXT,
                   extra=_quota_fields(), source_path="s1/subagents/agent-a.jsonl")
    hits = detect_limit_hits(conn)
    assert len(hits) == 1
    assert hits[0].occurrence_count == 2
    assert hits[0].ts == _utc("2026-11-24T13:30:20.215Z")
    assert hits[0].session_ids == [1]


def test_structured_and_text_only_records_of_one_hit_dedupe() -> None:
    conn = _make_conn()
    # An older text-only record and a structured one for the same cap share a
    # key, even when resetsAt carries seconds the minute-rounded text drops.
    _add_limit_hit(conn, 1, "2026-11-24T13:30:00Z", FIVE_HOUR_TEXT)
    _add_limit_hit(conn, 1, "2026-11-24T13:31:00Z", FIVE_HOUR_TEXT,
                   extra=_quota_fields(resets_at=FIVE_HOUR_RESETS_AT + 25))
    hits = detect_limit_hits(conn)
    assert len(hits) == 1
    assert hits[0].occurrence_count == 2


def test_detect_ignores_synthetic_rows_without_rate_limit_marker() -> None:
    conn = _make_conn()
    _add_limit_hit(conn, 1, "2026-07-03T09:40:44Z", "Some other synthetic notice",
                   error=None)
    assert detect_limit_hits(conn) == []


def test_detect_unparseable_reset_buckets_by_time() -> None:
    conn = _make_conn()
    text = "You've hit your session limit — resets 5pm"  # no timezone: unparseable
    _add_limit_hit(conn, 1, "2026-07-03T09:40:00Z", text)
    _add_limit_hit(conn, 1, "2026-07-03T09:42:00Z", text)  # same 5-minute bucket
    _add_limit_hit(conn, 1, "2026-07-03T11:00:00Z", text)  # separate hit
    hits = detect_limit_hits(conn)
    assert len(hits) == 2
    assert hits[0].reset_at is None
    assert hits[0].minutes_until_reset is None


def test_minutes_until_reset_is_recorded_delta_not_observed_wait_time() -> None:
    hit = LimitHit(
        ts=_utc("2026-07-03T09:40:44Z"),
        kind="session",
        reset_at=_utc("2026-07-03T10:30:00Z"),
    )
    invalid = LimitHit(
        ts=_utc("2026-07-03T09:40:44Z"),
        kind="session",
        reset_at=_utc("2026-07-03T09:30:00Z"),
    )

    assert hit.minutes_until_reset == pytest.approx(49.2666667)
    assert invalid.minutes_until_reset is None


# ---------------------------------------------------------------------------
# Window folding
# ---------------------------------------------------------------------------

def _events(*specs: tuple[str, float]) -> list[UsageEvent]:
    return [UsageEvent(ts=_utc(ts), cost=cost, tokens=int(cost * 1000))
            for ts, cost in specs]


def test_fold_windows_groups_by_five_hours() -> None:
    events = _events(
        ("2026-07-03T08:00:00Z", 1.0),
        ("2026-07-03T09:00:00Z", 2.0),   # same window (starts 08:00, ends 13:00)
        ("2026-07-03T14:00:00Z", 4.0),   # next window
    )
    windows = fold_windows(events, [])
    assert len(windows) == 2
    assert windows[0].start == _utc("2026-07-03T08:00:00Z")
    assert windows[0].end == _utc("2026-07-03T13:00:00Z")
    assert windows[0].value_usd == 3.0
    assert windows[1].value_usd == 4.0


def test_fold_windows_attaches_hit_and_measures_usage_at_hit() -> None:
    events = _events(
        ("2026-07-03T08:00:00Z", 1.0),
        ("2026-07-03T09:00:00Z", 2.0),
        ("2026-07-03T09:40:44Z", 0.0),   # the synthetic hit row itself (zero cost)
        ("2026-07-03T12:00:00Z", 8.0),   # after the snapped reset: a NEW window
    )
    hit = LimitHit(ts=_utc("2026-07-03T09:40:44Z"), kind="session",
                   reset_at=_utc("2026-07-03T10:30:00Z"))
    windows = fold_windows(events, [hit])
    # The hit snaps window 0's end to the reset stamp, so the 12:00 event opens window 1.
    assert len(windows) == 2
    assert windows[0].end == _utc("2026-07-03T10:30:00Z")
    assert windows[0].hit_kinds == ["session"]
    assert hit.window_index == 0
    assert hit.usage_at_hit == 3.0
    assert hit.usage_at_hit_tokens == 3000
    assert windows[1].start == _utc("2026-07-03T12:00:00Z")


def test_fold_windows_never_snaps_weekly_hits() -> None:
    events = _events(
        ("2026-07-03T08:00:00Z", 1.0),
        ("2026-07-03T08:30:00Z", 0.0),
    )
    hit = LimitHit(ts=_utc("2026-07-03T08:30:00Z"), kind="weekly",
                   reset_at=_utc("2026-07-06T09:00:00Z"))  # days away
    windows = fold_windows(events, [hit])
    assert windows[0].end == _utc("2026-07-03T13:00:00Z")  # untouched
    assert hit.window_index == 0


def test_fold_windows_ignores_out_of_tolerance_reset() -> None:
    events = _events(
        ("2026-07-03T08:00:00Z", 1.0),
        ("2026-07-03T08:10:00Z", 0.0),
    )
    # A "session" stamp 7h out is inconsistent with a 5h window: keep the inferred end.
    hit = LimitHit(ts=_utc("2026-07-03T08:10:00Z"), kind="session",
                   reset_at=_utc("2026-07-03T15:00:00Z"))
    windows = fold_windows(events, [hit])
    assert windows[0].end == _utc("2026-07-03T13:00:00Z")


def test_fold_windows_attaches_deferred_hit_without_matching_event() -> None:
    # The hit has no event row of its own; a later event must not steal it.
    events = _events(
        ("2026-07-03T08:00:00Z", 1.0),
        ("2026-07-03T20:00:00Z", 4.0),
    )
    hit = LimitHit(ts=_utc("2026-07-03T10:00:00Z"), kind="session",
                   reset_at=_utc("2026-07-03T10:30:00Z"))
    windows = fold_windows(events, [hit])
    assert len(windows) == 2
    assert hit.window_index == 0
    assert hit.usage_at_hit == 1.0
    assert windows[0].end == _utc("2026-07-03T10:30:00Z")
    assert windows[0].hit_kinds == ["session"]


def test_fold_windows_hit_in_activity_gap_opens_its_own_window() -> None:
    events = _events(("2026-07-03T08:00:00Z", 1.0))
    hit = LimitHit(ts=_utc("2026-07-03T14:00:00Z"), kind="session", reset_at=None)
    windows = fold_windows(events, [hit])
    assert len(windows) == 2
    assert hit.window_index == 1
    assert hit.usage_at_hit == 0.0


# ---------------------------------------------------------------------------
# limits_analytics composition
# ---------------------------------------------------------------------------

def _add_usage(conn: sqlite3.Connection, session_id: int, ts: str, base: int,
               model: str = "claude-opus-4-8") -> int:
    ev = conn.execute(
        "INSERT INTO events (session_id, source_path, line_no, type, timestamp, raw_json)"
        " VALUES (?, 'f.jsonl', 1, 'assistant', ?, '{}')",
        (session_id, ts),
    ).lastrowid
    conn.execute(
        "INSERT INTO messages (event_id, role, model, input_tokens, output_tokens,"
        " base_input_tokens, cache_5m_tokens, cache_1h_tokens, cache_read_tokens)"
        " VALUES (?, 'assistant', ?, ?, 0, ?, 0, 0, 0)",
        (ev, model, base, base),
    )
    return int(ev)


@pytest.fixture()
def priced(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    csv = tmp_path / "pricing.csv"
    # $10 and $1 per million base-input tokens respectively.
    csv.write_text(
        "model,base-input-tokens,5m-cache-writes,1h-cache-writes,"
        "cache-hits-&-refreshes,output-tokens\n"
        "claude-opus-4-8,10,0,0,0,0\n"
        "claude-haiku-4-5,1,0,0,0,0\n",
        encoding="utf-8",
    )
    import ccfr.analysis.limits as limits_mod
    monkeypatch.setattr(limits_mod, "pricing_path", lambda: csv)
    monkeypatch.setattr(limits_mod, "pricing_dir", lambda: tmp_path / "no-sheets")


LIMIT_ERA_KEYS = {
    "era",
    "window_count",
    "session_hit_count",
    "minutes_until_reset",
    "hit_level_median_usd",
    "hit_level_min_usd",
    "hit_level_max_usd",
    "hit_level_median_tokens",
    "hit_level_min_tokens",
    "hit_level_max_tokens",
    "hit_level_percentile",
    "hit_level_percentile_tokens",
    "usage_at_hit_usd",
    "usage_at_hit_tokens",
    "start_date",
    "end_date",
    "weeks",
    "hits_per_week",
}


def test_limits_analytics_full_payload(priced: None) -> None:
    conn = _make_conn()
    # Window 1 (May 20, Pro era): $10 usage then a session hit.
    _add_usage(conn, 1, "2026-05-20T08:00:00Z", 1_000_000)
    _add_limit_hit(conn, 1, "2026-05-20T09:00:00Z",
                   "You've hit your session limit · resets 1pm (UTC)")
    # Window 2 (July 3, Max era): $30 usage then a session hit.
    _add_usage(conn, 1, "2026-07-03T08:00:00Z", 3_000_000)
    _add_limit_hit(conn, 1, "2026-07-03T09:40:00Z")
    # Window 3 (July 4, Max era): $25 quiet usage.
    _add_usage(conn, 1, "2026-07-04T08:00:00Z", 2_500_000)

    payload = limits_analytics(conn, plan_history=[
        {"plan": "Pro", "start_date": "2026-05-01"},
        {"plan": "Max 5x", "start_date": "2026-06-10"},
    ])

    assert payload["meta"]["total_hits"] == 2
    assert payload["meta"]["hit_counts"] == {"session": 2}
    assert payload["meta"]["total_windows"] == 3
    assert payload["meta"]["cost_available"] is True
    assert "method_note" not in payload["meta"]
    assert "blocked_minutes" not in payload["meta"]
    assert "minutes_until_reset" in payload["meta"]

    eras = {era["era"]: era for era in payload["eras"]}
    assert set(eras) == {"Pro", "Max 5x"}
    assert set(eras["Max 5x"]) == LIMIT_ERA_KEYS
    assert eras["Pro"]["session_hit_count"] == 1
    assert eras["Pro"]["hit_level_median_usd"] == 10.0
    assert eras["Pro"]["hit_level_median_tokens"] == 1_000_000
    assert eras["Max 5x"]["hit_level_median_usd"] == 30.0
    assert eras["Max 5x"]["hit_level_median_tokens"] == 3_000_000
    assert eras["Max 5x"]["hit_level_percentile_tokens"] == 1.0
    assert eras["Max 5x"]["window_count"] == 2

    assert [w["era"] for w in payload["windows"]] == ["Pro", "Max 5x", "Max 5x"]
    assert payload["windows"][0]["hit_kinds"] == ["session"]
    assert payload["hits"][0]["kind"] == "session"
    assert payload["hits"][0]["usage_at_hit"] == 10.0
    assert payload["hits"][0]["usage_at_hit_tokens"] == 1_000_000
    assert payload["hits"][0]["session_ids"] == [1]


def test_five_hour_hit_folds_into_a_window_with_usage(priced: None) -> None:
    conn = _make_conn()
    _add_usage(conn, 1, "2026-11-24T09:00:00Z", 2_000_000)  # $20, opens the window
    _add_usage(conn, 1, "2026-11-24T12:00:00Z", 1_000_000)  # $10
    _add_limit_hit(conn, 1, "2026-11-24T13:30:20.855Z", FIVE_HOUR_TEXT,
                   extra=_quota_fields(), source_path="s1.jsonl")
    _add_limit_hit(conn, 1, "2026-11-24T13:30:20.215Z", FIVE_HOUR_TEXT,
                   extra=_quota_fields(), source_path="s1/subagents/agent-a.jsonl")
    _add_usage(conn, 1, "2026-11-24T14:00:00Z", 500_000)  # after the reset: next window

    payload = limits_analytics(conn)

    assert payload["meta"]["hit_counts"] == {"session": 1}
    assert payload["meta"]["total_windows"] == 2
    hit = payload["hits"][0]
    assert hit["kind"] == "session"
    assert hit["window_index"] == 0
    assert hit["usage_at_hit"] == 30.0
    assert hit["usage_at_hit_tokens"] == 3_000_000
    assert hit["reset_at"] == "2026-11-24T13:50:00+00:00"
    window = payload["windows"][0]
    assert window["hit_kinds"] == ["session"]
    assert window["end"] == "2026-11-24T13:50:00+00:00"  # snapped to resetsAt
    assert payload["eras"][0]["session_hit_count"] == 1


def test_cost_and_token_percentiles_are_computed_independently(priced: None) -> None:
    conn = _make_conn()
    # The hit window has fewer, more expensive tokens; the quiet window has
    # more, cheaper tokens. Their rank therefore reverses between the lenses.
    _add_usage(conn, 1, "2026-07-03T08:00:00Z", 1_000_000)
    _add_limit_hit(conn, 1, "2026-07-03T09:40:00Z")
    _add_usage(
        conn, 1, "2026-07-04T08:00:00Z", 2_000_000,
        model="claude-haiku-4-5",
    )

    era = limits_analytics(conn)["eras"][0]

    assert era["hit_level_percentile"] == 1.0
    assert era["hit_level_percentile_tokens"] == 0.5


def test_non_session_hits_remain_receipts_but_do_not_change_window_statistics(
    priced: None,
) -> None:
    conn = _make_conn()
    _add_usage(conn, 1, "2026-07-03T08:00:00Z", 1_000_000)
    _add_limit_hit(conn, 1, "2026-07-03T09:00:00Z",
                   "You've hit your session limit · resets 1pm (UTC)")
    _add_limit_hit(conn, 1, "2026-07-03T20:00:00Z",
                   "You've hit your weekly limit · resets 9pm (UTC)")
    _add_limit_hit(conn, 1, "2026-07-04T02:00:00Z",
                   "Your org has hit its monthly usage limit · resets 3am (UTC)")
    _add_usage(conn, 1, "2026-07-04T08:00:00Z", 2_000_000)
    _add_limit_hit(conn, 1, "2026-07-04T09:00:00Z",
                   "You've hit your session limit · resets 1pm (UTC)")
    _add_limit_hit(conn, 1, "2026-07-04T20:00:00Z",
                   "Something rate-limited happened · resets 9pm (UTC)")

    payload = limits_analytics(conn)
    era = payload["eras"][0]

    assert payload["meta"]["total_hits"] == 5
    assert payload["meta"]["hit_counts"] == {
        "session": 2,
        "weekly": 1,
        "org": 1,
        "unknown": 1,
    }
    assert [hit["kind"] for hit in payload["hits"]] == [
        "session", "weekly", "org", "session", "unknown",
    ]
    assert payload["meta"]["total_windows"] == 2
    assert era["window_count"] == 2
    assert era["session_hit_count"] == 2
    assert era["usage_at_hit_usd"] == [10.0, 20.0]
    assert era["hit_level_median_usd"] == 15.0
    assert era["hit_level_percentile"] == 0.5
    non_session = [hit for hit in payload["hits"] if hit["kind"] != "session"]
    assert all(hit["window_index"] is None for hit in non_session)
    assert all(hit["usage_at_hit"] is None for hit in non_session)


def test_limits_analytics_without_plan_history_or_hits(priced: None) -> None:
    conn = _make_conn()
    _add_usage(conn, 1, "2026-05-20T08:00:00Z", 1_000_000)
    payload = limits_analytics(conn)
    assert payload["meta"]["total_hits"] == 0
    assert payload["meta"]["total_windows"] == 1
    assert payload["eras"] == [
        {
            "era": "", "window_count": 1, "session_hit_count": 0,
            "minutes_until_reset": 0.0,
            "hit_level_median_usd": None, "hit_level_min_usd": None,
            "hit_level_max_usd": None, "hit_level_median_tokens": None,
            "hit_level_min_tokens": None, "hit_level_max_tokens": None,
            "hit_level_percentile": None, "hit_level_percentile_tokens": None,
            "usage_at_hit_usd": [], "usage_at_hit_tokens": [],
            "start_date": None, "end_date": None,
            "weeks": 1.0, "hits_per_week": 0.0,
        }
    ]
    assert payload["windows"][0]["era_index"] == 0


def test_limits_analytics_zero_usage_hit_level_stays_defined(priced: None) -> None:
    conn = _make_conn()
    # A hit as the first logged call of its window: measured usage-at-hit is
    # $0 (the real usage lived outside these logs). The zone is still
    # reported, but a percentile is meaningless against a $0 hit level.
    _add_limit_hit(conn, 1, "2026-07-03T09:40:00Z")
    payload = limits_analytics(conn)
    era = payload["eras"][0]
    assert era["session_hit_count"] == 1
    assert era["hit_level_median_usd"] == 0.0
    assert era["hit_level_median_tokens"] == 0
    assert era["usage_at_hit_usd"] == [0.0]
    assert era["usage_at_hit_tokens"] == [0]
    assert era["hit_level_percentile"] is None
    assert era["hit_level_percentile_tokens"] is None
    assert payload["meta"]["hits_per_week_recent"] == 0.25


def _hit_window(conn: sqlite3.Connection, day: str, base: int = 1_000_000) -> None:
    """One window on `day`: usage at 08:00, then a session hit at 09:00."""
    _add_usage(conn, 1, f"{day}T08:00:00Z", base)
    _add_limit_hit(conn, 1, f"{day}T09:00:00Z",
                   "You've hit your session limit · resets 1pm (UTC)")


def test_repeated_plan_splits_into_separate_periods(priced: None) -> None:
    # Pro -> Max -> Pro: the two Pro stints are different periods, each with
    # its own hits and hit levels, not one pooled "Pro" era.
    conn = _make_conn()
    _add_usage(conn, 1, "2026-04-20T08:00:00Z", 500_000)  # before any plan entry
    _hit_window(conn, "2026-05-05", 1_000_000)  # first Pro: $10
    _hit_window(conn, "2026-06-05", 4_000_000)  # Max: $40
    _hit_window(conn, "2026-07-05", 2_000_000)  # second Pro: $20
    _hit_window(conn, "2026-07-06", 3_000_000)  # second Pro: $30

    payload = limits_analytics(conn, plan_history=[
        {"plan": "Pro", "start_date": "2026-05-01"},
        {"plan": "Max 5x", "start_date": "2026-06-01"},
        {"plan": "Pro", "start_date": "2026-07-01"},
    ])

    eras = payload["eras"]
    assert [e["era"] for e in eras] == ["", "Pro", "Max 5x", "Pro"]
    assert [(e["start_date"], e["end_date"]) for e in eras] == [
        (None, "2026-05-01"),
        ("2026-05-01", "2026-06-01"),
        ("2026-06-01", "2026-07-01"),
        ("2026-07-01", None),
    ]
    assert [e["session_hit_count"] for e in eras] == [0, 1, 1, 2]
    assert eras[1]["usage_at_hit_usd"] == [10.0]
    assert eras[3]["usage_at_hit_usd"] == [20.0, 30.0]
    assert eras[3]["hit_level_median_usd"] == 25.0
    assert [w["era_index"] for w in payload["windows"]] == [0, 1, 2, 3, 3]
    assert [w["era"] for w in payload["windows"]] == ["", "Pro", "Max 5x", "Pro", "Pro"]


def test_period_hit_rate_uses_its_own_tenure(priced: None) -> None:
    # Hits per week divide by the period's own calendar span: from its plan
    # start (or the first logged window, if later) to the next plan's start
    # (or the end of the logs). The Max stint in between never counts toward
    # either Pro period.
    conn = _make_conn()
    _add_usage(conn, 1, "2026-05-01T00:00:00Z", 1_000)  # logs start, after Pro began
    _hit_window(conn, "2026-05-01")
    _hit_window(conn, "2026-05-10")
    _add_usage(conn, 1, "2026-06-15T08:00:00Z", 1_000_000)  # quiet Max window
    _hit_window(conn, "2026-07-30")
    _hit_window(conn, "2026-08-10")
    _add_usage(conn, 1, "2026-08-20T19:00:00Z", 1_000)  # logs end 08-21 00:00

    payload = limits_analytics(conn, plan_history=[
        {"plan": "Pro", "start_date": "2026-03-01"},
        {"plan": "Max 5x", "start_date": "2026-05-29"},
        {"plan": "Pro", "start_date": "2026-07-24"},
    ])

    rates = [(e["era"], e["weeks"], e["hits_per_week"]) for e in payload["eras"]]
    assert rates == [
        ("Pro", 4.0, 0.5),     # 05-01 (first log) to 05-29
        ("Max 5x", 8.0, 0.0),  # 05-29 to 07-24
        ("Pro", 4.0, 0.5),     # 07-24 to 08-21 (end of logs)
    ]


def test_short_period_rate_floors_tenure_at_one_week(priced: None) -> None:
    conn = _make_conn()
    _hit_window(conn, "2026-07-01")
    _hit_window(conn, "2026-07-02")
    payload = limits_analytics(conn, plan_history=[
        {"plan": "Pro", "start_date": "2026-07-01"},
    ])
    era = payload["eras"][0]
    assert era["weeks"] == 1.0
    assert era["hits_per_week"] == 2.0


def test_window_hit_after_plan_switch_belongs_to_the_plan_in_force(priced: None) -> None:
    # The window opens on Pro (May 31, 23:30 UTC) but its session hit lands
    # after Max began (June 1, 01:00 UTC): the cap that was hit is Max's. The
    # whole window moves with its hit, so band, hit and percentile agree.
    conn = _make_conn()
    _add_usage(conn, 1, "2026-05-20T08:00:00Z", 1_000_000)  # an earlier Pro window
    _add_usage(conn, 1, "2026-05-31T23:30:00Z", 2_000_000)
    _add_limit_hit(conn, 1, "2026-06-01T01:00:00Z",
                   "You've hit your session limit · resets 4am (UTC)")

    payload = limits_analytics(conn, plan_history=[
        {"plan": "Pro", "start_date": "2026-05-01"},
        {"plan": "Max 5x", "start_date": "2026-06-01"},
    ])

    assert [w["era"] for w in payload["windows"]] == ["Pro", "Max 5x"]
    assert [(e["era"], e["session_hit_count"]) for e in payload["eras"]] == [
        ("Pro", 0), ("Max 5x", 1),
    ]
    assert payload["eras"][1]["usage_at_hit_usd"] == [20.0]


def test_plan_lookup_reads_timestamps_in_utc(priced: None) -> None:
    # 01:00 +02:00 on June 1 is 23:00 UTC on May 31: still Pro, the same day
    # the tenure arithmetic uses.
    conn = _make_conn()
    _add_usage(conn, 1, "2026-06-01T01:00:00+02:00", 1_000_000)
    payload = limits_analytics(conn, plan_history=[
        {"plan": "Pro", "start_date": "2026-05-01"},
        {"plan": "Max 5x", "start_date": "2026-06-01"},
    ])
    assert [w["era"] for w in payload["windows"]] == ["Pro"]


def test_observed_span_includes_hits_outside_windows(priced: None) -> None:
    # A weekly-limit hit with no usage after it still proves the logs cover
    # that time: the session-hit rate divides by June 1 -> June 29, not by
    # the single window.
    conn = _make_conn()
    _hit_window(conn, "2026-06-01")
    _add_limit_hit(conn, 1, "2026-06-29T09:00:00Z",
                   "You've hit your weekly limit · resets 9pm (UTC)")
    era = limits_analytics(conn)["eras"][0]
    assert era["weeks"] == 4.01  # June 1 08:00 -> June 29 09:00
    assert era["hits_per_week"] == 0.25
