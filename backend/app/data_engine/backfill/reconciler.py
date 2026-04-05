"""
Reconciler — deduplicates, aggregates custom intervals, writes to DB, and pushes to cache.

Responsibilities:
  * Receive ``FetchResult`` objects from the Historical Fetcher
  * Deduplicate against existing DB data (skip / overwrite / newer_wins)
  * Aggregate standard-interval bars into custom-interval candles
    — **preferring** BarAggregator when available (DRY compliance)
    — falling back to built-in ``_default_aggregate`` when aggregator is not set
  * Write bars to ``StorageBackend`` in batches
  * Push recent bars to ``CacheBackend`` (optional)
  * Report per-phase statistics via ``ReconcileResult``

Extension points:
  * ``set_bar_aggregator(agg)``      — use BarAggregator for custom aggregation
  * ``set_custom_aggregator(fn)``    — override OHLCV aggregation logic
  * ``set_dedup_fn(fn)``             — override deduplication logic
  * ``on_write_batch(callback)``     — per-batch callback
  * ``on_reconcile_done(callback)``  — completion callback

Usage::

    reconciler = Reconciler(config, storage, cache=my_cache)

    # Recommended: plug in the BarAggregator for consistent custom bars
    reconciler.set_bar_aggregator(bar_aggregator)

    result = await reconciler.reconcile(fetch_results, plan)
"""
from __future__ import annotations

import logging
import time
from typing import Callable, Awaitable, Any

from ..ingestion.metrics import LayerMetrics
from .config import BackfillConfig
from .models import (
    BackfillPlan,
    BackfillStatus,
    CacheBackend,
    DeduplicationStrategy,
    FetchedBar,
    FetchResult,
    IntervalDecomposition,
    ReconcileResult,
    StorageBackend,
    parse_interval_ms,
)
from app.core.market import compute_bucket_start_ms

logger = logging.getLogger("backfill.Reconciler")

# Type aliases
CustomAggregator = Callable[[list[FetchedBar], str, int, int, int], FetchedBar | None]
DedupFn = Callable[[FetchedBar, dict], bool]  # (new_bar, existing_row) → keep_new?
WriteBatchCallback = Callable[[str, str, int], Awaitable[None]]  # symbol, interval, count
ReconcileDoneCallback = Callable[[ReconcileResult], Awaitable[None]]


class Reconciler:
    """Deduplicates fetched data, generates custom candles, writes to storage."""

    def __init__(
        self,
        config: BackfillConfig,
        storage: StorageBackend,
        cache: CacheBackend | None = None,
    ) -> None:
        self._cfg = config
        self._storage = storage
        self._cache = cache
        self._metrics = LayerMetrics("Reconciler")

        # Extension points
        self._custom_aggregator: CustomAggregator | None = None
        self._custom_dedup_fn: DedupFn | None = None
        self._bar_aggregator: Any = None  # BarAggregator instance (optional)
        self._write_batch_callbacks: list[WriteBatchCallback] = []
        self._done_callbacks: list[ReconcileDoneCallback] = []

    # ── Public: Metrics / Snapshot ───────────────────────────

    @property
    def metrics(self) -> LayerMetrics:
        return self._metrics

    def snapshot(self) -> dict:
        return {
            "component": "Reconciler",
            "dedup_strategy": self._cfg.reconcile_dedup_strategy,
            "write_batch_size": self._cfg.reconcile_write_batch_size,
            "cache_enabled": self._cfg.reconcile_enable_cache_push,
            "metrics": self._metrics.snapshot(),
        }

    # ── Public: Extension points ─────────────────────────────

    def set_custom_aggregator(self, fn: CustomAggregator) -> None:
        """Override the OHLCV aggregation logic for custom intervals.

        The function signature::

            (bars: list[FetchedBar], symbol: str, custom_interval: str,
             bucket_start_ms: int, bucket_end_ms: int) → FetchedBar | None

        Example::

            def my_agg(bars, symbol, interval, start, end):
                if not bars:
                    return None
                return FetchedBar(
                    symbol=symbol, interval=interval,
                    open_time=start, close_time=end,
                    open=bars[0].open, high=max(b.high for b in bars),
                    low=min(b.low for b in bars), close=bars[-1].close,
                    volume=sum(b.volume for b in bars),
                )
            reconciler.set_custom_aggregator(my_agg)
        """
        self._custom_aggregator = fn

    def set_dedup_fn(self, fn: DedupFn) -> None:
        """Override the deduplication decision.

        The function receives ``(new_bar, existing_row_dict)`` and returns
        ``True`` if the new bar should replace the existing one.
        """
        self._custom_dedup_fn = fn

    def set_bar_aggregator(self, aggregator: Any) -> None:
        """Plug in a BarAggregator for custom-interval aggregation.

        When set, backfill data for custom intervals is routed through
        the BarAggregator's ``on_backfill_bars()`` method instead of
        the built-in ``_default_aggregate``.  This guarantees the same
        bucketing, alignment, and OHLCV merge logic is used for both
        live and historical data (DRY compliance).

        Args:
            aggregator: A ``BarAggregator`` instance.

        Example::

            reconciler.set_bar_aggregator(data_manager.bar_aggregator)
        """
        self._bar_aggregator = aggregator
        logger.info("Reconciler: BarAggregator integration enabled")

    def on_write_batch(self, callback: WriteBatchCallback) -> None:
        """Register a callback invoked after each DB write batch."""
        self._write_batch_callbacks.append(callback)

    def on_reconcile_done(self, callback: ReconcileDoneCallback) -> None:
        """Register a callback invoked when reconciliation completes."""
        self._done_callbacks.append(callback)

    # ── Public: Reconcile ────────────────────────────────────

    async def reconcile(
        self,
        fetch_results: list[FetchResult],
        plan: BackfillPlan,
    ) -> ReconcileResult:
        """Run the full reconciliation pipeline.

        Steps:
          1. Collect all bars from fetch results
          2. Deduplicate against DB
          3. Write standard-interval bars
          4. Generate and write custom-interval bars
          5. Push recent bars to cache

        Args:
            fetch_results: Results from the Historical Fetcher.
            plan:          The backfill plan (for decomposition info).

        Returns:
            A ``ReconcileResult`` summarizing what happened.
        """
        start = time.monotonic()
        self._metrics.inc("reconcile_runs")
        self._metrics.mark("last_reconcile_at")

        result = ReconcileResult()

        try:
            # 1. Collect all bars grouped by (market_type, symbol, interval)
            grouped = self._group_bars(fetch_results)
            total_received = sum(len(bars) for bars in grouped.values())
            result.bars_received = total_received

            # 2 & 3. Dedup + write standard bars
            for (market_type, symbol, interval), bars in grouped.items():
                written, skipped, deduped = await self._dedup_and_write(
                    symbol, interval, bars, market_type=market_type,
                )
                result.bars_written += written
                result.bars_skipped += skipped
                result.bars_deduplicated += deduped

            # 4. Generate custom-interval bars
            if self._cfg.reconcile_generate_custom and plan.custom_intervals:
                for decomp in plan.decompositions:
                    gen, wrt = await self._generate_custom_bars(
                        decomp, grouped,
                    )
                    result.custom_bars_generated += gen
                    result.custom_bars_written += wrt

            # 5. Push to cache
            if self._cfg.reconcile_enable_cache_push and self._cache is not None:
                cached = await self._push_to_cache(grouped)
                result.bars_cached = cached

        except Exception as exc:
            result.errors.append(str(exc))
            self._metrics.inc("reconcile_errors")
            logger.error("Reconciliation error: %s", exc, exc_info=True)

        result.elapsed_ms = int((time.monotonic() - start) * 1000)

        # Fire done callbacks
        for cb in self._done_callbacks:
            try:
                await cb(result)
            except Exception as exc:
                logger.error("Reconcile done callback error: %s", exc)

        self._metrics.inc("bars_written", result.bars_written)
        self._metrics.inc("bars_skipped", result.bars_skipped)
        logger.info(
            "Reconciliation done: received=%d written=%d skipped=%d "
            "custom_gen=%d cached=%d in %dms",
            result.bars_received, result.bars_written, result.bars_skipped,
            result.custom_bars_generated, result.bars_cached, result.elapsed_ms,
        )
        return result

    # ── Internal: Group bars ─────────────────────────────────

    @staticmethod
    def _group_bars(
        fetch_results: list[FetchResult],
    ) -> dict[tuple[str, str, str], list[FetchedBar]]:
        """Group all fetched bars by (market_type, symbol, interval)."""
        grouped: dict[tuple[str, str, str], list[FetchedBar]] = {}
        for fr in fetch_results:
            if fr.status == BackfillStatus.FAILED:
                continue
            for bar in fr.bars:
                key = (bar.market_type, bar.symbol, bar.interval)
                grouped.setdefault(key, []).append(bar)

        # Sort each group by open_time
        for bars in grouped.values():
            bars.sort(key=lambda b: b.open_time)

        return grouped

    # ── Internal: Dedup + Write ──────────────────────────────

    async def _dedup_and_write(
        self,
        symbol: str,
        interval: str,
        bars: list[FetchedBar],
        market_type: str = "spot",
    ) -> tuple[int, int, int]:
        """Deduplicate bars against DB and write in batches.

        Returns (written, skipped, deduplicated).
        """
        if not bars:
            return 0, 0, 0

        strategy = DeduplicationStrategy(self._cfg.reconcile_dedup_strategy)
        batch_size = self._cfg.reconcile_write_batch_size

        # Get existing open_times for dedup
        min_ot = bars[0].open_time
        max_ot = bars[-1].open_time
        try:
            existing = await self._storage.get_existing_open_times(
                symbol, interval, min_ot, max_ot, market_type=market_type,
            )
        except Exception:
            existing = set()

        to_write: list[FetchedBar] = []
        skipped = 0
        deduped = 0

        for bar in bars:
            if bar.open_time in existing:
                deduped += 1
                keep_new = self._should_replace(bar, strategy)
                if not keep_new:
                    skipped += 1
                    continue
            to_write.append(bar)

        # Write in batches
        written = 0
        for i in range(0, len(to_write), batch_size):
            batch = to_write[i : i + batch_size]
            dicts = [b.to_storage_dict() for b in batch]
            try:
                n = await self._storage.upsert_bars(
                    symbol, interval, dicts, source="backfill", market_type=market_type,
                )
                written += n
                await self._fire_write_batch(symbol, interval, n)
            except Exception as exc:
                logger.error(
                    "Write batch failed for %s@%s: %s",
                    symbol, interval, exc, exc_info=True,
                )
                self._metrics.inc("write_errors")

        return written, skipped, deduped

    def _should_replace(
        self, bar: FetchedBar, strategy: DeduplicationStrategy,
    ) -> bool:
        """Decide whether to replace an existing bar."""
        if self._custom_dedup_fn is not None:
            return self._custom_dedup_fn(bar, {})

        if strategy == DeduplicationStrategy.SKIP:
            return False
        if strategy == DeduplicationStrategy.OVERWRITE:
            return True
        # NEWER_WINS — without querying the existing row's timestamp,
        # we default to keeping new (backfill data is presumably correct)
        return True

    # ── Internal: Custom interval aggregation ────────────────

    async def _generate_custom_bars(
        self,
        decomp: IntervalDecomposition,
        grouped: dict[tuple[str, str, str], list[FetchedBar]],
    ) -> tuple[int, int]:
        """Aggregate standard bars into custom-interval candles.

        When a BarAggregator is available, component bars are fed through
        it via ``on_backfill_bars()`` — this reuses the exact same L1–L5
        pipeline (TimeBucket, BarState, Finalizer, Publisher) that handles
        live data, ensuring perfect consistency.

        When no BarAggregator is available, falls back to the built-in
        ``_aggregate_to_custom`` implementation.

        Returns (generated, written).
        """
        custom_iv = decomp.custom_interval
        custom_ms = decomp.custom_duration_ms
        generated = 0
        written = 0

        # Collect all component bars for each symbol
        symbols: set[str] = set()
        component_bars: dict[tuple[str, str], list[FetchedBar]] = {}  # (market_type, symbol) → sorted bars

        for comp in decomp.components:
            for (market_type, sym, iv), bars in grouped.items():
                if iv == comp.interval:
                    symbols.add((market_type, sym))
                    component_bars.setdefault((market_type, sym), []).extend(bars)

        for market_type, symbol in symbols:
            bars = component_bars.get((market_type, symbol), [])
            if not bars:
                continue

            bars.sort(key=lambda b: b.open_time)
            bucket_min_ms, bucket_max_ms = self._custom_bucket_bounds(
                bars, custom_ms, decomp.alignment_epoch_ms,
                custom_interval=custom_iv,
            )

            # ── Route through BarAggregator if available ─────
            if self._bar_aggregator is not None:
                try:
                    # Ensure the custom interval target is registered
                    self._bar_aggregator.add_target(symbol, custom_iv, market_type=market_type)

                    # Feed component bars strictly in global chronological order.
                    # Grouping by source interval first breaks ordering for mixed
                    # decompositions such as 7m -> 5m + 1m + 1m, which can close a
                    # custom bucket before all of its components have arrived.
                    for bar in bars:
                        await self._bar_aggregator.on_backfill_bars(
                            symbol, bar.interval, [bar.to_dict()], market_type=market_type,
                        )

                    # Collect generated bars from BarAggregator's state
                    recent = self._bar_aggregator.get_recent_bars(
                        symbol, custom_iv, limit=10000, market_type=market_type,
                    )
                    custom_bars_from_agg = []
                    for bar_state in recent:
                        if not (bucket_min_ms <= bar_state.bucket_start_ms <= bucket_max_ms):
                            continue
                        custom_bars_from_agg.append(FetchedBar(
                            symbol=symbol,
                            interval=custom_iv,
                            open_time=bar_state.bucket_start_ms,
                            close_time=bar_state.bucket_end_ms - 1,
                            open=bar_state.open,
                            high=bar_state.high,
                            low=bar_state.low,
                            close=bar_state.close,
                            volume=bar_state.volume,
                            market_type=market_type,
                            quote_volume=bar_state.quote_volume,
                            trades=bar_state.trades,
                            taker_buy_base=bar_state.taker_buy_base,
                            taker_buy_quote=bar_state.taker_buy_quote,
                            source="backfill_aggregated_via_bar_agg",
                        ))
                    custom_bars_from_agg.sort(key=lambda b: b.open_time)
                    generated += len(custom_bars_from_agg)

                    # Write to storage
                    batch_size = self._cfg.reconcile_write_batch_size
                    for i in range(0, len(custom_bars_from_agg), batch_size):
                        batch = custom_bars_from_agg[i : i + batch_size]
                        dicts = [b.to_storage_dict() for b in batch]
                        try:
                            n = await self._storage.upsert_bars(
                                symbol, custom_iv, dicts,
                                source="backfill_aggregated",
                                market_type=market_type,
                            )
                            written += n
                        except Exception as exc:
                            logger.error(
                                "Custom bar write (via aggregator) failed "
                                "for %s@%s: %s",
                                symbol, custom_iv, exc, exc_info=True,
                            )
                    logger.debug(
                        "Custom bars via BarAggregator: %s@%s → %d bars",
                        symbol, custom_iv, len(custom_bars_from_agg),
                    )
                    continue  # skip fallback path for this symbol

                except Exception as exc:
                    logger.warning(
                        "BarAggregator path failed for %s@%s, "
                        "falling back to built-in: %s",
                        symbol, custom_iv, exc,
                    )
                    # Fall through to built-in aggregation

            # ── Fallback: built-in aggregation ───────────────
            custom_bars = self._aggregate_to_custom(
                bars, symbol, custom_iv, custom_ms,
                decomp.alignment_epoch_ms,
            )
            generated += len(custom_bars)

            # Write custom bars
            batch_size = self._cfg.reconcile_write_batch_size
            for i in range(0, len(custom_bars), batch_size):
                batch = custom_bars[i : i + batch_size]
                dicts = [b.to_storage_dict() for b in batch]
                try:
                    n = await self._storage.upsert_bars(
                        symbol, custom_iv, dicts, source="backfill_aggregated", market_type=market_type,
                    )
                    written += n
                except Exception as exc:
                    logger.error(
                        "Custom bar write failed for %s@%s: %s",
                        symbol, custom_iv, exc, exc_info=True,
                    )

        return generated, written

    @staticmethod
    def _custom_bucket_bounds(
        bars: list[FetchedBar],
        custom_ms: int,
        epoch_ms: int,
        *,
        custom_interval: str | None = None,
    ) -> tuple[int, int]:
        """Return inclusive min/max custom bucket starts touched by *bars*."""
        first_open = min(bar.open_time for bar in bars)
        last_open = max(bar.open_time for bar in bars)
        bucket_min = compute_bucket_start_ms(first_open, custom_ms, interval=custom_interval)
        bucket_max = compute_bucket_start_ms(last_open, custom_ms, interval=custom_interval)
        return bucket_min, bucket_max

    def _aggregate_to_custom(
        self,
        bars: list[FetchedBar],
        symbol: str,
        custom_interval: str,
        custom_ms: int,
        epoch_ms: int,
    ) -> list[FetchedBar]:
        """Aggregate component bars into custom-interval candles."""
        if not bars:
            return []

        result: list[FetchedBar] = []

        # Assign each bar to a custom bucket
        buckets: dict[int, list[FetchedBar]] = {}
        for bar in bars:
            bucket_start = compute_bucket_start_ms(bar.open_time, custom_ms, interval=custom_interval)
            buckets.setdefault(bucket_start, []).append(bar)

        for bucket_start in sorted(buckets.keys()):
            bucket_bars = buckets[bucket_start]
            bucket_bars.sort(key=lambda b: b.open_time)
            bucket_end = bucket_start + custom_ms - 1

            if self._custom_aggregator is not None:
                agg = self._custom_aggregator(
                    bucket_bars, symbol, custom_interval,
                    bucket_start, bucket_end,
                )
            else:
                agg = self._default_aggregate(
                    bucket_bars, symbol, custom_interval,
                    bucket_start, bucket_end,
                )

            if agg is not None:
                result.append(agg)

        return result

    @staticmethod
    def _default_aggregate(
        bars: list[FetchedBar],
        symbol: str,
        custom_interval: str,
        bucket_start: int,
        bucket_end: int,
    ) -> FetchedBar | None:
        """Default OHLCV aggregation: standard candle merge."""
        if not bars:
            return None

        return FetchedBar(
            symbol=symbol,
            interval=custom_interval,
            open_time=bucket_start,
            close_time=bucket_end,
            open=bars[0].open,
            high=max(b.high for b in bars),
            low=min(b.low for b in bars),
            close=bars[-1].close,
            volume=sum(b.volume for b in bars),
            quote_volume=sum(b.quote_volume for b in bars),
            trades=sum(b.trades for b in bars),
            taker_buy_base=sum(b.taker_buy_base for b in bars),
            taker_buy_quote=sum(b.taker_buy_quote for b in bars),
            source="backfill_aggregated",
        )

    # ── Internal: Cache push ─────────────────────────────────

    async def _push_to_cache(
        self,
        grouped: dict[tuple[str, str, str], list[FetchedBar]],
    ) -> int:
        """Push recent bars to the cache backend."""
        if self._cache is None:
            return 0

        now_ms = int(time.time() * 1000)
        window = self._cfg.reconcile_cache_window_ms
        cutoff = now_ms - window
        total_cached = 0

        for (market_type, symbol, interval), bars in grouped.items():
            recent = [b for b in bars if b.open_time >= cutoff]
            if not recent:
                continue
            try:
                dicts = [b.to_lightweight() for b in recent]
                try:
                    n = await self._cache.push_bars(symbol, interval, dicts, market_type=market_type)
                except TypeError:
                    n = await self._cache.push_bars(symbol, interval, dicts)
                total_cached += n
            except Exception as exc:
                logger.warning(
                    "Cache push failed for %s:%s@%s: %s",
                    market_type,
                    symbol,
                    interval,
                    exc,
                )
                self._metrics.inc("cache_push_errors")

        self._metrics.inc("bars_cached", total_cached)
        return total_cached

    # ── Internal: Callbacks ──────────────────────────────────

    async def _fire_write_batch(
        self, symbol: str, interval: str, count: int,
    ) -> None:
        for cb in self._write_batch_callbacks:
            try:
                await cb(symbol, interval, count)
            except Exception as exc:
                logger.error("Write batch callback error: %s", exc)
