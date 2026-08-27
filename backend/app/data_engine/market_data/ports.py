"""Typed service ports owned by the DataManager market-data facade.

The concrete services intentionally keep channel-specific semantics.  These
protocols only define the stable boundary that DataManager needs for routing,
lifecycle, and diagnostics; they do not flatten bars, trades, and books into a
single generic query method.
"""

from __future__ import annotations

from typing import Any, Protocol, runtime_checkable

from .models import MarketStreamKey


@runtime_checkable
class AdvancedMarketDataPort(Protocol):
    async def ensure_stream(self, key: MarketStreamKey, *, consumer_id: str) -> bool: ...

    async def release_stream(self, key: MarketStreamKey, *, consumer_id: str) -> bool: ...

    async def snapshot(
        self,
        keys: list[MarketStreamKey],
        *,
        refresh_missing: bool = True,
    ) -> list[Any]: ...

    async def history(self, key: MarketStreamKey, **kwargs: Any) -> list[Any]: ...

    async def history_page(self, key: MarketStreamKey, **kwargs: Any) -> Any: ...

    def subscribe(
        self,
        keys: list[MarketStreamKey],
        *,
        max_pending: int = 64,
        replay: bool = True,
    ) -> Any: ...

    def diagnostics(self) -> dict[str, Any]: ...


@runtime_checkable
class PublicTradePort(Protocol):
    async def ensure_stream(self, key: MarketStreamKey, *, consumer_id: str) -> bool: ...

    async def release_stream(self, key: MarketStreamKey, *, consumer_id: str) -> bool: ...

    def recent(self, key: MarketStreamKey, **kwargs: Any) -> list[Any]: ...

    async def history(self, key: MarketStreamKey, **kwargs: Any) -> list[Any]: ...

    def attach(self, keys: list[MarketStreamKey], **kwargs: Any) -> Any: ...

    async def archive_coverage(self, key: MarketStreamKey, **kwargs: Any) -> Any: ...

    def diagnostics(self) -> dict[str, Any]: ...


@runtime_checkable
class LiquidationPort(Protocol):
    async def ensure_stream(self, key: MarketStreamKey, *, consumer_id: str) -> bool: ...

    async def release_stream(self, key: MarketStreamKey, *, consumer_id: str) -> bool: ...

    def recent(self, key: MarketStreamKey, **kwargs: Any) -> list[Any]: ...

    async def history(self, key: MarketStreamKey, **kwargs: Any) -> list[Any]: ...

    def attach(self, keys: list[MarketStreamKey], **kwargs: Any) -> Any: ...

    def diagnostics(self) -> dict[str, Any]: ...


@runtime_checkable
class OrderBookPort(Protocol):
    async def ensure_stream(self, key: MarketStreamKey, *, consumer_id: str) -> bool: ...

    async def release_stream(self, key: MarketStreamKey, *, consumer_id: str) -> bool: ...

    def current(self, key: MarketStreamKey, **kwargs: Any) -> Any: ...

    async def wait_for_snapshot(self, key: MarketStreamKey, **kwargs: Any) -> Any: ...

    def attach(self, keys: list[MarketStreamKey], **kwargs: Any) -> Any: ...

    def diagnostics(self) -> dict[str, Any]: ...


@runtime_checkable
class FullOrderBookPort(Protocol):
    async def ensure_stream(self, key: MarketStreamKey, *, consumer_id: str) -> bool: ...

    async def release_stream(self, key: MarketStreamKey, *, consumer_id: str) -> bool: ...

    def current(self, key: MarketStreamKey, **kwargs: Any) -> Any: ...

    async def wait_for_live(self, key: MarketStreamKey, **kwargs: Any) -> Any: ...

    def attach(self, keys: list[MarketStreamKey], **kwargs: Any) -> Any: ...

    def diagnostics(self) -> dict[str, Any]: ...


__all__ = [
    "AdvancedMarketDataPort",
    "FullOrderBookPort",
    "LiquidationPort",
    "OrderBookPort",
    "PublicTradePort",
]
