from __future__ import annotations

from typing import Iterable

from .base import ExchangeAdapter


class ExchangeRegistry:
    """Simple in-process registry for exchange adapters."""

    def __init__(self) -> None:
        self._adapters: dict[str, ExchangeAdapter] = {}

    def register(self, adapter: ExchangeAdapter) -> None:
        self._adapters[adapter.id] = adapter

    def has(self, exchange: str) -> bool:
        return exchange.strip().lower() in self._adapters

    def get(self, exchange: str) -> ExchangeAdapter:
        key = exchange.strip().lower()
        if key not in self._adapters:
            raise KeyError(f"Unknown exchange: {exchange}")
        return self._adapters[key]

    def list(self) -> list[ExchangeAdapter]:
        return sorted(self._adapters.values(), key=lambda adapter: adapter.id)

    def items(self) -> Iterable[tuple[str, ExchangeAdapter]]:
        return self._adapters.items()


_registry = ExchangeRegistry()


def get_exchange_registry() -> ExchangeRegistry:
    return _registry


def bootstrap_default_adapters() -> ExchangeRegistry:
    if not _registry.has("binance"):
        from .binance import BinanceExchangeAdapter

        _registry.register(BinanceExchangeAdapter())
    if not _registry.has("okx"):
        from .okx import OkxExchangeAdapter

        _registry.register(OkxExchangeAdapter())
    return _registry
