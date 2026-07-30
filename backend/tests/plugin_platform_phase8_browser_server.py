"""Isolated real-browser fixture for the Phase 8 sandbox plugin workflow."""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.plugin_core_v2.api import create_core_plugin_router
from app.plugin_core_v2.runtime import CorePluginPlatform
from app.plugin_security_v2.management import LocalManagementGuard
from tests.plugin_platform_bundle_testkit import build_sandbox_view_bundle


ROOT = Path(os.environ["PHASE8_BROWSER_PLATFORM_ROOT"]).resolve()
BUNDLE_DIRECTORY = Path(os.environ["PHASE8_BROWSER_BUNDLE_DIRECTORY"]).resolve()
ORIGIN = os.environ.get("PHASE8_BROWSER_ORIGIN", "http://127.0.0.1:15188")
SESSION_TOKEN = os.environ.get(
    "PHASE8_BROWSER_SESSION_TOKEN",
    "phase8-browser-session-token-0123456789abcdef",
)
CSRF_TOKEN = os.environ.get(
    "PHASE8_BROWSER_CSRF_TOKEN",
    "phase8-browser-csrf-token-abcdef0123456789",
)
FRONTEND_DIST = Path(
    os.environ.get(
        "PHASE8_BROWSER_FRONTEND_DIST",
        Path(__file__).resolve().parents[2] / "frontend" / "dist",
    )
).resolve()
if not FRONTEND_DIST.is_dir():
    raise RuntimeError("Phase 8 browser fixture requires a production frontend build")

BUNDLE_FIXTURE = build_sandbox_view_bundle(BUNDLE_DIRECTORY)
SUBRESOURCE_PROBE_REQUESTS = 0
platform = CorePluginPlatform(
    root=ROOT,
    host_name="CandleScope",
    host_version="0.4.0",
)
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
    summary = platform.health_summary()
    return {
        "ready": True,
        "installed": summary["installed"],
        "runningEntrypoints": summary["runningEntrypoints"],
        "subscriptions": summary["subscriptions"],
        "bundleName": BUNDLE_FIXTURE.bundle.path.name,
        "bundleSha256": BUNDLE_FIXTURE.bundle.sha256,
        "subresourceProbeRequests": SUBRESOURCE_PROBE_REQUESTS,
    }


@app.get("/phase8-subresource-probe.gif")
async def phase8_subresource_probe() -> Response:
    global SUBRESOURCE_PROBE_REQUESTS
    SUBRESOURCE_PROBE_REQUESTS += 1
    return Response(
        content=bytes.fromhex(
            "47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b"
        ),
        media_type="image/gif",
    )


app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="phase8-frontend")
