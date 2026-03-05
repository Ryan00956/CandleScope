from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor, as_completed
import threading

import pandas as pd

from app.data_engine.collectors.binance.spot_fetcher import fetch_klines
from app.data_engine.storage.klines_repo import (
    dataframe_to_rows,
    delete_klines,
    fetch_before,
    get_bounds,
    has_older_than,
    interval_to_milliseconds,
    query_klines,
    upsert_klines,
)

BINANCE_PAGE_LIMIT = 1000
MAX_BACKFILL_BATCHES = 24
MAX_REFRESH_BATCHES = 8
LIVE_ROW_CACHE_TTL_MS = 2000
LIVE_ROW_STALE_MS = 10000
_LIVE_ROW_CACHE: dict[tuple[str, str], dict] = {}
LATEST_REFRESH_MIN_GAP_MS = 15000
_LATEST_REFRESH_ATTEMPT_MS: dict[tuple[str, str], int] = {}

# Shared thread pool for background network IO
_io_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="kline-io")
# Track in-flight background tasks to avoid duplicate work
_bg_tasks_lock = threading.Lock()
_bg_tasks_in_flight: set[tuple[str, str]] = set()


def _normalize_symbol(symbol: str) -> str:
    return symbol.upper().strip()


def _latest_closed_open_time_ms(now_ms: int, interval_ms: int) -> int | None:
    if interval_ms <= 0:
        return None
    current_open = (now_ms // interval_ms) * interval_ms
    latest_closed_open = current_open - interval_ms
    if latest_closed_open < 0:
        return None
    return latest_closed_open


def _rows_to_lightweight(rows: list[dict]) -> list[dict]:
    return [
        {
            "time": int(r["open_time"]) // 1000,
            "open": round(float(r["open"]), 8),
            "high": round(float(r["high"]), 8),
            "low": round(float(r["low"]), 8),
            "close": round(float(r["close"]), 8),
            "volume": round(float(r["volume"]), 8),
        }
        for r in rows
    ]


def _live_row_to_lightweight(row: pd.Series) -> dict:
    return {
        "time": int(row["openTimeStamp"]) // 1000,
        "open": round(float(row["Open"]), 8),
        "high": round(float(row["High"]), 8),
        "low": round(float(row["Low"]), 8),
        "close": round(float(row["Close"]), 8),
        "volume": round(float(row["Volume"]), 8),
    }


def _fetch_live_open_row(symbol: str, interval: str) -> dict | None:
    now_ms = int(time.time() * 1000)
    cache_key = (symbol, interval)
    cached = _LIVE_ROW_CACHE.get(cache_key)
    if cached and (now_ms - int(cached["fetched_at"]) <= LIVE_ROW_CACHE_TTL_MS):
        return cached["row"]

    df = fetch_klines(symbol=symbol, interval=interval, limit=3)
    if df is None or df.empty:
        if cached and (now_ms - int(cached["fetched_at"]) <= LIVE_ROW_STALE_MS):
            return cached["row"]
        return None

    live_df = df[df["closeTimeStamp"] > now_ms]
    if live_df.empty:
        if cached and (now_ms - int(cached["fetched_at"]) <= LIVE_ROW_STALE_MS):
            return cached["row"]
        return None

    latest_live = live_df.sort_values("openTimeStamp").iloc[-1]
    row = _live_row_to_lightweight(latest_live)
    _LIVE_ROW_CACHE[cache_key] = {"fetched_at": now_ms, "row": row}
    return row


def _merge_live_row(data: list[dict], live_row: dict | None) -> list[dict]:
    if live_row is None:
        return data
    if not data:
        return [live_row]

    merged = list(data)
    for i, row in enumerate(merged):
        if row["time"] == live_row["time"]:
            merged[i] = live_row
            return merged

    if live_row["time"] > merged[-1]["time"]:
        merged.append(live_row)
    return merged


def _store_df(symbol: str, interval: str, df: pd.DataFrame, source: str = "binance") -> int:
    rows = dataframe_to_rows(df)
    if not rows:
        return 0

    now_ms = int(time.time() * 1000)
    # Keep storage strictly on closed candles; unfinished candle should stay in-memory only.
    rows = [r for r in rows if int(r["close_time"]) <= now_ms]
    if not rows:
        return 0

    return upsert_klines(symbol=symbol, interval=interval, rows=rows, source=source)


def _prune_unclosed_rows(symbol: str, interval: str, now_ms: int) -> int:
    interval_ms = interval_to_milliseconds(interval)
    latest_closed_open_ms = _latest_closed_open_time_ms(now_ms, interval_ms)
    if latest_closed_open_ms is None:
        return 0

    bounds = get_bounds(symbol, interval)
    latest = bounds["latest_open_time"]
    if latest is None or int(latest) <= latest_closed_open_ms:
        return 0

    return delete_klines(
        symbol=symbol,
        interval=interval,
        start_ms=latest_closed_open_ms + interval_ms,
    )


def _backfill_left(
    symbol: str,
    interval: str,
    target_start_ms: int,
    end_ms: int | None = None,
    max_batches: int = MAX_BACKFILL_BATCHES,
) -> int:
    bounds = get_bounds(symbol, interval)
    earliest = bounds["earliest_open_time"]
    if earliest is not None and earliest <= target_start_ms:
        return 0

    cursor_end = end_ms if end_ms is not None else int(time.time() * 1000)
    if earliest is not None:
        cursor_end = min(cursor_end, int(earliest) - 1)

    total_written = 0
    for _ in range(max_batches):
        if cursor_end <= target_start_ms:
            break

        df = fetch_klines(
            symbol=symbol,
            interval=interval,
            limit=BINANCE_PAGE_LIMIT,
            end_ms=cursor_end,
        )
        if df is None or df.empty:
            break

        total_written += _store_df(symbol, interval, df)
        oldest = int(df["openTimeStamp"].min())
        if oldest <= target_start_ms:
            break
        if oldest >= cursor_end:
            break

        cursor_end = oldest - 1
        time.sleep(0.12)

    return total_written


def _refresh_right(
    symbol: str,
    interval: str,
    target_end_ms: int,
    max_batches: int = MAX_REFRESH_BATCHES,
) -> int:
    interval_ms = interval_to_milliseconds(interval)
    latest_closed_open_ms = _latest_closed_open_time_ms(target_end_ms, interval_ms)
    if latest_closed_open_ms is None:
        return 0

    bounds = get_bounds(symbol, interval)
    latest = bounds["latest_open_time"]

    if latest is None:
        cursor_start = max(0, latest_closed_open_ms - (BINANCE_PAGE_LIMIT - 1) * interval_ms)
    else:
        latest = int(latest)
        if latest >= latest_closed_open_ms:
            return 0
        cursor_start = latest + interval_ms

    total_written = 0
    for _ in range(max_batches):
        if cursor_start > latest_closed_open_ms:
            break

        df = fetch_klines(
            symbol=symbol,
            interval=interval,
            limit=BINANCE_PAGE_LIMIT,
            start_ms=cursor_start,
            end_ms=latest_closed_open_ms,
        )
        if df is None or df.empty:
            break

        total_written += _store_df(symbol, interval, df)
        newest = int(df["openTimeStamp"].max())
        if newest < cursor_start:
            break

        cursor_start = newest + interval_ms
        if cursor_start > latest_closed_open_ms:
            break
        if len(df) < BINANCE_PAGE_LIMIT:
            break
        time.sleep(0.08)

    return total_written


def _refresh_latest_window(symbol: str, interval: str, window: int = 5) -> int:
    window = max(1, min(window, BINANCE_PAGE_LIMIT))
    df = fetch_klines(symbol=symbol, interval=interval, limit=window)
    if df is None or df.empty:
        return 0
    return _store_df(symbol, interval, df)


def _refresh_right_if_needed(symbol: str, interval: str, now_ms: int) -> int:
    interval_ms = interval_to_milliseconds(interval)
    latest_closed_open_ms = _latest_closed_open_time_ms(now_ms, interval_ms)
    if latest_closed_open_ms is None:
        return 0

    bounds = get_bounds(symbol, interval)
    latest = bounds["latest_open_time"]
    if latest is not None and int(latest) >= latest_closed_open_ms:
        return 0

    key = (symbol, interval)
    last_attempt = _LATEST_REFRESH_ATTEMPT_MS.get(key, 0)
    if now_ms - last_attempt < LATEST_REFRESH_MIN_GAP_MS:
        return 0

    _LATEST_REFRESH_ATTEMPT_MS[key] = now_ms
    return _refresh_right(symbol, interval, target_end_ms=now_ms)


def _ensure_cached_range(symbol: str, interval: str, start_ms: int, end_ms: int) -> int:
    """Backfill left + refresh right in PARALLEL using thread pool."""
    futures = []
    futures.append(_io_pool.submit(_backfill_left, symbol, interval, start_ms, end_ms))
    futures.append(_io_pool.submit(_refresh_right, symbol, interval, end_ms))

    written = 0
    for f in as_completed(futures):
        try:
            written += f.result(timeout=30)
        except Exception as exc:
            print(f"_ensure_cached_range sub-task error: {exc}")
    return written


def _bg_ensure_cached(symbol: str, interval: str, start_ms: int, end_ms: int) -> None:
    """Background thread task: fill gaps, then clear in-flight flag."""
    key = (symbol, interval)
    try:
        _ensure_cached_range(symbol, interval, start_ms, end_ms)
    except Exception as exc:
        print(f"bg_ensure_cached error {key}: {exc}")
    finally:
        with _bg_tasks_lock:
            _bg_tasks_in_flight.discard(key)


def get_cached_history(symbol: str, interval: str, days: int) -> dict:
    """
    Two-phase approach:
    Phase 1 — Instant: return whatever is already in the local cache.
    Phase 2 — Background: if gaps exist, submit a background thread to
              backfill/refresh. The next poll or interval switch will pick
              up the newly cached data.
    """
    symbol = _normalize_symbol(symbol)
    end_ms = int(time.time() * 1000)
    start_ms = end_ms - int(days * 24 * 60 * 60 * 1000)

    _prune_unclosed_rows(symbol, interval, end_ms)

    # Phase 1: return cache immediately
    rows = query_klines(symbol, interval, start_ms=start_ms, end_ms=end_ms, order="ASC")
    bounds = get_bounds(symbol, interval)
    cached_data = _rows_to_lightweight(rows)

    # Phase 2: kick off background fill if there are likely gaps
    needs_fill = False
    if not rows:
        needs_fill = True
    else:
        earliest_cached = bounds.get("earliest_open_time")
        latest_cached = bounds.get("latest_open_time")
        if earliest_cached is not None and int(earliest_cached) > start_ms:
            needs_fill = True
        if latest_cached is not None:
            interval_ms = interval_to_milliseconds(interval)
            latest_closed = _latest_closed_open_time_ms(end_ms, interval_ms)
            if latest_closed and int(latest_cached) < latest_closed:
                needs_fill = True

    bg_submitted = False
    if needs_fill:
        key = (symbol, interval)
        with _bg_tasks_lock:
            if key not in _bg_tasks_in_flight:
                _bg_tasks_in_flight.add(key)
                bg_submitted = True

        if bg_submitted:
            _io_pool.submit(_bg_ensure_cached, symbol, interval, start_ms, end_ms)

    # If we have zero cached rows, we must do a synchronous fill (first-time load)
    if not cached_data and needs_fill:
        # Wait briefly for inflight task, or do inline fill
        _ensure_cached_range(symbol, interval, start_ms, end_ms)
        rows = query_klines(symbol, interval, start_ms=start_ms, end_ms=end_ms, order="ASC")
        bounds = get_bounds(symbol, interval)
        cached_data = _rows_to_lightweight(rows)
        return {
            "data": cached_data,
            "fetched": len(cached_data),
            "source": "cache+binance",
            "bounds": bounds,
        }

    return {
        "data": cached_data,
        "fetched": 0,
        "source": "cache" if cached_data else "empty",
        "bounds": bounds,
    }


def get_cached_latest(symbol: str, interval: str, limit: int) -> dict:
    symbol = _normalize_symbol(symbol)
    now_ms = int(time.time() * 1000)
    interval_ms = interval_to_milliseconds(interval)

    _prune_unclosed_rows(symbol, interval, now_ms)
    fetched = _refresh_right_if_needed(symbol, interval, now_ms)
    rows = query_klines(symbol, interval, end_ms=now_ms, limit=limit, order="DESC")

    if not rows:
        target_start = now_ms - limit * interval_ms
        fetched += _backfill_left(symbol, interval, target_start_ms=target_start, end_ms=now_ms)
        fetched += _refresh_right(symbol, interval, target_end_ms=now_ms)
        rows = query_klines(symbol, interval, end_ms=now_ms, limit=limit, order="DESC")

    rows.reverse()
    data = _rows_to_lightweight(rows)
    live_row = _fetch_live_open_row(symbol=symbol, interval=interval)
    data = _merge_live_row(data, live_row)
    if len(data) > limit:
        data = data[-limit:]
    bounds = get_bounds(symbol, interval)
    return {
        "data": data,
        "fetched": fetched,
        "source": "cache+binance" if (fetched > 0 or live_row is not None) else "cache",
        "bounds": bounds,
    }


def get_more_left(symbol: str, interval: str, before_seconds: int, bars: int = 500, max_batches: int = 12) -> dict:
    symbol = _normalize_symbol(symbol)
    before_ms = before_seconds * 1000
    interval_ms = interval_to_milliseconds(interval)

    rows = fetch_before(symbol=symbol, interval=interval, before_ms=before_ms, limit=bars)
    fetched = 0
    if len(rows) < bars:
        target_start = before_ms - bars * interval_ms
        fetched += _backfill_left(
            symbol=symbol,
            interval=interval,
            target_start_ms=target_start,
            end_ms=before_ms - 1,
            max_batches=max_batches,
        )
        rows = fetch_before(symbol=symbol, interval=interval, before_ms=before_ms, limit=bars)

    if rows:
        has_more = has_older_than(symbol, interval, rows[0]["open_time"])
    else:
        has_more = False

    return {
        "data": _rows_to_lightweight(rows),
        "fetched": fetched,
        "source": "cache+binance" if fetched > 0 else "cache",
        "has_more": has_more,
        "bounds": get_bounds(symbol, interval),
    }


def get_cached_meta(symbol: str, interval: str) -> dict:
    symbol = _normalize_symbol(symbol)
    return get_bounds(symbol, interval)


def delete_cached_klines(
    symbol: str,
    interval: str,
    start_seconds: int | None = None,
    end_seconds: int | None = None,
) -> int:
    symbol = _normalize_symbol(symbol)
    start_ms = start_seconds * 1000 if start_seconds is not None else None
    end_ms = end_seconds * 1000 if end_seconds is not None else None
    return delete_klines(symbol=symbol, interval=interval, start_ms=start_ms, end_ms=end_ms)


def calculate_sma(
    symbol: str,
    interval: str,
    period: int = 20,
    start_seconds: int | None = None,
    end_seconds: int | None = None,
) -> list[dict]:
    symbol = _normalize_symbol(symbol)
    start_ms = start_seconds * 1000 if start_seconds is not None else None
    end_ms = end_seconds * 1000 if end_seconds is not None else None

    rows = query_klines(symbol=symbol, interval=interval, start_ms=start_ms, end_ms=end_ms, order="ASC")
    if not rows:
        return []

    df = pd.DataFrame(rows)
    df["sma"] = df["close"].rolling(window=period, min_periods=period).mean()
    df = df.dropna(subset=["sma"])

    result = []
    for _, row in df.iterrows():
        result.append(
            {
                "time": int(row["open_time"]) // 1000,
                "value": round(float(row["sma"]), 8),
            }
        )
    return result
