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
    """In-process progress snapshot for the local import UI."""

    def __init__(self) -> None:
        self._lock = Lock()
        self._snapshot: dict[str, Any] = deepcopy(_INACTIVE_SNAPSHOT)

    def get(self) -> dict[str, Any]:
        with self._lock:
            return deepcopy(self._snapshot)

    def update(self, snapshot: dict[str, Any]) -> None:
        with self._lock:
            self._snapshot = deepcopy(snapshot)

    def clear(self) -> None:
        with self._lock:
            self._snapshot = deepcopy(_INACTIVE_SNAPSHOT)


import_progress_store = ImportProgressStore()
