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

from app.api.v1.indicators import router as indicators_router  # indicator engine v2
from app.api.v1.klines import router as klines_router
from app.api.v1.settings import router as settings_router
from app.api.v1.stream import router as stream_router
from app.core.config import CORS_ORIGINS
from app.core.market import is_custom_interval
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
app.include_router(settings_router, prefix="/api/v1")


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
        backfill_engine.reconciler.set_bar_aggregator(dm.bar_aggregator)
        app.state.backfill_engine = backfill_engine  # for shutdown

        main_loop = asyncio.get_running_loop()

        _BACKFILL_MAX_RETRIES = 3
        _BACKFILL_BASE_DELAY = 5  # seconds

        async def _load_backfilled_to_cache(
            symbol: str, interval: str, start_ms: int, end_ms: int,
        ) -> None:
            """Re-query storage for backfilled range and load into cache."""
            from app.data_engine.data_manager.models import BarData
            if is_custom_interval(interval):
                result = await asyncio.to_thread(
                    dm.query, symbol, interval, start_ms, end_ms, None,
                )
                if result.bars:
                    await dm.on_bars_backfilled(symbol, interval, result.bars)
            else:
                rows = storage.query_bars(
                    symbol=symbol, interval=interval,
                    start_ms=start_ms, end_ms=end_ms,
                    order="ASC",
                )
                bars = [BarData.from_storage_row(r) for r in rows]
                if bars:
                    await dm.on_bars_backfilled(symbol, interval, bars)

        def _backfill_trigger(symbol: str, interval: str, start_ms: int, end_ms: int) -> None:
            """Synchronous trigger that schedules an async backfill run with retry."""
            async def _run_backfill() -> None:
                for attempt in range(_BACKFILL_MAX_RETRIES):
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

                        from app.data_engine.backfill.models import BackfillStatus
                        if report.status == BackfillStatus.FAILED:
                            logger.warning(
                                "Backfill FAILED for %s/%s (attempt %d/%d)",
                                symbol, interval, attempt + 1, _BACKFILL_MAX_RETRIES,
                            )
                            delay = _BACKFILL_BASE_DELAY * (3 ** attempt)
                            await asyncio.sleep(delay)
                            continue  # retry

                        # Success (COMPLETED or PARTIAL): load into cache
                        if hasattr(report, 'reconcile_result') and report.reconcile_result:
                            rr = report.reconcile_result
                            if hasattr(rr, 'bars_written') and rr.bars_written > 0:
                                await _load_backfilled_to_cache(
                                    symbol, interval, start_ms, end_ms,
                                )
                        return  # done

                    except Exception as exc:
                        logger.error(
                            "Backfill task error for %s/%s (attempt %d/%d): %s",
                            symbol, interval, attempt + 1,
                            _BACKFILL_MAX_RETRIES, exc, exc_info=True,
                        )
                        delay = _BACKFILL_BASE_DELAY * (3 ** attempt)
                        await asyncio.sleep(delay)

                logger.error(
                    "Backfill exhausted all %d retries for %s/%s [%d→%d]",
                    _BACKFILL_MAX_RETRIES, symbol, interval, start_ms, end_ms,
                )

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

        # ── Startup Gap Scan ─────────────────────────────────
        # Proactively detect and fill gaps for all prewarmed intervals.
        # This covers the "app was offline for days" scenario.
        async def _startup_gap_scan() -> None:
            await asyncio.sleep(5)  # let prewarm + WS settle
            logger.info("Starting gap scan for all prewarmed intervals...")
            print("[startup] Running startup gap scan...")

            scanned = 0
            filled = 0
            for sym in dm.coordinator._cfg.prewarm_symbols:
                for iv in dm.coordinator._cfg.prewarm_intervals:
                    try:
                        bounds = storage.get_bounds(sym, iv)
                        latest = bounds.get("latest_open_time")
                        if not latest:
                            continue

                        now_ms = int(time.time() * 1000)
                        from app.data_engine.bar_aggregator.models import parse_interval_ms
                        interval_ms = parse_interval_ms(iv) or 60_000
                        gap_ms = now_ms - latest

                        # If latest data is more than 3 intervals behind, backfill
                        if gap_ms > interval_ms * 3:
                            scanned += 1
                            logger.info(
                                "Startup gap: %s@%s latest=%s gap=%.1fh, backfilling",
                                sym, iv,
                                time.strftime('%Y-%m-%d %H:%M', time.gmtime(latest / 1000)),
                                gap_ms / 3_600_000,
                            )
                            report = await backfill_engine.run(
                                symbol=sym,
                                intervals=[iv],
                                range_start_ms=latest,
                                range_end_ms=now_ms,
                            )
                            bars_written = (
                                report.reconcile_result.bars_written
                                if report.reconcile_result else 0
                            )
                            if bars_written > 0:
                                filled += 1
                                await _load_backfilled_to_cache(sym, iv, latest, now_ms)
                                logger.info(
                                    "Startup gap filled: %s@%s wrote %d bars",
                                    sym, iv, bars_written,
                                )
                    except Exception as exc:
                        logger.warning(
                            "Startup gap scan failed for %s@%s: %s",
                            sym, iv, exc,
                        )

            logger.info(
                "Startup gap scan complete: %d intervals scanned, %d filled",
                scanned, filled,
            )
            print(f"[startup] Gap scan done: {scanned} scanned, {filled} filled")

        asyncio.create_task(_startup_gap_scan())

        # ── 5. Bridge IndicatorEngine to DataManager EventBus ──
        #   The IndicatorEngine listens to BAR_CLOSED / BAR_UPDATED /
        #   BACKFILL_COMPLETED events and incrementally updates all
        #   subscribed indicator instances in real time.
        try:
            from app.indicator import create_engine
            from app.data_engine.data_manager.models import DataEventType

            indicator_engine = create_engine()
            app.state.indicator_engine = indicator_engine

            async def _on_bar_event_for_indicators(event):
                """Bridge DataManager bar events → IndicatorEngine."""
                bar = event.bar
                if bar is None:
                    return
                symbol = event.key.symbol
                interval = event.key.interval

                if event.event_type == DataEventType.BAR_CLOSED:
                    indicator_engine.on_bar_closed(symbol, interval, bar)
                elif event.event_type == DataEventType.BAR_UPDATED:
                    indicator_engine.on_bar_updated(symbol, interval, bar)

            async def _on_backfill_for_indicators(event):
                """Bridge DataManager backfill events → IndicatorEngine recompute."""
                symbol = event.key.symbol
                interval = event.key.interval
                # Query all cached bars and trigger recompute
                try:
                    result = dm.query_latest(symbol, interval, limit=5000)
                    if result.bars:
                        indicator_engine.on_bars_backfilled(symbol, interval, result.bars)
                except Exception as exc:
                    logger.warning("Indicator recompute after backfill failed: %s", exc)

            # Subscribe to bar events (for real-time indicator updates)
            dm.subscribe(
                callback=_on_bar_event_for_indicators,
                event_types={DataEventType.BAR_CLOSED, DataEventType.BAR_UPDATED},
            )

            # Subscribe to backfill events (for historical correction)
            dm.subscribe(
                callback=_on_backfill_for_indicators,
                event_types={DataEventType.BACKFILL_COMPLETED},
            )

            print("[startup] IndicatorEngine bridged to DataManager ✓")
        except Exception as exc:
            logger.warning("IndicatorEngine bridge failed: %s", exc)
            print(f"[startup] IndicatorEngine bridge failed: {exc}")

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
