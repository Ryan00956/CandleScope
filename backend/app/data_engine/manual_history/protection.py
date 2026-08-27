"""In-memory durable/transient protection floors restored from SQLite."""

from __future__ import annotations

import threading
from collections.abc import Callable, Iterable, Mapping
from typing import Any

from app.data_engine.data_manager.models import SeriesKey

from .models import StorageProtectionFloor
from .repository import ManualHistoryRepository


class DurableProtectionRegistry:
    """Read-mostly floor snapshot used by GC planning and execute revalidation.

    The database remains the source of truth.  Callers must reload or replace
    this snapshot under the same ``_storage_gc_guard`` that serializes physical
    deletes so GC never observes a committed-but-unprotected window.
    """

    def __init__(
        self,
        *,
        lock: threading.RLock | None = None,
        on_change: Callable[[], None] | None = None,
    ) -> None:
        self._lock = lock or threading.RLock()
        self._on_change = on_change
        self._floors: dict[SeriesKey, StorageProtectionFloor] = {}

    def replace(self, floors: Iterable[StorageProtectionFloor]) -> bool:
        mapping = {floor.key: floor for floor in floors}
        with self._lock:
            if mapping == self._floors:
                return False
            self._floors = mapping
        if self._on_change is not None:
            self._on_change()
        return True

    def load_from_repository(self, repository: ManualHistoryRepository) -> bool:
        return self.replace(repository.active_protection_snapshot())

    def clone(self) -> dict[SeriesKey, StorageProtectionFloor]:
        with self._lock:
            return dict(self._floors)

    def floor_for(self, key: SeriesKey) -> StorageProtectionFloor | None:
        with self._lock:
            return self._floors.get(key)

    def as_mapping(self) -> Mapping[SeriesKey, StorageProtectionFloor]:
        return self.clone()


def floor_owner_kinds(floor: StorageProtectionFloor) -> tuple[str, ...]:
    kinds: list[str] = []
    seen: set[str] = set()
    for owner_id in floor.owner_ids:
        kind = str(owner_id).split(":", 1)[0]
        if kind and kind not in seen:
            seen.add(kind)
            kinds.append(kind)
    return tuple(kinds)


def planned_floor_payload(floor: StorageProtectionFloor | None) -> dict[str, Any]:
    if floor is None:
        return {
            "protected_start_ms": None,
            "protected_owner_count": 0,
            "protected_owner_kinds": [],
            "protection_clamped": False,
            "rows_before_protected_floor": 0,
            "blocked_delete_rows": 0,
        }
    return {
        "protected_start_ms": int(floor.protected_start_ms),
        "protected_owner_count": int(floor.owner_count),
        "protected_owner_kinds": list(floor_owner_kinds(floor)),
        "protection_clamped": False,
        "rows_before_protected_floor": 0,
        "blocked_delete_rows": 0,
    }
