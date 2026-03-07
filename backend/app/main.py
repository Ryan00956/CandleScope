"""
CandleScope backend entrypoint.

Startup sequence:
  1. Initialize SQLite storage (klines_repo).
  2. Create and start the unified ``DataManager`` facade.
  3. Inject ``KlinesRepoAdapter`` as the storage backend.
  4. Store ``DataManager`` on ``app.state`` so that API/WS endpoints
     can access it via ``request.app.state.data_manager``.
  5. On shutdown, gracefully stop all streams and flush state.

When DataManager fails to initialize (e.g. import error during
early development), the application still starts — API and WS
endpoints fall back to the legacy services/kline_cache_service path.
"""
import asyncio
import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1.indicators import router as indicators_router
from app.api.v1.klines import router as klines_router
from app.api.v1.stream import router as stream_router
from app.core.config import CORS_ORIGINS
from app.data_engine.storage import init_klines_storage

logger = logging.getLogger("candlescope")

app = FastAPI(
    title="CandleScope API",
    description="Backend API for CandleScope",
    version="0.3.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(klines_router, prefix="/api/v1")
app.include_router(stream_router, prefix="/api/v1")
app.include_router(indicators_router, prefix="/api/v1")


# ═══════════════════════════════════════════════════════════════
#  Legacy prewarm (fallback when DataManager is not available)
# ═══════════════════════════════════════════════════════════════

_PREWARM_INTERVALS = {
    "1m": 1,
    "5m": 3,
    "15m": 7,
    "1h": 30,
    "4h": 90,
    "1d": 365,
}
_PREWARM_SYMBOL = "BTCUSDT"


def _legacy_prewarm_cache() -> None:
    """Prewarm the kline cache using the legacy service (fallback)."""
    from app.data_engine.services.kline_cache_service import get_cached_history

    for interval, days in _PREWARM_INTERVALS.items():
        try:
            result = get_cached_history(
                symbol=_PREWARM_SYMBOL, interval=interval, days=days,
            )
            count = len(result.get("data", []))
            print(f"[prewarm/legacy] {_PREWARM_SYMBOL} {interval} ({days}d): {count} bars cached")
        except Exception as exc:  # noqa: BLE001
            print(f"[prewarm/legacy] {_PREWARM_SYMBOL} {interval} failed: {exc}")


# ═══════════════════════════════════════════════════════════════
#  DataManager bootstrap
# ═══════════════════════════════════════════════════════════════


async def _init_data_manager() -> None:
    """Create, configure, and start the DataManager.

    Wiring:
      DataManager
        ├── BarAggregator (L1–L5)  — auto-created internally
        ├── StreamCoordinator      — auto-created internally
        ├── BarCache               — auto-created internally
        ├── QueryEngine            — auto-created internally
        ├── EventBus               — auto-created internally
        ├── StorageBackend         — injected: KlinesRepoAdapter
        ├── IngestionFactory       — injected: BinanceIngestionFactory  ← NEW
        └── BackfillTrigger        — injected: BackfillEngine.run()    ← NEW
    """
    try:
        from app.data_engine.data_manager import DataManager
        from app.data_engine.storage import KlinesRepoAdapter, AsyncKlinesRepoAdapter
        from app.data_engine.ingestion.factory import BinanceIngestionFactory
        from app.data_engine.backfill import BackfillEngine
        from app.data_engine.ingestion import TransportLayer
        from app.data_engine.ingestion.config import IngestionConfig

        dm = DataManager()

        # ── 1. Inject storage backend ────────────────────────
        storage = KlinesRepoAdapter()          # sync — for DataManager/QueryEngine
        async_storage = AsyncKlinesRepoAdapter()  # async — for BackfillEngine
        dm.set_storage(storage)

        # ── 2. Inject ingestion factory (real-time data) ─────
        #   Bridges the 6-layer Ingestion pipeline into DataManager.
        #   When a chart subscribes to (symbol, interval), the coordinator
        #   calls factory.start() → spins up WS connection → data flows
        #   through L1–L6 Ingestion → BarAggregator → Cache → EventBus → WS.
        ingestion_factory = BinanceIngestionFactory()
        dm.set_ingestion_factory(ingestion_factory)
        app.state.ingestion_factory = ingestion_factory  # for shutdown
        print("[startup] IngestionFactory injected ✓")

        # ── 3. Inject backfill trigger (historical gap repair) ──
        #   When QueryEngine detects gaps, it calls this trigger to
        #   spawn a BackfillEngine.run() task that fetches missing data.
        ingestion_cfg = IngestionConfig()
        transport = TransportLayer(ingestion_cfg)
        await transport.start()
        app.state.backfill_transport = transport  # for shutdown

        backfill_engine = BackfillEngine(
            storage=async_storage,
            transport=transport,
            ingestion_config=ingestion_cfg,
        )
        app.state.backfill_engine = backfill_engine  # for shutdown

        main_loop = asyncio.get_running_loop()

        def _backfill_trigger(symbol: str, interval: str, start_ms: int, end_ms: int) -> None:
            """Synchronous trigger that schedules an async backfill run."""
            async def _run_backfill() -> None:
                try:
                    report = await backfill_engine.run(
                        symbol=symbol,
                        intervals=[interval],
                        range_start_ms=start_ms,
                        range_end_ms=end_ms,
                    )
                    bars_written = (
                        report.reconcile_result.bars_written
                        if report.reconcile_result else 0
                    )
                    logger.info(
                        "Backfill completed: %s/%s status=%s bars_written=%s",
                        symbol, interval, report.status.value,
                        bars_written,
                    )
                    # Feed backfilled bars into DataManager cache
                    if hasattr(report, 'reconcile_result') and report.reconcile_result:
                        rr = report.reconcile_result
                        if hasattr(rr, 'bars_written') and rr.bars_written > 0:
                            # Re-query storage and load into cache
                            from app.data_engine.data_manager.models import BarData
                            rows = storage.query_bars(
                                symbol=symbol, interval=interval,
                                start_ms=start_ms, end_ms=end_ms,
                                order="ASC",
                            )
                            bars = [BarData.from_storage_row(r) for r in rows]
                            if bars:
                                await dm.on_bars_backfilled(symbol, interval, bars)
                except Exception as exc:
                    logger.error("Backfill task failed: %s", exc, exc_info=True)

            try:
                asyncio.run_coroutine_threadsafe(_run_backfill(), main_loop)
            except Exception as exc:
                logger.warning("Failed to schedule backfill trigger: %s", exc)

        dm.set_backfill_trigger(_backfill_trigger)
        print("[startup] BackfillTrigger injected ✓")

        # ── 4. Start the DataManager ─────────────────────────
        await dm.start()

        # Store on app.state for access by API/WS endpoints
        app.state.data_manager = dm
        logger.info("DataManager initialized and started successfully")
        print("[startup] DataManager initialized ✓")

    except Exception as exc:
        logger.error("DataManager initialization failed: %s", exc, exc_info=True)
        print(f"[startup] DataManager init failed: {exc}")
        print("[startup] Falling back to legacy services")
        app.state.data_manager = None


# ═══════════════════════════════════════════════════════════════
#  Application Lifecycle
# ═══════════════════════════════════════════════════════════════


@app.on_event("startup")
async def startup_event() -> None:
    """Application startup handler."""
    # 1. Initialize SQLite storage
    init_klines_storage()

    # 2. Try to initialize DataManager (new architecture)
    await _init_data_manager()

    # 3. If DataManager is not available, fall back to legacy prewarm
    if getattr(app.state, "data_manager", None) is None:
        asyncio.get_event_loop().run_in_executor(None, _legacy_prewarm_cache)


@app.on_event("shutdown")
async def shutdown_event() -> None:
    """Application shutdown handler."""
    dm = getattr(app.state, "data_manager", None)
    if dm is not None:
        try:
            await dm.shutdown()
            print("[shutdown] DataManager shut down gracefully ✓")
        except Exception as exc:
            print(f"[shutdown] DataManager shutdown error: {exc}")

    # Shutdown ingestion factory (closes shared MarketDataIngress)
    ingestion_factory = getattr(app.state, "ingestion_factory", None)
    if ingestion_factory is not None:
        try:
            await ingestion_factory.shutdown()
            print("[shutdown] IngestionFactory shut down ✓")
        except Exception as exc:
            print(f"[shutdown] IngestionFactory shutdown error: {exc}")

    # Shutdown backfill transport (HTTP session)
    transport = getattr(app.state, "backfill_transport", None)
    if transport is not None:
        try:
            await transport.stop()
            print("[shutdown] Backfill transport shut down ✓")
        except Exception as exc:
            print(f"[shutdown] Backfill transport shutdown error: {exc}")


# ═══════════════════════════════════════════════════════════════
#  System Endpoints
# ═══════════════════════════════════════════════════════════════


@app.get("/", tags=["system"])
async def root() -> dict:
    dm = getattr(app.state, "data_manager", None)
    return {
        "name": "CandleScope API",
        "version": "0.3.0",
        "status": "running",
        "data_manager": "active" if dm is not None else "legacy_fallback",
    }


@app.get("/health", tags=["system"])
async def health_check() -> dict:
    dm = getattr(app.state, "data_manager", None)
    result: dict = {"status": "ok"}
    if dm is not None:
        try:
            snapshot = dm.snapshot()
            result["data_manager"] = {
                "started": snapshot.get("started", False),
                "active_streams": snapshot.get("coordinator", {}).get("active_streams", 0),
                "cache_series": snapshot.get("cache", {}).get("series_count", 0),
            }
        except Exception:
            result["data_manager"] = {"status": "error"}
    else:
        result["data_manager"] = {"status": "not_initialized"}
    return result


@app.get("/debug/snapshot", tags=["system"])
async def debug_snapshot() -> dict:
    """Full diagnostic snapshot of the DataManager (dev/debug only)."""
    dm = getattr(app.state, "data_manager", None)
    if dm is None:
        return {"error": "DataManager not initialized"}
    try:
        return dm.snapshot()
    except Exception as exc:
        return {"error": str(exc)}
