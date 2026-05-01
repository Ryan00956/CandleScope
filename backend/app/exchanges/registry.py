from __future__ import annotations

from typing import Iterable

from .base import ExchangeAdapter
from .plugin import BuiltinExchangePlugin, ExchangePlugin


class ExchangeRegistry:
    """Simple in-process registry for exchange plugins.

    The old adapter-centric API is kept for compatibility while callers move
    toward the plugin entry points.
    """

    def __init__(self) -> None:
        self._plugins: dict[str, ExchangePlugin] = {}

    def register(self, plugin_or_adapter: ExchangePlugin | ExchangeAdapter) -> None:
        plugin = self._coerce_plugin(plugin_or_adapter)
        self._plugins[plugin.id] = plugin

    def has(self, exchange: str) -> bool:
        return exchange.strip().lower() in self._plugins

    def get(self, exchange: str) -> ExchangeAdapter:
        return self.get_plugin(exchange).adapter()

    def get_plugin(self, exchange: str) -> ExchangePlugin:
        key = exchange.strip().lower()
        if key not in self._plugins:
            raise KeyError(f"Unknown exchange: {exchange}")
        return self._plugins[key]

    def list(self) -> list[ExchangeAdapter]:
        return [plugin.adapter() for plugin in self.list_plugins()]

    def list_plugins(self) -> list[ExchangePlugin]:
        return sorted(self._plugins.values(), key=lambda plugin: plugin.id)

    def items(self) -> Iterable[tuple[str, ExchangeAdapter]]:
        return ((plugin.id, plugin.adapter()) for plugin in self.list_plugins())

    def plugin_items(self) -> Iterable[tuple[str, ExchangePlugin]]:
        return ((plugin.id, plugin) for plugin in self.list_plugins())

    @staticmethod
    def _coerce_plugin(plugin_or_adapter: ExchangePlugin | ExchangeAdapter) -> ExchangePlugin:
        adapter_method = getattr(plugin_or_adapter, "adapter", None)
        if callable(adapter_method):
            return plugin_or_adapter  # type: ignore[return-value]

        adapter = plugin_or_adapter  # type: ignore[assignment]
        return BuiltinExchangePlugin(adapter)


_registry = ExchangeRegistry()


def get_exchange_registry() -> ExchangeRegistry:
    return _registry


def bootstrap_default_adapters() -> ExchangeRegistry:
    if not _registry.has("binance"):
        from .plugins.binance import create_plugin

        _registry.register(create_plugin())
    if not _registry.has("okx"):
        from .plugins.okx import create_plugin

        _registry.register(create_plugin())
    return _registry
