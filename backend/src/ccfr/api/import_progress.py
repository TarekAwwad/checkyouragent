from __future__ import annotations

from copy import deepcopy
from threading import Lock
from typing import Any


_INACTIVE_SNAPSHOT: dict[str, Any] = {
    "active": False,
    "import_id": None,
    "status": "idle",
    "source_path": None,
    "project": None,
    "totals": None,
    "summary": None,
    "updated_at": None,
}


class ImportProgressStore:
    """In-process progress snapshot for the local import UI.

    ``data_version`` counts the imports, demo loads and local resets this process
    has finished, successful or not. Clients refetch imported data when it
    changes, whichever tab started the change.
    """

    def __init__(self) -> None:
        self._lock = Lock()
        self._snapshot: dict[str, Any] = deepcopy(_INACTIVE_SNAPSHOT)
        self._data_version = 0

    def get(self) -> dict[str, Any]:
        with self._lock:
            return {**deepcopy(self._snapshot), "data_version": self._data_version}

    def update(self, snapshot: dict[str, Any]) -> None:
        with self._lock:
            self._snapshot = deepcopy(snapshot)

    def clear(self) -> None:
        """Go idle without a data change, e.g. after a rejected request."""
        with self._lock:
            self._snapshot = deepcopy(_INACTIVE_SNAPSHOT)

    def finish(self) -> None:
        """Go idle after a change that may have written imported data."""
        with self._lock:
            self._snapshot = deepcopy(_INACTIVE_SNAPSHOT)
            self._data_version += 1


import_progress_store = ImportProgressStore()
