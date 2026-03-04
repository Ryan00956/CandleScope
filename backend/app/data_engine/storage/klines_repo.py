from __future__ import annotations

import sqlite3
import time
from pathlib import Path

import pandas as pd

from app.core.config import KLINES_DB_PATH

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


def interval_to_milliseconds(interval: str) -> int:
    if interval not in INTERVAL_SECONDS:
        raise ValueError(f"Unsupported interval: {interval}")
    return INTERVAL_SECONDS[interval] * 1000


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(KLINES_DB_PATH), timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    return conn


def init_klines_storage() -> None:
    Path(KLINES_DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    with _connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS klines (
                symbol TEXT NOT NULL,
                interval TEXT NOT NULL,
                open_time INTEGER NOT NULL,
                close_time INTEGER,
                open REAL NOT NULL,
                high REAL NOT NULL,
                low REAL NOT NULL,
                close REAL NOT NULL,
                volume REAL NOT NULL,
                quote_volume REAL,
                trades INTEGER,
                taker_buy_base REAL,
                taker_buy_quote REAL,
                source TEXT NOT NULL DEFAULT 'binance',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (symbol, interval, open_time)
            );

            CREATE INDEX IF NOT EXISTS idx_klines_symbol_interval_time
            ON klines(symbol, interval, open_time);
            """
        )


def dataframe_to_rows(df: pd.DataFrame) -> list[dict]:
    if df is None or df.empty:
        return []

    rows: list[dict] = []
    for _, row in df.iterrows():
        rows.append(
            {
                "open_time": int(row["openTimeStamp"]),
                "close_time": int(row["closeTimeStamp"]),
                "open": float(row["Open"]),
                "high": float(row["High"]),
                "low": float(row["Low"]),
                "close": float(row["Close"]),
                "volume": float(row["Volume"]),
                "quote_volume": float(row["QuoteVolume"]),
                "trades": int(row["Trades"]) if pd.notna(row["Trades"]) else None,
                "taker_buy_base": float(row["TakerBuyBase"]),
                "taker_buy_quote": float(row["TakerBuyQuote"]),
            }
        )
    return rows


def upsert_klines(
    symbol: str,
    interval: str,
    rows: list[dict],
    source: str = "binance",
) -> int:
    if not rows:
        return 0

    now_ms = int(time.time() * 1000)
    payload = [
        (
            symbol,
            interval,
            r["open_time"],
            r["close_time"],
            r["open"],
            r["high"],
            r["low"],
            r["close"],
            r["volume"],
            r["quote_volume"],
            r["trades"],
            r["taker_buy_base"],
            r["taker_buy_quote"],
            source,
            now_ms,
            now_ms,
        )
        for r in rows
    ]

    with _connect() as conn:
        conn.executemany(
            """
            INSERT INTO klines (
                symbol, interval, open_time, close_time,
                open, high, low, close, volume, quote_volume,
                trades, taker_buy_base, taker_buy_quote,
                source, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(symbol, interval, open_time) DO UPDATE SET
                close_time = excluded.close_time,
                open = excluded.open,
                high = excluded.high,
                low = excluded.low,
                close = excluded.close,
                volume = excluded.volume,
                quote_volume = excluded.quote_volume,
                trades = excluded.trades,
                taker_buy_base = excluded.taker_buy_base,
                taker_buy_quote = excluded.taker_buy_quote,
                source = excluded.source,
                updated_at = excluded.updated_at
            """,
            payload,
        )
        conn.commit()

    return len(rows)


def query_klines(
    symbol: str,
    interval: str,
    start_ms: int | None = None,
    end_ms: int | None = None,
    limit: int | None = None,
    order: str = "ASC",
) -> list[dict]:
    where = ["symbol = ?", "interval = ?"]
    params: list[object] = [symbol, interval]

    if start_ms is not None:
        where.append("open_time >= ?")
        params.append(start_ms)
    if end_ms is not None:
        where.append("open_time <= ?")
        params.append(end_ms)

    order_sql = "DESC" if order.upper() == "DESC" else "ASC"
    sql = f"""
        SELECT symbol, interval, open_time, close_time,
               open, high, low, close, volume, quote_volume,
               trades, taker_buy_base, taker_buy_quote, source
        FROM klines
        WHERE {" AND ".join(where)}
        ORDER BY open_time {order_sql}
    """
    if limit is not None:
        sql += " LIMIT ?"
        params.append(limit)

    with _connect() as conn:
        rows = conn.execute(sql, params).fetchall()

    return [dict(r) for r in rows]


def fetch_before(symbol: str, interval: str, before_ms: int, limit: int = 500) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT symbol, interval, open_time, close_time,
                   open, high, low, close, volume, quote_volume,
                   trades, taker_buy_base, taker_buy_quote, source
            FROM klines
            WHERE symbol = ? AND interval = ? AND open_time < ?
            ORDER BY open_time DESC
            LIMIT ?
            """,
            (symbol, interval, before_ms, limit),
        ).fetchall()

    records = [dict(r) for r in rows]
    records.reverse()
    return records


def get_bounds(symbol: str, interval: str) -> dict:
    with _connect() as conn:
        row = conn.execute(
            """
            SELECT
                MIN(open_time) AS earliest_open_time,
                MAX(open_time) AS latest_open_time,
                COUNT(*) AS total_count
            FROM klines
            WHERE symbol = ? AND interval = ?
            """,
            (symbol, interval),
        ).fetchone()

    if row is None:
        return {"earliest_open_time": None, "latest_open_time": None, "total_count": 0}
    return dict(row)


def has_older_than(symbol: str, interval: str, open_time_ms: int) -> bool:
    with _connect() as conn:
        row = conn.execute(
            """
            SELECT 1
            FROM klines
            WHERE symbol = ? AND interval = ? AND open_time < ?
            LIMIT 1
            """,
            (symbol, interval, open_time_ms),
        ).fetchone()
    return row is not None


def delete_klines(
    symbol: str,
    interval: str,
    start_ms: int | None = None,
    end_ms: int | None = None,
) -> int:
    where = ["symbol = ?", "interval = ?"]
    params: list[object] = [symbol, interval]

    if start_ms is not None:
        where.append("open_time >= ?")
        params.append(start_ms)
    if end_ms is not None:
        where.append("open_time <= ?")
        params.append(end_ms)

    sql = f"DELETE FROM klines WHERE {' AND '.join(where)}"
    with _connect() as conn:
        cur = conn.execute(sql, params)
        conn.commit()
        return cur.rowcount
