"""Storage retention intent registry for DataManager-owned series."""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from .models import SeriesKey

WILDCARD_INTERVAL = "*"
PRIORITY_KEEP_ROWS = {
    "weak": 1_000,
    "normal": 10_000,
    "strong": 50_000,
}
PRIORITY_RANK = {
    "weak": 1,
    "normal": 2,
    "strong": 3,
}


@dataclass(slots=True)
class StorageIntent:
    key: SeriesKey
    source: str
    priority: str = "weak"
    storage_allowed: bool = True
    frontend_cache_allowed: bool = False
    stream_required: bool = False
    keep_rows: int | None = None
    detail: dict[str, Any] = field(default_factory=dict)
    registered_at_ms: int = 0
    last_seen_ms: int = 0

    def __post_init__(self) -> None:
        now = int(time.time() * 1000)
        if not self.registered_at_ms:
            self.registered_at_ms = now
        if not self.last_seen_ms:
            self.last_seen_ms = now
        self.priority = normalize_priority(self.priority)
        if self.keep_rows is not None:
            self.keep_rows = max(0, int(self.keep_rows))

    @property
    def id(self) -> str:
        return f"{self.source}|{self.key}"

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "key": str(self.key),
            "exchange": self.key.exchange,
            "market_type": self.key.market_type,
            "symbol": self.key.symbol,
            "interval": self.key.interval,
            "source": self.source,
            "priority": self.priority,
            "storage_allowed": self.storage_allowed,
            "frontend_cache_allowed": self.frontend_cache_allowed,
            "stream_required": self.stream_required,
            "keep_rows": self.keep_rows,
            "effective_keep_rows": self.effective_keep_rows,
            "detail": dict(self.detail),
            "registered_at_ms": self.registered_at_ms,
            "last_seen_ms": self.last_seen_ms,
        }

    @property
    def effective_keep_rows(self) -> int:
        if self.keep_rows is not None:
            return self.keep_rows
        return PRIORITY_KEEP_ROWS[self.priority]


def normalize_priority(priority: str | None) -> str:
    value = str(priority or "weak").strip().lower()
    return value if value in PRIORITY_KEEP_ROWS else "weak"


class StorageIntentRegistry:
    """Tracks why a stored K-line series should be retained."""

    def __init__(self) -> None:
        self._intents: dict[str, StorageIntent] = {}

    def register(
        self,
        key: SeriesKey,
        *,
        source: str,
        priority: str = "weak",
        storage_allowed: bool = True,
        frontend_cache_allowed: bool = False,
        stream_required: bool = False,
        keep_rows: int | None = None,
        detail: dict[str, Any] | None = None,
    ) -> StorageIntent:
        source = str(source or "").strip()
        if not source:
            raise ValueError("storage intent source is required")
        intent_id = f"{source}|{key}"
        current = self._intents.get(intent_id)
        now = int(time.time() * 1000)
        intent = StorageIntent(
            key=key,
            source=source,
            priority=priority,
            storage_allowed=storage_allowed,
            frontend_cache_allowed=frontend_cache_allowed,
            stream_required=stream_required,
            keep_rows=keep_rows,
            detail=detail or {},
            registered_at_ms=current.registered_at_ms if current else now,
            last_seen_ms=now,
        )
        self._intents[intent_id] = intent
        return intent

    def unregister(self, key: SeriesKey, *, source: str) -> None:
        self._intents.pop(f"{str(source or '').strip()}|{key}", None)

    def unregister_source_prefix(self, source_prefix: str) -> int:
        prefix = str(source_prefix or "").strip()
        if not prefix:
            return 0
        removed = 0
        for intent_id, intent in list(self._intents.items()):
            if intent.source.startswith(prefix):
                self._intents.pop(intent_id, None)
                removed += 1
        return removed

    def match(self, key: SeriesKey) -> list[StorageIntent]:
        return [
            intent for intent in self._intents.values()
            if intent.storage_allowed
            and intent.key.exchange == key.exchange
            and intent.key.market_type == key.market_type
            and intent.key.symbol == key.symbol
            and (
                intent.key.interval == key.interval
                or intent.key.interval == WILDCARD_INTERVAL
            )
        ]

    def effective_keep_rows(self, key: SeriesKey, base_keep_rows: int) -> int:
        keep_rows = int(base_keep_rows or 0)
        if keep_rows <= 0:
            return keep_rows
        for intent in self.match(key):
            keep_rows = max(keep_rows, intent.effective_keep_rows)
        return keep_rows

    def snapshot(self) -> dict[str, Any]:
        intents = [intent.to_dict() for intent in self._intents.values()]
        intents.sort(key=lambda item: (item["exchange"], item["market_type"], item["symbol"], item["interval"], item["source"]))
        return {
            "owner": "storage-retention-intents",
            "intent_count": len(intents),
            "intents": intents,
        }
