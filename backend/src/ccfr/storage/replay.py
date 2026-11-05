"""Project-scoped accounting for transcript copies and streamed API messages.

Events remain available for timelines, search and turn boundaries. Event UUIDs
identify replayed activity; API message IDs identify usage, which can span
several different event UUIDs. These are deliberately separate identities.
"""
from __future__ import annotations

import json
import sqlite3
from typing import Any

TOKEN_COLUMNS = (
    "input_tokens", "output_tokens", "base_input_tokens",
    "cache_5m_tokens", "cache_1h_tokens", "cache_read_tokens",
)


def token_usage(usage: dict[str, Any]) -> tuple[int, int, int, int, int, int]:
    """Normalize recorded usage exactly as ingestion does, including old cache logs."""
    base = int(usage.get("input_tokens") or 0)
    read = int(usage.get("cache_read_input_tokens") or 0)
    creation = usage.get("cache_creation")
    creation = creation if isinstance(creation, dict) else {}
    c5 = int(creation.get("ephemeral_5m_input_tokens") or 0)
    c1 = int(creation.get("ephemeral_1h_input_tokens") or 0)
    if c5 == 0 and c1 == 0:
        c5 = int(usage.get("cache_creation_input_tokens") or 0)
    return base + c5 + c1 + read, int(usage.get("output_tokens") or 0), base, c5, c1, read


# Nested CASEs: SQLite does not guarantee AND short-circuits, and json_type raises
# on malformed JSON. A usage that is not an object is empty, as in the importer.
PROVIDER_MESSAGE_ID_SQL = """
    CASE WHEN json_valid(e.raw_json) THEN
        CASE WHEN json_type(e.raw_json, '$.message.id') = 'text'
             THEN json_extract(e.raw_json, '$.message.id') END
    END"""
RECORDED_USAGE_SQL = """
    CASE WHEN json_valid(e.raw_json) THEN
        CASE WHEN json_type(e.raw_json, '$.message.usage') = 'object'
             THEN json_extract(e.raw_json, '$.message.usage') END
    END"""


def recorded_tokens(raw_usage: str | None) -> tuple[int, int, int, int, int, int] | None:
    """Normalize a usage selected with RECORDED_USAGE_SQL; None when there is none."""
    return token_usage(json.loads(raw_usage)) if raw_usage else None


def reconcile_replays(conn: sqlite3.Connection, *, project_ids: list[int] | None = None) -> None:
    """Rebuild replay flags and counted usage from retained source records.

    Scope all identities to a project. Shared API message IDs or event UUIDs
    join copies into one usage group; rows with neither remain independent.
    The most complete usage record wins, matching the existing within-session
    rule for streamed messages; copies are never added together. Ties prefer a
    self-claimed origin, then earlier session start, stable session ID, main
    transcript and source position. Restamped forks can have identical starts:
    their ownership is deterministic, not a claim to know the original run.

    Numeric message columns contain counted usage, as they did before this fix.
    Non-owners get zero; raw_json retains every original usage record so this
    pass can restore an owner after a re-import or migration. All cost/token
    consumers therefore agree without applying an event-replay filter. Canonical
    event selection prefers the usage owner so activity views can also exclude
    replayed events without dropping any counted tokens. Importers call this in
    the project's transaction, so committed usage is always reconciled.
    """
    if project_ids == []:
        return
    scope = ""
    params: list[int] = []
    if project_ids is not None:
        scope = f"AND s.project_id IN ({','.join('?' for _ in project_ids)})"
        params = project_ids

    # Extract only identity and usage, not conversation text. Older caches may
    # have zeroed an earlier streaming block: restore from raw before choosing.
    rows = conn.execute(
        f"""
        SELECT m.id AS message_id, e.id AS event_id, e.uuid, s.project_id,
               e.origin_session_id, s.session_id, s.first_ts,
               e.is_sidechain, e.source_path, e.line_no,
               {', '.join('m.' + column for column in TOKEN_COLUMNS)},
               {PROVIDER_MESSAGE_ID_SQL} AS provider_message_id,
               {RECORDED_USAGE_SQL} AS raw_usage
        FROM messages m JOIN events e ON e.id = m.event_id
        JOIN sessions s ON s.id = e.session_id
        WHERE 1 = 1 {scope}
        """, params,
    )
    rows.row_factory = sqlite3.Row
    # Connect both identities: an older copy can lack message.id, while another
    # copy links that event UUID to several streamed blocks of the same request.
    parents: dict[int, int] = {}
    identities: dict[tuple, int] = {}

    def root(mid: int) -> int:
        while parents[mid] != mid:
            parents[mid] = parents[parents[mid]]
            mid = parents[mid]
        return mid

    candidates: list[tuple[tuple, int, tuple[int, ...]]] = []
    previous: dict[int, tuple[int, ...]] = {}
    for row in rows:
        mid = row["message_id"]
        parents[mid] = mid
        previous[mid] = tuple(int(row[column] or 0) for column in TOKEN_COLUMNS)
        tokens = recorded_tokens(row["raw_usage"]) or previous[mid]
        provider_id = row["provider_message_id"]
        for kind, value in (("message", provider_id), ("event", row["uuid"])):
            if value:
                key = (row["project_id"], kind, value)
                if key in identities:
                    parents[root(mid)] = root(identities[key])
                else:
                    identities[key] = mid
        rank = (
            -(tokens[0] + tokens[1]),
            row["origin_session_id"] != row["session_id"],
            row["first_ts"] is None, row["first_ts"] or "", row["session_id"],
            row["is_sidechain"], row["source_path"], row["line_no"], row["event_id"],
        )
        candidates.append((rank, mid, tokens))

    owners: dict[int, tuple[tuple, int, tuple[int, ...]]] = {}
    for rank, mid, tokens in candidates:
        key = root(mid)
        if key not in owners or rank < owners[key][0]:
            owners[key] = (rank, mid, tokens)

    counted = {mid: tokens for _, mid, tokens in owners.values()}
    zeros = (0,) * len(TOKEN_COLUMNS)
    conn.executemany(
        f"UPDATE messages SET {', '.join(column + ' = ?' for column in TOKEN_COLUMNS)} WHERE id = ?",
        ((*counted.get(mid, zeros), mid) for mid, old in previous.items() if counted.get(mid, zeros) != old),
    )
    # Rows without an identity stay distinct, including empty UUIDs.
    conn.execute(
        f"""
        WITH ranked AS (
            SELECT e.id, ROW_NUMBER() OVER (
                PARTITION BY s.project_id, COALESCE(NULLIF(e.uuid, ''), e.id)
                ORDER BY CASE WHEN EXISTS (
                             SELECT 1 FROM messages m WHERE m.event_id = e.id
                             AND m.input_tokens + m.output_tokens > 0
                         ) THEN 0 ELSE 1 END,
                         CASE WHEN e.origin_session_id = s.session_id THEN 0 ELSE 1 END,
                         s.first_ts IS NULL, s.first_ts, s.session_id,
                         e.is_sidechain, e.source_path, e.line_no, e.id
            ) AS position
            FROM events e JOIN sessions s ON s.id = e.session_id
            WHERE 1 = 1 {scope}
        )
        UPDATE events SET is_replay = ranked.position > 1
        FROM ranked WHERE ranked.id = events.id
        """, params,
    )


def refresh_session_tokens(conn: sqlite3.Connection) -> None:
    """Recompute cached token summaries for a migration, which has no import to do it."""
    conn.execute(
        """
        UPDATE session_stats SET
            input_tokens = (SELECT COALESCE(SUM(m.input_tokens), 0) FROM messages m
                            JOIN events e ON e.id = m.event_id WHERE e.session_id = session_stats.session_id),
            output_tokens = (SELECT COALESCE(SUM(m.output_tokens), 0) FROM messages m
                             JOIN events e ON e.id = m.event_id WHERE e.session_id = session_stats.session_id)
        """
    )
