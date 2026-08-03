"""Real-browser fixture for the Phase 6 local trust double-confirmation UX."""

from __future__ import annotations

import asyncio
import json
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from app.plugin_core_v2.api import create_core_plugin_router
from app.plugin_core_v2.runtime import CorePluginPlatform
from app.plugin_security_v2.management import LocalManagementGuard
from tests.plugin_platform_bundle_testkit import build_hello_platform_bundle


ROOT = Path(os.environ["PHASE6_BROWSER_PLATFORM_ROOT"]).resolve()
BUNDLE_DIRECTORY = Path(os.environ["PHASE6_BROWSER_BUNDLE_DIRECTORY"]).resolve()
ORIGIN = os.environ.get("PHASE6_BROWSER_ORIGIN", "http://127.0.0.1:18136")
MANAGEMENT_API_ORIGIN = os.environ.get(
    "PHASE6_BROWSER_MANAGEMENT_API_ORIGIN",
    "http://localhost:18136",
)
SESSION_TOKEN = "phase6-browser-session-token-0123456789abcdef"
CSRF_TOKEN = "phase6-browser-csrf-token-abcdef0123456789"
FRONTEND_DIST = Path(
    os.environ.get(
        "PHASE6_BROWSER_FRONTEND_DIST",
        Path(__file__).resolve().parents[2] / "frontend" / "dist",
    )
).resolve()
if not FRONTEND_DIST.is_dir():
    raise RuntimeError("Phase 6 browser fixture requires a production frontend build")

BUNDLE_FIXTURE = build_hello_platform_bundle(BUNDLE_DIRECTORY)
PLATFORM = CorePluginPlatform(
    root=ROOT,
    host_name="CandleScope",
    host_version="0.4.0",
    trust_ux_enabled=True,
)
GUARD = LocalManagementGuard(
    (ORIGIN,),
    session_token=SESSION_TOKEN,
    csrf_token=CSRF_TOKEN,
)


def _browser_exchange() -> dict[str, Any]:
    return {
        "exchange": "binance",
        "name": "Phase 6 Browser Fixture",
        "capability_schema_version": 3,
        "markets": [{"market_type": "spot", "product_type": "spot", "label": "Spot"}],
        "native_intervals": ["1m", "1h"],
        "channels": [
            {
                "channel": "kline",
                "market_types": ["spot"],
                "realtime": True,
                "history": True,
                "params": {"interval": ["1m", "1h"]},
            }
        ],
        "protocol_features": [],
        "limits": {},
        "known_limitations": ["Phase 6 browser fixture only"],
    }


def _browser_klines() -> dict[str, Any]:
    end = int(time.time()) // 3_600 * 3_600
    bars = [
        {
            "time": end - (63 - index) * 3_600,
            "open": 99 + (index % 4) * 0.25,
            "high": 101 + (index % 4) * 0.25,
            "low": 98 + (index % 4) * 0.25,
            "close": 100 + (index % 4) * 0.25,
            "volume": 10 + index,
            "is_closed": True,
        }
        for index in range(64)
    ]
    return {
        "data": bars,
        "count": len(bars),
        "exchange": "binance",
        "market_type": "spot",
        "symbol": "BTCUSDT",
        "interval": "1h",
        "has_more": False,
        "all_rows_final": True,
        "verified_contiguous": True,
        "renderable": True,
    }


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await PLATFORM.start()
    try:
        yield
    finally:
        await PLATFORM.stop()


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
app.include_router(create_core_plugin_router())


@app.post("/api/v1/settings/cache-limits")
async def browser_cache_limits() -> dict[str, Any]:
    return {"updated": True}


@app.post("/api/v1/settings/cache-access")
async def browser_cache_access() -> dict[str, Any]:
    return {"recorded": True}


@app.get("/api/v1/settings/cache-diagnostics")
async def browser_cache_diagnostics() -> dict[str, Any]:
    return {}


@app.get("/api/v1/settings/proxy")
async def browser_proxy_settings() -> dict[str, Any]:
    return {
        "mode": "none",
        "custom_proxy": "",
        "system_proxy": "",
        "effective_proxy": "",
    }


@app.get("/api/v1/exchanges/")
async def browser_exchanges() -> dict[str, Any]:
    exchange = _browser_exchange()
    return {"count": 1, "exchanges": [exchange]}


@app.get("/api/v1/exchanges/binance/capabilities")
async def browser_exchange_capabilities() -> dict[str, Any]:
    return _browser_exchange()


@app.get("/api/v1/subscriptions/")
async def browser_subscriptions() -> dict[str, Any]:
    return {"subscriptions": []}


@app.get("/api/v1/replay/capabilities")
async def browser_replay_capabilities() -> dict[str, Any]:
    return {
        "protocol": "replay.v1",
        "enabled": False,
        "available": False,
        "reason": "REPLAY_DISABLED",
        "sources": {
            "bar": {"enabled": False, "reason": "REPLAY_DISABLED"},
            "agg_trade": {"enabled": False, "reason": "REPLAY_DISABLED"},
        },
        "execution_models": [],
        "limits": {
            "max_active_sessions": 1,
            "max_warmup_bars": 5000,
            "max_bar_dataset_rows": 1_000_000,
            "max_horizon_days": 365,
            "event_buffer_size": 10_000,
            "subscriber_queue": 1024,
        },
        "persistence": {
            "opened": False,
            "schema_version": None,
            "degraded": False,
            "degraded_reason": None,
        },
    }


@app.get("/api/v1/klines/")
@app.get("/api/v1/klines/latest")
@app.get("/api/v1/klines/history")
async def browser_klines() -> dict[str, Any]:
    return _browser_klines()


async def _hold_browser_websocket(websocket: WebSocket) -> None:
    await websocket.accept()
    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                return
    except WebSocketDisconnect:
        return


@app.websocket("/api/v1/stream/prices")
@app.websocket("/api/v1/stream/order-book")
@app.websocket("/api/v1/stream/klines_multi")
async def browser_websocket(websocket: WebSocket) -> None:
    await _hold_browser_websocket(websocket)


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    installed = list(await asyncio.to_thread(PLATFORM.installer.list_plugins))
    detail = (
        await asyncio.to_thread(
            PLATFORM.management_detail,
            installed[0]["pluginId"],
        )
        if installed
        else None
    )
    return {
        "ready": True,
        "bundlePath": str(BUNDLE_FIXTURE.bundle.path),
        "bundleSha256": BUNDLE_FIXTURE.bundle.sha256,
        "installed": installed,
        "detail": detail,
        "supervisors": len(PLATFORM.manager.owner_keys()),
    }


@app.get("/", response_class=HTMLResponse)
async def frontend_index() -> HTMLResponse:
    html = (FRONTEND_DIST / "index.html").read_text(encoding="utf-8")
    bootstrap = f"""
<script>
localStorage.setItem("candlescope-active-indicators", JSON.stringify([{{
  id: "vol", name: "VOL", engineName: "VOL", script: "", params: {{}},
  description: "Browser fixture", category: "", paneTarget: "volume",
  isPreset: true, visible: false
}}]));
localStorage.setItem("candlescope-vol-initialized", "1");
window.__CANDLESCOPE_PLUGIN_MANAGEMENT_V1__ = {{
  apiBase: "{MANAGEMENT_API_ORIGIN}/api/v2/plugins",
  sessionToken: "{SESSION_TOKEN}",
  csrfToken: "{CSRF_TOKEN}"
}};
window.__CANDLESCOPE_PHASE6_BROWSER_V1__ = {
        json.dumps(
            {
                "pluginId": BUNDLE_FIXTURE.bundle.manifest.plugin.id,
                "version": BUNDLE_FIXTURE.bundle.manifest.plugin.version,
                "bundleSha256": BUNDLE_FIXTURE.bundle.sha256,
            },
            separators=(",", ":"),
        )
    };
</script>
"""
    return HTMLResponse(html.replace("</head>", bootstrap + "</head>"))


app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="phase6-frontend")
