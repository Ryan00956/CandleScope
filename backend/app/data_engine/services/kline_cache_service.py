from __future__ import annotations

import time

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


def _normalize_symbol(symbol: str) -> str:
    return symbol.upper().strip()


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


def _store_df(symbol: str, interval: str, df: pd.DataFrame, source: str = "binance") -> int:
    rows = dataframe_to_rows(df)
    return upsert_klines(symbol=symbol, interval=interval, rows=rows, source=source)


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
    bounds = get_bounds(symbol, interval)
    latest = bounds["latest_open_time"]

    if latest is None:
        cursor_start = target_end_ms - BINANCE_PAGE_LIMIT * interval_ms
    else:
        latest = int(latest)
        if latest >= target_end_ms - interval_ms:
            return 0
        cursor_start = latest + interval_ms

    total_written = 0
    for _ in range(max_batches):
        if cursor_start > target_end_ms:
            break

        df = fetch_klines(
            symbol=symbol,
            interval=interval,
            limit=BINANCE_PAGE_LIMIT,
            start_ms=cursor_start,
            end_ms=target_end_ms,
        )
        if df is None or df.empty:
            break

        total_written += _store_df(symbol, interval, df)
        newest = int(df["openTimeStamp"].max())
        if newest < cursor_start:
            break

        cursor_start = newest + interval_ms
        if len(df) < BINANCE_PAGE_LIMIT:
            break
        time.sleep(0.08)

    return total_written


def _ensure_cached_range(symbol: str, interval: str, start_ms: int, end_ms: int) -> int:
    written = 0
    written += _backfill_left(symbol, interval, target_start_ms=start_ms, end_ms=end_ms)
    written += _refresh_right(symbol, interval, target_end_ms=end_ms)
    return written


def get_cached_history(symbol: str, interval: str, days: int) -> dict:
    symbol = _normalize_symbol(symbol)
    end_ms = int(time.time() * 1000)
    start_ms = end_ms - int(days * 24 * 60 * 60 * 1000)

    fetched = _ensure_cached_range(symbol, interval, start_ms=start_ms, end_ms=end_ms)
    rows = query_klines(symbol, interval, start_ms=start_ms, end_ms=end_ms, order="ASC")
    bounds = get_bounds(symbol, interval)

    return {
        "data": _rows_to_lightweight(rows),
        "fetched": fetched,
        "source": "cache+binance" if fetched > 0 else "cache",
        "bounds": bounds,
    }


def get_cached_latest(symbol: str, interval: str, limit: int) -> dict:
    symbol = _normalize_symbol(symbol)
    now_ms = int(time.time() * 1000)
    interval_ms = interval_to_milliseconds(interval)

    fetched = _refresh_right(symbol, interval, target_end_ms=now_ms)
    rows = query_klines(symbol, interval, end_ms=now_ms, limit=limit, order="DESC")

    if not rows:
        target_start = now_ms - limit * interval_ms
        fetched += _backfill_left(symbol, interval, target_start_ms=target_start, end_ms=now_ms)
        rows = query_klines(symbol, interval, end_ms=now_ms, limit=limit, order="DESC")

    rows.reverse()
    bounds = get_bounds(symbol, interval)
    return {
        "data": _rows_to_lightweight(rows),
        "fetched": fetched,
        "source": "cache+binance" if fetched > 0 else "cache",
        "bounds": bounds,
    }


def get_more_left(symbol: str, interval: str, before_seconds: int, bars: int = 500) -> dict:
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
            max_batches=12,
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
