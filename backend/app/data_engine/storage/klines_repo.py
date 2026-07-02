from __future__ import annotations

import sqlite3
import time
import logging
from pathlib import Path

import pandas as pd

from app.core.config import KLINES_DB_PATH
from app.core.executors import run_storage
from app.data_engine.interval_policy import (
    INTERVAL_SECONDS,
    VALID_INTERVALS,
    compute_bucket_end_ms,
    compute_bucket_start_ms,
    is_monthly_interval,
    parse_interval_ms,
)

# Valid market types
VALID_MARKET_TYPES = ("spot", "futures", "swap")
DEFAULT_EXCHANGE = "binance"
DEFAULT_MARKET_TYPE = "spot"
logger = logging.getLogger("candlescope.storage.klines")


def interval_to_milliseconds(interval: str) -> int:
    if interval not in INTERVAL_SECONDS:
        raise ValueError(f"Unsupported interval: {interval}")
    return INTERVAL_SECONDS[interval] * 1000


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(KLINES_DB_PATH), timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode=WAL;")
    except sqlite3.OperationalError as exc:
        logger.warning("SQLite WAL mode unavailable for %s, falling back to DELETE journal: %s", KLINES_DB_PATH, exc)
        conn.execute("PRAGMA journal_mode=DELETE;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    return conn


def _migrate_add_exchange_market_type(conn: sqlite3.Connection) -> None:
    """Auto-migrate legacy tables that lack exchange/market_type columns.

    Strategy:
      1. Check if the 'exchange' column exists in the klines table.
      2. If not, create a new table with the full schema, copy data over
         (filling defaults), and swap tables.
    """
    cursor = conn.execute("PRAGMA table_info(klines);")
    columns = {row[1] for row in cursor.fetchall()}

    if "exchange" in columns and "market_type" in columns:
        return  # Already migrated

    print("[migration] Adding exchange/market_type columns to klines table...")

    conn.executescript(
        f"""
        -- Create the new table with updated schema
        CREATE TABLE IF NOT EXISTS klines_new (
            exchange TEXT NOT NULL DEFAULT '{DEFAULT_EXCHANGE}',
            market_type TEXT NOT NULL DEFAULT '{DEFAULT_MARKET_TYPE}',
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
            source TEXT NOT NULL DEFAULT '{DEFAULT_EXCHANGE}',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (exchange, market_type, symbol, interval, open_time)
        );

        -- Copy existing data with default values for new columns
        INSERT OR IGNORE INTO klines_new (
            exchange, market_type, symbol, interval, open_time,
            close_time, open, high, low, close, volume,
            quote_volume, trades, taker_buy_base, taker_buy_quote,
            source, created_at, updated_at
        )
        SELECT
            '{DEFAULT_EXCHANGE}', '{DEFAULT_MARKET_TYPE}',
            symbol, interval, open_time,
            close_time, open, high, low, close, volume,
            quote_volume, trades, taker_buy_base, taker_buy_quote,
            source, created_at, updated_at
        FROM klines;

        -- Swap tables
        DROP TABLE IF EXISTS klines;
        ALTER TABLE klines_new RENAME TO klines;

        -- Recreate index
        CREATE INDEX IF NOT EXISTS idx_klines_lookup
        ON klines(exchange, market_type, symbol, interval, open_time);
        """
    )
    print("[migration] Migration complete ✓")


def init_klines_storage() -> None:
    Path(KLINES_DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    with _connect() as conn:
        # Step 1: Create the table if it doesn't exist (fresh install)
        conn.executescript(
            f"""
            CREATE TABLE IF NOT EXISTS klines (
                exchange TEXT NOT NULL DEFAULT '{DEFAULT_EXCHANGE}',
                market_type TEXT NOT NULL DEFAULT '{DEFAULT_MARKET_TYPE}',
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
                source TEXT NOT NULL DEFAULT '{DEFAULT_EXCHANGE}',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (exchange, market_type, symbol, interval, open_time)
            );
            """
        )

        # Step 2: Migrate old schema if needed (adds exchange/market_type columns)
        _migrate_add_exchange_market_type(conn)

        # Step 3: Create index (safe after migration)
        conn.executescript(
            """
            CREATE INDEX IF NOT EXISTS idx_klines_lookup
            ON klines(exchange, market_type, symbol, interval, open_time);
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
    *,
    exchange: str = DEFAULT_EXCHANGE,
    market_type: str = DEFAULT_MARKET_TYPE,
) -> int:
    if not rows:
        return 0

    now_ms = int(time.time() * 1000)
    payload = [
        (
            exchange,
            market_type,
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
                exchange, market_type, symbol, interval, open_time,
                close_time, open, high, low, close, volume, quote_volume,
                trades, taker_buy_base, taker_buy_quote,
                source, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(exchange, market_type, symbol, interval, open_time) DO UPDATE SET
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
    *,
    exchange: str = DEFAULT_EXCHANGE,
    market_type: str = DEFAULT_MARKET_TYPE,
) -> list[dict]:
    where = ["exchange = ?", "market_type = ?", "symbol = ?", "interval = ?"]
    params: list[object] = [exchange, market_type, symbol, interval]

    if start_ms is not None:
        where.append("open_time >= ?")
        params.append(start_ms)
    if end_ms is not None:
        where.append("open_time <= ?")
        params.append(end_ms)

    order_sql = "DESC" if order.upper() == "DESC" else "ASC"
    sql = f"""
        SELECT exchange, market_type, symbol, interval, open_time, close_time,
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


def fetch_before(
    symbol: str,
    interval: str,
    before_ms: int,
    limit: int = 500,
    *,
    exchange: str = DEFAULT_EXCHANGE,
    market_type: str = DEFAULT_MARKET_TYPE,
) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT exchange, market_type, symbol, interval, open_time, close_time,
                   open, high, low, close, volume, quote_volume,
                   trades, taker_buy_base, taker_buy_quote, source
            FROM klines
            WHERE exchange = ? AND market_type = ? AND symbol = ? AND interval = ? AND open_time < ?
            ORDER BY open_time DESC
            LIMIT ?
            """,
            (exchange, market_type, symbol, interval, before_ms, limit),
        ).fetchall()

    records = [dict(r) for r in rows]
    records.reverse()
    return records


def get_bounds(
    symbol: str,
    interval: str,
    *,
    exchange: str = DEFAULT_EXCHANGE,
    market_type: str = DEFAULT_MARKET_TYPE,
) -> dict:
    with _connect() as conn:
        row = conn.execute(
            """
            SELECT
                MIN(open_time) AS earliest_open_time,
                MAX(open_time) AS latest_open_time,
                COUNT(*) AS total_count
            FROM klines
            WHERE exchange = ? AND market_type = ? AND symbol = ? AND interval = ?
            """,
            (exchange, market_type, symbol, interval),
        ).fetchone()

    if row is None:
        return {"earliest_open_time": None, "latest_open_time": None, "total_count": 0}
    return dict(row)


def list_series_summaries(
    custom_only: bool = False,
    *,
    exchange: str | None = None,
    market_type: str | None = None,
) -> list[dict]:
    """List stored series with bounds/count metadata."""
    sql = """
        SELECT
            exchange,
            market_type,
            symbol,
            interval,
            MIN(open_time) AS earliest_open_time,
            MAX(open_time) AS latest_open_time,
            COUNT(*) AS total_count
        FROM klines
    """
    params: list[object] = []
    where: list[str] = []
    if exchange:
        where.append("exchange = ?")
        params.append(exchange)
    if market_type:
        where.append("market_type = ?")
        params.append(market_type)
    if custom_only:
        placeholders = ", ".join("?" for _ in VALID_INTERVALS)
        where.append(f"interval NOT IN ({placeholders})")
        params.extend(VALID_INTERVALS)
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += """
        GROUP BY exchange, market_type, symbol, interval
        ORDER BY exchange ASC, market_type ASC, symbol ASC, interval ASC
    """

    with _connect() as conn:
        rows = conn.execute(sql, params).fetchall()

    return [dict(r) for r in rows]


def _first_expected_open_ms(start_ms: int, interval: str) -> int:
    interval_ms = parse_interval_ms(interval) or 60_000
    bucket = compute_bucket_start_ms(start_ms, interval_ms, interval=interval)
    if bucket < start_ms:
        bucket = compute_bucket_end_ms(bucket, interval_ms, interval=interval)
    return bucket


def _last_expected_open_ms(end_ms: int, interval: str) -> int:
    interval_ms = parse_interval_ms(interval) or 60_000
    return compute_bucket_start_ms(end_ms, interval_ms, interval=interval)


def _next_expected_open_ms(open_ms: int, interval: str) -> int:
    interval_ms = parse_interval_ms(interval) or 60_000
    return compute_bucket_end_ms(open_ms, interval_ms, interval=interval)


def _previous_expected_open_ms(open_ms: int, interval: str) -> int:
    interval_ms = parse_interval_ms(interval) or 60_000
    return compute_bucket_start_ms(open_ms - 1, interval_ms, interval=interval)


def _count_expected_opens(start_ms: int, end_ms: int, interval: str) -> int:
    if start_ms > end_ms:
        return 0

    interval_ms = parse_interval_ms(interval) or 60_000
    if not is_monthly_interval(interval):
        return (end_ms - start_ms) // interval_ms + 1

    count = 0
    current = start_ms
    while current <= end_ms:
        count += 1
        current = compute_bucket_end_ms(current, interval_ms, interval=interval)
    return count


def _gap_payload(
    *,
    exchange: str,
    market_type: str,
    symbol: str,
    interval: str,
    start_ms: int,
    end_ms: int,
    reason: str,
) -> dict:
    missing_bars = _count_expected_opens(start_ms, end_ms, interval)
    return {
        "exchange": exchange,
        "market_type": market_type,
        "symbol": symbol,
        "interval": interval,
        "start_ms": start_ms,
        "end_ms": end_ms,
        "missing_bars": missing_bars,
        "reason": reason,
        "status": "detected",
    }


def scan_klines_gaps(
    symbol: str,
    interval: str,
    start_ms: int | None = None,
    end_ms: int | None = None,
    *,
    exchange: str = DEFAULT_EXCHANGE,
    market_type: str = DEFAULT_MARKET_TYPE,
    limit: int = 50_000,
) -> dict:
    """Scan one stored series for continuity gaps in a bounded range."""
    interval_ms = parse_interval_ms(interval)
    if interval_ms is None or interval_ms <= 0:
        return {
            "exchange": exchange,
            "market_type": market_type,
            "symbol": symbol,
            "interval": interval,
            "gaps": [],
            "gap_count": 0,
            "missing_bars": 0,
            "scanned_bars": 0,
            "truncated": False,
            "error": f"Unsupported interval: {interval}",
        }

    where = ["exchange = ?", "market_type = ?", "symbol = ?", "interval = ?"]
    params: list[object] = [exchange, market_type, symbol, interval]
    if start_ms is not None:
        where.append("open_time >= ?")
        params.append(start_ms)
    if end_ms is not None:
        where.append("open_time <= ?")
        params.append(end_ms)

    sql = f"""
        SELECT open_time
        FROM klines
        WHERE {" AND ".join(where)}
        ORDER BY open_time ASC
        LIMIT ?
    """
    params.append(max(1, limit + 1))

    with _connect() as conn:
        rows = conn.execute(sql, params).fetchall()

    opens = [int(row["open_time"]) for row in rows[:limit]]
    truncated = len(rows) > limit
    gaps: list[dict] = []

    if not opens:
        if start_ms is not None and end_ms is not None and start_ms <= end_ms:
            gap_start = _first_expected_open_ms(start_ms, interval)
            gap_end = _last_expected_open_ms(end_ms, interval)
            if gap_start <= gap_end:
                gaps.append(_gap_payload(
                    exchange=exchange,
                    market_type=market_type,
                    symbol=symbol,
                    interval=interval,
                    start_ms=gap_start,
                    end_ms=gap_end,
                    reason="empty_range",
                ))
        return {
            "exchange": exchange,
            "market_type": market_type,
            "symbol": symbol,
            "interval": interval,
            "start_ms": start_ms,
            "end_ms": end_ms,
            "gaps": gaps,
            "gap_count": len(gaps),
            "missing_bars": sum(gap["missing_bars"] for gap in gaps),
            "scanned_bars": 0,
            "truncated": truncated,
        }

    if start_ms is not None:
        first_expected = _first_expected_open_ms(start_ms, interval)
        if opens[0] > first_expected:
            gap_end = _previous_expected_open_ms(opens[0], interval)
            gaps.append(_gap_payload(
                exchange=exchange,
                market_type=market_type,
                symbol=symbol,
                interval=interval,
                start_ms=first_expected,
                end_ms=gap_end,
                reason="head_gap",
            ))

    previous = opens[0]
    for current in opens[1:]:
        expected_next = _next_expected_open_ms(previous, interval)
        if current > expected_next:
            gap_end = _previous_expected_open_ms(current, interval)
            gaps.append(_gap_payload(
                exchange=exchange,
                market_type=market_type,
                symbol=symbol,
                interval=interval,
                start_ms=expected_next,
                end_ms=gap_end,
                reason="interior_gap",
            ))
        previous = current

    if end_ms is not None and not truncated:
        last_expected = _last_expected_open_ms(end_ms, interval)
        next_expected = _next_expected_open_ms(opens[-1], interval)
        if next_expected <= last_expected:
            gaps.append(_gap_payload(
                exchange=exchange,
                market_type=market_type,
                symbol=symbol,
                interval=interval,
                start_ms=next_expected,
                end_ms=last_expected,
                reason="tail_gap",
            ))

    return {
        "exchange": exchange,
        "market_type": market_type,
        "symbol": symbol,
        "interval": interval,
        "start_ms": start_ms,
        "end_ms": end_ms,
        "gaps": gaps,
        "gap_count": len(gaps),
        "missing_bars": sum(gap["missing_bars"] for gap in gaps),
        "scanned_bars": len(opens),
        "truncated": truncated,
    }


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

    def __init__(
        self,
        exchange: str = DEFAULT_EXCHANGE,
        market_type: str = DEFAULT_MARKET_TYPE,
    ) -> None:
        self._exchange = exchange
        self._market_type = market_type

    def query_bars(
        self,
        symbol: str,
        interval: str,
        start_ms: int | None = None,
        end_ms: int | None = None,
        limit: int | None = None,
        order: str = "ASC",
        exchange: str | None = None,
        market_type: str | None = None,
    ) -> list[dict]:
        """Query bars from SQLite storage."""
        return query_klines(
            symbol=symbol,
            interval=interval,
            start_ms=start_ms,
            end_ms=end_ms,
            limit=limit,
            order=order,
            exchange=exchange or self._exchange,
            market_type=market_type or self._market_type,
        )

    def upsert_bars(
        self,
        symbol: str,
        interval: str,
        rows: list[dict],
        source: str = "data_manager",
        exchange: str | None = None,
        market_type: str | None = None,
    ) -> int:
        """Insert or update bars in SQLite storage."""
        return upsert_klines(
            symbol=symbol,
            interval=interval,
            rows=rows,
            source=source,
            exchange=exchange or self._exchange,
            market_type=market_type or self._market_type,
        )

    def get_bounds(
        self,
        symbol: str,
        interval: str,
        exchange: str | None = None,
        market_type: str | None = None,
    ) -> dict:
        """Return {earliest_open_time, latest_open_time, total_count}."""
        return get_bounds(
            symbol=symbol,
            interval=interval,
            exchange=exchange or self._exchange,
            market_type=market_type or self._market_type,
        )

    def list_series(
        self,
        custom_only: bool = False,
        exchange: str | None = None,
        market_type: str | None = None,
    ) -> list[dict]:
        """Return stored series summaries."""
        return list_series_summaries(
            custom_only=custom_only,
            exchange=exchange or self._exchange,
            market_type=market_type or self._market_type,
        )

    def list_all_series(self, custom_only: bool = False) -> list[dict]:
        """Return stored series summaries across all exchanges and markets."""
        return list_series_summaries(custom_only=custom_only)

    def scan_gaps(
        self,
        symbol: str,
        interval: str,
        start_ms: int | None = None,
        end_ms: int | None = None,
        exchange: str | None = None,
        market_type: str | None = None,
        limit: int = 50_000,
    ) -> dict:
        """Scan a stored series for continuity gaps."""
        return scan_klines_gaps(
            symbol=symbol,
            interval=interval,
            start_ms=start_ms,
            end_ms=end_ms,
            exchange=exchange or self._exchange,
            market_type=market_type or self._market_type,
            limit=limit,
        )

    def delete_bars(
        self,
        symbol: str,
        interval: str,
        start_ms: int | None = None,
        end_ms: int | None = None,
        exchange: str | None = None,
        market_type: str | None = None,
    ) -> int:
        """Delete bars in range."""
        return delete_klines(
            symbol=symbol,
            interval=interval,
            start_ms=start_ms,
            end_ms=end_ms,
            exchange=exchange or self._exchange,
            market_type=market_type or self._market_type,
        )

    def fetch_before(
        self,
        symbol: str,
        interval: str,
        before_ms: int,
        limit: int = 500,
        exchange: str | None = None,
        market_type: str | None = None,
    ) -> list[dict]:
        """Fetch bars before a timestamp, ordered ASC."""
        return fetch_before(
            symbol=symbol,
            interval=interval,
            before_ms=before_ms,
            limit=limit,
            exchange=exchange or self._exchange,
            market_type=market_type or self._market_type,
        )

    def delete_oldest(
        self,
        symbol: str,
        interval: str,
        keep: int,
        exchange: str | None = None,
        market_type: str | None = None,
    ) -> int:
        """Delete oldest bars, keeping only the most recent *keep* rows."""
        return delete_oldest_klines(
            symbol=symbol,
            interval=interval,
            keep=keep,
            exchange=exchange or self._exchange,
            market_type=market_type or self._market_type,
        )

    def delete_oldest_batch(
        self,
        symbol: str,
        interval: str,
        keep: int,
        batch_size: int = 10_000,
        exchange: str | None = None,
        market_type: str | None = None,
    ) -> int:
        """Delete one bounded batch of oldest bars while keeping newest rows."""
        return delete_oldest_klines_batch(
            symbol=symbol,
            interval=interval,
            keep=keep,
            batch_size=batch_size,
            exchange=exchange or self._exchange,
            market_type=market_type or self._market_type,
        )

    def wal_checkpoint_truncate(self) -> dict:
        """Run a WAL truncate checkpoint."""
        return wal_checkpoint_truncate()

    def vacuum(self) -> dict:
        """Run VACUUM manually."""
        return vacuum_database()


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
    the shared storage executor so the backfill pipeline can call them with
    ``await``.

    Usage::

        from app.data_engine.storage.klines_repo import AsyncKlinesRepoAdapter
        backfill_engine = BackfillEngine(storage=AsyncKlinesRepoAdapter(), ...)
    """

    def __init__(
        self,
        exchange: str = DEFAULT_EXCHANGE,
        market_type: str = DEFAULT_MARKET_TYPE,
    ) -> None:
        self._exchange = exchange
        self._market_type = market_type

    async def get_latest_time(
        self,
        symbol: str,
        interval: str,
        exchange: str | None = None,
        market_type: str | None = None,
    ) -> int | None:
        """Return the latest open_time (ms) stored, or None if empty."""
        def _sync():
            bounds = get_bounds(
                symbol, interval,
                exchange=exchange or self._exchange,
                market_type=market_type or self._market_type,
            )
            return bounds.get("latest_open_time")
        return await run_storage(_sync)

    async def get_earliest_time(
        self,
        symbol: str,
        interval: str,
        exchange: str | None = None,
        market_type: str | None = None,
    ) -> int | None:
        """Return the earliest open_time (ms) stored, or None if empty."""
        def _sync():
            bounds = get_bounds(
                symbol, interval,
                exchange=exchange or self._exchange,
                market_type=market_type or self._market_type,
            )
            return bounds.get("earliest_open_time")
        return await run_storage(_sync)

    async def query_time_range(
        self, symbol: str, interval: str, start_ms: int, end_ms: int,
        exchange: str | None = None,
        market_type: str | None = None,
    ) -> list[dict]:
        """Return all bars within [start_ms, end_ms], ordered by open_time ASC."""
        resolved_exchange = exchange or self._exchange
        resolved_market_type = market_type or self._market_type
        def _sync():
            return query_klines(
                symbol, interval, start_ms, end_ms, None, "ASC",
                exchange=resolved_exchange, market_type=resolved_market_type,
            )
        return await run_storage(_sync)

    async def upsert_bars(
        self,
        symbol: str,
        interval: str,
        bars: list[dict],
        source: str = "backfill",
        exchange: str | None = None,
        market_type: str | None = None,
    ) -> int:
        """Insert or update bars. Return number of rows affected."""
        resolved_exchange = exchange or self._exchange
        resolved_market_type = market_type or self._market_type
        def _sync():
            return upsert_klines(
                symbol, interval, bars, source,
                exchange=resolved_exchange, market_type=resolved_market_type,
            )
        return await run_storage(_sync)

    async def count_bars(
        self, symbol: str, interval: str, start_ms: int, end_ms: int,
        exchange: str | None = None,
        market_type: str | None = None,
    ) -> int:
        """Count bars within [start_ms, end_ms]."""
        resolved_exchange = exchange or self._exchange
        resolved_market_type = market_type or self._market_type
        def _sync():
            with _connect() as conn:
                row = conn.execute(
                    "SELECT COUNT(*) AS cnt FROM klines "
                    "WHERE exchange = ? AND market_type = ? "
                    "AND symbol = ? AND interval = ? AND open_time >= ? AND open_time <= ?",
                    (resolved_exchange, resolved_market_type, symbol, interval, start_ms, end_ms),
                ).fetchone()
                return row["cnt"] if row else 0
        return await run_storage(_sync)

    async def get_existing_open_times(
        self, symbol: str, interval: str, start_ms: int, end_ms: int,
        exchange: str | None = None,
        market_type: str | None = None,
    ) -> set[int]:
        """Return the set of open_time values that exist in [start_ms, end_ms]."""
        resolved_exchange = exchange or self._exchange
        resolved_market_type = market_type or self._market_type
        def _sync():
            with _connect() as conn:
                rows = conn.execute(
                    "SELECT open_time FROM klines "
                    "WHERE exchange = ? AND market_type = ? "
                    "AND symbol = ? AND interval = ? AND open_time >= ? AND open_time <= ?",
                    (resolved_exchange, resolved_market_type, symbol, interval, start_ms, end_ms),
                ).fetchall()
                return {r["open_time"] for r in rows}
        return await run_storage(_sync)


def has_older_than(
    symbol: str,
    interval: str,
    open_time_ms: int,
    *,
    exchange: str = DEFAULT_EXCHANGE,
    market_type: str = DEFAULT_MARKET_TYPE,
) -> bool:
    with _connect() as conn:
        row = conn.execute(
            """
            SELECT 1
            FROM klines
            WHERE exchange = ? AND market_type = ? AND symbol = ? AND interval = ? AND open_time < ?
            LIMIT 1
            """,
            (exchange, market_type, symbol, interval, open_time_ms),
        ).fetchone()
    return row is not None


def delete_klines(
    symbol: str,
    interval: str,
    start_ms: int | None = None,
    end_ms: int | None = None,
    *,
    exchange: str = DEFAULT_EXCHANGE,
    market_type: str = DEFAULT_MARKET_TYPE,
) -> int:
    where = ["exchange = ?", "market_type = ?", "symbol = ?", "interval = ?"]
    params: list[object] = [exchange, market_type, symbol, interval]

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


def delete_oldest_klines(
    symbol: str,
    interval: str,
    keep: int,
    *,
    exchange: str = DEFAULT_EXCHANGE,
    market_type: str = DEFAULT_MARKET_TYPE,
) -> int:
    """Delete oldest bars, keeping only the most recent *keep* rows.

    Uses a subquery to find the cutoff open_time, then deletes everything
    older.  Returns the number of rows actually deleted.

    If total rows <= keep, nothing is deleted (returns 0).
    """
    if keep < 0:
        keep = 0

    with _connect() as conn:
        # First check total count
        count_row = conn.execute(
            "SELECT COUNT(*) AS cnt FROM klines "
            "WHERE exchange = ? AND market_type = ? AND symbol = ? AND interval = ?",
            (exchange, market_type, symbol, interval),
        ).fetchone()
        total = count_row["cnt"] if count_row else 0

        if total <= keep:
            return 0

        # Find the cutoff: the open_time of the (keep)-th newest bar
        cutoff_row = conn.execute(
            "SELECT open_time FROM klines "
            "WHERE exchange = ? AND market_type = ? AND symbol = ? AND interval = ? "
            "ORDER BY open_time DESC LIMIT 1 OFFSET ?",
            (exchange, market_type, symbol, interval, keep),
        ).fetchone()

        if cutoff_row is None:
            return 0

        cutoff_ms = cutoff_row["open_time"]

        # Delete everything at or before the cutoff
        cur = conn.execute(
            "DELETE FROM klines "
            "WHERE exchange = ? AND market_type = ? AND symbol = ? AND interval = ? "
            "AND open_time <= ?",
            (exchange, market_type, symbol, interval, cutoff_ms),
        )
        conn.commit()
        return cur.rowcount


def delete_oldest_klines_batch(
    symbol: str,
    interval: str,
    keep: int,
    batch_size: int = 10_000,
    *,
    exchange: str = DEFAULT_EXCHANGE,
    market_type: str = DEFAULT_MARKET_TYPE,
) -> int:
    """Delete at most *batch_size* oldest bars while keeping newest *keep* rows."""
    if keep < 0:
        keep = 0
    batch_size = max(1, int(batch_size or 1))

    with _connect() as conn:
        count_row = conn.execute(
            "SELECT COUNT(*) AS cnt FROM klines "
            "WHERE exchange = ? AND market_type = ? AND symbol = ? AND interval = ?",
            (exchange, market_type, symbol, interval),
        ).fetchone()
        total = count_row["cnt"] if count_row else 0
        to_delete = min(batch_size, max(0, total - keep))
        if to_delete <= 0:
            return 0

        cur = conn.execute(
            """
            DELETE FROM klines
            WHERE rowid IN (
                SELECT rowid FROM klines
                WHERE exchange = ? AND market_type = ? AND symbol = ? AND interval = ?
                ORDER BY open_time ASC
                LIMIT ?
            )
            """,
            (exchange, market_type, symbol, interval, to_delete),
        )
        conn.commit()
        return cur.rowcount


def wal_checkpoint_truncate() -> dict:
    """Run a WAL truncate checkpoint and return SQLite's result tuple."""
    with _connect() as conn:
        row = conn.execute("PRAGMA wal_checkpoint(TRUNCATE);").fetchone()
    values = tuple(row) if row is not None else ()
    return {
        "mode": "TRUNCATE",
        "result": list(values),
        "busy": int(values[0]) if len(values) > 0 else None,
        "log": int(values[1]) if len(values) > 1 else None,
        "checkpointed": int(values[2]) if len(values) > 2 else None,
    }


def vacuum_database() -> dict:
    """Run VACUUM. This can lock the database and should be manually triggered."""
    started = time.time()
    with _connect() as conn:
        conn.execute("VACUUM;")
    return {
        "status": "ok",
        "elapsed_ms": int((time.time() - started) * 1000),
    }
