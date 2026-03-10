"""
DataManager — the single public facade for all data operations.

**This is the class that the rest of the application uses.**
Charts, indicators, strategies, API endpoints, and WebSocket hubs
all interact with ``DataManager`` instead of touching cache, storage,
or ingestion modules directly.

Responsibilities:
  * Unified query interface (``query``, ``query_latest``, ``query_before``)
  * Event subscription (``subscribe``, ``subscribe_iter``)
  * Stream lifecycle (``ensure_stream``, ``stop_stream``)
  * Cache prewarm and maintenance
  * Diagnostic snapshots
  * **BarAggregator integration** — wires ingestion → aggregation → cache

Architecture::

    ┌─────────────────────────────────────────────────────────┐
    │                DataManager  (facade)                    │
    │                                                         │
    │  ┌───────┐  ┌──────────┐  ┌─────────────┐              │
    │  │ Cache │  │QueryEngine│  │  EventBus   │              │
    │  └───┬───┘  └─────┬────┘  └──────┬──────┘              │
    │      │            │              │                      │
    │  ┌───┴────────────┴──────────────┴──────┐               │
    │  │       StreamCoordinator              │               │
    │  │  (ingestion lifecycle management)    │               │
    │  └──────────────┬───────────────────────┘               │
    │                 │                                       │
    │  ┌──────────────┴───────────────────────┐               │
    │  │       BarAggregator (L1–L5)          │               │
    │  │  (time-bucket, OHLCV merge, close)   │               │
    │  └──────────────────────────────────────┘               │
    └─────────────────────────────────────────────────────────┘

    Data flow:
      Ingestion → BarAggregator.on_market_event()
                → L1 Router → L2 TimeBucket → L3 BarState → L4 Finalizer
                → L5 Publisher → DataManager._on_aggregator_event()
                → Cache + EventBus → Subscribers (WS, API, etc.)

Usage::

    from data_manager import DataManager, DataManagerConfig

    dm = DataManager()                  # default config
    dm = DataManager(DataManagerConfig(...))  # custom config

    # Set optional backends
    dm.set_storage(my_storage_backend)
    dm.set_ingestion_factory(my_factory)

    # Start
    await dm.start()

    # Query — charts, indicators, strategies all use this
    result = dm.query("BTCUSDT", "1m", limit=500)
    result = dm.query("BTCUSDT", "1h", start_ms=..., end_ms=...)

    # Subscribe to events — WebSocket hub, indicator engine, etc.
    handle = dm.subscribe(
        callback=on_bar,
        symbol="BTCUSDT",
        interval="1m",
        event_types={DataEventType.BAR_CLOSED},
    )

    # Async iterator style
    async for event in dm.subscribe_iter("BTCUSDT", "1m"):
        push_to_websocket(event)

    # Shutdown
    await dm.shutdown()
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, AsyncIterator

from app.core.market import parse_custom_interval

from .cache import BarCache
from .config import DataManagerConfig
from .coordinator import IngestionFactory, StreamCoordinator
from .event_bus import DataEventBus, MiddlewareHook
from .models import (
    BarData,
    DataEvent,
    DataEventType,
    EventCallback,
    QueryResult,
    SeriesKey,
    StorageBackend,
    StreamInfo,
    SubscriptionHandle,
)
from .query import QueryEngine

from ..bar_aggregator import (
    BarAggregator,
    BarAggregatorConfig,
    BarInput,
    BarInputSource,
    BarEvent,
    BarEventType,
    BarState,
)

logger = logging.getLogger("data_manager")


class DataManager:
    """Unified facade for all K-line data operations.

    This is the **only** class that external code needs to import.
    It composes:
      * ``BarCache`` — in-memory bar storage
      * ``QueryEngine`` — three-level query resolution
      * ``DataEventBus`` — pub/sub event delivery
      * ``StreamCoordinator`` — stream lifecycle management
      * ``BarAggregator`` — L1–L5 aggregation pipeline

    All sub-components are accessible for advanced use cases,
    but the facade methods cover 95% of needs.
    """

    def __init__(self, config: DataManagerConfig | None = None) -> None:
        self._cfg = config or DataManagerConfig()

        # ── Core components ──────────────────────────────────
        self.cache = BarCache(self._cfg.cache)
        self.event_bus = DataEventBus(self._cfg.event_bus)
        self.coordinator = StreamCoordinator(
            config=self._cfg.coordinator,
            cache=self.cache,
            event_bus=self.event_bus,
        )
        self.query_engine = QueryEngine(
            cache=self.cache,
            config=self._cfg.query,
        )

        # ── BarAggregator (L1–L5) ───────────────────────────
        self.bar_aggregator = BarAggregator(BarAggregatorConfig())

        # Wire BarAggregator output → DataManager → Cache + EventBus
        self.bar_aggregator.publisher.on_bar_event(self._on_aggregator_event)

        # Tell Coordinator to route ingestion data through BarAggregator
        self.coordinator.set_bar_aggregator(self.bar_aggregator)

        # ── State ────────────────────────────────────────────
        self._started = False
        self._ttl_task: asyncio.Task | None = None

    # ═══════════════════════════════════════════════════════════
    #  Setup — call before start()
    # ═══════════════════════════════════════════════════════════

    def set_storage(self, storage: StorageBackend) -> None:
        """Inject a storage backend (SQLite, PostgreSQL, etc.).

        The storage is shared across the query engine, coordinator,
        and backfill system.

        Must be called before ``start()`` for prewarm to work.

        Example::

            from app.data_engine.storage.klines_repo import KlinesRepoAdapter
            dm.set_storage(KlinesRepoAdapter())
        """
        self.query_engine._storage = storage
        self.coordinator.set_storage(storage)

    def set_ingestion_factory(self, factory: IngestionFactory) -> None:
        """Inject an ingestion factory for auto-starting streams.

        The factory creates WS connections to exchanges.  If not set,
        ``ensure_stream()`` works in passive mode (manual push only).

        Example::

            dm.set_ingestion_factory(BinanceIngestionFactory())
        """
        self.coordinator.set_ingestion_factory(factory)

    def set_backfill_trigger(self, trigger: Any) -> None:
        """Inject a backfill trigger callback.

        Signature: ``(symbol, interval, start_ms, end_ms) -> None``

        Called by the query engine when gaps are detected.

        Example::

            dm.set_backfill_trigger(backfill_service.trigger)
        """
        self.query_engine._backfill_trigger = trigger

    # ═══════════════════════════════════════════════════════════
    #  Lifecycle
    # ═══════════════════════════════════════════════════════════

    async def start(self) -> None:
        """Start the Data Manager.

        This:
          1. Starts the BarAggregator (timeout checker, etc.).
          2. Prewarms the cache from storage (if configured).
          3. Starts the idle-stream reaper.
          4. Starts TTL-based cache eviction (if configured).
        """
        if self._started:
            return
        self._started = True
        logger.info("DataManager starting...")

        # Start BarAggregator
        await self.bar_aggregator.start()

        # Prewarm
        await self.coordinator.prewarm()

        # Start background tasks
        await self.coordinator.start_reaper()

        # TTL eviction task
        if self._cfg.cache.ttl_seconds > 0:
            self._ttl_task = asyncio.create_task(self._ttl_loop())

        logger.info("DataManager started")

    async def shutdown(self) -> None:
        """Gracefully shut down everything."""
        if not self._started:
            return
        self._started = False
        logger.info("DataManager shutting down...")

        # Stop TTL task
        if self._ttl_task is not None:
            self._ttl_task.cancel()
            try:
                await self._ttl_task
            except asyncio.CancelledError:
                pass

        # Stop coordinator (stops ingestion streams)
        await self.coordinator.shutdown()

        # Stop BarAggregator (flushes active bars)
        await self.bar_aggregator.stop()

        # Close event bus
        await self.event_bus.close()

        logger.info("DataManager shutdown complete")

    # ═══════════════════════════════════════════════════════════
    #  Query Interface — the main API for data consumers
    # ═══════════════════════════════════════════════════════════

    def query(
        self,
        symbol: str,
        interval: str,
        start_ms: int | None = None,
        end_ms: int | None = None,
        limit: int | None = None,
    ) -> QueryResult:
        """Query K-line bars.

        This is the **primary data access method**.  Charts, indicators,
        strategies, and API endpoints should all use this.

        Args:
            symbol:    Trading pair, e.g. "BTCUSDT".
            interval:  K-line interval, e.g. "1m", "5m", "1h", "1d".
            start_ms:  Start time (ms, inclusive).  None = no lower bound.
            end_ms:    End time (ms, inclusive).  None = no upper bound.
            limit:     Max bars to return.  Default from config.

        Returns:
            ``QueryResult`` with bars sorted ascending and metadata.

        Example::

            result = dm.query("BTCUSDT", "1m", limit=500)
            for bar in result.bars:
                print(bar.time, bar.close)
        """
        return self.query_engine.query(
            symbol=symbol,
            interval=interval,
            start_ms=start_ms,
            end_ms=end_ms,
            limit=limit,
        )

    def query_latest(self, symbol: str, interval: str, limit: int = 500) -> QueryResult:
        """Get the latest N bars.  Shorthand for ``query(limit=N)``."""
        return self.query_engine.query_latest(symbol, interval, limit)

    def query_before(
        self, symbol: str, interval: str, before_ms: int, limit: int = 500,
    ) -> QueryResult:
        """Get bars before a timestamp (for pagination / load-more)."""
        return self.query_engine.query_before(symbol, interval, before_ms, limit)

    def get_bounds(self, symbol: str, interval: str) -> dict:
        """Get cache + storage bounds for a series."""
        return self.query_engine.get_bounds(symbol, interval)

    # ═══════════════════════════════════════════════════════════
    #  Event Subscription — for real-time consumers
    # ═══════════════════════════════════════════════════════════

    def subscribe(
        self,
        callback: EventCallback,
        symbol: str | None = None,
        interval: str | None = None,
        event_types: set[DataEventType] | None = None,
    ) -> SubscriptionHandle:
        """Subscribe to bar/stream events via callback.

        Args:
            callback:    Async function ``(DataEvent) -> None``.
            symbol:      Filter to this symbol.  None = all symbols.
            interval:    Filter to this interval.  None = all intervals.
            event_types: Filter to these event types.  None = all.

        Returns:
            ``SubscriptionHandle`` — pass to ``unsubscribe()`` to stop.

        Example::

            async def on_bar(event: DataEvent):
                if event.bar:
                    chart.update(event.bar.to_dict())

            handle = dm.subscribe(
                callback=on_bar,
                symbol="BTCUSDT",
                interval="1m",
                event_types={DataEventType.BAR_UPDATED, DataEventType.BAR_CLOSED},
            )
        """
        key = None
        if symbol and interval:
            key = SeriesKey(symbol, interval)
        elif symbol or interval:
            raise ValueError(
                "Both 'symbol' and 'interval' must be provided together, "
                f"or both omitted. Got symbol={symbol!r}, interval={interval!r}"
            )
        return self.event_bus.subscribe(
            callback=callback, key=key, event_types=event_types,
        )

    def unsubscribe(self, handle: SubscriptionHandle) -> None:
        """Remove a subscription."""
        self.event_bus.unsubscribe(handle)

    async def subscribe_iter(
        self,
        symbol: str | None = None,
        interval: str | None = None,
        event_types: set[DataEventType] | None = None,
    ) -> AsyncIterator[DataEvent]:
        """Subscribe as an async iterator.

        Usage::

            async for event in dm.subscribe_iter("BTCUSDT", "1m"):
                ws.send(event.to_dict())
        """
        key = None
        if symbol and interval:
            key = SeriesKey(symbol, interval)
        elif symbol or interval:
            raise ValueError(
                "Both 'symbol' and 'interval' must be provided together, "
                f"or both omitted. Got symbol={symbol!r}, interval={interval!r}"
            )
        async for event in self.event_bus.subscribe_iter(
            key=key, event_types=event_types,
        ):
            yield event

    # ═══════════════════════════════════════════════════════════
    #  Stream Management
    # ═══════════════════════════════════════════════════════════

    async def ensure_stream(self, symbol: str, interval: str) -> StreamInfo:
        """Ensure a live data stream is running.

        If the stream is already active, returns immediately.
        If ``auto_start_ingestion`` is True, starts the pipeline.

        Also registers the (symbol, interval) target with the
        BarAggregator so that incoming data is aggregated.

        For **non-standard intervals** (e.g. 7m, 11m, 45m), the base
        interval (typically 1m) is also registered as an aggregation
        target, ensuring the Router can fan out 1m data to the custom
        interval.  The coordinator handles reusing the base interval's
        WS connection instead of opening a new one.

        This is typically called when:
          * A user opens a chart for a new symbol/interval
          * A strategy subscribes to a new data feed
          * The system prewarms on startup
        """
        stream_key = SeriesKey(symbol, interval)
        had_stream = stream_key in self.coordinator._streams

        # Register aggregation target
        self.bar_aggregator.add_target(symbol, interval)

        # For non-standard intervals, also register the base interval
        # so the Router has a source target to receive and fan out data.
        from ..bar_aggregator.models import is_standard_interval
        if not is_standard_interval(interval):
            base = self._cfg.coordinator.base_interval  # typically "1m"
            self.bar_aggregator.add_target(symbol, base)

        info = await self.coordinator.ensure_stream(symbol, interval)

        if not is_standard_interval(interval) and not had_stream:
            try:
                await self._seed_custom_interval(symbol, interval)
            except Exception as exc:
                logger.warning(
                    "Failed to seed active custom bucket for %s@%s: %s",
                    symbol, interval, exc,
                    exc_info=True,
                )
            self._trigger_custom_tail_repair(symbol, interval)

        return info

    async def stop_stream(self, symbol: str, interval: str) -> None:
        """Stop a running data stream."""
        await self.coordinator.stop_stream(symbol, interval)
        self.bar_aggregator.remove_target(symbol, interval)

    def get_stream_info(self, symbol: str, interval: str) -> StreamInfo | None:
        """Get info about a specific stream."""
        return self.coordinator.get_stream_info(symbol, interval)

    def get_all_streams(self) -> list[StreamInfo]:
        """Get info about all active streams."""
        return self.coordinator.get_all_streams()

    # ═══════════════════════════════════════════════════════════
    #  Cache Operations
    # ═══════════════════════════════════════════════════════════

    def cache_invalidate(self, symbol: str, interval: str) -> None:
        """Invalidate (clear) cached bars for a series."""
        self.cache.invalidate(SeriesKey(symbol, interval))

    def cache_clear(self) -> None:
        """Clear all cached data."""
        self.cache.clear()

    # ═══════════════════════════════════════════════════════════
    #  Bar Ingestion — integration point for bar_aggregator
    # ═══════════════════════════════════════════════════════════

    async def on_bar_event(
        self,
        symbol: str,
        interval: str,
        bar: BarData,
        event_type: DataEventType = DataEventType.BAR_UPDATED,
    ) -> None:
        """Push a bar event into the system.

        This is the integration point for ``bar_aggregator.publisher``.
        The bar is written to cache and forwarded to all subscribers.

        Args:
            symbol:     Trading pair.
            interval:   K-line interval.
            bar:        The bar data.
            event_type: BAR_CREATED, BAR_UPDATED, or BAR_CLOSED.
        """
        await self.coordinator.on_bar_event(symbol, interval, bar, event_type)

    async def on_bars_backfilled(
        self, symbol: str, interval: str, bars: list[BarData],
    ) -> None:
        """Receive backfilled bars and merge into cache.

        Called by the backfill module after historical data is fetched
        and reconciled.  Bars are loaded into cache and a completion
        event is emitted.
        """
        if not bars:
            return

        key = SeriesKey(symbol, interval)
        self.cache.bulk_load(key, bars)

        # Emit completion event
        await self.event_bus.emit(DataEvent(
            event_type=DataEventType.BACKFILL_COMPLETED,
            key=key,
            detail={
                "bars_count": len(bars),
                "earliest": bars[0].time,
                "latest": bars[-1].time,
            },
        ))

    # ═══════════════════════════════════════════════════════════
    #  Middleware
    # ═══════════════════════════════════════════════════════════

    def add_middleware(self, hook: MiddlewareHook) -> None:
        """Add a middleware hook to the event bus."""
        self.event_bus.add_middleware(hook)

    def remove_middleware(self, hook: MiddlewareHook) -> None:
        """Remove a middleware hook."""
        self.event_bus.remove_middleware(hook)

    # ═══════════════════════════════════════════════════════════
    #  Diagnostics
    # ═══════════════════════════════════════════════════════════

    def snapshot(self) -> dict:
        """Full diagnostic snapshot of the Data Manager."""
        return {
            "started": self._started,
            "config": self._cfg.snapshot(),
            "cache": self.cache.snapshot(),
            "query_engine": self.query_engine.snapshot(),
            "event_bus": self.event_bus.snapshot(),
            "coordinator": self.coordinator.snapshot(),
            "bar_aggregator": self.bar_aggregator.snapshot(),
        }

    @property
    def config(self) -> DataManagerConfig:
        """Access the configuration (read-only reference)."""
        return self._cfg

    # ═══════════════════════════════════════════════════════════
    #  Async Context Manager
    # ═══════════════════════════════════════════════════════════

    async def __aenter__(self) -> DataManager:
        """Support ``async with DataManager() as dm:`` usage."""
        await self.start()
        return self

    async def __aexit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        await self.shutdown()

    # ═══════════════════════════════════════════════════════════
    #  Internal: BarAggregator → Cache + EventBus Bridge
    # ═══════════════════════════════════════════════════════════

    async def _on_aggregator_event(self, event: BarEvent) -> None:
        """Bridge callback: BarAggregator L5 Publisher → DataManager.

        Converts ``bar_aggregator.BarEvent`` into ``data_manager.DataEvent``
        and routes to Cache + EventBus.

        This is the key integration point that was previously missing —
        it ensures all data flows through the full L1–L5 pipeline before
        reaching the cache and subscribers.
        """
        bar_state: BarState = event.bar
        bar_data = BarData.from_bar_state(bar_state)
        symbol = bar_state.symbol
        interval = bar_state.interval
        key = SeriesKey(symbol, interval)

        # Map BarAggregator event types → DataManager event types
        event_type_map = {
            BarEventType.CREATED: DataEventType.BAR_CREATED,
            BarEventType.UPDATED: DataEventType.BAR_UPDATED,
            BarEventType.CLOSED: DataEventType.BAR_CLOSED,
            BarEventType.AMENDED: DataEventType.BAR_AMENDED,
            BarEventType.EXPIRED: DataEventType.BAR_EXPIRED,
        }
        dm_event_type = event_type_map.get(
            event.event_type, DataEventType.BAR_UPDATED,
        )

        # Update cache
        if dm_event_type == DataEventType.BAR_CLOSED:
            self.cache.append(key, bar_data)
        elif dm_event_type in (
            DataEventType.BAR_CREATED,
            DataEventType.BAR_UPDATED,
            DataEventType.BAR_AMENDED,
        ):
            self.cache.upsert(key, bar_data)

        # Update stream info in coordinator
        entry = self.coordinator._streams.get(key)
        if entry is not None:
            import time as _time
            entry.info.bars_received += 1
            entry.info.last_bar_at_ms = int(_time.time() * 1000)

        # Forward to EventBus
        dm_event = DataEvent(
            event_type=dm_event_type,
            key=key,
            bar=bar_data,
        )
        if event.previous_bar is not None:
            dm_event.previous_bar = BarData.from_bar_state(event.previous_bar)

        await self.event_bus.emit(dm_event)

    async def _seed_custom_interval(self, symbol: str, interval: str) -> None:
        """Seed the currently-forming custom bucket from recent base bars.

        Without this, if a user subscribes midway through an active custom
        bucket (for example a 7m candle in minute 5), the aggregator would
        only see subsequent realtime base bars and incorrectly treat the
        first seen component as the bucket's open.
        """
        pipeline = self.bar_aggregator.get_pipeline(interval)
        storage = self.query_engine._storage
        if pipeline is None or storage is None:
            return

        base_interval = self._cfg.coordinator.base_interval
        base_seconds = parse_custom_interval(base_interval) or 60
        now_ms = int(time.time() * 1000)
        bucket_start_ms = pipeline.time_bucket.compute_bucket(now_ms)

        rows = storage.query_bars(
            symbol=symbol.upper(),
            interval=base_interval,
            start_ms=bucket_start_ms,
            end_ms=now_ms,
            order="ASC",
        )
        base_key = SeriesKey(symbol, base_interval)
        rows_by_open_time = {
            int(row["open_time"]): dict(row) for row in rows
        }
        cached_rows = self.cache.query(
            base_key,
            start_time=bucket_start_ms // 1000,
            end_time=now_ms // 1000,
        )
        for cached in cached_rows:
            open_time_ms = cached.time * 1000
            if open_time_ms < bucket_start_ms:
                continue

            close_time_ms = open_time_ms + (base_seconds * 1000) - 1
            rows_by_open_time[open_time_ms] = {
                "open_time": open_time_ms,
                "close_time": close_time_ms,
                "open": cached.open,
                "high": cached.high,
                "low": cached.low,
                "close": cached.close,
                "volume": cached.volume,
                "quote_volume": 0.0,
                "trades": 0,
                "taker_buy_base": 0.0,
                "taker_buy_quote": 0.0,
            }

        if not rows_by_open_time:
            return

        rows = sorted(rows_by_open_time.values(), key=lambda row: int(row["open_time"]))

        for row in rows:
            open_time_ms = int(row["open_time"])
            close_time_ms = int(row.get("close_time", open_time_ms + (base_seconds * 1000) - 1))
            is_closed = close_time_ms < now_ms
            bar_input = BarInput(
                symbol=symbol.upper(),
                source_interval=base_interval,
                open_time_ms=open_time_ms,
                close_time_ms=close_time_ms,
                open=float(row["open"]),
                high=float(row["high"]),
                low=float(row["low"]),
                close=float(row["close"]),
                volume=float(row.get("volume", 0)),
                source=BarInputSource.BACKFILL if is_closed else BarInputSource.REALTIME,
                is_closed=is_closed,
                quote_volume=float(row.get("quote_volume", 0) or 0),
                trades=int(row.get("trades", 0) or 0),
                taker_buy_base=float(row.get("taker_buy_base", 0) or 0),
                taker_buy_quote=float(row.get("taker_buy_quote", 0) or 0),
                sequence=open_time_ms,
            )
            await self.bar_aggregator._handle_bar_input(
                symbol.upper(), interval, bar_input,
            )

    def _trigger_custom_tail_repair(self, symbol: str, interval: str) -> None:
        """Force a recent custom-interval rebuild to overwrite stale rows.

        Historical custom bars may already be persisted with older, incorrect
        aggregation semantics. Trigger a focused tail backfill so the latest
        visible bars are recomputed and the frontend can reload them on the
        subsequent BACKFILL_COMPLETED event.
        """
        trigger = self.query_engine._backfill_trigger
        if trigger is None:
            return

        interval_seconds = parse_custom_interval(interval) or 60
        now_ms = int(time.time() * 1000)
        repair_window_ms = min(
            max(interval_seconds * 16 * 1000, 6 * 60 * 60 * 1000),
            7 * 24 * 60 * 60 * 1000,
        )
        start_ms = max(0, now_ms - repair_window_ms)

        try:
            trigger(symbol.upper(), interval, start_ms, now_ms)
        except Exception as exc:
            logger.warning(
                "Failed to trigger custom tail repair for %s@%s: %s",
                symbol, interval, exc,
                exc_info=True,
            )

    # ═══════════════════════════════════════════════════════════
    #  Internal
    # ═══════════════════════════════════════════════════════════

    async def _ttl_loop(self) -> None:
        """Background loop for TTL-based cache eviction."""
        interval = max(30, self._cfg.cache.ttl_seconds // 2)
        try:
            while True:
                await asyncio.sleep(interval)
                evicted = self.cache.evict_idle()
                if evicted:
                    logger.debug("TTL eviction: removed %d series", evicted)
        except asyncio.CancelledError:
            pass
