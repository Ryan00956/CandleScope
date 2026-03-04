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
    df = fetch_klines(symbol=symbol, interval=interval, limit=3)
    if df is None or df.empty:
        return None

    live_df = df[df["closeTimeStamp"] > now_ms]
    if live_df.empty:
        return None

    latest_live = live_df.sort_values("openTimeStamp").iloc[-1]
    return _live_row_to_lightweight(latest_live)


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


def _ensure_cached_range(symbol: str, interval: str, start_ms: int, end_ms: int) -> int:
    written = 0
    written += _backfill_left(symbol, interval, target_start_ms=start_ms, end_ms=end_ms)
    written += _refresh_right(symbol, interval, target_end_ms=end_ms)
    return written


def get_cached_history(symbol: str, interval: str, days: int) -> dict:
    symbol = _normalize_symbol(symbol)
    end_ms = int(time.time() * 1000)
    start_ms = end_ms - int(days * 24 * 60 * 60 * 1000)

    _prune_unclosed_rows(symbol, interval, end_ms)
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

    _prune_unclosed_rows(symbol, interval, now_ms)
    fetched = _refresh_right(symbol, interval, target_end_ms=now_ms)
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
