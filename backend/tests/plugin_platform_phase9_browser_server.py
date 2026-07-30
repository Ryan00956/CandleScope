"""Isolated real-browser fixture for the Phase 9 integration gateway workflow."""

from __future__ import annotations

import os
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.plugin_core_v2.api import create_core_plugin_router
from app.plugin_core_v2.runtime import CorePluginPlatform
from app.plugin_gateway_v2.network import (
    ConnectionControl,
    PinnedHttpRequest,
    PinnedHttpResponse,
)
from app.plugin_security_v2.management import LocalManagementGuard
from tests.plugin_platform_bundle_testkit import build_integration_gateway_bundle


ROOT = Path(os.environ["PHASE9_BROWSER_PLATFORM_ROOT"]).resolve()
BUNDLE_DIRECTORY = Path(os.environ["PHASE9_BROWSER_BUNDLE_DIRECTORY"]).resolve()
ORIGIN = os.environ.get("PHASE9_BROWSER_ORIGIN", "http://127.0.0.1:18129")
SESSION_TOKEN = os.environ.get(
    "PHASE9_BROWSER_SESSION_TOKEN",
    "phase9-browser-session-token-0123456789abcdef",
)
CSRF_TOKEN = os.environ.get(
    "PHASE9_BROWSER_CSRF_TOKEN",
    "phase9-browser-csrf-token-abcdef0123456789",
)
FRONTEND_DIST = Path(
    os.environ.get(
        "PHASE9_BROWSER_FRONTEND_DIST",
        Path(__file__).resolve().parents[2] / "frontend" / "dist",
    )
).resolve()
if not FRONTEND_DIST.is_dir():
    raise RuntimeError("Phase 9 browser fixture requires a production frontend build")

BUNDLE_FIXTURE = build_integration_gateway_bundle(BUNDLE_DIRECTORY)


class BrowserPinnedTransport:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.requests = 0
        self.last_method: str | None = None
        self.last_host: str | None = None
        self.last_resolved_ip: str | None = None

    def request(
        self,
        request: PinnedHttpRequest,
        *,
        resolved_ip: str,
        timeout_seconds: float,
        max_response_bytes: int,
        control: ConnectionControl,
    ) -> PinnedHttpResponse:
        del timeout_seconds, max_response_bytes
        if control.cancelled:
            raise OSError("browser fixture network request was revoked")
        with self._lock:
            self.requests += 1
            self.last_method = request.method
            self.last_host = request.host
            self.last_resolved_ip = resolved_ip
        return PinnedHttpResponse(
            200,
            (("content-type", "text/plain"),),
            b"phase9-browser-host-mediated-network",
        )

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "requests": self.requests,
                "lastMethod": self.last_method,
                "lastHost": self.last_host,
                "lastResolvedIp": self.last_resolved_ip,
            }


network_transport = BrowserPinnedTransport()
platform = CorePluginPlatform(
    root=ROOT,
    host_name="CandleScope",
    host_version="0.4.0",
    network_resolver=lambda host, port: ("93.184.216.34",),
    network_transport=network_transport,
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
        "bundleName": BUNDLE_FIXTURE.bundle.path.name,
        "bundleSha256": BUNDLE_FIXTURE.bundle.sha256,
        "network": network_transport.snapshot(),
    }


app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="phase9-frontend")
