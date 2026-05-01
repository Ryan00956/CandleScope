"""Application-facing DataEngine runtime wiring."""
from __future__ import annotations

import asyncio
import logging
from contextlib import suppress
from dataclasses import dataclass
from typing import Any

from app.core.config import KLINES_DB_PATH
from app.data_engine.backfill import BackfillEngine
from app.data_engine.data_manager import DataManager
from app.data_engine.data_manager.backfill_coordinator import BackfillCoordinator
from app.data_engine.data_manager.ingestion_price_source import IngestionPriceSource
from app.data_engine.data_manager.subscriptions import SubscriptionService
from app.data_engine.ingestion import TransportLayer
from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.factory import BinanceIngestionFactory
from app.data_engine.storage import AsyncKlinesRepoAdapter, KlinesRepoAdapter

logger = logging.getLogger("data_engine.runtime")


@dataclass(slots=True)
class DataEngineRuntime:
    """Runtime-owned components needed by the FastAPI application."""

    data_manager: DataManager
    ingestion_factory: BinanceIngestionFactory
    backfill_transport: TransportLayer
    backfill_engine: BackfillEngine
    backfill_coordinator: BackfillCoordinator
    price_stream_source: IngestionPriceSource | None = None
    subscription_service: SubscriptionService | None = None
    gap_scan_task: asyncio.Task | None = None

    def attach_to_app_state(self, state: Any) -> None:
        """Expose stable app.state handles used by API routes."""
        state.data_engine_runtime = self
        state.data_manager = self.data_manager

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
        await self._cancel_gap_scan()

        await self._shutdown_step(
            "BackfillCoordinator",
            self.backfill_coordinator.shutdown(),
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

    async def _cancel_gap_scan(self) -> None:
        task = self.gap_scan_task
        if task is None or task.done():
            return
        task.cancel()
        with suppress(asyncio.CancelledError, Exception):
            await asyncio.wait_for(task, timeout=2)
        print("[shutdown] Gap scan task cancelled ✓")

    @staticmethod
    async def _shutdown_step(name: str, awaitable: Any, timeout: float) -> None:
        try:
            await asyncio.wait_for(awaitable, timeout=timeout)
            print(f"[shutdown] {name} shut down ✓")
        except asyncio.TimeoutError:
            print(f"[shutdown] {name} shutdown timed out")
        except Exception as exc:
            print(f"[shutdown] {name} shutdown error: {exc}")


async def start_data_engine() -> DataEngineRuntime:
    """Create, configure, and start the application DataEngine runtime."""
    runtime: DataEngineRuntime | None = None
    dm: DataManager | None = None
    ingestion_factory: BinanceIngestionFactory | None = None
    transport: TransportLayer | None = None
    price_source: IngestionPriceSource | None = None

    try:
        dm = DataManager()

        storage = KlinesRepoAdapter()
        async_storage = AsyncKlinesRepoAdapter()
        dm.set_storage(storage)

        ingestion_factory = BinanceIngestionFactory()
        dm.set_ingestion_factory(ingestion_factory)
        print("[startup] IngestionFactory injected ✓")

        ingestion_cfg = IngestionConfig()
        transport = TransportLayer(ingestion_cfg)
        await transport.start()

        backfill_engine = BackfillEngine(
            storage=async_storage,
            transport=transport,
            ingestion_config=ingestion_cfg,
        )
        dm.wire_backfill_reconciler(backfill_engine.reconciler)

        backfill_coordinator = BackfillCoordinator(
            storage=storage,
            bars_backfilled=dm.on_bars_backfilled,
            emit_event=dm.emit_event,
            engine=backfill_engine,
            loop=asyncio.get_running_loop(),
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

        gap_scan_task = _start_startup_gap_scan(dm, backfill_coordinator)

        runtime = DataEngineRuntime(
            data_manager=dm,
            ingestion_factory=ingestion_factory,
            backfill_transport=transport,
            backfill_engine=backfill_engine,
            backfill_coordinator=backfill_coordinator,
            price_stream_source=price_source,
            subscription_service=subscription_service,
            gap_scan_task=gap_scan_task,
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
            )
        raise


async def _start_subscription_workflows(
    dm: DataManager,
    ingestion_factory: BinanceIngestionFactory,
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


async def _cleanup_partial_start(
    *,
    dm: DataManager | None,
    ingestion_factory: BinanceIngestionFactory | None,
    transport: TransportLayer | None,
    price_source: IngestionPriceSource | None,
) -> None:
    if price_source is not None:
        with suppress(Exception):
            await price_source.stop()
    if dm is not None:
        with suppress(Exception):
            await dm.shutdown()
    if ingestion_factory is not None:
        with suppress(Exception):
            await ingestion_factory.shutdown()
    if transport is not None:
        with suppress(Exception):
            await transport.stop()


__all__ = ["DataEngineRuntime", "start_data_engine"]
