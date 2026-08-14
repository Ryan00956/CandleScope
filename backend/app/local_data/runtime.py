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
        } or path.startswith("/api/v1/local")

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


class LocalOfflineRuntime:
    def __init__(self, root: Path) -> None:
        self.service = LocalDatasetService(root)
        self.jobs = LocalImportJobManager(self.service)
        self.network_guard = OfflineNetworkGuard()

    def start(self) -> None:
        self.service.start()
        self.network_guard.install()

    def shutdown(self) -> None:
        self.jobs.shutdown()
        self.network_guard.uninstall()

    def diagnostics(self) -> dict[str, Any]:
        return {
            "mode": "LOCAL_OFFLINE",
            "network": self.network_guard.snapshot(),
            "local_data": self.service.diagnostics(),
        }
