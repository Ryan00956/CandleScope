"""Lifecycle and ASGI boundary for the local-offline application profile."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .network_guard import OfflineNetworkGuard
from .jobs import LocalImportJobManager
from .service import LocalDatasetService


class LocalOfflineProfileMiddleware:
    """Reject live/replay/plugin APIs when the process selected local mode."""

    def __init__(self, app: Any, *, enabled: bool) -> None:
        self.app = app
        self.enabled = enabled

    @staticmethod
    def _allowed(path: str) -> bool:
        return path in {
            "/",
            "/health",
            "/docs",
            "/redoc",
            "/openapi.json",
        } or path.startswith(("/api/v1/local", "/api/v1/backtests"))

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if not self.enabled or self._allowed(scope.get("path", "")):
            await self.app(scope, receive, send)
            return
        if scope["type"] == "websocket":
            await send(
                {
                    "type": "websocket.close",
                    "code": 1008,
                    "reason": "LOCAL_OFFLINE profile",
                }
            )
            return
        if scope["type"] == "http":
            body = json.dumps(
                {
                    "detail": {
                        "code": "offline_profile_boundary",
                        "message": "This API is disabled in LOCAL_OFFLINE mode",
                    }
                }
            ).encode()
            await send(
                {
                    "type": "http.response.start",
                    "status": 403,
                    "headers": [
                        (b"content-type", b"application/json"),
                        (b"content-length", str(len(body)).encode()),
                    ],
                }
            )
            await send({"type": "http.response.body", "body": body})
            return
        await self.app(scope, receive, send)


class LocalDataRuntime:
    """Unique writable owner of LocalDatasetService and import jobs."""

    def __init__(self, root: Path) -> None:
        self.service = LocalDatasetService(root)
        self.jobs = LocalImportJobManager(self.service)
        self._started = False
        self._shutdown = False

    def start(self) -> None:
        if self._started:
            return
        self.service.start()
        self._started = True

    def shutdown(self) -> None:
        if self._shutdown:
            return
        self._shutdown = True
        self.jobs.shutdown()


class LocalOfflineBoundary:
    """Process-level LOCAL_OFFLINE network guard. Not a page toggle."""

    def __init__(self) -> None:
        self.network_guard = OfflineNetworkGuard()

    def install(self) -> None:
        self.network_guard.install()

    def uninstall(self) -> None:
        self.network_guard.uninstall()

    def snapshot(self) -> dict[str, Any]:
        return self.network_guard.snapshot()


class LocalOfflineRuntime:
    def __init__(self, root: Path) -> None:
        self.data = LocalDataRuntime(root)
        self.boundary = LocalOfflineBoundary()
        self.service = self.data.service
        self.jobs = self.data.jobs
        self.network_guard = self.boundary.network_guard

    def start(self) -> None:
        self.data.start()
        self.boundary.install()

    def shutdown(self) -> None:
        self.data.shutdown()
        self.boundary.uninstall()

    def diagnostics(self) -> dict[str, Any]:
        return {
            "mode": "LOCAL_OFFLINE",
            "network": self.network_guard.snapshot(),
            "local_data": self.service.diagnostics(),
        }
