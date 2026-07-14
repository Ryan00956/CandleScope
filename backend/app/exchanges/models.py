from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.data_engine.market_data.models import (
    DeliveryClass,
    MarketChannel,
    TransportMode,
)


@dataclass(slots=True)
class ExchangeMarket:
    """A market family exposed by an exchange adapter."""

    market_type: str
    product_type: str
    label: str
    contract_family: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "market_type": self.market_type,
            "product_type": self.product_type,
            "label": self.label,
            "contract_family": self.contract_family,
        }


@dataclass(slots=True)
class MarketChannelCapability:
    """Runtime support for one canonical market-data channel.

    This describes what the installed plugin can actually deliver, rather
    than every endpoint the upstream exchange may advertise.  A single entry
    may cover multiple market families when their transport and payload
    semantics are identical.
    """

    channel: MarketChannel
    market_types: tuple[str, ...]
    realtime: bool = False
    history: bool = False
    realtime_transports: tuple[TransportMode, ...] = ()
    history_transports: tuple[TransportMode, ...] = ()
    delivery: DeliveryClass = DeliveryClass.LATEST
    snapshot: bool = False
    delta: bool = False
    sequence: str = "none"
    checksum: bool = False
    resync: str = "none"
    params: dict[str, Any] = field(default_factory=dict)
    update_intervals_ms: tuple[int, ...] = ()
    available_fields: tuple[str, ...] = ()
    unavailable_fields: tuple[str, ...] = ()
    connection_model: str | None = None
    limits: dict[str, Any] = field(default_factory=dict)
    known_limitations: tuple[str, ...] = ()
    # Keep additive capability metadata last for positional v2 constructors.
    derived_fields: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if not isinstance(self.channel, MarketChannel):
            self.channel = MarketChannel(str(self.channel).strip().lower())
        self.market_types = _unique_strings(self.market_types, lower=True)
        self.realtime_transports = tuple(
            item
            if isinstance(item, TransportMode)
            else TransportMode(str(item).strip().lower())
            for item in self.realtime_transports
        )
        self.history_transports = tuple(
            item
            if isinstance(item, TransportMode)
            else TransportMode(str(item).strip().lower())
            for item in self.history_transports
        )
        if not isinstance(self.delivery, DeliveryClass):
            self.delivery = DeliveryClass(str(self.delivery).strip().lower())
        self.sequence = str(self.sequence or "none").strip().lower()
        self.resync = str(self.resync or "none").strip().lower()
        self.params = dict(self.params)
        self.update_intervals_ms = tuple(self.update_intervals_ms)
        self.available_fields = _unique_strings(self.available_fields)
        self.unavailable_fields = _unique_strings(self.unavailable_fields)
        self.derived_fields = _unique_strings(self.derived_fields)
        if self.connection_model is not None:
            self.connection_model = str(self.connection_model).strip().lower() or None
        self.limits = dict(self.limits)
        self.known_limitations = _unique_strings(self.known_limitations)

    def supports_market(self, market_type: str) -> bool:
        return str(market_type or "").strip().lower() in self.market_types

    def supports_transport(
        self,
        transport: TransportMode | str,
        *,
        history: bool = False,
    ) -> bool:
        mode = (
            transport
            if isinstance(transport, TransportMode)
            else TransportMode(str(transport).strip().lower())
        )
        transports = self.history_transports if history else self.realtime_transports
        return mode in transports

    def to_dict(self) -> dict[str, Any]:
        return {
            "channel": self.channel.value,
            "market_types": list(self.market_types),
            "realtime": self.realtime,
            "history": self.history,
            "realtime_transports": [item.value for item in self.realtime_transports],
            "history_transports": [item.value for item in self.history_transports],
            "delivery": self.delivery.value,
            "snapshot": self.snapshot,
            "delta": self.delta,
            "sequence": self.sequence,
            "checksum": self.checksum,
            "resync": self.resync,
            "params": dict(self.params),
            "update_intervals_ms": list(self.update_intervals_ms),
            "available_fields": list(self.available_fields),
            "unavailable_fields": list(self.unavailable_fields),
            "derived_fields": list(self.derived_fields),
            "connection_model": self.connection_model,
            "limits": dict(self.limits),
            "known_limitations": list(self.known_limitations),
        }


@dataclass(slots=True)
class ExchangeCapabilities:
    """Static capabilities advertised by an exchange adapter."""

    exchange: str
    name: str
    plugin_api_version: str = "1.0"
    capability_schema_version: int = 1
    markets: list[ExchangeMarket] = field(default_factory=list)
    native_intervals: list[str] = field(default_factory=list)
    supports_multi_symbol_ticker: bool = False
    supports_symbol_search: bool = True
    ws_connection_model: str = "path_per_stream"
    protocol_features: list[str] = field(default_factory=list)
    limits: dict[str, Any] = field(default_factory=dict)
    known_limitations: list[str] = field(default_factory=list)
    # Keep this v2 addition last so v1 plugins using positional construction
    # retain the exact field order they were compiled against.
    channels: list[MarketChannelCapability] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "exchange": self.exchange,
            "name": self.name,
            "plugin_api_version": self.plugin_api_version,
            "capability_schema_version": self.capability_schema_version,
            "markets": [market.to_dict() for market in self.markets],
            "channels": [channel.to_dict() for channel in self.channels],
            "native_intervals": list(self.native_intervals),
            "supports_multi_symbol_ticker": self.supports_multi_symbol_ticker,
            "supports_symbol_search": self.supports_symbol_search,
            "ws_connection_model": self.ws_connection_model,
            "protocol_features": list(self.protocol_features),
            "limits": dict(self.limits),
            "known_limitations": list(self.known_limitations),
        }

    def channel_capability(
        self,
        channel: MarketChannel | str,
        market_type: str,
    ) -> MarketChannelCapability | None:
        canonical_channel = (
            channel
            if isinstance(channel, MarketChannel)
            else MarketChannel(str(channel).strip().lower())
        )
        for item in self.channels:
            if item.channel == canonical_channel and item.supports_market(market_type):
                return item
        return None

    def supports_channel(
        self,
        channel: MarketChannel | str,
        market_type: str,
        *,
        transport: TransportMode | str | None = None,
        history: bool = False,
    ) -> bool:
        capability = self.channel_capability(channel, market_type)
        if capability is None:
            return False
        if history and not capability.history:
            return False
        if not history and not capability.realtime:
            return False
        if transport is None:
            return True
        return capability.supports_transport(transport, history=history)


def serialize_exchange_capabilities(capabilities: Any) -> dict[str, Any]:
    """Serialize both current capability objects and legacy schema-v1 objects.

    Some external plugins own a v1 capability class whose ``to_dict`` method
    predates ``channels``.  The API still emits a stable additive shape for
    those plugins; callers use ``capability_schema_version`` to distinguish an
    unknown v1 channel matrix from an authoritative v2 matrix.
    """

    to_dict = getattr(capabilities, "to_dict", None)
    if not callable(to_dict):
        raise TypeError("exchange capabilities must provide to_dict()")
    payload = dict(to_dict())
    payload.setdefault(
        "plugin_api_version",
        getattr(capabilities, "plugin_api_version", "1.0"),
    )
    payload.setdefault(
        "capability_schema_version",
        getattr(capabilities, "capability_schema_version", 1),
    )
    if "channels" not in payload:
        payload["channels"] = [
            channel.to_dict()
            for channel in (getattr(capabilities, "channels", ()) or ())
        ]
    return payload


@dataclass(slots=True)
class SymbolInfo:
    """Canonical symbol metadata used by the frontend and registry cache."""

    symbol: str
    base_asset: str
    quote_asset: str
    status: str
    exchange: str
    market_type: str
    product_type: str
    contract_type: str = ""
    raw: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        data = {
            "symbol": self.symbol,
            "baseAsset": self.base_asset,
            "quoteAsset": self.quote_asset,
            "status": self.status,
            "exchange": self.exchange,
            "marketType": self.market_type,
            "productType": self.product_type,
        }
        if self.contract_type:
            data["contractType"] = self.contract_type
        return data


def _unique_strings(values: Any, *, lower: bool = False) -> tuple[str, ...]:
    if isinstance(values, (str, bytes, dict)):
        raise TypeError("string collections must be an iterable of strings")
    normalized: list[str] = []
    for value in values or ():
        if not isinstance(value, str):
            raise TypeError("string collections must contain only strings")
        item = value.strip()
        if lower:
            item = item.lower()
        if item and item not in normalized:
            normalized.append(item)
    return tuple(normalized)
