"""Application-facing DataEngine runtime wiring."""
from __future__ import annotations

import asyncio
import logging
import math
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.core.config import (
    KLINES_DB_PATH,
    FULL_ORDER_BOOK_DEFAULT_MAX_PENDING,
    FULL_ORDER_BOOK_MAX_BUFFERED_LEVEL_UPDATES,
    FULL_ORDER_BOOK_MAX_LEVELS_PER_SIDE,
    FULL_ORDER_BOOK_MAX_RESYNC_BACKOFF_SECONDS,
    FULL_ORDER_BOOK_MAX_STREAMS,
    FULL_ORDER_BOOK_MAX_UPDATES_PER_DELTA,
    FULL_ORDER_BOOK_PHYSICAL_STOP_TIMEOUT_SECONDS,
    FULL_ORDER_BOOK_RESYNC_BACKOFF_SECONDS,
    FULL_ORDER_BOOK_SNAPSHOT_TIMEOUT_SECONDS,
    FULL_ORDER_BOOK_UPSTREAM_QUEUE_SIZE,
    LIQUIDATION_BATCH_INTERVAL_SECONDS,
    LIQUIDATION_CAPTURE_STREAMS,
    LIQUIDATION_DB_PATH,
    LIQUIDATION_EVENT_QUEUE_SIZE,
    LIQUIDATION_FINALIZE_INTERVAL_SECONDS,
    LIQUIDATION_MAX_BATCH_SIZE,
    LIQUIDATION_MAX_STREAMS,
    LIQUIDATION_RAW_RING_SIZE,
    LIQUIDATION_ROLLUP_BACKEND,
    ORDER_BOOK_DEFAULT_MAX_PENDING,
    ORDER_BOOK_EVENT_QUEUE_SIZE,
    ORDER_BOOK_MAX_SNAPSHOT_AGE_MS,
    ORDER_BOOK_MAX_STREAMS,
    ORDER_BOOK_PHYSICAL_STOP_TIMEOUT_SECONDS,
    RAW_AGG_TRADE_ARCHIVE_BACKEND,
    RAW_AGG_TRADE_ARCHIVE_DIR,
    RAW_AGG_TRADE_ARCHIVE_ENABLED,
    RAW_AGG_TRADE_ARCHIVE_FLUSH_SECONDS,
    RAW_AGG_TRADE_ARCHIVE_MAX_PENDING_BATCHES,
    RAW_AGG_TRADE_ARCHIVE_MAX_ROWS_PER_BATCH,
    RAW_AGG_TRADE_ARCHIVE_STREAMS,
    TRADE_FLOW_BATCH_INTERVAL_SECONDS,
    TRADE_FLOW_DB_PATH,
    TRADE_FLOW_EVENT_QUEUE_SIZE,
    TRADE_FLOW_GAP_REPAIR_MAX_TRADES,
    TRADE_FLOW_MAX_BATCH_SIZE,
    TRADE_FLOW_MAX_STREAMS,
    TRADE_FLOW_RAW_RING_SIZE,
    TRADE_FLOW_ROLLUP_BACKEND,
)
from app.data_engine.backfill import BackfillEngine
from app.data_engine.data_manager import DataManager
from app.data_engine.data_manager.backfill_coordinator import BackfillCoordinator
from app.data_engine.data_manager.ingestion_price_source import IngestionPriceSource
from app.data_engine.data_manager.subscriptions import SubscriptionService
from app.data_engine.ingestion import TransportLayer
from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.factory import ExchangeIngestionFactory
from app.data_engine.history import (
    ExchangeHistoryPolicyResolver,
    HistoryAvailabilityService,
    HistoryBoundaryRepository,
    get_history_calendar_registry,
)
from app.data_engine.market_data.append_hub import AppendBatchHub
from app.data_engine.market_data.full_order_book import FullOrderBookEngine
from app.data_engine.market_data.full_order_book_service import FullOrderBookService
from app.data_engine.market_data.hub import MarketEventHub
from app.data_engine.market_data.liquidation import LiquidationEngine, NormalizedLiquidation
from app.data_engine.market_data.liquidation_service import LiquidationService
from app.data_engine.market_data.order_book import OrderBookEngine
from app.data_engine.market_data.order_book_service import OrderBookService
from app.data_engine.market_data.service import MarketDataService
from app.data_engine.market_data.storage_writer import MarketMetricStorageWriter
from app.data_engine.market_data.trade_flow import (
    NormalizedAggTrade,
    TradeFlowEngine,
)
from app.data_engine.market_data.trade_flow_service import TradeFlowService
from app.data_engine.storage import (
    AsyncKlinesRepoAdapter,
    DisabledRawAggTradeArchive,
    GapLedger,
    KlinesRepoAdapter,
    LiquidationRollupStore,
    LiquidationRollupWriter,
    MarketMetricsRepository,
    ParquetRawAggTradeArchive,
    RawAggTradeArchive,
    RawAggTradeArchiveWriter,
    SQLiteTradeFlowRollupStore,
    SQLiteLiquidationRollupStore,
    TradeFlowRollupStore,
    TradeFlowRollupWriter,
)
from app.replay.runtime import ReplayRuntime, start_replay_runtime

logger = logging.getLogger("data_engine.runtime")


class TradeFlowConfigurationError(RuntimeError):
    """A fail-fast TradeFlow storage or pipeline configuration error."""


class LiquidationConfigurationError(RuntimeError):
    """A fail-fast public-liquidation pipeline configuration error."""


class OrderBookConfigurationError(RuntimeError):
    """A fail-fast Partial Top-N order-book pipeline configuration error."""


class FullOrderBookConfigurationError(RuntimeError):
    """A fail-fast sequence-consistent full-book configuration error."""


_RAW_ARCHIVE_CONSUMER_ID = "runtime:raw-agg-trade-archive"
_LIQUIDATION_CAPTURE_CONSUMER_ID = "runtime:liquidation-capture"


@dataclass(slots=True)
class DataEngineRuntime:
    """Runtime-owned components needed by the FastAPI application."""

    data_manager: DataManager
    ingestion_factory: ExchangeIngestionFactory
    backfill_transport: TransportLayer
    backfill_engine: BackfillEngine
    backfill_coordinator: BackfillCoordinator
    market_data_service: MarketDataService
    trade_flow_service: TradeFlowService
    liquidation_service: LiquidationService | None = None
    order_book_service: OrderBookService | None = None
    full_order_book_service: FullOrderBookService | None = None
    price_stream_source: IngestionPriceSource | None = None
    subscription_service: SubscriptionService | None = None
    gap_scan_task: asyncio.Task | None = None
    gap_audit_task: asyncio.Task | None = None
    replay_runtime: ReplayRuntime | None = None

    def attach_to_app_state(self, state: Any) -> None:
        """Expose stable app.state handles used by API routes."""
        state.data_engine_runtime = self
        state.data_manager = self.data_manager
        state.replay_runtime = self.replay_runtime
        state.replay_service = (
            None if self.replay_runtime is None else self.replay_runtime.service
        )

    def get_ingestion_config(self) -> IngestionConfig | None:
        """Return the primary ingestion config for settings display."""
        configs = self._ingestion_configs()
        return configs[0] if configs else None

    def update_ingestion_config(self, **updates: Any) -> None:
        """Apply config updates to all runtime-owned ingestion configs."""
        for config in self._ingestion_configs():
            config.update(**updates)

    def transports(self) -> list[TransportLayer]:
        """Return all runtime-owned transports that can be restarted."""
        transports: list[TransportLayer] = []

        def _append(transport: Any) -> None:
            if transport is not None and all(existing is not transport for existing in transports):
                transports.append(transport)

        _append(self.backfill_transport)

        get_transports = getattr(self.ingestion_factory, "get_transports", None)
        if callable(get_transports):
            for transport in get_transports():
                _append(transport)

        return transports

    async def restart_transports(self) -> None:
        """Restart active transport HTTP sessions after config changes."""
        for transport in self.transports():
            try:
                await transport.restart_http_session()
            except Exception as exc:
                logger.warning("Failed to restart transport session: %s", exc)

    def get_backfill_coordinator(self) -> BackfillCoordinator:
        """Return the runtime-owned backfill coordinator."""
        return self.backfill_coordinator

    def get_backfill_engine(self) -> BackfillEngine:
        """Return the runtime-owned backfill engine."""
        return self.backfill_engine

    def _ingestion_configs(self) -> list[IngestionConfig]:
        configs: list[IngestionConfig] = []

        def _append(config: Any) -> None:
            if config is not None and all(existing is not config for existing in configs):
                configs.append(config)

        _append(getattr(self.backfill_transport, "config", None))
        _append(getattr(self.ingestion_factory, "config", None))
        return configs

    async def shutdown(self, step_timeout: float = 5.0) -> None:
        """Stop runtime-owned components in dependency order."""
        if self.replay_runtime is not None:
            await self._shutdown_step(
                "ReplayRuntime",
                self.replay_runtime.shutdown(step_timeout=step_timeout),
                None,
            )

        await self._cancel_background_task(self.gap_audit_task, "Gap audit")
        await self._cancel_background_task(self.gap_scan_task, "Gap scan")

        await self._shutdown_step(
            "BackfillCoordinator",
            self.backfill_coordinator.shutdown(),
            step_timeout,
        )

        if self.liquidation_service is not None:
            await self._shutdown_step(
                "LiquidationService",
                self.liquidation_service.shutdown(),
                None,
            )

        if self.order_book_service is not None:
            await self._shutdown_step(
                "OrderBookService",
                self.order_book_service.shutdown(),
                None,
            )

        if self.full_order_book_service is not None:
            await self._shutdown_step(
                "FullOrderBookService",
                self.full_order_book_service.shutdown(),
                None,
            )

        await self._shutdown_step(
            "TradeFlowService",
            self.trade_flow_service.shutdown(),
            None,
        )

        await self._shutdown_step(
            "MarketDataService",
            self.market_data_service.shutdown(),
            step_timeout,
        )

        if self.price_stream_source is not None:
            await self._shutdown_step(
                "Price source",
                self.price_stream_source.stop(),
                step_timeout,
            )

        await self._shutdown_step(
            "DataManager",
            self.data_manager.shutdown(),
            step_timeout,
        )
        await self._shutdown_step(
            "IngestionFactory",
            self.ingestion_factory.shutdown(),
            step_timeout,
        )
        await self._shutdown_step(
            "Backfill transport",
            self.backfill_transport.stop(),
            step_timeout,
        )

    async def _cancel_background_task(self, task: asyncio.Task | None, name: str) -> None:
        if task is None or task.done():
            return
        task.cancel()
        with suppress(asyncio.CancelledError, Exception):
            await asyncio.wait_for(task, timeout=2)
        print(f"[shutdown] {name} task cancelled ✓")

    @staticmethod
    async def _shutdown_step(
        name: str,
        awaitable: Any,
        timeout: float | None,
    ) -> None:
        try:
            if timeout is None:
                # Append-only services own durable rollup/archive queues.
                # Cancelling halfway through would make local capture state
                # unknowable, so cancellation-safe shutdown drains them before
                # dependent transports are closed.
                await awaitable
            else:
                await asyncio.wait_for(awaitable, timeout=timeout)
            print(f"[shutdown] {name} shut down ✓")
        except asyncio.TimeoutError:
            print(f"[shutdown] {name} shutdown timed out")
        except Exception as exc:
            print(f"[shutdown] {name} shutdown error: {exc}")


def _build_trade_flow_service(
    ingestion_factory: ExchangeIngestionFactory,
) -> TradeFlowService:
    """Construct the independent append-only TradeFlow pipeline.

    Backend selection happens before any exchange stream can be leased, so an
    unsupported rollup/archive backend or an unusable enabled archive fails the
    application startup instead of surfacing only after the first trade.
    """

    rollup_store = _build_trade_flow_rollup_store()
    raw_archive = _build_raw_agg_trade_archive()
    rollup_writer = TradeFlowRollupWriter(rollup_store)
    if raw_archive.enabled:
        archive_flush_seconds = _non_negative_float_config(
            "RAW_AGG_TRADE_ARCHIVE_FLUSH_SECONDS",
            RAW_AGG_TRADE_ARCHIVE_FLUSH_SECONDS,
        )
        archive_pending_batches = _positive_int_config(
            "RAW_AGG_TRADE_ARCHIVE_MAX_PENDING_BATCHES",
            RAW_AGG_TRADE_ARCHIVE_MAX_PENDING_BATCHES,
        )
        archive_batch_rows = _positive_int_config(
            "RAW_AGG_TRADE_ARCHIVE_MAX_ROWS_PER_BATCH",
            RAW_AGG_TRADE_ARCHIVE_MAX_ROWS_PER_BATCH,
        )
    else:
        # Archive-only settings are intentionally inert while archival is off.
        archive_flush_seconds = 0.0
        archive_pending_batches = 1
        archive_batch_rows = 1
    archive_writer = RawAggTradeArchiveWriter(
        raw_archive,
        flush_interval_seconds=archive_flush_seconds,
        max_pending_batches=archive_pending_batches,
        max_rows_per_batch=archive_batch_rows,
    )
    event_queue_size = _positive_int_config(
        "TRADE_FLOW_EVENT_QUEUE_SIZE",
        TRADE_FLOW_EVENT_QUEUE_SIZE,
    )
    max_batch_size = _positive_int_config(
        "TRADE_FLOW_MAX_BATCH_SIZE",
        TRADE_FLOW_MAX_BATCH_SIZE,
    )
    max_streams = _positive_int_config(
        "TRADE_FLOW_MAX_STREAMS",
        TRADE_FLOW_MAX_STREAMS,
    )
    engine = TradeFlowEngine(
        raw_ring_size=_positive_int_config(
            "TRADE_FLOW_RAW_RING_SIZE",
            TRADE_FLOW_RAW_RING_SIZE,
        ),
        max_streams=max_streams,
    )
    hub = AppendBatchHub[NormalizedAggTrade](
        max_pending_records=event_queue_size,
        max_batch_size=max_batch_size,
        default_subscriber_max_pending_records=event_queue_size,
    )
    return TradeFlowService(
        ingestion_factory,
        engine=engine,
        hub=hub,
        rollup_store=rollup_store,
        rollup_writer=rollup_writer,
        raw_archive=raw_archive,
        archive_writer=archive_writer,
        command_queue_size=event_queue_size,
        max_repair_trades_per_gap=_positive_int_config(
            "TRADE_FLOW_GAP_REPAIR_MAX_TRADES",
            TRADE_FLOW_GAP_REPAIR_MAX_TRADES,
        ),
        flush_interval_seconds=_positive_float_config(
            "TRADE_FLOW_BATCH_INTERVAL_SECONDS",
            TRADE_FLOW_BATCH_INTERVAL_SECONDS,
        ),
        archive_forward_queue_size=event_queue_size,
        archive_forward_batch_size=archive_batch_rows,
        max_streams=max_streams,
    )


def _build_liquidation_service(
    ingestion_factory: ExchangeIngestionFactory,
) -> LiquidationService:
    """Construct the independent sampled-liquidation observation pipeline."""

    store = _build_liquidation_rollup_store()
    writer = LiquidationRollupWriter(store)
    queue_size = _positive_int_config(
        "LIQUIDATION_EVENT_QUEUE_SIZE",
        LIQUIDATION_EVENT_QUEUE_SIZE,
        error_type=LiquidationConfigurationError,
    )
    max_streams = _positive_int_config(
        "LIQUIDATION_MAX_STREAMS",
        LIQUIDATION_MAX_STREAMS,
        error_type=LiquidationConfigurationError,
    )
    engine = LiquidationEngine(
        raw_ring_size=_positive_int_config(
            "LIQUIDATION_RAW_RING_SIZE",
            LIQUIDATION_RAW_RING_SIZE,
            error_type=LiquidationConfigurationError,
        ),
        max_streams=max_streams,
    )
    hub = AppendBatchHub[NormalizedLiquidation](
        max_pending_records=queue_size,
        max_batch_size=_positive_int_config(
            "LIQUIDATION_MAX_BATCH_SIZE",
            LIQUIDATION_MAX_BATCH_SIZE,
            error_type=LiquidationConfigurationError,
        ),
        default_subscriber_max_pending_records=queue_size,
    )
    return LiquidationService(
        ingestion_factory,
        engine=engine,
        hub=hub,
        rollup_store=store,
        rollup_writer=writer,
        command_queue_size=queue_size,
        flush_interval_seconds=_positive_float_config(
            "LIQUIDATION_BATCH_INTERVAL_SECONDS",
            LIQUIDATION_BATCH_INTERVAL_SECONDS,
            error_type=LiquidationConfigurationError,
        ),
        finalize_interval_seconds=_positive_float_config(
            "LIQUIDATION_FINALIZE_INTERVAL_SECONDS",
            LIQUIDATION_FINALIZE_INTERVAL_SECONDS,
            error_type=LiquidationConfigurationError,
        ),
        max_streams=max_streams,
    )


def _build_order_book_service(
    ingestion_factory: ExchangeIngestionFactory,
) -> OrderBookService:
    """Construct the process-local latest-wins Partial Top-N pipeline."""

    max_streams = _positive_int_config(
        "ORDER_BOOK_MAX_STREAMS",
        ORDER_BOOK_MAX_STREAMS,
        error_type=OrderBookConfigurationError,
    )
    event_queue_size = _positive_int_config(
        "ORDER_BOOK_EVENT_QUEUE_SIZE",
        ORDER_BOOK_EVENT_QUEUE_SIZE,
        error_type=OrderBookConfigurationError,
    )
    if event_queue_size < max_streams:
        raise OrderBookConfigurationError(
            "ORDER_BOOK_EVENT_QUEUE_SIZE must be at least ORDER_BOOK_MAX_STREAMS "
            "so every active replaceable stream owns a latest-state slot"
        )
    default_max_pending = _positive_int_config(
        "ORDER_BOOK_DEFAULT_MAX_PENDING",
        ORDER_BOOK_DEFAULT_MAX_PENDING,
        error_type=OrderBookConfigurationError,
    )
    max_snapshot_age_ms = _positive_int_config(
        "ORDER_BOOK_MAX_SNAPSHOT_AGE_MS",
        ORDER_BOOK_MAX_SNAPSHOT_AGE_MS,
        error_type=OrderBookConfigurationError,
    )
    stop_timeout = _positive_float_config(
        "ORDER_BOOK_PHYSICAL_STOP_TIMEOUT_SECONDS",
        ORDER_BOOK_PHYSICAL_STOP_TIMEOUT_SECONDS,
        error_type=OrderBookConfigurationError,
    )
    engine = OrderBookEngine(max_streams=max_streams)
    hub = MarketEventHub(
        max_states=max_streams,
        default_max_pending=default_max_pending,
    )
    return OrderBookService(
        ingestion_factory,
        engine=engine,
        hub=hub,
        max_streams=max_streams,
        event_queue_size=event_queue_size,
        default_max_pending=default_max_pending,
        max_snapshot_age_ms=max_snapshot_age_ms,
        physical_stop_timeout_seconds=stop_timeout,
    )


def _build_full_order_book_service(
    ingestion_factory: ExchangeIngestionFactory,
) -> FullOrderBookService:
    """Construct the bounded REST-seed + ordered-delta reconstruction chain."""

    error_type = FullOrderBookConfigurationError
    max_streams = _positive_int_config(
        "FULL_ORDER_BOOK_MAX_STREAMS",
        FULL_ORDER_BOOK_MAX_STREAMS,
        error_type=error_type,
    )
    upstream_queue_size = _positive_int_config(
        "FULL_ORDER_BOOK_UPSTREAM_QUEUE_SIZE",
        FULL_ORDER_BOOK_UPSTREAM_QUEUE_SIZE,
        error_type=error_type,
    )
    max_levels_per_side = _positive_int_config(
        "FULL_ORDER_BOOK_MAX_LEVELS_PER_SIDE",
        FULL_ORDER_BOOK_MAX_LEVELS_PER_SIDE,
        error_type=error_type,
    )
    if max_levels_per_side < 1_000:
        raise error_type(
            "FULL_ORDER_BOOK_MAX_LEVELS_PER_SIDE must be at least 1000 "
            "to hold the configured Binance REST seed"
        )
    max_updates_per_delta = _positive_int_config(
        "FULL_ORDER_BOOK_MAX_UPDATES_PER_DELTA",
        FULL_ORDER_BOOK_MAX_UPDATES_PER_DELTA,
        error_type=error_type,
    )
    max_buffered_level_updates = _positive_int_config(
        "FULL_ORDER_BOOK_MAX_BUFFERED_LEVEL_UPDATES",
        FULL_ORDER_BOOK_MAX_BUFFERED_LEVEL_UPDATES,
        error_type=error_type,
    )
    if max_buffered_level_updates < max_updates_per_delta:
        raise error_type(
            "FULL_ORDER_BOOK_MAX_BUFFERED_LEVEL_UPDATES must be at least "
            "FULL_ORDER_BOOK_MAX_UPDATES_PER_DELTA"
        )
    default_max_pending = _positive_int_config(
        "FULL_ORDER_BOOK_DEFAULT_MAX_PENDING",
        FULL_ORDER_BOOK_DEFAULT_MAX_PENDING,
        error_type=error_type,
    )
    snapshot_timeout = _positive_float_config(
        "FULL_ORDER_BOOK_SNAPSHOT_TIMEOUT_SECONDS",
        FULL_ORDER_BOOK_SNAPSHOT_TIMEOUT_SECONDS,
        error_type=error_type,
    )
    initial_backoff = _non_negative_float_config(
        "FULL_ORDER_BOOK_RESYNC_BACKOFF_SECONDS",
        FULL_ORDER_BOOK_RESYNC_BACKOFF_SECONDS,
        error_type=error_type,
    )
    max_backoff = _positive_float_config(
        "FULL_ORDER_BOOK_MAX_RESYNC_BACKOFF_SECONDS",
        FULL_ORDER_BOOK_MAX_RESYNC_BACKOFF_SECONDS,
        error_type=error_type,
    )
    if max_backoff < initial_backoff:
        raise error_type(
            "FULL_ORDER_BOOK_MAX_RESYNC_BACKOFF_SECONDS cannot be less than "
            "FULL_ORDER_BOOK_RESYNC_BACKOFF_SECONDS"
        )
    stop_timeout = _positive_float_config(
        "FULL_ORDER_BOOK_PHYSICAL_STOP_TIMEOUT_SECONDS",
        FULL_ORDER_BOOK_PHYSICAL_STOP_TIMEOUT_SECONDS,
        error_type=error_type,
    )

    engine = FullOrderBookEngine(
        max_streams=max_streams,
        max_levels_per_side=max_levels_per_side,
        max_buffered_deltas_per_stream=upstream_queue_size,
        max_updates_per_delta=max_updates_per_delta,
        max_buffered_level_updates=max_buffered_level_updates,
    )
    hub = MarketEventHub(
        max_states=max_streams,
        default_max_pending=default_max_pending,
    )
    return FullOrderBookService(
        ingestion_factory,
        engine=engine,
        hub=hub,
        max_streams=max_streams,
        upstream_queue_size=upstream_queue_size,
        snapshot_limit=1_000,
        snapshot_timeout_seconds=snapshot_timeout,
        resync_backoff_seconds=initial_backoff,
        max_resync_backoff_seconds=max_backoff,
        physical_stop_timeout_seconds=stop_timeout,
        default_max_pending=default_max_pending,
    )


def _build_liquidation_rollup_store() -> LiquidationRollupStore:
    backend = str(LIQUIDATION_ROLLUP_BACKEND).strip().lower()
    if backend == "sqlite":
        try:
            return SQLiteLiquidationRollupStore(LIQUIDATION_DB_PATH)
        except (OSError, TypeError, ValueError) as exc:
            raise LiquidationConfigurationError(
                f"invalid liquidation SQLite path: {LIQUIDATION_DB_PATH!r}"
            ) from exc
    raise LiquidationConfigurationError(
        "unsupported liquidation rollup backend "
        f"{backend!r}; supported backends: sqlite"
    )


def _build_trade_flow_rollup_store() -> TradeFlowRollupStore:
    backend = str(TRADE_FLOW_ROLLUP_BACKEND).strip().lower()
    if backend == "sqlite":
        try:
            return SQLiteTradeFlowRollupStore(TRADE_FLOW_DB_PATH)
        except (OSError, TypeError, ValueError) as exc:
            raise TradeFlowConfigurationError(
                f"invalid TradeFlow SQLite path: {TRADE_FLOW_DB_PATH!r}"
            ) from exc
    raise TradeFlowConfigurationError(
        "unsupported TradeFlow rollup backend "
        f"{backend!r}; supported backends: sqlite"
    )


def _build_raw_agg_trade_archive() -> RawAggTradeArchive:
    if not RAW_AGG_TRADE_ARCHIVE_ENABLED:
        return DisabledRawAggTradeArchive()

    backend = str(RAW_AGG_TRADE_ARCHIVE_BACKEND).strip().lower()
    if backend != "parquet":
        raise TradeFlowConfigurationError(
            "unsupported raw aggTrade archive backend "
            f"{backend!r}; supported backends: parquet"
        )

    try:
        archive_root = Path(RAW_AGG_TRADE_ARCHIVE_DIR).expanduser()
        archive_root.mkdir(parents=True, exist_ok=True)
    except (OSError, RuntimeError, TypeError, ValueError) as exc:
        raise TradeFlowConfigurationError(
            "raw aggTrade archive directory is unusable: "
            f"{RAW_AGG_TRADE_ARCHIVE_DIR!r}"
        ) from exc
    if not archive_root.is_dir():
        raise TradeFlowConfigurationError(
            f"raw aggTrade archive path is not a directory: {archive_root}"
        )

    try:
        return ParquetRawAggTradeArchive(
            archive_root,
            max_rows_per_file=_positive_int_config(
                "RAW_AGG_TRADE_ARCHIVE_MAX_ROWS_PER_BATCH",
                RAW_AGG_TRADE_ARCHIVE_MAX_ROWS_PER_BATCH,
            ),
        )
    except TradeFlowConfigurationError:
        raise
    except Exception as exc:
        raise TradeFlowConfigurationError(
            "failed to initialize raw aggTrade Parquet archive: "
            f"{exc}"
        ) from exc


def _raw_archive_stream_identities() -> tuple[tuple[str, str, str], ...]:
    """Parse configured always-on raw archive identities fail-closed."""

    if not RAW_AGG_TRADE_ARCHIVE_ENABLED:
        return ()
    identities: list[tuple[str, str, str]] = []
    seen: set[tuple[str, str, str]] = set()
    for raw in RAW_AGG_TRADE_ARCHIVE_STREAMS:
        if not isinstance(raw, str):
            raise TradeFlowConfigurationError(
                "RAW_AGG_TRADE_ARCHIVE_STREAMS entries must be strings"
            )
        parts = tuple(part.strip() for part in raw.split(":"))
        if len(parts) != 3 or any(not part for part in parts):
            raise TradeFlowConfigurationError(
                "RAW_AGG_TRADE_ARCHIVE_STREAMS entries must use "
                "exchange:market_type:symbol"
            )
        identity = (parts[0].lower(), parts[1].lower(), parts[2].upper())
        if identity not in seen:
            seen.add(identity)
            identities.append(identity)
    return tuple(identities)


async def _start_raw_archive_streams(service: TradeFlowService) -> None:
    """Hold optional runtime leases for continuous replay capture."""

    for identity in _raw_archive_stream_identities():
        try:
            await service.ensure_stream(
                identity,
                consumer_id=_RAW_ARCHIVE_CONSUMER_ID,
            )
        except Exception as exc:
            raise TradeFlowConfigurationError(
                "failed to start configured raw aggTrade archive stream "
                f"{identity[0]}:{identity[1]}:{identity[2]}"
            ) from exc


def _liquidation_capture_identities() -> tuple[tuple[str, str, str], ...]:
    """Parse always-on liquidation capture identities fail-closed."""

    identities: list[tuple[str, str, str]] = []
    seen: set[tuple[str, str, str]] = set()
    for raw in LIQUIDATION_CAPTURE_STREAMS:
        if not isinstance(raw, str):
            raise LiquidationConfigurationError(
                "LIQUIDATION_CAPTURE_STREAMS entries must be strings"
            )
        parts = tuple(part.strip() for part in raw.split(":"))
        if len(parts) != 3 or any(not part for part in parts):
            raise LiquidationConfigurationError(
                "LIQUIDATION_CAPTURE_STREAMS entries must use "
                "exchange:market_type:symbol"
            )
        identity = (parts[0].lower(), parts[1].lower(), parts[2].upper())
        if identity not in seen:
            seen.add(identity)
            identities.append(identity)
    return tuple(identities)


async def _start_liquidation_capture_streams(service: LiquidationService) -> None:
    """Hold optional runtime leases for durable local observation history."""

    for identity in _liquidation_capture_identities():
        try:
            await service.ensure_stream(
                identity,
                consumer_id=_LIQUIDATION_CAPTURE_CONSUMER_ID,
            )
        except Exception as exc:
            raise LiquidationConfigurationError(
                "failed to start configured liquidation capture stream "
                f"{identity[0]}:{identity[1]}:{identity[2]}"
            ) from exc


def _positive_int_config(
    name: str,
    value: int,
    *,
    error_type: type[RuntimeError] = TradeFlowConfigurationError,
) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise error_type(f"{name} must be greater than zero")
    return value


def _positive_float_config(
    name: str,
    value: float,
    *,
    error_type: type[RuntimeError] = TradeFlowConfigurationError,
) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise error_type(f"{name} must be greater than zero")
    parsed = float(value)
    if not math.isfinite(parsed) or parsed <= 0:
        raise error_type(f"{name} must be greater than zero")
    return parsed


def _non_negative_float_config(
    name: str,
    value: float,
    *,
    error_type: type[RuntimeError] = TradeFlowConfigurationError,
) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise error_type(f"{name} must be zero or greater")
    parsed = float(value)
    if not math.isfinite(parsed) or parsed < 0:
        raise error_type(f"{name} must be zero or greater")
    return parsed


async def start_data_engine() -> DataEngineRuntime:
    """Create, configure, and start the application DataEngine runtime."""
    runtime: DataEngineRuntime | None = None
    dm: DataManager | None = None
    ingestion_factory: ExchangeIngestionFactory | None = None
    transport: TransportLayer | None = None
    price_source: IngestionPriceSource | None = None
    market_data_service: MarketDataService | None = None
    trade_flow_service: TradeFlowService | None = None
    liquidation_service: LiquidationService | None = None
    order_book_service: OrderBookService | None = None
    full_order_book_service: FullOrderBookService | None = None
    replay_runtime: ReplayRuntime | None = None

    try:
        history_service = HistoryAvailabilityService(
            calendars=get_history_calendar_registry(),
            boundaries=HistoryBoundaryRepository(KLINES_DB_PATH),
        )
        history_policy = ExchangeHistoryPolicyResolver(history_service)

        def _calendar_resolver(
            exchange: str,
            market_type: str,
            symbol: str,
        ):
            key = history_policy.series_key(
                exchange=exchange,
                market_type=market_type,
                symbol=symbol,
                channel="kline",
            )
            context = history_policy.resolve(key)
            return (
                context.calendar
                or context.availability.calendar_id
                or "history.calendar.unknown"
            )

        dm = DataManager()
        set_history_policy = getattr(dm, "set_history_policy", None)
        if callable(set_history_policy):
            set_history_policy(history_policy)

        storage = KlinesRepoAdapter()
        set_storage_calendar = getattr(storage, "set_calendar_resolver", None)
        if callable(set_storage_calendar):
            set_storage_calendar(
                _calendar_resolver,
                registry=history_service.calendars,
            )
        async_storage = AsyncKlinesRepoAdapter()
        gap_ledger = GapLedger()
        dm.set_storage(storage)

        ingestion_factory = ExchangeIngestionFactory()
        set_ingestion_calendar = getattr(
            ingestion_factory,
            "set_calendar_resolver",
            None,
        )
        if callable(set_ingestion_calendar):
            set_ingestion_calendar(_calendar_resolver)
        dm.set_ingestion_factory(ingestion_factory)
        print("[startup] IngestionFactory injected ✓")

        market_metrics_repository = MarketMetricsRepository()
        market_metrics_writer = MarketMetricStorageWriter(market_metrics_repository)
        market_metrics_writer.start()
        market_data_service = MarketDataService(
            ingestion_factory,
            metrics_repository=market_metrics_repository,
            metrics_writer=market_metrics_writer,
            history_policy=history_policy,
        )
        dm.set_market_data_service(market_data_service)
        print("[startup] MarketDataService injected ✓")

        trade_flow_service = _build_trade_flow_service(ingestion_factory)
        dm.set_trade_flow_service(trade_flow_service)
        await _start_raw_archive_streams(trade_flow_service)
        print("[startup] TradeFlowService injected ✓")

        liquidation_service = _build_liquidation_service(ingestion_factory)
        dm.set_liquidation_service(liquidation_service)
        await _start_liquidation_capture_streams(liquidation_service)
        print("[startup] LiquidationService injected ✓")

        order_book_service = _build_order_book_service(ingestion_factory)
        dm.set_order_book_service(order_book_service)
        print("[startup] OrderBookService injected ✓")

        full_order_book_service = _build_full_order_book_service(ingestion_factory)
        dm.set_full_order_book_service(full_order_book_service)
        print("[startup] FullOrderBookService injected ✓")

        ingestion_cfg = IngestionConfig()
        transport = TransportLayer(ingestion_cfg)
        await transport.start()

        backfill_engine = BackfillEngine(
            storage=async_storage,
            transport=transport,
            ingestion_config=ingestion_cfg,
        )
        backfill_engine.detector.set_calendar_resolver(
            _calendar_resolver,
            registry=history_service.calendars,
        )
        dm.wire_backfill_reconciler(backfill_engine.reconciler)

        backfill_coordinator = BackfillCoordinator(
            storage=storage,
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.emit_event,
            engine=backfill_engine,
            loop=asyncio.get_running_loop(),
            gap_ledger=gap_ledger,
            history_service=history_service,
            history_policy_resolver=lambda repair: history_policy.resolve(
                history_policy.series_key(
                    exchange=repair.exchange,
                    market_type=repair.market_type,
                    symbol=repair.symbol,
                    channel="kline",
                    variant=repair.interval,
                )
            ),
        )
        dm.set_backfill_trigger(backfill_coordinator.trigger)
        print("[startup] BackfillCoordinator injected ✓")

        await dm.start()
        logger.info("DataManager initialized and started successfully")
        print("[startup] DataManager initialized ✓")

        price_source, subscription_service = await _start_subscription_workflows(
            dm,
            ingestion_factory,
        )

        replay_runtime = await start_replay_runtime()
        gap_scan_task = _start_startup_gap_scan(dm, backfill_coordinator)
        gap_audit_task = _start_background_gap_audit(dm, backfill_coordinator)

        runtime = DataEngineRuntime(
            data_manager=dm,
            ingestion_factory=ingestion_factory,
            backfill_transport=transport,
            backfill_engine=backfill_engine,
            backfill_coordinator=backfill_coordinator,
            market_data_service=market_data_service,
            trade_flow_service=trade_flow_service,
            liquidation_service=liquidation_service,
            order_book_service=order_book_service,
            full_order_book_service=full_order_book_service,
            price_stream_source=price_source,
            subscription_service=subscription_service,
            gap_scan_task=gap_scan_task,
            gap_audit_task=gap_audit_task,
            replay_runtime=replay_runtime,
        )
        return runtime
    except Exception:
        if runtime is not None:
            await runtime.shutdown()
        else:
            await _cleanup_partial_start(
                dm=dm,
                ingestion_factory=ingestion_factory,
                transport=transport,
                price_source=price_source,
                market_data_service=market_data_service,
                trade_flow_service=trade_flow_service,
                liquidation_service=liquidation_service,
                order_book_service=order_book_service,
                full_order_book_service=full_order_book_service,
                replay_runtime=replay_runtime,
            )
        raise


async def _start_subscription_workflows(
    dm: DataManager,
    ingestion_factory: ExchangeIngestionFactory,
) -> tuple[IngestionPriceSource | None, SubscriptionService | None]:
    price_source: IngestionPriceSource | None = None
    subscription_service: SubscriptionService | None = None
    try:
        price_source = IngestionPriceSource(ingestion_factory)
        dm.set_price_stream_controller(price_source)
        price_source.on_price_update(dm.on_price_ticks)

        subscription_service = SubscriptionService(db_path=str(KLINES_DB_PATH))
        subscription_service.set_data_manager(dm)
        dm.set_subscription_service(subscription_service)

        await subscription_service.start()

        print("[startup] SubscriptionService + ingestion price source initialized ✓")
        return price_source, subscription_service
    except Exception as exc:
        logger.warning("SubscriptionService init failed: %s", exc)
        print(f"[startup] SubscriptionService init failed: {exc}")
        return price_source, subscription_service


def _start_startup_gap_scan(
    dm: DataManager,
    backfill_coordinator: BackfillCoordinator,
) -> asyncio.Task:
    logger.info("Starting gap scan for all prewarmed intervals...")
    print("[startup] Running startup gap scan...")
    task = asyncio.create_task(
        backfill_coordinator.startup_scan(
            dm.prewarm_targets(),
            dm.prewarm_intervals(),
            delay_seconds=5,
        )
    )
    task.add_done_callback(_log_gap_scan_done)
    return task


def _log_gap_scan_done(task: asyncio.Task) -> None:
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:
        logger.warning("Startup gap scan failed: %s", exc)
        print(f"[startup] Gap scan failed: {exc}")
        return
    report = task.result()
    logger.info(
        "Startup gap scan complete: %d scanned, %d repaired, %d failed",
        report.scanned,
        report.repaired,
        report.failed,
    )
    print(
        "[startup] Gap scan done: "
        f"{report.scanned} scanned, {report.repaired} repaired, {report.failed} failed"
    )


def _start_background_gap_audit(
    dm: DataManager,
    backfill_coordinator: BackfillCoordinator,
    *,
    initial_delay_seconds: float = 30.0,
    interval_seconds: float = 300.0,
) -> asyncio.Task:
    logger.info("Starting background storage gap audit...")
    task = asyncio.create_task(
        _background_gap_audit_loop(
            dm,
            backfill_coordinator,
            initial_delay_seconds=initial_delay_seconds,
            interval_seconds=interval_seconds,
        ),
        name="data-engine-gap-audit",
    )
    task.add_done_callback(_log_gap_audit_done)
    return task


async def _background_gap_audit_loop(
    dm: DataManager,
    backfill_coordinator: BackfillCoordinator,
    *,
    initial_delay_seconds: float,
    interval_seconds: float,
) -> None:
    if initial_delay_seconds > 0:
        await asyncio.sleep(initial_delay_seconds)

    while True:
        try:
            get_series = getattr(dm, "gap_audit_series", None)
            if callable(get_series):
                report = await backfill_coordinator.audit_storage_series(
                    get_series(),
                    scan_limit=50_000,
                    max_gaps=100,
                    repair=True,
                )
            else:
                report = await backfill_coordinator.audit_storage_gaps(
                    dm.prewarm_targets(),
                    dm.prewarm_intervals(),
                    scan_limit=50_000,
                    max_gaps=100,
                    repair=True,
                )
            if (
                report.queued
                or report.failed
                or report.ledger_resolved
                or report.ledger_failed
            ):
                logger.info(
                    "Background gap audit: %d scanned, %d queued, %d failed; "
                    "ledger %d scanned, %d resolved, %d failed",
                    report.scanned,
                    report.queued,
                    report.failed,
                    report.ledger_scanned,
                    report.ledger_resolved,
                    report.ledger_failed,
                )
                print(
                    "[gap-audit] "
                    f"{report.scanned} scanned, {report.queued} queued, "
                    f"{report.failed} failed; ledger {report.ledger_scanned} scanned, "
                    f"{report.ledger_resolved} resolved, {report.ledger_failed} failed"
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("Background gap audit iteration failed: %s", exc)
            print(f"[gap-audit] iteration failed: {exc}")

        await asyncio.sleep(interval_seconds)


def _log_gap_audit_done(task: asyncio.Task) -> None:
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:
        logger.warning("Background gap audit stopped: %s", exc)
        print(f"[gap-audit] stopped: {exc}")


async def _cleanup_partial_start(
    *,
    dm: DataManager | None,
    ingestion_factory: ExchangeIngestionFactory | None,
    transport: TransportLayer | None,
    price_source: IngestionPriceSource | None,
    market_data_service: MarketDataService | None,
    trade_flow_service: TradeFlowService | None,
    liquidation_service: LiquidationService | None = None,
    order_book_service: OrderBookService | None = None,
    full_order_book_service: FullOrderBookService | None = None,
    replay_runtime: ReplayRuntime | None = None,
) -> None:
    if replay_runtime is not None:
        with suppress(Exception):
            await replay_runtime.shutdown()
    if price_source is not None:
        with suppress(Exception):
            await price_source.stop()
    if liquidation_service is not None:
        with suppress(Exception):
            await liquidation_service.shutdown()
    if order_book_service is not None:
        with suppress(Exception):
            await order_book_service.shutdown()
    if full_order_book_service is not None:
        with suppress(Exception):
            await full_order_book_service.shutdown()
    if trade_flow_service is not None:
        with suppress(Exception):
            await trade_flow_service.shutdown()
    if market_data_service is not None:
        with suppress(Exception):
            await market_data_service.shutdown()
    if dm is not None:
        with suppress(Exception):
            await dm.shutdown()
    if ingestion_factory is not None:
        with suppress(Exception):
            await ingestion_factory.shutdown()
    if transport is not None:
        with suppress(Exception):
            await transport.stop()


__all__ = [
    "DataEngineRuntime",
    "FullOrderBookConfigurationError",
    "LiquidationConfigurationError",
    "OrderBookConfigurationError",
    "TradeFlowConfigurationError",
    "start_data_engine",
]
