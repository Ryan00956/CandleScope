"""
L2: Time Bucket Engine — pure computation of time bucket membership.

Responsibilities:
  * Given a timestamp and target interval, compute which bucket it belongs to
  * Support multiple alignment modes (epoch, midnight, custom)
  * Detect cross-bucket scenarios (input spanning multiple buckets)
  * Provide bucket range queries

This layer is **stateless** and **pure-functional** — no side effects,
no I/O, easy to test and reason about.

Usage::

    engine = TimeBucketEngine(
        interval_ms=5_460_000,   # 91 minutes
        alignment=AlignmentMode.EPOCH,
    )
    bucket = engine.compute_bucket(1672531200000)
    start, end = engine.compute_bucket_range(bucket)

Users can replace the entire engine with a custom ``BucketCalculator``
protocol implementation for exotic bucketing schemes (session-based,
volume-based, etc.).
"""
from __future__ import annotations

import calendar
import logging
from datetime import datetime, timezone

from .models import AlignmentMode, BucketCalculator

logger = logging.getLogger("bar_aggregator.L2_TimeBucket")

# UTC midnight anchor: 2000-01-01T00:00:00Z (ms)
_MIDNIGHT_ANCHOR_MS = 946_684_800_000

# Number of ms in one day
_DAY_MS = 86_400_000


class TimeBucketEngine:
    """Stateless engine that computes time bucket membership.

    Given an ``interval_ms`` and an ``AlignmentMode``, this engine
    determines which bucket any given timestamp falls into.

    All timestamps and return values are in **milliseconds**.
    """

    def __init__(
        self,
        interval_ms: int,
        alignment: AlignmentMode = AlignmentMode.EPOCH,
        epoch_ms: int = 0,
        custom_calculator: BucketCalculator | None = None,
    ) -> None:
        """
        Args:
            interval_ms:        Bucket width in milliseconds (e.g. 60_000 for 1m)
            alignment:          How bucket boundaries are aligned
            epoch_ms:           Custom alignment epoch (only for CUSTOM mode)
            custom_calculator:  User-provided calculator that overrides all logic
        """
        if interval_ms <= 0:
            raise ValueError(f"interval_ms must be positive, got {interval_ms}")

        self._interval_ms = interval_ms
        self._alignment = alignment
        self._epoch_ms = epoch_ms
        self._custom_calculator = custom_calculator

        # Pre-compute the alignment anchor based on mode
        self._anchor_ms = self._resolve_anchor()

    # ── Public API ───────────────────────────────────────────

    @property
    def interval_ms(self) -> int:
        """The bucket width in milliseconds."""
        return self._interval_ms

    @property
    def alignment(self) -> AlignmentMode:
        """The current alignment mode."""
        return self._alignment

    def compute_bucket(self, open_time_ms: int) -> int:
        """Compute the bucket_start_ms for a given timestamp.

        Args:
            open_time_ms: The timestamp (ms) to classify

        Returns:
            The start time (ms) of the bucket this timestamp belongs to

        Examples::

            # 1m interval, epoch-aligned
            engine = TimeBucketEngine(60_000)
            engine.compute_bucket(1672531230000)  # → 1672531200000

            # 91m interval
            engine = TimeBucketEngine(5_460_000)
            engine.compute_bucket(1672531200000)  # → bucket start
        """
        if self._custom_calculator is not None:
            return self._custom_calculator.compute_bucket(open_time_ms)

        # Offset from anchor, then floor-divide to bucket boundary
        offset = open_time_ms - self._anchor_ms
        bucket_index = offset // self._interval_ms
        return self._anchor_ms + bucket_index * self._interval_ms

    def compute_bucket_range(self, bucket_start_ms: int) -> tuple[int, int]:
        """Return (bucket_start_ms, bucket_end_ms) for a given bucket.

        ``bucket_end_ms`` is **exclusive** (i.e. the start of the next bucket).

        Args:
            bucket_start_ms: The start time of the bucket

        Returns:
            Tuple of (start_ms, end_ms_exclusive)
        """
        if self._custom_calculator is not None:
            return self._custom_calculator.compute_bucket_range(bucket_start_ms)

        return (bucket_start_ms, bucket_start_ms + self._interval_ms)

    def is_in_bucket(self, time_ms: int, bucket_start_ms: int) -> bool:
        """Check if a timestamp falls within a specific bucket.

        Args:
            time_ms:         The timestamp to check
            bucket_start_ms: The bucket to check against

        Returns:
            True if time_ms is in [bucket_start_ms, bucket_end_ms)
        """
        start, end = self.compute_bucket_range(bucket_start_ms)
        return start <= time_ms < end

    def next_bucket(self, bucket_start_ms: int) -> int:
        """Return the start of the next bucket after the given one."""
        if self._custom_calculator is not None:
            _, end = self._custom_calculator.compute_bucket_range(bucket_start_ms)
            return end
        return bucket_start_ms + self._interval_ms

    def prev_bucket(self, bucket_start_ms: int) -> int:
        """Return the start of the previous bucket before the given one."""
        if self._custom_calculator is not None:
            # For custom calculators, compute by going back one interval
            return self.compute_bucket(bucket_start_ms - 1)
        return bucket_start_ms - self._interval_ms

    def buckets_between(self, start_ms: int, end_ms: int) -> list[int]:
        """Return all bucket_start_ms values between start_ms and end_ms.

        Useful for backfill scenarios where you need to know all buckets
        in a time range.

        Args:
            start_ms: Start of the range (inclusive)
            end_ms:   End of the range (inclusive)

        Returns:
            Sorted list of bucket_start_ms values
        """
        first_bucket = self.compute_bucket(start_ms)
        result: list[int] = []
        current = first_bucket
        while current <= end_ms:
            result.append(current)
            current = self.next_bucket(current)
        return result

    def is_last_component(
        self,
        input_open_time_ms: int,
        input_close_time_ms: int,
        bucket_start_ms: int,
    ) -> bool:
        """Check if a source bar is the LAST component of a bucket.

        Used by CompositeCloseFinalizer to determine if a custom-interval
        bar should be closed when the last component bar's is_closed=True.

        A source bar is the "last component" if its close_time_ms is ≥
        bucket_end_ms - 1 (allowing for the typical ms offset in close times).

        Args:
            input_open_time_ms:  Open time of the source bar
            input_close_time_ms: Close time of the source bar
            bucket_start_ms:     The bucket being checked

        Returns:
            True if this is the last component of the bucket
        """
        _, bucket_end_ms = self.compute_bucket_range(bucket_start_ms)
        # Close time is usually bucket_end - 1 (inclusive convention)
        # So we check if close_time >= bucket_end - 1
        return input_close_time_ms >= bucket_end_ms - 1

    def snapshot(self) -> dict:
        """Return a JSON-serializable snapshot of engine configuration."""
        return {
            "engine": "TimeBucketEngine",
            "interval_ms": self._interval_ms,
            "alignment": self._alignment.value,
            "epoch_ms": self._epoch_ms,
            "anchor_ms": self._anchor_ms,
            "has_custom_calculator": self._custom_calculator is not None,
        }

    # ── Internal ─────────────────────────────────────────────

    def _resolve_anchor(self) -> int:
        """Determine the alignment anchor point based on mode."""
        if self._alignment == AlignmentMode.EPOCH:
            return 0
        if self._alignment == AlignmentMode.MIDNIGHT:
            return _MIDNIGHT_ANCHOR_MS
        if self._alignment == AlignmentMode.MARKET:
            # For crypto markets that trade 24/7, MARKET ≈ MIDNIGHT.
            # For traditional markets, this could be exchange open time.
            # Users can override via CUSTOM mode or BucketCalculator.
            return _MIDNIGHT_ANCHOR_MS
        if self._alignment == AlignmentMode.CUSTOM:
            return self._epoch_ms
        if self._alignment == AlignmentMode.NONE:
            return 0
        return 0


# ═══════════════════════════════════════════════════════════════
#  MonthlyBucketCalculator — calendar-month alignment for 1M
# ═══════════════════════════════════════════════════════════════


class MonthlyBucketCalculator:
    """BucketCalculator that aligns buckets to calendar month boundaries.

    Unlike fixed-duration bucketing (30 days = 2,592,000,000 ms), this
    calculator aligns to the 1st of each month at 00:00:00 UTC.

    Supports multi-month buckets (e.g. 2M, 3M) by grouping months
    from the start of the year.  For example, with ``months=3``:
      Q1 = Jan–Mar, Q2 = Apr–Jun, Q3 = Jul–Sep, Q4 = Oct–Dec.

    This matches Binance's native 1M kline semantics where each monthly
    candle starts at the beginning of the calendar month.

    Implements the ``BucketCalculator`` protocol.

    Args:
        months: Number of calendar months per bucket (default 1).
    """

    def __init__(self, months: int = 1) -> None:
        if months <= 0:
            raise ValueError(f"months must be positive, got {months}")
        self._months = months

    def compute_bucket(self, open_time_ms: int) -> int:
        """Return the start of the calendar-month bucket (UTC) containing open_time_ms.

        For multi-month buckets, aligns to year-start: N-month groups
        always begin from January.
        """
        dt = datetime.fromtimestamp(open_time_ms / 1000, tz=timezone.utc)
        # Zero-based month index from January
        month_index = dt.month - 1  # 0..11
        # Which N-month group does this fall in?
        group_index = month_index // self._months
        bucket_month = group_index * self._months + 1  # 1-based month
        month_start = dt.replace(
            month=bucket_month, day=1,
            hour=0, minute=0, second=0, microsecond=0,
        )
        return int(month_start.timestamp() * 1000)

    def compute_bucket_range(self, bucket_start_ms: int) -> tuple[int, int]:
        """Return (bucket_start_ms, next_bucket_start_ms) for the given bucket."""
        dt = datetime.fromtimestamp(bucket_start_ms / 1000, tz=timezone.utc)
        month_start = dt.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        # Advance by N months
        new_month = month_start.month + self._months
        new_year = month_start.year + (new_month - 1) // 12
        new_month = (new_month - 1) % 12 + 1
        next_bucket = month_start.replace(year=new_year, month=new_month)
        start_ms = int(month_start.timestamp() * 1000)
        end_ms = int(next_bucket.timestamp() * 1000)
        return (start_ms, end_ms)


# ═══════════════════════════════════════════════════════════════
#  WeeklyBucketCalculator — Monday-aligned bucketing for Nw
# ═══════════════════════════════════════════════════════════════

# Unix epoch (1970-01-01) is a Thursday.
# The first Monday after epoch is 1970-01-05 = 4 * 86400 * 1000 ms.
_MONDAY_EPOCH_MS = 4 * 86_400_000  # 345_600_000


class WeeklyBucketCalculator:
    """BucketCalculator that aligns weekly buckets to Monday 00:00 UTC.

    Ensures weekly candle boundaries match the standard financial and
    crypto convention (Binance 1w candles start on Monday 00:00 UTC).

    Supports multi-week buckets (e.g. '2w', '3w') by aligning to every
    Nth Monday starting from 1970-01-05 (the first Monday after epoch).

    Implements the ``BucketCalculator`` protocol.

    Args:
        weeks: Number of weeks per bucket (default 1).
    """

    def __init__(self, weeks: int = 1) -> None:
        if weeks <= 0:
            raise ValueError(f"weeks must be positive, got {weeks}")
        self._weeks = weeks
        self._bucket_ms = weeks * 7 * 86_400_000  # bucket width in ms

    def compute_bucket(self, open_time_ms: int) -> int:
        """Return the Monday-aligned bucket start (UTC ms) for the timestamp."""
        offset = open_time_ms - _MONDAY_EPOCH_MS
        bucket_index = offset // self._bucket_ms
        return _MONDAY_EPOCH_MS + bucket_index * self._bucket_ms

    def compute_bucket_range(self, bucket_start_ms: int) -> tuple[int, int]:
        """Return (bucket_start_ms, next_bucket_start_ms)."""
        return (bucket_start_ms, bucket_start_ms + self._bucket_ms)
