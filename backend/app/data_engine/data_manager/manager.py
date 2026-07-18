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
import threading
import time
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Protocol

from app.core.executors import run_storage
from app.data_engine.interval_policy import parse_interval_ms
from app.data_engine.market_data.models import MarketStreamKey

from .aggregator_bridge import AggregatorBridge
from .auto_gc import (
    AutoGcPolicy,
    auto_gc_loop,
    filter_auto_storage_plan,
    run_auto_gc_once,
)
from .cache import BarCache
from .config import DataManagerConfig
from .coordinator import IngestionFactory, StreamCoordinator
from .event_bus import DataEventBus, MiddlewareHook
from .cache_behavior import CacheAccessEvent, CacheBehaviorStore
from .gc import execute_memory_gc_plan, plan_memory_gc
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
    audience_for_backfill_reason,
)
from .maintenance import MaintenanceService, RepairRequester
from .price_cache import PriceSnapshot, PriceSnapshotCache, normalize_price_key, price_key
from .query import BackfillTrigger, QueryEngine
from .backfill_coordinator import priority_for_reason
from .retention import RetentionService
from .runtime_pressure import (
    disk_pressure_snapshot,
    process_memory_snapshot,
    storage_file_snapshot,
)
from .storage_intents import PRIORITY_RANK, StorageIntentRegistry, WILDCARD_INTERVAL
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


@dataclass(slots=True)
class _StreamLease:
    """Consumer ownership for one backend stream entry."""

    consumers: set[str] = field(default_factory=set)


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
        self._storage_gc_guard = threading.RLock()
        self._storage_gc_protection_epoch = 0

        # ── Core components ──────────────────────────────────
        self.cache = BarCache(self._cfg.cache)
        self.event_bus = DataEventBus(
            self._cfg.event_bus,
            protection_lock=self._storage_gc_guard,
            on_subscription_change=self._mark_storage_gc_protection_changed,
        )
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
        self._auto_gc_task: asyncio.Task | None = None
        self._cache_access_loop: asyncio.AbstractEventLoop | None = None
        self._cache_access_tasks: set[asyncio.Task] = set()
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
        self.storage_intents = StorageIntentRegistry(
            lock=self._storage_gc_guard,
            on_change=self._mark_storage_gc_protection_changed,
        )
        self.cache_behavior = CacheBehaviorStore()
        self._subscriptions: Any = None
        self._price_stream_controller: PriceStreamControllerLike | None = None
        self._market_data_service: Any = None
        self._trade_flow_service: Any = None
        self._liquidation_service: Any = None
        self._order_book_service: Any = None
        self._full_order_book_service: Any = None
        self._stream_leases: dict[SeriesKey, _StreamLease] = {}
        self._memory_gc_last_report: dict[str, Any] | None = None
        self._storage_gc_last_report: dict[str, Any] | None = None
        self._auto_gc_last_report: dict[str, Any] | None = None
        self._auto_gc_health: dict[str, Any] = {
            "status": "not-started",
            "task_alive": False,
        }
        self._auto_gc_policy = AutoGcPolicy.from_env()

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
            storage_gc_protection=self._storage_gc_protection_reason,
            storage_gc_delete_batch=self._storage_gc_delete_batch,
            storage_gc_replanner=self._storage_gc_replan_for_execution,
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

    def set_history_policy(self, history_policy: Any | None) -> None:
        """Inject the shared history availability/calendar resolver."""
        self.query_engine.set_history_policy(history_policy)

    @property
    def history_policy(self) -> Any | None:
        """Return the configured shared history resolver, if any."""
        return self.query_engine.history_policy

    def set_ingestion_factory(self, factory: IngestionFactory) -> None:
        """Inject an ingestion factory for auto-starting streams.

        The factory creates WS connections to exchanges.  If not set,
        ``ensure_stream()`` works in passive mode (manual push only).

        Example::

            dm.set_ingestion_factory(ExchangeIngestionFactory())
        """
        self.coordinator.set_ingestion_factory(factory)

    def set_market_data_service(self, service: Any) -> None:
        """Attach the independent advanced market-data service."""

        required = (
            "ensure_stream",
            "release_stream",
            "snapshot",
            "history",
            "subscribe",
            "diagnostics",
        )
        if any(not callable(getattr(service, name, None)) for name in required):
            raise TypeError("market data service does not implement the required facade")
        self._market_data_service = service

    def set_trade_flow_service(self, service: Any) -> None:
        """Attach the append-only aggregate-trade/TradeFlow service."""

        required = (
            "ensure_stream",
            "release_stream",
            "recent",
            "history",
            "attach",
            "archive_coverage",
            "diagnostics",
        )
        if any(not callable(getattr(service, name, None)) for name in required):
            raise TypeError("trade flow service does not implement the required facade")
        self._trade_flow_service = service

    def set_liquidation_service(self, service: Any) -> None:
        """Attach the append-only public-liquidation observation service."""

        required = (
            "ensure_stream",
            "release_stream",
            "recent",
            "history",
            "attach",
            "diagnostics",
        )
        if any(not callable(getattr(service, name, None)) for name in required):
            raise TypeError("liquidation service does not implement the required facade")
        self._liquidation_service = service

    def set_order_book_service(self, service: Any) -> None:
        """Attach the latest-wins Partial Top-N order-book service."""

        required = (
            "ensure_stream",
            "release_stream",
            "current",
            "wait_for_snapshot",
            "attach",
            "diagnostics",
        )
        if any(not callable(getattr(service, name, None)) for name in required):
            raise TypeError("order-book service does not implement the required facade")
        self._order_book_service = service

    def set_full_order_book_service(self, service: Any) -> None:
        """Attach the sequence-consistent reconstructed order-book service."""

        required = (
            "ensure_stream",
            "release_stream",
            "current",
            "wait_for_live",
            "attach",
            "diagnostics",
        )
        if any(not callable(getattr(service, name, None)) for name in required):
            raise TypeError("full order-book service does not implement the required facade")
        self._full_order_book_service = service

    @property
    def market_data_ready(self) -> bool:
        return self._market_data_service is not None

    @property
    def trade_flow_ready(self) -> bool:
        return self._trade_flow_service is not None

    @property
    def liquidation_ready(self) -> bool:
        return self._liquidation_service is not None

    @property
    def order_book_ready(self) -> bool:
        return self._order_book_service is not None

    @property
    def full_order_book_ready(self) -> bool:
        return self._full_order_book_service is not None

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
        self._cache_access_loop = asyncio.get_running_loop()
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
        if self._auto_gc_policy.enabled:
            self._auto_gc_task = asyncio.create_task(
                auto_gc_loop(self, self._auto_gc_policy),
                name="data-manager-auto-gc",
            )

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
            self._cleanup_task = None

        if self._auto_gc_task is not None:
            self._auto_gc_task.cancel()
            try:
                await self._auto_gc_task
            except asyncio.CancelledError:
                pass
            except Exception:
                logger.exception("Auto GC task failed during shutdown")
            self._auto_gc_task = None

        if self._cache_access_tasks:
            await asyncio.gather(*self._cache_access_tasks, return_exceptions=True)
            self._cache_access_tasks.clear()
        self._cache_access_loop = None

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
        self._record_cache_access_deferred(
            symbol,
            interval,
            exchange=exchange,
            market_type=market_type,
            action="range-query" if start_ms is not None or end_ms is not None else "history-query",
            source=backfill_requester,
        )
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
        self._record_cache_access_deferred(
            symbol,
            interval,
            exchange=exchange,
            market_type=market_type,
            action="history-query",
            source=backfill_requester,
        )
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
        self._record_cache_access_deferred(
            symbol,
            interval,
            exchange=exchange,
            market_type=market_type,
            action="query-before",
            source=backfill_requester,
        )
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
        request_ids: list[str] = []
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
                request_id = self._call_backfill_trigger(
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
                if isinstance(request_id, str) and request_id:
                    request_ids.append(request_id)
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
            if request_ids:
                result.metadata["backfill_request_ids"] = request_ids
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
    ) -> Any:
        trigger = self._backfill_trigger
        if trigger is None:
            return None

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

        return trigger(symbol, interval, start_ms, end_ms, exchange, market_type, **kwargs)

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
    #  Advanced Market Data — independent from the bar event bus
    # ═══════════════════════════════════════════════════════════

    async def ensure_market_stream(
        self,
        key: MarketStreamKey,
        *,
        consumer_id: str,
    ) -> bool:
        service = self._require_market_data_service()
        return await service.ensure_stream(key, consumer_id=consumer_id)

    async def release_market_stream(
        self,
        key: MarketStreamKey,
        *,
        consumer_id: str,
    ) -> bool:
        service = self._require_market_data_service()
        return await service.release_stream(key, consumer_id=consumer_id)

    async def market_snapshot(
        self,
        keys: list[MarketStreamKey],
        *,
        refresh_missing: bool = True,
    ) -> list[Any]:
        service = self._require_market_data_service()
        return await service.snapshot(keys, refresh_missing=refresh_missing)

    async def market_history(
        self,
        key: MarketStreamKey,
        **kwargs: Any,
    ) -> list[Any]:
        service = self._require_market_data_service()
        return await service.history(key, **kwargs)

    async def market_history_page(
        self,
        key: MarketStreamKey,
        **kwargs: Any,
    ) -> Any:
        service = self._require_market_data_service()
        return await service.history_page(key, **kwargs)

    def subscribe_market(
        self,
        keys: list[MarketStreamKey],
        *,
        max_pending: int = 64,
        replay: bool = True,
    ) -> Any:
        service = self._require_market_data_service()
        return service.subscribe(keys, max_pending=max_pending, replay=replay)

    def _require_market_data_service(self) -> Any:
        if self._market_data_service is None:
            raise RuntimeError("advanced market data service is not initialized")
        return self._market_data_service

    # ═══════════════════════════════════════════════════════════
    #  TradeFlow — append-only and intentionally separate from P1 latest state
    # ═══════════════════════════════════════════════════════════

    async def ensure_trade_flow_stream(
        self,
        key: MarketStreamKey,
        *,
        consumer_id: str,
    ) -> bool:
        service = self._require_trade_flow_service()
        return await service.ensure_stream(key, consumer_id=consumer_id)

    async def release_trade_flow_stream(
        self,
        key: MarketStreamKey,
        *,
        consumer_id: str,
    ) -> bool:
        service = self._require_trade_flow_service()
        return await service.release_stream(key, consumer_id=consumer_id)

    def trade_flow_recent(self, key: MarketStreamKey, **kwargs: Any) -> list[Any]:
        service = self._require_trade_flow_service()
        return service.recent(key, **kwargs)

    async def trade_flow_history(
        self,
        key: MarketStreamKey,
        **kwargs: Any,
    ) -> list[Any]:
        service = self._require_trade_flow_service()
        return await service.history(key, **kwargs)

    def attach_trade_flow(self, keys: list[MarketStreamKey], **kwargs: Any) -> Any:
        service = self._require_trade_flow_service()
        return service.attach(keys, **kwargs)

    async def trade_flow_archive_coverage(
        self,
        key: MarketStreamKey,
        **kwargs: Any,
    ) -> Any:
        service = self._require_trade_flow_service()
        return await service.archive_coverage(key, **kwargs)

    def _require_trade_flow_service(self) -> Any:
        if self._trade_flow_service is None:
            raise RuntimeError("trade flow service is not initialized")
        return self._trade_flow_service

    # ═══════════════════════════════════════════════════════════
    #  Liquidations — sampled append-only observations, never K-line events
    # ═══════════════════════════════════════════════════════════

    async def ensure_liquidation_stream(
        self,
        key: MarketStreamKey,
        *,
        consumer_id: str,
    ) -> bool:
        service = self._require_liquidation_service()
        return await service.ensure_stream(key, consumer_id=consumer_id)

    async def release_liquidation_stream(
        self,
        key: MarketStreamKey,
        *,
        consumer_id: str,
    ) -> bool:
        service = self._require_liquidation_service()
        return await service.release_stream(key, consumer_id=consumer_id)

    def liquidation_recent(self, key: MarketStreamKey, **kwargs: Any) -> list[Any]:
        service = self._require_liquidation_service()
        return service.recent(key, **kwargs)

    async def liquidation_history(
        self,
        key: MarketStreamKey,
        **kwargs: Any,
    ) -> list[Any]:
        service = self._require_liquidation_service()
        return await service.history(key, **kwargs)

    def attach_liquidations(self, keys: list[MarketStreamKey], **kwargs: Any) -> Any:
        service = self._require_liquidation_service()
        return service.attach(keys, **kwargs)

    def _require_liquidation_service(self) -> Any:
        if self._liquidation_service is None:
            raise RuntimeError("liquidation service is not initialized")
        return self._liquidation_service

    # ═══════════════════════════════════════════════════════════
    #  Partial Top-N order book — latest replaceable snapshots
    # ═══════════════════════════════════════════════════════════

    async def ensure_order_book_stream(
        self,
        key: MarketStreamKey,
        *,
        consumer_id: str,
    ) -> bool:
        service = self._require_order_book_service()
        return await service.ensure_stream(key, consumer_id=consumer_id)

    async def release_order_book_stream(
        self,
        key: MarketStreamKey,
        *,
        consumer_id: str,
    ) -> bool:
        service = self._require_order_book_service()
        return await service.release_stream(key, consumer_id=consumer_id)

    def order_book_snapshot(self, key: MarketStreamKey) -> Any:
        service = self._require_order_book_service()
        return service.current(key)

    async def wait_for_order_book_snapshot(
        self,
        key: MarketStreamKey,
        *,
        timeout_seconds: float,
    ) -> Any:
        service = self._require_order_book_service()
        return await service.wait_for_snapshot(
            key,
            timeout_seconds=timeout_seconds,
        )

    def attach_order_books(self, keys: list[MarketStreamKey], **kwargs: Any) -> Any:
        service = self._require_order_book_service()
        return service.attach(keys, **kwargs)

    def _require_order_book_service(self) -> Any:
        if self._order_book_service is None:
            raise RuntimeError("order-book service is not initialized")
        return self._order_book_service

    # ═══════════════════════════════════════════════════════════
    #  Full order book — strict snapshot + ordered delta rebuild
    # ═══════════════════════════════════════════════════════════

    async def ensure_full_order_book_stream(
        self,
        key: MarketStreamKey,
        *,
        consumer_id: str,
    ) -> bool:
        service = self._require_full_order_book_service()
        return await service.ensure_stream(key, consumer_id=consumer_id)

    async def release_full_order_book_stream(
        self,
        key: MarketStreamKey,
        *,
        consumer_id: str,
    ) -> bool:
        service = self._require_full_order_book_service()
        return await service.release_stream(key, consumer_id=consumer_id)

    def full_order_book_snapshot(self, key: MarketStreamKey) -> Any:
        service = self._require_full_order_book_service()
        return service.current(key, require_live=True)

    async def wait_for_full_order_book_snapshot(
        self,
        key: MarketStreamKey,
        *,
        timeout_seconds: float,
    ) -> Any:
        service = self._require_full_order_book_service()
        return await service.wait_for_live(key, timeout_seconds=timeout_seconds)

    def attach_full_order_books(
        self,
        keys: list[MarketStreamKey],
        **kwargs: Any,
    ) -> Any:
        service = self._require_full_order_book_service()
        return service.attach(keys, **kwargs)

    def _require_full_order_book_service(self) -> Any:
        if self._full_order_book_service is None:
            raise RuntimeError("full order-book service is not initialized")
        return self._full_order_book_service

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
        consumer_id: str | None = None,
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

        lease_keys = self._stream_plan_lease_keys(plan)
        stream_consumer = self._stream_consumer_id(
            consumer_id,
            focus_scope=focus_scope,
            subscription_tier=subscription_tier,
        )
        self._register_stream_leases(
            lease_keys,
            consumer_id=stream_consumer,
        )
        self._register_stream_storage_intents(
            lease_keys,
            consumer_id=stream_consumer,
            focus_scope=focus_scope,
            subscription_tier=subscription_tier,
        )

        try:
            # Publish hard protection before any stream/aggregator transition.
            # A bounded storage-delete batch and stream activation therefore
            # have one shared linearization boundary.
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
        except Exception:
            empty_keys = self._release_stream_leases(
                lease_keys,
                consumer_id=stream_consumer,
            )
            self._release_stream_storage_intents(
                lease_keys,
                consumer_id=stream_consumer,
            )
            for key in empty_keys:
                await self.coordinator.stop_stream(
                    key.symbol,
                    key.interval,
                    exchange=key.exchange,
                    market_type=key.market_type,
                )
                self.bar_aggregator.remove_target(
                    key.symbol,
                    key.interval,
                    exchange=key.exchange,
                    market_type=key.market_type,
                )
            raise

        return info

    async def release_stream(
        self,
        symbol: str,
        interval: str,
        exchange: str = "binance",
        market_type: str = "spot",
        *,
        consumer_id: str | None = None,
        focus_scope: str = "foreground",
        subscription_tier: str | None = None,
    ) -> None:
        """Release one consumer's claim on a stream.

        The underlying backend stream is stopped only after the last
        registered consumer for that stream has released it.
        """
        market_type = self._normalize_market_type(market_type)
        self._record_cache_access_deferred(
            symbol,
            interval,
            exchange=exchange,
            market_type=market_type,
            action=(
                "alert-stream" if str(subscription_tier or "").lower() == "alerts"
                else "indicator-range" if str(subscription_tier or "").lower() == "indicator"
                else "stream"
            ),
            source=subscription_tier or focus_scope,
            detail={"focus_scope": focus_scope, "subscription_tier": subscription_tier},
        )
        plan = self.stream_policy.plan(
            symbol,
            interval,
            exchange=exchange,
            market_type=market_type,
        )
        consumer = self._stream_consumer_id(
            consumer_id,
            focus_scope=focus_scope,
            subscription_tier=subscription_tier,
        )
        empty_keys = self._release_stream_leases(
            self._stream_plan_lease_keys(plan),
            consumer_id=consumer,
        )
        self._release_stream_storage_intents(
            self._stream_plan_lease_keys(plan),
            consumer_id=consumer,
        )

        for key in empty_keys:
            await self.coordinator.stop_stream(
                key.symbol,
                key.interval,
                exchange=key.exchange,
                market_type=key.market_type,
            )
            self.bar_aggregator.remove_target(
                key.symbol,
                key.interval,
                exchange=key.exchange,
                market_type=key.market_type,
            )

    async def stop_stream(
        self,
        symbol: str,
        interval: str,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> None:
        """Stop a running data stream."""
        market_type = self._normalize_market_type(market_type)
        with self._storage_gc_guard:
            removed = self._stream_leases.pop(
                SeriesKey(symbol, interval, exchange=exchange, market_type=market_type),
                None,
            )
            if removed is not None:
                self._mark_storage_gc_protection_changed()
        await self.coordinator.stop_stream(symbol, interval, exchange=exchange, market_type=market_type)
        self.bar_aggregator.remove_target(
            symbol, interval, exchange=exchange, market_type=market_type,
        )

    def _stream_consumer_id(
        self,
        consumer_id: str | None,
        *,
        focus_scope: str,
        subscription_tier: str | None,
    ) -> str:
        if consumer_id and consumer_id.strip():
            return consumer_id.strip()
        tier = (
            subscription_tier.strip()
            if isinstance(subscription_tier, str) and subscription_tier.strip()
            else "adhoc"
        )
        scope = focus_scope.strip() if focus_scope.strip() else "foreground"
        return f"{scope}:{tier}:default"

    @staticmethod
    def _stream_plan_lease_keys(plan: Any) -> tuple[SeriesKey, ...]:
        keys: list[SeriesKey] = [plan.requested]
        keys.extend(plan.aggregation_targets)
        keys.extend(plan.prerequisite_streams)
        return tuple(dict.fromkeys(keys))

    def _register_stream_leases(
        self,
        keys: tuple[SeriesKey, ...],
        *,
        consumer_id: str,
    ) -> None:
        with self._storage_gc_guard:
            changed = False
            for key in keys:
                lease = self._stream_leases.setdefault(key, _StreamLease())
                before = len(lease.consumers)
                lease.consumers.add(consumer_id)
                changed = changed or len(lease.consumers) != before
            if changed:
                self._mark_storage_gc_protection_changed()

    def _release_stream_leases(
        self,
        keys: tuple[SeriesKey, ...],
        *,
        consumer_id: str,
    ) -> list[SeriesKey]:
        with self._storage_gc_guard:
            empty_keys: list[SeriesKey] = []
            changed = False
            for key in keys:
                lease = self._stream_leases.get(key)
                if lease is None:
                    continue
                before = len(lease.consumers)
                lease.consumers.discard(consumer_id)
                changed = changed or len(lease.consumers) != before
                if not lease.consumers:
                    self._stream_leases.pop(key, None)
                    empty_keys.append(key)
            if changed:
                self._mark_storage_gc_protection_changed()
            return empty_keys

    def _register_stream_storage_intents(
        self,
        keys: tuple[SeriesKey, ...],
        *,
        consumer_id: str,
        focus_scope: str,
        subscription_tier: str | None,
    ) -> None:
        priority, frontend_cache_allowed = self._storage_intent_policy(
            focus_scope=focus_scope,
            subscription_tier=subscription_tier,
        )
        for key in keys:
            self.storage_intents.register(
                key,
                source=f"stream:{consumer_id}",
                priority=priority,
                storage_allowed=True,
                frontend_cache_allowed=frontend_cache_allowed,
                stream_required=True,
                detail={
                    "focus_scope": focus_scope,
                    "subscription_tier": subscription_tier,
                },
            )

    def _release_stream_storage_intents(
        self,
        keys: tuple[SeriesKey, ...],
        *,
        consumer_id: str,
    ) -> None:
        for key in keys:
            self.storage_intents.unregister(key, source=f"stream:{consumer_id}")

    @staticmethod
    def _storage_intent_policy(
        *,
        focus_scope: str,
        subscription_tier: str | None,
    ) -> tuple[str, bool]:
        tier = str(subscription_tier or "").strip().lower()
        scope = str(focus_scope or "").strip().lower()
        if tier in {"full", "alerts"}:
            return "strong", tier == "full"
        if tier == "indicator":
            return "normal", False
        if scope in {"foreground", "websocket"}:
            return "normal", True
        return "weak", False

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
        self._record_cache_access_deferred(
            normalized_symbol,
            WILDCARD_INTERVAL,
            exchange=normalized_exchange,
            market_type=normalized_market,
            action="price-stream",
            source="price",
        )
        self.storage_intents.register(
            SeriesKey(
                normalized_symbol,
                WILDCARD_INTERVAL,
                exchange=normalized_exchange,
                market_type=normalized_market,
            ),
            source=f"price:{normalized_exchange}:{normalized_market}:{normalized_symbol}",
            priority="weak",
            storage_allowed=True,
            frontend_cache_allowed=False,
            stream_required=False,
            detail={"stream_type": "price"},
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
        self.storage_intents.unregister(
            SeriesKey(
                normalized_symbol,
                WILDCARD_INTERVAL,
                exchange=normalized_exchange,
                market_type=normalized_market,
            ),
            source=f"price:{normalized_exchange}:{normalized_market}:{normalized_symbol}",
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

    def plan_memory_gc(
        self,
        policy: dict[str, Any] | None = None,
        *,
        scoring: str = "smart",
    ) -> dict[str, Any]:
        """Return a dry-run plan for DataManager memory cache cleanup."""
        report = plan_memory_gc(
            self,
            policy,
            behavior_heat=self.cache_behavior.heat_map(),
            runtime_pressure=self.runtime_pressure_snapshot(),
            scoring=scoring,
        )
        self._memory_gc_last_report = report
        return report

    async def plan_memory_gc_async(
        self,
        policy: dict[str, Any] | None = None,
        *,
        scoring: str = "smart",
    ) -> dict[str, Any]:
        """Plan memory GC without running SQLite/disk probes on the event loop.

        Learned behavior and runtime probes are independent inputs and may be
        captured on the storage executor.  The actual cache/protection snapshot
        remains on the event-loop thread so it is adjacent to conditional
        execution and cannot be queued behind unrelated storage work.
        """
        behavior_heat, runtime_pressure = await asyncio.gather(
            run_storage(self.cache_behavior.heat_map),
            run_storage(self.runtime_pressure_snapshot),
        )
        report = plan_memory_gc(
            self,
            policy,
            behavior_heat=behavior_heat,
            runtime_pressure=runtime_pressure,
            scoring=scoring,
        )
        self._memory_gc_last_report = report
        return report

    def run_memory_gc(self, policy: dict[str, Any] | None = None) -> dict[str, Any]:
        """Execute DataManager memory cache cleanup and return a report."""
        report = execute_memory_gc_plan(self, self.plan_memory_gc(policy))
        self._memory_gc_last_report = report
        return report

    async def run_memory_gc_async(
        self,
        policy: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Plan asynchronously, then conditionally execute on the event loop."""
        plan = await self.plan_memory_gc_async(policy)
        report = execute_memory_gc_plan(self, plan)
        self._memory_gc_last_report = report
        return report

    async def run_auto_gc(self, policy: dict[str, Any] | None = None) -> dict[str, Any]:
        """Execute one conservative automatic GC pass."""
        report = await run_auto_gc_once(self, policy or self._auto_gc_policy)
        self._auto_gc_last_report = report
        self._memory_gc_last_report = report.get("memory") or self._memory_gc_last_report
        self._storage_gc_last_report = report.get("storage") or self._storage_gc_last_report
        return report

    def auto_gc_snapshot(self) -> dict[str, Any]:
        """Return automatic GC configuration and last execution report."""
        return {
            "owner": "auto-gc",
            "policy": self._auto_gc_policy.to_dict(),
            "health": dict(self._auto_gc_health),
            "last_report": self._auto_gc_last_report or {
                "mode": "not-run",
                "status": "idle",
            },
        }

    def plan_storage_gc(
        self,
        *,
        db_limits: dict[str, int] | None = None,
        sqlite_budget_bytes: int | None = None,
        storage_row_limits_enabled: bool | None = None,
        file_snapshot: dict[str, Any] | None = None,
        scoring: str = "smart",
    ) -> dict[str, Any]:
        """Return a dry-run plan for SQLite retention cleanup."""
        protected_keys, storage_intents, protection_epoch = (
            self._storage_gc_planning_snapshot()
        )
        report = self.retention.plan_storage_gc(
            db_limits=db_limits,
            sqlite_budget_bytes=sqlite_budget_bytes,
            storage_row_limits_enabled=storage_row_limits_enabled,
            protected_keys=protected_keys,
            storage_intents=storage_intents,
            behavior_heat=self.cache_behavior.heat_map(),
            runtime_pressure=self.runtime_pressure_snapshot(file_snapshot=file_snapshot),
            scoring=scoring,
            file_snapshot=file_snapshot,
        )
        report["protection_epoch_at_plan"] = protection_epoch
        self._storage_gc_last_report = report
        return report

    async def plan_storage_gc_async(
        self,
        *,
        db_limits: dict[str, int] | None = None,
        sqlite_budget_bytes: int | None = None,
        storage_row_limits_enabled: bool | None = None,
        file_snapshot: dict[str, Any] | None = None,
        scoring: str = "smart",
    ) -> dict[str, Any]:
        """Capture loop-owned protection state before offloading storage planning."""
        protected_keys, storage_intents, protection_epoch = (
            self._storage_gc_planning_snapshot()
        )
        behavior_heat = await run_storage(self.cache_behavior.heat_map)
        runtime_pressure = self.runtime_pressure_snapshot(file_snapshot=file_snapshot)
        report = await run_storage(
            self.retention.plan_storage_gc,
            db_limits=db_limits,
            sqlite_budget_bytes=sqlite_budget_bytes,
            storage_row_limits_enabled=storage_row_limits_enabled,
            protected_keys=protected_keys,
            storage_intents=storage_intents,
            behavior_heat=behavior_heat,
            runtime_pressure=runtime_pressure,
            scoring=scoring,
            file_snapshot=file_snapshot,
        )
        report["protection_epoch_at_plan"] = protection_epoch
        self._storage_gc_last_report = report
        return report

    def _storage_gc_replan_for_execution(
        self,
        confirmed_plan: dict[str, Any],
    ) -> dict[str, Any]:
        """Refresh physical pressure and intersect it later with the confirmed plan.

        This method runs on the storage executor after any pre-delete
        checkpoint.  It only produces a fresh plan; ``MaintenanceService``
        enforces that execution cannot exceed either plan.
        """
        policy = dict(confirmed_plan.get("policy") or {})
        storage = getattr(self.query_engine, "storage", None)
        storage_path = (
            getattr(storage, "db_path", None)
            or getattr(storage, "_db_path", None)
        )
        if storage_path is None:
            from app.core.config import KLINES_DB_PATH

            storage_path = KLINES_DB_PATH
        fresh_files = storage_file_snapshot(storage_path)
        protected_keys, storage_intents, protection_epoch = (
            self._storage_gc_planning_snapshot()
        )
        report = self.retention.plan_storage_gc(
            db_limits=policy.get("db_limits"),
            sqlite_budget_bytes=policy.get("sqlite_budget_bytes"),
            storage_row_limits_enabled=policy.get("storage_row_limits_enabled"),
            protected_keys=protected_keys,
            storage_intents=storage_intents,
            behavior_heat=self.cache_behavior.heat_map(),
            runtime_pressure=self.runtime_pressure_snapshot(
                file_snapshot=fresh_files,
            ),
            scoring=(
                "smart"
                if int(confirmed_plan.get("scoringVersion", 1) or 0) > 0
                else "legacy"
            ),
            file_snapshot=fresh_files,
        )
        if (
            str(confirmed_plan.get("mode") or "") == "auto-plan"
            or confirmed_plan.get("autoPolicy") is not None
        ):
            report = filter_auto_storage_plan(
                report,
                AutoGcPolicy.from_mapping(
                    dict(confirmed_plan.get("autoPolicy") or {})
                ),
            )
        report["protection_epoch_at_plan"] = protection_epoch
        report["execution_file_snapshot"] = fresh_files
        report["revalidation_of_generated_at_ms"] = confirmed_plan.get(
            "generated_at_ms"
        )
        return report

    def register_storage_intent(
        self,
        symbol: str,
        interval: str = WILDCARD_INTERVAL,
        *,
        source: str,
        exchange: str = "binance",
        market_type: str = "spot",
        priority: str = "weak",
        storage_allowed: bool = True,
        frontend_cache_allowed: bool = False,
        stream_required: bool = False,
        keep_rows: int | None = None,
        detail: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Register a retention intent for a stored K-line series or symbol."""
        intent = self.storage_intents.register(
            SeriesKey(
                symbol,
                interval,
                exchange=exchange,
                market_type=self._normalize_market_type(market_type),
            ),
            source=source,
            priority=priority,
            storage_allowed=storage_allowed,
            frontend_cache_allowed=frontend_cache_allowed,
            stream_required=stream_required,
            keep_rows=keep_rows,
            detail=detail,
        )
        return intent.to_dict()

    def unregister_storage_intent(
        self,
        symbol: str,
        interval: str = WILDCARD_INTERVAL,
        *,
        source: str,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> None:
        """Remove one retention intent."""
        self.storage_intents.unregister(
            SeriesKey(
                symbol,
                interval,
                exchange=exchange,
                market_type=self._normalize_market_type(market_type),
            ),
            source=source,
        )

    def unregister_storage_intents_for_source(self, source_prefix: str) -> int:
        """Remove all retention intents whose source starts with a prefix."""
        return self.storage_intents.unregister_source_prefix(source_prefix)

    def storage_intent_snapshot(self) -> dict[str, Any]:
        """Return diagnostic storage retention intents."""
        return self.storage_intents.snapshot()

    def _record_cache_access_deferred(
        self,
        symbol: str,
        interval: str,
        **kwargs: Any,
    ) -> None:
        """Record cache behavior off the caller's hot path when the loop is running."""
        loop = self._cache_access_loop
        if loop is None or loop.is_closed():
            self.record_cache_access(symbol, interval, **kwargs)
            return

        def _submit() -> None:
            task = asyncio.create_task(run_storage(self.record_cache_access, symbol, interval, **kwargs))
            self._cache_access_tasks.add(task)

            def _done(done_task: asyncio.Task) -> None:
                self._cache_access_tasks.discard(done_task)
                try:
                    done_task.result()
                except Exception as exc:
                    logger.debug("deferred cache access recording failed: %s", exc)

            task.add_done_callback(_done)

        try:
            loop.call_soon_threadsafe(_submit)
        except RuntimeError:
            self.record_cache_access(symbol, interval, **kwargs)

    def record_cache_access_deferred(
        self,
        symbol: str,
        interval: str,
        **kwargs: Any,
    ) -> None:
        """Record one cache access signal without blocking the caller."""
        self._record_cache_access_deferred(symbol, interval, **kwargs)

    def record_cache_access(
        self,
        symbol: str,
        interval: str,
        *,
        exchange: str = "binance",
        market_type: str = "spot",
        action: str = "access",
        source: str = "backend",
        weight: float | None = None,
        detail: dict[str, Any] | None = None,
        occurred_at_ms: int | None = None,
    ) -> dict[str, Any]:
        """Persist one cache access signal for future GC scoring."""
        key = SeriesKey(
            symbol,
            interval,
            exchange=exchange,
            market_type=self._normalize_market_type(market_type),
        )
        try:
            return self.cache_behavior.record(CacheAccessEvent(
                key=key,
                action=action,
                source=source,
                weight=weight,
                detail=detail,
                occurred_at_ms=occurred_at_ms,
            ))
        except Exception as exc:
            logger.debug("cache access recording failed for %s: %s", key, exc)
            return {}

    def cache_behavior_snapshot(self, *, limit: int = 50) -> dict[str, Any]:
        """Return learned cache behavior heat for diagnostics."""
        try:
            return self.cache_behavior.snapshot(limit=limit)
        except Exception as exc:
            return {
                "owner": "cache-behavior",
                "available": False,
                "error": str(exc),
                "series": [],
            }

    def runtime_pressure_snapshot(
        self,
        *,
        file_snapshot: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Return process and storage pressure for GC scoring."""
        storage_path = None
        if file_snapshot:
            storage_path = file_snapshot.get("path")
        storage_path = storage_path or getattr(getattr(self.query_engine, "storage", None), "db_path", None)
        if storage_path is None:
            from app.core.config import KLINES_DB_PATH
            storage_path = KLINES_DB_PATH
        return {
            "processMemory": process_memory_snapshot(),
            "disk": disk_pressure_snapshot(storage_path),
        }

    async def run_storage_gc(
        self,
        *,
        db_limits: dict[str, int] | None = None,
        sqlite_budget_bytes: int | None = None,
        storage_row_limits_enabled: bool | None = None,
        file_snapshot: dict[str, Any] | None = None,
        batch_size: int = 10_000,
    ) -> dict[str, Any]:
        """Execute SQLite retention cleanup using a fresh dry-run plan."""
        plan = await self.plan_storage_gc_async(
            db_limits=db_limits,
            sqlite_budget_bytes=sqlite_budget_bytes,
            storage_row_limits_enabled=storage_row_limits_enabled,
            file_snapshot=file_snapshot,
        )
        report = await self.maintenance.run_storage_gc(
            plan=plan,
            batch_size=batch_size,
        )
        self._storage_gc_last_report = report
        return report

    async def vacuum_storage(self) -> dict[str, Any]:
        """Run SQLite VACUUM through the maintenance lock."""
        report = await self.maintenance.vacuum_storage()
        self._storage_gc_last_report = report
        return report

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
            audience=audience_for_backfill_reason(detail.get("reason")),
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
            "storage_intents": self.storage_intents.snapshot(),
            "behavior_heat": self.cache_behavior_snapshot(),
            "runtimePressure": self.runtime_pressure_snapshot(),
            "price_cache": self.price_cache.diagnostics(),
            "market_data": (
                self._market_data_service.diagnostics()
                if self._market_data_service is not None
                else {"status": "not_initialized"}
            ),
            "trade_flow": (
                self._trade_flow_service.diagnostics()
                if self._trade_flow_service is not None
                else {"status": "not_initialized"}
            ),
            "liquidations": (
                self._liquidation_service.diagnostics()
                if self._liquidation_service is not None
                else {"status": "not_initialized"}
            ),
            "order_book": (
                self._order_book_service.diagnostics()
                if self._order_book_service is not None
                else {"status": "not_initialized"}
            ),
            "full_order_book": (
                self._full_order_book_service.diagnostics()
                if self._full_order_book_service is not None
                else {"status": "not_initialized"}
            ),
            "auto_gc": self.auto_gc_snapshot(),
            "memory_gc": self._memory_gc_last_report or {
                "mode": "not-run",
                "owner": "data-manager-memory",
            },
            "storage_gc": self._storage_gc_last_report or {
                "mode": "not-run",
                "owner": "sqlite-storage",
            },
        }

    @property
    def config(self) -> DataManagerConfig:
        """Access the configuration (read-only reference)."""
        return self._cfg

    @staticmethod
    def _normalize_market_type(market_type: str) -> str:
        return (market_type or "spot").strip().lower()

    def _protected_storage_keys(self) -> set[SeriesKey]:
        with self._storage_gc_guard:
            keys: set[SeriesKey] = set()
            keys.update(self.event_bus.get_all_subscribed_keys())
            keys.update(self._stream_leases.keys())
            for info in self.coordinator.get_all_streams():
                if info.status in (StreamStatus.ACTIVE, StreamStatus.STARTING):
                    keys.add(info.key)
            for exchange, market_type, symbol, interval in self.bar_aggregator.get_targets():
                keys.add(SeriesKey(symbol, interval, exchange=exchange, market_type=market_type))
            return keys

    def _storage_gc_planning_snapshot(self) -> tuple[set[SeriesKey], Any, int]:
        """Capture protection inputs and their diagnostic epoch atomically."""
        with self._storage_gc_guard:
            return (
                self._protected_storage_keys(),
                self.storage_intents.clone(),
                self._storage_gc_protection_epoch,
            )

    def _mark_storage_gc_protection_changed(self) -> None:
        self._storage_gc_protection_epoch += 1

    def _storage_gc_protection_reason(
        self,
        key: SeriesKey,
        planned_intents: list[dict[str, Any]],
        planned_keep_rows: int | None = None,
    ) -> str | None:
        """Return the current hard protection reason for a storage GC key."""
        with self._storage_gc_guard:
            if key in self._protected_storage_keys():
                return "series became active, subscribed, or leased after planning"
            current_intents = [intent.to_dict() for intent in self.storage_intents.match(key)]
            planned_ids = {str(intent.get("id") or "") for intent in planned_intents}
            current_ids = {str(intent.get("id") or "") for intent in current_intents}
            if current_ids - planned_ids:
                return "series gained a storage intent after planning"

            def intent_semantics(intents: list[dict[str, Any]]) -> tuple[int, int, bool]:
                keep_rows = max(
                    (int(intent.get("effective_keep_rows", 0) or 0) for intent in intents),
                    default=0,
                )
                priority = max(
                    (
                        PRIORITY_RANK.get(
                            str(intent.get("priority") or "").strip().lower(),
                            0,
                        )
                        for intent in intents
                    ),
                    default=0,
                )
                stream_required = any(bool(intent.get("stream_required")) for intent in intents)
                return keep_rows, priority, stream_required

            planned_keep, planned_priority, planned_stream = intent_semantics(planned_intents)
            current_keep, current_priority, current_stream = intent_semantics(current_intents)
            if (
                current_keep > planned_keep
                or current_priority > planned_priority
                or (current_stream and not planned_stream)
            ):
                return "series storage intent protection became stronger after planning"
            if planned_keep_rows is not None and current_keep > int(planned_keep_rows):
                return "current storage intent keep floor exceeds the planned keep rows"
            return None

    def _storage_gc_delete_batch(
        self,
        *,
        key: SeriesKey,
        planned_intents: list[dict[str, Any]],
        planned_keep_rows: int,
        planned_protection_epoch: int = 0,
        expires_at_ms: int = 0,
        delete_func: Any,
        delete_kwargs: dict[str, Any],
    ) -> dict[str, Any]:
        """Linearize the final protection check with one bounded delete batch."""
        guard_requested_at = time.perf_counter()
        with self._storage_gc_guard:
            guard_acquired_at = time.perf_counter()
            authorized_at_ms = int(time.time() * 1000)
            protection_epoch_at_check = self._storage_gc_protection_epoch
            if expires_at_ms and authorized_at_ms > int(expires_at_ms):
                return {
                    "deleted_rows": 0,
                    "cache_invalidated": False,
                    "stale_reason": "storage GC plan expired at final batch authorization",
                    "protection_reason": None,
                    "planned_protection_epoch": int(planned_protection_epoch or 0),
                    "protection_epoch": protection_epoch_at_check,
                    "protection_epoch_at_check": protection_epoch_at_check,
                    "protection_epoch_at_completion": protection_epoch_at_check,
                    "backend_delete_elapsed_ms": 0.0,
                    "guard_wait_ms": int(
                        (guard_acquired_at - guard_requested_at) * 1000
                    ),
                    "guard_hold_ms": int(
                        (time.perf_counter() - guard_acquired_at) * 1000
                    ),
                }
            protection_reason = self._storage_gc_protection_reason(
                key,
                planned_intents,
                planned_keep_rows,
            )
            if protection_reason:
                return {
                    "deleted_rows": 0,
                    "cache_invalidated": False,
                    "stale_reason": None,
                    "protection_reason": protection_reason,
                    "planned_protection_epoch": int(planned_protection_epoch or 0),
                    "protection_epoch": protection_epoch_at_check,
                    "protection_epoch_at_check": protection_epoch_at_check,
                    "protection_epoch_at_completion": protection_epoch_at_check,
                    "backend_delete_elapsed_ms": 0.0,
                    "guard_wait_ms": int(
                        (guard_acquired_at - guard_requested_at) * 1000
                    ),
                    "guard_hold_ms": int(
                        (time.perf_counter() - guard_acquired_at) * 1000
                    ),
                }
            delete_started_at = time.perf_counter()
            deleted = int(delete_func(**delete_kwargs) or 0)
            backend_delete_elapsed_ms = (
                time.perf_counter() - delete_started_at
            ) * 1000.0
            if deleted > 0:
                # Keep deletion and invalidation in the same ordering domain as
                # stream/lease/intent activation.  A later activation therefore
                # cannot have freshly loaded bars cleared by this GC batch.
                self.cache.invalidate(key)
            protection_epoch_at_completion = self._storage_gc_protection_epoch
            batch_limit = int(delete_kwargs.get("batch_size", 0) or 0)
            contract_error = (
                "bounded delete returned more rows than the authorized batch"
                if deleted < 0 or (batch_limit > 0 and deleted > batch_limit)
                else None
            )
            return {
                "deleted_rows": deleted,
                "cache_invalidated": deleted > 0,
                "stale_reason": None,
                "protection_reason": None,
                "planned_protection_epoch": int(planned_protection_epoch or 0),
                "protection_epoch": protection_epoch_at_completion,
                "protection_epoch_at_check": protection_epoch_at_check,
                "protection_epoch_at_completion": protection_epoch_at_completion,
                "backend_delete_elapsed_ms": backend_delete_elapsed_ms,
                "guard_wait_ms": int(
                    (guard_acquired_at - guard_requested_at) * 1000
                ),
                "guard_hold_ms": int(
                    (time.perf_counter() - guard_acquired_at) * 1000
                ),
                "contract_error": contract_error,
            }

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
        sqlite_budget_bytes: int | None = None,
        storage_row_limits_enabled: bool | None = None,
    ) -> None:
        """Update data retention limits from frontend settings.

        Args:
            db_limits:      {"minutes": N, "hours": N, "daily": N} where 0 = unlimited.
            ephemeral_bars: Max bars per ephemeral series (e.g. 86400 for 24h of 1s).
        """
        self.retention.update_limits(
            db_limits=db_limits,
            ephemeral_bars=ephemeral_bars,
            sqlite_budget_bytes=sqlite_budget_bytes,
            storage_row_limits_enabled=storage_row_limits_enabled,
        )

    def retention_snapshot(self) -> dict:
        """Return the current data retention settings."""
        return self.retention.snapshot()
