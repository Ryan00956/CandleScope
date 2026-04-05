"""
Bar Aggregator Data Models — types, enums, and abstract interfaces.

This module defines all data structures and protocols used across
the Bar Aggregator pipeline:

  * Enums: BarInputSource, BarStatus, BarEventType, BarStateChange
  * Dataclasses: BarInput, BarState, BarEvent
  * Protocols: BarInputAdapter, BucketCalculator, BarMergeStrategy,
               FinalizerStrategy

All timestamps are in **milliseconds** (consistent with ingestion/backfill).
"""
from __future__ import annotations

import enum
import time
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable


# ═══════════════════════════════════════════════════════════════
#  Enums
# ═══════════════════════════════════════════════════════════════


class BarInputSource(str, enum.Enum):
    """Where a BarInput originated."""
    REALTIME = "realtime"          # from ingestion WS/HTTP live feed
    BACKFILL = "backfill"          # from backfill engine historical data
    MANUAL = "manual"              # user-injected data
    ADAPTER = "adapter"            # from a user-registered adapter


class BarSourceMode(str, enum.Enum):
    """Which raw data to use for building bars."""
    KLINE = "kline"                # use exchange kline events (default)
    TRADE = "trade"                # build bars from raw trade / aggTrade events
    AUTO = "auto"                  # prefer kline, fallback to trade


class BarStatus(str, enum.Enum):
    """Lifecycle status of a bar being formed."""
    FORMING = "forming"            # actively receiving data
    CLOSED = "closed"              # sealed — no more updates expected
    EXPIRED = "expired"            # evicted from memory (too old)


class BarEventType(str, enum.Enum):
    """Types of bar lifecycle events emitted by the Publisher."""
    CREATED = "bar.created"        # new bucket started
    UPDATED = "bar.updated"        # OHLCV updated within current bucket
    CLOSED = "bar.closed"          # bucket sealed (most important!)
    AMENDED = "bar.amended"        # historical bar corrected (backfill overwrite)
    EXPIRED = "bar.expired"        # bar evicted from memory


class BarStateChange(str, enum.Enum):
    """What happened when a BarInput was applied to BarState."""
    CREATED = "created"            # brand-new bucket started
    UPDATED = "updated"            # existing bucket updated
    AMENDED = "amended"            # historical bar corrected/overwritten
    NO_CHANGE = "no_change"        # input was redundant / no-op


class AlignmentMode(str, enum.Enum):
    """How custom-interval bucket boundaries are aligned.

    Mirrors ``backfill.models.AlignmentMode`` for consistency.
    """
    EPOCH = "epoch"                # align to Unix epoch 0 (default)
    MIDNIGHT = "midnight"          # align to UTC midnight
    MARKET = "market"              # align to exchange market-open time
    CUSTOM = "custom"              # user-provided epoch_ms
    NONE = "none"                  # no alignment; start from data


# ═══════════════════════════════════════════════════════════════
#  BarInput — unified input into the aggregation pipeline
# ═══════════════════════════════════════════════════════════════


@dataclass(slots=True)
class BarInput:
    """Unified input for bar aggregation.

    Every data source (WS kline, HTTP kline, aggTrade, FetchedBar, manual)
    is converted into this structure before entering the pipeline.

    All timestamps in milliseconds.
    """
    symbol: str
    source_interval: str           # original interval (e.g. "1m")
    open_time_ms: int              # start time of the source bar/event
    close_time_ms: int             # end time of the source bar/event
    open: float
    high: float
    low: float
    close: float
    volume: float
    source: BarInputSource         # where this came from
    is_closed: bool                # whether the source bar is closed
    exchange: str = "binance"
    market_type: str = "spot"
    quote_volume: float = 0.0
    trades: int = 0
    taker_buy_base: float = 0.0
    taker_buy_quote: float = 0.0
    sequence: int | None = None    # for ordering / dedup
    extra: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.symbol = self.symbol.upper().strip()
        self.exchange = self.exchange.strip().lower()
        self.market_type = self.market_type.strip().lower()

    @property
    def input_key(self) -> str:
        """Unique key for dedup: symbol@interval:open_time."""
        return (
            f"{self.exchange}:{self.market_type}:{self.symbol}"
            f"@{self.source_interval}:{self.open_time_ms}"
        )

    def to_dict(self) -> dict:
        return {
            "symbol": self.symbol,
            "exchange": self.exchange,
            "market_type": self.market_type,
            "source_interval": self.source_interval,
            "open_time_ms": self.open_time_ms,
            "close_time_ms": self.close_time_ms,
            "open": self.open,
            "high": self.high,
            "low": self.low,
            "close": self.close,
            "volume": self.volume,
            "source": self.source.value,
            "is_closed": self.is_closed,
            "quote_volume": self.quote_volume,
            "trades": self.trades,
        }


# ═══════════════════════════════════════════════════════════════
#  BarState — the current state of a forming/closed bar
# ═══════════════════════════════════════════════════════════════


@dataclass(slots=True)
class BarState:
    """The accumulated OHLCV state for a single time bucket.

    Represents one bar (candle) being built or already closed.
    """
    symbol: str
    interval: str                  # target interval (e.g. "91m")
    bucket_start_ms: int           # bucket start time
    bucket_end_ms: int             # bucket end time (exclusive)
    open: float
    high: float
    low: float
    close: float
    volume: float
    exchange: str = "binance"
    market_type: str = "spot"
    quote_volume: float = 0.0
    trades: int = 0
    taker_buy_base: float = 0.0
    taker_buy_quote: float = 0.0
    tick_count: int = 0            # how many BarInputs were merged
    first_input_at_ms: int = 0     # open_time of the first input
    last_input_at_ms: int = 0      # open_time of the last input
    last_close_received: bool = False  # did we receive is_closed=True for the last component?
    source_snapshots: dict[str, dict[str, Any]] = field(default_factory=dict)
    status: BarStatus = BarStatus.FORMING
    created_at_ms: int = field(default_factory=lambda: int(time.time() * 1000))
    updated_at_ms: int = field(default_factory=lambda: int(time.time() * 1000))

    def __post_init__(self) -> None:
        self.symbol = self.symbol.upper().strip()
        self.exchange = self.exchange.strip().lower()
        self.market_type = self.market_type.strip().lower()

    def to_dict(self) -> dict:
        return {
            "symbol": self.symbol,
            "exchange": self.exchange,
            "market_type": self.market_type,
            "interval": self.interval,
            "bucket_start_ms": self.bucket_start_ms,
            "bucket_end_ms": self.bucket_end_ms,
            "open": self.open,
            "high": self.high,
            "low": self.low,
            "close": self.close,
            "volume": self.volume,
            "quote_volume": self.quote_volume,
            "trades": self.trades,
            "taker_buy_base": self.taker_buy_base,
            "taker_buy_quote": self.taker_buy_quote,
            "tick_count": self.tick_count,
            "first_input_at_ms": self.first_input_at_ms,
            "last_input_at_ms": self.last_input_at_ms,
            "last_close_received": self.last_close_received,
            "status": self.status.value,
            "created_at_ms": self.created_at_ms,
            "updated_at_ms": self.updated_at_ms,
        }

    def to_ohlcv(self) -> dict:
        """Lightweight OHLCV dict for charting / storage."""
        return {
            "time": self.bucket_start_ms // 1000,  # seconds for lightweight-charts
            "open": self.open,
            "high": self.high,
            "low": self.low,
            "close": self.close,
            "volume": self.volume,
        }

    def to_storage_dict(self) -> dict:
        """Full dict for database storage."""
        return {
            "open_time": self.bucket_start_ms,
            "close_time": self.bucket_end_ms - 1,  # inclusive end
            "open": self.open,
            "high": self.high,
            "low": self.low,
            "close": self.close,
            "volume": self.volume,
            "quote_volume": self.quote_volume,
            "trades": self.trades,
            "taker_buy_base": self.taker_buy_base,
            "taker_buy_quote": self.taker_buy_quote,
        }


# ═══════════════════════════════════════════════════════════════
#  BarEvent — lifecycle event emitted by the Publisher
# ═══════════════════════════════════════════════════════════════


@dataclass(slots=True)
class BarEvent:
    """A bar lifecycle event.

    Downstream consumers subscribe to these events to react to bar
    creation, updates, and closures.
    """
    event_type: BarEventType
    bar: BarState
    timestamp_ms: int = field(default_factory=lambda: int(time.time() * 1000))

    # For AMENDED events — the old bar state before amendment
    previous_bar: BarState | None = None

    def to_dict(self) -> dict:
        d: dict[str, Any] = {
            "event_type": self.event_type.value,
            "bar": self.bar.to_dict(),
            "timestamp_ms": self.timestamp_ms,
        }
        if self.previous_bar is not None:
            d["previous_bar"] = self.previous_bar.to_dict()
        return d

    @property
    def bar_key(self) -> str:
        """Unique key for this bar: symbol@interval:bucket_start."""
        return (
            f"{self.bar.exchange}:{self.bar.market_type}:{self.bar.symbol}"
            f"@{self.bar.interval}:{self.bar.bucket_start_ms}"
        )


# ═══════════════════════════════════════════════════════════════
#  FinalizeTrigger — context passed to Finalizer strategies
# ═══════════════════════════════════════════════════════════════


@dataclass(slots=True)
class FinalizeTrigger:
    """Context provided to finalizer strategies to decide whether to close a bar.

    Attributes:
        trigger_type:      What caused this check ("input", "timer", "flush", "next_bucket")
        input:             The BarInput that triggered this check (if any)
        current_time_ms:   Current wall-clock time (ms)
        next_bucket_start: Start of the next bucket (if a new bucket event triggered this)
        is_backfill:       Whether this is a backfill scenario (batch close)
    """
    trigger_type: str              # "input" | "timer" | "flush" | "next_bucket"
    input: BarInput | None = None
    current_time_ms: int = field(default_factory=lambda: int(time.time() * 1000))
    next_bucket_start: int | None = None
    is_backfill: bool = False


# ═══════════════════════════════════════════════════════════════
#  BarEventFilter — for selective subscription
# ═══════════════════════════════════════════════════════════════


@dataclass(slots=True)
class BarEventFilter:
    """Filter for selective bar event subscription.

    All fields are optional.  An event passes the filter if it matches
    ALL specified criteria (AND logic).  Unset fields match everything.
    """
    exchanges: set[str] | None = None         # only these exchanges
    market_types: set[str] | None = None      # only these market types
    symbols: set[str] | None = None           # only these symbols
    intervals: set[str] | None = None         # only these intervals
    event_types: set[BarEventType] | None = None  # only these event types

    def matches(self, event: BarEvent) -> bool:
        if self.exchanges and event.bar.exchange not in self.exchanges:
            return False
        if self.market_types and event.bar.market_type not in self.market_types:
            return False
        if self.symbols and event.bar.symbol not in self.symbols:
            return False
        if self.intervals and event.bar.interval not in self.intervals:
            return False
        if self.event_types and event.event_type not in self.event_types:
            return False
        return True


# ═══════════════════════════════════════════════════════════════
#  Protocol Interfaces — user-extensible hooks
# ═══════════════════════════════════════════════════════════════


@runtime_checkable
class BarInputAdapter(Protocol):
    """User-implementable protocol to adapt custom data sources into BarInput.

    Register adapters with ``EventRouter.register_adapter()`` to support
    any data format or exchange.

    Example — adapting a custom CSV feed::

        class CsvAdapter:
            def adapt(self, raw_data):
                row = raw_data  # assume dict
                return BarInput(
                    symbol=row["sym"],
                    source_interval="1m",
                    open_time_ms=row["ts"] * 1000,
                    ...
                )
        router.register_adapter("csv_feed", CsvAdapter())
    """
    def adapt(self, raw_data: Any) -> BarInput | None:
        """Convert raw data into a BarInput, or None to skip."""
        ...


@runtime_checkable
class BucketCalculator(Protocol):
    """User-implementable protocol to override time bucket calculation.

    Replace the default ``TimeBucketEngine`` logic for exotic bucketing
    schemes (e.g. session-based, volume-based, tick-count-based).

    Example — session-based buckets::

        class SessionBucket:
            def compute_bucket(self, open_time_ms):
                # align to US market session start (14:30 UTC)
                ...
            def compute_bucket_range(self, bucket_start_ms):
                # return (start, end) for this session
                ...
    """
    def compute_bucket(self, open_time_ms: int) -> int:
        """Return the bucket_start_ms for the given timestamp."""
        ...

    def compute_bucket_range(self, bucket_start_ms: int) -> tuple[int, int]:
        """Return (bucket_start_ms, bucket_end_ms) for the given bucket."""
        ...


@runtime_checkable
class BarMergeStrategy(Protocol):
    """User-implementable protocol to customize OHLCV merge logic.

    The default strategy is standard OHLCV:
      O = first open, H = max(high), L = min(low), C = last close, V = sum(volume)

    Override this for exotic bar types like Heikin-Ashi, Renko, etc.

    Example — Heikin-Ashi::

        class HeikinAshiMerge:
            def apply(self, state, input, is_new):
                if is_new:
                    ha_open = (prev_open + prev_close) / 2  # from previous bar
                    ...
                return updated_state
    """
    def apply(self, state: BarState, bar_input: BarInput, is_new: bool) -> BarState:
        """Apply a BarInput to a BarState.

        Args:
            state:     Current bar state (may be freshly created if is_new=True)
            bar_input: The input to merge
            is_new:    True if this is the first input for this bucket

        Returns:
            Updated BarState (may be the same object mutated, or a new one)
        """
        ...


@runtime_checkable
class FinalizerStrategy(Protocol):
    """User-implementable protocol for custom bar close (finalization) logic.

    Multiple strategies can be registered and are evaluated in order.
    The first strategy that returns True triggers the close.

    Example — close after N ticks::

        class TickCountFinalizer:
            def __init__(self, max_ticks: int = 100):
                self.max_ticks = max_ticks
            def should_close(self, state, trigger):
                return state.tick_count >= self.max_ticks
    """
    def should_close(self, state: BarState, trigger: FinalizeTrigger) -> bool:
        """Return True if the bar should be closed (finalized)."""
        ...


# ═══════════════════════════════════════════════════════════════
#  Interval Helpers (shared with backfill)
# ═══════════════════════════════════════════════════════════════

# Standard intervals supported by Binance
STANDARD_INTERVALS: dict[str, int] = {
    "1s": 1_000,
    "1m": 60_000,
    "3m": 180_000,
    "5m": 300_000,
    "15m": 900_000,
    "30m": 1_800_000,
    "1h": 3_600_000,
    "2h": 7_200_000,
    "4h": 14_400_000,
    "6h": 21_600_000,
    "8h": 28_800_000,
    "12h": 43_200_000,
    "1d": 86_400_000,
    "3d": 259_200_000,
    "1w": 604_800_000,
    "1M": 2_592_000_000,
}

_SUFFIX_MS: dict[str, int] = {
    "s": 1_000,
    "m": 60_000,
    "h": 3_600_000,
    "d": 86_400_000,
    "w": 604_800_000,
    "M": 2_592_000_000,
}


def parse_interval_ms(interval: str) -> int | None:
    """Parse an interval string (standard or custom) into milliseconds.

    Supports standard ("1m", "4h") and custom ("91m", "7h") intervals.

    Returns None if the string cannot be parsed.

    Examples::

        parse_interval_ms("1m")  → 60_000
        parse_interval_ms("91m") → 5_460_000
        parse_interval_ms("4h")  → 14_400_000
    """
    if interval in STANDARD_INTERVALS:
        return STANDARD_INTERVALS[interval]
    if len(interval) < 2:
        return None
    suffix = interval[-1]
    multiplier = _SUFFIX_MS.get(suffix)
    if multiplier is None:
        return None
    try:
        value = int(interval[:-1])
    except ValueError:
        return None
    if value <= 0:
        return None
    return value * multiplier


def is_standard_interval(interval: str) -> bool:
    """Return True if the interval is natively supported by the exchange."""
    return interval in STANDARD_INTERVALS
