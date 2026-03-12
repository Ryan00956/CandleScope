"""
Kline Aggregator — synthesize custom time-period candles from base exchange data.

Given a set of base-interval OHLCV rows (e.g. 1-min candles), this module
groups them by a custom time window (e.g. 7 min) and produces aggregated
OHLCV candles using the standard rules:
  O = first Open,  H = max(High),  L = min(Low),  C = last Close,  V = sum(Volume)

For monthly intervals (e.g. '1M', '2M', '3M'), calendar-month aligned
bucketing is used instead of fixed-duration (30-day) bucketing.
"""
from __future__ import annotations

from app.core.market import (
    aggregate_rows_by_month,
    compute_month_bucket,
    is_monthly_interval,
    parse_monthly_count,
)


def aggregate_klines(
    base_rows: list[dict],
    custom_interval_seconds: int,
    *,
    interval: str | None = None,
) -> list[dict]:
    """Aggregate *base_rows* into candles of width *custom_interval_seconds*.

    Each element in *base_rows* must have keys:
        time (unix seconds), open, high, low, close, volume

    For monthly intervals (detected via the optional *interval* parameter,
    e.g. '1M', '2M', '3M'), calendar-month aligned bucketing is used
    instead of fixed-duration (30-day) bucketing.  If *interval* is not
    provided, the function also checks whether *custom_interval_seconds*
    corresponds to a 30-day multiple and falls back to fixed bucketing.

    Returns a list of aggregated candle dicts sorted by ``time`` ascending.
    """
    if not base_rows:
        return []

    # Check if this is a monthly interval — use calendar-month alignment
    month_count = parse_monthly_count(interval) if interval else None
    if month_count is not None:
        return aggregate_rows_by_month(base_rows, months=month_count)

    bucket_width = custom_interval_seconds

    # 1. Group base rows into time buckets
    buckets: dict[int, list[dict]] = {}
    for row in base_rows:
        ts = row["time"]  # unix seconds
        bucket_start = (ts // bucket_width) * bucket_width
        buckets.setdefault(bucket_start, []).append(row)

    # 2. Merge each bucket into one OHLCV candle
    result: list[dict] = []
    for bucket_start in sorted(buckets):
        rows = buckets[bucket_start]
        # Sort by time to ensure first/last are correct
        rows.sort(key=lambda r: r["time"])
        result.append({
            "time": bucket_start,
            "open": rows[0]["open"],
            "high": max(r["high"] for r in rows),
            "low": min(r["low"] for r in rows),
            "close": rows[-1]["close"],
            "volume": round(sum(r["volume"] for r in rows), 8),
        })

    return result


def aggregate_realtime_into_last(
    current_custom_candle: dict | None,
    incoming: dict,
    custom_interval_seconds: int,
    *,
    interval: str | None = None,
) -> tuple[dict, bool]:
    """Merge a single incoming tick/candle into the custom candle being formed.

    Returns (updated_candle, is_new_candle).
    If the incoming data falls into a new time bucket, a brand new candle is
    started and ``is_new_candle`` is True.

    For monthly intervals (via *interval* param), uses calendar-month alignment.
    """
    month_count = parse_monthly_count(interval) if interval else None
    if month_count is not None:
        bucket_start = compute_month_bucket(incoming["time"], month_count)
    else:
        bucket_width = custom_interval_seconds
        bucket_start = (incoming["time"] // bucket_width) * bucket_width

    if current_custom_candle is None or bucket_start != current_custom_candle["time"]:
        # New candle
        new_candle = {
            "time": bucket_start,
            "open": incoming["open"],
            "high": incoming["high"],
            "low": incoming["low"],
            "close": incoming["close"],
            "volume": round(incoming["volume"], 8),
        }
        return new_candle, True

    # Update existing candle in-place
    c = {**current_custom_candle}
    c["high"] = max(c["high"], incoming["high"])
    c["low"] = min(c["low"], incoming["low"])
    c["close"] = incoming["close"]
    c["volume"] = round(c["volume"] + incoming["volume"], 8)
    return c, False


def aggregate_multi_resolution(
    custom_interval_seconds: int,
    coarse_rows: list[dict],
    coarse_seconds: int,
    fine_rows: list[dict],
    fine_seconds: int,
) -> list[dict]:
    """Aggregate candles from two resolution levels into custom-period candles.

    Uses coarse candles (e.g. 1h) for bulk coverage inside each custom bucket,
    and fine candles (e.g. 1m) to fill gaps at bucket boundaries.

    A coarse candle is only used if it fits **entirely** within the custom
    bucket.  Fine candles that overlap with an already-placed coarse candle
    are skipped (no double-counting).

    Example for 91m custom bucket [00:00, 01:31):
      • 1h candle [00:00, 01:00)  → used as coarse
      • 1m candles [01:00, 01:31) → 31 fine candles fill the gap
      • Total: 32 data points instead of 91 pure 1m candles
    """
    if not coarse_rows and not fine_rows:
        return []

    bucket_width = custom_interval_seconds

    # --- Phase 1: place coarse candles that fit entirely within buckets ---
    buckets: dict[int, list[dict]] = {}
    # Track which time ranges are covered by coarse candles per bucket
    covered: dict[int, list[tuple[int, int]]] = {}

    for row in coarse_rows:
        ts = row["time"]
        bucket_start = (ts // bucket_width) * bucket_width
        candle_end = ts + coarse_seconds

        # Only include if the coarse candle ends within the bucket
        if candle_end <= bucket_start + bucket_width:
            buckets.setdefault(bucket_start, []).append(row)
            covered.setdefault(bucket_start, []).append((ts, candle_end))

    # --- Phase 2: add fine candles for uncovered gaps ---
    for row in fine_rows:
        ts = row["time"]
        bucket_start = (ts // bucket_width) * bucket_width
        candle_end = ts + fine_seconds

        # Check if this fine candle is already covered by a coarse candle
        is_covered = False
        if bucket_start in covered:
            for cs, ce in covered[bucket_start]:
                if ts >= cs and candle_end <= ce:
                    is_covered = True
                    break

        if not is_covered:
            buckets.setdefault(bucket_start, []).append(row)

    # --- Phase 3: merge each bucket into one OHLCV candle ---
    result: list[dict] = []
    for bucket_start in sorted(buckets):
        rows = buckets[bucket_start]
        rows.sort(key=lambda r: r["time"])
        result.append({
            "time": bucket_start,
            "open": rows[0]["open"],
            "high": max(r["high"] for r in rows),
            "low": min(r["low"] for r in rows),
            "close": rows[-1]["close"],
            "volume": round(sum(r["volume"] for r in rows), 8),
        })

    return result
