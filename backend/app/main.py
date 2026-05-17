"""
CandleScope backend entrypoint.

Startup sequence:
  1. Initialize SQLite storage (klines_repo).
  2. Refresh exchange metadata on a best-effort basis.
  3. Start the DataEngine runtime and attach its public handles to
     ``app.state`` for API/WS endpoints.
  4. Bridge the IndicatorEngine to DataManager events.
  5. On shutdown, stop IndicatorEngine and the DataEngine runtime.

When DataManager fails to initialize, the application can still expose
health endpoints, but data APIs report explicit service-unavailable errors.
"""
import logging

# ── Monkey-patch: websockets recv_messages bug ──────────────────
# websockets ≥15 initializes ``recv_messages`` in ``connection_made``,
# but if the TCP connection is reset (e.g. GFW) *before* that callback
# fires, ``connection_lost`` crashes with:
#   AttributeError: 'ClientConnection' object has no attribute 'recv_messages'
# This patch makes ``connection_lost`` safe when the connection was
# never fully established.
try:
    from websockets.asyncio.connection import Connection as _WsConnection

    _orig_connection_lost = _WsConnection.connection_lost

    def _safe_connection_lost(self, exc):
        if not hasattr(self, "recv_messages"):
            # Connection was reset before handshake; nothing to clean up.
            return
        _orig_connection_lost(self, exc)

    _WsConnection.connection_lost = _safe_connection_lost
except Exception:
    pass
# ── End monkey-patch ────────────────────────────────────────────


from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1.indicators import router as indicators_router  # indicator engine v2
from app.api.v1.exchanges import router as exchanges_router
from app.api.v1.klines import router as klines_router
from app.api.v1.settings import router as settings_router
from app.api.v1.stream import router as stream_router
from app.api.v1.subscriptions import router as subscriptions_router
from app.api.v1.subscriptions import price_ws_router
from app.api.v1.symbols import router as symbols_router
from app.core.config import CORS_ORIGINS, EVENT_LOOP_LAG_INTERVAL_SECONDS
from app.core.executors import executors_snapshot
from app.core.runtime_metrics import EventLoopLagMonitor, ws_runtime_metrics
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
app.include_router(exchanges_router, prefix="/api/v1")
app.include_router(symbols_router, prefix="/api/v1")
app.include_router(subscriptions_router, prefix="/api/v1")
app.include_router(price_ws_router, prefix="/api/v1")


# ═══════════════════════════════════════════════════════════════
#  DataManager bootstrap
# ═══════════════════════════════════════════════════════════════


async def _init_data_manager() -> None:
    """Create and start the DataEngine runtime."""
    try:
        from app.data_engine.runtime import start_data_engine
        from app.indicator.data_manager_bridge import bridge_indicator_engine

        runtime = await start_data_engine()
        runtime.attach_to_app_state(app.state)

        try:
            indicator_engine = bridge_indicator_engine(runtime.data_manager)
            app.state.indicator_engine = indicator_engine
            print("[startup] IndicatorEngine bridged to DataManager ✓")
        except Exception as exc:
            logger.warning("IndicatorEngine bridge failed: %s", exc)
            print(f"[startup] IndicatorEngine bridge failed: {exc}")

    except Exception as exc:
        logger.error("DataManager initialization failed: %s", exc, exc_info=True)
        print(f"[startup] DataManager init failed: {exc}")
        app.state.data_manager = None


# ═══════════════════════════════════════════════════════════════
#  Application Lifecycle
# ═══════════════════════════════════════════════════════════════


@app.on_event("startup")
async def startup_event() -> None:
    """Application startup handler."""
    lag_monitor = EventLoopLagMonitor(interval_seconds=EVENT_LOOP_LAG_INTERVAL_SECONDS)
    lag_monitor.start()
    app.state.event_loop_lag_monitor = lag_monitor

    # 1. Initialize SQLite storage
    init_klines_storage()

    # 2. Load exchange symbol info (non-blocking, best-effort)
    try:
        from app.api.v1.symbols import refresh_exchange_metadata

        counts = await refresh_exchange_metadata()
        print(f"[startup] Exchange info loaded ✓ {counts}")
    except Exception as exc:
        print(f"[startup] Exchange info load failed (non-critical): {exc}")

    # 3. Initialize DataManager
    await _init_data_manager()


@app.on_event("shutdown")
async def shutdown_event() -> None:
    """Application shutdown handler."""
    lag_monitor = getattr(app.state, "event_loop_lag_monitor", None)
    if lag_monitor is not None:
        await lag_monitor.stop()

    indicator_engine = getattr(app.state, "indicator_engine", None)
    if indicator_engine is not None:
        try:
            indicator_engine.stop()
            print("[shutdown] IndicatorEngine shut down ✓")
        except Exception as exc:
            print(f"[shutdown] IndicatorEngine shutdown error: {exc}")

    runtime = getattr(app.state, "data_engine_runtime", None)
    if runtime is not None:
        await runtime.shutdown(step_timeout=5)

    print("[shutdown] All components shut down")


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
        "data_manager": "active" if dm is not None else "not_initialized",
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
            lag_monitor = getattr(app.state, "event_loop_lag_monitor", None)
            if lag_monitor is not None:
                result["event_loop_lag"] = lag_monitor.snapshot()
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
        snapshot = dm.snapshot()
        snapshot["executors"] = executors_snapshot()
        lag_monitor = getattr(app.state, "event_loop_lag_monitor", None)
        snapshot["runtime"] = {
            "event_loop_lag": lag_monitor.snapshot() if lag_monitor is not None else None,
            "websocket": ws_runtime_metrics.snapshot(),
        }
        return snapshot
    except Exception as exc:
        return {"error": str(exc)}
