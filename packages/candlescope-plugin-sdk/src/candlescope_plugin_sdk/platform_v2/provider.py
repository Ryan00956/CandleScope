"""Dependency-free public market-data provider contracts for Platform v2."""

from __future__ import annotations

import math
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from .errors import contract_error


PROVIDER_SYMBOLS_PAGE_V1 = "candlescope.provider-symbols-page/1"
PROVIDER_HISTORY_PAGE_V1 = "candlescope.provider-history-page/1"
PROVIDER_STREAM_OPEN_V1 = "candlescope.provider-stream-open/1"
PROVIDER_STREAM_BATCH_V1 = "candlescope.provider-stream-batch/1"
PROVIDER_STREAM_CLOSE_V1 = "candlescope.provider-stream-close/1"
PROVIDER_DATA_PLANE_V1 = "candlescope.stream/1"

PROVIDER_CHANNELS = frozenset({"kline", "full_depth"})
PROVIDER_BAR_FINALITY = frozenset({"forming", "final", "corrected"})
PROVIDER_EVENT_TYPES = frozenset(
    {
        "bar.updated",
        "bar.closed",
        "bar.amended",
        "orderbook.snapshot",
        "orderbook.delta",
    }
)
PROVIDER_QUALITY_LEVELS = frozenset({"authoritative", "verified", "best-effort", "synthetic"})

_EXCHANGE = re.compile(r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")
_MARKET_TYPE = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
_SYMBOL = re.compile(r"^[A-Z0-9][A-Z0-9._:-]{0,63}$")
_INTERVAL = re.compile(r"^[1-9][0-9]{0,5}[smhdwM]$")
_OPAQUE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_DECIMAL = re.compile(r"^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$")


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
    pattern: re.Pattern[str] | None = None,
) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or len(value) > maximum
        or (pattern is not None and pattern.fullmatch(value) is None)
    ):
        raise contract_error(f"{path} must be a bounded canonical string", path=path)
    return value


def _optional_string(
    value: Any,
    path: str,
    *,
    maximum: int = 128,
    pattern: re.Pattern[str] | None = None,
) -> str | None:
    if value is None:
        return None
    return _string(value, path, maximum=maximum, pattern=pattern)


def _integer(
    value: Any,
    path: str,
    *,
    minimum: int = 0,
    maximum: int = 9_007_199_254_740_991,
) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise contract_error(f"{path} must be an integer from {minimum} to {maximum}", path=path)
    return value


def _number(value: Any, path: str, *, minimum: float | None = None) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise contract_error(f"{path} must be numeric", path=path)
    normalized = float(value)
    if not math.isfinite(normalized) or (minimum is not None and normalized < minimum):
        raise contract_error(f"{path} is outside its numeric bounds", path=path)
    return normalized


def _boolean(value: Any, path: str) -> bool:
    if not isinstance(value, bool):
        raise contract_error(f"{path} must be boolean", path=path)
    return value


def _quality(value: Any, path: str = "sourceQuality") -> dict[str, str]:
    data = _object(
        value,
        path,
        required=frozenset({"quality", "finality", "timestamp"}),
    )
    quality = _string(data["quality"], f"{path}.quality", maximum=32)
    finality = _string(data["finality"], f"{path}.finality", maximum=32)
    timestamp = _string(data["timestamp"], f"{path}.timestamp", maximum=32)
    if quality not in PROVIDER_QUALITY_LEVELS:
        raise contract_error(f"{path}.quality is unsupported", path=f"{path}.quality")
    if finality not in {"explicit", "inferred"}:
        raise contract_error(f"{path}.finality is unsupported", path=f"{path}.finality")
    if timestamp not in {"exchange", "provider", "host"}:
        raise contract_error(f"{path}.timestamp is unsupported", path=f"{path}.timestamp")
    return {"quality": quality, "finality": finality, "timestamp": timestamp}


@dataclass(frozen=True, slots=True)
class ProviderStreamDescriptor:
    exchange: str
    market_type: str
    channel: str
    symbol: str
    interval: str | None = None

    def __post_init__(self) -> None:
        exchange = _string(self.exchange, "descriptor.exchange", maximum=64, pattern=_EXCHANGE)
        market_type = _string(
            self.market_type, "descriptor.marketType", maximum=32, pattern=_MARKET_TYPE
        )
        channel = _string(self.channel, "descriptor.channel", maximum=32)
        symbol = _string(self.symbol, "descriptor.symbol", maximum=64, pattern=_SYMBOL)
        interval = _optional_string(
            self.interval, "descriptor.interval", maximum=16, pattern=_INTERVAL
        )
        if channel not in PROVIDER_CHANNELS:
            raise contract_error("descriptor.channel is unsupported", path="descriptor.channel")
        if (channel == "kline") != (interval is not None):
            raise contract_error(
                "only kline descriptors require an interval", path="descriptor.interval"
            )
        object.__setattr__(self, "exchange", exchange)
        object.__setattr__(self, "market_type", market_type)
        object.__setattr__(self, "channel", channel)
        object.__setattr__(self, "symbol", symbol)
        object.__setattr__(self, "interval", interval)

    def to_wire(self) -> dict[str, Any]:
        return {
            "exchange": self.exchange,
            "marketType": self.market_type,
            "channel": self.channel,
            "symbol": self.symbol,
            **({"interval": self.interval} if self.interval is not None else {}),
        }

    @classmethod
    def from_wire(cls, value: Any, *, path: str = "descriptor") -> "ProviderStreamDescriptor":
        data = _object(
            value,
            path,
            required=frozenset({"exchange", "marketType", "channel", "symbol"}),
            optional=frozenset({"interval"}),
        )
        return cls(
            data["exchange"],
            data["marketType"],
            data["channel"],
            data["symbol"],
            data.get("interval"),
        )


@dataclass(frozen=True, slots=True)
class ProviderSymbolsRequest:
    market_type: str
    limit: int
    quote_asset: str | None = None
    search: str | None = None
    cursor: str | None = None

    @classmethod
    def from_invoke(cls, value: Any) -> "ProviderSymbolsRequest":
        data = _object(
            value,
            "provider.symbols.input",
            required=frozenset({"operation", "marketType", "limit"}),
            optional=frozenset({"quoteAsset", "search", "cursor"}),
        )
        if data["operation"] != "symbols.list":
            raise contract_error("provider symbol operation is invalid", path="operation")
        quote_asset = _optional_string(data.get("quoteAsset"), "quoteAsset", maximum=32)
        if quote_asset is not None and quote_asset != quote_asset.upper():
            raise contract_error("quoteAsset must be uppercase", path="quoteAsset")
        return cls(
            market_type=_string(data["marketType"], "marketType", maximum=32, pattern=_MARKET_TYPE),
            limit=_integer(data["limit"], "limit", minimum=1, maximum=500),
            quote_asset=quote_asset,
            search=_optional_string(data.get("search"), "search", maximum=128),
            cursor=_optional_string(data.get("cursor"), "cursor", pattern=_OPAQUE_ID),
        )


@dataclass(frozen=True, slots=True)
class ProviderHistoryRequest:
    descriptor: ProviderStreamDescriptor
    start_ms: int | None
    end_ms: int | None
    limit: int

    @classmethod
    def from_invoke(cls, value: Any) -> "ProviderHistoryRequest":
        data = _object(
            value,
            "provider.history.input",
            required=frozenset({"operation", "descriptor", "startMs", "endMs", "limit"}),
        )
        if data["operation"] != "history.read":
            raise contract_error("provider history operation is invalid", path="operation")
        descriptor = ProviderStreamDescriptor.from_wire(data["descriptor"])
        if descriptor.channel != "kline":
            raise contract_error("Phase 10 history supports kline only", path="descriptor.channel")
        start_ms = None if data["startMs"] is None else _integer(data["startMs"], "startMs")
        end_ms = None if data["endMs"] is None else _integer(data["endMs"], "endMs")
        if start_ms is not None and end_ms is not None and start_ms > end_ms:
            raise contract_error("startMs must not exceed endMs", path="startMs")
        return cls(
            descriptor,
            start_ms,
            end_ms,
            _integer(data["limit"], "limit", minimum=1, maximum=5_000),
        )


@dataclass(frozen=True, slots=True)
class ProviderStreamOpenRequest:
    host_stream_id: str
    descriptor: ProviderStreamDescriptor
    batch_limit: int
    resync: bool

    @classmethod
    def from_invoke(cls, value: Any) -> "ProviderStreamOpenRequest":
        data = _object(
            value,
            "provider.stream.open.input",
            required=frozenset({"operation", "hostStreamId", "descriptor", "batchLimit", "resync"}),
        )
        if data["operation"] != "stream.open":
            raise contract_error("provider stream operation is invalid", path="operation")
        return cls(
            _string(data["hostStreamId"], "hostStreamId", pattern=_OPAQUE_ID),
            ProviderStreamDescriptor.from_wire(data["descriptor"]),
            _integer(data["batchLimit"], "batchLimit", minimum=1, maximum=256),
            _boolean(data["resync"], "resync"),
        )


@dataclass(frozen=True, slots=True)
class ProviderStreamPollRequest:
    provider_stream_id: str
    after_sequence: int
    batch_limit: int
    wait_ms: int

    @classmethod
    def from_invoke(cls, value: Any) -> "ProviderStreamPollRequest":
        data = _object(
            value,
            "provider.stream.poll.input",
            required=frozenset(
                {"operation", "providerStreamId", "afterSequence", "batchLimit", "waitMs"}
            ),
        )
        if data["operation"] != "stream.poll":
            raise contract_error("provider stream operation is invalid", path="operation")
        return cls(
            _string(data["providerStreamId"], "providerStreamId", pattern=_OPAQUE_ID),
            _integer(data["afterSequence"], "afterSequence", minimum=0),
            _integer(data["batchLimit"], "batchLimit", minimum=1, maximum=256),
            _integer(data["waitMs"], "waitMs", minimum=0, maximum=5_000),
        )


@dataclass(frozen=True, slots=True)
class ProviderStreamCloseRequest:
    provider_stream_id: str

    @classmethod
    def from_invoke(cls, value: Any) -> "ProviderStreamCloseRequest":
        data = _object(
            value,
            "provider.stream.close.input",
            required=frozenset({"operation", "providerStreamId"}),
        )
        if data["operation"] != "stream.close":
            raise contract_error("provider stream operation is invalid", path="operation")
        return cls(_string(data["providerStreamId"], "providerStreamId", pattern=_OPAQUE_ID))


def parse_provider_operation(
    value: Any,
) -> (
    ProviderSymbolsRequest
    | ProviderHistoryRequest
    | ProviderStreamOpenRequest
    | ProviderStreamPollRequest
    | ProviderStreamCloseRequest
):
    if not isinstance(value, Mapping):
        raise contract_error("provider input must be an object", path="invoke.input")
    operation = value.get("operation")
    if operation == "symbols.list":
        return ProviderSymbolsRequest.from_invoke(value)
    if operation == "history.read":
        return ProviderHistoryRequest.from_invoke(value)
    if operation == "stream.open":
        return ProviderStreamOpenRequest.from_invoke(value)
    if operation == "stream.poll":
        return ProviderStreamPollRequest.from_invoke(value)
    if operation == "stream.close":
        return ProviderStreamCloseRequest.from_invoke(value)
    raise contract_error("provider operation is unsupported", path="operation")


def _symbol(value: Any, path: str) -> dict[str, Any]:
    data = _object(
        value,
        path,
        required=frozenset(
            {
                "symbol",
                "baseAsset",
                "quoteAsset",
                "status",
                "exchange",
                "marketType",
                "productType",
            }
        ),
        optional=frozenset(
            {
                "contractType",
                "listedAtMs",
                "continuousTradingAtMs",
                "delistedAtMs",
                "expiryAtMs",
                "priceTickSize",
            }
        ),
    )
    result: dict[str, Any] = {
        "symbol": _string(data["symbol"], f"{path}.symbol", maximum=64, pattern=_SYMBOL),
        "baseAsset": _string(data["baseAsset"], f"{path}.baseAsset", maximum=32),
        "quoteAsset": _string(data["quoteAsset"], f"{path}.quoteAsset", maximum=32),
        "status": _string(data["status"], f"{path}.status", maximum=32),
        "exchange": _string(data["exchange"], f"{path}.exchange", maximum=64, pattern=_EXCHANGE),
        "marketType": _string(
            data["marketType"], f"{path}.marketType", maximum=32, pattern=_MARKET_TYPE
        ),
        "productType": _string(data["productType"], f"{path}.productType", maximum=32),
    }
    if (
        result["baseAsset"] != result["baseAsset"].upper()
        or result["quoteAsset"] != result["quoteAsset"].upper()
    ):
        raise contract_error(f"{path} assets must be uppercase", path=path)
    if result["status"] not in {"active", "inactive"}:
        raise contract_error(f"{path}.status is unsupported", path=f"{path}.status")
    for name in ("listedAtMs", "continuousTradingAtMs", "delistedAtMs", "expiryAtMs"):
        if name in data:
            result[name] = None if data[name] is None else _integer(data[name], f"{path}.{name}")
    for name in ("contractType", "priceTickSize"):
        if name in data:
            result[name] = _string(data[name], f"{path}.{name}", maximum=64)
    tick = result.get("priceTickSize")
    if tick is not None and (_DECIMAL.fullmatch(tick) is None or float(tick) <= 0):
        raise contract_error(f"{path}.priceTickSize is invalid", path=f"{path}.priceTickSize")
    return result


def validate_provider_symbols_page(
    value: Any,
    *,
    expected_exchange: str | None = None,
    expected_market_type: str | None = None,
    max_rows: int = 500,
) -> dict[str, Any]:
    data = _object(
        value,
        "providerSymbolsPage",
        required=frozenset(
            {
                "schemaVersion",
                "exchange",
                "marketType",
                "symbols",
                "nextCursor",
                "exhausted",
                "sourceQuality",
            }
        ),
    )
    if data["schemaVersion"] != PROVIDER_SYMBOLS_PAGE_V1:
        raise contract_error("provider symbols schema is unsupported", path="schemaVersion")
    exchange = _string(data["exchange"], "exchange", maximum=64, pattern=_EXCHANGE)
    market_type = _string(data["marketType"], "marketType", maximum=32, pattern=_MARKET_TYPE)
    if expected_exchange is not None and exchange != expected_exchange:
        raise contract_error("provider symbols exchange drifted", path="exchange")
    if expected_market_type is not None and market_type != expected_market_type:
        raise contract_error("provider symbols marketType drifted", path="marketType")
    raw_symbols = data["symbols"]
    if isinstance(raw_symbols, (str, bytes)) or not isinstance(raw_symbols, Sequence):
        raise contract_error("symbols must be an array", path="symbols")
    if len(raw_symbols) > max_rows:
        raise contract_error("symbols page exceeds Host row limit", path="symbols")
    symbols = [_symbol(item, f"symbols[{index}]") for index, item in enumerate(raw_symbols)]
    identities = [item["symbol"] for item in symbols]
    if identities != sorted(set(identities)):
        raise contract_error("symbols must be sorted and unique", path="symbols")
    if any(item["exchange"] != exchange or item["marketType"] != market_type for item in symbols):
        raise contract_error("symbol identity does not match page identity", path="symbols")
    exhausted = _boolean(data["exhausted"], "exhausted")
    next_cursor = _optional_string(data["nextCursor"], "nextCursor", pattern=_OPAQUE_ID)
    if exhausted != (next_cursor is None):
        raise contract_error(
            "exhausted pages must omit nextCursor and partial pages must provide it",
            path="nextCursor",
        )
    return {
        "schemaVersion": PROVIDER_SYMBOLS_PAGE_V1,
        "exchange": exchange,
        "marketType": market_type,
        "symbols": symbols,
        "nextCursor": next_cursor,
        "exhausted": exhausted,
        "sourceQuality": _quality(data["sourceQuality"]),
    }


def _bar(value: Any, path: str, *, history: bool) -> dict[str, Any]:
    data = _object(
        value,
        path,
        required=frozenset(
            {"openTimeMs", "closeTimeMs", "open", "high", "low", "close", "volume", "finality"}
        ),
        optional=frozenset(
            {"quoteVolume", "trades", "takerBuyBase", "takerBuyQuote", "eventTimeMs", "sequence"}
        ),
    )
    result: dict[str, Any] = {
        "openTimeMs": _integer(data["openTimeMs"], f"{path}.openTimeMs"),
        "closeTimeMs": _integer(data["closeTimeMs"], f"{path}.closeTimeMs"),
        "open": _number(data["open"], f"{path}.open", minimum=0),
        "high": _number(data["high"], f"{path}.high", minimum=0),
        "low": _number(data["low"], f"{path}.low", minimum=0),
        "close": _number(data["close"], f"{path}.close", minimum=0),
        "volume": _number(data["volume"], f"{path}.volume", minimum=0),
        "finality": _string(data["finality"], f"{path}.finality", maximum=16),
    }
    if result["closeTimeMs"] < result["openTimeMs"]:
        raise contract_error(f"{path} close time precedes open time", path=path)
    if result["high"] < max(result["open"], result["close"], result["low"]):
        raise contract_error(f"{path}.high violates OHLC invariants", path=f"{path}.high")
    if result["low"] > min(result["open"], result["close"], result["high"]):
        raise contract_error(f"{path}.low violates OHLC invariants", path=f"{path}.low")
    if result["finality"] not in PROVIDER_BAR_FINALITY or (
        history and result["finality"] == "forming"
    ):
        raise contract_error(f"{path}.finality is invalid", path=f"{path}.finality")
    for name in ("quoteVolume", "takerBuyBase", "takerBuyQuote"):
        if name in data:
            result[name] = _number(data[name], f"{path}.{name}", minimum=0)
    for name in ("trades", "eventTimeMs", "sequence"):
        if name in data:
            result[name] = _integer(data[name], f"{path}.{name}")
    return result


def validate_provider_history_page(
    value: Any,
    *,
    request: ProviderHistoryRequest | None = None,
    max_rows: int = 5_000,
) -> dict[str, Any]:
    data = _object(
        value,
        "providerHistoryPage",
        required=frozenset(
            {
                "schemaVersion",
                "descriptor",
                "rows",
                "nextBeforeMs",
                "exhausted",
                "sourceQuality",
            }
        ),
    )
    if data["schemaVersion"] != PROVIDER_HISTORY_PAGE_V1:
        raise contract_error("provider history schema is unsupported", path="schemaVersion")
    descriptor = ProviderStreamDescriptor.from_wire(data["descriptor"])
    if descriptor.channel != "kline":
        raise contract_error("history page must contain kline rows", path="descriptor.channel")
    if request is not None and descriptor != request.descriptor:
        raise contract_error("provider history descriptor drifted", path="descriptor")
    raw_rows = data["rows"]
    if isinstance(raw_rows, (str, bytes)) or not isinstance(raw_rows, Sequence):
        raise contract_error("history rows must be an array", path="rows")
    row_limit = min(max_rows, request.limit if request is not None else max_rows)
    if len(raw_rows) > row_limit:
        raise contract_error("history page exceeds Host row limit", path="rows")
    rows = [_bar(item, f"rows[{index}]", history=True) for index, item in enumerate(raw_rows)]
    times = [item["openTimeMs"] for item in rows]
    if times != sorted(set(times)):
        raise contract_error("history rows must be sorted and unique", path="rows")
    if request is not None and any(
        (request.start_ms is not None and item < request.start_ms)
        or (request.end_ms is not None and item > request.end_ms)
        for item in times
    ):
        raise contract_error("history row is outside the requested range", path="rows")
    exhausted = _boolean(data["exhausted"], "exhausted")
    next_before = (
        None if data["nextBeforeMs"] is None else _integer(data["nextBeforeMs"], "nextBeforeMs")
    )
    if exhausted and next_before is not None:
        raise contract_error("exhausted history pages cannot continue", path="nextBeforeMs")
    if not exhausted and (not rows or next_before != rows[0]["openTimeMs"] - 1):
        raise contract_error(
            "partial history pages require the canonical reverse-time cursor",
            path="nextBeforeMs",
        )
    return {
        "schemaVersion": PROVIDER_HISTORY_PAGE_V1,
        "descriptor": descriptor.to_wire(),
        "rows": rows,
        "nextBeforeMs": next_before,
        "exhausted": exhausted,
        "sourceQuality": _quality(data["sourceQuality"]),
    }


def validate_provider_stream_open(
    value: Any, *, expected_host_stream_id: str | None = None
) -> dict[str, Any]:
    data = _object(
        value,
        "providerStreamOpen",
        required=frozenset(
            {
                "schemaVersion",
                "hostStreamId",
                "providerStreamId",
                "generation",
                "nextSequence",
                "sourceQuality",
            }
        ),
    )
    if data["schemaVersion"] != PROVIDER_STREAM_OPEN_V1:
        raise contract_error("provider stream-open schema is unsupported", path="schemaVersion")
    host_stream_id = _string(data["hostStreamId"], "hostStreamId", pattern=_OPAQUE_ID)
    if expected_host_stream_id is not None and host_stream_id != expected_host_stream_id:
        raise contract_error("provider echoed a different Host stream", path="hostStreamId")
    return {
        "schemaVersion": PROVIDER_STREAM_OPEN_V1,
        "hostStreamId": host_stream_id,
        "providerStreamId": _string(
            data["providerStreamId"], "providerStreamId", pattern=_OPAQUE_ID
        ),
        "generation": _integer(data["generation"], "generation", minimum=1),
        "nextSequence": _integer(data["nextSequence"], "nextSequence", minimum=1),
        "sourceQuality": _quality(data["sourceQuality"]),
    }


def _levels(value: Any, path: str, *, allow_zero: bool) -> list[list[float]]:
    if isinstance(value, (str, bytes)) or not isinstance(value, Sequence) or len(value) > 5_000:
        raise contract_error(f"{path} must be a bounded array", path=path)
    result: list[list[float]] = []
    for index, raw in enumerate(value):
        if isinstance(raw, (str, bytes)) or not isinstance(raw, Sequence) or len(raw) != 2:
            raise contract_error(f"{path}[{index}] must be [price, quantity]", path=path)
        price = _number(raw[0], f"{path}[{index}][0]", minimum=0)
        quantity = _number(raw[1], f"{path}[{index}][1]", minimum=0)
        if price <= 0 or (not allow_zero and quantity <= 0):
            raise contract_error(f"{path}[{index}] contains an invalid level", path=path)
        result.append([price, quantity])
    return result


def _book_payload(value: Any, path: str, *, snapshot: bool) -> dict[str, Any]:
    required = (
        frozenset({"kind", "lastUpdateId", "eventTimeMs", "bids", "asks"})
        if snapshot
        else frozenset(
            {
                "kind",
                "firstUpdateId",
                "finalUpdateId",
                "previousFinalUpdateId",
                "eventTimeMs",
                "bids",
                "asks",
            }
        )
    )
    data = _object(value, path, required=required, optional=frozenset({"updateIntervalMs"}))
    expected_kind = "snapshot" if snapshot else "delta"
    if data["kind"] != expected_kind:
        raise contract_error(f"{path}.kind must be {expected_kind}", path=f"{path}.kind")
    result: dict[str, Any] = {
        "kind": expected_kind,
        "eventTimeMs": _integer(data["eventTimeMs"], f"{path}.eventTimeMs"),
        "bids": _levels(data["bids"], f"{path}.bids", allow_zero=not snapshot),
        "asks": _levels(data["asks"], f"{path}.asks", allow_zero=not snapshot),
    }
    if snapshot:
        result["lastUpdateId"] = _integer(data["lastUpdateId"], f"{path}.lastUpdateId", minimum=1)
        if not result["bids"] or not result["asks"]:
            raise contract_error("order-book snapshots require both sides", path=path)
    else:
        first = _integer(data["firstUpdateId"], f"{path}.firstUpdateId", minimum=1)
        final = _integer(data["finalUpdateId"], f"{path}.finalUpdateId", minimum=1)
        previous = _integer(
            data["previousFinalUpdateId"], f"{path}.previousFinalUpdateId", minimum=0
        )
        if first > final or previous >= final:
            raise contract_error("order-book delta sequence range is invalid", path=path)
        result.update(
            {
                "firstUpdateId": first,
                "finalUpdateId": final,
                "previousFinalUpdateId": previous,
            }
        )
    if "updateIntervalMs" in data:
        result["updateIntervalMs"] = _integer(
            data["updateIntervalMs"], f"{path}.updateIntervalMs", minimum=1, maximum=60_000
        )
    return result


def _stream_event(value: Any, path: str) -> dict[str, Any]:
    data = _object(
        value,
        path,
        required=frozenset({"sequence", "eventType", "descriptor", "eventTimeMs", "payload"}),
    )
    sequence = _integer(data["sequence"], f"{path}.sequence", minimum=1)
    event_type = _string(data["eventType"], f"{path}.eventType", maximum=32)
    if event_type not in PROVIDER_EVENT_TYPES:
        raise contract_error(f"{path}.eventType is unsupported", path=f"{path}.eventType")
    descriptor = ProviderStreamDescriptor.from_wire(data["descriptor"], path=f"{path}.descriptor")
    if event_type.startswith("bar."):
        if descriptor.channel != "kline":
            raise contract_error("bar events require a kline descriptor", path=f"{path}.descriptor")
        payload = _bar(data["payload"], f"{path}.payload", history=False)
        expected_finality = {
            "bar.updated": "forming",
            "bar.closed": "final",
            "bar.amended": "corrected",
        }[event_type]
        if payload["finality"] != expected_finality:
            raise contract_error("bar event finality drifted", path=f"{path}.payload.finality")
    else:
        if descriptor.channel != "full_depth":
            raise contract_error(
                "order-book events require a full_depth descriptor", path=f"{path}.descriptor"
            )
        payload = _book_payload(
            data["payload"],
            f"{path}.payload",
            snapshot=event_type == "orderbook.snapshot",
        )
    return {
        "sequence": sequence,
        "eventType": event_type,
        "descriptor": descriptor.to_wire(),
        "eventTimeMs": _integer(data["eventTimeMs"], f"{path}.eventTimeMs"),
        "payload": payload,
    }


def validate_provider_stream_batch(
    value: Any,
    *,
    expected_provider_stream_id: str | None = None,
    expected_generation: int | None = None,
    expected_descriptor: ProviderStreamDescriptor | None = None,
    max_events: int = 256,
) -> dict[str, Any]:
    data = _object(
        value,
        "providerStreamBatch",
        required=frozenset(
            {
                "schemaVersion",
                "providerStreamId",
                "generation",
                "firstSequence",
                "nextSequence",
                "events",
                "heartbeat",
                "sourceQuality",
            }
        ),
    )
    if data["schemaVersion"] != PROVIDER_STREAM_BATCH_V1:
        raise contract_error("provider stream-batch schema is unsupported", path="schemaVersion")
    stream_id = _string(data["providerStreamId"], "providerStreamId", pattern=_OPAQUE_ID)
    generation = _integer(data["generation"], "generation", minimum=1)
    if expected_provider_stream_id is not None and stream_id != expected_provider_stream_id:
        raise contract_error("provider stream ID drifted", path="providerStreamId")
    if expected_generation is not None and generation != expected_generation:
        raise contract_error("provider stream generation drifted", path="generation")
    first = _integer(data["firstSequence"], "firstSequence", minimum=1)
    next_sequence = _integer(data["nextSequence"], "nextSequence", minimum=1)
    raw_events = data["events"]
    if isinstance(raw_events, (str, bytes)) or not isinstance(raw_events, Sequence):
        raise contract_error("stream events must be an array", path="events")
    if len(raw_events) > max_events:
        raise contract_error("stream batch exceeds Host event limit", path="events")
    events = [_stream_event(item, f"events[{index}]") for index, item in enumerate(raw_events)]
    if [item["sequence"] for item in events] != list(range(first, first + len(events))):
        raise contract_error("stream event sequences must be contiguous", path="events")
    if next_sequence != first + len(events):
        raise contract_error("nextSequence does not follow the batch", path="nextSequence")
    if expected_descriptor is not None and any(
        item["descriptor"] != expected_descriptor.to_wire() for item in events
    ):
        raise contract_error("stream event descriptor drifted", path="events")
    heartbeat = _boolean(data["heartbeat"], "heartbeat")
    if not events and not heartbeat:
        raise contract_error("empty stream batches must be heartbeats", path="heartbeat")
    return {
        "schemaVersion": PROVIDER_STREAM_BATCH_V1,
        "providerStreamId": stream_id,
        "generation": generation,
        "firstSequence": first,
        "nextSequence": next_sequence,
        "events": events,
        "heartbeat": heartbeat,
        "sourceQuality": _quality(data["sourceQuality"]),
    }


def validate_provider_stream_close(
    value: Any, *, expected_provider_stream_id: str | None = None
) -> dict[str, Any]:
    data = _object(
        value,
        "providerStreamClose",
        required=frozenset({"schemaVersion", "providerStreamId", "closed"}),
    )
    if data["schemaVersion"] != PROVIDER_STREAM_CLOSE_V1:
        raise contract_error("provider stream-close schema is unsupported", path="schemaVersion")
    stream_id = _string(data["providerStreamId"], "providerStreamId", pattern=_OPAQUE_ID)
    if expected_provider_stream_id is not None and stream_id != expected_provider_stream_id:
        raise contract_error("provider stream ID drifted", path="providerStreamId")
    return {
        "schemaVersion": PROVIDER_STREAM_CLOSE_V1,
        "providerStreamId": stream_id,
        "closed": _boolean(data["closed"], "closed"),
    }


__all__ = [
    "PROVIDER_BAR_FINALITY",
    "PROVIDER_CHANNELS",
    "PROVIDER_DATA_PLANE_V1",
    "PROVIDER_EVENT_TYPES",
    "PROVIDER_HISTORY_PAGE_V1",
    "PROVIDER_QUALITY_LEVELS",
    "PROVIDER_STREAM_BATCH_V1",
    "PROVIDER_STREAM_CLOSE_V1",
    "PROVIDER_STREAM_OPEN_V1",
    "PROVIDER_SYMBOLS_PAGE_V1",
    "ProviderHistoryRequest",
    "ProviderStreamCloseRequest",
    "ProviderStreamDescriptor",
    "ProviderStreamOpenRequest",
    "ProviderStreamPollRequest",
    "ProviderSymbolsRequest",
    "parse_provider_operation",
    "validate_provider_history_page",
    "validate_provider_stream_batch",
    "validate_provider_stream_close",
    "validate_provider_stream_open",
    "validate_provider_symbols_page",
]
