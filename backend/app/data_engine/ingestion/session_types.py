"""Session contracts consumed by feed control."""
from __future__ import annotations

from typing import Awaitable, Callable, Protocol

from .models import FeedMode, RawMessage, SessionHealth

MessageCallback = Callable[[RawMessage], Awaitable[None]]
HealthCallback = Callable[[SessionHealth, str], Awaitable[None]]


class SessionLike(Protocol):
    """WebSocket session interface used by FeedControlLayer."""

    @property
    def health(self) -> SessionHealth:
        ...

    @property
    def feed_mode(self) -> FeedMode:
        ...

    @property
    def manages_recovery_while_http(self) -> bool:
        """Whether this session remains active while L3 uses HTTP fallback."""
        ...

    @property
    def http_fallback_health_states(self) -> frozenset[SessionHealth]:
        """Health states that should move L3 into HTTP fallback."""
        ...

    def on_message(self, callback: MessageCallback) -> None:
        ...

    def on_health_change(self, callback: HealthCallback) -> None:
        ...

    async def start(self) -> None:
        ...

    async def stop(self) -> None:
        ...

    def snapshot(self) -> dict:
        ...
