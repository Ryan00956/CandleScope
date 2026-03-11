from __future__ import annotations

import sqlite3
import time
from pathlib import Path

import pandas as pd

from app.core.config import KLINES_DB_PATH
from app.core.market import VALID_INTERVALS

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


def list_series_summaries(custom_only: bool = False) -> list[dict]:
    """List stored series with bounds/count metadata."""
    sql = """
        SELECT
            symbol,
            interval,
            MIN(open_time) AS earliest_open_time,
            MAX(open_time) AS latest_open_time,
            COUNT(*) AS total_count
        FROM klines
    """
    params: list[object] = []
    if custom_only:
        placeholders = ", ".join("?" for _ in VALID_INTERVALS)
        sql += f" WHERE interval NOT IN ({placeholders})"
        params.extend(VALID_INTERVALS)
    sql += """
        GROUP BY symbol, interval
        ORDER BY symbol ASC, interval ASC
    """

    with _connect() as conn:
        rows = conn.execute(sql, params).fetchall()

    return [dict(r) for r in rows]


# ═══════════════════════════════════════════════════════════════
#  KlinesRepoAdapter — implements data_manager.StorageBackend protocol
# ═══════════════════════════════════════════════════════════════


class KlinesRepoAdapter:
    """Wraps the module-level klines_repo functions into an object
    that satisfies the ``data_manager.models.StorageBackend`` protocol.

    Usage::

        from app.data_engine.storage.klines_repo import KlinesRepoAdapter
        dm = DataManager()
        dm.set_storage(KlinesRepoAdapter())
    """

    def query_bars(
        self,
        symbol: str,
        interval: str,
        start_ms: int | None = None,
        end_ms: int | None = None,
        limit: int | None = None,
        order: str = "ASC",
    ) -> list[dict]:
        """Query bars from SQLite storage."""
        return query_klines(
            symbol=symbol,
            interval=interval,
            start_ms=start_ms,
            end_ms=end_ms,
            limit=limit,
            order=order,
        )

    def upsert_bars(
        self,
        symbol: str,
        interval: str,
        rows: list[dict],
        source: str = "data_manager",
    ) -> int:
        """Insert or update bars in SQLite storage."""
        return upsert_klines(
            symbol=symbol,
            interval=interval,
            rows=rows,
            source=source,
        )

    def get_bounds(self, symbol: str, interval: str) -> dict:
        """Return {earliest_open_time, latest_open_time, total_count}."""
        return get_bounds(symbol=symbol, interval=interval)

    def list_series(self, custom_only: bool = False) -> list[dict]:
        """Return stored series summaries."""
        return list_series_summaries(custom_only=custom_only)

    def delete_bars(
        self,
        symbol: str,
        interval: str,
        start_ms: int | None = None,
        end_ms: int | None = None,
    ) -> int:
        """Delete bars in range."""
        return delete_klines(
            symbol=symbol,
            interval=interval,
            start_ms=start_ms,
            end_ms=end_ms,
        )

    def fetch_before(
        self,
        symbol: str,
        interval: str,
        before_ms: int,
        limit: int = 500,
    ) -> list[dict]:
        """Fetch bars before a timestamp, ordered ASC."""
        return fetch_before(
            symbol=symbol,
            interval=interval,
            before_ms=before_ms,
            limit=limit,
        )


# ═══════════════════════════════════════════════════════════════
#  AsyncKlinesRepoAdapter — implements backfill.models.StorageBackend protocol
# ═══════════════════════════════════════════════════════════════


class AsyncKlinesRepoAdapter:
    """Async wrapper that satisfies the ``backfill.models.StorageBackend``
    protocol (all methods are async).

    The BackfillEngine's GapDetector, Reconciler, etc. require async storage
    methods like ``get_latest_time``, ``get_earliest_time``, ``count_bars``,
    ``get_existing_open_times`` — which the sync ``KlinesRepoAdapter`` does
    not provide.

    This adapter wraps the module-level sync functions using
    ``asyncio.to_thread`` so the backfill pipeline can call them with
    ``await``.

    Usage::

        from app.data_engine.storage.klines_repo import AsyncKlinesRepoAdapter
        backfill_engine = BackfillEngine(storage=AsyncKlinesRepoAdapter(), ...)
    """

    async def get_latest_time(self, symbol: str, interval: str) -> int | None:
        """Return the latest open_time (ms) stored, or None if empty."""
        import asyncio
        def _sync():
            bounds = get_bounds(symbol, interval)
            return bounds.get("latest_open_time")
        return await asyncio.to_thread(_sync)

    async def get_earliest_time(self, symbol: str, interval: str) -> int | None:
        """Return the earliest open_time (ms) stored, or None if empty."""
        import asyncio
        def _sync():
            bounds = get_bounds(symbol, interval)
            return bounds.get("earliest_open_time")
        return await asyncio.to_thread(_sync)

    async def query_time_range(
        self, symbol: str, interval: str, start_ms: int, end_ms: int,
    ) -> list[dict]:
        """Return all bars within [start_ms, end_ms], ordered by open_time ASC."""
        import asyncio
        return await asyncio.to_thread(
            query_klines, symbol, interval, start_ms, end_ms, None, "ASC",
        )

    async def upsert_bars(
        self, symbol: str, interval: str, bars: list[dict], source: str = "backfill",
    ) -> int:
        """Insert or update bars. Return number of rows affected."""
        import asyncio
        return await asyncio.to_thread(upsert_klines, symbol, interval, bars, source)

    async def count_bars(
        self, symbol: str, interval: str, start_ms: int, end_ms: int,
    ) -> int:
        """Count bars within [start_ms, end_ms]."""
        import asyncio
        def _sync():
            with _connect() as conn:
                row = conn.execute(
                    "SELECT COUNT(*) AS cnt FROM klines "
                    "WHERE symbol = ? AND interval = ? AND open_time >= ? AND open_time <= ?",
                    (symbol, interval, start_ms, end_ms),
                ).fetchone()
                return row["cnt"] if row else 0
        return await asyncio.to_thread(_sync)

    async def get_existing_open_times(
        self, symbol: str, interval: str, start_ms: int, end_ms: int,
    ) -> set[int]:
        """Return the set of open_time values that exist in [start_ms, end_ms]."""
        import asyncio
        def _sync():
            with _connect() as conn:
                rows = conn.execute(
                    "SELECT open_time FROM klines "
                    "WHERE symbol = ? AND interval = ? AND open_time >= ? AND open_time <= ?",
                    (symbol, interval, start_ms, end_ms),
                ).fetchall()
                return {r["open_time"] for r in rows}
        return await asyncio.to_thread(_sync)


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
