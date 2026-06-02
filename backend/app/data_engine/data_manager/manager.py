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
                → L5 Publisher → AggregatorBridge.on_bar_event()
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
import inspect
import logging
from typing import Any, AsyncIterator, Protocol

from app.core.executors import run_storage
from app.data_engine.interval_policy import parse_interval_ms

from .aggregator_bridge import AggregatorBridge
from .cache import BarCache
from .config import DataManagerConfig
from .coordinator import IngestionFactory, StreamCoordinator
from .event_bus import DataEventBus, MiddlewareHook
from .daily_open import DailyOpenService
from .models import (
    BarData,
    DataEvent,
    DataEventType,
    EventCallback,
    QueryResult,
    SeriesKey,
    StorageBackend,
    StreamInfo,
    StreamStatus,
    SubscriptionHandle,
)
from .maintenance import MaintenanceService, RepairRequester
from .price_cache import PriceSnapshot, PriceSnapshotCache, normalize_price_key, price_key
from .query import BackfillTrigger, QueryEngine
from .backfill_coordinator import priority_for_reason
from .retention import RetentionService
from .stream_policy import StreamEnsurePlanner
from .warm_start import AggregatorWarmStartService

from ..bar_aggregator import (
    BarAggregator,
    BarAggregatorConfig,
)

logger = logging.getLogger("data_manager")


class BackfillReconcilerLike(Protocol):
    """Minimal backfill reconciler contract used during runtime wiring."""

    def set_bar_aggregator(self, aggregator: BarAggregator) -> None:
        ...


class PriceStreamControllerLike(Protocol):
    """Optional controller contract for DataManager-owned price streams."""

    async def ensure_symbol(self, key: str) -> Any:
        ...

    async def remove_symbol(self, key: str) -> Any:
        ...

    def set_watched_symbols(self, symbols: set[str]) -> Any:
        ...


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

        # ── State ────────────────────────────────────────────
        self._started = False
        self._ttl_task: asyncio.Task | None = None
        self._cleanup_task: asyncio.Task | None = None
        self._backfill_trigger: BackfillTrigger | None = None

        # ── BarAggregator (L1–L5) ───────────────────────────
        self.bar_aggregator = BarAggregator(BarAggregatorConfig())
        self.aggregator_bridge = AggregatorBridge(
            cache=self.cache,
            event_bus=self.event_bus,
            storage_provider=lambda: self.query_engine.storage,
            mark_bar_received=self.coordinator.mark_bar_received,
            is_started=lambda: self._started,
        )
        self.warm_start = AggregatorWarmStartService(
            cache=self.cache,
            bar_aggregator=self.bar_aggregator,
            base_interval=self._cfg.coordinator.base_interval,
            storage_provider=lambda: self.query_engine.storage,
            backfill_trigger_provider=lambda: self._backfill_trigger,
        )
        self.retention = RetentionService(
            cache=self.cache,
            event_bus=self.event_bus,
            storage_provider=lambda: self.query_engine.storage,
        )
        self.stream_policy = StreamEnsurePlanner(self._cfg.coordinator.base_interval)
        self.daily_open = DailyOpenService(
            storage_provider=lambda: self.query_engine.storage,
            backfill_trigger_provider=lambda: self._backfill_trigger,
        )
        self.price_cache = PriceSnapshotCache()
        self._subscriptions: Any = None
        self._price_stream_controller: PriceStreamControllerLike | None = None

        # Wire BarAggregator output → DataManager → Cache + EventBus
        self.bar_aggregator.publisher.on_bar_event(self.aggregator_bridge.on_bar_event)
        self.query_engine.set_bar_aggregator(self.bar_aggregator)

        # Tell Coordinator to route ingestion data through BarAggregator
        self.coordinator.set_bar_aggregator(self.bar_aggregator)
        self.maintenance = MaintenanceService(
            storage_provider=lambda: self.query_engine.storage,
            aggregator_config_snapshot=lambda: self.bar_aggregator.config.snapshot(),
            cache_invalidator=self.cache_invalidate,
            bars_backfilled=self.on_bars_backfilled,
            active_targets=self.bar_aggregator.get_targets,
            seed_active_bar=self.warm_start.seed_if_needed,
        )

        # Compatibility reference for older settings code.
        self._db_limits = self.retention.db_limits

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
        self.query_engine.set_storage(storage)
        self.coordinator.set_storage(storage)

    def set_ingestion_factory(self, factory: IngestionFactory) -> None:
        """Inject an ingestion factory for auto-starting streams.

        The factory creates WS connections to exchanges.  If not set,
        ``ensure_stream()`` works in passive mode (manual push only).

        Example::

            dm.set_ingestion_factory(ExchangeIngestionFactory())
        """
        self.coordinator.set_ingestion_factory(factory)

    def wire_backfill_reconciler(self, reconciler: BackfillReconcilerLike) -> None:
        """Attach this manager's BarAggregator to a backfill reconciler."""
        set_bar_aggregator = getattr(reconciler, "set_bar_aggregator", None)
        if not callable(set_bar_aggregator):
            raise TypeError("reconciler must expose set_bar_aggregator()")
        set_bar_aggregator(self.bar_aggregator)

    async def emit_event(self, event: DataEvent) -> None:
        """Emit a DataEvent through the manager-owned event bus."""
        await self.event_bus.emit(event)

    def prewarm_targets(self) -> list[tuple[str, str, str]]:
        """Return configured prewarm targets for runtime startup scans."""
        return self.coordinator.prewarm_targets()

    def prewarm_intervals(self) -> tuple[str, ...]:
        """Return configured prewarm intervals for runtime startup scans."""
        return self.coordinator.prewarm_intervals()

    def gap_audit_series(self) -> list[tuple[str, str, str, str]]:
        """Return exact series that should be included in background gap audits."""
        series: set[tuple[str, str, str, str]] = set()

        for exchange, market_type, symbol in self.prewarm_targets():
            for interval in self.prewarm_intervals():
                series.add((
                    exchange.strip().lower(),
                    self._normalize_market_type(market_type),
                    symbol.upper().strip(),
                    interval,
                ))

        for exchange, market_type, symbol, interval in self.bar_aggregator.get_targets():
            series.add((
                exchange.strip().lower(),
                self._normalize_market_type(market_type),
                symbol.upper().strip(),
                interval,
            ))

        storage = self.query_engine.storage
        list_series = getattr(storage, "list_series", None)
        if callable(list_series):
            try:
                for row in list_series(custom_only=False):
                    series.add((
                        str(row.get("exchange") or "binance").strip().lower(),
                        self._normalize_market_type(row.get("market_type") or "spot"),
                        str(row.get("symbol") or "").upper().strip(),
                        str(row.get("interval") or "").strip(),
                    ))
            except Exception:
                logger.exception("Failed to list storage series for gap audit")

        return sorted(item for item in series if item[2] and item[3])

    def set_subscription_service(self, service: Any | None) -> None:
        """Attach the runtime-owned subscription service."""
        self._subscriptions = service

    def get_subscription_service(self) -> Any | None:
        """Return the attached subscription service, if initialized."""
        return self._subscriptions

    def set_backfill_trigger(self, trigger: BackfillTrigger | None) -> None:
        """Inject a backfill trigger callback.

        Signature:
        ``(symbol, interval, start_ms, end_ms, exchange, market_type, *, reason=None,
        priority=None, requester=None, metadata=None) -> None``. Legacy callbacks
        with only the first six positional arguments remain supported.

        Called by DataManager when QueryEngine reports missing ranges.
        Also used by ingestion gap markers emitted from ContinuityLayer.

        Example::

            dm.set_backfill_trigger(backfill_service.trigger)
        """
        self._backfill_trigger = trigger
        # DataManager owns coordinator submission. QueryEngine still supports
        # direct callbacks for standalone use, but facade queries submit the
        # structured MissingRange results below.
        self.query_engine.set_backfill_trigger(None)
        if trigger is None:
            self.coordinator.set_gap_handler(None)
            return

        async def _handle_ingestion_gap(key: SeriesKey, gap: Any) -> None:
            stream_type = getattr(getattr(gap, "stream_type", None), "value", None)
            if stream_type != "kline" or getattr(gap, "filled", False):
                return

            interval_ms = parse_interval_ms(key.interval) or 0
            start_ms = int(getattr(gap, "gap_start", 0) or 0) + interval_ms
            end_ms = int(getattr(gap, "gap_end", 0) or 0) - interval_ms
            if start_ms <= 0 or end_ms <= 0 or start_ms > end_ms:
                return
            self._call_backfill_trigger(
                key.symbol,
                key.interval,
                start_ms,
                end_ms,
                key.exchange,
                key.market_type,
                reason="tail_gap",
                requester="ingestion_gap",
            )

        self.coordinator.set_gap_handler(_handle_ingestion_gap)

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

        # Startup DB cleanup (safe — no subscribers yet)
        await run_storage(self.retention.run_startup_db_cleanup)

        # Ephemeral trim loop (every 30 min)
        self._cleanup_task = asyncio.create_task(self.retention.ephemeral_trim_loop())

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

        # Stop cleanup task
        if self._cleanup_task is not None:
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
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
        exchange: str = "binance",
        market_type: str = "spot",
        auto_backfill: bool | None = None,
        backfill_reason: str | None = None,
        backfill_requester: str = "query",
    ) -> QueryResult:
        """Query K-line bars.

        This is the **primary data access method**.  Charts, indicators,
        strategies, and API endpoints should all use this.

        Args:
            symbol:      Trading pair, e.g. "BTCUSDT".
            interval:    K-line interval, e.g. "1m", "5m", "1h", "1d".
            start_ms:    Start time (ms, inclusive).  None = no lower bound.
            end_ms:      End time (ms, inclusive).  None = no upper bound.
            limit:       Max bars to return.  Default from config.
            market_type: "spot" or "futures".

        Returns:
            ``QueryResult`` with bars sorted ascending and metadata.
        """
        market_type = self._normalize_market_type(market_type)
        result = self.query_engine.query(
            symbol=symbol,
            interval=interval,
            start_ms=start_ms,
            end_ms=end_ms,
            limit=limit,
            exchange=exchange,
            market_type=market_type,
            auto_backfill=auto_backfill,
        )
        return self._submit_missing_ranges(
            result,
            reason=backfill_reason,
            requester=backfill_requester,
        )

    def query_latest(
        self,
        symbol: str,
        interval: str,
        limit: int = 500,
        exchange: str = "binance",
        market_type: str = "spot",
        auto_backfill: bool | None = None,
        backfill_reason: str | None = "latest_refresh",
        backfill_requester: str = "query_latest",
    ) -> QueryResult:
        """Get the latest N bars.  Shorthand for ``query(limit=N)``."""
        market_type = self._normalize_market_type(market_type)
        result = self.query_engine.query_latest(
            symbol,
            interval,
            limit,
            exchange=exchange,
            market_type=market_type,
            auto_backfill=auto_backfill,
        )
        return self._submit_missing_ranges(
            result,
            reason=backfill_reason,
            requester=backfill_requester,
        )

    def query_before(
        self, symbol: str, interval: str, before_ms: int, limit: int = 500,
        exchange: str = "binance",
        market_type: str = "spot",
        backfill_reason: str | None = "visible_load_more",
        backfill_requester: str = "query_before",
        auto_backfill: bool | None = None,
    ) -> QueryResult:
        """Get bars before a timestamp (for pagination / load-more)."""
        market_type = self._normalize_market_type(market_type)
        result = self.query_engine.query_before(
            symbol,
            interval,
            before_ms,
            limit,
            exchange=exchange,
            market_type=market_type,
            auto_backfill=auto_backfill,
        )
        return self._submit_missing_ranges(
            result,
            reason=backfill_reason,
            requester=backfill_requester,
        )

    def _submit_missing_ranges(
        self,
        result: QueryResult,
        *,
        reason: str | None = None,
        requester: str = "query",
    ) -> QueryResult:
        """Submit QueryEngine-detected missing ranges via DataManager."""
        if self._backfill_trigger is None or not result.missing_ranges:
            return result

        submitted = 0
        for missing in result.missing_ranges:
            demand_reason = reason or self._semantic_reason_for_missing(missing.reason)
            metadata = {
                "query_reason": missing.reason,
                "requested_range": {
                    "start_ms": missing.start_ms,
                    "end_ms": missing.end_ms,
                },
            }
            try:
                self._call_backfill_trigger(
                    missing.symbol,
                    missing.interval,
                    missing.start_ms,
                    missing.end_ms,
                    missing.exchange,
                    missing.market_type,
                    reason=demand_reason,
                    priority=priority_for_reason(demand_reason),
                    requester=requester,
                    metadata=metadata,
                )
                submitted += 1
            except Exception as exc:
                logger.error(
                    "Backfill trigger failed for %s:%s:%s@%s %d-%d: %s",
                    missing.exchange,
                    missing.market_type,
                    missing.symbol,
                    missing.interval,
                    missing.start_ms,
                    missing.end_ms,
                    exc,
                    exc_info=True,
                )

        if submitted:
            result.backfill_triggered = True
            self.query_engine.note_backfill_triggered(submitted)
        return result

    def _call_backfill_trigger(
        self,
        symbol: str,
        interval: str,
        start_ms: int,
        end_ms: int,
        exchange: str,
        market_type: str,
        *,
        reason: str | None = None,
        priority: int | None = None,
        requester: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        trigger = self._backfill_trigger
        if trigger is None:
            return

        raw_kwargs = {
            "reason": reason,
            "priority": priority,
            "requester": requester,
            "metadata": metadata,
        }
        kwargs = {key: value for key, value in raw_kwargs.items() if value is not None}
        try:
            signature = inspect.signature(trigger)
            supports_kwargs = any(
                param.kind is inspect.Parameter.VAR_KEYWORD
                for param in signature.parameters.values()
            )
            if not supports_kwargs:
                kwargs = {
                    key: value
                    for key, value in kwargs.items()
                    if key in signature.parameters
                }
        except (TypeError, ValueError):
            pass

        trigger(symbol, interval, start_ms, end_ms, exchange, market_type, **kwargs)

    def request_backfill(
        self,
        symbol: str,
        interval: str,
        start_ms: int,
        end_ms: int,
        exchange: str = "binance",
        market_type: str = "spot",
        *,
        reason: str = "query_gap",
        priority: int | None = None,
        requester: str = "data_manager",
        metadata: dict[str, Any] | None = None,
    ) -> bool:
        """Submit an explicit semantic backfill demand through the facade."""
        if self._backfill_trigger is None:
            return False
        market_type = self._normalize_market_type(market_type)
        self._call_backfill_trigger(
            symbol,
            interval,
            int(start_ms),
            int(end_ms),
            exchange,
            market_type,
            reason=reason,
            priority=priority if priority is not None else priority_for_reason(reason),
            requester=requester,
            metadata=metadata,
        )
        return True

    @staticmethod
    def _semantic_reason_for_missing(reason: str) -> str:
        if reason == "load_more_shortfall":
            return "visible_load_more"
        if reason in {"query_tail_gap"}:
            return "tail_gap"
        if reason in {"query_left_gap", "query_interior_gap", "range_verification"}:
            return "visible_range_gap"
        return reason or "query_gap"

    def get_bounds(
        self,
        symbol: str,
        interval: str,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> dict:
        """Get cache + storage bounds for a series."""
        market_type = self._normalize_market_type(market_type)
        return self.query_engine.get_bounds(symbol, interval, exchange=exchange, market_type=market_type)

    def scan_storage_gaps(
        self,
        symbol: str,
        interval: str,
        start_ms: int | None = None,
        end_ms: int | None = None,
        exchange: str = "binance",
        market_type: str = "spot",
        limit: int = 50_000,
    ) -> dict:
        """Detect storage continuity gaps without triggering repair."""
        market_type = self._normalize_market_type(market_type)
        storage = self.query_engine.storage
        scanner = getattr(storage, "scan_gaps", None)
        if not callable(scanner):
            return {
                "exchange": exchange,
                "market_type": market_type,
                "symbol": symbol.upper(),
                "interval": interval,
                "gaps": [],
                "gap_count": 0,
                "missing_bars": 0,
                "scanned_bars": 0,
                "truncated": False,
                "error": "storage does not support gap scanning",
            }
        return scanner(
            symbol=symbol,
            interval=interval,
            start_ms=start_ms,
            end_ms=end_ms,
            exchange=exchange,
            market_type=market_type,
            limit=limit,
        )

    # ═══════════════════════════════════════════════════════════
    #  Event Subscription — for real-time consumers
    # ═══════════════════════════════════════════════════════════

    def subscribe(
        self,
        callback: EventCallback,
        symbol: str | None = None,
        interval: str | None = None,
        exchange: str = "binance",
        market_type: str = "spot",
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
            market_type = self._normalize_market_type(market_type)
            key = SeriesKey(symbol, interval, exchange=exchange, market_type=market_type)
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
        exchange: str = "binance",
        market_type: str = "spot",
        event_types: set[DataEventType] | None = None,
    ) -> AsyncIterator[DataEvent]:
        """Subscribe as an async iterator.

        Usage::

            async for event in dm.subscribe_iter("BTCUSDT", "1m"):
                ws.send(event.to_dict())
        """
        key = None
        if symbol and interval:
            market_type = self._normalize_market_type(market_type)
            key = SeriesKey(symbol, interval, exchange=exchange, market_type=market_type)
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

    async def ensure_stream(
        self,
        symbol: str,
        interval: str,
        exchange: str = "binance",
        market_type: str = "spot",
        *,
        focus_scope: str = "foreground",
        subscription_tier: str | None = None,
    ) -> StreamInfo:
        """Ensure a live data stream is running.

        Also registers the (symbol, interval) target with the
        BarAggregator so that incoming data is aggregated.
        """
        market_type = self._normalize_market_type(market_type)
        plan = self.stream_policy.plan(
            symbol,
            interval,
            exchange=exchange,
            market_type=market_type,
        )
        had_stream = self.coordinator.has_stream(
            plan.requested.symbol,
            plan.requested.interval,
            exchange=plan.requested.exchange,
            market_type=plan.requested.market_type,
        )

        for target in plan.aggregation_targets:
            self.bar_aggregator.add_target(
                target.symbol,
                target.interval,
                exchange=target.exchange,
                market_type=target.market_type,
            )

        for stream in plan.prerequisite_streams:
            await self.coordinator.ensure_stream(
                stream.symbol,
                stream.interval,
                exchange=stream.exchange,
                market_type=stream.market_type,
            )

        info = await self.coordinator.ensure_stream(
            plan.requested.symbol,
            plan.requested.interval,
            exchange=plan.requested.exchange,
            market_type=plan.requested.market_type,
        )

        await self.warm_start.seed_if_needed(
            plan.requested.symbol,
            plan.requested.interval,
            exchange=plan.requested.exchange,
            market_type=plan.requested.market_type,
            had_stream=had_stream,
            focus_scope=focus_scope,
            subscription_tier=subscription_tier,
        )

        return info

    async def stop_stream(
        self,
        symbol: str,
        interval: str,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> None:
        """Stop a running data stream."""
        market_type = self._normalize_market_type(market_type)
        await self.coordinator.stop_stream(symbol, interval, exchange=exchange, market_type=market_type)
        self.bar_aggregator.remove_target(
            symbol, interval, exchange=exchange, market_type=market_type,
        )

    # ═══════════════════════════════════════════════════════════
    #  Price Streams
    # ═══════════════════════════════════════════════════════════

    def set_price_stream_controller(self, controller: PriceStreamControllerLike | None) -> None:
        """Attach the price stream source to DataManager."""
        self._price_stream_controller = controller
        self._sync_price_stream_controller()

    async def ensure_price_stream(
        self,
        symbol: str,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> StreamInfo:
        """Ensure price snapshots are tracked for one symbol."""
        market_type = self._normalize_market_type(market_type)
        normalized_exchange, normalized_market, normalized_symbol = normalize_price_key(
            symbol,
            exchange=exchange,
            market_type=market_type,
        )
        _, was_new = self.price_cache.watch(
            normalized_symbol,
            exchange=normalized_exchange,
            market_type=normalized_market,
        )
        await self._ensure_price_stream_controller(
            normalized_symbol,
            exchange=normalized_exchange,
            market_type=normalized_market,
        )
        key = SeriesKey(
            normalized_symbol,
            "price",
            exchange=normalized_exchange,
            market_type=normalized_market,
        )
        if was_new:
            await self.event_bus.emit(DataEvent(
                event_type=DataEventType.STREAM_STARTED,
                key=key,
                detail={"stream_type": "price"},
            ))
        return StreamInfo(
            key=key,
            status=StreamStatus.ACTIVE,
            started_at_ms=0,
        )

    async def stop_price_stream(
        self,
        symbol: str,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> None:
        """Stop tracking price snapshots for one symbol."""
        normalized_exchange, normalized_market, normalized_symbol = normalize_price_key(
            symbol,
            exchange=exchange,
            market_type=market_type,
        )
        _, existed = self.price_cache.unwatch(
            normalized_symbol,
            exchange=normalized_exchange,
            market_type=normalized_market,
        )
        await self._stop_price_stream_controller(
            normalized_symbol,
            exchange=normalized_exchange,
            market_type=normalized_market,
        )
        if existed:
            await self.event_bus.emit(DataEvent(
                event_type=DataEventType.STREAM_STOPPED,
                key=SeriesKey(
                    normalized_symbol,
                    "price",
                    exchange=normalized_exchange,
                    market_type=normalized_market,
                ),
                detail={"stream_type": "price"},
            ))

    def get_price(
        self,
        symbol: str,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> PriceSnapshot | None:
        """Return a single cached price snapshot."""
        return self.price_cache.get(
            symbol,
            exchange=exchange,
            market_type=self._normalize_market_type(market_type),
        )

    def get_prices_snapshot(self) -> list[dict]:
        """Return watched price snapshots for REST consumers."""
        return self.price_cache.snapshot(watched_only=True)

    async def on_price_ticks(self, ticks: list[Any]) -> None:
        """Receive price updates from the active price source."""
        snapshots: list[PriceSnapshot] = []
        for tick in ticks:
            snapshot = PriceSnapshot.from_any(tick)
            snapshot.daily_open = await self.daily_open.resolve(snapshot)
            snapshots.append(snapshot)

        for snapshot in self.price_cache.upsert_many(snapshots):
            if not self.price_cache.is_watched_key(snapshot.key):
                continue
            await self.event_bus.emit(DataEvent(
                event_type=DataEventType.PRICE_UPDATED,
                key=snapshot.series_key,
                detail={"price": snapshot.to_dict()},
            ))

    def _sync_price_stream_controller(self) -> None:
        controller = self._price_stream_controller
        if controller is None:
            return
        set_watched = getattr(controller, "set_watched_symbols", None)
        if callable(set_watched):
            set_watched(self.price_cache.watched_keys())

    async def _ensure_price_stream_controller(
        self,
        symbol: str,
        exchange: str,
        market_type: str,
    ) -> None:
        controller = self._price_stream_controller
        if controller is None:
            return
        key = self.price_cache.watch(symbol, exchange=exchange, market_type=market_type)[0]
        ensure_symbol = getattr(controller, "ensure_symbol", None)
        if callable(ensure_symbol):
            await ensure_symbol(key)
            return
        self._sync_price_stream_controller()

    async def _stop_price_stream_controller(
        self,
        symbol: str,
        exchange: str,
        market_type: str,
    ) -> None:
        controller = self._price_stream_controller
        if controller is None:
            return
        key = price_key(symbol, exchange=exchange, market_type=market_type)
        remove_symbol = getattr(controller, "remove_symbol", None)
        if callable(remove_symbol):
            await remove_symbol(key)
            return
        self._sync_price_stream_controller()

    def get_stream_info(
        self,
        symbol: str,
        interval: str,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> StreamInfo | None:
        """Get info about a specific stream."""
        market_type = self._normalize_market_type(market_type)
        return self.coordinator.get_stream_info(symbol, interval, exchange=exchange, market_type=market_type)

    def get_all_streams(self) -> list[StreamInfo]:
        """Get info about all active streams."""
        return self.coordinator.get_all_streams()

    # ═══════════════════════════════════════════════════════════
    #  Cache Operations
    # ═══════════════════════════════════════════════════════════

    def cache_invalidate(
        self,
        symbol: str,
        interval: str,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> None:
        """Invalidate (clear) cached bars for a series."""
        market_type = self._normalize_market_type(market_type)
        self.cache.invalidate(SeriesKey(symbol, interval, exchange=exchange, market_type=market_type))

    def cache_clear(self) -> None:
        """Clear all cached data."""
        self.cache.clear()

    # ═══════════════════════════════════════════════════════════
    #  Maintenance Facade
    # ═══════════════════════════════════════════════════════════

    async def repair_custom_storage(
        self,
        *,
        symbols_filter: list[str] | None,
        backfill_coordinator: RepairRequester | None,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> dict:
        """Check and rebuild stored custom-interval rows."""
        return await self.maintenance.repair_custom_storage(
            symbols_filter=symbols_filter,
            backfill_coordinator=backfill_coordinator,
            exchange=exchange,
            market_type=self._normalize_market_type(market_type),
        )

    async def scan_and_fill_storage_gaps(
        self,
        *,
        symbols_filter: list[str] | None,
        backfill_coordinator: RepairRequester | None,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> dict:
        """Scan stored standard intervals for gaps and repair them."""
        return await self.maintenance.scan_and_fill_gaps(
            symbols_filter=symbols_filter,
            backfill_coordinator=backfill_coordinator,
            exchange=exchange,
            market_type=self._normalize_market_type(market_type),
        )

    async def delete_storage_data(
        self,
        *,
        symbol: str,
        interval: str,
        start_ms: int | None = None,
        end_ms: int | None = None,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> int:
        """Delete stored bars for a series and invalidate its cache."""
        return await self.maintenance.delete_storage_data(
            symbol=symbol,
            interval=interval,
            start_ms=start_ms,
            end_ms=end_ms,
            exchange=exchange,
            market_type=self._normalize_market_type(market_type),
        )

    # ═══════════════════════════════════════════════════════════
    #  Bar Ingestion — integration point for bar_aggregator
    # ═══════════════════════════════════════════════════════════

    async def on_bar_event(
        self,
        symbol: str,
        interval: str,
        bar: BarData,
        event_type: DataEventType = DataEventType.BAR_UPDATED,
        exchange: str = "binance",
        market_type: str = "spot",
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
        await self.coordinator.on_bar_event(
            symbol,
            interval,
            bar,
            event_type,
            exchange=exchange,
            market_type=self._normalize_market_type(market_type),
        )

    async def on_bars_backfilled(
        self,
        symbol: str,
        interval: str,
        bars: list[BarData],
        exchange: str = "binance",
        market_type: str = "spot",
        event_detail: dict[str, Any] | None = None,
    ) -> None:
        """Receive backfilled bars and merge into cache.

        Called by the backfill module after historical data is fetched
        and reconciled.  Bars are loaded into cache and a completion
        event is emitted. Follow-up repair scheduling belongs to
        BackfillCoordinator, not this cache merge hook.
        """
        if not bars:
            return

        market_type = self._normalize_market_type(market_type)
        key = SeriesKey(symbol, interval, exchange=exchange, market_type=market_type)
        self.cache.bulk_load(key, bars)

        detail = {
            "bars_count": len(bars),
            "earliest": bars[0].time,
            "latest": bars[-1].time,
        }
        if event_detail:
            detail.update(event_detail)

        # Emit completion event
        await self.event_bus.emit(DataEvent(
            event_type=DataEventType.BACKFILL_COMPLETED,
            key=key,
            detail=detail,
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
            "retention": self.retention.snapshot(),
            "price_cache": self.price_cache.diagnostics(),
        }

    @property
    def config(self) -> DataManagerConfig:
        """Access the configuration (read-only reference)."""
        return self._cfg

    @staticmethod
    def _normalize_market_type(market_type: str) -> str:
        return (market_type or "spot").strip().lower()

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

    # ═══════════════════════════════════════════════════════════
    #  Data Retention Cleanup
    # ═══════════════════════════════════════════════════════════

    def update_retention_limits(
        self,
        db_limits: dict[str, int] | None = None,
        ephemeral_bars: int | None = None,
    ) -> None:
        """Update data retention limits from frontend settings.

        Args:
            db_limits:      {"minutes": N, "hours": N, "daily": N} where 0 = unlimited.
            ephemeral_bars: Max bars per ephemeral series (e.g. 86400 for 24h of 1s).
        """
        self.retention.update_limits(
            db_limits=db_limits,
            ephemeral_bars=ephemeral_bars,
        )

    def retention_snapshot(self) -> dict:
        """Return the current data retention settings."""
        return self.retention.snapshot()
