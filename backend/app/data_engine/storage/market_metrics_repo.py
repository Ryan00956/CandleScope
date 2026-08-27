"""SQLite repository for Funding Rate and Open Interest history.

The advanced market-data chain deliberately keeps this storage contract
separate from the bar-centric ``KlinesRepoAdapter``.  Realtime provisional
rows and authoritative REST-history rows share the same natural keys; final
rows always win over provisional observations.
"""

from __future__ import annotations

import logging
import math
import sqlite3
import time
from pathlib import Path
from typing import Any, Iterable

from app.core.config import KLINES_DB_PATH

from .sqlite_runtime import open_sqlite


logger = logging.getLogger("candlescope.storage.market_metrics")


def _connect(db_path: Path) -> sqlite3.Connection:
    return open_sqlite(db_path, logger=logger)


def init_market_metrics_storage(db_path: Path | str | None = None) -> None:
    """Create the independent Funding/OI tables and lookup indexes."""

    path = Path(db_path or KLINES_DB_PATH)
    with _connect(path) as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS funding_rate_history (
                exchange TEXT NOT NULL,
                market_type TEXT NOT NULL,
                symbol TEXT NOT NULL,
                funding_time_ms INTEGER NOT NULL CHECK (funding_time_ms >= 0),
                funding_cycle_ms INTEGER NOT NULL CHECK (funding_cycle_ms >= 0),
                funding_rate REAL NOT NULL,
                is_final INTEGER NOT NULL DEFAULT 1 CHECK (is_final IN (0, 1)),
                source TEXT NOT NULL,
                received_at_ms INTEGER NOT NULL CHECK (received_at_ms >= 0),
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                PRIMARY KEY (exchange, market_type, symbol, funding_time_ms)
            );

            CREATE TABLE IF NOT EXISTS premium_index_history (
                exchange TEXT NOT NULL,
                market_type TEXT NOT NULL,
                symbol TEXT NOT NULL,
                interval TEXT NOT NULL,
                open_time_ms INTEGER NOT NULL CHECK (open_time_ms >= 0),
                close_time_ms INTEGER NOT NULL CHECK (close_time_ms >= open_time_ms),
                premium_open REAL NOT NULL,
                premium_high REAL NOT NULL,
                premium_low REAL NOT NULL,
                premium_close REAL NOT NULL,
                source TEXT NOT NULL,
                received_at_ms INTEGER NOT NULL CHECK (received_at_ms >= 0),
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                PRIMARY KEY (
                    exchange, market_type, symbol, interval, open_time_ms
                )
            );

            CREATE TABLE IF NOT EXISTS open_interest_history (
                exchange TEXT NOT NULL,
                market_type TEXT NOT NULL,
                symbol TEXT NOT NULL,
                period TEXT NOT NULL,
                event_time_ms INTEGER NOT NULL CHECK (event_time_ms >= 0),
                open_interest REAL NOT NULL CHECK (open_interest >= 0),
                open_interest_value REAL,
                is_final INTEGER NOT NULL DEFAULT 1 CHECK (is_final IN (0, 1)),
                source TEXT NOT NULL,
                received_at_ms INTEGER NOT NULL CHECK (received_at_ms >= 0),
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                PRIMARY KEY (
                    exchange, market_type, symbol, period, event_time_ms
                )
            );

            CREATE INDEX IF NOT EXISTS idx_funding_rate_history_lookup
            ON funding_rate_history(
                exchange, market_type, symbol, funding_time_ms DESC
            );

            CREATE INDEX IF NOT EXISTS idx_open_interest_history_lookup
            ON open_interest_history(
                exchange, market_type, symbol, period, event_time_ms DESC
            );

            CREATE INDEX IF NOT EXISTS idx_premium_index_history_lookup
            ON premium_index_history(
                exchange, market_type, symbol, interval, open_time_ms ASC
            );
            """
        )
        _migrate_funding_cycle_identity(conn)


def _migrate_funding_cycle_identity(conn: sqlite3.Connection) -> None:
    """Add the normalized funding-cycle key without rewriting legacy DBs.

    Binance occasionally reports the same settlement boundary a few
    milliseconds apart between preview and final transports.  Rounding to the
    nearest minute preserves the raw exchange timestamp while giving both rows
    one stable replacement identity.
    """

    columns = {
        str(row["name"])
        for row in conn.execute("PRAGMA table_info(funding_rate_history)")
    }
    if "funding_cycle_ms" not in columns:
        conn.execute("ALTER TABLE funding_rate_history ADD COLUMN funding_cycle_ms INTEGER")
    conn.execute(
        """
        UPDATE funding_rate_history
        SET funding_cycle_ms =
            CAST((funding_time_ms + 30000) / 60000 AS INTEGER) * 60000
        WHERE funding_cycle_ms IS NULL
        """,
    )
    conn.execute(
        """
        DELETE FROM funding_rate_history
        WHERE rowid IN (
            SELECT rowid
            FROM (
                SELECT rowid,
                       ROW_NUMBER() OVER (
                           PARTITION BY exchange, market_type, symbol, funding_cycle_ms
                           ORDER BY is_final DESC, received_at_ms DESC, rowid DESC
                       ) AS rank
                FROM funding_rate_history
            )
            WHERE rank > 1
        )
        """,
    )
    conn.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_funding_rate_history_cycle
        ON funding_rate_history(exchange, market_type, symbol, funding_cycle_ms)
        """,
    )
    conn.commit()


class MarketMetricsRepository:
    """Synchronous SQLite repository used through the storage executor."""

    def __init__(
        self,
        db_path: Path | str | None = None,
        *,
        initialize: bool = True,
    ) -> None:
        self.db_path = Path(db_path or KLINES_DB_PATH)
        if initialize:
            init_market_metrics_storage(self.db_path)

    def upsert_funding(self, rows: Iterable[dict[str, Any]]) -> int:
        now_ms = int(time.time() * 1000)
        payload = [self._funding_payload(row, now_ms=now_ms) for row in rows]
        if not payload:
            return 0

        with _connect(self.db_path) as conn:
            conn.executemany(
                """
                INSERT INTO funding_rate_history (
                    exchange, market_type, symbol, funding_time_ms, funding_cycle_ms,
                    funding_rate, is_final, source,
                    received_at_ms, created_at_ms, updated_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(exchange, market_type, symbol, funding_cycle_ms)
                DO UPDATE SET
                    funding_time_ms = excluded.funding_time_ms,
                    funding_rate = excluded.funding_rate,
                    is_final = excluded.is_final,
                    source = excluded.source,
                    received_at_ms = excluded.received_at_ms,
                    updated_at_ms = excluded.updated_at_ms
                WHERE
                    excluded.is_final > funding_rate_history.is_final
                    OR (
                        excluded.is_final = funding_rate_history.is_final
                        AND excluded.received_at_ms >= funding_rate_history.received_at_ms
                    )
                """,
                payload,
            )
            conn.commit()
        return len(payload)

    def upsert_premium_index(self, rows: Iterable[dict[str, Any]]) -> int:
        now_ms = int(time.time() * 1000)
        payload = [self._premium_index_payload(row, now_ms=now_ms) for row in rows]
        if not payload:
            return 0

        with _connect(self.db_path) as conn:
            conn.executemany(
                """
                INSERT INTO premium_index_history (
                    exchange, market_type, symbol, interval,
                    open_time_ms, close_time_ms,
                    premium_open, premium_high, premium_low, premium_close,
                    source, received_at_ms, created_at_ms, updated_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(exchange, market_type, symbol, interval, open_time_ms)
                DO UPDATE SET
                    close_time_ms = excluded.close_time_ms,
                    premium_open = excluded.premium_open,
                    premium_high = excluded.premium_high,
                    premium_low = excluded.premium_low,
                    premium_close = excluded.premium_close,
                    source = excluded.source,
                    received_at_ms = excluded.received_at_ms,
                    updated_at_ms = excluded.updated_at_ms
                WHERE excluded.received_at_ms >= premium_index_history.received_at_ms
                """,
                payload,
            )
            conn.commit()
        return len(payload)

    def upsert_open_interest(self, rows: Iterable[dict[str, Any]]) -> int:
        now_ms = int(time.time() * 1000)
        payload = [self._open_interest_payload(row, now_ms=now_ms) for row in rows]
        if not payload:
            return 0

        with _connect(self.db_path) as conn:
            conn.executemany(
                """
                INSERT INTO open_interest_history (
                    exchange, market_type, symbol, period, event_time_ms,
                    open_interest, open_interest_value, is_final, source,
                    received_at_ms, created_at_ms, updated_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(exchange, market_type, symbol, period, event_time_ms)
                DO UPDATE SET
                    open_interest = excluded.open_interest,
                    open_interest_value = excluded.open_interest_value,
                    is_final = excluded.is_final,
                    source = excluded.source,
                    received_at_ms = excluded.received_at_ms,
                    updated_at_ms = excluded.updated_at_ms
                WHERE
                    excluded.is_final > open_interest_history.is_final
                    OR (
                        excluded.is_final = open_interest_history.is_final
                        AND excluded.received_at_ms >= open_interest_history.received_at_ms
                    )
                """,
                payload,
            )
            conn.commit()
        return len(payload)

    def query_funding(
        self,
        *,
        exchange: str,
        market_type: str,
        symbol: str,
        start_ms: int | None = None,
        end_ms: int | None = None,
        limit: int = 500,
        oldest_first: bool = False,
        use_cycle_range: bool = False,
    ) -> list[dict[str, Any]]:
        where = ["exchange = ?", "market_type = ?", "symbol = ?"]
        params: list[Any] = [
            _identity(exchange, "exchange", lower=True),
            _identity(market_type, "market_type", lower=True),
            _identity(symbol, "symbol", upper=True),
        ]
        _append_time_range(
            where,
            params,
            column="funding_cycle_ms" if use_cycle_range else "funding_time_ms",
            start_ms=start_ms,
            end_ms=end_ms,
        )
        rows = self._query_bounded(
            table="funding_rate_history",
            columns=(
                "exchange, market_type, symbol, funding_time_ms, funding_cycle_ms, "
                "funding_rate, "
                "is_final, source, received_at_ms"
            ),
            time_column="funding_cycle_ms" if use_cycle_range else "funding_time_ms",
            where=where,
            params=params,
            limit=limit,
            oldest_first=oldest_first,
            max_limit=100_000,
        )
        return [dict(row) for row in rows]

    def query_premium_index(
        self,
        *,
        exchange: str,
        market_type: str,
        symbol: str,
        interval: str = "1m",
        start_ms: int | None = None,
        end_ms: int | None = None,
        limit: int = 250_000,
    ) -> list[dict[str, Any]]:
        rows = self._query_premium_index_rows(
            exchange=exchange,
            market_type=market_type,
            symbol=symbol,
            interval=interval,
            start_ms=start_ms,
            end_ms=end_ms,
            limit=limit,
            columns=(
                "exchange, market_type, symbol, interval, open_time_ms, "
                "close_time_ms, premium_open, premium_high, premium_low, "
                "premium_close, source, received_at_ms"
            ),
        )
        return [dict(row) for row in rows]

    def query_premium_index_compact(
        self,
        *,
        exchange: str,
        market_type: str,
        symbol: str,
        interval: str = "1m",
        start_ms: int | None = None,
        end_ms: int | None = None,
        limit: int = 250_000,
    ) -> list[dict[str, Any]]:
        """Return the compact Premium fields needed by funding estimation."""

        rows = self._query_premium_index_rows(
            exchange=exchange,
            market_type=market_type,
            symbol=symbol,
            interval=interval,
            start_ms=start_ms,
            end_ms=end_ms,
            limit=limit,
            columns=(
                "open_time_ms, close_time_ms, premium_close, received_at_ms"
            ),
        )
        return [dict(row) for row in rows]

    def _query_premium_index_rows(
        self,
        *,
        exchange: str,
        market_type: str,
        symbol: str,
        interval: str,
        start_ms: int | None,
        end_ms: int | None,
        limit: int,
        columns: str,
    ) -> list[sqlite3.Row]:
        where = [
            "exchange = ?",
            "market_type = ?",
            "symbol = ?",
            "interval = ?",
        ]
        params: list[Any] = [
            _identity(exchange, "exchange", lower=True),
            _identity(market_type, "market_type", lower=True),
            _identity(symbol, "symbol", upper=True),
            _identity(interval, "interval", lower=True),
        ]
        _append_time_range(
            where,
            params,
            column="open_time_ms",
            start_ms=start_ms,
            end_ms=end_ms,
        )
        rows = self._query_bounded(
            table="premium_index_history",
            columns=columns,
            time_column="open_time_ms",
            where=where,
            params=params,
            limit=limit,
            oldest_first=True,
            max_limit=250_000,
        )
        return rows

    def premium_index_bounds(
        self,
        *,
        exchange: str,
        market_type: str,
        symbol: str,
        interval: str = "1m",
    ) -> dict[str, int | None]:
        params = (
            _identity(exchange, "exchange", lower=True),
            _identity(market_type, "market_type", lower=True),
            _identity(symbol, "symbol", upper=True),
            _identity(interval, "interval", lower=True),
        )
        with _connect(self.db_path) as conn:
            row = conn.execute(
                """
                SELECT MIN(open_time_ms) AS earliest_ms,
                       MAX(open_time_ms) AS latest_ms,
                       COUNT(*) AS rows
                FROM premium_index_history
                WHERE exchange = ? AND market_type = ? AND symbol = ? AND interval = ?
                """,
                params,
            ).fetchone()
        return dict(row) if row is not None else {
            "earliest_ms": None,
            "latest_ms": None,
            "rows": 0,
        }

    def query_open_interest(
        self,
        *,
        exchange: str,
        market_type: str,
        symbol: str,
        period: str,
        start_ms: int | None = None,
        end_ms: int | None = None,
        limit: int = 500,
    ) -> list[dict[str, Any]]:
        where = [
            "exchange = ?",
            "market_type = ?",
            "symbol = ?",
            "period = ?",
        ]
        params: list[Any] = [
            _identity(exchange, "exchange", lower=True),
            _identity(market_type, "market_type", lower=True),
            _identity(symbol, "symbol", upper=True),
            _identity(period, "period", lower=True),
        ]
        _append_time_range(
            where,
            params,
            column="event_time_ms",
            start_ms=start_ms,
            end_ms=end_ms,
        )
        rows = self._query_bounded(
            table="open_interest_history",
            columns=(
                "exchange, market_type, symbol, period, event_time_ms, "
                "open_interest, open_interest_value, is_final, source, received_at_ms"
            ),
            time_column="event_time_ms",
            where=where,
            params=params,
            limit=limit,
        )
        return [dict(row) for row in rows]

    def diagnostics(self) -> dict[str, Any]:
        with _connect(self.db_path) as conn:
            funding = conn.execute(
                """
                SELECT COUNT(*) AS rows,
                       MIN(funding_time_ms) AS earliest_ms,
                       MAX(funding_time_ms) AS latest_ms
                FROM funding_rate_history
                """
            ).fetchone()
            open_interest = conn.execute(
                """
                SELECT COUNT(*) AS rows,
                       MIN(event_time_ms) AS earliest_ms,
                       MAX(event_time_ms) AS latest_ms
                FROM open_interest_history
                """
            ).fetchone()
            premium_index = conn.execute(
                """
                SELECT COUNT(*) AS rows,
                       MIN(open_time_ms) AS earliest_ms,
                       MAX(open_time_ms) AS latest_ms
                FROM premium_index_history
                """,
            ).fetchone()
        return {
            "db_path": str(self.db_path),
            "funding": dict(funding) if funding is not None else {},
            "open_interest": dict(open_interest) if open_interest is not None else {},
            "premium_index": dict(premium_index) if premium_index is not None else {},
        }

    def _query_bounded(
        self,
        *,
        table: str,
        columns: str,
        time_column: str,
        where: list[str],
        params: list[Any],
        limit: int,
        oldest_first: bool = False,
        max_limit: int = 1000,
    ) -> list[sqlite3.Row]:
        bounded_limit = max(1, min(int(limit), max(1, int(max_limit))))
        if oldest_first:
            sql = f"""
                SELECT {columns}
                FROM {table}
                WHERE {" AND ".join(where)}
                ORDER BY {time_column} ASC
                LIMIT ?
            """
        else:
            sql = f"""
                SELECT {columns}
                FROM (
                    SELECT {columns}
                    FROM {table}
                    WHERE {" AND ".join(where)}
                    ORDER BY {time_column} DESC
                    LIMIT ?
                )
                ORDER BY {time_column} ASC
            """
        with _connect(self.db_path) as conn:
            return conn.execute(sql, [*params, bounded_limit]).fetchall()

    @staticmethod
    def _funding_payload(row: dict[str, Any], *, now_ms: int) -> tuple[Any, ...]:
        funding_rate = _finite_float(row.get("funding_rate"), "funding_rate")
        return (
            _identity(row.get("exchange"), "exchange", lower=True),
            _identity(row.get("market_type"), "market_type", lower=True),
            _identity(row.get("symbol"), "symbol", upper=True),
            _non_negative_int(row.get("funding_time_ms"), "funding_time_ms"),
            _funding_cycle_ms(
                row.get("funding_cycle_ms", row.get("funding_time_ms")),
            ),
            funding_rate,
            1 if bool(row.get("is_final", True)) else 0,
            _identity(row.get("source"), "source", lower=True),
            _non_negative_int(row.get("received_at_ms"), "received_at_ms"),
            now_ms,
            now_ms,
        )

    @staticmethod
    def _premium_index_payload(
        row: dict[str, Any],
        *,
        now_ms: int,
    ) -> tuple[Any, ...]:
        open_time_ms = _non_negative_int(row.get("open_time_ms"), "open_time_ms")
        close_time_ms = _non_negative_int(row.get("close_time_ms"), "close_time_ms")
        if close_time_ms < open_time_ms:
            raise ValueError("close_time_ms cannot precede open_time_ms")
        return (
            _identity(row.get("exchange"), "exchange", lower=True),
            _identity(row.get("market_type"), "market_type", lower=True),
            _identity(row.get("symbol"), "symbol", upper=True),
            _identity(row.get("interval", "1m"), "interval", lower=True),
            open_time_ms,
            close_time_ms,
            _finite_float(row.get("premium_open"), "premium_open"),
            _finite_float(row.get("premium_high"), "premium_high"),
            _finite_float(row.get("premium_low"), "premium_low"),
            _finite_float(row.get("premium_close"), "premium_close"),
            _identity(row.get("source"), "source", lower=True),
            _non_negative_int(row.get("received_at_ms"), "received_at_ms"),
            now_ms,
            now_ms,
        )

    @staticmethod
    def _open_interest_payload(
        row: dict[str, Any],
        *,
        now_ms: int,
    ) -> tuple[Any, ...]:
        open_interest = _finite_float(row.get("open_interest"), "open_interest")
        if open_interest < 0:
            raise ValueError("open_interest cannot be negative")
        open_interest_value = _optional_finite_float(
            row.get("open_interest_value"),
            "open_interest_value",
        )
        if open_interest_value is not None and open_interest_value < 0:
            raise ValueError("open_interest_value cannot be negative")
        return (
            _identity(row.get("exchange"), "exchange", lower=True),
            _identity(row.get("market_type"), "market_type", lower=True),
            _identity(row.get("symbol"), "symbol", upper=True),
            _identity(row.get("period"), "period", lower=True),
            _non_negative_int(row.get("event_time_ms"), "event_time_ms"),
            open_interest,
            open_interest_value,
            1 if bool(row.get("is_final", True)) else 0,
            _identity(row.get("source"), "source", lower=True),
            _non_negative_int(row.get("received_at_ms"), "received_at_ms"),
            now_ms,
            now_ms,
        )


def _append_time_range(
    where: list[str],
    params: list[Any],
    *,
    column: str,
    start_ms: int | None,
    end_ms: int | None,
) -> None:
    if start_ms is not None:
        where.append(f"{column} >= ?")
        params.append(_non_negative_int(start_ms, "start_ms"))
    if end_ms is not None:
        where.append(f"{column} <= ?")
        params.append(_non_negative_int(end_ms, "end_ms"))


def _identity(
    value: Any,
    label: str,
    *,
    lower: bool = False,
    upper: bool = False,
) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} cannot be blank")
    normalized = value.strip()
    if lower:
        return normalized.lower()
    if upper:
        return normalized.upper()
    return normalized


def _finite_float(value: Any, label: str) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{label} must be finite")
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError(f"{label} must be finite") from exc
    if not math.isfinite(number):
        raise ValueError(f"{label} must be finite")
    return number


def _optional_finite_float(value: Any, label: str) -> float | None:
    if value is None:
        return None
    return _finite_float(value, label)


def _non_negative_int(value: Any, label: str) -> int:
    if isinstance(value, bool):
        raise ValueError(f"{label} must be a non-negative integer")
    try:
        number = int(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError(f"{label} must be a non-negative integer") from exc
    if number < 0:
        raise ValueError(f"{label} must be a non-negative integer")
    return number


def normalize_funding_cycle_ms(value: Any) -> int:
    timestamp_ms = _non_negative_int(value, "funding_cycle_ms")
    return ((timestamp_ms + 30_000) // 60_000) * 60_000


def _funding_cycle_ms(value: Any) -> int:
    return normalize_funding_cycle_ms(value)


__all__ = [
    "MarketMetricsRepository",
    "init_market_metrics_storage",
    "normalize_funding_cycle_ms",
]
