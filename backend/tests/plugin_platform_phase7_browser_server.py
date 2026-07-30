"""Isolated real-browser fixture for the Phase 7 declarative plugin workflow."""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.data_engine.data_manager.models import (
    BarData,
    QueryResult,
    QuerySource,
)
from app.plugin_core_v2.api import create_core_plugin_router
from app.plugin_core_v2.runtime import CorePluginPlatform
from app.plugin_market_v2.ports import PortBarSubscription
from app.plugin_security_v2.management import LocalManagementGuard
from tests.plugin_platform_bundle_testkit import build_market_scanner_bundle


ROOT = Path(os.environ["PHASE7_BROWSER_PLATFORM_ROOT"]).resolve()
BUNDLE_DIRECTORY = Path(os.environ["PHASE7_BROWSER_BUNDLE_DIRECTORY"]).resolve()
ORIGIN = os.environ.get("PHASE7_BROWSER_ORIGIN", "http://127.0.0.1:15187")
SESSION_TOKEN = os.environ.get(
    "PHASE7_BROWSER_SESSION_TOKEN",
    "phase7-browser-session-token-0123456789abcdef",
)
CSRF_TOKEN = os.environ.get(
    "PHASE7_BROWSER_CSRF_TOKEN",
    "phase7-browser-csrf-token-abcdef0123456789",
)
FRONTEND_DIST = Path(
    os.environ.get(
        "PHASE7_BROWSER_FRONTEND_DIST",
        Path(__file__).resolve().parents[2] / "frontend" / "dist",
    )
).resolve()
if not FRONTEND_DIST.is_dir():
    raise RuntimeError("Phase 7 browser fixture requires a production frontend build")

# Build a real offline-installable bundle, but leave installation to the browser.
BUNDLE_FIXTURE = build_market_scanner_bundle(BUNDLE_DIRECTORY)


class BrowserMarketPort:
    async def list_symbols(self, _request: Any):
        return (
            [
                {"symbol": "BTCUSDT", "baseAsset": "BTC", "quoteAsset": "USDT"},
                {"symbol": "ETHUSDT", "baseAsset": "ETH", "quoteAsset": "USDT"},
            ],
            123.0,
        )

    async def read_bars(self, request: Any):
        multiplier = 1.0 if request.series.symbol == "BTCUSDT" else 2.0
        bars = [
            BarData(
                time=1_700_000_000,
                open=100 * multiplier,
                high=101 * multiplier,
                low=99 * multiplier,
                close=100 * multiplier,
                volume=10,
                quote_volume=1_000 * multiplier,
                trades=2,
                taker_buy_base=6,
                taker_buy_quote=600 * multiplier,
                is_closed=True,
                source="browser-fixture",
            ),
            BarData(
                time=1_700_003_600,
                open=100 * multiplier,
                high=104 * multiplier,
                low=99 * multiplier,
                close=103 * multiplier,
                volume=12,
                quote_volume=1_236 * multiplier,
                trades=3,
                taker_buy_base=7,
                taker_buy_quote=721 * multiplier,
                is_closed=True,
                source="browser-fixture",
            ),
        ]
        return QueryResult(
            bars=bars,
            symbol=request.series.symbol,
            interval=request.series.interval,
            source=QuerySource.CACHE,
            total=len(bars),
            metadata={"all_rows_final": True, "verified_contiguous": True},
            complete=True,
        )

    async def subscribe_bars(self, request: Any, *, consumer_id: str, callback: Any):
        del callback
        return PortBarSubscription(object(), consumer_id, request)

    async def unsubscribe_bars(self, _subscription: Any):
        return None

    async def read_trades(self, _request: Any):
        return {"schemaVersion": "candlescope.market-trades-page/1", "payload": {}}

    async def read_order_book(self, _request: Any, *, consumer_id: str):
        del consumer_id
        return {"schemaVersion": "candlescope.market-order-book/1", "payload": {}}


platform = CorePluginPlatform(
    root=ROOT,
    host_name="CandleScope",
    host_version="0.4.0",
)
platform.bind_market_data(BrowserMarketPort())
guard = LocalManagementGuard(
    (ORIGIN,),
    session_token=SESSION_TOKEN,
    csrf_token=CSRF_TOKEN,
)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await platform.start()
    try:
        yield
    finally:
        await platform.stop()


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[ORIGIN],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "OPTIONS"],
    allow_headers=["*"],
)
app.state.plugin_platform_v2 = platform
app.state.plugin_platform_v2_management_guard = guard
app.include_router(create_core_plugin_router())


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    return {
        "ready": True,
        "installed": platform.health_summary()["installed"],
        "bundleName": BUNDLE_FIXTURE.bundle.path.name,
    }


app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="phase7-frontend")
