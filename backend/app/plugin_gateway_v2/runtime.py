"""Composition root for Phase 9 network, file, and endpoint gateways."""

from __future__ import annotations

from pathlib import Path

from app.plugin_security_v2.audit import AuditLog
from app.plugin_security_v2.capabilities import (
    CapabilityBroker,
    CapabilityHandleAuthority,
    CapabilityLease,
)

from .adapters import IntegrationCapabilityAdapters
from .endpoints import EndpointInvoker, PluginHttpEndpointGateway
from .files import UserSelectedFileBroker
from .network import HostHttpGateway, HttpTransport, Resolver


class PluginIntegrationGateway:
    def __init__(
        self,
        *,
        root: Path,
        audit_log: AuditLog,
        broker: CapabilityBroker,
        authority: CapabilityHandleAuthority,
        invoke: EndpointInvoker,
        network_resolver: Resolver | None = None,
        network_transport: HttpTransport | None = None,
    ) -> None:
        network_kwargs = {}
        if network_resolver is not None:
            network_kwargs["resolver"] = network_resolver
        if network_transport is not None:
            network_kwargs["transport"] = network_transport
        self.network = HostHttpGateway(audit_log, **network_kwargs)
        self.files = UserSelectedFileBroker(root / "file-gateway-v1", audit_log)
        self.endpoints = PluginHttpEndpointGateway(audit_log, invoke)
        self.adapters = IntegrationCapabilityAdapters(
            network=self.network, files=self.files
        )
        self.adapters.register(broker)
        self.authority = authority
        self.authority.add_revocation_listener(self._on_revocation)

    def _on_revocation(self, leases: tuple[CapabilityLease, ...], reason: str) -> None:
        self.network.revoke_leases(leases, reason)
        self.files.revoke_leases(leases, reason)

    async def clear_plugin(self, plugin_id: str) -> None:
        await self.endpoints.clear_plugin(plugin_id)
        self.files.revoke_plugin(plugin_id)

    async def stop(self) -> None:
        await self.endpoints.close()
        self.network.close()
        self.files.close()

    def diagnostics(self) -> dict[str, dict[str, int]]:
        return {
            "network": self.network.snapshot(),
            "files": self.files.snapshot(),
            "endpoints": self.endpoints.snapshot(),
        }

    def sweep(self) -> None:
        self.files.sweep()

    async def close(self) -> None:
        self.authority.remove_revocation_listener(self._on_revocation)
        await self.stop()
