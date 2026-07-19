"""Unified interval parsing and bucket policy for data_engine."""
from __future__ import annotations

import calendar
import re
from datetime import datetime, timezone
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


def parse_custom_interval(interval: str) -> int | None:
    """Parse an interval string into seconds."""
    if interval in INTERVAL_SECONDS:
        return INTERVAL_SECONDS[interval]
    match = _INTERVAL_RE.match(str(interval or ""))
    if not match:
        return None
    value, unit = int(match.group(1)), match.group(2)
    if value <= 0:
        return None
    return value * _UNIT_SECONDS[unit]


def parse_interval_ms(interval: str) -> int | None:
    """Parse an interval string into milliseconds."""
    seconds = parse_custom_interval(interval)
    return seconds * 1000 if seconds is not None else None


def is_standard_interval(interval: str) -> bool:
    return interval in INTERVAL_SECONDS


def is_custom_interval(interval: str) -> bool:
    return interval not in INTERVAL_SECONDS


def is_ephemeral_interval(interval: str) -> bool:
    return interval in EPHEMERAL_INTERVALS


def is_weekly_interval(interval: str) -> bool:
    return bool(_WEEKLY_RE.match(str(interval or "")))


def is_monthly_interval(interval: str) -> bool:
    return bool(_MONTHLY_RE.match(str(interval or "")))


def parse_monthly_count(interval: str) -> int | None:
    match = _MONTHLY_RE.match(str(interval or ""))
    if not match:
        return None
    value = int(match.group(1))
    return value if value > 0 else None


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
        month_count = parse_monthly_count(interval)
        if month_count is not None:
            return compute_month_bucket(ts_seconds, month_count)
    if interval is not None and is_weekly_interval(interval):
        return (
            ((ts_seconds - _WEEK_EPOCH_OFFSET_S) // bucket_width_seconds)
            * bucket_width_seconds
            + _WEEK_EPOCH_OFFSET_S
        )
    return (ts_seconds // bucket_width_seconds) * bucket_width_seconds


def compute_bucket_start_ms(
    ts_ms: int,
    bucket_width_ms: int,
    *,
    interval: Optional[str] = None,
) -> int:
    if interval is not None:
        month_count = parse_monthly_count(interval)
        if month_count is not None:
            return compute_month_bucket_ms(ts_ms, month_count)
    if interval is not None and is_weekly_interval(interval):
        return (
            ((ts_ms - _WEEK_EPOCH_OFFSET_MS) // bucket_width_ms)
            * bucket_width_ms
            + _WEEK_EPOCH_OFFSET_MS
        )
    return (ts_ms // bucket_width_ms) * bucket_width_ms


def compute_bucket_end_ms(
    bucket_start_ms: int,
    bucket_width_ms: int,
    *,
    interval: Optional[str] = None,
) -> int:
    """Return the exclusive bucket end for a bucket start."""
    if interval is not None:
        month_count = parse_monthly_count(interval)
        if month_count is not None:
            return next_month_bucket(bucket_start_ms // 1000, month_count) * 1000
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


def compute_month_bucket(ts_seconds: int, months: int = 1) -> int:
    dt = datetime.fromtimestamp(ts_seconds, tz=timezone.utc)
    month_index = ((dt.month - 1) // months) * months + 1
    bucket = datetime(dt.year, month_index, 1, tzinfo=timezone.utc)
    return int(bucket.timestamp())


def compute_month_bucket_ms(ts_ms: int, months: int = 1) -> int:
    """Compute the calendar-month bucket start for a millisecond timestamp."""
    return compute_month_bucket(ts_ms // 1000, months) * 1000


def next_month_bucket(bucket_start_seconds: int, months: int = 1) -> int:
    """Return the next calendar-month bucket start in seconds."""
    dt = datetime.fromtimestamp(bucket_start_seconds, tz=timezone.utc)
    dt = dt.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    month = dt.month - 1 + months
    year = dt.year + month // 12
    month = month % 12 + 1
    return int(datetime(year, month, 1, tzinfo=timezone.utc).timestamp())


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
