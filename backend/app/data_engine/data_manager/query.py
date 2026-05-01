"""
Query Engine — three-level data retrieval: Cache → Storage → Backfill.

The query engine is the **single entry point** for all bar data reads.
Charts, indicators, strategies, and APIs all call ``QueryEngine.query()``
instead of reaching into cache or storage directly.

Resolution strategy:
  1. **Cache hit** — fast path, returns immediately.
  2. **Storage fallback** — if the cache doesn't cover the requested
     range, the engine reads from the storage backend.
  3. **Backfill trigger** — if storage is also missing data and
     ``auto_backfill`` is enabled, a backfill task is spawned.

The engine also pre-warms the cache with storage results so that
subsequent queries for the same range are served from memory.

Usage::

    engine = QueryEngine(cache, storage, config, backfill_fn)

    result = engine.query("BTCUSDT", "1m", limit=500)
    result = engine.query("BTCUSDT", "1h", start_ms=..., end_ms=...)
    result = engine.query_latest("BTCUSDT", "1m", 100)
"""
from __future__ import annotations

import logging
import time
from typing import Any, Callable

from app.data_engine.interval_policy import (
    is_custom_interval,
    is_ephemeral_interval,
    parse_custom_interval,
)

from .cache import BarCache
from .config import QueryConfig
from .custom_query import CustomIntervalQueryService
from .models import (
    BarData,
    MissingRange,
    QueryResult,
    QuerySource,
    SeriesKey,
    StorageBackend,
)

logger = logging.getLogger("data_manager.query")

# Signature for the optional backfill trigger callback
BackfillTrigger = Callable[[str, str, int, int, str, str], None]


class QueryEngine:
    """Three-level query engine: Cache → Storage → Backfill.

    This class owns **no** data — it orchestrates reads across the
    cache and storage backend, and optionally triggers backfill when
    gaps are detected.

    All public methods are synchronous (designed to be called via
    ``asyncio.to_thread`` from async contexts).

    Attributes:
        cache:      The in-memory ``BarCache`` instance.
        storage:    A ``StorageBackend`` implementation (or None).
        config:     ``QueryConfig`` with limits and feature flags.
        backfill_trigger:
                    Optional callback ``(symbol, interval, start_ms, end_ms)``
                    called when the engine detects missing data.
    """

    def __init__(
        self,
        cache: BarCache,
        storage: StorageBackend | None = None,
        config: QueryConfig | None = None,
        backfill_trigger: BackfillTrigger | None = None,
    ) -> None:
        self._cache = cache
        self._storage = storage
        self._cfg = config or QueryConfig()
        self._backfill_trigger = backfill_trigger

        # Metrics
        self._queries = 0
        self._cache_hits = 0
        self._storage_reads = 0
        self._backfills_triggered = 0
        self.custom_intervals = CustomIntervalQueryService(
            cache=self._cache,
            config=self._cfg,
            base_query=self.query,
        )

    # ── Public: Dependency Access ────────────────────────────

    @property
    def storage(self) -> StorageBackend | None:
        """Return the configured storage backend, if any."""
        return self._storage

    def set_storage(self, storage: StorageBackend | None) -> None:
        """Set or clear the storage backend used by query operations."""
        self._storage = storage

    @property
    def backfill_trigger(self) -> BackfillTrigger | None:
        """Return the configured backfill trigger callback, if any."""
        return self._backfill_trigger

    def set_backfill_trigger(self, trigger: BackfillTrigger | None) -> None:
        """Set or clear the backfill trigger callback."""
        self._backfill_trigger = trigger

    def set_bar_aggregator(self, bar_aggregator: Any | None) -> None:
        """Set the BarAggregator used for custom interval read aggregation."""
        self.custom_intervals.set_bar_aggregator(bar_aggregator)

    # ── Public: Main Query ───────────────────────────────────

    def query(
        self,
        symbol: str,
        interval: str,
        start_ms: int | None = None,
        end_ms: int | None = None,
        limit: int | None = None,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> QueryResult:
        """Query bars for a (symbol, interval) with flexible parameters.

        This is the **primary query interface**.  All consumers
        (chart, indicator, strategy, API) should use this method.

        Args:
            symbol:    Trading pair, e.g. "BTCUSDT".
            interval:  K-line interval, e.g. "1m", "5m", "1h".
            start_ms:  Start of range in milliseconds (inclusive).
            end_ms:    End of range in milliseconds (inclusive).
            limit:     Maximum bars to return.  Capped by config.

        Returns:
            ``QueryResult`` with bars sorted ascending by time.

        Resolution order:
            1. Cache (fast path)
            2. Storage (if cache miss or partial)
            3. Backfill trigger (if storage also missing)

        Ephemeral intervals (e.g. 1s) use a cache-only fast path:
        no storage reads, no backfill triggers.
        """
        t0 = time.monotonic()
        self._queries += 1

        if is_custom_interval(interval):
            return self.custom_intervals.query_from_base(
                symbol=symbol,
                interval=interval,
                start_ms=start_ms,
                end_ms=end_ms,
                limit=limit,
                started_at=t0,
                exchange=exchange,
                market_type=market_type,
            )

        key = SeriesKey(symbol, interval, exchange=exchange, market_type=market_type)

        # Ephemeral intervals are cache-only — skip storage and backfill
        if is_ephemeral_interval(interval):
            effective_limit = min(
                limit or self._cfg.default_limit,
                self._cfg.max_limit,
            )
            start_s = start_ms // 1000 if start_ms else None
            end_s = end_ms // 1000 if end_ms else None
            return self._query_cache_only(key, start_s, end_s, effective_limit, t0)
        effective_limit = min(
            limit or self._cfg.default_limit,
            self._cfg.max_limit,
        )

        # Convert ms → seconds for cache queries
        start_s = start_ms // 1000 if start_ms else None
        end_s = end_ms // 1000 if end_ms else None

        # ── Step 1: Try cache ────────────────────────────────
        if start_s is not None or end_s is not None:
            cached = self._cache.query(key, start_s, end_s, effective_limit)
        else:
            cached = self._cache.get_latest(key, effective_limit)

        if cached and self._is_complete(cached, start_s, end_s, effective_limit, interval=interval):
            self._cache_hits += 1
            elapsed = time.monotonic() - t0
            return QueryResult(
                bars=cached,
                symbol=key.symbol,
                interval=key.interval,
                exchange=key.exchange,
                market_type=key.market_type,
                source=QuerySource.CACHE,
                total=len(cached),
                has_more=self._cache.series_count(key) > len(cached),
                cache_hit=True,
                metadata={"elapsed_ms": round(elapsed * 1000, 2)},
            )

        # ── Step 2: Try storage ──────────────────────────────
        storage_bars: list[BarData] = []
        backfill_triggered = False
        missing_ranges: list[MissingRange] = []

        if self._storage is not None:
            self._storage_reads += 1
            try:
                rows = self._storage.query_bars(
                    symbol=key.symbol,
                    interval=key.interval,
                    start_ms=start_ms,
                    end_ms=end_ms,
                    limit=effective_limit,
                    order="DESC",
                    exchange=key.exchange,
                    market_type=key.market_type,
                )
                rows.reverse()
                storage_bars = [BarData.from_storage_row(r) for r in rows]
            except Exception as exc:
                logger.error("Storage query failed: %s", exc, exc_info=True)

            # Warm cache with storage results
            if storage_bars:
                self._cache.bulk_load(key, storage_bars)

        # ── Step 3: Merge cache + storage ────────────────────
        merged = self._merge(cached, storage_bars)

        # ── Step 3.5: Fill interior gaps from storage ────────
        # After merging cache + storage, there may still be interior
        # gaps (missing bars in the middle).  This happens when both
        # cache AND the initial storage query have holes — e.g. the
        # browser tab was backgrounded and WS messages were lost.
        # We detect each gap and do targeted storage reads to fill them.
        if merged and self._storage is not None and len(merged) >= 2:
            merged = self._fill_interior_gaps(
                key, merged, interval, missing_ranges,
            )
            backfill_triggered = bool(missing_ranges)

        if not merged:
            # Nothing anywhere — report a missing range if enabled.
            if self._cfg.auto_backfill:
                interval_secs = parse_custom_interval(key.interval) or 60

                trigger_start_ms = start_ms
                if trigger_start_ms is None:
                    trigger_start_ms = (end_ms or int(time.time() * 1000)) - (effective_limit * interval_secs * 1000)

                missing_range = self._trigger_backfill(
                    key, trigger_start_ms, end_ms, reason="query_empty",
                )
                if missing_range is not None:
                    missing_ranges.append(missing_range)
                    backfill_triggered = self._backfill_trigger is not None

            elapsed = time.monotonic() - t0
            return QueryResult(
                bars=[],
                symbol=key.symbol,
                interval=key.interval,
                exchange=key.exchange,
                market_type=key.market_type,
                source=QuerySource.EMPTY,
                total=0,
                has_more=False,
                cache_hit=False,
                backfill_triggered=backfill_triggered,
                missing_ranges=missing_ranges,
                metadata={"elapsed_ms": round(elapsed * 1000, 2)},
            )

        # ── Step 4: Check completeness & backfill ────────────
        if (
            self._cfg.auto_backfill
            and not missing_ranges
            and not self._is_complete(merged, start_s, end_s, effective_limit, interval=interval)
        ):
            interval_secs = parse_custom_interval(key.interval) or 60
            now_ms = int(time.time() * 1000)
            earliest_bar_ms = merged[0].time * 1000
            latest_bar_ms = merged[-1].time * 1000

            # Determine which direction has a gap
            has_gap_before = (start_ms is not None and earliest_bar_ms > start_ms)
            has_gap_after = latest_bar_ms < (end_ms or now_ms) - (interval_secs * 1000)

            if has_gap_before and has_gap_after:
                # Both sides have gaps — backfill the larger gap first
                # (forward catch-up is usually more urgent)
                missing_range = self._trigger_backfill(
                    key, latest_bar_ms, end_ms, reason="query_tail_gap",
                )
            elif has_gap_after:
                # Scenario 1: Forward catch-up (e.g. app was closed overnight)
                missing_range = self._trigger_backfill(
                    key, latest_bar_ms, end_ms, reason="query_tail_gap",
                )
            elif has_gap_before:
                # Scenario 2: Backward gap (start of requested range missing)
                missing_range = self._trigger_backfill(
                    key, start_ms, earliest_bar_ms, reason="query_left_gap",
                )
            else:
                # Count-based shortfall — backfill backwards from earliest data
                needed_ms = (effective_limit - len(merged)) * interval_secs * 1000
                trigger_start = earliest_bar_ms - needed_ms
                missing_range = self._trigger_backfill(
                    key,
                    trigger_start,
                    earliest_bar_ms,
                    reason="query_shortfall",
                )
            if missing_range is not None:
                missing_ranges.append(missing_range)
                backfill_triggered = self._backfill_trigger is not None

        # Apply limit
        if len(merged) > effective_limit:
            merged = merged[-effective_limit:]

        source = QuerySource.CACHE if not storage_bars else (
            QuerySource.MIXED if cached else QuerySource.STORAGE
        )

        # ── Step 5: Detect tail gap ──────────────────────────
        # If the latest bar in the result set trails "now" by more than
        # 1.5 × interval, the front-end should keep showing a loading
        # overlay until the backfill completes and fills the gap.
        tail_gap = False
        if merged and backfill_triggered:
            interval_secs = parse_custom_interval(key.interval) or 60
            now_s = int(time.time())
            gap_s = now_s - merged[-1].time
            if gap_s > interval_secs * 1.5:
                tail_gap = True

        elapsed = time.monotonic() - t0
        return QueryResult(
            bars=merged,
            symbol=key.symbol,
            interval=key.interval,
            exchange=key.exchange,
            market_type=key.market_type,
            source=source,
            total=len(merged),
            has_more=True,  # conservative — caller can paginate
            cache_hit=bool(cached),
            backfill_triggered=backfill_triggered,
            has_tail_gap=tail_gap,
            missing_ranges=missing_ranges,
            metadata={"elapsed_ms": round(elapsed * 1000, 2)},
        )

    # ── Public: Convenience Methods ──────────────────────────

    def query_latest(
        self, symbol: str, interval: str, limit: int = 500,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> QueryResult:
        """Shorthand for getting the latest N bars."""
        return self.query(symbol, interval, limit=limit, exchange=exchange, market_type=market_type)

    def query_before(
        self,
        symbol: str,
        interval: str,
        before_ms: int,
        limit: int = 500,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> QueryResult:
        """Query bars strictly before a timestamp (for pagination)."""
        if is_custom_interval(interval):
            return self.custom_intervals.query_before(
                symbol,
                interval,
                before_ms,
                limit,
                exchange=exchange,
                market_type=market_type,
            )

        key = SeriesKey(symbol, interval, exchange=exchange, market_type=market_type)
        before_s = before_ms // 1000
        effective_limit = min(limit, self._cfg.max_limit)

        # Ephemeral intervals are cache-only — skip storage and backfill
        if is_ephemeral_interval(interval):
            cached = self._cache.get_before(key, before_s, effective_limit)
            return QueryResult(
                bars=cached,
                symbol=key.symbol,
                interval=key.interval,
                exchange=key.exchange,
                market_type=key.market_type,
                source=QuerySource.CACHE,
                total=len(cached),
                has_more=self._cache.series_count(key) > len(cached),
                cache_hit=bool(cached),
                backfill_triggered=False,
                metadata={"ephemeral": True},
            )

        # Try cache first
        cached = self._cache.get_before(key, before_s, effective_limit)

        if len(cached) >= effective_limit:
            return QueryResult(
                bars=cached,
                symbol=key.symbol,
                interval=key.interval,
                exchange=key.exchange,
                market_type=key.market_type,
                source=QuerySource.CACHE,
                total=len(cached),
                has_more=True,
                cache_hit=True,
            )

        # Fall back to storage
        storage_bars: list[BarData] = []
        if self._storage is not None:
            try:
                rows = self._storage.fetch_before(
                    symbol=key.symbol,
                    interval=key.interval,
                    before_ms=before_ms,
                    limit=effective_limit,
                    exchange=key.exchange,
                    market_type=key.market_type,
                )
                storage_bars = [BarData.from_storage_row(r) for r in rows]
                if storage_bars:
                    self._cache.bulk_load(key, storage_bars)
            except Exception as exc:
                logger.error("Storage fetch_before failed: %s", exc)

        merged = self._merge(cached, storage_bars)
        if len(merged) > effective_limit:
            merged = merged[-effective_limit:]

        backfill_triggered = False
        missing_ranges: list[MissingRange] = []
        if len(merged) < effective_limit and self._cfg.auto_backfill:
            interval_secs = parse_custom_interval(key.interval) or 60

            # Only backfill the missing portion before existing data
            if merged:
                # We have some bars — backfill from (before_ms - needed_span) up to earliest existing bar
                needed = effective_limit - len(merged)
                trigger_start_ms = merged[0].time * 1000 - (needed * interval_secs * 1000)
                trigger_end_ms = merged[0].time * 1000
            else:
                # No data at all — backfill limit bars before before_ms
                trigger_start_ms = before_ms - (effective_limit * interval_secs * 1000)
                trigger_end_ms = before_ms

            missing_range = self._trigger_backfill(
                key,
                trigger_start_ms,
                trigger_end_ms,
                reason="load_more_shortfall",
            )
            if missing_range is not None:
                missing_ranges.append(missing_range)
                backfill_triggered = self._backfill_trigger is not None

        # Determine has_more accurately:
        # - If we got a full page of results, there's likely more data
        # - If storage returned fewer bars than requested AND no backfill
        #   was triggered, there's no more data available
        # - If backfill was triggered, report has_more=True so the frontend
        #   can retry after backfill completes
        if len(merged) >= effective_limit:
            has_more = True
        elif backfill_triggered:
            has_more = True
        elif not merged and not storage_bars:
            # Nothing found anywhere — no more data
            has_more = False
        elif storage_bars and len(storage_bars) < effective_limit:
            # Storage returned less than requested — we've hit the beginning
            has_more = False
        else:
            has_more = bool(merged)

        return QueryResult(
            bars=merged,
            symbol=key.symbol,
            interval=key.interval,
            exchange=key.exchange,
            market_type=key.market_type,
            source=QuerySource.MIXED if storage_bars else QuerySource.CACHE,
            total=len(merged),
            has_more=has_more,
            cache_hit=bool(cached),
            backfill_triggered=backfill_triggered,
            missing_ranges=missing_ranges,
        )

    def get_bounds(
        self,
        symbol: str,
        interval: str,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> dict:
        """Get cache + storage bounds for a series."""
        key = SeriesKey(symbol, interval, exchange=exchange, market_type=market_type)
        ce, cl = self._cache.get_bounds(key)
        result: dict[str, Any] = {
            "cache_earliest": ce,
            "cache_latest": cl,
            "cache_count": self._cache.series_count(key),
        }

        if self._storage is not None:
            try:
                sb = self._storage.get_bounds(
                    key.symbol,
                    key.interval,
                    exchange=key.exchange,
                    market_type=key.market_type,
                )
                result.update({
                    "storage_earliest_ms": sb.get("earliest_open_time"),
                    "storage_latest_ms": sb.get("latest_open_time"),
                    "storage_count": sb.get("total_count"),
                })
            except Exception:
                result.update({
                    "storage_earliest_ms": None,
                    "storage_latest_ms": None,
                    "storage_count": None,
                })
        return result

    # ── Public: Snapshot ─────────────────────────────────────

    def snapshot(self) -> dict:
        return {
            "total_queries": self._queries,
            "cache_hits": self._cache_hits,
            "storage_reads": self._storage_reads,
            "backfills_triggered": self._backfills_triggered,
            "config": {
                "default_limit": self._cfg.default_limit,
                "max_limit": self._cfg.max_limit,
                "auto_backfill": self._cfg.auto_backfill,
            },
        }

    # ── Internal ─────────────────────────────────────────────

    def _merge(
        self, a: list[BarData], b: list[BarData],
    ) -> list[BarData]:
        """Merge two sorted bar lists, deduplicating by time.

        On conflict (same timestamp), cache data (``a``) wins because
        it is typically more recent (from the live stream), while
        storage data (``b``) may be stale backfill data.
        """
        if not a:
            return list(b)
        if not b:
            return list(a)

        combined: dict[int, BarData] = {}
        for bar in b:
            combined[bar.time] = bar  # storage first
        for bar in a:
            combined[bar.time] = bar  # cache overwrites — cache wins
        return sorted(combined.values(), key=lambda x: x.time)

    def _has_interior_gaps(
        self, bars: list[BarData], interval: str,
    ) -> bool:
        """Check if bars have interior gaps (missing bars in the middle).

        A gap is detected when the time difference between consecutive
        bars exceeds 1.5× the expected interval.  This catches cases
        where the cache has enough bars by count, but is missing data
        in the middle (e.g. due to ingestion interruptions).
        """
        if len(bars) < 2:
            return False
        interval_secs = parse_custom_interval(interval) or 60
        threshold = interval_secs * 1.5
        for i in range(1, len(bars)):
            if bars[i].time - bars[i - 1].time > threshold:
                return True
        return False

    def _detect_gaps(
        self, bars: list[BarData], interval: str,
    ) -> list[tuple[int, int]]:
        """Return a list of (gap_start_s, gap_end_s) for each interior gap.

        ``gap_start_s`` is the time of the bar *before* the gap.
        ``gap_end_s``   is the time of the bar *after*  the gap.
        """
        if len(bars) < 2:
            return []
        interval_secs = parse_custom_interval(interval) or 60
        threshold = interval_secs * 1.5
        gaps: list[tuple[int, int]] = []
        for i in range(1, len(bars)):
            if bars[i].time - bars[i - 1].time > threshold:
                gaps.append((bars[i - 1].time, bars[i].time))
        return gaps

    def _fill_interior_gaps(
        self,
        key: SeriesKey,
        bars: list[BarData],
        interval: str,
        missing_ranges: list[MissingRange] | None = None,
    ) -> list[BarData]:
        """Detect interior gaps and fill them from storage.

        For each gap found, queries storage for bars in [gap_start, gap_end]
        and merges them into the bar list.  Also warms the cache with any
        newly fetched bars.

        If storage doesn't have the data either, triggers backfill for
        each gap so the data will be available on the next query.

        Returns the (potentially augmented) bar list, still sorted.
        """
        gaps = self._detect_gaps(bars, interval)
        if not gaps:
            return bars

        logger.info(
            "Detected %d interior gap(s) in %s %s, attempting storage fill",
            len(gaps), key.symbol, key.interval,
        )

        all_fill_bars: list[BarData] = []

        for gap_start_s, gap_end_s in gaps:
            gap_start_ms = gap_start_s * 1000
            gap_end_ms = gap_end_s * 1000

            try:
                rows = self._storage.query_bars(
                    symbol=key.symbol,
                    interval=key.interval,
                    start_ms=gap_start_ms,
                    end_ms=gap_end_ms,
                    limit=5000,  # generous limit for gap fills
                    order="ASC",
                    exchange=key.exchange,
                    market_type=key.market_type,
                )
                fill_bars = [BarData.from_storage_row(r) for r in rows]
                if fill_bars:
                    all_fill_bars.extend(fill_bars)
                    logger.info(
                        "Filled gap [%d → %d] with %d bars from storage",
                        gap_start_s, gap_end_s, len(fill_bars),
                    )
                else:
                    # Storage also doesn't have data — report a missing range.
                    if self._cfg.auto_backfill:
                        logger.info(
                            "Storage has no data for gap [%d → %d], triggering backfill",
                            gap_start_s, gap_end_s,
                        )
                        missing_range = self._trigger_backfill(
                            key,
                            gap_start_ms,
                            gap_end_ms,
                            reason="query_interior_gap",
                        )
                        if missing_range is not None and missing_ranges is not None:
                            missing_ranges.append(missing_range)
            except Exception as exc:
                logger.error(
                    "Failed to fill gap [%d → %d] from storage: %s",
                    gap_start_s, gap_end_s, exc,
                )

        if all_fill_bars:
            # Warm cache with the gap-fill data
            self._cache.bulk_load(key, all_fill_bars)
            # Merge into the result
            bars = self._merge(bars, all_fill_bars)

        return bars

    def _query_cache_only(
        self,
        key: SeriesKey,
        start_s: int | None,
        end_s: int | None,
        limit: int,
        started_at: float,
    ) -> QueryResult:
        """Ephemeral interval query — cache only, no storage, no backfill.

        Used for intervals like 1s where data is never persisted to DB.
        Returns whatever is currently in the in-memory cache.
        """
        if start_s is not None or end_s is not None:
            bars = self._cache.query(key, start_s, end_s, limit)
        else:
            bars = self._cache.get_latest(key, limit)

        self._cache_hits += 1 if bars else 0
        elapsed = time.monotonic() - started_at
        return QueryResult(
            bars=bars,
            symbol=key.symbol,
            interval=key.interval,
            exchange=key.exchange,
            market_type=key.market_type,
            source=QuerySource.CACHE,
            total=len(bars),
            has_more=self._cache.series_count(key) > len(bars),
            cache_hit=bool(bars),
            backfill_triggered=False,
            metadata={"elapsed_ms": round(elapsed * 1000, 2), "ephemeral": True},
        )

    def _is_complete(
        self,
        bars: list[BarData],
        start_s: int | None,
        end_s: int | None,
        limit: int,
        interval: str | None = None,
    ) -> bool:
        """Heuristic: does the cache result satisfy the query?

        Now also checks for **interior gaps** — even if the bar count
        is sufficient, hidden gaps in the middle mean the data is
        incomplete and we must fall through to storage.
        """
        if not bars:
            return False

        # Even if count is enough, check for interior gaps first
        if interval and self._has_interior_gaps(bars, interval):
            logger.debug(
                "Cache has %d bars but interior gaps detected for %s",
                len(bars), interval,
            )
            return False

        # Check data freshness: if no explicit end bound was requested
        # (i.e. "give me the latest N bars"), verify the newest bar
        # isn't stale.  Without this, prewarm data from days ago can
        # satisfy count >= limit and skip backfill entirely.
        if interval and end_s is None:
            interval_secs = parse_custom_interval(interval) or 60
            now_s = int(time.time())
            staleness = now_s - bars[-1].time
            if staleness > interval_secs * 2:
                logger.debug(
                    "Cache data stale for %s: latest=%d now=%d gap=%ds (%.1f intervals behind)",
                    interval, bars[-1].time, now_s, staleness,
                    staleness / interval_secs,
                )
                return False

        if len(bars) >= limit:
            return True
            
        # If no explicit bounds were requested, we CANNOT be complete if we missed the limit
        if start_s is None and end_s is None:
            return False
            
        # If the query had explicit bounds, check coverage
        if start_s is not None and bars[0].time > start_s:
            return False
        if end_s is not None and bars[-1].time < end_s:
            return False
        return True

    def _trigger_backfill(
        self,
        key: SeriesKey,
        start_ms: int | None,
        end_ms: int | None,
        *,
        reason: str = "query_gap",
    ) -> MissingRange | None:
        """Fire the backfill trigger callback.

        All callers should compute meaningful start/end values before
        calling this method.  The fallback here is a safety net only.
        """
        now_ms = int(time.time() * 1000)
        effective_end = end_ms if end_ms is not None else now_ms

        if start_ms is not None:
            effective_start = start_ms
        else:
            # Safety fallback: backfill at most 24 hours instead of from epoch 0
            effective_start = max(0, effective_end - 86_400_000)
            logger.warning(
                "Backfill start_ms is None for %s — "
                "defaulting to 24h lookback (%d → %d)",
                key, effective_start, effective_end,
            )

        missing_range = MissingRange(
            symbol=key.symbol,
            interval=key.interval,
            exchange=key.exchange,
            market_type=key.market_type,
            start_ms=int(effective_start),
            end_ms=int(effective_end),
            reason=reason,
        )
        if self._backfill_trigger is None:
            return missing_range

        self._backfills_triggered += 1
        try:
            self._backfill_trigger(
                key.symbol,
                key.interval,
                int(effective_start),
                int(effective_end),
                key.exchange,
                key.market_type,
            )
            return missing_range
        except Exception as exc:
            logger.error("Backfill trigger failed: %s", exc, exc_info=True)
            return missing_range

    def note_backfill_triggered(self, count: int = 1) -> None:
        """Record externally submitted backfill requests in query metrics."""
        self._backfills_triggered += max(0, count)
