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


logger = logging.getLogger("candlescope.storage.market_metrics")


def _connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=30000;")
    try:
        conn.execute("PRAGMA journal_mode=WAL;")
    except sqlite3.OperationalError as exc:
        logger.warning(
            "SQLite WAL mode unavailable for %s, falling back to DELETE journal: %s",
            db_path,
            exc,
        )
        conn.execute("PRAGMA journal_mode=DELETE;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    return conn


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
                funding_rate REAL NOT NULL,
                is_final INTEGER NOT NULL DEFAULT 1 CHECK (is_final IN (0, 1)),
                source TEXT NOT NULL,
                received_at_ms INTEGER NOT NULL CHECK (received_at_ms >= 0),
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                PRIMARY KEY (exchange, market_type, symbol, funding_time_ms)
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
            """
        )


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
                    exchange, market_type, symbol, funding_time_ms,
                    funding_rate, is_final, source,
                    received_at_ms, created_at_ms, updated_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(exchange, market_type, symbol, funding_time_ms)
                DO UPDATE SET
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
            column="funding_time_ms",
            start_ms=start_ms,
            end_ms=end_ms,
        )
        rows = self._query_bounded(
            table="funding_rate_history",
            columns=(
                "exchange, market_type, symbol, funding_time_ms, funding_rate, "
                "is_final, source, received_at_ms"
            ),
            time_column="funding_time_ms",
            where=where,
            params=params,
            limit=limit,
            oldest_first=oldest_first,
        )
        return [dict(row) for row in rows]

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
        return {
            "db_path": str(self.db_path),
            "funding": dict(funding) if funding is not None else {},
            "open_interest": dict(open_interest) if open_interest is not None else {},
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
    ) -> list[sqlite3.Row]:
        bounded_limit = max(1, min(int(limit), 1000))
        page_direction = "ASC" if oldest_first else "DESC"
        sql = f"""
            SELECT {columns}
            FROM (
                SELECT {columns}
                FROM {table}
                WHERE {" AND ".join(where)}
                ORDER BY {time_column} {page_direction}
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
            funding_rate,
            1 if bool(row.get("is_final", True)) else 0,
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


__all__ = ["MarketMetricsRepository", "init_market_metrics_storage"]
