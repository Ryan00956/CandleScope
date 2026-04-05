"""
Backfill Data Models — types, enums, and abstract interfaces for the Backfill Engine.

This module defines:
  * Enums for strategies and statuses
  * Dataclasses for gap info, plans, tasks, and reports
  * Protocol interfaces (``StorageBackend``, ``CacheBackend``) that users
    implement to plug in their own persistence layer

The Backfill Engine is storage-agnostic: it only interacts with the
``StorageBackend`` / ``CacheBackend`` protocols.  Any implementation
(SQLite, PostgreSQL, Redis, in-memory, etc.) works as long as it
satisfies the protocol.
"""
from __future__ import annotations

import enum
import time
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable


# ═══════════════════════════════════════════════════════════════
#  Enums
# ═══════════════════════════════════════════════════════════════


class AlignmentMode(str, enum.Enum):
    """How custom-interval bucket boundaries are aligned."""
    EPOCH = "epoch"          # align to a fixed epoch timestamp
    MIDNIGHT = "midnight"    # align to UTC midnight
    MARKET = "market"        # align to exchange market-open time
    NONE = "none"            # no alignment; start from gap_start


class DecompStrategy(str, enum.Enum):
    """Strategy for decomposing a custom interval into standard intervals."""
    GREEDY_DESCENDING = "greedy_descending"   # largest standard first
    MIN_REQUESTS = "min_requests"             # minimize total REST pages
    SINGLE_BASE = "single_base"               # use only one base interval


class DeduplicationStrategy(str, enum.Enum):
    """How to handle duplicate bars when reconciling."""
    SKIP = "skip"              # keep existing, discard new
    OVERWRITE = "overwrite"    # always replace with new
    NEWER_WINS = "newer_wins"  # keep whichever has a later updated_at


class BackfillStatus(str, enum.Enum):
    """Lifecycle status of a backfill run."""
    PENDING = "pending"
    DETECTING = "detecting"
    PLANNING = "planning"
    FETCHING = "fetching"
    RECONCILING = "reconciling"
    PUBLISHING = "publishing"
    COMPLETED = "completed"
    FAILED = "failed"
    PARTIAL = "partial"        # some tasks succeeded, some failed
    CANCELLED = "cancelled"


class GapType(str, enum.Enum):
    """Where the gap is relative to existing data."""
    TAIL = "tail"            # gap at the end (DB behind live data)
    HEAD = "head"            # gap at the beginning (DB starts too late)
    INTERIOR = "interior"    # hole in the middle of existing data


# ═══════════════════════════════════════════════════════════════
#  Gap Detection
# ═══════════════════════════════════════════════════════════════


@dataclass(slots=True)
class GapInfo:
    """Describes a detected gap in stored data for a specific interval.

    Attributes:
        symbol:         Trading pair, e.g. "BTCUSDT".
        interval:       K-line interval, e.g. "1m", "91m" (custom).
        gap_type:       Where the gap is (tail / head / interior).
        start_ms:       First missing open_time (ms).
        end_ms:         Last missing open_time (ms), inclusive.
        missing_bars:   Estimated number of missing bars.
        db_latest_ms:   Latest open_time currently in the DB (None if empty).
        reference_ms:   The "live edge" timestamp used as reference.
        metadata:       Arbitrary user-attached metadata.
    """
    symbol: str
    interval: str
    gap_type: GapType
    start_ms: int
    end_ms: int
    missing_bars: int
    db_latest_ms: int | None = None
    reference_ms: int | None = None
    market_type: str = "spot"
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "symbol": self.symbol,
            "interval": self.interval,
            "market_type": self.market_type,
            "gap_type": self.gap_type.value,
            "start_ms": self.start_ms,
            "end_ms": self.end_ms,
            "missing_bars": self.missing_bars,
            "db_latest_ms": self.db_latest_ms,
            "reference_ms": self.reference_ms,
            "metadata": self.metadata,
        }


# ═══════════════════════════════════════════════════════════════
#  Planner
# ═══════════════════════════════════════════════════════════════


@dataclass(slots=True)
class IntervalComponent:
    """One component in a custom-interval decomposition.

    Example: 91m decomposed → [(60m, 1), (30m, 1), (1m, 1)]
    means one 60m candle + one 30m candle + one 1m candle per custom bucket.

    Attributes:
        interval:   Standard interval string, e.g. "1h".
        count:      How many of this interval fit in one custom period.
        duration_ms: Duration of this single component in ms.
    """
    interval: str
    count: int
    duration_ms: int

    def to_dict(self) -> dict:
        return {
            "interval": self.interval,
            "count": self.count,
            "duration_ms": self.duration_ms,
        }


@dataclass(slots=True)
class IntervalDecomposition:
    """Complete decomposition of a custom interval into standard intervals.

    Attributes:
        custom_interval:    The user's custom interval string, e.g. "91m".
        custom_duration_ms: Total duration in ms.
        components:         Ordered list of IntervalComponent.
        is_standard:        True if the interval is natively supported.
        alignment_mode:     How bucket boundaries are aligned.
        alignment_epoch_ms: Epoch for alignment calculation.
    """
    custom_interval: str
    custom_duration_ms: int
    components: list[IntervalComponent]
    is_standard: bool = False
    alignment_mode: AlignmentMode = AlignmentMode.EPOCH
    alignment_epoch_ms: int = 0

    def to_dict(self) -> dict:
        return {
            "custom_interval": self.custom_interval,
            "custom_duration_ms": self.custom_duration_ms,
            "components": [c.to_dict() for c in self.components],
            "is_standard": self.is_standard,
            "alignment_mode": self.alignment_mode.value,
            "alignment_epoch_ms": self.alignment_epoch_ms,
        }


@dataclass(slots=True)
class BackfillTask:
    """A single fetch-task: retrieve bars for one standard interval + time range.

    Attributes:
        symbol:       Trading pair.
        interval:     Standard interval to fetch (e.g. "1m", "1h").
        start_ms:     Inclusive start open_time (ms).
        end_ms:       Inclusive end open_time (ms).
        priority:     Lower = higher priority (for queue ordering).
        parent_gap:   The GapInfo this task was derived from.
        estimated_bars: How many bars this task is expected to produce.
        metadata:     Arbitrary user-attached metadata.
    """
    symbol: str
    interval: str
    start_ms: int
    end_ms: int
    priority: int = 0
    parent_gap: GapInfo | None = None
    estimated_bars: int = 0
    market_type: str = "spot"
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def task_key(self) -> str:
        return (
            f"{self.market_type}:{self.symbol}"
            f"@{self.interval}:{self.start_ms}-{self.end_ms}"
        )

    def to_dict(self) -> dict:
        return {
            "symbol": self.symbol,
            "interval": self.interval,
            "market_type": self.market_type,
            "start_ms": self.start_ms,
            "end_ms": self.end_ms,
            "priority": self.priority,
            "estimated_bars": self.estimated_bars,
            "task_key": self.task_key,
            "metadata": self.metadata,
        }


@dataclass(slots=True)
class BackfillPlan:
    """A complete backfill plan: gaps → tasks → estimated cost.

    Attributes:
        gaps:                 All detected gaps that this plan addresses.
        decompositions:       Custom interval decompositions (if any).
        tasks:                Ordered list of fetch tasks.
        estimated_requests:   How many REST API calls are expected.
        estimated_bars:       Total bars expected to be fetched.
        custom_intervals:     List of custom intervals that need aggregation.
        metadata:             Arbitrary user-attached metadata.
    """
    gaps: list[GapInfo]
    decompositions: list[IntervalDecomposition] = field(default_factory=list)
    tasks: list[BackfillTask] = field(default_factory=list)
    estimated_requests: int = 0
    estimated_bars: int = 0
    custom_intervals: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "gaps": [g.to_dict() for g in self.gaps],
            "decompositions": [d.to_dict() for d in self.decompositions],
            "tasks": [t.to_dict() for t in self.tasks],
            "estimated_requests": self.estimated_requests,
            "estimated_bars": self.estimated_bars,
            "custom_intervals": self.custom_intervals,
            "metadata": self.metadata,
        }


# ═══════════════════════════════════════════════════════════════
#  Fetch Results
# ═══════════════════════════════════════════════════════════════


@dataclass(slots=True)
class FetchedBar:
    """A single OHLCV bar fetched from the exchange.

    All timestamps in milliseconds.
    """
    symbol: str
    interval: str
    open_time: int
    close_time: int
    open: float
    high: float
    low: float
    close: float
    volume: float
    market_type: str = "spot"
    quote_volume: float = 0.0
    trades: int = 0
    taker_buy_base: float = 0.0
    taker_buy_quote: float = 0.0
    source: str = "backfill"

    def to_dict(self) -> dict:
        return {
            "symbol": self.symbol,
            "interval": self.interval,
            "market_type": self.market_type,
            "open_time": self.open_time,
            "close_time": self.close_time,
            "open": self.open,
            "high": self.high,
            "low": self.low,
            "close": self.close,
            "volume": self.volume,
            "quote_volume": self.quote_volume,
            "trades": self.trades,
            "taker_buy_base": self.taker_buy_base,
            "taker_buy_quote": self.taker_buy_quote,
            "source": self.source,
        }

    def to_storage_dict(self) -> dict:
        """Format for StorageBackend.upsert_bars()."""
        return {
            "open_time": self.open_time,
            "close_time": self.close_time,
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

    def to_lightweight(self) -> dict:
        """Format for lightweight-charts / cache."""
        return {
            "time": self.open_time // 1000,
            "open": self.open,
            "high": self.high,
            "low": self.low,
            "close": self.close,
            "volume": self.volume,
        }


@dataclass(slots=True)
class FetchResult:
    """Result of executing a single BackfillTask.

    Attributes:
        task:           The task that was executed.
        bars:           Fetched bars.
        status:         success / failed / partial.
        elapsed_ms:     Time spent on this task.
        pages_fetched:  Number of REST pages fetched.
        errors:         List of error messages (if any).
    """
    task: BackfillTask
    bars: list[FetchedBar] = field(default_factory=list)
    status: BackfillStatus = BackfillStatus.COMPLETED
    elapsed_ms: int = 0
    pages_fetched: int = 0
    errors: list[str] = field(default_factory=list)

    @property
    def bars_count(self) -> int:
        return len(self.bars)

    def to_dict(self) -> dict:
        return {
            "task": self.task.to_dict(),
            "bars_count": self.bars_count,
            "status": self.status.value,
            "elapsed_ms": self.elapsed_ms,
            "pages_fetched": self.pages_fetched,
            "errors": self.errors,
        }


# ═══════════════════════════════════════════════════════════════
#  Reconciliation Results
# ═══════════════════════════════════════════════════════════════


@dataclass(slots=True)
class ReconcileResult:
    """Result of the reconciliation phase.

    Attributes:
        bars_received:        Total bars received from fetcher.
        bars_written:         Bars written to storage (new or updated).
        bars_skipped:         Bars skipped due to dedup.
        bars_deduplicated:    Bars that already existed and were handled per strategy.
        custom_bars_generated: Custom-interval aggregated bars generated.
        custom_bars_written:  Custom-interval bars written to storage.
        bars_cached:          Bars pushed to cache.
        elapsed_ms:           Time spent reconciling.
        errors:               List of error messages.
    """
    bars_received: int = 0
    bars_written: int = 0
    bars_skipped: int = 0
    bars_deduplicated: int = 0
    custom_bars_generated: int = 0
    custom_bars_written: int = 0
    bars_cached: int = 0
    elapsed_ms: int = 0
    errors: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "bars_received": self.bars_received,
            "bars_written": self.bars_written,
            "bars_skipped": self.bars_skipped,
            "bars_deduplicated": self.bars_deduplicated,
            "custom_bars_generated": self.custom_bars_generated,
            "custom_bars_written": self.custom_bars_written,
            "bars_cached": self.bars_cached,
            "elapsed_ms": self.elapsed_ms,
            "errors": self.errors,
        }


# ═══════════════════════════════════════════════════════════════
#  Repair Report
# ═══════════════════════════════════════════════════════════════


@dataclass(slots=True)
class RepairReport:
    """Final report produced by the Backfill Engine after a run.

    Attributes:
        run_id:           Unique identifier for this backfill run.
        symbol:           Trading pair.
        status:           Overall status.
        plan:             The backfill plan that was executed.
        fetch_results:    Per-task fetch results.
        reconcile_result: Reconciliation summary.
        started_at_ms:    When the run started (epoch ms).
        completed_at_ms:  When the run finished (epoch ms).
        elapsed_ms:       Total wall-clock time.
        data_preview:     Optional preview of written data.
        errors:           Top-level errors.
        metadata:         Arbitrary user-attached metadata.
    """
    run_id: str = ""
    symbol: str = ""
    status: BackfillStatus = BackfillStatus.PENDING
    plan: BackfillPlan | None = None
    fetch_results: list[FetchResult] = field(default_factory=list)
    reconcile_result: ReconcileResult | None = None
    started_at_ms: int = field(default_factory=lambda: int(time.time() * 1000))
    completed_at_ms: int = 0
    elapsed_ms: int = 0
    data_preview: list[dict] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "run_id": self.run_id,
            "symbol": self.symbol,
            "status": self.status.value,
            "plan": self.plan.to_dict() if self.plan else None,
            "fetch_results": [fr.to_dict() for fr in self.fetch_results],
            "reconcile_result": (
                self.reconcile_result.to_dict() if self.reconcile_result else None
            ),
            "started_at_ms": self.started_at_ms,
            "completed_at_ms": self.completed_at_ms,
            "elapsed_ms": self.elapsed_ms,
            "data_preview": self.data_preview,
            "errors": self.errors,
            "metadata": self.metadata,
        }


# ═══════════════════════════════════════════════════════════════
#  Abstract Interfaces (Protocols)
# ═══════════════════════════════════════════════════════════════


@runtime_checkable
class StorageBackend(Protocol):
    """Abstract storage interface that the Backfill Engine writes to.

    Implement this protocol to plug in any persistence layer
    (SQLite, PostgreSQL, ClickHouse, InfluxDB, etc.).

    All timestamps are in milliseconds.  Bars are dicts with at minimum::

        {
            "open_time": int,    # ms
            "close_time": int,   # ms
            "open": float,
            "high": float,
            "low": float,
            "close": float,
            "volume": float,
        }

    Additional fields (quote_volume, trades, taker_buy_base, taker_buy_quote)
    are optional but recommended.
    """

    async def get_latest_time(self, symbol: str, interval: str, market_type: str = "spot") -> int | None:
        """Return the latest open_time (ms) stored, or None if empty."""
        ...

    async def get_earliest_time(self, symbol: str, interval: str, market_type: str = "spot") -> int | None:
        """Return the earliest open_time (ms) stored, or None if empty."""
        ...

    async def query_time_range(
        self, symbol: str, interval: str, start_ms: int, end_ms: int,
        market_type: str = "spot",
    ) -> list[dict]:
        """Return all bars within [start_ms, end_ms], ordered by open_time ASC."""
        ...

    async def upsert_bars(
        self,
        symbol: str,
        interval: str,
        bars: list[dict],
        source: str = "backfill",
        market_type: str = "spot",
    ) -> int:
        """Insert or update bars.  Return number of rows affected."""
        ...

    async def count_bars(
        self, symbol: str, interval: str, start_ms: int, end_ms: int,
        market_type: str = "spot",
    ) -> int:
        """Count bars within [start_ms, end_ms]."""
        ...

    async def get_existing_open_times(
        self, symbol: str, interval: str, start_ms: int, end_ms: int,
        market_type: str = "spot",
    ) -> set[int]:
        """Return the set of open_time values that exist in [start_ms, end_ms].

        Used for efficient deduplication.  Default implementation can
        derive this from ``query_time_range()``.
        """
        ...


@runtime_checkable
class CacheBackend(Protocol):
    """Optional cache interface for pushing recent data to a fast-access layer.

    Implement this to integrate with Redis, in-memory LRU, or any other
    caching mechanism.  The Backfill Engine will call this after
    reconciliation for bars within the configured cache window.
    """

    async def push_bars(
        self, symbol: str, interval: str, bars: list[dict],
    ) -> int:
        """Push bars into the cache.  Return number of bars cached."""
        ...

    async def invalidate(
        self, symbol: str, interval: str, start_ms: int, end_ms: int,
    ) -> None:
        """Invalidate cached bars in the given time range."""
        ...


# ═══════════════════════════════════════════════════════════════
#  Interval Helpers
# ═══════════════════════════════════════════════════════════════

# Mapping of standard interval strings → milliseconds.
# Custom intervals (e.g. "91m") are parsed dynamically by parse_interval_ms().
STANDARD_INTERVAL_MS: dict[str, int] = {
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
    "1M": 2_592_000_000,  # ~30 days, approximate
}

# Suffix → milliseconds multiplier
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

    Supports:
      - Standard: "1m", "5m", "1h", "4h", "1d", etc.
      - Custom:   "91m", "7h", "2d", etc.

    Returns None if the interval string cannot be parsed.

    Examples::

        parse_interval_ms("1m")  → 60_000
        parse_interval_ms("91m") → 5_460_000
        parse_interval_ms("4h")  → 14_400_000
    """
    # Check standard mapping first
    if interval in STANDARD_INTERVAL_MS:
        return STANDARD_INTERVAL_MS[interval]

    # Try dynamic parsing: <number><suffix>
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
    return interval in STANDARD_INTERVAL_MS
