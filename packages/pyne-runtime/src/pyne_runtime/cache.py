"""Small in-process cache exposed to Pyne scripts."""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Any, Callable


@dataclass
class _CacheEntry:
    value: Any
    created_at: float
    last_access: float
    ttl: float | None

    def expired(self, now: float) -> bool:
        return self.ttl is not None and (self.ttl <= 0 or now - self.created_at > self.ttl)


class PyneCache:
    """Thread-safe process-local cache for expensive user objects."""

    def __init__(self, max_items: int = 32) -> None:
        self._lock = threading.RLock()
        self._items: dict[str, _CacheEntry] = {}
        self._max_items = max(int(max_items), 1)

    def configure(self, *, max_items: int | None = None) -> None:
        with self._lock:
            if max_items is not None:
                self._max_items = max(int(max_items), 1)
                self._enforce_limit()

    def get_or_load(self, key: str, loader: Callable[[], Any], ttl: float | None = None) -> Any:
        if not callable(loader):
            raise TypeError("pyne.cache loader must be callable")
        normalized_key = str(key)
        now = time.time()
        with self._lock:
            entry = self._items.get(normalized_key)
            if entry is not None and not entry.expired(now):
                entry.last_access = now
                return entry.value
            if entry is not None:
                self._items.pop(normalized_key, None)

        value = loader()

        with self._lock:
            now = time.time()
            self._items[normalized_key] = _CacheEntry(
                value=value,
                created_at=now,
                last_access=now,
                ttl=float(ttl) if ttl is not None else None,
            )
            self._enforce_limit()
        return value

    def clear(self, key: str | None = None) -> int:
        with self._lock:
            if key is None:
                count = len(self._items)
                self._items.clear()
                return count
            return 1 if self._items.pop(str(key), None) is not None else 0

    def stats(self) -> dict[str, Any]:
        with self._lock:
            return {
                "size": len(self._items),
                "maxItems": self._max_items,
                "keys": list(self._items.keys()),
            }

    def _enforce_limit(self) -> None:
        while len(self._items) > self._max_items:
            oldest_key = min(
                self._items,
                key=lambda key: self._items[key].last_access,
            )
            self._items.pop(oldest_key, None)


pyne_cache = PyneCache()


class PyneCacheNamespace:
    """Namespace injected as ``pyne`` inside user scripts."""

    def cache(self, key: str, loader: Callable[[], Any], ttl: float | None = None) -> Any:
        return pyne_cache.get_or_load(key, loader, ttl=ttl)

    def cache_clear(self, key: str | None = None) -> int:
        return pyne_cache.clear(key)

    def cache_stats(self) -> dict[str, Any]:
        return pyne_cache.stats()


pyne = PyneCacheNamespace()
