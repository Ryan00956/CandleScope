"""
Reconciler — deduplicates, aggregates custom intervals, writes to DB, and pushes to cache.

Responsibilities:
  * Receive ``FetchResult`` objects from the Historical Fetcher
  * Deduplicate against existing DB data (skip / overwrite / backfill_wins)
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

import asyncio
import logging
import time
from typing import Callable, Awaitable, Any

from app.data_engine.interval_policy import (
    aggregate_kline_rows,
    compute_bucket_close_ms,
    compute_bucket_start_ms,
    parse_interval_ms,
)
from app.data_engine.kline_quality import source_rank
from app.data_engine.custom_materialization import (
    MaterializationLease,
    custom_materialization_registry,
)

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
    WrittenRange,
)

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
        self._materialization_write_tasks: set[asyncio.Task[Any]] = set()

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
            "materialization_writes_draining": len(
                self._materialization_write_tasks
            ),
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
            archive_receipts = self._collect_archive_receipts(fetch_results)
            archive_receipts_by_key = {
                str(item["object_key"]): item
                for item in archive_receipts
            }
            handled_archive_receipts: set[str] = set()
            # 1. Collect all bars grouped by (exchange, market_type, symbol, interval)
            grouped = self._group_bars(fetch_results)
            total_received = sum(len(bars) for bars in grouped.values())
            result.bars_received = total_received

            # 2 & 3. Dedup + write standard bars
            for (exchange, market_type, symbol, interval), bars in grouped.items():
                (
                    written,
                    skipped,
                    deduped,
                    failures,
                    written_ranges,
                    archive_imported,
                    archive_invalidated,
                    handled_receipts,
                ) = await self._dedup_and_write(
                    symbol,
                    interval,
                    bars,
                    exchange=exchange,
                    market_type=market_type,
                    archive_receipts=archive_receipts_by_key,
                )
                result.bars_written += written
                result.bars_skipped += skipped
                result.bars_deduplicated += deduped
                result.written_ranges.extend(written_ranges)
                result.archive_objects_imported += archive_imported
                result.archive_dependent_rows_invalidated += archive_invalidated
                handled_archive_receipts.update(handled_receipts)
                self._metrics.inc("archive_objects_imported", archive_imported)
                self._metrics.inc(
                    "archive_dependent_rows_invalidated",
                    archive_invalidated,
                )
                self._record_write_failures(result, failures)

            # Archive receipts are advisory metadata, but revision
            # invalidation is part of correctness and must happen after the
            # official base rows commit and before custom bars regenerate.
            remaining_archive_receipts = [
                item
                for item in archive_receipts
                if str(item["object_key"]) not in handled_archive_receipts
            ]
            if remaining_archive_receipts and result.write_errors == 0:
                await self._persist_archive_receipts(
                    remaining_archive_receipts,
                    result,
                )

            # 4. Generate custom-interval bars
            if (
                not result.errors
                and self._cfg.reconcile_generate_custom
                and plan.custom_intervals
            ):
                custom_started = time.monotonic()
                for decomp in plan.decompositions:
                    gen, wrt, failures, written_ranges = await self._generate_custom_bars(
                        decomp, grouped,
                    )
                    result.custom_bars_generated += gen
                    result.custom_bars_written += wrt
                    result.written_ranges.extend(written_ranges)
                    self._record_write_failures(result, failures)
                custom_elapsed_ms = int(
                    (time.monotonic() - custom_started) * 1_000
                )
                self._metrics.inc(
                    "custom_materialization_elapsed_ms_total",
                    custom_elapsed_ms,
                )
                self._metrics.set(
                    "last_custom_materialization_elapsed_ms",
                    custom_elapsed_ms,
                )

            # 5. Push to cache
            if self._cfg.reconcile_enable_cache_push and self._cache is not None:
                cached = await self._push_to_cache(grouped)
                result.bars_cached = cached

        except Exception as exc:
            result.errors.append(str(exc))
            self._metrics.inc("reconcile_errors")
            logger.error("Reconciliation error: %s", exc, exc_info=True)

        result.elapsed_ms = int((time.monotonic() - start) * 1000)
        self._metrics.inc("reconcile_elapsed_ms_total", result.elapsed_ms)
        self._metrics.set("last_reconcile_elapsed_ms", result.elapsed_ms)

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
    ) -> dict[tuple[str, str, str, str], list[FetchedBar]]:
        """Group all fetched bars by (exchange, market_type, symbol, interval)."""
        indexed: dict[
            tuple[str, str, str, str],
            dict[int, FetchedBar],
        ] = {}
        for fr in fetch_results:
            if fr.status == BackfillStatus.FAILED:
                continue
            for bar in fr.bars:
                key = (bar.exchange, bar.market_type, bar.symbol, bar.interval)
                by_open_time = indexed.setdefault(key, {})
                existing = by_open_time.get(bar.open_time)
                if existing is None or Reconciler._prefer_grouped_bar(existing, bar):
                    by_open_time[bar.open_time] = bar

        return {
            key: sorted(values.values(), key=lambda bar: bar.open_time)
            for key, values in indexed.items()
        }

    @staticmethod
    def _prefer_grouped_bar(existing: FetchedBar, incoming: FetchedBar) -> bool:
        incoming_rank = source_rank(incoming.source)
        existing_rank = source_rank(existing.source)
        if incoming_rank != existing_rank:
            return incoming_rank > existing_rank
        # REST may carry a same-authority amendment for an archive row.  Keep
        # it when both arrive in the same reconciliation pass.
        incoming_is_archive = incoming.source.startswith("backfill_archive_")
        existing_is_archive = existing.source.startswith("backfill_archive_")
        if incoming_is_archive != existing_is_archive:
            return not incoming_is_archive
        return True

    @staticmethod
    def _collect_archive_receipts(
        fetch_results: list[FetchResult],
    ) -> list[dict[str, Any]]:
        receipts: dict[str, dict[str, Any]] = {}
        for fetch_result in fetch_results:
            if fetch_result.status == BackfillStatus.FAILED:
                continue
            raw_receipts = fetch_result.metadata.get("archive_objects")
            if not isinstance(raw_receipts, list):
                continue
            for raw in raw_receipts:
                if not isinstance(raw, dict):
                    continue
                object_key = str(raw.get("object_key") or "").strip()
                if object_key:
                    receipts[object_key] = dict(raw)
        return list(receipts.values())

    async def _persist_archive_receipts(
        self,
        receipts: list[dict[str, Any]],
        result: ReconcileResult,
    ) -> None:
        try:
            revised = [item for item in receipts if item.get("revision_changed")]
            invalidator = getattr(self._storage, "invalidate_archive_dependents", None)
            if revised and callable(invalidator):
                invalidated = int(await invalidator(revised) or 0)
                result.archive_dependent_rows_invalidated += invalidated
                self._metrics.inc(
                    "archive_dependent_rows_invalidated",
                    invalidated,
                )
            recorder = getattr(self._storage, "record_history_archive_imports", None)
            if callable(recorder):
                recorded = int(await recorder(receipts) or 0)
                result.archive_objects_imported += recorded
                self._metrics.inc("archive_objects_imported", recorded)
        except Exception as exc:
            message = f"Archive import receipt failed: {exc}"
            result.errors.append(message)
            self._metrics.inc("archive_receipt_errors")
            logger.error(message, exc_info=True)

    # ── Internal: Dedup + Write ──────────────────────────────

    async def _dedup_and_write(
        self,
        symbol: str,
        interval: str,
        bars: list[FetchedBar],
        exchange: str = "binance",
        market_type: str = "spot",
        archive_receipts: dict[str, dict[str, Any]] | None = None,
    ) -> tuple[
        int,
        int,
        int,
        list[dict[str, Any]],
        list[WrittenRange],
        int,
        int,
        set[str],
    ]:
        """Deduplicate bars against DB and write in batches.

        Returns (written, skipped, deduplicated, failures, written_ranges).
        """
        if not bars:
            return 0, 0, 0, [], [], 0, 0, set()

        strategy = DeduplicationStrategy(self._cfg.reconcile_dedup_strategy)
        batch_size = self._cfg.reconcile_write_batch_size

        # Overwrite/backfill-wins are unconditional upserts.  Reading the
        # entire range first only produced a diagnostic dedup count and doubled
        # storage I/O, so reserve that lookup for policies that actually need
        # existence to make a write decision.
        existing: set[int] = set()
        if strategy is DeduplicationStrategy.SKIP or self._custom_dedup_fn is not None:
            min_ot = bars[0].open_time
            max_ot = bars[-1].open_time
            try:
                existing = await self._storage.get_existing_open_times(
                    symbol,
                    interval,
                    min_ot,
                    max_ot,
                    exchange=exchange,
                    market_type=market_type,
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

        # Preserve provenance. Official archive groups are deliberately sent
        # to storage in one call so each selected archive range commits or
        # rolls back as a unit; ordinary REST remains bounded by the existing
        # write batch size.
        written = 0
        failures: list[dict[str, Any]] = []
        written_ranges: list[WrittenRange] = []
        archive_imported = 0
        archive_invalidated = 0
        handled_archive_receipts: set[str] = set()
        by_source: dict[tuple[str, str | None], list[FetchedBar]] = {}
        for bar in to_write:
            source = bar.source or "backfill"
            object_key = (
                bar.archive_object_key
                if source.startswith("backfill_archive_")
                else None
            )
            by_source.setdefault((source, object_key), []).append(bar)
        for (source, object_key), source_bars in by_source.items():
            effective_batch_size = (
                len(source_bars)
                if source.startswith("backfill_archive_")
                else batch_size
            )
            effective_batch_size = max(1, effective_batch_size)
            for i in range(0, len(source_bars), effective_batch_size):
                batch = source_bars[i : i + effective_batch_size]
                dicts = [b.to_storage_dict() for b in batch]
                archive_write_started = (
                    time.monotonic()
                    if source.startswith("backfill_archive_")
                    else None
                )
                try:
                    receipt = (
                        (archive_receipts or {}).get(object_key or "")
                        if source.startswith("backfill_archive_")
                        else None
                    )
                    archive_importer = getattr(
                        self._storage,
                        "import_history_archive",
                        None,
                    )
                    if receipt is not None and callable(archive_importer):
                        import_outcome = await archive_importer(
                            symbol,
                            interval,
                            dicts,
                            receipt,
                            source=source,
                            exchange=exchange,
                            market_type=market_type,
                        )
                        n = int(import_outcome.get("written") or 0)
                        archive_imported += int(
                            bool(import_outcome.get("imported"))
                        )
                        archive_invalidated += int(
                            import_outcome.get("invalidated") or 0
                        )
                        handled_archive_receipts.add(str(object_key))
                        if import_outcome.get("skipped"):
                            self._metrics.inc("archive_import_dedup_hits")
                    else:
                        n = await self._storage.upsert_bars(
                            symbol,
                            interval,
                            dicts,
                            source=source,
                            exchange=exchange,
                            market_type=market_type,
                        )
                    written += n
                    written_range = self._written_range_from_batch(
                        exchange=exchange,
                        market_type=market_type,
                        symbol=symbol,
                        interval=interval,
                        batch=batch,
                        bars_written=n,
                        source=source,
                        phase=(
                            "archive_standard"
                            if source.startswith("backfill_archive_")
                            else "standard"
                        ),
                    )
                    if written_range is not None:
                        written_ranges.append(written_range)
                    if n > 0:
                        await self._fire_write_batch(symbol, interval, n)
                except Exception as exc:
                    logger.error(
                        "Write batch failed for %s@%s source=%s: %s",
                        symbol,
                        interval,
                        source,
                        exc,
                        exc_info=True,
                    )
                    self._metrics.inc("write_errors")
                    failures.append(self._write_failure_detail(
                        exchange=exchange,
                        market_type=market_type,
                        symbol=symbol,
                        interval=interval,
                        batch=batch,
                        error=exc,
                        phase=(
                            "archive_standard"
                            if source.startswith("backfill_archive_")
                            else "standard"
                        ),
                    ))
                finally:
                    if archive_write_started is not None:
                        archive_write_elapsed_ms = int(
                            (time.monotonic() - archive_write_started) * 1_000
                        )
                        self._metrics.inc(
                            "archive_write_elapsed_ms_total",
                            archive_write_elapsed_ms,
                        )
                        self._metrics.set(
                            "last_archive_write_elapsed_ms",
                            archive_write_elapsed_ms,
                        )

        return (
            written,
            skipped,
            deduped,
            failures,
            written_ranges,
            archive_imported,
            archive_invalidated,
            handled_archive_receipts,
        )

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
        # BACKFILL_WINS (and the legacy newer_wins name) keeps the fetched
        # repair data without pretending we compared storage updated_at.
        return True

    # ── Internal: Custom interval aggregation ────────────────

    def _defer_materialization_lease_release(
        self,
        lease: MaterializationLease,
        storage_task: asyncio.Task[Any],
    ) -> None:
        """Keep ownership until a cancellation-resistant storage write ends.

        ``run_in_executor`` cannot stop a worker that has begun mutating
        SQLite.  The HTTP/coordinator task may still cancel immediately, but
        the materialization range must remain occupied until that physical
        worker's async wrapper reports completion.
        """
        self._materialization_write_tasks.add(storage_task)
        self._metrics.inc("custom_materialization_cancelled_writes_deferred")

        def _release(completed: asyncio.Task[Any]) -> None:
            self._materialization_write_tasks.discard(completed)
            try:
                completed.result()
            except BaseException as exc:
                lease.fail(exc)
                self._metrics.inc(
                    "custom_materialization_deferred_write_failures"
                )
            else:
                # The current batch may have committed, but cancellation
                # means later batches in this lease were never attempted.
                # Release as failed so a waiter retries the complete range,
                # only after the physical write is no longer in flight.
                lease.fail(
                    "materialization owner cancelled after storage write"
                )
                self._metrics.inc(
                    "custom_materialization_deferred_writes_drained"
                )

        storage_task.add_done_callback(_release)

    async def _write_custom_materialization(
        self,
        *,
        exchange: str,
        market_type: str,
        symbol: str,
        interval: str,
        bars: list[FetchedBar],
        phase: str,
    ) -> tuple[int, list[dict[str, Any]], list[WrittenRange]]:
        """Write one target range under shared query/reconciler ownership."""
        if not bars:
            return 0, [], []

        bars = sorted(bars, key=lambda bar: bar.open_time)
        contiguous_runs: list[list[FetchedBar]] = [[bars[0]]]
        for bar in bars[1:]:
            if bar.open_time == contiguous_runs[-1][-1].close_time + 1:
                contiguous_runs[-1].append(bar)
            else:
                contiguous_runs.append([bar])
        if len(contiguous_runs) > 1:
            total_written = 0
            all_failures: list[dict[str, Any]] = []
            all_ranges: list[WrittenRange] = []
            for run in contiguous_runs:
                count, failures, ranges = await self._write_custom_materialization(
                    exchange=exchange,
                    market_type=market_type,
                    symbol=symbol,
                    interval=interval,
                    bars=run,
                    phase=phase,
                )
                total_written += count
                all_failures.extend(failures)
                all_ranges.extend(ranges)
            return total_written, all_failures, all_ranges

        start_ms = min(bar.open_time for bar in bars)
        end_ms = max(bar.open_time for bar in bars)
        series = custom_materialization_registry.series_key(
            exchange=exchange,
            market_type=market_type,
            symbol=symbol,
            interval=interval,
        )
        async def _claim_materialization():
            while True:
                claimed, partial_overlap = (
                    custom_materialization_registry.claim_nowait(
                        series=series,
                        start_ms=start_ms,
                        end_ms=end_ms,
                        owner="reconciler",
                    )
                )
                if claimed is not None:
                    return claimed
                assert partial_overlap is not None
                await asyncio.shield(asyncio.wrap_future(partial_overlap))

        lease = await _claim_materialization()
        while not lease.is_owner:
            outcome = await asyncio.shield(asyncio.wrap_future(lease.future))
            if outcome.success:
                self._metrics.inc("custom_materialization_joins")
                covered_rows = min(len(bars), outcome.rows_covered)
                joined_range = (
                    WrittenRange(
                        symbol=symbol,
                        interval=interval,
                        exchange=exchange,
                        market_type=market_type,
                        start_ms=start_ms,
                        end_ms=end_ms,
                        bars_written=covered_rows,
                        source="backfill_aggregated",
                        phase=f"{phase}_joined_{outcome.owner}",
                    )
                    if covered_rows > 0
                    else None
                )
                return (
                    covered_rows,
                    [],
                    [joined_range] if joined_range is not None else [],
                )
            lease = await _claim_materialization()

        self._metrics.inc("custom_materialization_owners")
        written = 0
        failures: list[dict[str, Any]] = []
        written_ranges: list[WrittenRange] = []
        batch_size = self._cfg.reconcile_write_batch_size
        lease_finished = False
        lease_release_deferred = False
        try:
            for i in range(0, len(bars), batch_size):
                batch = bars[i : i + batch_size]
                dicts = [bar.to_storage_dict() for bar in batch]
                try:
                    storage_task = asyncio.create_task(
                        self._storage.upsert_bars(
                            symbol,
                            interval,
                            dicts,
                            source="backfill_aggregated",
                            exchange=exchange,
                            market_type=market_type,
                        )
                    )
                    try:
                        storage_result = await asyncio.shield(storage_task)
                    except asyncio.CancelledError:
                        self._defer_materialization_lease_release(
                            lease,
                            storage_task,
                        )
                        lease_release_deferred = True
                        raise
                    count = int(storage_result or 0)
                    written += count
                    # A successful upsert returning zero commonly means the
                    # exact rows already existed.  Preserve durable coverage
                    # separately from the physical mutation count so repair
                    # completion never loses the target range.
                    written_range = self._written_range_from_batch(
                        exchange=exchange,
                        market_type=market_type,
                        symbol=symbol,
                        interval=interval,
                        batch=batch,
                        bars_written=len(batch),
                        source="backfill_aggregated",
                        phase=phase,
                    )
                    if written_range is not None:
                        written_ranges.append(written_range)
                except Exception as exc:
                    logger.error(
                        "Custom bar write failed for %s@%s phase=%s: %s",
                        symbol,
                        interval,
                        phase,
                        exc,
                        exc_info=True,
                    )
                    self._metrics.inc("write_errors")
                    failures.append(self._write_failure_detail(
                        exchange=exchange,
                        market_type=market_type,
                        symbol=symbol,
                        interval=interval,
                        batch=batch,
                        error=exc,
                        phase=phase,
                    ))

            if failures:
                lease.fail(failures[0]["error"])
            else:
                lease.complete(written, rows_covered=len(bars))
            lease_finished = True
            return written, failures, written_ranges
        except BaseException as exc:
            if not lease_finished and not lease_release_deferred:
                lease.fail(exc)
            raise

    async def _generate_custom_bars(
        self,
        decomp: IntervalDecomposition,
        grouped: dict[tuple[str, str, str, str], list[FetchedBar]],
    ) -> tuple[int, int, list[dict[str, Any]], list[WrittenRange]]:
        """Aggregate standard bars into custom-interval candles.

        When a BarAggregator is available, component bars are fed through
        it via ``on_backfill_bars()`` — this reuses the exact same L1–L5
        pipeline (TimeBucket, BarState, Finalizer, Publisher) that handles
        live data, ensuring perfect consistency.

        When no BarAggregator is available, falls back to the built-in
        ``_aggregate_to_custom`` implementation.

        Returns (generated, written, failures, written_ranges).
        """
        custom_iv = decomp.custom_interval
        custom_ms = decomp.custom_duration_ms
        generated = 0
        written = 0
        failures: list[dict[str, Any]] = []
        written_ranges: list[WrittenRange] = []

        # Collect all component bars for each symbol
        symbols: set[tuple[str, str, str]] = set()
        component_bars: dict[tuple[str, str, str], list[FetchedBar]] = {}

        for comp in decomp.components:
            for (exchange, market_type, sym, iv), bars in grouped.items():
                if iv == comp.interval:
                    symbols.add((exchange, market_type, sym))
                    component_bars.setdefault((exchange, market_type, sym), []).extend(bars)

        for exchange, market_type, symbol in symbols:
            bars = component_bars.get((exchange, market_type, symbol), [])
            if not bars:
                continue

            bars.sort(key=lambda b: b.open_time)
            bucket_min_ms, bucket_max_ms = self._custom_bucket_bounds(
                bars, custom_ms, decomp.alignment_epoch_ms,
                custom_interval=custom_iv,
            )

            archive_bulk_fast_path = (
                decomp.alignment_epoch_ms == 0
                and len(bars) >= 1_000
                and any(
                    bar.source.startswith("backfill_archive_")
                    for bar in bars
                )
            )
            if archive_bulk_fast_path:
                # Archive packages are strictly ordered, closed and validated
                # before they reach reconciliation.  Feeding 100k+ component
                # rows one at a time through the live async event pipeline is
                # semantically redundant and dominated warm rebuild time.
                # The pure batch implementation shares interval-policy bucket
                # boundaries and emits only fully covered buckets; parity with
                # BarAggregator is guarded by interval-policy consistency tests.
                custom_bars = self._aggregate_to_custom(
                    bars,
                    symbol,
                    custom_iv,
                    custom_ms,
                    decomp.alignment_epoch_ms,
                )
                generated += len(custom_bars)
                count, write_failures, ranges = (
                    await self._write_custom_materialization(
                        exchange=exchange,
                        market_type=market_type,
                        symbol=symbol,
                        interval=custom_iv,
                        bars=custom_bars,
                        phase="custom_archive_bulk",
                    )
                )
                written += count
                failures.extend(write_failures)
                written_ranges.extend(ranges)
                self._metrics.inc("custom_archive_bulk_fast_paths")
                self._metrics.inc(
                    "custom_archive_bulk_component_rows",
                    len(bars),
                )
                continue

            # ── Route through BarAggregator if available ─────
            if self._bar_aggregator is not None:
                try:
                    # Aggregate in an isolated BarAggregator instance so the
                    # reconciler cannot pollute live targets or active state.
                    batch_states = await self._bar_aggregator.aggregate_batch(
                        symbol,
                        custom_iv,
                        None,
                        bars,
                        exchange=exchange,
                        market_type=market_type,
                        require_authoritative=True,
                    )
                    custom_bars_from_agg = []
                    for bar_state in batch_states:
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
                            exchange=exchange,
                            market_type=market_type,
                            quote_volume=bar_state.quote_volume,
                            trades=bar_state.trades,
                            taker_buy_base=bar_state.taker_buy_base,
                            taker_buy_quote=bar_state.taker_buy_quote,
                            source="backfill_aggregated_via_bar_agg",
                            enhanced_fields=bar_state.enhanced_fields,
                        ))
                    custom_bars_from_agg.sort(key=lambda b: b.open_time)
                    generated += len(custom_bars_from_agg)

                    count, write_failures, ranges = (
                        await self._write_custom_materialization(
                            exchange=exchange,
                            market_type=market_type,
                            symbol=symbol,
                            interval=custom_iv,
                            bars=custom_bars_from_agg,
                            phase="custom_via_aggregator",
                        )
                    )
                    written += count
                    failures.extend(write_failures)
                    written_ranges.extend(ranges)
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

            count, write_failures, ranges = await self._write_custom_materialization(
                exchange=exchange,
                market_type=market_type,
                symbol=symbol,
                interval=custom_iv,
                bars=custom_bars,
                phase="custom",
            )
            written += count
            failures.extend(write_failures)
            written_ranges.extend(ranges)

        return generated, written, failures, written_ranges

    @staticmethod
    def _written_range_from_batch(
        *,
        exchange: str,
        market_type: str,
        symbol: str,
        interval: str,
        batch: list[FetchedBar],
        bars_written: int,
        source: str,
        phase: str,
    ) -> WrittenRange | None:
        if bars_written <= 0 or not batch:
            return None
        open_times = [bar.open_time for bar in batch]
        return WrittenRange(
            symbol=symbol,
            interval=interval,
            exchange=exchange,
            market_type=market_type,
            start_ms=min(open_times),
            end_ms=max(open_times),
            bars_written=bars_written,
            source=source,
            phase=phase,
        )

    @staticmethod
    def _write_failure_detail(
        *,
        exchange: str,
        market_type: str,
        symbol: str,
        interval: str,
        batch: list[FetchedBar],
        error: Exception,
        phase: str,
    ) -> dict[str, Any]:
        open_times = [bar.open_time for bar in batch]
        return {
            "exchange": exchange,
            "market_type": market_type,
            "symbol": symbol,
            "interval": interval,
            "phase": phase,
            "batch_size": len(batch),
            "start_ms": min(open_times) if open_times else None,
            "end_ms": max(open_times) if open_times else None,
            "error": str(error),
        }

    @staticmethod
    def _record_write_failures(
        result: ReconcileResult,
        failures: list[dict[str, Any]],
    ) -> None:
        if not failures:
            return
        result.write_errors += len(failures)
        result.failed_batches.extend(failures)
        for failure in failures:
            result.errors.append(
                "Write batch failed for "
                f"{failure['exchange']}:{failure['market_type']}:"
                f"{failure['symbol']}@{failure['interval']} "
                f"({failure['phase']}): {failure['error']}"
            )

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

        if self._custom_aggregator is None:
            source_interval = bars[0].interval
            if parse_interval_ms(source_interval) is None:
                inferred_source_ms = int(bars[0].close_time) - int(bars[0].open_time) + 1
                if inferred_source_ms <= 0 or inferred_source_ms % 1_000:
                    return []
                source_interval = f"{inferred_source_ms // 1_000}s"
            rebuilt = aggregate_kline_rows(
                [bar.to_storage_dict() for bar in bars],
                target_interval=custom_interval,
                source_interval=source_interval,
                now_ms=max(int(bar.close_time) for bar in bars) + 1,
            )
            result: list[FetchedBar] = []
            for row in rebuilt:
                enhanced_fields = frozenset(
                    field
                    for field in (
                        "quote_volume",
                        "trades",
                        "taker_buy_base",
                        "taker_buy_quote",
                    )
                    if row.get(field) is not None
                )
                result.append(FetchedBar(
                    symbol=symbol,
                    interval=custom_interval,
                    open_time=int(row["open_time"]),
                    close_time=int(row["close_time"]),
                    open=float(row["open"]),
                    high=float(row["high"]),
                    low=float(row["low"]),
                    close=float(row["close"]),
                    volume=float(row["volume"]),
                    exchange=bars[0].exchange,
                    market_type=bars[0].market_type,
                    quote_volume=float(row.get("quote_volume") or 0),
                    trades=int(row.get("trades") or 0),
                    taker_buy_base=float(row.get("taker_buy_base") or 0),
                    taker_buy_quote=float(row.get("taker_buy_quote") or 0),
                    source="backfill_aggregated",
                    enhanced_fields=enhanced_fields,
                ))
            return result

        result: list[FetchedBar] = []

        # Assign each bar to a custom bucket
        buckets: dict[int, list[FetchedBar]] = {}
        for bar in bars:
            bucket_start = compute_bucket_start_ms(bar.open_time, custom_ms, interval=custom_interval)
            buckets.setdefault(bucket_start, []).append(bar)

        for bucket_start in sorted(buckets.keys()):
            bucket_bars = buckets[bucket_start]
            bucket_bars.sort(key=lambda b: b.open_time)
            bucket_end = compute_bucket_close_ms(
                bucket_start,
                custom_ms,
                interval=custom_interval,
            )

            components_cover_bucket = (
                bucket_bars[0].open_time == bucket_start
                and all(
                    current.open_time == previous.close_time + 1
                    for previous, current in zip(bucket_bars, bucket_bars[1:])
                )
                and bucket_bars[-1].close_time >= bucket_end
            )
            if not components_cover_bucket:
                logger.warning(
                    "Skipping incomplete custom bucket %s@%s open=%d "
                    "components=%d",
                    symbol,
                    custom_interval,
                    bucket_start,
                    len(bucket_bars),
                )
                continue

            agg = self._custom_aggregator(
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

        enhanced_fields = frozenset.intersection(*(
            frozenset(bar.enhanced_fields or ())
            for bar in bars
        ))

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
            exchange=bars[0].exchange,
            quote_volume=sum(b.quote_volume for b in bars),
            market_type=bars[0].market_type,
            trades=sum(b.trades for b in bars),
            taker_buy_base=sum(b.taker_buy_base for b in bars),
            taker_buy_quote=sum(b.taker_buy_quote for b in bars),
            source="backfill_aggregated",
            enhanced_fields=enhanced_fields,
        )

    # ── Internal: Cache push ─────────────────────────────────

    async def _push_to_cache(
        self,
        grouped: dict[tuple[str, str, str, str], list[FetchedBar]],
    ) -> int:
        """Push recent bars to the cache backend."""
        if self._cache is None:
            return 0

        now_ms = int(time.time() * 1000)
        window = self._cfg.reconcile_cache_window_ms
        cutoff = now_ms - window
        total_cached = 0

        for (exchange, market_type, symbol, interval), bars in grouped.items():
            recent = [b for b in bars if b.open_time >= cutoff]
            if not recent:
                continue
            try:
                dicts = [b.to_lightweight() for b in recent]
                try:
                    n = await self._cache.push_bars(
                        symbol, interval, dicts, exchange=exchange, market_type=market_type,
                    )
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
