from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from enum import Enum
from typing import Any

from app.data_engine.market_data.models import (
    DeliveryClass,
    MarketChannel,
    TransportMode,
)
from app.data_engine.series_identity import (
    DEFAULT_ASSET_CLASS,
    DEFAULT_PRICE_ADJUSTMENT,
    DEFAULT_SERIES_VARIANT,
    DEFAULT_SESSION_VARIANT,
    DEFAULT_VOLUME_SEMANTICS,
    KlineSeriesIdentity,
)


CRYPTO_24X7_CALENDAR_ID = "crypto.24x7.utc"


class HistoryCadence(str, Enum):
    """How a historical channel is expected to produce observations."""

    UNKNOWN = "unknown"
    REGULAR = "regular"
    SCHEDULED = "scheduled"
    EVENT_DRIVEN = "event_driven"


class HistoryEmptyPageSemantics(str, Enum):
    """What a successful empty upstream history page proves.

    ``AUTHORITATIVE_RANGE_EMPTY`` only proves that the requested range has no
    rows.  It deliberately does not turn one empty response into a permanent
    series boundary. ``TERMINAL_EXHAUSTION`` is reserved for protocols that
    explicitly return a terminal/exhausted signal.
    """

    UNKNOWN = "unknown"
    AUTHORITATIVE_RANGE_EMPTY = "authoritative_range_empty"
    TERMINAL_EXHAUSTION = "terminal_exhaustion"


@dataclass(slots=True)
class HistoryAvailabilityPolicy:
    """Typed static availability contract for one historical channel.

    The old dotted ``limits`` keys remain public for schema-v1/v2 consumers.
    This object is the canonical schema-v3 representation used by history
    planners, while missing values may still be populated from those legacy
    keys for a lossless migration.
    """

    cadence: HistoryCadence = HistoryCadence.UNKNOWN
    empty_page_semantics: HistoryEmptyPageSemantics = (
        HistoryEmptyPageSemantics.UNKNOWN
    )
    calendar_id: str | None = None
    timezone: str | None = None
    max_age_ms: int | None = None
    max_window_ms: int | None = None
    max_page_size: int | None = None
    available_from_ms: int | None = None
    available_to_ms: int | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.cadence, HistoryCadence):
            self.cadence = HistoryCadence(str(self.cadence).strip().lower())
        if not isinstance(self.empty_page_semantics, HistoryEmptyPageSemantics):
            self.empty_page_semantics = HistoryEmptyPageSemantics(
                str(self.empty_page_semantics).strip().lower(),
            )
        if self.calendar_id is not None:
            self.calendar_id = str(self.calendar_id).strip() or None
        if self.timezone is not None:
            self.timezone = str(self.timezone).strip() or None
        for field_name in (
            "max_age_ms",
            "max_window_ms",
            "max_page_size",
            "available_from_ms",
            "available_to_ms",
        ):
            value = getattr(self, field_name)
            if value is None:
                continue
            if isinstance(value, bool) or not isinstance(value, int):
                raise TypeError(f"{field_name} must be a non-boolean integer or None")
            if value < 0 or (field_name.startswith("max_") and value == 0):
                raise ValueError(f"{field_name} must be positive or None")
        if (
            self.available_from_ms is not None
            and self.available_to_ms is not None
            and self.available_from_ms > self.available_to_ms
        ):
            raise ValueError("available_from_ms must not exceed available_to_ms")

    def apply_legacy_limits(self, limits: dict[str, Any]) -> None:
        """Fill unspecified typed values from schema-v1/v2 dotted limits."""

        legacy_values = {
            "max_age_ms": limits.get("history.max_age_ms"),
            "max_window_ms": limits.get("history.max_window_ms"),
            "max_page_size": limits.get(
                "history.max_limit",
                limits.get("rest.max_limit"),
            ),
        }
        for field_name, value in legacy_values.items():
            # Schema-v1/v2 ``limits`` was intentionally untyped. Preserve
            # plugin compatibility by migrating only values that already
            # satisfy the schema-v3 positive-integer contract.
            if (
                getattr(self, field_name) is None
                and isinstance(value, int)
                and not isinstance(value, bool)
                and value > 0
            ):
                setattr(self, field_name, value)
        # Validate values copied from plugin-owned legacy dictionaries.
        self.__post_init__()

    def to_dict(self) -> dict[str, Any]:
        return {
            "cadence": self.cadence.value,
            "empty_page_semantics": self.empty_page_semantics.value,
            "calendar_id": self.calendar_id,
            "timezone": self.timezone,
            "max_age_ms": self.max_age_ms,
            "max_window_ms": self.max_window_ms,
            "max_page_size": self.max_page_size,
            "available_from_ms": self.available_from_ms,
            "available_to_ms": self.available_to_ms,
        }


@dataclass(slots=True)
class ExchangeMarket:
    """A market family exposed by an exchange adapter."""

    market_type: str
    product_type: str
    label: str
    contract_family: str | None = None
    calendar_id: str | None = None
    timezone: str | None = None

    def __post_init__(self) -> None:
        if self.calendar_id is not None:
            self.calendar_id = str(self.calendar_id).strip() or None
        if self.timezone is not None:
            self.timezone = str(self.timezone).strip() or None

    def to_dict(self) -> dict[str, Any]:
        return {
            "market_type": self.market_type,
            "product_type": self.product_type,
            "label": self.label,
            "contract_family": self.contract_family,
            "calendar_id": self.calendar_id,
            "timezone": self.timezone,
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
    # Kept in its original positional-v2 slot for source compatibility.
    derived_fields: tuple[str, ...] = ()
    # Schema-v3 addition. Kept last so v1/v2 positional construction remains
    # source compatible.
    history_policy: HistoryAvailabilityPolicy | None = None

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
        if isinstance(self.history_policy, dict):
            self.history_policy = HistoryAvailabilityPolicy(**self.history_policy)
        elif self.history_policy is not None and not isinstance(
            self.history_policy,
            HistoryAvailabilityPolicy,
        ):
            raise TypeError(
                "history_policy must be HistoryAvailabilityPolicy, dict, or None",
            )
        if self.history:
            if self.history_policy is None:
                self.history_policy = HistoryAvailabilityPolicy()
            self.history_policy.apply_legacy_limits(self.limits)

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
            "history_policy": (
                self.history_policy.to_dict()
                if self.history_policy is not None
                else None
            ),
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

    def kline_intervals(
        self,
        market_type: str,
        *,
        history: bool = False,
    ) -> tuple[str, ...]:
        """Return purpose-aware native K-line intervals for one market.

        Capability schema v2+ declares interval support on the concrete
        K-line channel.  The exchange-wide ``native_intervals`` list is only a
        compatibility fallback for schema-v1 documents that predate channel
        capabilities.  This keeps callers from accidentally treating a
        top-level superset (for example Binance spot ``1s``) as supported by a
        narrower market/purpose channel.
        """
        capability = self.channel_capability(MarketChannel.KLINE, market_type)
        if capability is None:
            if self.capability_schema_version <= 1:
                return _unique_strings(self.native_intervals)
            return ()
        if history and not capability.history:
            return ()
        if not history and not capability.realtime:
            return ()

        declared = capability.params.get("interval")
        if isinstance(declared, str):
            values = (declared,)
        elif isinstance(declared, (list, tuple)):
            values = tuple(declared)
        else:
            values = ()
        return _unique_strings(values)

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
    listed_at_ms: int | None = None
    continuous_trading_at_ms: int | None = None
    delisted_at_ms: int | None = None
    expiry_at_ms: int | None = None
    price_tick_size: str = ""
    display_name: str = ""
    currency: str = ""
    provider_id: str = ""
    provider_instrument_id: str = ""
    venue: str = ""
    venue_mic: str = ""
    asset_class: str = DEFAULT_ASSET_CLASS
    series_variant: str = DEFAULT_SERIES_VARIANT
    price_adjustment: str = DEFAULT_PRICE_ADJUSTMENT
    session_variant: str = DEFAULT_SESSION_VARIANT
    volume_semantics: str = DEFAULT_VOLUME_SEMANTICS
    contract_multiplier: str = ""
    underlying_symbol: str = ""
    option_strike: str = ""
    option_right: str = ""
    entitlement: str = "unknown"
    delay_seconds: int | None = None
    redistribution: str = "unknown"

    def __post_init__(self) -> None:
        for field_name in (
            "listed_at_ms",
            "continuous_trading_at_ms",
            "delisted_at_ms",
            "expiry_at_ms",
        ):
            value = getattr(self, field_name)
            if value is None:
                continue
            if isinstance(value, bool) or not isinstance(value, int):
                raise TypeError(f"{field_name} must be a non-boolean integer or None")
            if value < 0:
                raise ValueError(f"{field_name} must be non-negative or None")
        tick_size = str(self.price_tick_size or "").strip()
        if tick_size:
            try:
                parsed_tick_size = Decimal(tick_size)
            except InvalidOperation as exc:
                raise ValueError("price_tick_size must be a positive decimal string") from exc
            if not parsed_tick_size.is_finite() or parsed_tick_size <= 0:
                raise ValueError("price_tick_size must be a positive decimal string")
        self.price_tick_size = tick_size
        identity = KlineSeriesIdentity.for_exchange(
            self.exchange,
            provider_id=self.provider_id or None,
            venue=self.venue or self.venue_mic or None,
            asset_class=self.asset_class,
            series_variant=self.series_variant,
            price_adjustment=self.price_adjustment,
            session_variant=self.session_variant,
            volume_semantics=self.volume_semantics,
        )
        for field_name, value in identity.to_dict().items():
            setattr(self, field_name, value)
        self.display_name = str(self.display_name or "").strip()
        self.currency = str(self.currency or "").strip().upper()
        self.provider_instrument_id = str(
            self.provider_instrument_id or ""
        ).strip()
        self.venue_mic = str(self.venue_mic or "").strip().upper()
        self.underlying_symbol = str(self.underlying_symbol or "").strip().upper()
        self.option_right = str(self.option_right or "").strip().lower()
        if self.option_right not in {"", "call", "put"}:
            raise ValueError("option_right must be call, put, or empty")
        for field_name, allow_zero in (
            ("contract_multiplier", False),
            ("option_strike", True),
        ):
            text = str(getattr(self, field_name) or "").strip()
            if text:
                try:
                    parsed = Decimal(text)
                except InvalidOperation as exc:
                    raise ValueError(
                        f"{field_name} must be a decimal string"
                    ) from exc
                if not parsed.is_finite() or parsed < 0 or (parsed == 0 and not allow_zero):
                    raise ValueError(f"{field_name} must be a valid decimal string")
            setattr(self, field_name, text)
        if self.delay_seconds is not None:
            if isinstance(self.delay_seconds, bool) or not isinstance(
                self.delay_seconds,
                int,
            ):
                raise TypeError("delay_seconds must be a non-boolean integer or None")
            if self.delay_seconds < 0:
                raise ValueError("delay_seconds must be non-negative or None")
        self.entitlement = str(self.entitlement or "unknown").strip().lower()
        self.redistribution = str(self.redistribution or "unknown").strip().lower()

    def to_dict(self) -> dict[str, Any]:
        identity = KlineSeriesIdentity(
            provider_id=self.provider_id,
            venue=self.venue,
            asset_class=self.asset_class,
            series_variant=self.series_variant,
            price_adjustment=self.price_adjustment,
            session_variant=self.session_variant,
            volume_semantics=self.volume_semantics,
        )
        data = {
            "symbol": self.symbol,
            "baseAsset": self.base_asset,
            "quoteAsset": self.quote_asset,
            "status": self.status,
            "exchange": self.exchange,
            "marketType": self.market_type,
            "productType": self.product_type,
            "listedAtMs": self.listed_at_ms,
            "continuousTradingAtMs": self.continuous_trading_at_ms,
            "delistedAtMs": self.delisted_at_ms,
            "expiryAtMs": self.expiry_at_ms,
            "displayName": self.display_name,
            "currency": self.currency,
            **identity.to_camel_dict(),
            "providerInstrumentId": self.provider_instrument_id,
            "venueMic": self.venue_mic,
            "contractMultiplier": self.contract_multiplier,
            "underlyingSymbol": self.underlying_symbol,
            "optionStrike": self.option_strike,
            "optionRight": self.option_right,
            "entitlement": self.entitlement,
            "delaySeconds": self.delay_seconds,
            "redistribution": self.redistribution,
        }
        if self.contract_type:
            data["contractType"] = self.contract_type
        if self.price_tick_size:
            data["priceTickSize"] = self.price_tick_size
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
