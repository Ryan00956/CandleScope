"""Capability-routed facade for strict TradeFlow and observational trade tape."""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from .models import MarketChannel, MarketStreamKey
from .trade_flow_service import TradeFlowService
from .trade_tape_service import TradeTapeService


class PublicTradeService:
    """Preserve strict aggTrade semantics while adding an explicit fallback."""

    def __init__(self, strict: TradeFlowService, observational: TradeTapeService) -> None:
        self.strict = strict
        self.observational = observational

    async def ensure_stream(self, key: MarketStreamKey, *, consumer_id: str) -> bool:
        return await self._service(key).ensure_stream(key, consumer_id=consumer_id)

    async def release_stream(self, key: MarketStreamKey, *, consumer_id: str) -> bool:
        return await self._service(key).release_stream(key, consumer_id=consumer_id)

    def recent(self, key: MarketStreamKey, **kwargs: Any) -> list[Any]:
        return self._service(key).recent(key, **kwargs)

    async def history(self, key: MarketStreamKey, **kwargs: Any) -> list[Any]:
        if key.channel is MarketChannel.TRADE:
            raise ValueError("observational trade tape does not provide repairable history")
        return await self.strict.history(key, **kwargs)

    def attach(
        self,
        keys: MarketStreamKey | Iterable[MarketStreamKey],
        **kwargs: Any,
    ) -> Any:
        requested = [keys] if isinstance(keys, MarketStreamKey) else list(keys)
        if not requested:
            raise ValueError("public trade attachment requires at least one key")
        channels = {key.channel for key in requested}
        if len(channels) != 1:
            raise ValueError("strict and observational trade streams require separate sockets")
        return self._service(requested[0]).attach(requested, **kwargs)

    async def archive_coverage(self, key: MarketStreamKey, **kwargs: Any) -> Any:
        if key.channel is MarketChannel.TRADE:
            raise ValueError("observational trade tape has no raw archive coverage contract")
        return await self.strict.archive_coverage(key, **kwargs)

    def diagnostics(self) -> dict[str, Any]:
        return {
            "strict": self.strict.diagnostics(),
            "observational": self.observational.diagnostics(),
        }

    async def shutdown(self) -> None:
        await self.observational.shutdown()
        await self.strict.shutdown()

    def _service(self, key: MarketStreamKey) -> Any:
        if not isinstance(key, MarketStreamKey):
            raise TypeError("public trade key must be a MarketStreamKey")
        if key.channel is MarketChannel.AGG_TRADE:
            return self.strict
        if key.channel is MarketChannel.TRADE:
            return self.observational
        raise ValueError("public trade service only accepts agg_trade or trade keys")


__all__ = ["PublicTradeService"]
