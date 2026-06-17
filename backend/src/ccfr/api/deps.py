from __future__ import annotations

from collections.abc import Iterator
from sqlite3 import Connection

from ccfr.config import database_path
from ccfr.settings import read_settings
from ccfr.storage import connect


def get_db() -> Iterator[Connection]:
    # Schema is initialized once in the app lifespan; re-running the
    # full DDL script per request takes a write lock and races other requests/imports
    # ("database is locked"), so we only open a connection here.
    conn = connect(database_path())
    try:
        yield conn
    finally:
        conn.close()


def get_historical_pricing(historical: bool | None = None) -> bool:
    """Resolve the pricing mode for a request.

    An explicit ``?historical=`` query param wins so the request URL encodes the
    mode (two modes never share one cacheable URL); absent it, the persisted
    server-side setting applies.
    """
    if historical is not None:
        return historical
    return read_settings().historical_pricing
