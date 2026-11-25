from __future__ import annotations

import sqlite3

from ccfr.analysis.date_bounds import in_window, is_instant, sql_terms

# "Today" (24 Nov 2026) in Paris (UTC+1) as the frontend sends it.
PARIS_TODAY = ("2026-11-23T23:00:00.000Z", "2026-11-24T22:59:59.999Z")


def _conn(stamps: list[str]) -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, ts TEXT)")
    conn.executemany("INSERT INTO t (ts) VALUES (?)", [(s,) for s in stamps])
    return conn


def _select(conn: sqlite3.Connection, date_from: str | None, date_to: str | None) -> list[str]:
    terms, params = sql_terms("ts", date_from, date_to)
    where = (" WHERE " + " AND ".join(terms)) if terms else ""
    return [row[0] for row in conn.execute(f"SELECT ts FROM t{where} ORDER BY id", params)]


def test_is_instant_tells_instants_from_dates() -> None:
    assert is_instant("2026-11-23T23:00:00.000Z")
    assert not is_instant("2026-11-24")


def test_instant_window_selects_the_local_day() -> None:
    conn = _conn([
        "2026-11-23T22:59:59Z",   # 23:59:59 on the 23rd in Paris
        "2026-11-23T23:30:00Z",   # 00:30 on the 24th in Paris
        "2026-11-24T22:59:59Z",
        "2026-11-24T23:00:00Z",   # midnight starting the 25th in Paris
    ])
    assert _select(conn, *PARIS_TODAY) == ["2026-11-23T23:30:00Z", "2026-11-24T22:59:59Z"]


def test_instant_window_compares_mixed_timestamp_forms() -> None:
    conn = _conn([
        "2026-11-23T23:00:00Z",
        "2026-11-23T23:00:00.000Z",
        "2026-11-24T00:00:00+01:00",
        "2026-11-24T22:59:59.999+00:00",
    ])
    assert len(_select(conn, *PARIS_TODAY)) == 4


def test_date_window_keeps_inclusive_utc_days() -> None:
    conn = _conn(["2026-06-01T00:00:00Z", "2026-06-05T23:59:59Z", "2026-06-06T00:00:00Z"])
    assert _select(conn, "2026-06-01", "2026-06-05") == [
        "2026-06-01T00:00:00Z", "2026-06-05T23:59:59Z",
    ]


def test_in_window_agrees_with_sql_terms() -> None:
    stamps = [
        "2026-11-23T22:59:59Z", "2026-11-23T23:30:00Z", "2026-11-24T12:00:00.500Z",
        "2026-11-24T23:00:00Z", "2026-11-25T08:00:00+01:00",
    ]
    conn = _conn(stamps)
    for date_from, date_to in [PARIS_TODAY, ("2026-11-24", "2026-11-24"), (None, None),
                               (PARIS_TODAY[0], None), (None, "2026-11-24")]:
        expected = _select(conn, date_from, date_to)
        assert [s for s in stamps if in_window(s, date_from, date_to)] == expected


def test_in_window_rejects_undated_items_inside_a_window() -> None:
    assert in_window(None, None, None)
    assert not in_window(None, *PARIS_TODAY)
    assert not in_window("", "2026-11-24", None)
