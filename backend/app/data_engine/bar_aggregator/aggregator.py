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

import json
from app.data_engine.series_identity import (
    KlineSeriesIdentity,
    resolve_kline_series_identity,
)

import asyncio
import logging
import time
from dataclasses import replace
from typing import Any

from app.data_engine.interval_policy import parse_interval_spec
from app.data_engine.interval_resolution import IntervalResolver

from .config import BarAggregatorConfig
from .models import (
    AlignmentMode,
    BarInput,
    BarInputSource,
    BarFinality,
    BarState,
    BarStateChange,
    BarEvent,
    BarEventType,
    FinalizeTrigger,
    MergeMode,
    parse_interval_ms,
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

    def __init__(
        self,
        config: BarAggregatorConfig | None = None,
        interval_resolver: IntervalResolver | None = None,
    ) -> None:
        self._cfg = config or BarAggregatorConfig()

        # L1: Event Router
        self._router = EventRouter(self._cfg, interval_resolver=interval_resolver)
        self._router.set_on_bar_input(self._handle_bar_input)

        # L5: Publisher (shared across all intervals)
        self._publisher = BarAggregatorPublisher(self._cfg)

        # Per-interval pipelines: {interval → IntervalPipeline}
        self._pipelines: dict[str, IntervalPipeline] = {}

        # Track which (exchange, market_type, symbol) are active per interval
        # (redundant with router targets, but useful for fast lookup)
        self._symbol_intervals: dict[
            tuple[str, str, str, KlineSeriesIdentity], set[str]
        ] = {}

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

    @staticmethod
    def _pipeline_key(
        interval: str, exchange: str, series_identity: KlineSeriesIdentity | None
    ) -> str:
        identity = resolve_kline_series_identity(exchange, series_identity)
        if identity.is_legacy_default_for(exchange):
            return interval
        return json.dumps([interval, *identity.storage_values], separators=(",", ":"))

    def add_target(
        self,
        symbol: str,
        interval: str,
        exchange: str = "binance",
        market_type: str = "spot",
        series_identity: KlineSeriesIdentity | None = None,
    ) -> None:
        """Register a (symbol, interval) aggregation target.

        Creates the per-interval pipeline if it doesn't exist yet.

        Args:
            symbol:   Trading pair (e.g. "BTCUSDT")
            interval: Target interval (e.g. "1m", "5m", "91m")

        Raises:
            ValueError: If the interval string cannot be parsed
        """
        symbol = symbol.upper()
        exchange = exchange.lower().strip()
        market_type = market_type.lower().strip()
        spec = parse_interval_spec(interval)
        if spec is not None:
            interval = spec.canonical
        interval_ms = parse_interval_ms(interval)
        if interval_ms is None:
            raise ValueError(f"Cannot parse interval: {interval!r}")

        # Create pipeline if needed
        pipeline_key = self._pipeline_key(interval, exchange, series_identity)
        if pipeline_key not in self._pipelines:
            self._pipelines[pipeline_key] = IntervalPipeline(
                interval,
                interval_ms,
                self._cfg,
            )
            logger.info(
                "Created pipeline for interval %s (%d ms)", interval, interval_ms,
            )

        # Register with router
        self._router.register_target(
            symbol,
            interval,
            exchange=exchange,
            market_type=market_type,
            series_identity=series_identity,
        )

        # Track
        self._symbol_intervals.setdefault(
            (
                exchange,
                market_type,
                symbol,
                resolve_kline_series_identity(exchange, series_identity),
            ),
            set(),
        ).add(interval)

    def remove_target(
        self,
        symbol: str,
        interval: str,
        exchange: str = "binance",
        market_type: str = "spot",
        series_identity: KlineSeriesIdentity | None = None,
    ) -> None:
        """Unregister a (symbol, interval) target.

        Does NOT destroy the pipeline — other symbols may use it.  Any
        forming state for this exact target is discarded so a detached
        stream cannot later be promoted to CLOSED by timeout or shutdown.
        """
        symbol = symbol.upper()
        exchange = exchange.lower().strip()
        market_type = market_type.lower().strip()
        spec = parse_interval_spec(interval)
        if spec is not None:
            interval = spec.canonical
        self._router.unregister_target(
            symbol,
            interval,
            exchange=exchange,
            market_type=market_type,
            series_identity=series_identity,
        )
        pipeline = self._pipelines.get(
            self._pipeline_key(interval, exchange, series_identity)
        )
        expired = 0
        if pipeline is not None:
            for state in pipeline.bar_state.get_all_active(exchange, market_type, symbol):
                state.close_reason = "target_removed"
                if pipeline.bar_state.expire_bar(
                    exchange,
                    market_type,
                    symbol,
                    state.bucket_start_ms,
                ) is not None:
                    expired += 1
        key = (
            exchange,
            market_type,
            symbol,
            resolve_kline_series_identity(exchange, series_identity),
        )
        if key in self._symbol_intervals:
            self._symbol_intervals[key].discard(interval)
            if not self._symbol_intervals[key]:
                self._symbol_intervals.pop(key, None)
        if expired:
            logger.info(
                "Expired %d forming bars while removing target %s:%s:%s@%s",
                expired,
                exchange,
                market_type,
                symbol,
                interval,
            )

    def get_targets(self) -> list[tuple[str, str, str, str]]:
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
        self,
        symbol: str,
        interval: str,
        bars: list[Any],
        exchange: str = "binance",
        market_type: str = "spot",
        series_identity: KlineSeriesIdentity | None = None,
    ) -> None:
        """Feed historical bars from the backfill engine.

        Each bar is converted to BarInput and processed through the
        full pipeline.
        """
        await self._router.on_backfill_bars(
            symbol,
            interval,
            bars,
            exchange=exchange,
            market_type=market_type,
            series_identity=series_identity,
        )

    async def on_custom_data(self, adapter_name: str, raw_data: Any) -> None:
        """Feed data through a registered custom adapter."""
        await self._router.on_custom_data(adapter_name, raw_data)

    async def ingest_bar_input(
        self,
        exchange: str,
        market_type: str,
        symbol: str,
        interval: str,
        bar_input: BarInput,
        *,
        emit_events: bool = True,
    ) -> None:
        """Public wrapper for feeding an already-normalized BarInput."""
        await self._handle_bar_input(
            exchange.lower().strip(),
            market_type.lower().strip(),
            symbol.upper().strip(),
            interval,
            bar_input,
            emit_events=emit_events,
        )

    def compute_bucket(
        self,
        interval: str,
        open_time_ms: int,
        *,
        exchange: str = "binance",
        series_identity: KlineSeriesIdentity | None = None,
    ) -> int | None:
        """Return the bucket start for an interval using its pipeline policy."""
        pipeline = self._pipelines.get(
            self._pipeline_key(interval, exchange, series_identity)
        )
        if pipeline is None:
            return None
        return pipeline.time_bucket.compute_bucket(open_time_ms)

    def previous_bucket(
        self,
        interval: str,
        bucket_start_ms: int,
        *,
        exchange: str = "binance",
        series_identity: KlineSeriesIdentity | None = None,
    ) -> int | None:
        """Return the previous bucket start for an interval."""
        pipeline = self._pipelines.get(
            self._pipeline_key(interval, exchange, series_identity)
        )
        if pipeline is None:
            return None
        return pipeline.time_bucket.prev_bucket(bucket_start_ms)

    def get_bucket_state(
        self,
        symbol: str,
        interval: str,
        bucket_start_ms: int,
        exchange: str = "binance",
        market_type: str = "spot",
        series_identity: KlineSeriesIdentity | None = None,
    ) -> BarState | None:
        """Return active state for a specific bucket."""
        pipeline = self._pipelines.get(
            self._pipeline_key(interval, exchange, series_identity)
        )
        if pipeline is None:
            return None
        return pipeline.bar_state.get_active(
            exchange.lower().strip(),
            market_type.lower().strip(),
            symbol.upper().strip(),
            bucket_start_ms,
        )

    def expire_bucket(
        self,
        symbol: str,
        interval: str,
        bucket_start_ms: int,
        exchange: str = "binance",
        market_type: str = "spot",
        series_identity: KlineSeriesIdentity | None = None,
    ) -> BarState | None:
        """Expire an active bucket without exposing BarStateEngine internals."""
        pipeline = self._pipelines.get(
            self._pipeline_key(interval, exchange, series_identity)
        )
        if pipeline is None:
            return None
        return pipeline.bar_state.expire_bar(
            exchange.lower().strip(),
            market_type.lower().strip(),
            symbol.upper().strip(),
            bucket_start_ms,
        )

    async def seed_active_bar(
        self,
        symbol: str,
        interval: str,
        bar_input: BarInput,
        exchange: str = "binance",
        market_type: str = "spot",
        *,
        emit_events: bool = False,
    ) -> BarState | None:
        """Seed a forming standard bucket from a trusted snapshot."""
        await self.ingest_bar_input(
            exchange,
            market_type,
            symbol,
            interval,
            bar_input,
            emit_events=emit_events,
        )
        bucket_start_ms = self.compute_bucket(
            interval,
            bar_input.open_time_ms,
            exchange=exchange,
            series_identity=bar_input.identity,
        )
        if bucket_start_ms is None:
            return None
        return self.get_bucket_state(
            symbol,
            interval,
            bucket_start_ms,
            exchange=exchange,
            market_type=market_type,
            series_identity=bar_input.identity,
        )

    async def replay_components(
        self,
        symbol: str,
        interval: str,
        components: list[BarInput],
        exchange: str = "binance",
        market_type: str = "spot",
        *,
        bucket_start_ms: int | None = None,
        expire_existing: bool = True,
        emit_events: bool = False,
        series_identity: KlineSeriesIdentity | None = None,
    ) -> BarState | None:
        """Replay base components into a target bucket and return its state."""
        identity = resolve_kline_series_identity(exchange, series_identity)
        if any(component.identity != identity for component in components):
            raise ValueError("Component series identity does not match the target")
        if bucket_start_ms is not None and expire_existing:
            self.expire_bucket(
                symbol,
                interval,
                bucket_start_ms,
                exchange=exchange,
                market_type=market_type,
                series_identity=series_identity,
            )

        for component in components:
            if component.merge_mode != MergeMode.COMPONENT:
                component = replace(component, merge_mode=MergeMode.COMPONENT)
            await self.ingest_bar_input(
                exchange,
                market_type,
                symbol,
                interval,
                component,
                emit_events=emit_events,
            )

        if bucket_start_ms is None and components:
            bucket_start_ms = self.compute_bucket(
                interval,
                components[-1].open_time_ms,
                exchange=exchange,
                series_identity=series_identity,
            )
        if bucket_start_ms is None:
            return None
        return self.get_bucket_state(
            symbol,
            interval,
            bucket_start_ms,
            exchange=exchange,
            market_type=market_type,
            series_identity=series_identity,
        )

    async def aggregate_batch(
        self,
        symbol: str,
        target_interval: str,
        source_interval: str | None,
        bars: list[Any],
        exchange: str = "binance",
        market_type: str = "spot",
        *,
        require_authoritative: bool = False,
        series_identity: KlineSeriesIdentity | None = None,
    ) -> list[BarState]:
        """Aggregate a batch in an isolated aggregator instance.

        Persistence callers must set ``require_authoritative`` so a partial
        historical component set cannot become durable merely because the
        time-based fallback closed it. Diagnostic callers retain incomplete
        active states, explicitly marked provisional, so capability masks and
        gap evidence remain inspectable without becoming publishable data.
        """
        temp = BarAggregator(self._cfg)
        temp.add_target(
            symbol,
            target_interval,
            exchange=exchange,
            market_type=market_type,
            series_identity=series_identity,
        )
        rows_by_open_time: dict[int, BarState] = {}

        async def _capture(event: BarEvent) -> None:
            if (
                require_authoritative
                and event.bar.finality != BarFinality.AUTHORITATIVE
            ):
                return
            rows_by_open_time[event.bar.bucket_start_ms] = event.bar

        temp.publisher.on_bar_closed(_capture)
        temp.publisher.on_bar_amended(_capture)
        if source_interval is not None:
            components = [
                temp.router._convert_fetched_bar(
                    bar,
                    symbol,
                    source_interval,
                    exchange=exchange,
                    market_type=market_type,
                    series_identity=series_identity,
                )
                for bar in bars
            ]
            await temp.replay_components(
                symbol,
                target_interval,
                [component for component in components if component is not None],
                exchange=exchange,
                market_type=market_type,
                series_identity=series_identity,
                expire_existing=False,
                emit_events=True,
            )
        else:
            for bar in bars:
                interval = (
                    bar.get("interval")
                    if isinstance(bar, dict)
                    else getattr(bar, "interval", None)
                )
                if interval is None:
                    raise ValueError("source_interval is required when bars do not carry interval")
                await temp.on_backfill_bars(
                    symbol,
                    interval,
                    [bar],
                    exchange=exchange,
                    market_type=market_type,
                    series_identity=series_identity,
                )
        if not require_authoritative:
            for state in temp.get_active_bars(
                symbol,
                target_interval,
                exchange=exchange,
                market_type=market_type,
                series_identity=series_identity,
            ):
                rows_by_open_time.setdefault(state.bucket_start_ms, state)
        return [rows_by_open_time[key] for key in sorted(rows_by_open_time)]

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

    def get_pipeline(
        self,
        interval: str,
        *,
        exchange: str = "binance",
        series_identity: KlineSeriesIdentity | None = None,
    ) -> IntervalPipeline | None:
        """Access a per-interval pipeline for advanced customization.

        Returns None if no pipeline exists for this interval.

        Example — swap merge strategy for 91m bars::

            pipeline = agg.get_pipeline("91m")
            if pipeline:
                pipeline.bar_state.set_merge_strategy(MyCustomMerge())
        """
        return self._pipelines.get(
            self._pipeline_key(interval, exchange, series_identity)
        )

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

    def get_latest_bar(
        self,
        symbol: str,
        interval: str,
        exchange: str = "binance",
        market_type: str = "spot",
        series_identity: KlineSeriesIdentity | None = None,
    ) -> BarState | None:
        """Get the most recent bar for a (symbol, interval) pair."""
        p = self.get_pipeline(
            interval, exchange=exchange, series_identity=series_identity
        )
        if p is None:
            return None
        return p.bar_state.get_latest_bar(exchange, market_type, symbol)

    def get_active_bars(
        self,
        symbol: str,
        interval: str,
        exchange: str = "binance",
        market_type: str = "spot",
        series_identity: KlineSeriesIdentity | None = None,
    ) -> list[BarState]:
        """Get all active (FORMING) bars for a (symbol, interval) pair."""
        p = self.get_pipeline(
            interval, exchange=exchange, series_identity=series_identity
        )
        if p is None:
            return []
        return p.bar_state.get_all_active(exchange, market_type, symbol)

    def get_recent_bars(
        self,
        symbol: str,
        interval: str,
        limit: int = 100,
        exchange: str = "binance",
        market_type: str = "spot",
        series_identity: KlineSeriesIdentity | None = None,
    ) -> list[BarState]:
        """Get recently closed bars for a (symbol, interval) pair."""
        p = self.get_pipeline(
            interval, exchange=exchange, series_identity=series_identity
        )
        if p is None:
            return []
        return p.bar_state.get_recent_closed(exchange, market_type, symbol, limit)

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
        self,
        exchange: str,
        market_type: str,
        symbol: str,
        interval: str,
        bar_input: BarInput,
        emit_events: bool = True,
    ) -> None:
        """Core processing callback: L1 → L2 → L3 → L4 → L5.

        This is the heart of the aggregator, called by the EventRouter
        for each (symbol, interval, BarInput) tuple.
        """
        pipeline = self._pipelines.get(
            self._pipeline_key(interval, exchange, bar_input.identity)
        )
        if pipeline is None:
            logger.warning("No pipeline for interval %s", interval)
            return

        # L2: Compute which bucket this input belongs to
        bucket_start_ms = pipeline.time_bucket.compute_bucket(bar_input.open_time_ms)

        # Check for event-driven close: if this input starts a new bucket,
        # close previous active bars for this symbol
        await self._check_event_driven_close(
            exchange,
            market_type,
            symbol,
            interval,
            pipeline,
            bucket_start_ms,
            bar_input,
            emit_events=emit_events,
        )

        # L3: Apply input to bar state
        state, change = pipeline.bar_state.apply(
            exchange, market_type, symbol, bucket_start_ms, bar_input,
        )

        # Drain eviction buffers — emit events for bars that were
        # force-closed or expired during apply() due to limit enforcement.
        await self._drain_eviction_buffers(pipeline, emit_events=emit_events)

        # L5: Emit lifecycle events
        if emit_events:
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
            closed = pipeline.bar_state.close_bar(
                exchange, market_type, symbol, bucket_start_ms,
            )
            if closed is not None:
                if emit_events:
                    await self._publisher.emit_closed(closed)
                # Drain eviction buffers after close_bar() — closing a bar
                # may trigger expired evictions from the closed bars cache.
                await self._drain_eviction_buffers(pipeline, emit_events=emit_events)

    async def _check_event_driven_close(
        self,
        exchange: str,
        market_type: str,
        symbol: str,
        interval: str,
        pipeline: IntervalPipeline,
        new_bucket_start_ms: int,
        bar_input: BarInput,
        *,
        emit_events: bool = True,
    ) -> None:
        """Close any older active bars when a new bucket's data arrives."""
        if not self._cfg.use_event_driven_close:
            return

        active = pipeline.bar_state.get_all_active(exchange, market_type, symbol)
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
                        exchange, market_type, symbol, state.bucket_start_ms,
                    )
                    if closed is not None:
                        if emit_events:
                            await self._publisher.emit_closed(closed)
                        await self._drain_eviction_buffers(pipeline, emit_events=emit_events)
                elif pipeline.finalizer.should_expire_unconfirmed(state, trigger):
                    state.close_reason = "next_bucket_unconfirmed"
                    expired = pipeline.bar_state.expire_bar(
                        exchange,
                        market_type,
                        symbol,
                        state.bucket_start_ms,
                    )
                    if expired is not None and emit_events:
                        await self._publisher.emit_expired(expired)

    # ── Internal: Eviction Buffer Drain ──────────────────────

    async def _drain_eviction_buffers(
        self,
        pipeline: IntervalPipeline,
        *,
        emit_events: bool = True,
    ) -> None:
        """Emit lifecycle events for bars evicted by limit enforcement.

        The BarStateEngine populates ``evicted_closed`` and ``evicted_expired``
        buffers when bars are force-closed or expired during apply()/close_bar().
        This method drains those buffers and emits the appropriate events.
        """
        # Emit CLOSED events for force-closed bars (active limit exceeded)
        if pipeline.bar_state.evicted_closed:
            if emit_events:
                for bar in pipeline.bar_state.evicted_closed:
                    await self._publisher.emit_closed(bar)
            pipeline.bar_state.evicted_closed.clear()

        # Emit EXPIRED events for expired bars (closed limit exceeded)
        if pipeline.bar_state.evicted_expired:
            if emit_events:
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
                trigger = FinalizeTrigger(
                    trigger_type="timer",
                    current_time_ms=int(time.time() * 1000),
                )
                close_event = pipeline.finalizer.check(state, trigger)
                if close_event is not None:
                    closed = pipeline.bar_state.close_bar(
                        state.exchange, state.market_type, state.symbol, state.bucket_start_ms,
                    )
                    if closed is not None:
                        await self._publisher.emit_closed(closed)
                elif pipeline.finalizer.should_expire_unconfirmed(state, trigger):
                    state.close_reason = "timeout_unconfirmed"
                    expired = pipeline.bar_state.expire_bar(
                        state.exchange,
                        state.market_type,
                        state.symbol,
                        state.bucket_start_ms,
                    )
                    if expired is not None:
                        await self._publisher.emit_expired(expired)

    # ── Internal: Flush ──────────────────────────────────────

    async def _flush_all(self) -> None:
        """Finalize active bars during shutdown without inventing authority."""
        for interval, pipeline in self._pipelines.items():
            for key in list(pipeline.bar_state._active.keys()):
                exchange, market_type, symbol, bucket_start = key
                state = pipeline.bar_state.get_active(
                    exchange,
                    market_type,
                    symbol,
                    bucket_start,
                )
                if state is None:
                    continue
                event = pipeline.finalizer.flush(state)
                if event.event_type == BarEventType.CLOSED:
                    closed = pipeline.bar_state.close_bar(
                        exchange,
                        market_type,
                        symbol,
                        bucket_start,
                    )
                    if closed is not None:
                        await self._publisher.emit_closed(closed)
                else:
                    expired = pipeline.bar_state.expire_bar(
                        exchange,
                        market_type,
                        symbol,
                        bucket_start,
                    )
                    if expired is not None:
                        await self._publisher.emit_expired(expired)
        logger.info("Flushed all active bars")
