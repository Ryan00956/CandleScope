"""Unified interval parsing and bucket policy for data_engine."""
from __future__ import annotations

import calendar
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Mapping, Optional, Sequence

from app.data_engine.market_data.kline_metrics import serialize_kline_enhancements


VALID_INTERVALS = [
    "1s",
    "1m",
    "3m",
    "5m",
    "15m",
    "30m",
    "1h",
    "2h",
    "4h",
    "6h",
    "8h",
    "12h",
    "1d",
    "3d",
    "1w",
    "1M",
]

INTERVAL_SECONDS = {
    "1s": 1,
    "1m": 60,
    "3m": 180,
    "5m": 300,
    "15m": 900,
    "30m": 1800,
    "1h": 3600,
    "2h": 7200,
    "4h": 14400,
    "6h": 21600,
    "8h": 28800,
    "12h": 43200,
    "1d": 86400,
    "3d": 259200,
    "1w": 604800,
    "1M": 2592000,
}


def row_is_closed(row: dict, default: bool = True) -> bool:
    """Read the canonical close state while tolerating legacy wire aliases."""
    value = row.get("is_closed", row.get("isClosed"))
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


def aggregate_tail_is_closed(
    rows: list[dict],
    *,
    bucket_end_seconds: int,
    source_interval_seconds: int | None = None,
) -> bool:
    """Return true only when the latest closed component reaches the bucket end."""
    if not rows or not row_is_closed(rows[-1]):
        return False
    if source_interval_seconds is None:
        return True
    return int(rows[-1]["time"]) + source_interval_seconds >= bucket_end_seconds


def enhanced_components_are_complete(
    rows: list[dict],
    *,
    bucket_start_seconds: int,
    bucket_end_seconds: int,
    source_interval_seconds: int | None,
) -> bool:
    """Check that enhanced totals cover a contiguous target-bucket prefix.

    A complete closed bucket must reach its end.  A forming bucket may end at
    the latest open source component, but the first component and every step
    before it must still be present.
    """
    if not rows or not source_interval_seconds or source_interval_seconds <= 0:
        return False
    if int(rows[0]["time"]) != bucket_start_seconds:
        return False
    if any(
        int(current["time"]) - int(previous["time"]) != source_interval_seconds
        for previous, current in zip(rows, rows[1:])
    ):
        return False
    reaches_bucket_end = (
        int(rows[-1]["time"]) + source_interval_seconds >= bucket_end_seconds
    )
    return reaches_bucket_end or not row_is_closed(rows[-1])


STANDARD_INTERVAL_MS = {key: value * 1000 for key, value in INTERVAL_SECONDS.items()}
STANDARD_INTERVALS = STANDARD_INTERVAL_MS
EPHEMERAL_INTERVALS: set[str] = {"1s"}

_UNIT_SECONDS = {
    "s": 1,
    "m": 60,
    "h": 3600,
    "d": 86400,
    "w": 604800,
    "M": 2592000,
}
_INTERVAL_RE = re.compile(r"^(\d+)([smhdwM])$")
_WEEKLY_RE = re.compile(r"^(\d+)w$")
_MONTHLY_RE = re.compile(r"^(\d+)M$")
_WEEK_EPOCH_OFFSET_S = 4 * 86400
_WEEK_EPOCH_OFFSET_MS = 4 * 86400_000
_BASE_INTERVALS_ORDERED = [
    ("1m", 60),
    ("3m", 180),
    ("5m", 300),
    ("15m", 900),
    ("30m", 1800),
    ("1h", 3600),
    ("2h", 7200),
    ("4h", 14400),
    ("6h", 21600),
    ("8h", 28800),
    ("12h", 43200),
    ("1d", 86400),
    ("3d", 259200),
    ("1w", 604800),
]
_MULTI_RES_FACTOR_THRESHOLD = 20
_MAX_INTERVAL_MS = (1 << 63) - 1
_MAX_CALENDAR_MONTH_COUNT = 12_000


class IntervalAlignment(str, Enum):
    """Semantic alignment family for one interval."""

    FIXED_EPOCH = "fixed_epoch"
    WEEKLY_MONDAY = "weekly_monday"
    CALENDAR_MONTH = "calendar_month"


@dataclass(frozen=True, slots=True)
class IntervalSpec:
    """Canonical time semantics independent from exchange capabilities."""

    requested: str
    canonical: str
    alignment: IntervalAlignment
    nominal_ms: int
    count: int
    signature: tuple[str, int]

    def floor_ms(self, timestamp_ms: int) -> int:
        timestamp_ms = int(timestamp_ms)
        if self.alignment is IntervalAlignment.CALENDAR_MONTH:
            return _calendar_month_floor_ms(timestamp_ms, self.count)
        anchor_ms = (
            _WEEK_EPOCH_OFFSET_MS
            if self.alignment is IntervalAlignment.WEEKLY_MONDAY
            else 0
        )
        return (
            ((timestamp_ms - anchor_ms) // self.nominal_ms) * self.nominal_ms
            + anchor_ms
        )

    def next_ms(self, open_ms: int) -> int:
        if self.alignment is IntervalAlignment.CALENDAR_MONTH:
            return _shift_calendar_month_open_ms(int(open_ms), self.count)
        return int(open_ms) + self.nominal_ms

    def previous_ms(self, open_ms: int) -> int:
        if self.alignment is IntervalAlignment.CALENDAR_MONTH:
            return _shift_calendar_month_open_ms(int(open_ms), -self.count)
        return int(open_ms) - self.nominal_ms

    def is_successor(self, previous_ms: int, current_ms: int) -> bool:
        return self.next_ms(int(previous_ms)) == int(current_ms)


def _canonical_fixed_interval(value: int, unit: str) -> tuple[str, int, int]:
    unit_ms = {
        "s": 1_000,
        "m": 60_000,
        "h": 3_600_000,
        "d": 86_400_000,
    }
    nominal_ms = value * unit_ms[unit]
    for canonical_unit, width_ms in (
        ("d", 86_400_000),
        ("h", 3_600_000),
        ("m", 60_000),
        ("s", 1_000),
    ):
        if nominal_ms % width_ms == 0:
            count = nominal_ms // width_ms
            return f"{count}{canonical_unit}", count, nominal_ms
    raise AssertionError("fixed interval must be divisible by one second")


def parse_interval_spec(value: str) -> IntervalSpec | None:
    """Parse and canonicalise interval time semantics.

    Fixed-width aliases reduce only within the fixed epoch-aligned family.
    Weekly and calendar-month spellings retain their distinct alignment, so
    ``7d != 1w`` and ``30d != 1M`` even though their nominal widths match.
    """
    requested = str(value or "").strip()
    match = _INTERVAL_RE.fullmatch(requested)
    if match is None:
        return None
    raw_count = int(match.group(1))
    unit = match.group(2)
    if raw_count <= 0:
        return None

    if unit in {"s", "m", "h", "d"}:
        unit_ms = {"s": 1_000, "m": 60_000, "h": 3_600_000, "d": 86_400_000}
        if raw_count > _MAX_INTERVAL_MS // unit_ms[unit]:
            return None
        canonical, count, nominal_ms = _canonical_fixed_interval(raw_count, unit)
        alignment = IntervalAlignment.FIXED_EPOCH
        signature = (alignment.value, nominal_ms)
    elif unit == "w":
        if raw_count > _MAX_INTERVAL_MS // (7 * 86_400_000):
            return None
        canonical = f"{raw_count}w"
        count = raw_count
        nominal_ms = raw_count * 7 * 86_400_000
        alignment = IntervalAlignment.WEEKLY_MONDAY
        signature = (alignment.value, count)
    else:
        if raw_count > _MAX_CALENDAR_MONTH_COUNT:
            return None
        canonical = f"{raw_count}M"
        count = raw_count
        nominal_ms = raw_count * 30 * 86_400_000
        alignment = IntervalAlignment.CALENDAR_MONTH
        signature = (alignment.value, count)

    return IntervalSpec(
        requested=requested,
        canonical=canonical,
        alignment=alignment,
        nominal_ms=nominal_ms,
        count=count,
        signature=signature,
    )


def intervals_equivalent(left: str, right: str) -> bool:
    left_spec = parse_interval_spec(left)
    right_spec = parse_interval_spec(right)
    return bool(
        left_spec is not None
        and right_spec is not None
        and left_spec.signature == right_spec.signature
    )


def interval_tiles(source: IntervalSpec, target: IntervalSpec) -> bool:
    """Return whether source buckets exactly tile target bucket boundaries."""
    if source.alignment is not target.alignment:
        # UTC fixed bars no wider than one day can tile Monday-aligned weeks
        # and real calendar months exactly.  Multi-day fixed bars cannot: a
        # 3d/7d epoch grid crosses week/month boundaries.
        return bool(
            source.alignment is IntervalAlignment.FIXED_EPOCH
            and target.alignment in {
                IntervalAlignment.WEEKLY_MONDAY,
                IntervalAlignment.CALENDAR_MONTH,
            }
            and source.nominal_ms <= 86_400_000
            and 86_400_000 % source.nominal_ms == 0
        )
    if source.alignment is IntervalAlignment.CALENDAR_MONTH:
        return target.count % source.count == 0
    return target.nominal_ms % source.nominal_ms == 0


def parse_custom_interval(interval: str) -> int | None:
    """Parse an interval string into seconds."""
    spec = parse_interval_spec(interval)
    return spec.nominal_ms // 1000 if spec is not None else None


def parse_interval_ms(interval: str) -> int | None:
    """Parse an interval string into milliseconds."""
    spec = parse_interval_spec(interval)
    return spec.nominal_ms if spec is not None else None


def is_standard_interval(interval: str) -> bool:
    spec = parse_interval_spec(interval)
    return spec is not None and spec.canonical in INTERVAL_SECONDS


def is_custom_interval(interval: str) -> bool:
    return not is_standard_interval(interval)


def is_ephemeral_interval(interval: str) -> bool:
    spec = parse_interval_spec(interval)
    return spec is not None and spec.canonical in EPHEMERAL_INTERVALS


def is_weekly_interval(interval: str) -> bool:
    spec = parse_interval_spec(interval)
    return spec is not None and spec.alignment is IntervalAlignment.WEEKLY_MONDAY


def is_monthly_interval(interval: str) -> bool:
    spec = parse_interval_spec(interval)
    return spec is not None and spec.alignment is IntervalAlignment.CALENDAR_MONTH


def parse_monthly_count(interval: str) -> int | None:
    spec = parse_interval_spec(interval)
    if spec is None or spec.alignment is not IntervalAlignment.CALENDAR_MONTH:
        return None
    return spec.count


def get_tier_for_interval(interval: str) -> str:
    seconds = parse_custom_interval(interval)
    if seconds is None:
        return "minutes"
    if seconds < 60:
        return "seconds"
    if seconds < 3600:
        return "minutes"
    if seconds < 86400:
        return "hours"
    return "daily"


def compute_bucket_start(
    ts_seconds: int,
    bucket_width_seconds: int,
    *,
    interval: Optional[str] = None,
) -> int:
    if interval is not None:
        spec = parse_interval_spec(interval)
        if spec is not None:
            return spec.floor_ms(int(ts_seconds) * 1000) // 1000
    return (ts_seconds // bucket_width_seconds) * bucket_width_seconds


def compute_bucket_start_ms(
    ts_ms: int,
    bucket_width_ms: int,
    *,
    interval: Optional[str] = None,
) -> int:
    if interval is not None:
        spec = parse_interval_spec(interval)
        if spec is not None:
            return spec.floor_ms(int(ts_ms))
    return (ts_ms // bucket_width_ms) * bucket_width_ms


def compute_bucket_end_ms(
    bucket_start_ms: int,
    bucket_width_ms: int,
    *,
    interval: Optional[str] = None,
) -> int:
    """Return the exclusive bucket end for a bucket start."""
    if interval is not None:
        spec = parse_interval_spec(interval)
        if spec is not None:
            return spec.next_ms(int(bucket_start_ms))
    return bucket_start_ms + bucket_width_ms


def compute_bucket_close_ms(
    bucket_start_ms: int,
    bucket_width_ms: int,
    *,
    interval: Optional[str] = None,
) -> int:
    """Return the inclusive bucket close timestamp for a bucket start."""
    return compute_bucket_end_ms(
        bucket_start_ms,
        bucket_width_ms,
        interval=interval,
    ) - 1


def last_closed_bar_open_ms(now_ms: int, interval: str) -> int | None:
    """Return the open time of the latest fully closed interval bucket.

    Historical K-line ranges are expressed in bar ``open_time`` values.  The
    bucket containing ``now_ms`` is still forming, so the right-most eligible
    historical open is the bucket immediately before it.  Bucket helpers are
    used instead of fixed-width subtraction so calendar-month intervals (for
    example ``1M`` and ``2M``) retain their real UTC month boundaries.
    """
    width_ms = parse_interval_ms(interval)
    if width_ms is None or width_ms <= 0:
        return None

    current_open_ms = compute_bucket_start_ms(
        int(now_ms),
        width_ms,
        interval=interval,
    )
    if current_open_ms <= 0:
        return None

    previous_open_ms = compute_bucket_start_ms(
        current_open_ms - 1,
        width_ms,
        interval=interval,
    )
    if compute_bucket_end_ms(
        previous_open_ms,
        width_ms,
        interval=interval,
    ) > int(now_ms):
        return None
    return previous_open_ms


def latest_eligible_bar_open_ms(
    now_ms: int,
    interval: str,
    requested_end_ms: int | None = None,
) -> int | None:
    """Return the latest *closed* bar open that a request may include.

    Storage queries use an inclusive wall-clock ``end_ms`` but K-line history
    is keyed by bucket open.  A caller can therefore pass either an exact open
    time, a bar close time, or a timestamp inside the current forming bucket.
    This helper intersects that request edge with the target interval's closed
    boundary.  It is deliberately target-interval-aware: subtracting one
    fixed interval from a wall clock creates an off-by-one tail blind spot and
    is incorrect for calendar months.
    """
    last_closed_ms = last_closed_bar_open_ms(now_ms, interval)
    if last_closed_ms is None:
        return None
    if requested_end_ms is None:
        return last_closed_ms

    width_ms = parse_interval_ms(interval)
    if width_ms is None or width_ms <= 0:
        return None
    requested_open_ms = compute_bucket_start_ms(
        int(requested_end_ms),
        width_ms,
        interval=interval,
    )
    return min(last_closed_ms, requested_open_ms)


def aggregate_kline_rows(
    component_rows: Sequence[Mapping[str, Any]],
    *,
    target_interval: str,
    source_interval: str,
    now_ms: int,
) -> list[dict[str, Any]]:
    """Safely rebuild closed target K-lines from complete stored components.

    The helper is intentionally strict.  A target bucket is emitted only when
    every expected source open is present, every component has its canonical
    close timestamp, every component is closed by ``now_ms``, and the target
    bucket itself is already closed.  It is therefore safe to use for
    derived/custom series without ever turning a forming bucket into durable
    history.  It must not replace an exchange-native standard candle: venues
    can aggregate volume and order-flow differently from persisted minute
    components, so a missing native ``1d`` remains an authoritative-history
    repair task.

    Input and output rows use the storage shape (``open_time`` in
    milliseconds).  Optional order-flow fields are preserved only when every
    component supplies a valid value, matching the existing calendar-month
    aggregation semantics.
    """
    target_ms = parse_interval_ms(target_interval)
    source_ms = parse_interval_ms(source_interval)
    if (
        not component_rows
        or target_ms is None
        or source_ms is None
        or target_ms <= source_ms
        or source_ms <= 0
    ):
        return []

    last_closed_ms = last_closed_bar_open_ms(int(now_ms), target_interval)
    if last_closed_ms is None:
        return []

    rows_by_open: dict[int, dict[str, Any]] = {}
    for raw in component_rows:
        try:
            row = dict(raw)
            open_time_ms = int(row["open_time"])
        except (KeyError, TypeError, ValueError):
            continue
        # A duplicate component makes the source ambiguous.  Refuse that
        # target bucket instead of silently choosing a row.
        if open_time_ms in rows_by_open:
            rows_by_open[open_time_ms] = {}
        else:
            rows_by_open[open_time_ms] = row

    bucket_opens = sorted({
        compute_bucket_start_ms(
            open_time_ms,
            target_ms,
            interval=target_interval,
        )
        for open_time_ms in rows_by_open
    })
    rebuilt: list[dict[str, Any]] = []

    for bucket_open_ms in bucket_opens:
        if bucket_open_ms > last_closed_ms:
            continue
        bucket_end_ms = compute_bucket_end_ms(
            bucket_open_ms,
            target_ms,
            interval=target_interval,
        )

        expected_opens: list[int] = []
        component_open_ms = bucket_open_ms
        while component_open_ms < bucket_end_ms:
            expected_opens.append(component_open_ms)
            component_open_ms += source_ms
        # A source interval that crosses a target boundary cannot prove an
        # exact target candle.  This is expected for some exotic interval
        # pairs; callers can still fall back to authoritative history.
        if component_open_ms != bucket_end_ms:
            continue

        components = [rows_by_open.get(open_time_ms) for open_time_ms in expected_opens]
        if any(not row for row in components):
            continue
        rows = [row for row in components if row]
        if not all(_stored_component_is_closed(
            row,
            open_time_ms=open_time_ms,
            source_ms=source_ms,
            now_ms=now_ms,
        ) for row, open_time_ms in zip(rows, expected_opens)):
            continue

        try:
            enhanced_rows = [
                serialize_kline_enhancements(
                    volume=row.get("volume"),
                    quote_volume=row.get("quote_volume"),
                    trades=row.get("trades"),
                    taker_buy_base=row.get("taker_buy_base"),
                    taker_buy_quote=row.get("taker_buy_quote"),
                )
                for row in rows
            ]
            rebuilt.append({
                "open_time": bucket_open_ms,
                "close_time": bucket_end_ms - 1,
                "open": float(rows[0]["open"]),
                "high": max(float(row["high"]) for row in rows),
                "low": min(float(row["low"]) for row in rows),
                "close": float(rows[-1]["close"]),
                "volume": round(sum(float(row["volume"]) for row in rows), 8),
                "quote_volume": _sum_optional_additive_field(
                    enhanced_rows, "quote_volume",
                ),
                "trades": _sum_optional_additive_field(
                    enhanced_rows, "trades", integer=True,
                ),
                "taker_buy_base": _sum_optional_additive_field(
                    enhanced_rows, "taker_buy_base",
                ),
                "taker_buy_quote": _sum_optional_additive_field(
                    enhanced_rows, "taker_buy_quote",
                ),
                "is_closed": True,
            })
        except (KeyError, TypeError, ValueError):
            # A malformed component must not produce a plausible-looking
            # reconstructed candle.
            continue

    return rebuilt


def _stored_component_is_closed(
    row: Mapping[str, Any],
    *,
    open_time_ms: int,
    source_ms: int,
    now_ms: int,
) -> bool:
    """Validate one storage-shaped source component for strict reconstruction."""
    if not row_is_closed(dict(row), default=True):
        return False
    try:
        close_time_ms = int(row["close_time"])
    except (KeyError, TypeError, ValueError):
        return False
    return (
        close_time_ms == int(open_time_ms) + int(source_ms) - 1
        and close_time_ms < int(now_ms)
    )


def find_best_base_interval(
    custom_seconds: int,
    *,
    interval: str | None = None,
) -> tuple[str, int]:
    if interval is not None and is_monthly_interval(interval):
        month_count = parse_monthly_count(interval) or 1
        return "1d", month_count * 30

    best_interval = "1m"
    best_factor = max(custom_seconds // 60, 1)
    for name, seconds in reversed(_BASE_INTERVALS_ORDERED):
        if seconds >= custom_seconds:
            continue
        if custom_seconds % seconds == 0:
            best_interval = name
            best_factor = custom_seconds // seconds
            break
    return best_interval, best_factor


def find_optimal_fetch_plan(custom_seconds: int) -> dict:
    base_interval, factor = find_best_base_interval(custom_seconds)
    base_seconds = INTERVAL_SECONDS[base_interval]
    if factor <= _MULTI_RES_FACTOR_THRESHOLD:
        return {
            "use_multi_res": False,
            "base_interval": base_interval,
            "base_seconds": base_seconds,
            "factor": factor,
            "coarse_interval": None,
            "coarse_seconds": 0,
        }

    coarse_interval = None
    coarse_seconds = 0
    for name, seconds in reversed(_BASE_INTERVALS_ORDERED):
        if seconds >= custom_seconds:
            continue
        if seconds > base_seconds:
            coarse_interval = name
            coarse_seconds = seconds
            break

    if coarse_interval is None:
        return {
            "use_multi_res": False,
            "base_interval": base_interval,
            "base_seconds": base_seconds,
            "factor": factor,
            "coarse_interval": None,
            "coarse_seconds": 0,
        }
    return {
        "use_multi_res": True,
        "base_interval": base_interval,
        "base_seconds": base_seconds,
        "factor": factor,
        "coarse_interval": coarse_interval,
        "coarse_seconds": coarse_seconds,
    }


_MONTH_ANCHOR_ORDINAL = 1970 * 12


def _month_ordinal_to_datetime(ordinal: int) -> datetime:
    year, zero_based_month = divmod(int(ordinal), 12)
    return datetime(year, zero_based_month + 1, 1, tzinfo=timezone.utc)


def _calendar_month_floor_ms(timestamp_ms: int, months: int) -> int:
    if months <= 0:
        raise ValueError(f"months must be positive, got {months}")
    dt = datetime.fromtimestamp(int(timestamp_ms) / 1000, tz=timezone.utc)
    ordinal = dt.year * 12 + (dt.month - 1)
    bucket_ordinal = (
        _MONTH_ANCHOR_ORDINAL
        + ((ordinal - _MONTH_ANCHOR_ORDINAL) // months) * months
    )
    return int(_month_ordinal_to_datetime(bucket_ordinal).timestamp() * 1000)


def _shift_calendar_month_open_ms(open_ms: int, months: int) -> int:
    dt = datetime.fromtimestamp(int(open_ms) / 1000, tz=timezone.utc)
    ordinal = dt.year * 12 + (dt.month - 1) + int(months)
    return int(_month_ordinal_to_datetime(ordinal).timestamp() * 1000)


def compute_month_bucket(ts_seconds: int, months: int = 1) -> int:
    return _calendar_month_floor_ms(int(ts_seconds) * 1000, months) // 1000


def compute_month_bucket_ms(ts_ms: int, months: int = 1) -> int:
    """Compute the calendar-month bucket start for a millisecond timestamp."""
    return compute_month_bucket(ts_ms // 1000, months) * 1000


def next_month_bucket(bucket_start_seconds: int, months: int = 1) -> int:
    """Return the next calendar-month bucket start in seconds."""
    spec = parse_interval_spec(f"{months}M")
    if spec is None:
        raise ValueError(f"months must be positive, got {months}")
    canonical_open_ms = spec.floor_ms(int(bucket_start_seconds) * 1000)
    return spec.next_ms(canonical_open_ms) // 1000


def previous_month_bucket(bucket_start_seconds: int, months: int = 1) -> int:
    """Return the previous anchored calendar-month bucket start in seconds."""
    spec = parse_interval_spec(f"{months}M")
    if spec is None:
        raise ValueError(f"months must be positive, got {months}")
    canonical_open_ms = spec.floor_ms(int(bucket_start_seconds) * 1000)
    return spec.previous_ms(canonical_open_ms) // 1000


def aggregate_rows_by_month(
    base_rows: list[dict],
    months: int = 1,
    *,
    source_interval_seconds: int | None = None,
) -> list[dict]:
    """Aggregate lightweight-chart rows into calendar-month buckets."""
    if not base_rows:
        return []

    buckets: dict[int, list[dict]] = {}
    for row in base_rows:
        bucket_start = compute_month_bucket(int(row["time"]), months)
        buckets.setdefault(bucket_start, []).append(row)

    result: list[dict] = []
    for bucket_start in sorted(buckets):
        rows = sorted(buckets[bucket_start], key=lambda row: row["time"])
        bucket_end = next_month_bucket(bucket_start, months)
        enhanced_complete = enhanced_components_are_complete(
            rows,
            bucket_start_seconds=bucket_start,
            bucket_end_seconds=bucket_end,
            source_interval_seconds=source_interval_seconds,
        )
        enhanced_rows = [
            serialize_kline_enhancements(
                volume=row.get("volume"),
                quote_volume=row.get("quote_volume"),
                trades=row.get("trades"),
                taker_buy_base=row.get("taker_buy_base"),
                taker_buy_quote=row.get("taker_buy_quote"),
            )
            for row in rows
        ]
        result.append({
            "time": bucket_start,
            "open": rows[0]["open"],
            "high": max(row["high"] for row in rows),
            "low": min(row["low"] for row in rows),
            "close": rows[-1]["close"],
            "volume": round(sum(row["volume"] for row in rows), 8),
            "quote_volume": _sum_optional_additive_field(enhanced_rows, "quote_volume")
            if enhanced_complete else None,
            "trades": _sum_optional_additive_field(enhanced_rows, "trades", integer=True)
            if enhanced_complete else None,
            "taker_buy_base": _sum_optional_additive_field(enhanced_rows, "taker_buy_base")
            if enhanced_complete else None,
            "taker_buy_quote": _sum_optional_additive_field(enhanced_rows, "taker_buy_quote")
            if enhanced_complete else None,
            # A newer component implicitly confirms any older component whose
            # explicit close event was missed, but a partial target bucket is
            # still forming until that component reaches its calendar end.
            "is_closed": bool(
                enhanced_complete
                and aggregate_tail_is_closed(
                    rows,
                    bucket_end_seconds=bucket_end,
                    source_interval_seconds=source_interval_seconds,
                )
            ),
        })
    return result


def _sum_optional_additive_field(
    rows: list[dict],
    field: str,
    *,
    integer: bool = False,
) -> float | int | None:
    """Sum an additive field only for a complete component set."""
    values = [row.get(field) for row in rows]
    if any(value is None for value in values):
        return None
    if integer:
        return sum(int(value) for value in values)
    return round(sum(float(value) for value in values), 8)


def add_months(ts_seconds: int, months: int) -> int:
    dt = datetime.fromtimestamp(ts_seconds, tz=timezone.utc)
    month = dt.month - 1 + months
    year = dt.year + month // 12
    month = month % 12 + 1
    day = min(dt.day, calendar.monthrange(year, month)[1])
    new_dt = datetime(
        year,
        month,
        day,
        dt.hour,
        dt.minute,
        dt.second,
        tzinfo=timezone.utc,
    )
    return int(new_dt.timestamp())
