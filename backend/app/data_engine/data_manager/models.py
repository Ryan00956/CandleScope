"""
Data Manager Models — types and protocols for the unified data layer.

This module defines:
  * ``BarData``           — a single OHLCV bar in lightweight-charts format
  * ``QueryResult``       — the standard response envelope for all queries
  * ``SubscriptionHandle``— opaque handle for managing event subscriptions
  * ``DataEvent``         — unified event wrapper for the event bus
  * ``DataEventType``     — enum of event types
  * ``SeriesKey``         — typed (symbol, interval) pair
  * ``StreamInfo``        — runtime info about an active data stream

All timestamps follow the project convention:
  * Internal / storage: **milliseconds** (int)
  * Lightweight-charts output: **seconds** (``BarData.time``)
"""
from __future__ import annotations

import enum
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Awaitable, Protocol, runtime_checkable


# ═══════════════════════════════════════════════════════════════
#  Series Key
# ═══════════════════════════════════════════════════════════════


@dataclass(frozen=True, slots=True)
class SeriesKey:
    """Immutable identifier for an (exchange, market_type, symbol, interval) series.

    Usable as a dict key and set member.

    Examples::

        key = SeriesKey("BTCUSDT", "1m")
        key = SeriesKey("BTCUSDT", "1m", market_type="futures")
        cache[key] = bars
    """
    symbol: str
    interval: str
    exchange: str = "binance"
    market_type: str = "spot"  # "spot" or "futures"

    def __post_init__(self) -> None:
        # Normalize symbol to uppercase
        object.__setattr__(self, "symbol", self.symbol.upper().strip())
        object.__setattr__(self, "interval", self.interval.strip())
        object.__setattr__(self, "exchange", self.exchange.strip().lower())
        object.__setattr__(self, "market_type", self.market_type.strip().lower())

    @property
    def topic(self) -> str:
        """Event bus topic string, e.g. ``'BTCUSDT@1m'`` or ``'okx:futures:BTCUSDT@1m'``."""
        base = f"{self.symbol}@{self.interval}"
        prefixes: list[str] = []
        if self.exchange != "binance":
            prefixes.append(self.exchange)
        if self.market_type != "spot":
            prefixes.append(self.market_type)
        if prefixes:
            return f"{':'.join(prefixes)}:{base}"
        return base

    def __str__(self) -> str:
        return self.topic


# ═══════════════════════════════════════════════════════════════
#  Bar Data (lightweight-charts compatible)
# ═══════════════════════════════════════════════════════════════


@dataclass(slots=True)
class BarData:
    """A single OHLCV bar in the format expected by lightweight-charts.

    ``time`` is in **seconds** (Unix epoch).  All other fields are floats.

    This is the universal output type — every query, every event, every
    cache entry uses this structure.
    """
    time: int          # Unix seconds (for lightweight-charts)
    open: float
    high: float
    low: float
    close: float
    volume: float
    is_closed: bool = True

    def to_dict(self) -> dict:
        return {
            "time": self.time,
            "open": round(self.open, 8),
            "high": round(self.high, 8),
            "low": round(self.low, 8),
            "close": round(self.close, 8),
            "volume": round(self.volume, 8),
            "is_closed": bool(self.is_closed),
        }

    @staticmethod
    def _coerce_is_closed(value: Any, default: bool = True) -> bool:
        if value is None:
            return default
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            normalized = value.strip().lower()
            if normalized in {"false", "0", "no", "n", "open", "forming"}:
                return False
            if normalized in {"true", "1", "yes", "y", "closed", "final"}:
                return True
        return bool(value)

    @classmethod
    def from_dict(cls, d: dict) -> BarData:
        """Create from a dict with ``time, open, high, low, close, volume``.

        Accepts both seconds and milliseconds for ``time`` — if the value
        looks like milliseconds (> 1e12) it is auto-converted.
        """
        t = int(d["time"])
        if t > 1_000_000_000_000:  # milliseconds → seconds
            t = t // 1000
        return cls(
            time=t,
            open=float(d["open"]),
            high=float(d["high"]),
            low=float(d["low"]),
            close=float(d["close"]),
            volume=float(d.get("volume", 0)),
            is_closed=cls._coerce_is_closed(
                d.get("is_closed", d.get("isClosed")),
                default=True,
            ),
        )

    @classmethod
    def from_storage_row(cls, row: dict) -> BarData:
        """Create from a storage/SQLite row dict (open_time in ms)."""
        return cls(
            time=int(row["open_time"]) // 1000,
            open=round(float(row["open"]), 8),
            high=round(float(row["high"]), 8),
            low=round(float(row["low"]), 8),
            close=round(float(row["close"]), 8),
            volume=round(float(row.get("volume", 0)), 8),
            is_closed=cls._coerce_is_closed(row.get("is_closed"), default=True),
        )

    @classmethod
    def from_bar_state(cls, bar_state: Any, is_closed: bool | None = None) -> BarData:
        """Create from a ``bar_aggregator.BarState`` instance."""
        if is_closed is None:
            status = getattr(bar_state, "status", None)
            is_closed = getattr(status, "value", status) == "closed"
        return cls(
            time=bar_state.bucket_start_ms // 1000,
            open=round(bar_state.open, 8),
            high=round(bar_state.high, 8),
            low=round(bar_state.low, 8),
            close=round(bar_state.close, 8),
            volume=round(bar_state.volume, 8),
            is_closed=bool(is_closed),
        )

    def with_closed_state(self, is_closed: bool) -> BarData:
        """Return a copy with the same OHLCV values and explicit close state."""
        return BarData(
            time=self.time,
            open=self.open,
            high=self.high,
            low=self.low,
            close=self.close,
            volume=self.volume,
            is_closed=bool(is_closed),
        )

    @property
    def time_ms(self) -> int:
        """Convenience: time in milliseconds."""
        return self.time * 1000


# ═══════════════════════════════════════════════════════════════
#  Query Result
# ═══════════════════════════════════════════════════════════════


class QuerySource(str, enum.Enum):
    """Where the data came from."""
    CACHE = "cache"
    STORAGE = "storage"
    BACKFILL = "backfill"
    MIXED = "mixed"            # cache + storage/backfill combined
    EMPTY = "empty"


@dataclass(slots=True)
class MissingRange:
    """A storage gap detected during a query."""

    symbol: str
    interval: str
    start_ms: int
    end_ms: int
    exchange: str = "binance"
    market_type: str = "spot"
    reason: str = "query_gap"
    missing_bars: int | None = None
    status: str = "detected"

    def to_dict(self) -> dict:
        payload = {
            "symbol": self.symbol,
            "interval": self.interval,
            "exchange": self.exchange,
            "market_type": self.market_type,
            "start_ms": self.start_ms,
            "end_ms": self.end_ms,
            "reason": self.reason,
            "status": self.status,
        }
        if self.missing_bars is not None:
            payload["missing_bars"] = self.missing_bars
        return payload


@dataclass(slots=True)
class QueryResult:
    """Standard response envelope for all bar queries.

    Every query method in DataManager returns this structure.

    Attributes:
        bars:        The requested OHLCV bars, sorted by time ascending.
        symbol:      Normalized symbol.
        interval:    Requested interval.
        source:      Where the data came from.
        total:       Number of bars returned.
        has_more:    Whether older data is available beyond this result.
        cache_hit:   Whether the query was (partially) served from cache.
        backfill_triggered:
                     Whether a backfill was triggered to fill gaps.
        missing_ranges:
                     Structured missing ranges detected by QueryEngine.
        metadata:    Arbitrary extra info (bounds, timing, etc.).
    """
    bars: list[BarData] = field(default_factory=list)
    symbol: str = ""
    interval: str = ""
    exchange: str = "binance"
    market_type: str = "spot"
    source: QuerySource = QuerySource.EMPTY
    total: int = 0
    has_more: bool = False
    cache_hit: bool = False
    backfill_triggered: bool = False
    has_tail_gap: bool = False
    missing_ranges: list[MissingRange] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "symbol": self.symbol,
            "interval": self.interval,
            "exchange": self.exchange,
            "market_type": self.market_type,
            "source": self.source.value,
            "total": self.total,
            "has_more": self.has_more,
            "cache_hit": self.cache_hit,
            "backfill_triggered": self.backfill_triggered,
            "has_tail_gap": self.has_tail_gap,
            "missing_ranges": [r.to_dict() for r in self.missing_ranges],
            "data": [b.to_dict() for b in self.bars],
            "metadata": self.metadata,
        }

    @property
    def data(self) -> list[dict]:
        """Convenience: bars as list of dicts (for JSON serialization)."""
        return [b.to_dict() for b in self.bars]


# ═══════════════════════════════════════════════════════════════
#  Event Types & Data Events
# ═══════════════════════════════════════════════════════════════


class DataEventType(str, enum.Enum):
    """Types of events flowing through the Data Manager event bus."""
    BAR_CREATED = "bar.created"     # new bar bucket started
    BAR_UPDATED = "bar.updated"     # bar OHLCV updated (live tick)
    BAR_CLOSED = "bar.closed"       # bar finalized — most important!
    BAR_AMENDED = "bar.amended"     # historical bar corrected (backfill)
    BAR_EXPIRED = "bar.expired"     # bar evicted from memory
    STREAM_STARTED = "stream.started"
    STREAM_STOPPED = "stream.stopped"
    STREAM_ERROR = "stream.error"
    BACKFILL_STARTED = "backfill.started"
    BACKFILL_COMPLETED = "backfill.completed"
    BACKFILL_FAILED = "backfill.failed"
    CACHE_PREWARM = "cache.prewarm"
    CACHE_EVICTION = "cache.eviction"
    PRICE_UPDATED = "price.updated"


USER_VISIBLE_BACKFILL_REASONS: frozenset[str] = frozenset({
    "initial_history",
    "visible_load_more",
    "visible_range_gap",
    "visible_seed_gap",
    "tail_gap",
})

INTERNAL_BACKFILL_REASONS: frozenset[str] = frozenset({
    "related_interval_warmup",
    "full_subscription_warmup",
    "startup_gap_scan",
    "background_gap_audit",
    "latest_refresh",
    "query_gap",
    "query_empty",
    "query_tail_gap",
    "query_left_gap",
    "query_shortfall",
    "query_interior_gap",
    "price_daily_open",
})


def audience_for_backfill_reason(reason: str | None) -> str:
    """Classify a backfill completion for browser delivery."""
    parts = [
        part.strip()
        for part in str(reason or "").split("+")
        if part.strip()
    ]
    if any(part in USER_VISIBLE_BACKFILL_REASONS for part in parts):
        return "user"
    return "internal"


@dataclass(slots=True)
class DataEvent:
    """Unified event wrapper for the event bus.

    All events in the Data Manager flow through this envelope.

    Attributes:
        event_type:   What kind of event this is.
        key:          The (symbol, interval) this event relates to.
        bar:          The bar data (for bar events).
        previous_bar: The previous bar (for AMENDED events).
        detail:       Arbitrary extra data (error messages, etc.).
        timestamp_ms: When this event was created.
    """
    event_type: DataEventType
    key: SeriesKey
    bar: BarData | None = None
    previous_bar: BarData | None = None
    detail: dict[str, Any] = field(default_factory=dict)
    audience: str = "user"
    timestamp_ms: int = field(default_factory=lambda: int(time.time() * 1000))

    def to_dict(self) -> dict:
        d: dict[str, Any] = {
            "event_type": self.event_type.value,
            "audience": self.audience,
            "exchange": self.key.exchange,
            "symbol": self.key.symbol,
            "interval": self.key.interval,
            "market_type": self.key.market_type,
            "timestamp_ms": self.timestamp_ms,
        }
        if self.bar is not None:
            d["bar"] = self.bar.to_dict()
        if self.previous_bar is not None:
            d["previous_bar"] = self.previous_bar.to_dict()
        if self.detail:
            d["detail"] = self.detail
        return d


# ═══════════════════════════════════════════════════════════════
#  Subscription Handle
# ═══════════════════════════════════════════════════════════════

# Callback signature for event subscribers
EventCallback = Callable[[DataEvent], Awaitable[None]]


@dataclass(slots=True)
class SubscriptionHandle:
    """Opaque handle returned when subscribing to events.

    Pass this handle to ``unsubscribe()`` to stop receiving events.
    The ``id`` is auto-generated and globally unique.

    Attributes:
        id:        Unique subscription identifier.
        key:       The (symbol, interval) subscribed to (None = all).
        event_types:
                   Filter by event types (None = all types).
        callback:  The registered callback.
        created_at_ms: When the subscription was created.
    """
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    key: SeriesKey | None = None
    event_types: set[DataEventType] | None = None
    callback: EventCallback | None = None
    created_at_ms: int = field(default_factory=lambda: int(time.time() * 1000))

    def matches(self, event: DataEvent) -> bool:
        """Return True if this subscription should receive the event."""
        if self.key is not None and event.key != self.key:
            return False
        if self.event_types is not None and event.event_type not in self.event_types:
            return False
        return True


# ═══════════════════════════════════════════════════════════════
#  Stream Info
# ═══════════════════════════════════════════════════════════════


class StreamStatus(str, enum.Enum):
    """Runtime status of a managed data stream."""
    STARTING = "starting"
    ACTIVE = "active"
    IDLE = "idle"           # no subscribers, waiting to be reaped
    STOPPING = "stopping"
    STOPPED = "stopped"
    ERROR = "error"


@dataclass(slots=True)
class StreamInfo:
    """Runtime information about an active data stream.

    Attributes:
        key:              The (symbol, interval) this stream serves.
        status:           Current lifecycle status.
        subscriber_count: Number of active subscribers.
        bars_received:    Total bars received since stream start.
        last_bar_at_ms:   Timestamp of the last bar received.
        started_at_ms:    When the stream was started.
        error:            Last error message (if status == ERROR).
    """
    key: SeriesKey
    status: StreamStatus = StreamStatus.STOPPED
    subscriber_count: int = 0
    bars_received: int = 0
    last_bar_at_ms: int = 0
    started_at_ms: int = 0
    error: str | None = None

    def to_dict(self) -> dict:
        return {
            "exchange": self.key.exchange,
            "symbol": self.key.symbol,
            "interval": self.key.interval,
            "market_type": self.key.market_type,
            "topic": self.key.topic,
            "status": self.status.value,
            "subscriber_count": self.subscriber_count,
            "bars_received": self.bars_received,
            "last_bar_at_ms": self.last_bar_at_ms,
            "started_at_ms": self.started_at_ms,
            "error": self.error,
        }


# ═══════════════════════════════════════════════════════════════
#  Storage Protocol (for dependency injection)
# ═══════════════════════════════════════════════════════════════


@runtime_checkable
class StorageBackend(Protocol):
    """Protocol that the Data Manager uses to read/write persistent bars.

    The default implementation wraps ``klines_repo.py``.  Users can
    provide their own implementation (PostgreSQL, ClickHouse, etc.)
    by implementing this protocol.

    All timestamps are in **milliseconds**.
    """

    def query_bars(
        self,
        symbol: str,
        interval: str,
        start_ms: int | None = None,
        end_ms: int | None = None,
        limit: int | None = None,
        order: str = "ASC",
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> list[dict]:
        """Query bars from storage.  Returns list of row dicts."""
        ...

    def upsert_bars(
        self,
        symbol: str,
        interval: str,
        rows: list[dict],
        source: str = "data_manager",
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> int:
        """Insert or update bars.  Returns number of rows written."""
        ...

    def get_bounds(
        self, symbol: str, interval: str, exchange: str = "binance", market_type: str = "spot",
    ) -> dict:
        """Return {earliest_open_time, latest_open_time, total_count}."""
        ...

    def delete_bars(
        self,
        symbol: str,
        interval: str,
        start_ms: int | None = None,
        end_ms: int | None = None,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> int:
        """Delete bars in range.  Returns number of rows deleted."""
        ...

    def fetch_before(
        self,
        symbol: str,
        interval: str,
        before_ms: int,
        limit: int = 500,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> list[dict]:
        """Fetch bars before a timestamp, ordered ASC."""
        ...

    def delete_oldest(
        self,
        symbol: str,
        interval: str,
        keep: int,
    ) -> int:
        """Delete oldest bars, keeping only the most recent *keep* rows.

        Returns the number of rows actually deleted.
        """
        ...
