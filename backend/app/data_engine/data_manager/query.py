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

import calendar
import logging
import time
from typing import Any, Callable

from datetime import datetime, timezone

from app.core.market import (
    aggregate_rows_by_month,
    compute_month_bucket,
    find_best_base_interval,
    is_custom_interval,
    is_monthly_interval,
    parse_custom_interval,
    parse_monthly_count,
)

from .cache import BarCache
from .config import QueryConfig
from .models import BarData, QueryResult, QuerySource, SeriesKey, StorageBackend

logger = logging.getLogger("data_manager.query")

# Signature for the optional backfill trigger callback
BackfillTrigger = Callable[[str, str, int, int], None]


def _aggregate_rows_to_interval(
    base_rows: list[dict],
    custom_interval_seconds: int,
) -> list[dict]:
    """Aggregate lightweight-chart rows into a custom interval."""
    if not base_rows:
        return []

    buckets: dict[int, list[dict]] = {}
    for row in base_rows:
        ts = row["time"]
        bucket_start = (ts // custom_interval_seconds) * custom_interval_seconds
        buckets.setdefault(bucket_start, []).append(row)

    result: list[dict] = []
    for bucket_start in sorted(buckets):
        rows = sorted(buckets[bucket_start], key=lambda r: r["time"])
        result.append({
            "time": bucket_start,
            "open": rows[0]["open"],
            "high": max(r["high"] for r in rows),
            "low": min(r["low"] for r in rows),
            "close": rows[-1]["close"],
            "volume": round(sum(r["volume"] for r in rows), 8),
        })
    return result


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

    # ── Public: Main Query ───────────────────────────────────

    def query(
        self,
        symbol: str,
        interval: str,
        start_ms: int | None = None,
        end_ms: int | None = None,
        limit: int | None = None,
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
        """
        t0 = time.monotonic()
        self._queries += 1

        if is_custom_interval(interval):
            return self._query_custom_from_base(
                symbol=symbol,
                interval=interval,
                start_ms=start_ms,
                end_ms=end_ms,
                limit=limit,
                started_at=t0,
            )

        key = SeriesKey(symbol, interval)
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
                source=QuerySource.CACHE,
                total=len(cached),
                has_more=self._cache.series_count(key) > len(cached),
                cache_hit=True,
                metadata={"elapsed_ms": round(elapsed * 1000, 2)},
            )

        # ── Step 2: Try storage ──────────────────────────────
        storage_bars: list[BarData] = []
        backfill_triggered = False

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
            merged = self._fill_interior_gaps(key, merged, interval)

        if not merged:
            # Nothing anywhere — trigger backfill if enabled
            if self._cfg.auto_backfill and self._backfill_trigger:
                interval_secs = parse_custom_interval(key.interval) or 60

                trigger_start_ms = start_ms
                if trigger_start_ms is None:
                    trigger_start_ms = (end_ms or int(time.time() * 1000)) - (effective_limit * interval_secs * 1000)

                self._trigger_backfill(key, trigger_start_ms, end_ms)
                backfill_triggered = True

            elapsed = time.monotonic() - t0
            return QueryResult(
                bars=[],
                symbol=key.symbol,
                interval=key.interval,
                source=QuerySource.EMPTY,
                total=0,
                has_more=False,
                cache_hit=False,
                backfill_triggered=backfill_triggered,
                metadata={"elapsed_ms": round(elapsed * 1000, 2)},
            )

        # ── Step 4: Check completeness & backfill ────────────
        if (
            self._cfg.auto_backfill
            and self._backfill_trigger
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
                self._trigger_backfill(key, latest_bar_ms, end_ms)
                backfill_triggered = True
            elif has_gap_after:
                # Scenario 1: Forward catch-up (e.g. app was closed overnight)
                self._trigger_backfill(key, latest_bar_ms, end_ms)
                backfill_triggered = True
            elif has_gap_before:
                # Scenario 2: Backward gap (start of requested range missing)
                self._trigger_backfill(key, start_ms, earliest_bar_ms)
                backfill_triggered = True
            else:
                # Count-based shortfall — backfill backwards from earliest data
                needed_ms = (effective_limit - len(merged)) * interval_secs * 1000
                trigger_start = earliest_bar_ms - needed_ms
                self._trigger_backfill(key, trigger_start, earliest_bar_ms)
                backfill_triggered = True

        # Apply limit
        if len(merged) > effective_limit:
            merged = merged[-effective_limit:]

        source = QuerySource.CACHE if not storage_bars else (
            QuerySource.MIXED if cached else QuerySource.STORAGE
        )

        elapsed = time.monotonic() - t0
        return QueryResult(
            bars=merged,
            symbol=key.symbol,
            interval=key.interval,
            source=source,
            total=len(merged),
            has_more=True,  # conservative — caller can paginate
            cache_hit=bool(cached),
            backfill_triggered=backfill_triggered,
            metadata={"elapsed_ms": round(elapsed * 1000, 2)},
        )

    # ── Public: Convenience Methods ──────────────────────────

    def query_latest(
        self, symbol: str, interval: str, limit: int = 500,
    ) -> QueryResult:
        """Shorthand for getting the latest N bars."""
        return self.query(symbol, interval, limit=limit)

    def query_before(
        self,
        symbol: str,
        interval: str,
        before_ms: int,
        limit: int = 500,
    ) -> QueryResult:
        """Query bars strictly before a timestamp (for pagination).

        Useful for "load more" / infinite scroll in the chart.
        """
        if is_custom_interval(interval):
            return self._query_custom_before(symbol, interval, before_ms, limit)

        key = SeriesKey(symbol, interval)
        before_s = before_ms // 1000
        effective_limit = min(limit, self._cfg.max_limit)

        # Try cache first
        cached = self._cache.get_before(key, before_s, effective_limit)

        if len(cached) >= effective_limit:
            return QueryResult(
                bars=cached,
                symbol=key.symbol,
                interval=key.interval,
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
        if len(merged) < effective_limit and self._cfg.auto_backfill and self._backfill_trigger:
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

            self._trigger_backfill(key, trigger_start_ms, trigger_end_ms)
            backfill_triggered = True

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
            source=QuerySource.MIXED if storage_bars else QuerySource.CACHE,
            total=len(merged),
            has_more=has_more,
            cache_hit=bool(cached),
            backfill_triggered=backfill_triggered,
        )

    def _query_custom_from_base(
        self,
        symbol: str,
        interval: str,
        start_ms: int | None,
        end_ms: int | None,
        limit: int | None,
        started_at: float,
    ) -> QueryResult:
        """Serve custom intervals by aggregating a single base interval on read.

        This deliberately avoids trusting persisted custom-interval rows,
        which may have been generated by older aggregation logic.  The
        returned bars are rebuilt from the authoritative standard-interval
        series (cache + storage + backfill), then cached under the custom key
        for downstream consumers.
        """
        custom_seconds = parse_custom_interval(interval)
        if custom_seconds is None:
            return QueryResult(
                bars=[],
                symbol=symbol.upper(),
                interval=interval,
                source=QuerySource.EMPTY,
                total=0,
                has_more=False,
                cache_hit=False,
                metadata={"elapsed_ms": round((time.monotonic() - started_at) * 1000, 2)},
            )

        effective_limit = min(limit or self._cfg.default_limit, self._cfg.max_limit)
        base_interval, factor = find_best_base_interval(custom_seconds, interval=interval)
        custom_ms = custom_seconds * 1000

        # For monthly intervals, align start to calendar-month boundaries
        month_count = parse_monthly_count(interval)
        aligned_start_ms = None
        if start_ms is not None:
            if month_count is not None:
                from app.core.market import compute_month_bucket_ms
                aligned_start_ms = compute_month_bucket_ms(start_ms, month_count)
            else:
                aligned_start_ms = (start_ms // custom_ms) * custom_ms

        if start_ms is not None and end_ms is not None:
            estimated_custom = max(1, ((end_ms - aligned_start_ms) // custom_ms) + 2)
            base_limit = estimated_custom * factor + factor
        else:
            # Add extra `factor` to ensure the last custom bucket has all
            # its base-interval components — without this the final candle
            # may be built from an incomplete set of base bars.
            base_limit = (effective_limit + 2) * factor + factor

        base_result = self.query(
            symbol,
            base_interval,
            start_ms=aligned_start_ms,
            end_ms=end_ms,
            limit=base_limit,
        )
        derived_bars = self._aggregate_custom_bars(
            base_result.bars,
            interval=interval,
            start_ms=start_ms,
            end_ms=end_ms,
        )
        if len(derived_bars) > effective_limit:
            derived_bars = derived_bars[-effective_limit:]

        key = SeriesKey(symbol, interval)
        if derived_bars:
            self._cache.bulk_load(key, derived_bars)

        elapsed = time.monotonic() - started_at
        return QueryResult(
            bars=derived_bars,
            symbol=key.symbol,
            interval=key.interval,
            source=base_result.source,
            total=len(derived_bars),
            has_more=base_result.has_more or len(derived_bars) >= effective_limit,
            cache_hit=base_result.cache_hit,
            backfill_triggered=base_result.backfill_triggered,
            metadata={
                "elapsed_ms": round(elapsed * 1000, 2),
                "derived_from": base_interval,
                "aggregation_factor": factor,
                "base_source": base_result.source.value,
            },
        )

    def _query_custom_before(
        self,
        symbol: str,
        interval: str,
        before_ms: int,
        limit: int,
    ) -> QueryResult:
        """Paginate custom intervals by rebuilding them from base bars."""
        started_at = time.monotonic()
        custom_seconds = parse_custom_interval(interval)
        if custom_seconds is None:
            return QueryResult(
                bars=[],
                symbol=symbol.upper(),
                interval=interval,
                source=QuerySource.EMPTY,
                total=0,
                has_more=False,
                cache_hit=False,
            )

        effective_limit = min(limit, self._cfg.max_limit)
        base_interval, factor = find_best_base_interval(custom_seconds, interval=interval)
        custom_ms = custom_seconds * 1000

        # For monthly intervals, align to calendar-month boundaries
        month_count = parse_monthly_count(interval)
        if month_count is not None:
            from app.core.market import compute_month_bucket_ms, next_month_bucket
            last_bucket_start_ms = compute_month_bucket_ms(before_ms - 1, month_count)
            base_end_ms = next_month_bucket(last_bucket_start_ms // 1000, month_count) * 1000 - 1
        else:
            last_bucket_start_ms = ((before_ms - 1) // custom_ms) * custom_ms
            base_end_ms = last_bucket_start_ms + custom_ms - 1
        base_limit = (effective_limit + 2) * factor

        base_result = self.query(
            symbol,
            base_interval,
            end_ms=base_end_ms,
            limit=base_limit,
        )
        derived_bars = self._aggregate_custom_bars(
            base_result.bars,
            interval=interval,
            end_ms=base_end_ms,
        )
        derived_bars = [bar for bar in derived_bars if bar.time_ms < before_ms]
        if len(derived_bars) > effective_limit:
            derived_bars = derived_bars[-effective_limit:]

        key = SeriesKey(symbol, interval)
        if derived_bars:
            self._cache.bulk_load(key, derived_bars)

        return QueryResult(
            bars=derived_bars,
            symbol=key.symbol,
            interval=key.interval,
            source=base_result.source,
            total=len(derived_bars),
            has_more=bool(derived_bars) or base_result.backfill_triggered,
            cache_hit=base_result.cache_hit,
            backfill_triggered=base_result.backfill_triggered,
            metadata={
                "elapsed_ms": round((time.monotonic() - started_at) * 1000, 2),
                "derived_from": base_interval,
                "aggregation_factor": factor,
                "base_source": base_result.source.value,
            },
        )

    def get_bounds(self, symbol: str, interval: str) -> dict:
        """Get cache + storage bounds for a series.

        Returns::
            {
                "cache_earliest": int | None,  # seconds
                "cache_latest": int | None,
                "cache_count": int,
                "storage_earliest_ms": int | None,
                "storage_latest_ms": int | None,
                "storage_count": int | None,
            }
        """
        key = SeriesKey(symbol, interval)
        ce, cl = self._cache.get_bounds(key)
        result: dict[str, Any] = {
            "cache_earliest": ce,
            "cache_latest": cl,
            "cache_count": self._cache.series_count(key),
        }

        if self._storage is not None:
            try:
                sb = self._storage.get_bounds(key.symbol, key.interval)
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

    def _aggregate_custom_bars(
        self,
        base_bars: list[BarData],
        interval: str,
        start_ms: int | None = None,
        end_ms: int | None = None,
    ) -> list[BarData]:
        """Aggregate standard-interval bars into a custom interval.

        For monthly intervals (e.g. '2M', '3M'), uses calendar-month
        aligned bucketing instead of fixed-duration bucketing.
        """
        custom_seconds = parse_custom_interval(interval)
        if custom_seconds is None or not base_bars:
            return []

        month_count = parse_monthly_count(interval)
        if month_count is not None:
            # Use calendar-month aligned aggregation
            aggregated = aggregate_rows_by_month(
                [bar.to_dict() for bar in base_bars],
                months=month_count,
            )
        else:
            aggregated = _aggregate_rows_to_interval(
                [bar.to_dict() for bar in base_bars],
                custom_seconds,
            )
        result = [BarData.from_dict(row) for row in aggregated]
        if start_ms is not None:
            result = [bar for bar in result if bar.time_ms >= start_ms]
        if end_ms is not None:
            result = [bar for bar in result if bar.time_ms <= end_ms]
        return result

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
                )
                fill_bars = [BarData.from_storage_row(r) for r in rows]
                if fill_bars:
                    all_fill_bars.extend(fill_bars)
                    logger.info(
                        "Filled gap [%d → %d] with %d bars from storage",
                        gap_start_s, gap_end_s, len(fill_bars),
                    )
                else:
                    # Storage also doesn't have data — trigger backfill
                    if self._cfg.auto_backfill and self._backfill_trigger:
                        logger.info(
                            "Storage has no data for gap [%d → %d], triggering backfill",
                            gap_start_s, gap_end_s,
                        )
                        self._trigger_backfill(key, gap_start_ms, gap_end_ms)
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
        self, key: SeriesKey, start_ms: int | None, end_ms: int | None,
    ) -> None:
        """Fire the backfill trigger callback.

        All callers should compute meaningful start/end values before
        calling this method.  The fallback here is a safety net only.
        """
        if self._backfill_trigger is None:
            return
        self._backfills_triggered += 1

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

        try:
            self._backfill_trigger(
                key.symbol,
                key.interval,
                effective_start,
                effective_end,
            )
        except Exception as exc:
            logger.error("Backfill trigger failed: %s", exc, exc_info=True)
