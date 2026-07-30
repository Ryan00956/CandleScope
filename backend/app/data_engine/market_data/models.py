"""Canonical identities and delivery policies for market-data streams.

These types deliberately do not depend on exchange adapters or the existing
bar pipeline.  They form the stable vocabulary shared by capability metadata,
stream lifecycle management, and future market-event delivery code.
"""

from __future__ import annotations

import enum
import math
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any, TypeAlias
from urllib.parse import urlencode


class MarketChannel(str, enum.Enum):
    """Canonical exchange-agnostic market-data channels."""

    KLINE = "kline"
    AGG_TRADE = "agg_trade"
    TRADE = "trade"
    TICKER = "ticker"
    MINI_TICKER = "mini_ticker"
    DEPTH = "depth"
    FULL_DEPTH = "full_depth"
    MARK_PRICE = "mark_price"
    INDEX_PRICE = "index_price"
    FUNDING_RATE = "funding_rate"
    OPEN_INTEREST = "open_interest"
    BASIS = "basis"
    LIQUIDATION = "liquidation"


class TransportMode(str, enum.Enum):
    """Mechanism used to obtain a channel from an exchange."""

    WEBSOCKET = "websocket"
    REST_POLL = "rest_poll"
    REST_SNAPSHOT = "rest_snapshot"
    REST_HISTORY = "rest_history"
    PLUGIN_STREAM = "plugin_stream"


class DeliveryClass(str, enum.Enum):
    """Queue and replacement semantics required by a channel."""

    LATEST = "latest"
    APPEND = "append"
    SNAPSHOT = "snapshot"
    ORDERED_DELTA = "ordered_delta"


ParamPair: TypeAlias = tuple[str, str]
ParamPairs: TypeAlias = tuple[ParamPair, ...]
ParamsInput: TypeAlias = Mapping[object, object] | Iterable[tuple[object, object]]


_STREAM_VALUE_TO_CHANNEL = {
    "kline": MarketChannel.KLINE,
    "aggTrade": MarketChannel.AGG_TRADE,
    "trade": MarketChannel.TRADE,
    "ticker": MarketChannel.TICKER,
    "miniTicker": MarketChannel.MINI_TICKER,
    "depth": MarketChannel.DEPTH,
    "fullDepth": MarketChannel.FULL_DEPTH,
    "markPrice": MarketChannel.MARK_PRICE,
    "indexPrice": MarketChannel.INDEX_PRICE,
    "fundingRate": MarketChannel.FUNDING_RATE,
    "openInterest": MarketChannel.OPEN_INTEREST,
    "forceOrder": MarketChannel.LIQUIDATION,
}


def market_channel_for_stream_type(stream_type: object) -> MarketChannel | None:
    """Map an ingestion stream enum/value to its canonical logical channel."""

    value = getattr(stream_type, "value", stream_type)
    if not isinstance(value, str):
        return None
    return _STREAM_VALUE_TO_CHANNEL.get(value.strip())


def _canonical_param_component(
    value: object,
    *,
    label: str,
    name: bool = False,
) -> str:
    """Convert one parameter component to its stable string form."""

    if value is None:
        raise ValueError(f"market stream {label} cannot be None")
    if isinstance(value, enum.Enum):
        value = value.value
    if name and not isinstance(value, str):
        raise TypeError("market stream param names must be strings")
    if isinstance(value, bool):
        normalized = "true" if value else "false"
    elif isinstance(value, str):
        normalized = value.strip()
    elif isinstance(value, int):
        normalized = str(value)
    elif isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError(f"market stream {label} must be finite")
        normalized = repr(value)
    else:
        raise TypeError(
            f"market stream {label} must be a string, integer, float, boolean, or enum",
        )
    if not normalized:
        raise ValueError(f"market stream {label} cannot be blank")
    return normalized


def _canonical_params(params: object) -> ParamPairs:
    """Freeze mapping or pair input as sorted, unique string pairs."""

    if params is None:
        return ()
    if isinstance(params, Mapping):
        items: Iterable[object] = params.items()
    elif isinstance(params, Iterable) and not isinstance(params, (str, bytes)):
        items = params
    else:
        raise TypeError("market stream params must be a mapping or iterable of pairs")

    normalized: dict[str, str] = {}
    for item in items:
        if isinstance(item, (str, bytes)):
            raise TypeError("each market stream param must be a key/value pair")
        try:
            key, value = item  # type: ignore[misc]
        except (TypeError, ValueError) as exc:
            raise TypeError("each market stream param must be a key/value pair") from exc
        key_string = _canonical_param_component(key, label="param name", name=True)
        if key_string in normalized:
            raise ValueError(f"duplicate market stream param: {key_string!r}")
        normalized[key_string] = _canonical_param_component(
            value,
            label=f"param {key_string!r}",
        )
    return tuple(sorted(normalized.items()))


def _required_identity(value: object, *, label: str, case: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"market stream {label} must be a string")
    normalized = value.strip()
    if not normalized:
        raise ValueError(f"market stream {label} cannot be blank")
    if case == "lower":
        return normalized.lower()
    if case == "upper":
        return normalized.upper()
    return normalized


@dataclass(frozen=True, slots=True)
class MarketStreamKey:
    """Immutable identity for one logical market-data stream.

    ``params`` accepts either a mapping or an iterable of key/value pairs at
    construction time.  It is frozen to sorted string pairs, making equivalent
    input orders compare and hash identically.  Pair input is useful at trust
    boundaries because duplicate names can be detected instead of silently
    overwritten by a dictionary.
    """

    exchange: str
    market_type: str
    symbol: str
    channel: MarketChannel
    params: ParamPairs = ()

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "exchange",
            _required_identity(self.exchange, label="exchange", case="lower"),
        )
        object.__setattr__(
            self,
            "market_type",
            _required_identity(self.market_type, label="market type", case="lower"),
        )
        object.__setattr__(
            self,
            "symbol",
            _required_identity(self.symbol, label="symbol", case="upper"),
        )

        channel = self.channel
        if isinstance(channel, str):
            channel_value = channel.strip().lower()
            if not channel_value:
                raise ValueError("market stream channel cannot be blank")
            try:
                channel = MarketChannel(channel_value)
            except ValueError as exc:
                raise ValueError(f"unsupported market stream channel: {channel_value!r}") from exc
        elif not isinstance(channel, MarketChannel):
            raise TypeError("market stream channel must be a MarketChannel or string")
        object.__setattr__(self, "channel", channel)
        object.__setattr__(self, "params", _canonical_params(self.params))

    @classmethod
    def build(
        cls,
        exchange: str,
        market_type: str,
        symbol: str,
        channel: MarketChannel | str,
        params: ParamsInput | None = None,
        **channel_params: object,
    ) -> MarketStreamKey:
        """Build a key from mapping/pair input and optional keyword params.

        Keyword params are primarily a convenience for call sites such as
        ``MarketStreamKey.build(..., MarketChannel.KLINE, interval="1m")``.
        Supplying the same name in ``params`` and as a keyword is rejected by
        the normal duplicate check.
        """

        combined: list[tuple[object, object]] = []
        if params is not None:
            if isinstance(params, Mapping):
                combined.extend(params.items())
            elif isinstance(params, Iterable) and not isinstance(params, (str, bytes)):
                combined.extend(params)
            else:
                raise TypeError("market stream params must be a mapping or iterable of pairs")
        combined.extend(channel_params.items())
        return cls(exchange, market_type, symbol, channel, combined)  # type: ignore[arg-type]

    @property
    def topic(self) -> str:
        """Return a deterministic, human-readable event-routing topic."""

        base = f"{self.exchange}:{self.market_type}:{self.symbol}@{self.channel.value}"
        if not self.params:
            return base
        return f"{base}?{urlencode(self.params)}"

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-serializable representation of the identity."""

        return {
            "exchange": self.exchange,
            "market_type": self.market_type,
            "symbol": self.symbol,
            "channel": self.channel.value,
            "params": dict(self.params),
        }

    def __str__(self) -> str:
        return self.topic
