"""Host-owned ports; plugin code never receives these Python objects."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Protocol

from candlescope_plugin_sdk.platform_v2 import (
    BarsReadRequest,
    BarsSubscribeRequest,
    OrderBookReadRequest,
    SymbolsReadRequest,
    TradesReadRequest,
)


BarEventCallback = Callable[[Any], Awaitable[None]]


@dataclass(frozen=True, slots=True)
class PortBarSubscription:
    handle: Any
    consumer_id: str
    request: BarsSubscribeRequest


class MarketDataConsumerPort(Protocol):
    async def list_symbols(
        self, request: SymbolsReadRequest
    ) -> tuple[list[dict[str, Any]], float]: ...

    async def read_bars(self, request: BarsReadRequest) -> Any: ...

    async def subscribe_bars(
        self,
        request: BarsSubscribeRequest,
        *,
        consumer_id: str,
        callback: BarEventCallback,
    ) -> PortBarSubscription: ...

    async def unsubscribe_bars(self, subscription: PortBarSubscription) -> None: ...

    async def read_trades(self, request: TradesReadRequest) -> dict[str, Any]: ...

    async def read_order_book(
        self, request: OrderBookReadRequest, *, consumer_id: str
    ) -> dict[str, Any]: ...


__all__ = ["BarEventCallback", "MarketDataConsumerPort", "PortBarSubscription"]
