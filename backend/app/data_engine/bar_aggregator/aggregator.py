"""
Bar Aggregator — top-level orchestrator that wires L1–L5 together.

This is the main entry point for the Bar Aggregator module.  It creates
and connects all sub-components (Router, TimeBucket, BarState, Finalizer,
Publisher) and provides a high-level API.

Usage::

    from bar_aggregator import BarAggregator, BarAggregatorConfig

    config = BarAggregatorConfig()
    agg = BarAggregator(config)

    # Register symbols and intervals
    agg.add_target("BTCUSDT", "1m")
    agg.add_target("BTCUSDT", "91m")

    # Hook up consumers
    agg.publisher.on_bar_closed(save_to_db)

    # Feed from ingestion
    await agg.on_market_event(market_event)

    # Feed from backfill
    await agg.on_backfill_bars("BTCUSDT", "1m", bars)

Architecture::

    MarketEvent / FetchedBar
            │
            ▼
    ┌─ L1: EventRouter ─────────────────────────┐
    │   normalize → BarInput                     │
    │   dispatch by (symbol, target_interval)    │
    └───────────────┬────────────────────────────┘
                    │  BarInput
                    ▼
    ┌─ L2: TimeBucketEngine ─────────────────────┐
    │   compute_bucket(open_time_ms) → bucket_ms │
    └───────────────┬────────────────────────────┘
                    │  bucket_start_ms
                    ▼
    ┌─ L3: BarStateEngine ───────────────────────┐
    │   apply(symbol, bucket, input) → BarState  │
    │   + merge strategy (OHLCV / custom)        │
    └───────────────┬────────────────────────────┘
                    │  BarState + BarStateChange
                    ▼
    ┌─ L4: Finalizer ───────────────────────────┐
    │   check(state, trigger) → close?           │
    │   strategy chain evaluation                │
    └───────────────┬────────────────────────────┘
                    │  BarEvent (if closed)
                    ▼
    ┌─ L5: Publisher ───────────────────────────┐
    │   emit(CREATED/UPDATED/CLOSED/...)        │
    │   → callbacks + async iterators           │
    └───────────────────────────────────────────┘
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from .config import BarAggregatorConfig
from .models import (
    AlignmentMode,
    BarInput,
    BarInputSource,
    BarState,
    BarStateChange,
    BarEvent,
    BarEventType,
    FinalizeTrigger,
    parse_interval_ms,
    is_standard_interval,
)
from .router import EventRouter
from .time_bucket import TimeBucketEngine, MonthlyBucketCalculator, WeeklyBucketCalculator
from .bar_state import BarStateEngine
from .finalizer import Finalizer
from .publisher import BarAggregatorPublisher

logger = logging.getLogger("bar_aggregator")


class IntervalPipeline:
    """Internal: a per-interval aggregation pipeline (L2 + L3 + L4).

    Each registered interval gets its own pipeline with dedicated
    TimeBucketEngine, BarStateEngine, and Finalizer instances.
    """

    def __init__(
        self,
        interval: str,
        interval_ms: int,
        config: BarAggregatorConfig,
    ) -> None:
        self.interval = interval
        self.interval_ms = interval_ms

        alignment = AlignmentMode(config.default_alignment_mode)

        # Monthly intervals need calendar-based bucketing, not fixed 30-day.
        # This applies to ALL month-unit intervals (1M, 2M, 3M, etc.),
        # not just the standard "1M".
        custom_calc = None
        if interval.endswith("M") and interval[:-1].isdigit():
            month_count = int(interval[:-1])
            if month_count > 0:
                custom_calc = MonthlyBucketCalculator(months=month_count)
        # Weekly intervals need Monday-aligned bucketing.
        # Without this, floor-dividing from Unix epoch (a Thursday)
        # would produce buckets starting on Thursday instead of Monday.
        elif interval.endswith("w") and interval[:-1].isdigit():
            week_count = int(interval[:-1])
            if week_count > 0:
                custom_calc = WeeklyBucketCalculator(weeks=week_count)

        self.time_bucket = TimeBucketEngine(
            interval_ms=interval_ms,
            alignment=alignment,
            epoch_ms=config.alignment_epoch_ms,
            custom_calculator=custom_calc,
        )
        self.bar_state = BarStateEngine(config, self.time_bucket, interval)
        self.finalizer = Finalizer(config, self.time_bucket, interval)

    def snapshot(self) -> dict:
        return {
            "interval": self.interval,
            "interval_ms": self.interval_ms,
            "time_bucket": self.time_bucket.snapshot(),
            "bar_state": self.bar_state.snapshot(),
            "finalizer": self.finalizer.snapshot(),
        }


class BarAggregator:
    """Top-level Bar Aggregator — wires L1 through L5 together.

    This is the **only class** external code needs to interact with.
    It exposes:
      - ``add_target()`` / ``remove_target()`` to manage (symbol, interval) pairs
      - ``on_market_event()`` to feed realtime data from ingestion
      - ``on_backfill_bars()`` to feed historical data from backfill
      - ``publisher`` property for subscribing to bar lifecycle events
      - Per-layer access for advanced customization
    """

    def __init__(self, config: BarAggregatorConfig | None = None) -> None:
        self._cfg = config or BarAggregatorConfig()

        # L1: Event Router
        self._router = EventRouter(self._cfg)
        self._router.set_on_bar_input(self._handle_bar_input)

        # L5: Publisher (shared across all intervals)
        self._publisher = BarAggregatorPublisher(self._cfg)

        # Per-interval pipelines: {interval → IntervalPipeline}
        self._pipelines: dict[str, IntervalPipeline] = {}

        # Track which (market_type, symbol) are active per interval
        # (redundant with router targets, but useful for fast lookup)
        self._symbol_intervals: dict[tuple[str, str], set[str]] = {}

        # Timeout checker task
        self._timeout_task: asyncio.Task | None = None

    # ── Public: Lifecycle ────────────────────────────────────

    async def start(self) -> None:
        """Start background tasks (e.g. timeout checker)."""
        if self._timeout_task is None:
            self._timeout_task = asyncio.create_task(
                self._timeout_loop(), name="bar_agg_timeout",
            )
            logger.info("BarAggregator started")

    async def stop(self) -> None:
        """Stop background tasks and flush all active bars."""
        if self._timeout_task is not None:
            self._timeout_task.cancel()
            try:
                await self._timeout_task
            except asyncio.CancelledError:
                pass
            self._timeout_task = None

        # Flush all active bars
        await self._flush_all()
        await self._publisher.close_all_subscribers()
        logger.info("BarAggregator stopped")

    # ── Public: Target Management ────────────────────────────

    def add_target(self, symbol: str, interval: str, market_type: str = "spot") -> None:
        """Register a (symbol, interval) aggregation target.

        Creates the per-interval pipeline if it doesn't exist yet.

        Args:
            symbol:   Trading pair (e.g. "BTCUSDT")
            interval: Target interval (e.g. "1m", "5m", "91m")

        Raises:
            ValueError: If the interval string cannot be parsed
        """
        symbol = symbol.upper()
        market_type = market_type.lower().strip()
        interval_ms = parse_interval_ms(interval)
        if interval_ms is None:
            raise ValueError(f"Cannot parse interval: {interval!r}")

        # Create pipeline if needed
        if interval not in self._pipelines:
            self._pipelines[interval] = IntervalPipeline(
                interval, interval_ms, self._cfg,
            )
            logger.info(
                "Created pipeline for interval %s (%d ms)", interval, interval_ms,
            )

        # Register with router
        self._router.register_target(symbol, interval, market_type=market_type)

        # Track
        self._symbol_intervals.setdefault((market_type, symbol), set()).add(interval)

    def remove_target(self, symbol: str, interval: str, market_type: str = "spot") -> None:
        """Unregister a (symbol, interval) target.

        Does NOT destroy the pipeline — other symbols may use it.
        """
        symbol = symbol.upper()
        market_type = market_type.lower().strip()
        self._router.unregister_target(symbol, interval, market_type=market_type)
        key = (market_type, symbol)
        if key in self._symbol_intervals:
            self._symbol_intervals[key].discard(interval)

    def get_targets(self) -> list[tuple[str, str, str]]:
        """Return all registered (symbol, interval) targets."""
        return self._router.get_targets()

    # ── Public: Data Ingestion ───────────────────────────────

    async def on_market_event(self, event: Any) -> None:
        """Feed a MarketEvent from the ingestion layer.

        The event is normalized to BarInput by the Router and dispatched
        to all matching interval pipelines.
        """
        await self._router.on_market_event(event)

    async def on_backfill_bars(
        self, symbol: str, interval: str, bars: list[Any], market_type: str = "spot",
    ) -> None:
        """Feed historical bars from the backfill engine.

        Each bar is converted to BarInput and processed through the
        full pipeline.
        """
        await self._router.on_backfill_bars(symbol, interval, bars, market_type=market_type)

    async def on_custom_data(self, adapter_name: str, raw_data: Any) -> None:
        """Feed data through a registered custom adapter."""
        await self._router.on_custom_data(adapter_name, raw_data)

    # ── Public: Layer Access (advanced customization) ────────

    @property
    def config(self) -> BarAggregatorConfig:
        """Access the aggregator configuration."""
        return self._cfg

    @property
    def router(self) -> EventRouter:
        """Access L1: EventRouter (for adapter registration, etc.)."""
        return self._router

    @property
    def publisher(self) -> BarAggregatorPublisher:
        """Access L5: Publisher (for subscribing to bar events)."""
        return self._publisher

    def get_pipeline(self, interval: str) -> IntervalPipeline | None:
        """Access a per-interval pipeline for advanced customization.

        Returns None if no pipeline exists for this interval.

        Example — swap merge strategy for 91m bars::

            pipeline = agg.get_pipeline("91m")
            if pipeline:
                pipeline.bar_state.set_merge_strategy(MyCustomMerge())
        """
        return self._pipelines.get(interval)

    def get_time_bucket(self, interval: str) -> TimeBucketEngine | None:
        """Access L2: TimeBucketEngine for a specific interval."""
        p = self._pipelines.get(interval)
        return p.time_bucket if p else None

    def get_bar_state(self, interval: str) -> BarStateEngine | None:
        """Access L3: BarStateEngine for a specific interval."""
        p = self._pipelines.get(interval)
        return p.bar_state if p else None

    def get_finalizer(self, interval: str) -> Finalizer | None:
        """Access L4: Finalizer for a specific interval."""
        p = self._pipelines.get(interval)
        return p.finalizer if p else None

    # ── Public: State Queries ────────────────────────────────

    def get_latest_bar(self, symbol: str, interval: str, market_type: str = "spot") -> BarState | None:
        """Get the most recent bar for a (symbol, interval) pair."""
        p = self._pipelines.get(interval)
        if p is None:
            return None
        return p.bar_state.get_latest_bar(market_type, symbol)

    def get_active_bars(self, symbol: str, interval: str, market_type: str = "spot") -> list[BarState]:
        """Get all active (FORMING) bars for a (symbol, interval) pair."""
        p = self._pipelines.get(interval)
        if p is None:
            return []
        return p.bar_state.get_all_active(market_type, symbol)

    def get_recent_bars(
        self, symbol: str, interval: str, limit: int = 100, market_type: str = "spot",
    ) -> list[BarState]:
        """Get recently closed bars for a (symbol, interval) pair."""
        p = self._pipelines.get(interval)
        if p is None:
            return []
        return p.bar_state.get_recent_closed(market_type, symbol, limit)

    # ── Public: Snapshot ─────────────────────────────────────

    def snapshot(self) -> dict:
        """Full diagnostic snapshot of the entire aggregator."""
        return {
            "config": self._cfg.snapshot(),
            "router": self._router.snapshot(),
            "publisher": self._publisher.snapshot(),
            "pipelines": {
                interval: p.snapshot()
                for interval, p in self._pipelines.items()
            },
        }

    # ── Internal: Core Processing ────────────────────────────

    async def _handle_bar_input(
        self, market_type: str, symbol: str, interval: str, bar_input: BarInput,
    ) -> None:
        """Core processing callback: L1 → L2 → L3 → L4 → L5.

        This is the heart of the aggregator, called by the EventRouter
        for each (symbol, interval, BarInput) tuple.
        """
        pipeline = self._pipelines.get(interval)
        if pipeline is None:
            logger.warning("No pipeline for interval %s", interval)
            return

        # L2: Compute which bucket this input belongs to
        bucket_start_ms = pipeline.time_bucket.compute_bucket(bar_input.open_time_ms)

        # Check for event-driven close: if this input starts a new bucket,
        # close previous active bars for this symbol
        await self._check_event_driven_close(
            market_type, symbol, interval, pipeline, bucket_start_ms, bar_input,
        )

        # L3: Apply input to bar state
        state, change = pipeline.bar_state.apply(market_type, symbol, bucket_start_ms, bar_input)

        # Drain eviction buffers — emit events for bars that were
        # force-closed or expired during apply() due to limit enforcement.
        await self._drain_eviction_buffers(pipeline)

        # L5: Emit lifecycle events
        if change == BarStateChange.CREATED:
            await self._publisher.emit_created(state)
        elif change == BarStateChange.UPDATED:
            await self._publisher.emit_updated(state)
        elif change == BarStateChange.AMENDED:
            await self._publisher.emit_amended(state)

        # L4: Check if this bar should be finalized
        is_backfill = bar_input.source == BarInputSource.BACKFILL
        trigger = FinalizeTrigger(
            trigger_type="input",
            input=bar_input,
            current_time_ms=int(time.time() * 1000),
            is_backfill=is_backfill,
        )
        close_event = pipeline.finalizer.check(state, trigger)

        if close_event is not None:
            # Seal the bar
            closed = pipeline.bar_state.close_bar(market_type, symbol, bucket_start_ms)
            if closed is not None:
                await self._publisher.emit_closed(closed)
                # Drain eviction buffers after close_bar() — closing a bar
                # may trigger expired evictions from the closed bars cache.
                await self._drain_eviction_buffers(pipeline)

    async def _check_event_driven_close(
        self,
        market_type: str,
        symbol: str,
        interval: str,
        pipeline: IntervalPipeline,
        new_bucket_start_ms: int,
        bar_input: BarInput,
    ) -> None:
        """Close any older active bars when a new bucket's data arrives."""
        if not self._cfg.use_event_driven_close:
            return

        active = pipeline.bar_state.get_all_active(market_type, symbol)
        for state in active:
            if state.bucket_start_ms < new_bucket_start_ms:
                trigger = FinalizeTrigger(
                    trigger_type="next_bucket",
                    current_time_ms=int(time.time() * 1000),
                    next_bucket_start=new_bucket_start_ms,
                )
                close_event = pipeline.finalizer.check(state, trigger)
                if close_event is not None:
                    closed = pipeline.bar_state.close_bar(
                        market_type, symbol, state.bucket_start_ms,
                    )
                    if closed is not None:
                        await self._publisher.emit_closed(closed)

    # ── Internal: Eviction Buffer Drain ──────────────────────

    async def _drain_eviction_buffers(self, pipeline: IntervalPipeline) -> None:
        """Emit lifecycle events for bars evicted by limit enforcement.

        The BarStateEngine populates ``evicted_closed`` and ``evicted_expired``
        buffers when bars are force-closed or expired during apply()/close_bar().
        This method drains those buffers and emits the appropriate events.
        """
        # Emit CLOSED events for force-closed bars (active limit exceeded)
        if pipeline.bar_state.evicted_closed:
            for bar in pipeline.bar_state.evicted_closed:
                await self._publisher.emit_closed(bar)
            pipeline.bar_state.evicted_closed.clear()

        # Emit EXPIRED events for expired bars (closed limit exceeded)
        if pipeline.bar_state.evicted_expired:
            for bar in pipeline.bar_state.evicted_expired:
                await self._publisher.emit_expired(bar)
            pipeline.bar_state.evicted_expired.clear()

    # ── Internal: Timeout Loop ───────────────────────────────

    async def _timeout_loop(self) -> None:
        """Background task that periodically checks for timed-out bars."""
        while True:
            try:
                await asyncio.sleep(1.0)  # check every second
                await self._check_timeouts()
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.error("Timeout loop error: %s", exc, exc_info=True)
                await asyncio.sleep(5.0)

    async def _check_timeouts(self) -> None:
        """Check all active bars for timeout-based finalization."""
        for interval, pipeline in self._pipelines.items():
            # Get all active bars across all symbols
            for key, state in list(pipeline.bar_state._active.items()):
                close_event = pipeline.finalizer.check_timeout(state)
                if close_event is not None:
                    closed = pipeline.bar_state.close_bar(
                        state.market_type, state.symbol, state.bucket_start_ms,
                    )
                    if closed is not None:
                        await self._publisher.emit_closed(closed)

    # ── Internal: Flush ──────────────────────────────────────

    async def _flush_all(self) -> None:
        """Force-close all active bars (used during shutdown)."""
        for interval, pipeline in self._pipelines.items():
            for key in list(pipeline.bar_state._active.keys()):
                market_type, symbol, bucket_start = key
                closed = pipeline.bar_state.close_bar(market_type, symbol, bucket_start)
                if closed is not None:
                    await self._publisher.emit_closed(closed)
        logger.info("Flushed all active bars")
