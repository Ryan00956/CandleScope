"""Real cold-database browser fixture for the Phase 10 provider workflow."""

from __future__ import annotations

import os
import sqlite3
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from app.api.v1.exchanges import router as exchanges_router
from app.api.v1.indicators import router as indicators_router
from app.api.v1.klines import router as klines_router
from app.api.v1.settings import router as settings_router
from app.api.v1.stream import router as stream_router
from app.api.v1.subscriptions import price_ws_router, router as subscriptions_router
from app.api.v1.symbols import (
    evict_exchange_metadata,
    refresh_exchange_metadata,
    router as symbols_router,
)
from app.data_engine.runtime import start_data_engine
from app.data_engine.storage import (
    KlinesRepoAdapter,
    init_klines_storage,
    init_liquidation_storage,
    init_market_metrics_storage,
    init_trade_flow_storage,
)
from app.exchanges import get_exchange_registry
from app.plugin_core_v2.api import create_core_plugin_router
from app.plugin_core_v2.runtime import CorePluginPlatform
from app.plugin_installer_v2 import PlatformPluginInstaller
from app.plugin_market_v2 import DataManagerConsumerPort
from app.plugin_security_v2.management import LocalManagementGuard
from tests.plugin_platform_bundle_testkit import build_mock_exchange_provider_bundle


ROOT = Path(os.environ["PHASE10_BROWSER_PLATFORM_ROOT"]).resolve()
BUNDLE_DIRECTORY = Path(os.environ["PHASE10_BROWSER_BUNDLE_DIRECTORY"]).resolve()
DB_PATH = Path(os.environ["KLINES_DB_PATH"]).resolve()
ORIGIN = os.environ.get("PHASE10_BROWSER_ORIGIN", "http://127.0.0.1:18130")
MANAGEMENT_API_ORIGIN = os.environ.get(
    "PHASE10_BROWSER_MANAGEMENT_API_ORIGIN",
    "http://localhost:18130",
)
SESSION_TOKEN = "phase10-browser-session-token-0123456789abcdef"
CSRF_TOKEN = "phase10-browser-csrf-token-abcdef0123456789"
FRONTEND_DIST = Path(
    os.environ.get(
        "PHASE10_BROWSER_FRONTEND_DIST",
        Path(__file__).resolve().parents[2] / "frontend" / "dist",
    )
).resolve()
if not FRONTEND_DIST.is_dir():
    raise RuntimeError("Phase 10 browser fixture requires a production frontend build")
if DB_PATH.exists():
    raise RuntimeError("Phase 10 browser fixture requires a non-existent cold database")

BUNDLE_FIXTURE = build_mock_exchange_provider_bundle(BUNDLE_DIRECTORY)
INSTALLER = PlatformPluginInstaller(root=ROOT, host_version="0.4.0")
INSTALLATION = INSTALLER.install(
    BUNDLE_FIXTURE.bundle.path,
    expected_sha256=BUNDLE_FIXTURE.bundle.sha256,
    enabled=True,
)
PLATFORM = CorePluginPlatform(
    root=ROOT,
    host_name="CandleScope",
    host_version="0.4.0",
)
GUARD = LocalManagementGuard(
    (ORIGIN,),
    session_token=SESSION_TOKEN,
    csrf_token=CSRF_TOKEN,
)
COLD_AT_START = True
INITIAL_ROWS = 0


@asynccontextmanager
async def lifespan(app: FastAPI):
    global INITIAL_ROWS
    init_klines_storage()
    init_market_metrics_storage()
    init_trade_flow_storage(DB_PATH)
    init_liquidation_storage(DB_PATH)
    storage = KlinesRepoAdapter(exchange="mock", market_type="spot")
    INITIAL_ROWS = len(storage.query_bars("BTCUSDT", "1m"))
    if INITIAL_ROWS != 0:
        raise RuntimeError("Phase 10 browser database was not empty at startup")

    registry = get_exchange_registry()
    registry.unregister("mock")
    evict_exchange_metadata("mock")
    PLATFORM.bind_symbol_refresher(
        refresh_exchange_metadata,
        evictor=evict_exchange_metadata,
    )
    await PLATFORM.start()
    runtime = await start_data_engine()
    runtime.attach_to_app_state(app.state)
    PLATFORM.bind_market_data(DataManagerConsumerPort(runtime.data_manager))
    try:
        yield
    finally:
        await runtime.shutdown()
        await PLATFORM.stop()
        registry.unregister("mock")
        evict_exchange_metadata("mock")


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[ORIGIN],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "OPTIONS"],
    allow_headers=["*"],
)
app.state.plugin_platform_v2 = PLATFORM
app.state.plugin_platform_v2_management_guard = GUARD
app.include_router(klines_router, prefix="/api/v1")
app.include_router(exchanges_router, prefix="/api/v1")
app.include_router(symbols_router, prefix="/api/v1")
app.include_router(stream_router, prefix="/api/v1")
app.include_router(subscriptions_router, prefix="/api/v1")
app.include_router(price_ws_router, prefix="/api/v1")
app.include_router(settings_router, prefix="/api/v1")
app.include_router(indicators_router, prefix="/api/v1")
app.include_router(create_core_plugin_router())


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    storage = KlinesRepoAdapter(exchange="mock", market_type="spot")
    rows = storage.query_bars(
        "BTCUSDT",
        "1m",
        exchange="mock",
        market_type="spot",
        limit=5_000,
    )
    with sqlite3.connect(DB_PATH) as connection:
        quick_check = connection.execute("PRAGMA quick_check").fetchone()[0]
    supervisor = next(
        (
            PLATFORM.manager.supervisor(*owner).snapshot()
            for owner in PLATFORM.manager.owner_keys()
            if owner == (INSTALLATION.plugin_id, "main")
        ),
        None,
    )
    return {
        "ready": True,
        "coldAtStart": COLD_AT_START,
        "initialRows": INITIAL_ROWS,
        "storedRows": len(rows),
        "quickCheck": quick_check,
        "providerRequests": supervisor["requests"] if supervisor else None,
        "providerRestarts": supervisor["restarts"] if supervisor else None,
        "registeredExchanges": list(PLATFORM.providers.registered_exchanges()),
        "bundleSha256": BUNDLE_FIXTURE.bundle.sha256,
    }


@app.get("/", response_class=HTMLResponse)
async def frontend_index() -> HTMLResponse:
    html = (FRONTEND_DIST / "index.html").read_text(encoding="utf-8")
    bootstrap = f"""
<script>
localStorage.setItem("candlescope-user-prefs", JSON.stringify({{
  lastExchange: "mock", lastMarketType: "spot", lastSymbol: "BTCUSDT", lastInterval: "1m"
}}));
window.__CANDLESCOPE_PLUGIN_MANAGEMENT_V1__ = {{
  apiBase: "{MANAGEMENT_API_ORIGIN}/api/v2/plugins",
  sessionToken: "{SESSION_TOKEN}",
  csrfToken: "{CSRF_TOKEN}"
}};
</script>
"""
    return HTMLResponse(html.replace("</head>", bootstrap + "</head>"))


app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="phase10-frontend")
