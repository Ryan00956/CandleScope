"""
In-Memory K-line Cache — fast, bounded OHLCV bar storage.

Architecture:
  * Per-series ring buffer: each (symbol, interval) pair gets its own
    ``BarSeries`` — a sorted list of ``BarData`` with a configurable
    max capacity.  Oldest bars are evicted when the limit is reached.
  * LRU series eviction: when the total number of series exceeds
    ``max_series``, the least-recently-used series is dropped entirely.
  * Thread-safe: all mutations are protected by a ``threading.Lock``.
    The cache is designed to be called from both async (via
    ``asyncio.to_thread``) and sync contexts.

Design goals:
  * **Zero-copy reads** where possible — ``get_bars()`` returns a
    *slice* of the internal list (shallow copy for safety).
  * **Deterministic memory** — total bars ≤ max_series × max_bars.
  * **O(1) append** for the hot path (realtime bar updates).
  * **O(log n) insert** for out-of-order inserts (backfill).

Usage::

    from data_manager.cache import BarCache
    from data_manager.config import CacheConfig

    cache = BarCache(CacheConfig(max_bars_per_series=5000))
    key = SeriesKey("BTCUSDT", "1m")

    cache.append(key, bar)           # hot path — realtime
    cache.bulk_load(key, bars)       # cold path — prewarm / backfill
    bars = cache.get_bars(key, 100)  # latest 100 bars
    bars = cache.query(key, start_ms, end_ms)  # range query
"""
from __future__ import annotations

import bisect
import logging
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any

from .config import CacheConfig
from .models import BarData, SeriesKey

logger = logging.getLogger("data_manager.cache")


# ═══════════════════════════════════════════════════════════════
#  Bar Series — per-(symbol, interval) ring buffer
# ═══════════════════════════════════════════════════════════════


class BarSeries:
    """Sorted, bounded list of ``BarData`` for one (symbol, interval).

    Bars are kept sorted by ``time`` (ascending).  The series enforces
    a maximum capacity; when exceeded, the oldest bars are dropped.

    Not thread-safe on its own — the outer ``BarCache`` handles locking.
    """

    __slots__ = (
        "_bars",
        "_max_bars",
        "_last_access_ms",
        "_generation",
        "_revision",
        "_access_revision",
        "_time_index",
    )

    def __init__(self, max_bars: int = 5000, *, generation: int = 0) -> None:
        self._bars: list[BarData] = []
        self._max_bars = max_bars
        self._last_access_ms: int = int(time.time() * 1000)
        self._generation = int(generation)
        self._revision = 0
        self._access_revision = 0
        # Separate sorted list of timestamps for fast bisect lookups
        self._time_index: list[int] = []

    # ── Properties ───────────────────────────────────────────

    @property
    def count(self) -> int:
        return len(self._bars)

    @property
    def last_access_ms(self) -> int:
        return self._last_access_ms

    @property
    def generation(self) -> int:
        """Cache-wide incarnation id that never repeats for a recreated key."""
        return self._generation

    @property
    def revision(self) -> int:
        """Monotonic mutation revision used by conditional maintenance."""
        return self._revision

    @property
    def access_revision(self) -> int:
        """Monotonic read revision used to invalidate stale GC plans."""
        return self._access_revision

    @property
    def earliest_time(self) -> int | None:
        return self._bars[0].time if self._bars else None

    @property
    def latest_time(self) -> int | None:
        return self._bars[-1].time if self._bars else None

    # ── Mutations ────────────────────────────────────────────

    def append(self, bar: BarData) -> list[BarData]:
        """Append or update a bar at the end (hot path).

        If the bar's time matches the last bar, it is updated in-place
        (typical for live UPDATED events).  Otherwise it is appended.

        Returns a list of evicted bars (may be empty).
        """
        self._last_access_ms = int(time.time() * 1000)
        self._revision += 1
        evicted: list[BarData] = []

        if self._bars and self._bars[-1].time == bar.time:
            # Update in-place
            self._bars[-1] = bar
            return evicted

        if self._bars and bar.time < self._bars[-1].time:
            # Out-of-order — use insert path
            return self._insert_sorted(bar)

        self._bars.append(bar)
        self._time_index.append(bar.time)

        # Evict oldest if over capacity
        while len(self._bars) > self._max_bars:
            evicted.append(self._bars.pop(0))
            self._time_index.pop(0)

        return evicted

    def upsert(self, bar: BarData) -> list[BarData]:
        """Insert or update a bar at the correct sorted position.

        If a bar with the same ``time`` exists, it is replaced.
        Otherwise the bar is inserted in sorted order.

        Returns evicted bars.
        """
        self._last_access_ms = int(time.time() * 1000)
        self._revision += 1
        idx = bisect.bisect_left(self._time_index, bar.time)

        if idx < len(self._time_index) and self._time_index[idx] == bar.time:
            # Replace existing
            self._bars[idx] = bar
            return []

        return self._insert_sorted(bar)

    def bulk_load(self, bars: list[BarData]) -> list[BarData]:
        """Load multiple bars, merging with existing data.

        Bars are expected to be sorted by time ascending.  Duplicates
        (same ``time``) are replaced.  Returns evicted bars.

        This is the primary path for prewarm / backfill results.
        """
        if not bars:
            return []

        self._last_access_ms = int(time.time() * 1000)
        self._revision += 1
        evicted: list[BarData] = []

        if not self._bars:
            # Empty series — direct load
            self._bars = list(bars)
            self._time_index = [b.time for b in bars]
        else:
            # Merge: combine both sorted lists
            merged: list[BarData] = []
            existing_map = {b.time: b for b in self._bars}
            for b in bars:
                existing_map[b.time] = b  # new data wins on conflict
            merged = sorted(existing_map.values(), key=lambda b: b.time)
            self._bars = merged
            self._time_index = [b.time for b in merged]

        # Enforce capacity
        if len(self._bars) > self._max_bars:
            overflow = len(self._bars) - self._max_bars
            evicted = self._bars[:overflow]
            self._bars = self._bars[overflow:]
            self._time_index = self._time_index[overflow:]

        return evicted

    def clear(self) -> None:
        """Remove all bars from this series."""
        if self._bars:
            self._revision += 1
        self._bars.clear()
        self._time_index.clear()

    # ── Reads ────────────────────────────────────────────────

    def get_latest(self, limit: int) -> list[BarData]:
        """Return the most recent ``limit`` bars (ascending order)."""
        self._mark_access()
        if limit >= len(self._bars):
            return list(self._bars)
        return list(self._bars[-limit:])

    def query_range(
        self,
        start_time: int | None = None,
        end_time: int | None = None,
        limit: int | None = None,
    ) -> list[BarData]:
        """Query bars within a time range [start_time, end_time].

        Times are in **seconds** (matching ``BarData.time``).
        Returns bars sorted ascending, capped by ``limit``.
        """
        self._mark_access()

        if not self._bars:
            return []

        lo = 0
        hi = len(self._bars)

        if start_time is not None:
            lo = bisect.bisect_left(self._time_index, start_time)
        if end_time is not None:
            hi = bisect.bisect_right(self._time_index, end_time)

        result = self._bars[lo:hi]
        if limit is not None and len(result) > limit:
            result = result[-limit:]
        return list(result)

    def get_bar_at(self, time_seconds: int) -> BarData | None:
        """Get a single bar at an exact timestamp."""
        self._mark_access()
        idx = bisect.bisect_left(self._time_index, time_seconds)
        if idx < len(self._time_index) and self._time_index[idx] == time_seconds:
            return self._bars[idx]
        return None

    def get_before(self, before_time: int, limit: int) -> list[BarData]:
        """Get bars strictly before ``before_time``, ascending order."""
        self._mark_access()
        idx = bisect.bisect_left(self._time_index, before_time)
        start = max(0, idx - limit)
        return list(self._bars[start:idx])

    # ── Internal ─────────────────────────────────────────────

    def _mark_access(self) -> None:
        self._last_access_ms = int(time.time() * 1000)
        self._access_revision += 1

    def _insert_sorted(self, bar: BarData) -> list[BarData]:
        """Insert a bar in sorted position.  Returns evicted bars."""
        idx = bisect.bisect_left(self._time_index, bar.time)

        if idx < len(self._time_index) and self._time_index[idx] == bar.time:
            self._bars[idx] = bar
            return []

        self._bars.insert(idx, bar)
        self._time_index.insert(idx, bar.time)

        evicted: list[BarData] = []
        while len(self._bars) > self._max_bars:
            evicted.append(self._bars.pop(0))
            self._time_index.pop(0)
        return evicted

    def snapshot(self) -> dict:
        return {
            "count": self.count,
            "max_bars": self._max_bars,
            "earliest_time": self.earliest_time,
            "latest_time": self.latest_time,
            "last_access_ms": self._last_access_ms,
            "generation": self._generation,
            "revision": self._revision,
            "access_revision": self._access_revision,
        }


# ═══════════════════════════════════════════════════════════════
#  Bar Cache — top-level cache manager
# ═══════════════════════════════════════════════════════════════


class BarCache:
    """Thread-safe, bounded, LRU-evicting in-memory bar cache.

    Manages multiple ``BarSeries`` (one per SeriesKey) with:
      * Per-series bar count limits
      * Total series count limits (LRU eviction)
      * Optional TTL-based idle eviction
      * Pluggable eviction callbacks

    This is the **only** class external code interacts with for
    cache operations.

    Usage::

        cache = BarCache(config)
        cache.append(key, bar)
        bars = cache.get_latest(key, 500)
        cache.on_eviction(my_callback)  # hook for custom eviction logic
    """

    def __init__(self, config: CacheConfig | None = None) -> None:
        self._cfg = config or CacheConfig()
        self._lock = threading.Lock()
        # OrderedDict for LRU tracking — most recently used at the end
        self._series: OrderedDict[SeriesKey, BarSeries] = OrderedDict()
        # Monotonic across remove/clear/LRU cycles so a stale plan cannot pass
        # revision checks against a newly-created incarnation of the same key.
        self._next_series_generation = 0
        # Eviction callbacks
        self._eviction_callbacks: list[Any] = []
        # Configurable ephemeral cache limit (default 86400 = 24h of 1s)
        self._ephemeral_max_bars: int = 86_400
        # Metrics
        self._hits = 0
        self._misses = 0
        self._evictions = 0

    # ── Public: Write Operations ─────────────────────────────

    def append(self, key: SeriesKey, bar: BarData) -> None:
        """Append a bar to a series (hot path for realtime data).

        Creates the series if it doesn't exist.  Evicts the LRU series
        if the series count exceeds ``max_series``.
        """
        with self._lock:
            series = self._get_or_create(key)
            evicted = series.append(bar)
        # Fire eviction callbacks outside the lock to avoid deadlocks
        if evicted:
            self._on_bars_evicted(key, evicted)

    def upsert(self, key: SeriesKey, bar: BarData) -> None:
        """Insert or update a bar at the correct sorted position."""
        with self._lock:
            series = self._get_or_create(key)
            evicted = series.upsert(bar)
        if evicted:
            self._on_bars_evicted(key, evicted)

    def bulk_load(self, key: SeriesKey, bars: list[BarData]) -> None:
        """Load multiple bars into a series (prewarm / backfill path).

        Bars should be sorted by time ascending.  Duplicates are replaced.
        """
        if not bars:
            return
        with self._lock:
            series = self._get_or_create(key)
            evicted = series.bulk_load(bars)
        if evicted:
            self._on_bars_evicted(key, evicted)

    def invalidate(self, key: SeriesKey) -> None:
        """Remove all cached bars for a series."""
        with self._lock:
            series = self._series.pop(key, None)
            if series:
                logger.debug("Invalidated cache for %s (%d bars)", key, series.count)

    def remove_series(self, key: SeriesKey) -> int:
        """Remove one cached series and return its previous bar count."""
        with self._lock:
            series = self._series.pop(key, None)
            if series is None:
                return 0
            removed = series.count
            logger.debug("Removed cache series %s (%d bars)", key, removed)
            return removed

    def remove_series_if_unchanged(
        self,
        key: SeriesKey,
        *,
        expected_generation: int,
        expected_revision: int,
        expected_access_revision: int,
        expected_last_access_ms: int,
    ) -> tuple[int, str]:
        """Atomically remove a series only when its plan snapshot is current."""
        with self._lock:
            series = self._series.get(key)
            if series is None:
                return 0, "missing"
            if (
                series.generation != expected_generation
                or series.revision != expected_revision
                or series.access_revision != expected_access_revision
                or series.last_access_ms != expected_last_access_ms
            ):
                return 0, "stale"
            removed = series.count
            self._series.pop(key, None)
            logger.debug("Conditionally removed cache series %s (%d bars)", key, removed)
            return removed, "removed"

    def clear(self) -> None:
        """Remove all cached data."""
        with self._lock:
            count = len(self._series)
            self._series.clear()
            logger.info("Cache cleared (%d series removed)", count)

    # ── Public: Read Operations ──────────────────────────────

    def get_latest(self, key: SeriesKey, limit: int) -> list[BarData]:
        """Get the most recent ``limit`` bars for a series.

        Returns empty list on cache miss (does NOT trigger storage reads).
        """
        with self._lock:
            series = self._touch(key)
            if series is None:
                self._misses += 1
                return []
            self._hits += 1
            return series.get_latest(limit)

    def query(
        self,
        key: SeriesKey,
        start_time: int | None = None,
        end_time: int | None = None,
        limit: int | None = None,
    ) -> list[BarData]:
        """Query bars within a time range.

        Times are in **seconds** (matching BarData.time convention).
        Returns bars sorted ascending.
        """
        with self._lock:
            series = self._touch(key)
            if series is None:
                self._misses += 1
                return []
            self._hits += 1
            return series.query_range(start_time, end_time, limit)

    def get_before(self, key: SeriesKey, before_time: int, limit: int) -> list[BarData]:
        """Get bars strictly before ``before_time``, ascending order."""
        with self._lock:
            series = self._touch(key)
            if series is None:
                self._misses += 1
                return []
            self._hits += 1
            return series.get_before(before_time, limit)

    def get_bar_at(self, key: SeriesKey, time_seconds: int) -> BarData | None:
        """Get a single bar at an exact timestamp (seconds)."""
        with self._lock:
            series = self._touch(key)
            if series is None:
                return None
            return series.get_bar_at(time_seconds)

    def has_series(self, key: SeriesKey) -> bool:
        """Check whether a series exists in cache."""
        with self._lock:
            return key in self._series

    def series_count(self, key: SeriesKey) -> int:
        """Return the number of bars cached for a series."""
        with self._lock:
            series = self._series.get(key)
            return series.count if series else 0

    def get_bounds(self, key: SeriesKey) -> tuple[int | None, int | None]:
        """Return (earliest_time, latest_time) in seconds, or (None, None)."""
        with self._lock:
            series = self._series.get(key)
            if series is None:
                return None, None
            return series.earliest_time, series.latest_time

    # ── Public: Eviction Callbacks ───────────────────────────

    def on_eviction(self, callback: Any) -> None:
        """Register a callback for bar eviction events.

        Signature: ``callback(key: SeriesKey, bars: list[BarData]) -> None``

        Useful for persisting evicted bars to storage before they are lost.
        """
        self._eviction_callbacks.append(callback)

    # ── Public: Maintenance ──────────────────────────────────

    def evict_idle(self) -> int:
        """Evict series that have been idle longer than ``ttl_seconds``.

        Returns the number of series evicted.  Call this periodically
        (e.g. from a background task) if TTL eviction is enabled.
        """
        ttl = self._cfg.ttl_seconds
        if ttl <= 0:
            return 0

        cutoff_ms = int(time.time() * 1000) - ttl * 1000
        to_remove: list[SeriesKey] = []

        with self._lock:
            for key, series in self._series.items():
                if series.last_access_ms < cutoff_ms:
                    to_remove.append(key)
            for key in to_remove:
                self._series.pop(key, None)
                self._evictions += 1

        if to_remove:
            logger.info("TTL eviction: removed %d idle series", len(to_remove))
        return len(to_remove)

    def get_all_keys(self) -> list[SeriesKey]:
        """Return all series keys currently in cache."""
        with self._lock:
            return list(self._series.keys())

    def trim_series(self, key: SeriesKey, max_bars: int) -> int:
        """Trim a series to at most *max_bars*, dropping the oldest.

        Returns the number of bars trimmed.  Safe to call even if
        the series doesn't exist (returns 0).
        """
        with self._lock:
            series = self._series.get(key)
            if series is None or series.count <= max_bars:
                return 0
            overflow = series.count - max_bars
            series._bars = series._bars[overflow:]
            series._time_index = series._time_index[overflow:]
            series._revision += 1
            logger.debug(
                "Trimmed %s: removed %d oldest bars (kept %d)",
                key, overflow, series.count,
            )
            return overflow

    def trim_series_if_unchanged(
        self,
        key: SeriesKey,
        max_bars: int,
        *,
        expected_generation: int,
        expected_revision: int,
        expected_access_revision: int,
        expected_last_access_ms: int,
    ) -> tuple[int, str]:
        """Atomically trim a series only when its plan snapshot is current."""
        with self._lock:
            series = self._series.get(key)
            if series is None:
                return 0, "missing"
            if (
                series.generation != expected_generation
                or series.revision != expected_revision
                or series.access_revision != expected_access_revision
                or series.last_access_ms != expected_last_access_ms
            ):
                return 0, "stale"
            if series.count <= max_bars:
                return 0, "unchanged"
            overflow = series.count - max_bars
            series._bars = series._bars[overflow:]
            series._time_index = series._time_index[overflow:]
            series._revision += 1
            logger.debug(
                "Conditionally trimmed %s: removed %d oldest bars (kept %d)",
                key,
                overflow,
                series.count,
            )
            return overflow, "trimmed"

    def set_ephemeral_limit(self, max_bars: int) -> None:
        """Update the ephemeral cache limit (e.g. from user settings).

        Does NOT immediately trim existing series — the periodic
        cleanup task handles that.
        """
        normalized = int(max_bars)
        if normalized < 1 or normalized > 1_000_000:
            raise ValueError("ephemeral cache limit must be between 1 and 1000000 bars")
        self._ephemeral_max_bars = normalized
        logger.info("Ephemeral cache limit updated to %d bars", normalized)

    def get_ephemeral_limit(self) -> int:
        """Return the configured max bars for ephemeral cache series."""
        return self._ephemeral_max_bars

    # ── Public: Snapshot ─────────────────────────────────────

    def snapshot(self) -> dict:
        """JSON-serializable diagnostic snapshot."""
        with self._lock:
            return {
                "total_series": len(self._series),
                "max_series": self._cfg.max_series,
                "max_bars_per_series": self._cfg.max_bars_per_series,
                "total_bars": sum(s.count for s in self._series.values()),
                "hits": self._hits,
                "misses": self._misses,
                "evictions": self._evictions,
                "series": {
                    str(key): series.snapshot()
                    for key, series in self._series.items()
                },
            }

    # ── Internal ─────────────────────────────────────────────

    def _get_or_create(self, key: SeriesKey) -> BarSeries:
        """Get existing series or create a new one (must hold lock)."""
        if key in self._series:
            self._series.move_to_end(key)
            return self._series[key]

        # Evict LRU series if at capacity
        while len(self._series) >= self._cfg.max_series:
            evicted_key, evicted_series = self._series.popitem(last=False)
            self._evictions += 1
            logger.debug(
                "LRU eviction: %s (%d bars)", evicted_key, evicted_series.count,
            )

        # Ephemeral intervals (e.g. 1s) get a separate cache capacity
        # since they are cache-only (no DB backing).
        from app.data_engine.interval_policy import is_ephemeral_interval
        if is_ephemeral_interval(key.interval):
            max_bars = self._ephemeral_max_bars
        else:
            max_bars = self._cfg.max_bars_per_series

        self._next_series_generation += 1
        series = BarSeries(
            max_bars=max_bars,
            generation=self._next_series_generation,
        )
        self._series[key] = series
        return series

    def _touch(self, key: SeriesKey) -> BarSeries | None:
        """Move series to end of LRU (must hold lock).  Returns None on miss."""
        if key not in self._series:
            return None
        self._series.move_to_end(key)
        return self._series[key]

    def _on_bars_evicted(self, key: SeriesKey, bars: list[BarData]) -> None:
        """Notify eviction callbacks (called outside lock — safe for I/O)."""
        for cb in self._eviction_callbacks:
            try:
                cb(key, bars)
            except Exception as exc:
                logger.error("Eviction callback error: %s", exc)
