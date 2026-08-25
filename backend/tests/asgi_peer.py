"""ASGI wrapper that sets the TCP peer for TestClient versions without client=."""

from __future__ import annotations

from typing import Any, Awaitable, Callable

Scope = dict[str, Any]
Receive = Callable[[], Awaitable[dict[str, Any]]]
Send = Callable[[dict[str, Any]], Awaitable[None]]


class PeerASGIApp:
    def __init__(self, app: Any, client_host: str) -> None:
        self.app = app
        self.client_host = client_host

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") in {"http", "websocket"}:
            scope = dict(scope)
            scope["client"] = (self.client_host, 50000)
        await self.app(scope, receive, send)
