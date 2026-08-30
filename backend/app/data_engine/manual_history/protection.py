"""In-memory durable/transient protection floors restored from SQLite."""

from __future__ import annotations

import threading
from collections.abc import Callable, Iterable, Mapping
from typing import Any

from app.data_engine.data_manager.models import SeriesKey

from .models import (
    ManualHistoryProtectionRecord,
    ProtectionKind,
    ProtectionState,
    StorageProtectionFloor,
)
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

    def ensure_records(
        self,
        records: Iterable[ManualHistoryProtectionRecord],
    ) -> bool:
        """Fail-closed merge for protections committed before a full reload.

        The normal path always replaces the mirror from the repository's
        aggregate snapshot.  If that read fails after a create transaction has
        committed, dropping the GC guard with no in-memory floor would create
        a deletion window.  This method only strengthens the current mirror;
        it never removes or weakens an existing floor.
        """

        with self._lock:
            mapping = dict(self._floors)
            changed = False
            for record in records:
                if record.state is not ProtectionState.ACTIVE:
                    continue
                key = SeriesKey(
                    record.symbol,
                    record.interval,
                    exchange=record.exchange,
                    market_type=record.market_type,
                )
                current = mapping.get(key)
                owner_ids = set(current.owner_ids if current is not None else ())
                qualified_owner_id = f"{record.owner_kind.value}:{record.owner_id}"
                owner_is_new = qualified_owner_id not in owner_ids
                owner_ids.add(qualified_owner_id)
                transient = current.transient_owner_count if current is not None else 0
                durable = current.durable_owner_count if current is not None else 0
                if owner_is_new and record.protection_kind is ProtectionKind.TRANSIENT:
                    transient += 1
                if owner_is_new and record.protection_kind is ProtectionKind.DURABLE:
                    durable += 1
                next_floor = StorageProtectionFloor(
                    key=key,
                    protected_start_ms=min(
                        int(record.protected_start_ms),
                        int(current.protected_start_ms)
                        if current is not None
                        else int(record.protected_start_ms),
                    ),
                    owner_count=len(owner_ids),
                    transient_owner_count=transient,
                    durable_owner_count=durable,
                    owner_ids=tuple(sorted(owner_ids)),
                )
                if next_floor != current:
                    mapping[key] = next_floor
                    changed = True
            if changed:
                self._floors = mapping
        if changed and self._on_change is not None:
            self._on_change()
        return changed

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
