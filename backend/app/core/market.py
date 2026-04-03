import re
import calendar
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

# --------------- Ephemeral (cache-only) intervals ---------------
# Ephemeral intervals are never persisted to the database and never
# trigger backfill.  Data lives only in the in-memory cache and is
# discarded when the process exits.  This is appropriate for very
# high-frequency intervals like 1s where:
#   - Historical data has limited value (users care about real-time)
#   - Data volume is enormous (86,400 bars/day for 1s)
#   - Backfill would be prohibitively slow
EPHEMERAL_INTERVALS: set[str] = {"1s"}


def is_ephemeral_interval(interval: str) -> bool:
    """Return True if the interval is ephemeral (cache-only, no DB persistence)."""
    return interval in EPHEMERAL_INTERVALS


def get_tier_for_interval(interval: str) -> str:
    """Classify an interval into a storage tier based on bar duration.

    Returns one of: 'seconds', 'minutes', 'hours', 'daily'.

    Examples::

        get_tier_for_interval('1s')  -> 'seconds'
        get_tier_for_interval('45m') -> 'minutes'
        get_tier_for_interval('4h')  -> 'hours'
        get_tier_for_interval('1d')  -> 'daily'
        get_tier_for_interval('1w')  -> 'daily'
    """
    secs = parse_custom_interval(interval)
    if secs is None:
        return "minutes"  # safe fallback
    if secs < 60:
        return "seconds"
    if secs < 3600:
        return "minutes"
    if secs < 86400:
        return "hours"
    return "daily"


# --------------- Weekly alignment constants ---------------
# Unix epoch (1970-01-01) is a Thursday.
# To align weekly buckets to Monday 00:00 UTC, we offset by 4 days
# to the first Monday after epoch: 1970-01-05.
_WEEK_EPOCH_OFFSET_S = 4 * 86400       # 345600 seconds
_WEEK_EPOCH_OFFSET_MS = 4 * 86400_000  # 345600000 milliseconds
_WEEKLY_RE = re.compile(r"^(\d+)w$")

# --------------- Custom interval parsing ---------------

_UNIT_SECONDS = {
    "s": 1,
    "m": 60,
    "h": 3600,
    "d": 86400,
    "w": 604800,
    "M": 2592000,  # 30 days approximation
}

_INTERVAL_RE = re.compile(r"^(\d+)([smhdwM])$")


def parse_custom_interval(interval: str) -> int | None:
    """Parse an interval string like '7m', '45m', '3h' into total seconds.

    Returns None if the string format is invalid.
    """
    if interval in INTERVAL_SECONDS:
        return INTERVAL_SECONDS[interval]
    m = _INTERVAL_RE.match(interval)
    if not m:
        return None
    num, unit = int(m.group(1)), m.group(2)
    if num <= 0:
        return None
    return num * _UNIT_SECONDS[unit]


def is_custom_interval(interval: str) -> bool:
    """Return True if *interval* is NOT a native exchange interval."""
    return interval not in VALID_INTERVALS


def is_weekly_interval(interval: str) -> bool:
    """Return True if *interval* uses week units (e.g. '1w', '2w', '3w')."""
    return bool(_WEEKLY_RE.match(interval))


def compute_bucket_start(
    ts_seconds: int,
    bucket_width_seconds: int,
    *,
    interval: Optional[str] = None,
) -> int:
    """Compute the time-bucket start for a Unix timestamp (seconds).

    For weekly intervals (e.g. '1w', '2w'), aligns to Monday 00:00 UTC.
    For all other intervals, uses simple integer division from Unix epoch.

    Args:
        ts_seconds:           Unix timestamp in seconds.
        bucket_width_seconds: Width of each bucket in seconds.
        interval:             Original interval string (e.g. '2w') used to
                              detect weekly alignment.  If None, falls back
                              to epoch-aligned division.
    """
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
    """Same as ``compute_bucket_start`` but with millisecond timestamps."""
    if interval is not None and is_weekly_interval(interval):
        return (
            ((ts_ms - _WEEK_EPOCH_OFFSET_MS) // bucket_width_ms)
            * bucket_width_ms
            + _WEEK_EPOCH_OFFSET_MS
        )
    return (ts_ms // bucket_width_ms) * bucket_width_ms


# Base intervals we can actually query from the exchange, ordered
# from smallest to largest (skip 1s because it produces huge data).
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


def find_best_base_interval(
    custom_seconds: int,
    *,
    interval: str | None = None,
) -> tuple[str, int]:
    """Find the largest native exchange interval that divides custom_seconds evenly.

    Returns (base_interval_str, aggregation_factor).
    Example: custom_seconds=2700 (45m) -> ("15m", 3)  because 45 / 15 = 3.

    For monthly intervals (2M, 3M, …), always use ``1d`` as the base because
    calendar months have variable day counts and larger intervals like ``3d``
    or ``1w`` would produce misaligned or incomplete buckets.
    """
    # Monthly intervals always use 1d as base — calendar months are variable
    # length, so larger fixed intervals (3d, 1w) don't align to month boundaries.
    if interval is not None and is_monthly_interval(interval):
        # Approximate: use 30 days per month for factor calculation
        month_count = parse_monthly_count(interval) or 1
        factor = month_count * 30  # approximate days per bucket
        return ("1d", factor)

    best_interval = "1m"
    best_factor = custom_seconds // 60

    for name, secs in reversed(_BASE_INTERVALS_ORDERED):
        if secs >= custom_seconds:
            continue   # skip base intervals >= target
        if custom_seconds % secs == 0:
            best_interval = name
            best_factor = custom_seconds // secs
            break

    return best_interval, best_factor


# Threshold: if the factor (number of base candles per custom candle) exceeds
# this, we switch to multi-resolution strategy for efficiency.
_MULTI_RES_FACTOR_THRESHOLD = 20


def find_optimal_fetch_plan(custom_seconds: int) -> dict:
    """Determine the most efficient fetching strategy for a custom interval.

    For most intervals (e.g. 45m → 15m base, factor 3), a single base interval
    suffices.  But when the only exact-divisor base is very small (e.g. 91m can
    only use 1m, factor 91), we enable **multi-resolution** mode:
      • coarse interval (e.g. 1h) covers the middle of each custom bucket
      • fine interval (1m) fills gaps at bucket boundaries

    Returns dict:
      use_multi_res : bool
      base_interval : str        — fine / exact-divisor interval
      base_seconds  : int
      factor        : int
      coarse_interval : str|None — larger interval for bulk (only when multi-res)
      coarse_seconds  : int
    """
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

    # Find the largest native interval that is *strictly smaller* than the
    # custom interval AND larger than the fine base.
    coarse_interval = None
    coarse_seconds = 0
    for name, secs in reversed(_BASE_INTERVALS_ORDERED):
        if secs >= custom_seconds:
            continue
        if secs > base_seconds:
            coarse_interval = name
            coarse_seconds = secs
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


# --------------- Monthly (calendar) interval helpers ---------------

_MONTHLY_RE = re.compile(r"^(\d+)M$")


def is_monthly_interval(interval: str) -> bool:
    """Return True if *interval* uses calendar-month units (e.g. '1M', '2M', '3M')."""
    return bool(_MONTHLY_RE.match(interval))


def parse_monthly_count(interval: str) -> int | None:
    """Extract the month count from a monthly interval string.

    Returns the number of months, or None if *interval* is not monthly.

    Examples::

        parse_monthly_count("1M")  → 1
        parse_monthly_count("3M")  → 3
        parse_monthly_count("5m")  → None  (lowercase 'm' = minutes)
    """
    m = _MONTHLY_RE.match(interval)
    if not m:
        return None
    n = int(m.group(1))
    return n if n > 0 else None


def compute_month_bucket(ts_seconds: int, months: int = 1) -> int:
    """Compute the calendar-month bucket start (UTC) for a unix timestamp.

    Aligns to year-start: N-month groups always begin from January.

    Args:
        ts_seconds: Unix timestamp in **seconds**.
        months:     Bucket width in calendar months (e.g. 1, 2, 3).

    Returns:
        Unix timestamp (seconds) of the bucket start (1st of the month, 00:00 UTC).

    Examples::

        # 2024-03-15 → bucket start for 3M = 2024-01-01
        compute_month_bucket(1710504000, 3)

        # 2024-05-10 → bucket start for 2M = 2024-05-01
        compute_month_bucket(1715299200, 2)
    """
    dt = datetime.fromtimestamp(ts_seconds, tz=timezone.utc)
    # Zero-based month index from January
    month_index = dt.month - 1  # 0..11
    # Which N-month group does this fall in?
    group_index = month_index // months
    bucket_month = group_index * months + 1  # 1-based month
    bucket_start = dt.replace(month=bucket_month, day=1, hour=0, minute=0, second=0, microsecond=0)
    return int(bucket_start.timestamp())


def compute_month_bucket_ms(ts_ms: int, months: int = 1) -> int:
    """Same as ``compute_month_bucket`` but with millisecond timestamps."""
    return compute_month_bucket(ts_ms // 1000, months) * 1000


def next_month_bucket(bucket_start_seconds: int, months: int = 1) -> int:
    """Return the start of the next N-month bucket (seconds)."""
    dt = datetime.fromtimestamp(bucket_start_seconds, tz=timezone.utc)
    dt = dt.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    # Advance by N months
    new_month = dt.month + months
    new_year = dt.year + (new_month - 1) // 12
    new_month = (new_month - 1) % 12 + 1
    next_dt = dt.replace(year=new_year, month=new_month)
    return int(next_dt.timestamp())


def aggregate_rows_by_month(
    base_rows: list[dict],
    months: int = 1,
) -> list[dict]:
    """Aggregate lightweight-chart rows into calendar-month buckets.

    Each element in *base_rows* must have keys:
        time (unix seconds), open, high, low, close, volume

    Returns a list of aggregated candle dicts sorted by ``time`` ascending.
    """
    if not base_rows:
        return []

    buckets: dict[int, list[dict]] = {}
    for row in base_rows:
        ts = row["time"]
        bucket_start = compute_month_bucket(ts, months)
        buckets.setdefault(bucket_start, []).append(row)

    result: list[dict] = []
    for bucket_start in sorted(buckets):
        rows = sorted(buckets[bucket_start], key=lambda r: r["time"])
        result.append({
            "time": bucket_start,
            "open": rows[0]["open"],
            "high": max(r["high"] for r in rows),
            "low": min(r["low"] for r in rows),
            "close": rows[-1]["close"],
            "volume": round(sum(r["volume"] for r in rows), 8),
        })
    return result
