import re

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


def find_best_base_interval(custom_seconds: int) -> tuple[str, int]:
    """Find the largest native exchange interval that divides custom_seconds evenly.

    Returns (base_interval_str, aggregation_factor).
    Example: custom_seconds=2700 (45m) -> ("15m", 3)  because 45 / 15 = 3.
    """
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
