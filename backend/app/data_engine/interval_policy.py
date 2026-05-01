"""Unified interval parsing and bucket policy for data_engine."""
from __future__ import annotations

import calendar
import re
from datetime import datetime, timezone
from typing import Optional


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
        result.append({
            "time": bucket_start,
            "open": rows[0]["open"],
            "high": max(row["high"] for row in rows),
            "low": min(row["low"] for row in rows),
            "close": rows[-1]["close"],
            "volume": round(sum(row["volume"] for row in rows), 8),
        })
    return result


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
