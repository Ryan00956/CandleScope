"""Public, dependency-free market consumer contracts for Plugin Platform v2."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from .errors import contract_error
from .json_codec import normalize_json


MARKET_BARS_PAGE_V1 = "candlescope.market-bars-page/1"
MARKET_STREAM_V1 = "candlescope.stream/1"
MARKET_SYMBOLS_PAGE_V1 = "candlescope.market-symbols-page/1"
MARKET_TRADES_PAGE_V1 = "candlescope.market-trades-page/1"
MARKET_ORDER_BOOK_V1 = "candlescope.market-order-book/1"

MARKET_CONTEXT_MODES = frozenset({"live", "replay"})
MARKET_BAR_EVENT_TYPES = frozenset({"bar.created", "bar.updated", "bar.closed", "bar.amended"})


def _object(
    value: Any,
    path: str,
    *,
    required: frozenset[str],
    optional: frozenset[str] = frozenset(),
) -> Mapping[str, Any]:
    if not isinstance(value, Mapping) or not all(isinstance(key, str) for key in value):
        raise contract_error(f"{path} must be an object", path=path)
    missing = sorted(required - set(value))
    unknown = sorted(set(value) - required - optional)
    if missing or unknown:
        raise contract_error(
            f"{path} has an invalid shape; missing={missing}, unknown={unknown}",
            path=path,
        )
    return value


def _string(
    value: Any,
    path: str,
    *,
    maximum: int = 128,
    lower: bool = False,
    upper: bool = False,
) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise contract_error(f"{path} must be a bounded non-empty string", path=path)
    normalized = value.strip()
    if normalized != value:
        raise contract_error(f"{path} must not contain surrounding whitespace", path=path)
    if lower:
        normalized = normalized.lower()
    if upper:
        normalized = normalized.upper()
    return normalized


def _optional_string(value: Any, path: str, *, maximum: int = 128) -> str | None:
    if value is None:
        return None
    return _string(value, path, maximum=maximum)


def _integer(
    value: Any,
    path: str,
    *,
    minimum: int,
    maximum: int = 9_007_199_254_740_991,
) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise contract_error(f"{path} must be an integer from {minimum} to {maximum}", path=path)
    return value


def _optional_time(value: Any, path: str) -> int | None:
    if value is None:
        return None
    return _integer(value, path, minimum=0)


@dataclass(frozen=True, slots=True)
class MarketContext:
    """Identity of one data plane; live and replay are never interchangeable."""

    mode: str
    exchange: str
    market_type: str

    def __post_init__(self) -> None:
        mode = _string(self.mode, "context.mode", lower=True)
        if mode not in MARKET_CONTEXT_MODES:
            raise contract_error("context.mode must be live or replay", path="context.mode")
        object.__setattr__(self, "mode", mode)
        object.__setattr__(self, "exchange", _string(self.exchange, "context.exchange", lower=True))
        object.__setattr__(
            self,
            "market_type",
            _string(self.market_type, "context.marketType", lower=True),
        )

    def to_wire(self) -> dict[str, str]:
        return {
            "mode": self.mode,
            "exchange": self.exchange,
            "marketType": self.market_type,
        }

    @classmethod
    def from_wire(cls, value: Any, *, path: str = "context") -> "MarketContext":
        data = _object(
            value,
            path,
            required=frozenset({"mode", "exchange", "marketType"}),
        )
        return cls(data["mode"], data["exchange"], data["marketType"])


@dataclass(frozen=True, slots=True)
class MarketSeries:
    symbol: str
    interval: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "symbol", _string(self.symbol, "series.symbol", upper=True))
        object.__setattr__(self, "interval", _string(self.interval, "series.interval", maximum=32))

    def to_wire(self) -> dict[str, str]:
        return {"symbol": self.symbol, "interval": self.interval}

    @classmethod
    def from_wire(cls, value: Any, *, path: str = "series") -> "MarketSeries":
        data = _object(
            value,
            path,
            required=frozenset({"symbol", "interval"}),
        )
        return cls(data["symbol"], data["interval"])


@dataclass(frozen=True, slots=True)
class SymbolsReadRequest:
    context: MarketContext
    quote_asset: str
    limit: int = 100
    search: str | None = None
    after: str | None = None

    @classmethod
    def from_wire(cls, value: Any) -> "SymbolsReadRequest":
        data = _object(
            value,
            "market.symbols.read.params",
            required=frozenset({"context", "quoteAsset"}),
            optional=frozenset({"limit", "search", "after"}),
        )
        return cls(
            context=MarketContext.from_wire(data["context"]),
            quote_asset=_string(data["quoteAsset"], "quoteAsset", upper=True),
            limit=_integer(data.get("limit", 100), "limit", minimum=1, maximum=200),
            search=_optional_string(data.get("search"), "search", maximum=128),
            after=_optional_string(data.get("after"), "after", maximum=128),
        )


@dataclass(frozen=True, slots=True)
class BarsReadRequest:
    context: MarketContext
    series: MarketSeries
    start_ms: int | None
    end_ms: int | None
    limit: int

    @classmethod
    def from_wire(cls, value: Any) -> "BarsReadRequest":
        data = _object(
            value,
            "market.bars.read.params",
            required=frozenset({"context", "series"}),
            optional=frozenset({"startMs", "endMs", "limit"}),
        )
        start_ms = _optional_time(data.get("startMs"), "startMs")
        end_ms = _optional_time(data.get("endMs"), "endMs")
        if start_ms is not None and end_ms is not None and start_ms > end_ms:
            raise contract_error("startMs must not exceed endMs", path="startMs")
        return cls(
            context=MarketContext.from_wire(data["context"]),
            series=MarketSeries.from_wire(data["series"]),
            start_ms=start_ms,
            end_ms=end_ms,
            limit=_integer(data.get("limit", 500), "limit", minimum=1, maximum=5_000),
        )


@dataclass(frozen=True, slots=True)
class BarsSubscribeRequest:
    context: MarketContext
    series: MarketSeries
    queue_capacity: int
    max_batch: int
    max_latency_ms: int

    @classmethod
    def from_wire(cls, value: Any) -> "BarsSubscribeRequest":
        data = _object(
            value,
            "market.bars.subscribe.params",
            required=frozenset({"context", "series"}),
            optional=frozenset({"queueCapacity", "maxBatch", "maxLatencyMs"}),
        )
        queue_capacity = _integer(
            data.get("queueCapacity", 64), "queueCapacity", minimum=8, maximum=1_024
        )
        max_batch = _integer(data.get("maxBatch", 16), "maxBatch", minimum=1, maximum=64)
        if max_batch > queue_capacity:
            raise contract_error("maxBatch must not exceed queueCapacity", path="maxBatch")
        return cls(
            context=MarketContext.from_wire(data["context"]),
            series=MarketSeries.from_wire(data["series"]),
            queue_capacity=queue_capacity,
            max_batch=max_batch,
            max_latency_ms=_integer(
                data.get("maxLatencyMs", 50),
                "maxLatencyMs",
                minimum=1,
                maximum=1_000,
            ),
        )


@dataclass(frozen=True, slots=True)
class TradesReadRequest:
    context: MarketContext
    symbol: str
    kind: str
    start_ms: int | None
    end_ms: int | None
    limit: int

    @classmethod
    def from_wire(cls, value: Any) -> "TradesReadRequest":
        data = _object(
            value,
            "market.trades.read.params",
            required=frozenset({"context", "symbol", "kind"}),
            optional=frozenset({"startMs", "endMs", "limit"}),
        )
        kind = _string(data["kind"], "kind")
        if kind not in {"recent", "history-1m"}:
            raise contract_error("kind must be recent or history-1m", path="kind")
        start_ms = _optional_time(data.get("startMs"), "startMs")
        end_ms = _optional_time(data.get("endMs"), "endMs")
        if start_ms is not None and end_ms is not None and start_ms > end_ms:
            raise contract_error("startMs must not exceed endMs", path="startMs")
        if kind == "recent" and (start_ms is not None or end_ms is not None):
            raise contract_error("recent trade reads do not accept a time range", path="kind")
        return cls(
            context=MarketContext.from_wire(data["context"]),
            symbol=_string(data["symbol"], "symbol", upper=True),
            kind=kind,
            start_ms=start_ms,
            end_ms=end_ms,
            limit=_integer(data.get("limit", 500), "limit", minimum=1, maximum=5_000),
        )


@dataclass(frozen=True, slots=True)
class OrderBookReadRequest:
    context: MarketContext
    symbol: str
    depth_levels: int
    update_interval_ms: int | None
    wait_ms: int

    @classmethod
    def from_wire(cls, value: Any) -> "OrderBookReadRequest":
        data = _object(
            value,
            "market.order-book.read.params",
            required=frozenset({"context", "symbol"}),
            optional=frozenset({"depthLevels", "updateIntervalMs", "waitMs"}),
        )
        depth = _integer(data.get("depthLevels", 20), "depthLevels", minimum=1, maximum=20)
        if depth not in {5, 10, 20}:
            raise contract_error("depthLevels must be one of 5, 10, or 20", path="depthLevels")
        update_interval = data.get("updateIntervalMs")
        if update_interval is not None:
            update_interval = _integer(
                update_interval, "updateIntervalMs", minimum=1, maximum=5_000
            )
        return cls(
            context=MarketContext.from_wire(data["context"]),
            symbol=_string(data["symbol"], "symbol", upper=True),
            depth_levels=depth,
            update_interval_ms=update_interval,
            wait_ms=_integer(data.get("waitMs", 2_000), "waitMs", minimum=100, maximum=5_000),
        )


def _validate_bar(value: Any, path: str) -> dict[str, Any]:
    normalized = normalize_json(value, path=path)
    if not isinstance(normalized, dict):
        raise contract_error(f"{path} must be an object", path=path)
    required = {"time", "open", "high", "low", "close", "volume", "is_closed"}
    missing = sorted(required - set(normalized))
    if missing:
        raise contract_error(f"{path} is missing {missing}", path=path)
    if isinstance(normalized["time"], bool) or not isinstance(normalized["time"], int):
        raise contract_error(f"{path}.time must be an integer", path=f"{path}.time")
    for name in ("open", "high", "low", "close", "volume"):
        if isinstance(normalized[name], bool) or not isinstance(normalized[name], (int, float)):
            raise contract_error(f"{path}.{name} must be numeric", path=f"{path}.{name}")
    if not isinstance(normalized["is_closed"], bool):
        raise contract_error(f"{path}.is_closed must be boolean", path=f"{path}.is_closed")
    return normalized


def validate_market_bars_page(value: Any) -> dict[str, Any]:
    """Validate and detach a Host bars-page response."""

    data = _object(
        value,
        "marketBarsPage",
        required=frozenset(
            {
                "schemaVersion",
                "context",
                "series",
                "data",
                "coverage",
                "sourceQuality",
                "pagination",
            }
        ),
    )
    if data["schemaVersion"] != MARKET_BARS_PAGE_V1:
        raise contract_error(
            "marketBarsPage.schemaVersion is unsupported",
            path="marketBarsPage.schemaVersion",
        )
    MarketContext.from_wire(data["context"])
    MarketSeries.from_wire(data["series"])
    raw_rows = data["data"]
    if isinstance(raw_rows, (str, bytes)) or not isinstance(raw_rows, Sequence):
        raise contract_error("marketBarsPage.data must be an array", path="marketBarsPage.data")
    normalized = normalize_json(value, path="marketBarsPage")
    assert isinstance(normalized, dict)
    normalized["data"] = [
        _validate_bar(item, f"marketBarsPage.data[{index}]") for index, item in enumerate(raw_rows)
    ]
    return normalized


def validate_market_stream_event(value: Any) -> dict[str, Any]:
    data = _object(
        value,
        "marketStreamEvent",
        required=frozenset(
            {
                "schemaVersion",
                "subscriptionId",
                "streamId",
                "generation",
                "sequence",
                "eventType",
                "context",
                "series",
                "bar",
                "emittedAtMs",
            }
        ),
    )
    if data["schemaVersion"] != MARKET_STREAM_V1:
        raise contract_error(
            "marketStreamEvent.schemaVersion is unsupported",
            path="marketStreamEvent.schemaVersion",
        )
    if data["eventType"] not in MARKET_BAR_EVENT_TYPES:
        raise contract_error(
            "marketStreamEvent.eventType is unsupported",
            path="marketStreamEvent.eventType",
        )
    MarketContext.from_wire(data["context"])
    MarketSeries.from_wire(data["series"])
    _string(data["subscriptionId"], "subscriptionId")
    _string(data["streamId"], "streamId")
    _integer(data["generation"], "generation", minimum=1)
    _integer(data["sequence"], "sequence", minimum=1)
    _integer(data["emittedAtMs"], "emittedAtMs", minimum=0)
    normalized = normalize_json(value, path="marketStreamEvent")
    assert isinstance(normalized, dict)
    normalized["bar"] = _validate_bar(data["bar"], "marketStreamEvent.bar")
    return normalized


__all__ = [
    "BarsReadRequest",
    "BarsSubscribeRequest",
    "MARKET_BAR_EVENT_TYPES",
    "MARKET_BARS_PAGE_V1",
    "MARKET_CONTEXT_MODES",
    "MARKET_ORDER_BOOK_V1",
    "MARKET_STREAM_V1",
    "MARKET_SYMBOLS_PAGE_V1",
    "MARKET_TRADES_PAGE_V1",
    "MarketContext",
    "MarketSeries",
    "OrderBookReadRequest",
    "SymbolsReadRequest",
    "TradesReadRequest",
    "validate_market_bars_page",
    "validate_market_stream_event",
]
