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
                   text: str = HIT_TEXT, *, error: str | None = "rate_limit") -> int:
    raw: dict = {"isApiErrorMessage": True,
                 "message": {"model": "<synthetic>",
                             "content": [{"type": "text", "text": text}]}}
    if error is not None:
        raw["error"] = error
        raw["apiErrorStatus"] = 429
    ev = conn.execute(
        "INSERT INTO events (session_id, source_path, line_no, type, timestamp, raw_json)"
        " VALUES (?, 'f.jsonl', 1, 'assistant', ?, ?)",
        (session_id, ts, json.dumps(raw)),
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
    assert hits[0].blocked_minutes is not None
    assert round(hits[0].blocked_minutes, 1) == 49.3
    assert hits[0].session_ids == [1]
    assert hits[0].session_titles == ["Session One"]


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
    assert hits[0].blocked_minutes is None


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

def _add_usage(conn: sqlite3.Connection, session_id: int, ts: str, base: int) -> int:
    ev = conn.execute(
        "INSERT INTO events (session_id, source_path, line_no, type, timestamp, raw_json)"
        " VALUES (?, 'f.jsonl', 1, 'assistant', ?, '{}')",
        (session_id, ts),
    ).lastrowid
    conn.execute(
        "INSERT INTO messages (event_id, role, model, input_tokens, output_tokens,"
        " base_input_tokens, cache_5m_tokens, cache_1h_tokens, cache_read_tokens)"
        " VALUES (?, 'assistant', 'claude-opus-4-8', ?, 0, ?, 0, 0, 0)",
        (ev, base, base),
    )
    return int(ev)


@pytest.fixture()
def priced(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    csv = tmp_path / "pricing.csv"
    # $10 per million base-input tokens: 1M tokens = $10.
    csv.write_text(
        "model,base-input-tokens,5m-cache-writes,1h-cache-writes,"
        "cache-hits-&-refreshes,output-tokens\n"
        "claude-opus-4-8,10,0,0,0,0\n",
        encoding="utf-8",
    )
    import ccfr.analysis.limits as limits_mod
    monkeypatch.setattr(limits_mod, "pricing_path", lambda: csv)
    monkeypatch.setattr(limits_mod, "pricing_dir", lambda: tmp_path / "no-sheets")


def test_limits_analytics_full_payload(priced: None) -> None:
    conn = _make_conn()
    # Window 1 (May 20, Pro era): $10 usage then a session hit.
    _add_usage(conn, 1, "2026-05-20T08:00:00Z", 1_000_000)
    _add_limit_hit(conn, 1, "2026-05-20T09:00:00Z",
                   "You've hit your session limit · resets 1pm (UTC)")
    # Window 2 (July 3, Max era): $30 usage then a session hit.
    _add_usage(conn, 1, "2026-07-03T08:00:00Z", 3_000_000)
    _add_limit_hit(conn, 1, "2026-07-03T09:40:00Z")
    # Window 3 (July 4, Max era): $25 quiet usage. 25 >= 0.6 * 30: a near-miss.
    _add_usage(conn, 1, "2026-07-04T08:00:00Z", 2_500_000)

    payload = limits_analytics(conn, plan_history=[
        {"plan": "Pro", "start_date": "2026-05-01"},
        {"plan": "Max 5x", "start_date": "2026-06-10"},
    ])

    assert payload["meta"]["total_hits"] == 2
    assert payload["meta"]["hit_counts"] == {"session": 2}
    assert payload["meta"]["total_windows"] == 3
    assert payload["meta"]["cost_available"] is True
    assert payload["meta"]["method_note"]

    eras = {era["era"]: era for era in payload["eras"]}
    assert set(eras) == {"Pro", "Max 5x"}
    assert eras["Pro"]["session_hit_count"] == 1
    assert eras["Pro"]["cap_median_usd"] == 10.0
    assert eras["Max 5x"]["cap_median_usd"] == 30.0
    assert eras["Max 5x"]["near_miss_count"] == 1
    assert eras["Max 5x"]["window_count"] == 2

    assert [w["era"] for w in payload["windows"]] == ["Pro", "Max 5x", "Max 5x"]
    assert payload["windows"][0]["hit_kinds"] == ["session"]
    assert payload["hits"][0]["kind"] == "session"
    assert payload["hits"][0]["usage_at_hit"] == 10.0
    assert payload["hits"][0]["session_ids"] == [1]


def test_limits_analytics_without_plan_history_or_hits(priced: None) -> None:
    conn = _make_conn()
    _add_usage(conn, 1, "2026-05-20T08:00:00Z", 1_000_000)
    payload = limits_analytics(conn)
    assert payload["meta"]["total_hits"] == 0
    assert payload["meta"]["total_windows"] == 1
    assert payload["eras"] == [
        {
            "era": "", "window_count": 1, "session_hit_count": 0,
            "blocked_minutes": 0.0, "cap_median_usd": None, "cap_min_usd": None,
            "cap_max_usd": None, "near_miss_count": 0, "cap_percentile": None,
            "usage_at_hit_usd": [],
        }
    ]


def test_limits_analytics_zero_usage_cap_zone_stays_defined(priced: None) -> None:
    conn = _make_conn()
    # A hit as the first logged call of its window: measured usage-at-hit is
    # $0 (the real usage lived outside these logs). The zone is still
    # reported, but near-miss and percentile are meaningless against a $0
    # cap and stay unset.
    _add_limit_hit(conn, 1, "2026-07-03T09:40:00Z")
    payload = limits_analytics(conn)
    era = payload["eras"][0]
    assert era["session_hit_count"] == 1
    assert era["cap_median_usd"] == 0.0
    assert era["usage_at_hit_usd"] == [0.0]
    assert era["near_miss_count"] == 0
    assert era["cap_percentile"] is None
