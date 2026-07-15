"""Typed contracts for historical-data availability planning.

All timestamps in this package are Unix milliseconds.  ``TimeRange`` and
``TimeBound`` are inclusive: a lower bound is the first timestamp which may be
requested and an upper bound is the last timestamp which may be requested.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Mapping


class BoundaryState(str, Enum):
    """Confidence attached to an observed history boundary."""

    CANDIDATE = "candidate"
    CONFIRMED = "confirmed"


class BoundarySide(str, Enum):
    """Which side of a series a persisted boundary limits."""

    LEFT = "left"
    RIGHT = "right"


class BoundaryReason(str, Enum):
    """Stable machine-readable explanations for time availability decisions."""

    DATA_START = "data_start"
    DATA_END = "data_end"
    LISTING = "listing"
    DELISTING = "delisting"
    UPSTREAM_START = "upstream_start"
    UPSTREAM_END = "upstream_end"
    PROVIDER_RETENTION = "provider_retention"
    SOURCE_EXHAUSTED = "source_exhausted"
    MARKET_CLOSED = "market_closed"
    CALENDAR_UNKNOWN = "calendar_unknown"
    TEMPORARY_UNAVAILABLE = "temporary_unavailable"
    AVAILABILITY_UNKNOWN = "availability_unknown"
    MANUAL = "manual"


class HistoryDisposition(str, Enum):
    """What a caller should do with a planned historical request."""

    FETCH = "fetch"
    NOT_EXPECTED = "not_expected"
    TERMINAL = "terminal"
    RETRYABLE = "retryable"
    UNKNOWN = "unknown"


@dataclass(frozen=True, slots=True)
class HistorySeriesKey:
    """Identity of one independently bounded historical series.

    ``variant`` identifies cadence/interval or another channel-specific shape.
    ``params_hash`` separates parameterised metrics which share a channel name.
    """

    exchange: str
    market_type: str
    symbol: str
    channel: str
    variant: str = ""
    params_hash: str = ""

    def __post_init__(self) -> None:
        values = {
            "exchange": self.exchange,
            "market_type": self.market_type,
            "symbol": self.symbol,
            "channel": self.channel,
        }
        for name, value in values.items():
            if not str(value or "").strip():
                raise ValueError(f"{name} must be non-empty")
        object.__setattr__(self, "exchange", self.exchange.strip().lower())
        object.__setattr__(self, "market_type", self.market_type.strip().lower())
        object.__setattr__(self, "symbol", self.symbol.strip().upper())
        object.__setattr__(self, "channel", self.channel.strip().lower())
        object.__setattr__(self, "variant", str(self.variant or "").strip())
        object.__setattr__(self, "params_hash", str(self.params_hash or "").strip())

    @classmethod
    def from_params(
        cls,
        *,
        exchange: str,
        market_type: str,
        symbol: str,
        channel: str,
        variant: str = "",
        params: Mapping[str, Any] | None = None,
    ) -> "HistorySeriesKey":
        """Build a key with a deterministic full SHA-256 parameter hash."""
        encoded = json.dumps(
            dict(params or {}),
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            default=str,
        ).encode("utf-8")
        return cls(
            exchange=exchange,
            market_type=market_type,
            symbol=symbol,
            channel=channel,
            variant=variant,
            params_hash=hashlib.sha256(encoded).hexdigest() if params else "",
        )


@dataclass(frozen=True, slots=True, order=True)
class TimeRange:
    """Inclusive millisecond time range."""

    start_ms: int
    end_ms: int

    def __post_init__(self) -> None:
        object.__setattr__(self, "start_ms", int(self.start_ms))
        object.__setattr__(self, "end_ms", int(self.end_ms))
        if self.end_ms < self.start_ms:
            raise ValueError("end_ms must be greater than or equal to start_ms")

    def intersection(self, other: "TimeRange") -> "TimeRange | None":
        start_ms = max(self.start_ms, other.start_ms)
        end_ms = min(self.end_ms, other.end_ms)
        return TimeRange(start_ms, end_ms) if start_ms <= end_ms else None

    def contains(self, timestamp_ms: int) -> bool:
        return self.start_ms <= int(timestamp_ms) <= self.end_ms


@dataclass(frozen=True, slots=True)
class TimeBound:
    """One observed or declared edge of historical availability."""

    value_ms: int
    reason: BoundaryReason
    state: BoundaryState = BoundaryState.CONFIRMED
    retryable: bool = False
    revision: str = ""
    revalidate_at_ms: int | None = None
    dynamic: bool = False
    metadata: Mapping[str, Any] = field(default_factory=dict, compare=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "value_ms", int(self.value_ms))
        object.__setattr__(self, "reason", BoundaryReason(self.reason))
        object.__setattr__(self, "state", BoundaryState(self.state))
        object.__setattr__(self, "revision", str(self.revision or ""))
        if self.revalidate_at_ms is not None:
            object.__setattr__(self, "revalidate_at_ms", int(self.revalidate_at_ms))
        object.__setattr__(self, "metadata", dict(self.metadata or {}))

    @property
    def confirmed(self) -> bool:
        return self.state is BoundaryState.CONFIRMED

    def is_active(self, *, now_ms: int | None = None, revision: str | None = None) -> bool:
        if revision is not None and self.revision != str(revision or ""):
            return False
        if (
            now_ms is not None
            and self.revalidate_at_ms is not None
            and self.revalidate_at_ms <= int(now_ms)
        ):
            return False
        return True


@dataclass(frozen=True, slots=True)
class HistoryAvailability:
    """Declared and learned availability inputs for a series.

    ``rolling_retention_ms`` is deliberately a duration, not an absolute
    boundary.  The planner resolves it against ``now_ms`` on every request.
    """

    data_start: TimeBound | None = None
    data_end: TimeBound | None = None
    upstream_start: TimeBound | None = None
    upstream_end: TimeBound | None = None
    rolling_retention_ms: int | None = None
    disposition: HistoryDisposition = HistoryDisposition.FETCH
    status_reason: BoundaryReason | None = None
    retry_at_ms: int | None = None
    calendar_id: str | None = None
    revision: str = ""

    def __post_init__(self) -> None:
        object.__setattr__(self, "disposition", HistoryDisposition(self.disposition))
        if self.status_reason is not None:
            object.__setattr__(self, "status_reason", BoundaryReason(self.status_reason))
        if self.rolling_retention_ms is not None:
            retention = int(self.rolling_retention_ms)
            if retention <= 0:
                raise ValueError("rolling_retention_ms must be positive")
            object.__setattr__(self, "rolling_retention_ms", retention)
        if self.retry_at_ms is not None:
            object.__setattr__(self, "retry_at_ms", int(self.retry_at_ms))
        object.__setattr__(self, "calendar_id", self.calendar_id.strip() if self.calendar_id else None)
        object.__setattr__(self, "revision", str(self.revision or ""))
        if self.disposition not in {
            HistoryDisposition.FETCH,
            HistoryDisposition.RETRYABLE,
            HistoryDisposition.UNKNOWN,
            HistoryDisposition.TERMINAL,
        }:
            raise ValueError("availability disposition must describe an upstream state")


@dataclass(frozen=True, slots=True)
class HistoryRequest:
    series: HistorySeriesKey
    interval: str
    start_ms: int
    end_ms: int

    def __post_init__(self) -> None:
        object.__setattr__(self, "interval", str(self.interval or "").strip())
        object.__setattr__(self, "start_ms", int(self.start_ms))
        object.__setattr__(self, "end_ms", int(self.end_ms))
        if not self.interval:
            raise ValueError("interval must be non-empty")
        if self.end_ms < self.start_ms:
            raise ValueError("end_ms must be greater than or equal to start_ms")

    @property
    def time_range(self) -> TimeRange:
        return TimeRange(self.start_ms, self.end_ms)


@dataclass(frozen=True, slots=True)
class HistoryExclusion:
    time_range: TimeRange
    disposition: HistoryDisposition
    reason: BoundaryReason
    bound: TimeBound | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "disposition", HistoryDisposition(self.disposition))
        object.__setattr__(self, "reason", BoundaryReason(self.reason))


@dataclass(frozen=True, slots=True)
class HistoryPlan:
    """Planner output consumed by query/backfill/API layers."""

    request: HistoryRequest
    disposition: HistoryDisposition
    fetch_ranges: tuple[TimeRange, ...] = ()
    exclusions: tuple[HistoryExclusion, ...] = ()
    effective_range: TimeRange | None = None
    terminal: bool = False
    retryable: bool = False
    unknown: bool = False
    calendar_id: str | None = None
    retry_at_ms: int | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "disposition", HistoryDisposition(self.disposition))
        object.__setattr__(self, "fetch_ranges", tuple(self.fetch_ranges))
        object.__setattr__(self, "exclusions", tuple(self.exclusions))

    @property
    def has_fetch_work(self) -> bool:
        return bool(self.fetch_ranges)

    @property
    def has_terminal_boundary(self) -> bool:
        return any(
            exclusion.disposition is HistoryDisposition.TERMINAL
            for exclusion in self.exclusions
        )

    @property
    def expected_count(self) -> int:
        """Number of fetch spans, not bars; calendars count bars explicitly."""
        return len(self.fetch_ranges)


@dataclass(frozen=True, slots=True)
class StoredHistoryBoundary:
    key: HistorySeriesKey
    side: BoundarySide
    bound: TimeBound
    evidence_count: int
    first_seen_at_ms: int
    last_seen_at_ms: int
