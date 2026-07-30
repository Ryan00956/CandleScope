"""Capability Broker bindings for Phase 9 integration services."""

from __future__ import annotations

import asyncio
from typing import Any

from candlescope_plugin_sdk.platform_v2 import HostCallRequest

from app.plugin_security_v2.capabilities import (
    CapabilityBroker,
    CapabilityLease,
    CapabilityMethodPolicy,
)

from .files import UserSelectedFileBroker
from .network import HostHttpGateway, network_required_scope


class IntegrationCapabilityAdapters:
    def __init__(
        self,
        *,
        network: HostHttpGateway,
        files: UserSelectedFileBroker,
    ) -> None:
        self.network = network
        self.files = files

    def register(self, broker: CapabilityBroker) -> None:
        broker.register(
            CapabilityMethodPolicy(
                "network.http.request",
                "network.connect",
                handler_with_lease=self.network.request,
                scope_extractor=network_required_scope,
                max_calls_per_minute=10_000,
                max_calls_per_activation=100_000,
            )
        )
        broker.register(
            CapabilityMethodPolicy(
                "filesystem.user-selected.read",
                "filesystem.open-user-selected",
                handler_with_lease=self._read,
                require_user_action=True,
                max_calls_per_minute=600,
                max_calls_per_activation=10_000,
            )
        )
        broker.register(
            CapabilityMethodPolicy(
                "filesystem.user-selected.write",
                "filesystem.save-user-selected",
                handler_with_lease=self._write,
                require_user_action=True,
                max_calls_per_minute=600,
                max_calls_per_activation=10_000,
            )
        )

    async def _read(
        self, call: HostCallRequest, lease: CapabilityLease
    ) -> dict[str, Any]:
        return await asyncio.to_thread(self.files.read, call, lease)

    async def _write(
        self, call: HostCallRequest, lease: CapabilityLease
    ) -> dict[str, Any]:
        return await asyncio.to_thread(self.files.write, call, lease)
