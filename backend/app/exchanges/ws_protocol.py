from __future__ import annotations

import enum
from dataclasses import dataclass, field
from typing import Any


class WsSubscriptionMode(str, enum.Enum):
    """How a WebSocket stream is subscribed."""
    PATH = "path"
    MESSAGE = "message"


@dataclass(slots=True)
class WsSubscriptionSpec:
    """Exchange-specific subscription instructions for a WS stream."""
    mode: WsSubscriptionMode = WsSubscriptionMode.PATH
    stream_name: str | None = None
    subscribe_payload: dict[str, Any] | None = None
    unsubscribe_payload: dict[str, Any] | None = None
    requires_subscribe_ack: bool = False


@dataclass(slots=True)
class WsConnectionContext:
    """Connection handle plus protocol metadata for the WS session."""
    connection: Any
    endpoint: str
    subscription: WsSubscriptionSpec
    prefetched_payloads: list[Any] = field(default_factory=list)
