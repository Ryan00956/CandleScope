"""Logical catalog for CandleScope market-data providers.

The catalog is a control plane.  It records who owns each channel, which
access/storage roles it supports, and how to inspect it.  It deliberately does
not combine unlike data into a common table or promise cross-backend atomicity.
"""

from __future__ import annotations

import threading
from collections import OrderedDict
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from .models import MarketChannel

DiagnosticsProvider = Callable[[], dict[str, Any]]


def _normalized_values(values: tuple[str, ...], *, label: str) -> tuple[str, ...]:
    normalized = tuple(dict.fromkeys(str(value).strip().lower() for value in values))
    if not normalized or any(not value for value in normalized):
        raise ValueError(f"market-data provider {label} must contain non-blank values")
    return normalized


@dataclass(frozen=True, slots=True)
class MarketDataProviderDescriptor:
    """Stable metadata for one channel-specific provider lane."""

    provider_id: str
    channels: tuple[MarketChannel, ...]
    access_modes: tuple[str, ...]
    storage_roles: tuple[str, ...]
    delivery: str
    authority: str

    def __post_init__(self) -> None:
        provider_id = self.provider_id.strip().lower()
        if not provider_id:
            raise ValueError("market-data provider id cannot be blank")
        object.__setattr__(self, "provider_id", provider_id)

        channels = tuple(dict.fromkeys(MarketChannel(channel) for channel in self.channels))
        if not channels:
            raise ValueError("market-data provider must own at least one channel")
        object.__setattr__(self, "channels", channels)
        object.__setattr__(
            self,
            "access_modes",
            _normalized_values(self.access_modes, label="access modes"),
        )
        object.__setattr__(
            self,
            "storage_roles",
            _normalized_values(self.storage_roles, label="storage roles"),
        )

        delivery = self.delivery.strip().lower()
        authority = self.authority.strip().lower()
        if not delivery or not authority:
            raise ValueError("market-data provider delivery and authority cannot be blank")
        object.__setattr__(self, "delivery", delivery)
        object.__setattr__(self, "authority", authority)

    def to_dict(self) -> dict[str, Any]:
        return {
            "provider_id": self.provider_id,
            "channels": [channel.value for channel in self.channels],
            "access_modes": list(self.access_modes),
            "storage_roles": list(self.storage_roles),
            "delivery": self.delivery,
            "authority": self.authority,
        }


@dataclass(frozen=True, slots=True)
class _ProviderRegistration:
    descriptor: MarketDataProviderDescriptor
    diagnostics: DiagnosticsProvider | None


class MarketDataCatalog:
    """Thread-safe registry and diagnostic view of market-data providers."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._providers: OrderedDict[str, _ProviderRegistration] = OrderedDict()

    def register(
        self,
        descriptor: MarketDataProviderDescriptor,
        *,
        diagnostics: DiagnosticsProvider | None = None,
        replace: bool = False,
    ) -> None:
        with self._lock:
            existing = self._providers.get(descriptor.provider_id)
            if existing is not None and not replace:
                raise ValueError(
                    f"market-data provider already registered: {descriptor.provider_id}",
                )

            claimed = {
                channel: registration.descriptor.provider_id
                for registration in self._providers.values()
                if registration.descriptor.provider_id != descriptor.provider_id
                for channel in registration.descriptor.channels
            }
            conflict = next(
                (channel for channel in descriptor.channels if channel in claimed),
                None,
            )
            if conflict is not None:
                raise ValueError(
                    "market-data channel already owned by "
                    f"{claimed[conflict]}: {conflict.value}",
                )
            self._providers[descriptor.provider_id] = _ProviderRegistration(
                descriptor=descriptor,
                diagnostics=diagnostics,
            )

    def snapshot(
        self,
        *,
        diagnostics_by_provider: Mapping[str, dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        overrides = diagnostics_by_provider or {}
        with self._lock:
            registrations = tuple(self._providers.values())

        providers: list[dict[str, Any]] = []
        channel_owners: dict[str, str] = {}
        degraded = False
        for registration in registrations:
            descriptor = registration.descriptor
            diagnostic: dict[str, Any] | None
            diagnostic_error: str | None = None
            if descriptor.provider_id in overrides:
                diagnostic = dict(overrides[descriptor.provider_id])
            elif registration.diagnostics is None:
                diagnostic = None
            else:
                try:
                    diagnostic = dict(registration.diagnostics())
                except Exception as exc:  # diagnostics must not break the control plane
                    diagnostic = None
                    diagnostic_error = f"{type(exc).__name__}: {exc}"
                    degraded = True

            item = descriptor.to_dict()
            item["diagnostics"] = diagnostic
            item["diagnostic_error"] = diagnostic_error
            providers.append(item)
            for channel in descriptor.channels:
                channel_owners[channel.value] = descriptor.provider_id

        return {
            "schema": "candlescope.market-data-catalog/1",
            "provider_count": len(providers),
            "channel_count": len(channel_owners),
            "degraded": degraded,
            "channel_owners": channel_owners,
            "providers": providers,
        }


__all__ = ["MarketDataCatalog", "MarketDataProviderDescriptor"]
