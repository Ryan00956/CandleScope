"""
CandleScope backend entrypoint.

Startup sequence:
  1. Initialize SQLite storage (klines_repo).
  2. Restore the local symbol catalog snapshot.
  3. Start the script-runtime plugin plane as a capability. First-party
     Pyne/Pine or plugin-host failures degrade that plane and never abort
     the process.
  4. Start the DataEngine runtime and attach its public handles to
     ``app.state`` for API/WS endpoints.
  5. Refresh exchange metadata asynchronously on a best-effort basis.
  6. Bridge the IndicatorEngine to DataManager events.
  7. On shutdown, stop IndicatorEngine, plugin sidecars, and DataEngine.

When DataManager fails to initialize, the application can still expose
health endpoints, but data APIs report explicit service-unavailable errors.
Script-language execution stays fail-closed: unavailable sidecars return
an explicit capability error and never silently fall back.
"""
import asyncio
import logging
import os

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
from starlette.middleware.gzip import GZipMiddleware

from app.core.config import (
    CORS_ORIGINS,
    EVENT_LOOP_LAG_INTERVAL_SECONDS,
    LIQUIDATION_DB_PATH,
    LIQUIDATION_ROLLUP_BACKEND,
    BACKTEST_SETTINGS,
    LOCAL_DATA_DIR,
    REPLAY_AGG_TRADE_ARCHIVE_DIR,
    RUNTIME_MODE,
    SYMBOL_CATALOG_FOREGROUND_DWELL_SECONDS,
    SYMBOL_CATALOG_FOREGROUND_RECHECK_SECONDS,
    TRADE_FLOW_DB_PATH,
    TRADE_FLOW_ROLLUP_BACKEND,
)
from app.core.executors import executors_snapshot
from app.core.runtime_metrics import EventLoopLagMonitor, ws_runtime_metrics
from app.local_data.runtime import LocalOfflineProfileMiddleware

if RUNTIME_MODE == "LIVE":
    from app.api.v1.alerts import router as alerts_router
    from app.api.v1.exchanges import router as exchanges_router
    from app.api.v1.full_order_book import router as full_order_book_router
    from app.api.v1.indicators import router as indicators_router
    from app.api.v1.klines import router as klines_router
    from app.api.v1.liquidations import router as liquidations_router
    from app.api.v1.market import router as market_router
    from app.api.v1.order_book import router as order_book_router
    from app.api.v1.replay import router as replay_router
    from app.api.v1.settings import router as settings_router
    from app.api.v1.stream import router as stream_router
    from app.api.v1.subscriptions import price_ws_router
    from app.api.v1.subscriptions import router as subscriptions_router
    from app.api.v1.symbols import router as symbols_router
    from app.api.v1.trade_flow import router as trade_flow_router
    from app.data_engine.data_manager.capacity import build_capacity_snapshot
    from app.plugin_core_v2 import create_core_plugin_router
    from app.data_engine.storage import (
        init_klines_storage,
        init_liquidation_storage,
        init_market_metrics_storage,
        init_trade_flow_storage,
    )
else:
    from app.api.v1.local_data import router as local_data_router

logger = logging.getLogger("candlescope")

APP_NAME = "CandleScope"
APP_VERSION = "0.3.0"
PLUGIN_PLATFORM_V2_HOST_VERSION = "0.4.0"

app = FastAPI(
    title="CandleScope API",
    description="Backend API for CandleScope",
    version=APP_VERSION,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(
    GZipMiddleware,
    minimum_size=1024,
    compresslevel=5,
)
if RUNTIME_MODE == "LOCAL_OFFLINE":
    app.add_middleware(LocalOfflineProfileMiddleware, enabled=True)
    app.include_router(local_data_router, prefix="/api/v1")
else:
    app.include_router(klines_router, prefix="/api/v1")
    app.include_router(market_router, prefix="/api/v1")
    app.include_router(trade_flow_router, prefix="/api/v1")
    app.include_router(liquidations_router, prefix="/api/v1")
    app.include_router(order_book_router, prefix="/api/v1")
    app.include_router(full_order_book_router, prefix="/api/v1")
    app.include_router(stream_router, prefix="/api/v1")
    app.include_router(indicators_router, prefix="/api/v1")
    app.include_router(alerts_router, prefix="/api/v1")
    app.include_router(settings_router, prefix="/api/v1")
    app.include_router(exchanges_router, prefix="/api/v1")
    app.include_router(symbols_router, prefix="/api/v1")
    app.include_router(subscriptions_router, prefix="/api/v1")
    app.include_router(price_ws_router, prefix="/api/v1")
    app.include_router(replay_router, prefix="/api/v1")
    app.include_router(create_core_plugin_router())

if BACKTEST_SETTINGS.enabled:
    from app.api.v1.backtests import router as backtests_router

    app.include_router(backtests_router, prefix="/api/v1")


# ═══════════════════════════════════════════════════════════════
#  DataManager bootstrap
# ═══════════════════════════════════════════════════════════════


async def _init_alert_delivery() -> None:
    """Start durable alert delivery independently from live market data."""
    from app.alerts.facade import AlertFacade

    alert_facade = AlertFacade()
    await alert_facade.start()
    app.state.alert_facade = alert_facade


async def _init_data_manager() -> None:
    """Create and start the DataEngine runtime."""
    from app.data_engine.runtime import (
        FullOrderBookConfigurationError,
        LiquidationConfigurationError,
        OrderBookConfigurationError,
        TradeFlowConfigurationError,
        start_data_engine,
    )
    try:
        from app.alerts.facade import AlertFacade
        from app.alerts.runtime import AlertRuntimeEngine
        from app.indicator.data_manager_bridge import bridge_indicator_engine
        from app.indicator.range_result_service import IndicatorRangeResultService
        from app.indicator.series_revision import SeriesRevisionRegistry

        runtime = await start_data_engine()
        runtime.attach_to_app_state(app.state)

        try:
            revision_registry = SeriesRevisionRegistry()
            indicator_range_service = IndicatorRangeResultService.from_config(
                revision_registry=revision_registry,
            )
            # One authoritative revision registry is shared by WS events,
            # range cache entries and HTTP response metadata.
            app.state.indicator_series_revisions = revision_registry
            app.state.indicator_range_service = indicator_range_service
            indicator_engine = bridge_indicator_engine(
                runtime.data_manager,
                backfill_coordinator=runtime.backfill_coordinator,
                result_service=indicator_range_service,
            )
            app.state.indicator_engine = indicator_engine
            print("[startup] IndicatorEngine bridged to DataManager [ok]")
        except Exception as exc:
            logger.warning("IndicatorEngine bridge failed: %s", exc)
            print(f"[startup] IndicatorEngine bridge failed: {exc}")

        try:
            alert_facade = getattr(app.state, "alert_facade", None)
            if not isinstance(alert_facade, AlertFacade):
                raise RuntimeError("Alert delivery facade is unavailable")
            alert_runtime = AlertRuntimeEngine(
                facade=alert_facade,
                data_manager=runtime.data_manager,
                backfill_coordinator=runtime.backfill_coordinator,
            )
            app.state.alert_facade = alert_facade
            app.state.alert_runtime = alert_runtime
            await alert_runtime.start()
            print("[startup] AlertRuntime bridged to DataManager [ok]")
        except Exception as exc:
            logger.warning("AlertRuntime bridge failed: %s", exc, exc_info=True)
            print(f"[startup] AlertRuntime bridge failed: {exc}")

    except (
        TradeFlowConfigurationError,
        LiquidationConfigurationError,
        OrderBookConfigurationError,
        FullOrderBookConfigurationError,
    ) as exc:
        logger.critical(
            "Advanced market-data configuration prevents safe startup: %s",
            exc,
            exc_info=True,
        )
        raise
    except Exception as exc:
        logger.error("DataManager initialization failed: %s", exc, exc_info=True)
        print(f"[startup] DataManager init failed: {exc}")
        app.state.data_manager = None


async def _init_replay_runtime() -> None:
    """Start replay as an application sibling, independent of live DataEngine."""

    from app.api.v1.symbols import get_cached_symbol_metadata
    from app.replay.runtime import start_replay_runtime

    runtime = await start_replay_runtime(
        instrument_metadata_resolver=get_cached_symbol_metadata,
    )
    app.state.replay_runtime = runtime
    app.state.replay_service = runtime.service


# ═══════════════════════════════════════════════════════════════
#  Plugin plane (capability, not a process prerequisite)
# ═══════════════════════════════════════════════════════════════


def _plugin_plane_issue_from_exception(exc: BaseException) -> tuple[str, str]:
    from app.indicator.runtime_routes import IndicatorRuntimeRoutesError
    from app.plugin_runtime.errors import PluginHostError

    if isinstance(exc, PluginHostError):
        return str(exc.code), str(exc.message)
    if isinstance(exc, IndicatorRuntimeRoutesError):
        return (
            "INDICATOR_RUNTIME_ROUTES_INVALID",
            "indicator runtime routes are invalid",
        )
    return type(exc).__name__, "plugin plane failed during startup"


def _mark_plugin_plane_degraded(*, code: str, message: str) -> None:
    current = getattr(app.state, "plugin_plane", None)
    if not isinstance(current, dict):
        current = {"status": "ok", "issues": []}
    issues = [
        item
        for item in list(current.get("issues") or [])
        if isinstance(item, dict) and item.get("code")
    ]
    if not any(item.get("code") == code for item in issues):
        issues.append({"code": code})
    app.state.plugin_plane = {
        "status": "degraded",
        "reasonCode": current.get("reasonCode") or code,
        "reason": current.get("reason") or message,
        "issues": issues[:8],
    }
    logger.warning("Plugin plane degraded (%s): %s", code, message)


async def _stop_plugin_owner(owner: object | None) -> None:
    if owner is None:
        return
    stop = getattr(owner, "stop", None)
    if not callable(stop):
        return
    try:
        await stop()
    except Exception as exc:
        logger.warning("Plugin plane rollback failed: %s", exc, exc_info=True)


async def _start_plugin_plane() -> None:
    """Start script/plugin runtimes without owning core market availability."""
    from app.first_party_plugin_bootstrap import (
        FirstPartyPluginBootstrapError,
        FirstPartyPluginBootstrapResult,
        ensure_first_party_plugins_from_environment,
    )
    from app.indicator.runtime_routes import IndicatorRuntimeRoutes
    from app.indicator.runtime_service import (
        IndicatorRuntimeService,
        build_indicator_runtime_service_from_environment,
    )
    from app.plugin_compat_v1 import V1ScriptRuntimeCompatibilityBridge
    from app.plugin_core_v2 import (
        DisabledCorePluginPlatform,
        build_core_plugin_platform_from_environment,
        build_management_guard_from_environment,
    )
    from app.plugin_core_v2.bootstrap import default_platform_root
    from app.plugin_runtime import (
        RuntimeHostService,
        build_runtime_host_from_environment,
    )

    app.state.plugin_plane = {"status": "ok", "issues": []}
    first_party_bootstrap = FirstPartyPluginBootstrapResult(
        status="skipped",
        reason="not-started",
    )
    plugin_runtime_host: RuntimeHostService | None = None
    indicator_runtime_service: IndicatorRuntimeService | None = None
    plugin_platform_v2 = None
    v1_compatibility = None
    plugin_platform_v2_guard = None

    try:
        first_party_bootstrap = await asyncio.to_thread(
            ensure_first_party_plugins_from_environment,
            host_name=APP_NAME,
            host_version=APP_VERSION,
        )
    except FirstPartyPluginBootstrapError as exc:
        first_party_bootstrap = FirstPartyPluginBootstrapResult.unavailable(exc.message)
        _mark_plugin_plane_degraded(code=exc.code, message=exc.message)
    except Exception as exc:
        code, message = _plugin_plane_issue_from_exception(exc)
        first_party_bootstrap = FirstPartyPluginBootstrapResult.unavailable(message)
        _mark_plugin_plane_degraded(code=code, message=message)

    try:
        plugin_runtime_host = build_runtime_host_from_environment(
            host_name=APP_NAME,
            host_version=APP_VERSION,
        )
        await plugin_runtime_host.start()
    except Exception as exc:
        code, message = _plugin_plane_issue_from_exception(exc)
        _mark_plugin_plane_degraded(code=code, message=message)
        await _stop_plugin_owner(plugin_runtime_host)
        plugin_runtime_host = RuntimeHostService.disabled(
            host_name=APP_NAME,
            host_version=APP_VERSION,
        )
        await plugin_runtime_host.start()

    try:
        indicator_runtime_service = build_indicator_runtime_service_from_environment(
            host=plugin_runtime_host,
        )
        await indicator_runtime_service.start()
    except Exception as exc:
        code, message = _plugin_plane_issue_from_exception(exc)
        _mark_plugin_plane_degraded(code=code, message=message)
        await _stop_plugin_owner(indicator_runtime_service)
        indicator_runtime_service = IndicatorRuntimeService(
            IndicatorRuntimeRoutes.first_party_sidecar_default(),
            host=plugin_runtime_host,
            legacy_languages=frozenset(),
        )
        await indicator_runtime_service.start()

    try:
        plugin_platform_v2 = build_core_plugin_platform_from_environment(
            host_name=APP_NAME,
            host_version=PLUGIN_PLATFORM_V2_HOST_VERSION,
        )
        v1_compatibility = V1ScriptRuntimeCompatibilityBridge(
            root=getattr(
                plugin_platform_v2,
                "root",
                default_platform_root(os.environ),
            ),
            indicator_source=indicator_runtime_service,
            runtime_host=plugin_runtime_host,
        )
        indicator_runtime_service.bind_catalog_projector(
            v1_compatibility.project_indicator_catalog
        )
        plugin_platform_v2.bind_v1_compatibility(v1_compatibility)
        plugin_platform_v2_guard = build_management_guard_from_environment(
            platform=plugin_platform_v2,
        )
    except Exception as exc:
        code, message = _plugin_plane_issue_from_exception(exc)
        _mark_plugin_plane_degraded(code=code, message=message)
        await _stop_plugin_owner(plugin_platform_v2)
        plugin_platform_v2 = DisabledCorePluginPlatform()
        if v1_compatibility is None:
            v1_compatibility = V1ScriptRuntimeCompatibilityBridge(
                root=default_platform_root(os.environ),
                indicator_source=indicator_runtime_service,
                runtime_host=plugin_runtime_host,
            )
        try:
            indicator_runtime_service.bind_catalog_projector(
                v1_compatibility.project_indicator_catalog
            )
        except Exception:
            pass
        try:
            plugin_platform_v2.bind_v1_compatibility(v1_compatibility)
        except Exception:
            pass
        plugin_platform_v2_guard = None

    routing_snapshot = indicator_runtime_service.snapshot()
    if routing_snapshot.get("unavailable"):
        _mark_plugin_plane_degraded(
            code="INDICATOR_RUNTIME_UNAVAILABLE",
            message="one or more script runtimes are unavailable",
        )
    host_summary = plugin_runtime_host.health_summary()
    if host_summary.get("status") == "degraded":
        _mark_plugin_plane_degraded(
            code="PLUGIN_RUNTIME_DEGRADED",
            message="one or more plugin runtimes failed to start",
        )

    app.state.first_party_plugin_bootstrap = first_party_bootstrap.to_wire()
    app.state.plugin_runtime_host = plugin_runtime_host
    app.state.indicator_runtime_service = indicator_runtime_service
    app.state.plugin_v1_compatibility = v1_compatibility
    app.state.plugin_platform_v2 = plugin_platform_v2
    app.state.plugin_platform_v2_management_guard = plugin_platform_v2_guard
    plugin_summary = plugin_runtime_host.health_summary()
    plugin_plane = getattr(app.state, "plugin_plane", {"status": "ok"})
    print(
        "[startup] Runtime plugin host "
        f"{plugin_summary['status']} "
        f"({plugin_summary['ready']}/{plugin_summary['enabled']} ready)"
    )
    print(
        "[startup] First-party plugin bootstrap "
        f"{first_party_bootstrap.status}"
        + (
            f" ({first_party_bootstrap.runtime_id} {first_party_bootstrap.version})"
            if first_party_bootstrap.runtime_id
            else ""
        )
    )
    if plugin_plane.get("status") == "degraded":
        print("[startup] Plugin plane degraded; core market runtime will continue")


# ═══════════════════════════════════════════════════════════════
#  Application Lifecycle
# ═══════════════════════════════════════════════════════════════


@app.on_event("startup")
async def startup_event() -> None:
    """Application startup handler."""
    lag_monitor = EventLoopLagMonitor(interval_seconds=EVENT_LOOP_LAG_INTERVAL_SECONDS)
    lag_monitor.start()
    app.state.event_loop_lag_monitor = lag_monitor
    app.state.runtime_mode = RUNTIME_MODE

    if RUNTIME_MODE == "LOCAL_OFFLINE":
        local_runtime = None
        backtest_runtime = None
        from app.local_data.runtime import LocalOfflineRuntime

        try:
            local_runtime = LocalOfflineRuntime(LOCAL_DATA_DIR)
            local_runtime.start()
            app.state.local_offline_runtime = local_runtime
            app.state.local_data_service = local_runtime.service
            app.state.local_import_jobs = local_runtime.jobs
            app.state.data_manager = None
            app.state.local_data_runtime = local_runtime.data
            if BACKTEST_SETTINGS.enabled:
                from app.backtest.runtime import BacktestRuntime

                backtest_runtime = BacktestRuntime.start(
                    BACKTEST_SETTINGS,
                    local_data_service=local_runtime.service,
                    trade_archive_dir=REPLAY_AGG_TRADE_ARCHIVE_DIR,
                )
                app.state.backtest_runtime = backtest_runtime
                app.state.backtest_service = backtest_runtime.service
                logger.info(
                    "Started LOCAL_OFFLINE backtest runtime at %s",
                    BACKTEST_SETTINGS.db_path,
                )
        except BaseException:
            if backtest_runtime is not None:
                backtest_runtime.shutdown()
            if local_runtime is not None:
                local_runtime.shutdown()
            await lag_monitor.stop()
            raise
        logger.info("Started LOCAL_OFFLINE runtime at %s", LOCAL_DATA_DIR)
        print("[startup] LOCAL_OFFLINE runtime [ok]")
        return

    # 1. Initialize SQLite storage
    init_klines_storage()
    init_market_metrics_storage()
    if TRADE_FLOW_ROLLUP_BACKEND == "sqlite":
        init_trade_flow_storage(TRADE_FLOW_DB_PATH)
    if LIQUIDATION_ROLLUP_BACKEND == "sqlite":
        init_liquidation_storage(LIQUIDATION_DB_PATH)

    # 2. Restore the validated local symbol snapshot before the API is opened.
    # This is local disk I/O only; optional upstream catalog I/O remains
    # asynchronous so it cannot hold core readiness hostage.
    from app.api.v1.symbols import initialize_exchange_metadata_cache

    restored_catalog = initialize_exchange_metadata_cache()
    if restored_catalog:
        logger.info("Restored last-known-good symbol catalog snapshot")

    # 3. Start script/plugin runtimes as a capability plane. A missing or
    # unsupported first-party sidecar degrades Pyne/Pine; it does not abort
    # DataEngine, alerts, or builtin indicators.
    try:
        if BACKTEST_SETTINGS.enabled:
            from app.backtest.runtime import BacktestRuntime
            from app.local_data.runtime import LocalDataRuntime

            data_runtime = LocalDataRuntime(LOCAL_DATA_DIR)
            data_runtime.start()
            app.state.local_data_runtime = data_runtime
            app.state.local_data_service = data_runtime.service
            backtest_runtime = BacktestRuntime.start(
                BACKTEST_SETTINGS,
                local_data_service=data_runtime.service,
                trade_archive_dir=REPLAY_AGG_TRADE_ARCHIVE_DIR,
            )
            app.state.backtest_runtime = backtest_runtime
            app.state.backtest_service = backtest_runtime.service
            logger.info(
                "Started backtest runtime at %s",
                BACKTEST_SETTINGS.db_path,
            )
        await _start_plugin_plane()
    except BaseException:
        backtest_runtime = getattr(app.state, "backtest_runtime", None)
        if backtest_runtime is not None:
            backtest_runtime.shutdown()
        data_runtime = getattr(app.state, "local_data_runtime", None)
        if data_runtime is not None:
            data_runtime.shutdown()
        await _stop_plugin_owner(getattr(app.state, "plugin_platform_v2", None))
        await _stop_plugin_owner(getattr(app.state, "indicator_runtime_service", None))
        await _stop_plugin_owner(getattr(app.state, "plugin_runtime_host", None))
        await lag_monitor.stop()
        raise

    plugin_runtime_host = app.state.plugin_runtime_host
    indicator_runtime_service = app.state.indicator_runtime_service
    plugin_platform_v2 = app.state.plugin_platform_v2

    # 4. Initialize DataManager. FastAPI does not guarantee that the shutdown
    # event runs after a startup exception, so reclaim already-started sidecars
    # before propagating a fatal DataEngine configuration failure.
    try:
        await _init_alert_delivery()
        await _init_replay_runtime()
        await _init_data_manager()
        data_manager = getattr(app.state, "data_manager", None)
        try:
            if data_manager is not None:
                from app.plugin_market_v2 import DataManagerConsumerPort

                plugin_platform_v2.bind_market_data(
                    DataManagerConsumerPort(data_manager)
                )
            from app.api.v1.symbols import (
                evict_exchange_metadata,
                refresh_exchange_metadata,
            )

            plugin_platform_v2.bind_symbol_refresher(
                refresh_exchange_metadata,
                evictor=evict_exchange_metadata,
            )
            await plugin_platform_v2.start()
            plugin_platform_v2.publish_event(
                "candlescope.app.ready/1",
                {"hostVersion": PLUGIN_PLATFORM_V2_HOST_VERSION},
            )
        except Exception as exc:
            code, message = _plugin_plane_issue_from_exception(exc)
            _mark_plugin_plane_degraded(code=code, message=message)
            await _stop_plugin_owner(plugin_platform_v2)
            from app.plugin_core_v2 import DisabledCorePluginPlatform

            plugin_platform_v2 = DisabledCorePluginPlatform()
            v1_compatibility = getattr(app.state, "plugin_v1_compatibility", None)
            if v1_compatibility is not None:
                try:
                    plugin_platform_v2.bind_v1_compatibility(v1_compatibility)
                except Exception:
                    pass
            app.state.plugin_platform_v2 = plugin_platform_v2
            print("[startup] Plugin Platform v2 degraded; core market runtime continues")
    except BaseException:
        alert_facade = getattr(app.state, "alert_facade", None)
        if alert_facade is not None:
            await alert_facade.stop()
        await _stop_plugin_owner(plugin_platform_v2)
        data_runtime = getattr(app.state, "data_engine_runtime", None)
        if data_runtime is not None:
            await data_runtime.shutdown()
        replay_runtime = getattr(app.state, "replay_runtime", None)
        if replay_runtime is not None:
            await replay_runtime.shutdown()
        backtest_runtime = getattr(app.state, "backtest_runtime", None)
        if backtest_runtime is not None:
            backtest_runtime.shutdown()
        await _stop_plugin_owner(indicator_runtime_service)
        await _stop_plugin_owner(plugin_runtime_host)
        await lag_monitor.stop()
        raise

    from app.api.v1.symbols import configure_exchange_metadata_foreground_probe

    runtime = getattr(app.state, "data_engine_runtime", None)
    configure_exchange_metadata_foreground_probe(
        getattr(runtime, "backfill_coordinator", None)
    )

    # 5. Refresh exchange symbols in the background. Product search can serve
    # its last-known-good process cache while this best-effort task is pending.
    _schedule_symbol_catalog_refresh()


def _schedule_symbol_catalog_refresh() -> asyncio.Task[None]:
    async def _refresh() -> None:
        try:
            from app.api.v1.symbols import refresh_exchange_metadata

            await _wait_for_catalog_foreground_quiet()
            counts = await refresh_exchange_metadata()
            print(f"[startup] Exchange info loaded [ok] {counts}")
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning(
                "Exchange info load failed (non-critical): %s",
                exc,
                exc_info=True,
            )
            print(f"[startup] Exchange info load failed (non-critical): {exc}")

    task = asyncio.create_task(_refresh(), name="startup:symbol-catalog-refresh")
    app.state.symbol_catalog_refresh_task = task
    return task


async def _wait_for_catalog_foreground_quiet() -> None:
    dwell = SYMBOL_CATALOG_FOREGROUND_DWELL_SECONDS
    if dwell > 0:
        await asyncio.sleep(dwell)
    runtime = getattr(app.state, "data_engine_runtime", None)
    coordinator = getattr(runtime, "backfill_coordinator", None)
    has_foreground_work = getattr(coordinator, "has_foreground_work", None)
    foreground_idle_seconds = getattr(coordinator, "foreground_idle_seconds", None)
    if not callable(has_foreground_work):
        return
    while True:
        try:
            busy = bool(has_foreground_work())
            idle_for = (
                float(foreground_idle_seconds())
                if callable(foreground_idle_seconds)
                else float("inf")
            )
        except Exception:
            busy = True
            idle_for = 0.0
        if not busy and idle_for >= dwell:
            return
        await asyncio.sleep(SYMBOL_CATALOG_FOREGROUND_RECHECK_SECONDS)


@app.on_event("shutdown")
async def shutdown_event() -> None:
    """Application shutdown handler."""
    local_runtime = getattr(app.state, "local_offline_runtime", None)
    if local_runtime is not None:
        backtest_runtime = getattr(app.state, "backtest_runtime", None)
        if backtest_runtime is not None:
            backtest_runtime.shutdown()
        else:
            backtest_service = getattr(app.state, "backtest_service", None)
            if backtest_service is not None:
                backtest_service.shutdown()
        local_runtime.shutdown()
        lag_monitor = getattr(app.state, "event_loop_lag_monitor", None)
        if lag_monitor is not None:
            await lag_monitor.stop()
        print("[shutdown] LOCAL_OFFLINE runtime shut down [ok]")
        return

    backtest_runtime = getattr(app.state, "backtest_runtime", None)
    if backtest_runtime is not None:
        backtest_runtime.shutdown()
    else:
        backtest_service = getattr(app.state, "backtest_service", None)
        if backtest_service is not None:
            backtest_service.shutdown()
    data_runtime = getattr(app.state, "local_data_runtime", None)
    if data_runtime is not None:
        data_runtime.shutdown()

    symbol_catalog_task = getattr(app.state, "symbol_catalog_refresh_task", None)
    if symbol_catalog_task is not None and not symbol_catalog_task.done():
        symbol_catalog_task.cancel()
        try:
            await symbol_catalog_task
        except asyncio.CancelledError:
            pass
    try:
        from app.api.v1.symbols import (
            cancel_exchange_metadata_refreshes,
            configure_exchange_metadata_foreground_probe,
        )

        await cancel_exchange_metadata_refreshes()
        configure_exchange_metadata_foreground_probe(None)
    except Exception as exc:
        logger.warning("Symbol catalog shutdown failed: %s", exc, exc_info=True)

    lag_monitor = getattr(app.state, "event_loop_lag_monitor", None)
    if lag_monitor is not None:
        await lag_monitor.stop()

    plugin_platform_v2 = getattr(app.state, "plugin_platform_v2", None)
    if plugin_platform_v2 is not None:
        try:
            plugin_platform_v2.publish_event(
                "candlescope.app.stopping/1", {"reason": "Application shutdown"}
            )
            await plugin_platform_v2.stop()
        except Exception as exc:
            logger.warning("Plugin Platform v2 shutdown error: %s", exc, exc_info=True)

    indicator_engine = getattr(app.state, "indicator_engine", None)
    if indicator_engine is not None:
        try:
            indicator_engine.stop()
            print("[shutdown] IndicatorEngine shut down [ok]")
        except Exception as exc:
            print(f"[shutdown] IndicatorEngine shutdown error: {exc}")

    indicator_range_service = getattr(app.state, "indicator_range_service", None)
    if indicator_range_service is not None:
        indicator_range_service.unbind_all()
        indicator_range_service.clear()

    alert_runtime = getattr(app.state, "alert_runtime", None)
    if alert_runtime is not None:
        try:
            await alert_runtime.stop()
            print("[shutdown] AlertRuntime shut down [ok]")
        except Exception as exc:
            print(f"[shutdown] AlertRuntime shutdown error: {exc}")

    alert_facade = getattr(app.state, "alert_facade", None)
    if alert_facade is not None:
        try:
            await alert_facade.stop()
            print("[shutdown] Alert delivery outbox shut down [ok]")
        except Exception as exc:
            print(f"[shutdown] Alert delivery outbox shutdown error: {exc}")

    indicator_runtime_service = getattr(
        app.state,
        "indicator_runtime_service",
        None,
    )
    if indicator_runtime_service is not None:
        try:
            await indicator_runtime_service.stop()
        except Exception as exc:
            logger.warning(
                "Indicator runtime routing shutdown error: %s",
                exc,
                exc_info=True,
            )

    plugin_runtime_host = getattr(app.state, "plugin_runtime_host", None)
    if plugin_runtime_host is not None:
        try:
            await plugin_runtime_host.stop()
            print("[shutdown] Runtime plugin host shut down [ok]")
        except Exception as exc:
            logger.warning("Runtime plugin host shutdown error: %s", exc, exc_info=True)
            print(f"[shutdown] Runtime plugin host shutdown error: {exc}")

    runtime = getattr(app.state, "data_engine_runtime", None)
    if runtime is not None:
        await runtime.shutdown(step_timeout=5)
    replay_runtime = getattr(app.state, "replay_runtime", None)
    if replay_runtime is not None:
        await replay_runtime.shutdown(step_timeout=5)

    print("[shutdown] All components shut down")


# ═══════════════════════════════════════════════════════════════
#  System Endpoints
# ═══════════════════════════════════════════════════════════════


@app.get("/", tags=["system"])
async def root() -> dict:
    dm = getattr(app.state, "data_manager", None)
    return {
        "name": "CandleScope API",
        "version": APP_VERSION,
        "status": "running",
        "runtime_mode": RUNTIME_MODE,
        "data_manager": "active" if dm is not None else "not_initialized",
    }


@app.get("/health", tags=["system"])
async def health_check() -> dict:
    dm = getattr(app.state, "data_manager", None)
    result: dict = {"status": "ok", "runtime_mode": RUNTIME_MODE}
    local_runtime = getattr(app.state, "local_offline_runtime", None)
    if local_runtime is not None:
        result["local_offline"] = local_runtime.diagnostics()
    alert_runtime = getattr(app.state, "alert_runtime", None)
    alert_facade = getattr(app.state, "alert_facade", None)
    if alert_runtime is not None:
        runtime_snapshot = alert_runtime.snapshot()
        result["alerts"] = {
            **(alert_facade.status() if alert_facade is not None else {}),
            "runtime": runtime_snapshot,
        }
        if runtime_snapshot.get("status") == "error":
            result["status"] = "degraded"
    elif alert_facade is not None:
        result["alerts"] = {
            **alert_facade.status(),
            "runtime": {"status": "unavailable", "started": False},
        }
        result["status"] = "degraded"
    plugin_plane = getattr(app.state, "plugin_plane", None)
    if isinstance(plugin_plane, dict):
        result["plugin_plane"] = {
            key: plugin_plane[key]
            for key in ("status", "reasonCode", "reason", "issues")
            if key in plugin_plane
        }
        if plugin_plane.get("status") == "degraded":
            result["status"] = "degraded"
    plugin_runtime_host = getattr(app.state, "plugin_runtime_host", None)
    if plugin_runtime_host is not None:
        result["plugin_runtimes"] = plugin_runtime_host.health_summary()
        if result["plugin_runtimes"].get("status") == "degraded":
            result["status"] = "degraded"
    plugin_platform_v2 = getattr(app.state, "plugin_platform_v2", None)
    if plugin_platform_v2 is not None:
        result["plugin_platform_v2"] = plugin_platform_v2.health_summary()
    first_party_bootstrap = getattr(
        app.state,
        "first_party_plugin_bootstrap",
        None,
    )
    if isinstance(first_party_bootstrap, dict):
        result["first_party_plugin_bootstrap"] = {
            key: first_party_bootstrap[key]
            for key in (
                "status",
                "runtimeId",
                "version",
                "changed",
                "downloaded",
                "reason",
            )
            if key in first_party_bootstrap
        }
        if first_party_bootstrap.get("status") == "unavailable":
            result["status"] = "degraded"
    indicator_runtime_service = getattr(
        app.state,
        "indicator_runtime_service",
        None,
    )
    if indicator_runtime_service is not None:
        routing = indicator_runtime_service.snapshot()
        result["indicator_runtime_routing"] = {
            "started": routing["started"],
            "routes": routing["routes"],
            "counts": routing["counts"],
            "unavailable": routing.get("unavailable") or [],
        }
        if result["indicator_runtime_routing"]["unavailable"]:
            result["status"] = "degraded"
    if dm is not None:
        try:
            result["data_manager"] = dm.health_snapshot()
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
    try:
        snapshot = (
            {"error": "DataManager not initialized"} if dm is None else dm.snapshot()
        )
        snapshot["executors"] = executors_snapshot()
        lag_monitor = getattr(app.state, "event_loop_lag_monitor", None)
        snapshot["runtime"] = {
            "event_loop_lag": lag_monitor.snapshot()
            if lag_monitor is not None
            else None,
            "websocket": ws_runtime_metrics.snapshot(),
        }
        replay_runtime = getattr(app.state, "replay_runtime", None)
        replay_service = getattr(app.state, "replay_service", None)
        if replay_runtime is not None:
            snapshot["replay"] = replay_runtime.diagnostics(redact_paths=True)
        elif replay_service is not None:
            snapshot["replay"] = replay_service.diagnostics(redact_paths=True)
        else:
            snapshot["replay"] = {
                "enabled": False,
                "available": False,
                "reason": "REPLAY_DISABLED",
                "sessions": {},
            }
        return snapshot
    except Exception as exc:
        return {"error": str(exc)}


@app.get("/debug/capacity", tags=["system"])
async def capacity_snapshot(
    include_database_hash: bool = False,
    detail_offset: int = 0,
    detail_limit: int = 20,
    event_loop_after_sequence: int | None = None,
) -> dict:
    """Return a read-only, multi-chart-oriented capacity snapshot."""

    return await build_capacity_snapshot(
        app.state,
        include_database_hash=include_database_hash,
        detail_offset=detail_offset,
        detail_limit=detail_limit,
        event_loop_after_sequence=event_loop_after_sequence,
    )
