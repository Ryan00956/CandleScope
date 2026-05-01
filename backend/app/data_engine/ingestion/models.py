"""
Ingestion Data Models — the lingua franca of the ingestion pipeline.

Every layer speaks these types.  No raw dicts leaking between layers.

The ingestion pipeline is a **generic market data intake** layer.  It does
NOT produce domain-specific structures like K-line bars — that is the
responsibility of downstream modules such as bar aggregation.

Core output type: ``MarketEvent`` — a unified, exchange-agnostic envelope
for any kind of real-time market data (kline snapshots, trades, tickers,
depth updates, etc.).
"""
from __future__ import annotations

import enum
from dataclasses import dataclass
from typing import Any


# ─── Enums ────────────────────────────────────────────────────


class StreamType(str, enum.Enum):
    """Supported market data stream types."""
    KLINE = "kline"              # @kline_<interval>  (exchange-aggregated candles)
    AGG_TRADE = "aggTrade"       # @aggTrade           (aggregated trades)
    TRADE = "trade"              # @trade              (raw trades)
    TICKER = "ticker"            # @ticker             (24h rolling ticker)
    MINI_TICKER = "miniTicker"   # @miniTicker         (lightweight ticker)
    DEPTH = "depth"              # @depth<levels>      (order-book depth)


class FeedMode(str, enum.Enum):
    """Current data feed mechanism."""
    WEBSOCKET = "websocket"
    HTTP_POLL = "http_poll"
    IDLE = "idle"           # not yet started or stopped


class DataSource(str, enum.Enum):
    """Where a particular data point came from."""
    WEBSOCKET = "websocket"
    HTTP = "http"
    HTTP_BACKFILL = "http_backfill"   # gap-fill fetches
    MOCK = "mock"


class SessionHealth(str, enum.Enum):
    """Health status of a WebSocket session."""
    CONNECTED = "connected"
    CONNECTING = "connecting"
    RECONNECTING = "reconnecting"
    UNHEALTHY = "unhealthy"          # exceeded failure threshold
    DISCONNECTED = "disconnected"


# ─── Stream Descriptor ───────────────────────────────────────


@dataclass(slots=True)
class StreamDescriptor:
    """Uniquely identifies a data stream.

    Examples:
        StreamDescriptor("BTCUSDT", StreamType.KLINE, interval="1m")
        StreamDescriptor("BTCUSDT", StreamType.AGG_TRADE)
        StreamDescriptor("ETHUSDT", StreamType.TICKER)
    """
    symbol: str
    stream_type: StreamType
    interval: str | None = None     # only for KLINE streams
    depth_levels: int | None = None  # only for DEPTH streams (5, 10, 20)
    exchange: str = "binance"
    market_type: str = "spot"       # "spot" or "futures"

    @property
    def key(self) -> str:
        """Unique pipeline key, e.g. 'BTCUSDT@kline_1m', 'okx:futures:BTCUSDT@kline_1m'."""
        symbol = self.symbol.upper()
        if self.stream_type == StreamType.KLINE:
            base = f"{symbol}@kline_{self.interval}"
        elif self.stream_type == StreamType.DEPTH and self.depth_levels:
            base = f"{symbol}@depth{self.depth_levels}"
        else:
            base = f"{symbol}@{self.stream_type.value}"
        prefixes: list[str] = []
        if self.exchange.strip().lower() != "binance":
            prefixes.append(self.exchange.strip().lower())
        if self.market_type != "spot":
            prefixes.append(self.market_type)
        if prefixes:
            return f"{':'.join(prefixes)}:{base}"
        return base

    @property
    def ws_stream_name(self) -> str:
        """Binance WS stream name, e.g. 'btcusdt@kline_1m', 'btcusdt@aggTrade'."""
        symbol = self.symbol.lower()
        if self.stream_type == StreamType.KLINE:
            return f"{symbol}@kline_{self.interval}"
        if self.stream_type == StreamType.DEPTH and self.depth_levels:
            return f"{symbol}@depth{self.depth_levels}"
        return f"{symbol}@{self.stream_type.value}"

    def validate(self) -> None:
        """Raise ValueError if the descriptor is invalid."""
        if self.stream_type == StreamType.KLINE and not self.interval:
            raise ValueError("KLINE stream requires an interval (e.g. '1m')")


# ─── Core Output: MarketEvent ────────────────────────────────


@dataclass(slots=True)
class MarketEvent:
    """A single normalized market data event — the universal output of the
    ingestion pipeline.

    All timestamps are in **milliseconds** (exchange convention).

    The ``data`` dict contains stream-type-specific fields in a
    standardized format.  See ``normalize.py`` for the exact schema
    per ``StreamType``.
    """
    event_type: StreamType          # kline / aggTrade / trade / ticker / ...
    symbol: str                     # "BTCUSDT"
    exchange: str                   # "binance"
    event_time_ms: int              # event timestamp from exchange (ms)
    received_at_ms: int             # local receive timestamp (ms)
    source: DataSource              # websocket / http / http_backfill / mock
    data: dict[str, Any]            # standardized payload (schema varies by event_type)
    stream_key: str = ""            # pipeline key, e.g. "BTCUSDT@kline_1m"
    sequence: int | None = None     # optional sequence/ID for dedup (trade_id, etc.)

    # ── Convenience ──

    def to_dict(self) -> dict:
        """Full dict representation for serialization / debugging."""
        return {
            "event_type": self.event_type.value,
            "symbol": self.symbol,
            "exchange": self.exchange,
            "event_time_ms": self.event_time_ms,
            "received_at_ms": self.received_at_ms,
            "source": self.source.value,
            "data": self.data,
            "stream_key": self.stream_key,
            "sequence": self.sequence,
        }

    @property
    def dedup_key(self) -> str | int | None:
        """Return a key suitable for deduplication.

        - Kline (closed): open_time
        - Kline (not closed): None (never dedup live updates)
        - AggTrade: agg_trade_id
        - Trade: trade_id
        - Others: None (no dedup)
        """
        if self.event_type == StreamType.KLINE:
            is_closed = self.data.get("is_closed", True)
            if not is_closed:
                return None  # never dedup live kline updates
            return self.data.get("open_time")
        if self.event_type == StreamType.AGG_TRADE:
            return self.data.get("agg_trade_id")
        if self.event_type == StreamType.TRADE:
            return self.data.get("trade_id")
        return None

    @property
    def continuity_key(self) -> int | None:
        """Return a sortable key for continuity/gap detection.

        - Kline: open_time (ms)
        - AggTrade: agg_trade_id
        - Trade: trade_id
        - Others: None
        """
        if self.event_type == StreamType.KLINE:
            return self.data.get("open_time")
        if self.event_type == StreamType.AGG_TRADE:
            return self.data.get("agg_trade_id")
        if self.event_type == StreamType.TRADE:
            return self.data.get("trade_id")
        return None


# ─── Gap Marker ──────────────────────────────────────────────


@dataclass(slots=True)
class GapMarker:
    """Marks a detected gap in the data stream.

    Emitted by L5 (Continuity) when consecutive events are not adjacent.
    The meaning of gap_start / gap_end depends on the stream type:
      - Kline: open_time (ms)
      - Trade/AggTrade: trade ID
    """
    stream_key: str          # pipeline key
    symbol: str
    stream_type: StreamType
    gap_start: int           # last seen continuity_key before gap
    gap_end: int             # first continuity_key after gap
    expected_count: int      # how many events are missing (estimate)
    filled: bool = False     # True if auto-fill succeeded

    def to_dict(self) -> dict:
        return {
            "type": "gap",
            "stream_key": self.stream_key,
            "symbol": self.symbol,
            "stream_type": self.stream_type.value,
            "gap_start": self.gap_start,
            "gap_end": self.gap_end,
            "expected_count": self.expected_count,
            "filled": self.filled,
        }


# ─── Raw message (internal, between L1-L4) ───────────────────


@dataclass(slots=True)
class RawMessage:
    """Raw message from transport, before normalization.

    Carries the original payload plus metadata about where it came from.
    L4 (Normalize) consumes this and produces MarketEvent.
    """
    payload: dict | list          # raw JSON from exchange
    source: DataSource
    stream_type: StreamType
    received_at_ms: int           # local timestamp when we received it
    endpoint: str = ""            # which URL / endpoint delivered this




@dataclass(slots=True)
class TransportRequest:
    """A request descriptor for L1 Transport to execute."""
    descriptor: StreamDescriptor
    limit: int = 1
    start_ms: int | None = None
    end_ms: int | None = None

    # Convenience properties for backward compat
    @property
    def symbol(self) -> str:
        return self.descriptor.symbol

    @property
    def interval(self) -> str | None:
        return self.descriptor.interval

    @property
    def stream_type(self) -> StreamType:
        return self.descriptor.stream_type


# ─── Delivery envelope ───────────────────────────────────────


@dataclass(slots=True)
class IngestionEvent:
    """Wrapper emitted by L6 Delivery.

    Consumers receive this and check ``event_type`` to decide handling.
    """
    event_type: str                         # "market_event" | "gap" | "status"
    market_event: MarketEvent | None = None
    gap: GapMarker | None = None
    status: dict | None = None              # arbitrary status payload

    def to_dict(self) -> dict:
        d: dict[str, Any] = {"event_type": self.event_type}
        if self.market_event is not None:
            d["market_event"] = self.market_event.to_dict()
        if self.gap is not None:
            d["gap"] = self.gap.to_dict()
        if self.status is not None:
            d["status"] = self.status
        return d
