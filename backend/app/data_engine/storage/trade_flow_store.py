"""Storage contract and SQLite backend for one-minute trade-flow rollups.

The engine-facing contract is asynchronous so a future DuckDB backend can be
substituted without leaking a concrete database into the trade-flow pipeline.
SQLite work is always submitted to the shared storage executor; none of the
database reads or writes execute on the asyncio event-loop thread.
"""

from __future__ import annotations

import logging
import math
import sqlite3
import time
from contextlib import closing
from pathlib import Path
from threading import Lock
from typing import Any, Iterable, Protocol, runtime_checkable

from app.core.config import KLINES_DB_PATH
from app.core.executors import run_storage


logger = logging.getLogger("candlescope.storage.trade_flow")


@runtime_checkable
class TradeFlowRollupStore(Protocol):
    """Database-agnostic asynchronous contract used by TradeFlowEngine."""

    async def upsert_rollups(self, rows: Iterable[dict[str, Any]]) -> int:
        """Persist one-minute rollups and return the accepted input count."""

    async def query_rollups(
        self,
        *,
        exchange: str,
        market_type: str,
        symbol: str,
        start_ms: int | None = None,
        end_ms: int | None = None,
        limit: int = 1000,
    ) -> list[dict[str, Any]]:
        """Return a bounded range ordered by bucket time ascending."""

    async def query_recent_rollups(
        self,
        *,
        exchange: str,
        market_type: str,
        symbol: str,
        limit: int = 1000,
    ) -> list[dict[str, Any]]:
        """Return the newest bounded tail, presented in ascending order."""

    async def diagnostics(self) -> dict[str, Any]:
        """Return backend identity and aggregate storage bounds."""


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


def init_trade_flow_storage(db_path: Path | str | None = None) -> None:
    """Create the independent one-minute trade-flow rollup table."""

    path = Path(db_path or KLINES_DB_PATH)
    with closing(_connect(path)) as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS trade_flow_rollup_1m (
                exchange TEXT NOT NULL,
                market_type TEXT NOT NULL,
                symbol TEXT NOT NULL,
                bucket_open_ms INTEGER NOT NULL CHECK (bucket_open_ms >= 0),
                bucket_close_ms INTEGER NOT NULL CHECK (
                    bucket_close_ms > bucket_open_ms
                ),
                buy_base_volume REAL NOT NULL CHECK (buy_base_volume >= 0),
                sell_base_volume REAL NOT NULL CHECK (sell_base_volume >= 0),
                buy_quote_volume REAL NOT NULL CHECK (buy_quote_volume >= 0),
                sell_quote_volume REAL NOT NULL CHECK (sell_quote_volume >= 0),
                base_volume_delta REAL NOT NULL,
                quote_volume_delta REAL NOT NULL,
                agg_trade_count INTEGER NOT NULL CHECK (agg_trade_count >= 0),
                trade_count INTEGER NOT NULL CHECK (trade_count >= 0),
                buy_trade_count INTEGER NOT NULL CHECK (buy_trade_count >= 0),
                sell_trade_count INTEGER NOT NULL CHECK (sell_trade_count >= 0),
                max_agg_trade_quote REAL NOT NULL CHECK (
                    max_agg_trade_quote >= 0
                ),
                first_agg_trade_id INTEGER CHECK (first_agg_trade_id >= 0),
                last_agg_trade_id INTEGER CHECK (last_agg_trade_id >= 0),
                is_final INTEGER NOT NULL DEFAULT 0 CHECK (is_final IN (0, 1)),
                is_complete INTEGER NOT NULL DEFAULT 1 CHECK (
                    is_complete IN (0, 1)
                ),
                revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
                source TEXT NOT NULL,
                received_at_ms INTEGER NOT NULL CHECK (received_at_ms >= 0),
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                PRIMARY KEY (exchange, market_type, symbol, bucket_open_ms)
            );

            CREATE INDEX IF NOT EXISTS idx_trade_flow_rollup_1m_lookup
            ON trade_flow_rollup_1m(
                exchange, market_type, symbol, bucket_open_ms ASC
            );
            """
        )


class SQLiteTradeFlowRollupStore:
    """Async SQLite implementation of :class:`TradeFlowRollupStore`.

    Schema initialization is lazy and also runs inside the storage executor,
    making construction safe from an already-running event loop.
    """

    backend_name = "sqlite"

    def __init__(self, db_path: Path | str | None = None) -> None:
        self.db_path = Path(db_path or KLINES_DB_PATH)
        self._initialized = False
        self._initialize_lock = Lock()

    async def upsert_rollups(self, rows: Iterable[dict[str, Any]]) -> int:
        copied = [dict(row) for row in rows]
        if not copied:
            return 0
        return await run_storage(self._upsert_sync, copied)

    async def query_rollups(
        self,
        *,
        exchange: str,
        market_type: str,
        symbol: str,
        start_ms: int | None = None,
        end_ms: int | None = None,
        limit: int = 1000,
    ) -> list[dict[str, Any]]:
        return await run_storage(
            self._query_sync,
            exchange=exchange,
            market_type=market_type,
            symbol=symbol,
            start_ms=start_ms,
            end_ms=end_ms,
            limit=limit,
        )

    async def diagnostics(self) -> dict[str, Any]:
        return await run_storage(self._diagnostics_sync)

    async def query_recent_rollups(
        self,
        *,
        exchange: str,
        market_type: str,
        symbol: str,
        limit: int = 1000,
    ) -> list[dict[str, Any]]:
        return await run_storage(
            self._query_recent_sync,
            exchange=exchange,
            market_type=market_type,
            symbol=symbol,
            limit=limit,
        )

    def _ensure_initialized(self) -> None:
        if self._initialized:
            return
        with self._initialize_lock:
            if not self._initialized:
                init_trade_flow_storage(self.db_path)
                self._initialized = True

    def _upsert_sync(self, rows: list[dict[str, Any]]) -> int:
        self._ensure_initialized()
        now_ms = int(time.time() * 1000)
        payload = [_rollup_payload(row, now_ms=now_ms) for row in rows]
        with closing(_connect(self.db_path)) as conn:
            conn.executemany(
                """
                INSERT INTO trade_flow_rollup_1m (
                    exchange, market_type, symbol,
                    bucket_open_ms, bucket_close_ms,
                    buy_base_volume, sell_base_volume,
                    buy_quote_volume, sell_quote_volume,
                    base_volume_delta, quote_volume_delta,
                    agg_trade_count, trade_count,
                    buy_trade_count, sell_trade_count,
                    max_agg_trade_quote,
                    first_agg_trade_id, last_agg_trade_id,
                    is_final, is_complete, revision, source, received_at_ms,
                    created_at_ms, updated_at_ms
                ) VALUES (
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                )
                ON CONFLICT(exchange, market_type, symbol, bucket_open_ms)
                DO UPDATE SET
                    bucket_close_ms = excluded.bucket_close_ms,
                    buy_base_volume = excluded.buy_base_volume,
                    sell_base_volume = excluded.sell_base_volume,
                    buy_quote_volume = excluded.buy_quote_volume,
                    sell_quote_volume = excluded.sell_quote_volume,
                    base_volume_delta = excluded.base_volume_delta,
                    quote_volume_delta = excluded.quote_volume_delta,
                    agg_trade_count = excluded.agg_trade_count,
                    trade_count = excluded.trade_count,
                    buy_trade_count = excluded.buy_trade_count,
                    sell_trade_count = excluded.sell_trade_count,
                    max_agg_trade_quote = excluded.max_agg_trade_quote,
                    first_agg_trade_id = excluded.first_agg_trade_id,
                    last_agg_trade_id = excluded.last_agg_trade_id,
                    is_final = excluded.is_final,
                    is_complete = excluded.is_complete,
                    revision = excluded.revision,
                    source = excluded.source,
                    received_at_ms = excluded.received_at_ms,
                    updated_at_ms = excluded.updated_at_ms
                WHERE
                    excluded.is_final >= trade_flow_rollup_1m.is_final
                    AND (
                        excluded.received_at_ms >
                            trade_flow_rollup_1m.received_at_ms
                        OR (
                            excluded.received_at_ms =
                                trade_flow_rollup_1m.received_at_ms
                            AND excluded.revision >=
                                trade_flow_rollup_1m.revision
                        )
                    )
                """,
                payload,
            )
            conn.commit()
        return len(payload)

    def _query_sync(
        self,
        *,
        exchange: str,
        market_type: str,
        symbol: str,
        start_ms: int | None,
        end_ms: int | None,
        limit: int,
    ) -> list[dict[str, Any]]:
        self._ensure_initialized()
        where = ["exchange = ?", "market_type = ?", "symbol = ?"]
        params: list[Any] = [
            _identity(exchange, "exchange", lower=True),
            _identity(market_type, "market_type", lower=True),
            _identity(symbol, "symbol", upper=True),
        ]
        if start_ms is not None:
            where.append("bucket_open_ms >= ?")
            params.append(_non_negative_int(start_ms, "start_ms"))
        if end_ms is not None:
            where.append("bucket_open_ms <= ?")
            params.append(_non_negative_int(end_ms, "end_ms"))
        bounded_limit = max(1, min(int(limit), 5000))
        with closing(_connect(self.db_path)) as conn:
            rows = conn.execute(
                f"""
                SELECT
                    exchange, market_type, symbol,
                    bucket_open_ms, bucket_close_ms,
                    buy_base_volume, sell_base_volume,
                    buy_quote_volume, sell_quote_volume,
                    base_volume_delta, quote_volume_delta,
                    agg_trade_count, trade_count,
                    buy_trade_count, sell_trade_count,
                    max_agg_trade_quote,
                    first_agg_trade_id, last_agg_trade_id,
                    is_final, is_complete, revision, source, received_at_ms
                FROM trade_flow_rollup_1m
                WHERE {" AND ".join(where)}
                ORDER BY bucket_open_ms ASC
                LIMIT ?
                """,
                [*params, bounded_limit],
            ).fetchall()
        return [dict(row) for row in rows]

    def _query_recent_sync(
        self,
        *,
        exchange: str,
        market_type: str,
        symbol: str,
        limit: int,
    ) -> list[dict[str, Any]]:
        self._ensure_initialized()
        params = [
            _identity(exchange, "exchange", lower=True),
            _identity(market_type, "market_type", lower=True),
            _identity(symbol, "symbol", upper=True),
            max(1, min(int(limit), 5000)),
        ]
        with closing(_connect(self.db_path)) as conn:
            rows = conn.execute(
                """
                SELECT *
                FROM (
                    SELECT
                        exchange, market_type, symbol,
                        bucket_open_ms, bucket_close_ms,
                        buy_base_volume, sell_base_volume,
                        buy_quote_volume, sell_quote_volume,
                        base_volume_delta, quote_volume_delta,
                        agg_trade_count, trade_count,
                        buy_trade_count, sell_trade_count,
                        max_agg_trade_quote,
                        first_agg_trade_id, last_agg_trade_id,
                        is_final, is_complete, revision, source, received_at_ms
                    FROM trade_flow_rollup_1m
                    WHERE exchange = ? AND market_type = ? AND symbol = ?
                    ORDER BY bucket_open_ms DESC
                    LIMIT ?
                )
                ORDER BY bucket_open_ms ASC
                """,
                params,
            ).fetchall()
        return [dict(row) for row in rows]

    def _diagnostics_sync(self) -> dict[str, Any]:
        self._ensure_initialized()
        with closing(_connect(self.db_path)) as conn:
            row = conn.execute(
                """
                SELECT COUNT(*) AS rows,
                       MIN(bucket_open_ms) AS earliest_ms,
                       MAX(bucket_open_ms) AS latest_ms,
                       SUM(CASE WHEN is_complete = 0 THEN 1 ELSE 0 END)
                           AS incomplete_rows,
                       SUM(CASE WHEN is_final = 0 THEN 1 ELSE 0 END)
                           AS provisional_rows
                FROM trade_flow_rollup_1m
                """
            ).fetchone()
        return {
            "backend": self.backend_name,
            "db_path": str(self.db_path),
            "rollups": dict(row) if row is not None else {},
        }


def _rollup_payload(row: dict[str, Any], *, now_ms: int) -> tuple[Any, ...]:
    bucket_open_ms = _non_negative_int(
        row.get("bucket_open_ms", row.get("bucket_start_ms")),
        "bucket_open_ms",
    )
    bucket_close_ms = _non_negative_int(
        row.get(
            "bucket_close_ms",
            row.get("bucket_end_ms", bucket_open_ms + 60_000),
        ),
        "bucket_close_ms",
    )
    if bucket_open_ms % 60_000 != 0:
        raise ValueError("bucket_open_ms must be aligned to one minute")
    if bucket_close_ms != bucket_open_ms + 60_000:
        raise ValueError("bucket_close_ms must equal bucket_open_ms + 60000")

    buy_base = _non_negative_float(
        row.get("buy_base_volume", row.get("taker_buy_base")),
        "buy_base_volume",
    )
    sell_base = _non_negative_float(
        row.get("sell_base_volume", row.get("taker_sell_base")),
        "sell_base_volume",
    )
    buy_quote = _non_negative_float(
        row.get("buy_quote_volume", row.get("taker_buy_quote")),
        "buy_quote_volume",
    )
    sell_quote = _non_negative_float(
        row.get("sell_quote_volume", row.get("taker_sell_quote")),
        "sell_quote_volume",
    )
    agg_trade_count = _non_negative_int(
        row.get("agg_trade_count"),
        "agg_trade_count",
    )
    trade_count = _non_negative_int(row.get("trade_count"), "trade_count")
    buy_trade_count = _non_negative_int(
        row.get("buy_trade_count"),
        "buy_trade_count",
    )
    sell_trade_count = _non_negative_int(
        row.get("sell_trade_count"),
        "sell_trade_count",
    )
    if buy_trade_count + sell_trade_count != trade_count:
        raise ValueError("trade_count must equal buy_trade_count + sell_trade_count")

    first_id = _optional_non_negative_int(
        row.get("first_agg_trade_id"),
        "first_agg_trade_id",
    )
    last_id = _optional_non_negative_int(
        row.get("last_agg_trade_id"),
        "last_agg_trade_id",
    )
    if (first_id is None) != (last_id is None):
        raise ValueError("first_agg_trade_id and last_agg_trade_id must both be set")
    if first_id is not None and last_id is not None and first_id > last_id:
        raise ValueError("first_agg_trade_id cannot exceed last_agg_trade_id")

    return (
        _identity(row.get("exchange"), "exchange", lower=True),
        _identity(row.get("market_type"), "market_type", lower=True),
        _identity(row.get("symbol"), "symbol", upper=True),
        bucket_open_ms,
        bucket_close_ms,
        buy_base,
        sell_base,
        buy_quote,
        sell_quote,
        _finite_float(
            row.get(
                "base_volume_delta",
                row.get("volume_delta_base", buy_base - sell_base),
            ),
            "base_volume_delta",
        ),
        _finite_float(
            row.get(
                "quote_volume_delta",
                row.get("volume_delta_quote", buy_quote - sell_quote),
            ),
            "quote_volume_delta",
        ),
        agg_trade_count,
        trade_count,
        buy_trade_count,
        sell_trade_count,
        _non_negative_float(
            row.get("max_agg_trade_quote", row.get("max_trade_notional")),
            "max_agg_trade_quote",
        ),
        first_id,
        last_id,
        1 if bool(row.get("is_final", False)) else 0,
        1 if bool(row.get("is_complete", True)) else 0,
        _non_negative_int(
            row.get("revision", row.get("received_at_ms", row.get("updated_at_ms"))),
            "revision",
        ),
        _identity(row.get("source", "trade_flow"), "source", lower=True),
        _non_negative_int(
            row.get("received_at_ms", row.get("updated_at_ms")),
            "received_at_ms",
        ),
        now_ms,
        now_ms,
    )


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


def _non_negative_float(value: Any, label: str) -> float:
    number = _finite_float(value, label)
    if number < 0:
        raise ValueError(f"{label} cannot be negative")
    return number


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


def _optional_non_negative_int(value: Any, label: str) -> int | None:
    if value is None:
        return None
    return _non_negative_int(value, label)


__all__ = [
    "SQLiteTradeFlowRollupStore",
    "TradeFlowRollupStore",
    "init_trade_flow_storage",
]
