"""Phase 6 market-data and chart-layer product service."""

from __future__ import annotations

import asyncio
from typing import Any, Callable

from app.plugin_security_v2 import CapabilityBroker, CapabilityHandleAuthority
from app.plugin_security_v2.capabilities import CapabilityLease

from .adapters import MarketCapabilityAdapters
from .chart_layers import ChartLayerRegistry
from .ports import MarketDataConsumerPort
from .subscriptions import BarSubscriptionManager, MarketBatchDelivery


class PluginMarketRuntime:
    def __init__(
        self,
        *,
        broker: CapabilityBroker,
        authority: CapabilityHandleAuthority,
        resolve_contribution: Callable[[str, str, str], Any],
        deliver: MarketBatchDelivery,
    ) -> None:
        self.chart_layers = ChartLayerRegistry(resolve_contribution)
        self.subscriptions = BarSubscriptionManager(deliver=deliver)
        self.adapters = MarketCapabilityAdapters(
            subscriptions=self.subscriptions,
            chart_layers=self.chart_layers,
        )
        self.adapters.register(broker)
        self._authority = authority
        self._authority.add_revocation_listener(self._on_revoked)
        self._loop: asyncio.AbstractEventLoop | None = None
        self._cleanup_tasks: set[asyncio.Task[None]] = set()

    def bind(self, port: MarketDataConsumerPort) -> None:
        self.adapters.bind(port)

    def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        self.adapters.start()
        self.subscriptions.start()
        self.chart_layers.start()

    def _on_revoked(self, leases: tuple[CapabilityLease, ...], reason: str) -> None:
        loop = self._loop
        if loop is None or loop.is_closed():
            self.chart_layers.clear_leases(leases)
            return

        def schedule() -> None:
            self.chart_layers.clear_leases(leases)
            task = asyncio.create_task(
                self.subscriptions.cancel_leases(leases, reason=reason),
                name="plugin-market-revocation-cleanup",
            )
            self._cleanup_tasks.add(task)
            task.add_done_callback(self._cleanup_tasks.discard)

        loop.call_soon_threadsafe(schedule)

    async def clear_plugin(self, plugin_id: str, *, reason: str) -> None:
        await self.subscriptions.cancel_plugin(plugin_id, reason=reason)
        self.chart_layers.clear_plugin(plugin_id)

    async def stop(self) -> None:
        self.adapters.stop()
        self.chart_layers.stop()
        await self.subscriptions.stop()
        if self._cleanup_tasks:
            await asyncio.gather(*tuple(self._cleanup_tasks), return_exceptions=True)
        for layer in tuple(self.chart_layers.snapshot()["layers"]):
            self.chart_layers.clear_plugin(layer["pluginId"])
        self._loop = None

    def diagnostics(self) -> dict[str, Any]:
        return {
            "adapters": self.adapters.snapshot(),
            "subscriptions": self.subscriptions.snapshot(),
            "chartLayers": self.chart_layers.snapshot(),
        }


__all__ = ["PluginMarketRuntime"]
