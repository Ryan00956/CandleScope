"""Cache facade backed by the standalone ``pyne_runtime`` package."""
from __future__ import annotations

from typing import Any, Callable

from .external_runtime import pyne_cache


class PyneCacheNamespace:
    """Namespace injected as ``pyne`` inside user scripts."""

    def cache(self, key: str, loader: Callable[[], Any], ttl: float | None = None) -> Any:
        return pyne_cache.get_or_load(key, loader, ttl=ttl)

    def cache_clear(self, key: str | None = None) -> int:
        return pyne_cache.clear(key)

    def cache_stats(self) -> dict[str, Any]:
        stats = pyne_cache.stats()
        return dict(stats) if isinstance(stats, dict) else {}


pyne = PyneCacheNamespace()
