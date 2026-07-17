"""Storage contract and SQLite backend for one-minute liquidation rollups.

The public contract is asynchronous so the reducer and service do not depend
on SQLite.  All SQLite work is submitted to the shared storage executor,
leaving room for a future DuckDB implementation without changing callers.
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


logger = logging.getLogger("candlescope.storage.liquidation")


@runtime_checkable
class LiquidationRollupStore(Protocol):
    """Database-agnostic asynchronous liquidation rollup contract."""

    async def upsert_rollups(self, rows: Iterable[dict[str, Any]]) -> int:
        """Persist one-minute long/short rollups and return input row count."""

    async def query_rollups(
        self,
        *,
        exchange: str,
        market_type: str,
        symbol: str,
        start_ms: int | None = None,
        end_ms: int | None = None,
        position_side: str | None = None,
        limit: int = 1000,
    ) -> list[dict[str, Any]]:
        """Return a bounded range ordered by bucket and position side."""

    async def query_recent_rollups(
        self,
        *,
        exchange: str,
        market_type: str,
        symbol: str,
        position_side: str | None = None,
        limit: int = 1000,
    ) -> list[dict[str, Any]]:
        """Return the newest bounded tail, presented in ascending order."""

    async def diagnostics(self) -> dict[str, Any]:
        """Return backend identity and aggregate storage bounds."""

    async def close(self) -> None:
        """Release backend resources and reject future reads/writes."""


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


def init_liquidation_storage(db_path: Path | str | None = None) -> None:
    """Create the independent one-minute liquidation rollup table."""

    path = Path(db_path or KLINES_DB_PATH)
    with closing(_connect(path)) as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS liquidation_rollup_1m (
                exchange TEXT NOT NULL,
                market_type TEXT NOT NULL,
                symbol TEXT NOT NULL,
                bucket_open_ms INTEGER NOT NULL CHECK (
                    bucket_open_ms >= 0 AND bucket_open_ms % 60000 = 0
                ),
                bucket_close_ms INTEGER NOT NULL CHECK (
                    bucket_close_ms = bucket_open_ms + 60000
                ),
                position_side TEXT NOT NULL CHECK (
                    position_side IN ('long', 'short')
                ),
                filled_quantity REAL NOT NULL CHECK (filled_quantity >= 0),
                filled_notional REAL NOT NULL CHECK (filled_notional >= 0),
                event_count INTEGER NOT NULL CHECK (event_count >= 0),
                max_event_notional REAL NOT NULL CHECK (max_event_notional >= 0),
                first_event_time_ms INTEGER NOT NULL CHECK (
                    first_event_time_ms >= 0
                ),
                last_event_time_ms INTEGER NOT NULL CHECK (
                    last_event_time_ms >= first_event_time_ms
                ),
                is_final INTEGER NOT NULL DEFAULT 0 CHECK (is_final IN (0, 1)),
                revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
                source TEXT NOT NULL,
                received_at_ms INTEGER NOT NULL CHECK (received_at_ms >= 0),
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                PRIMARY KEY (
                    exchange,
                    market_type,
                    symbol,
                    bucket_open_ms,
                    position_side
                )
            );

            CREATE INDEX IF NOT EXISTS idx_liquidation_rollup_1m_lookup
            ON liquidation_rollup_1m(
                exchange,
                market_type,
                symbol,
                bucket_open_ms ASC,
                position_side ASC
            );
            """
        )
        conn.commit()


class SQLiteLiquidationRollupStore:
    """Async SQLite implementation of :class:`LiquidationRollupStore`."""

    backend_name = "sqlite"

    def __init__(self, db_path: Path | str | None = None) -> None:
        self.db_path = Path(db_path or KLINES_DB_PATH)
        self._initialized = False
        self._initialize_lock = Lock()
        self._closed = False

    async def upsert_rollups(self, rows: Iterable[dict[str, Any]]) -> int:
        self._require_open()
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
        position_side: str | None = None,
        limit: int = 1000,
    ) -> list[dict[str, Any]]:
        self._require_open()
        start = _optional_non_negative_int(start_ms, "start_ms")
        end = _optional_non_negative_int(end_ms, "end_ms")
        if start is not None and end is not None and start > end:
            raise ValueError("start_ms cannot exceed end_ms")
        return await run_storage(
            self._query_sync,
            exchange=exchange,
            market_type=market_type,
            symbol=symbol,
            start_ms=start,
            end_ms=end,
            position_side=_optional_position_side(position_side),
            limit=_bounded_limit(limit),
        )

    async def query_recent_rollups(
        self,
        *,
        exchange: str,
        market_type: str,
        symbol: str,
        position_side: str | None = None,
        limit: int = 1000,
    ) -> list[dict[str, Any]]:
        self._require_open()
        return await run_storage(
            self._query_recent_sync,
            exchange=exchange,
            market_type=market_type,
            symbol=symbol,
            position_side=_optional_position_side(position_side),
            limit=_bounded_limit(limit),
        )

    async def diagnostics(self) -> dict[str, Any]:
        return await run_storage(self._diagnostics_sync)

    async def close(self) -> None:
        # Connections are intentionally short-lived.  The state transition is
        # still part of the backend-agnostic contract for future persistent
        # engines such as DuckDB.
        self._closed = True

    def _require_open(self) -> None:
        if self._closed:
            raise RuntimeError("liquidation rollup store is closed")

    def _ensure_initialized(self) -> None:
        if self._initialized:
            return
        with self._initialize_lock:
            if not self._initialized:
                init_liquidation_storage(self.db_path)
                self._initialized = True

    def _upsert_sync(self, rows: list[dict[str, Any]]) -> int:
        self._ensure_initialized()
        now_ms = int(time.time() * 1000)
        payload = [_rollup_payload(row, now_ms=now_ms) for row in rows]
        with closing(_connect(self.db_path)) as conn:
            conn.executemany(
                """
                INSERT INTO liquidation_rollup_1m (
                    exchange,
                    market_type,
                    symbol,
                    bucket_open_ms,
                    bucket_close_ms,
                    position_side,
                    filled_quantity,
                    filled_notional,
                    event_count,
                    max_event_notional,
                    first_event_time_ms,
                    last_event_time_ms,
                    is_final,
                    revision,
                    source,
                    received_at_ms,
                    created_at_ms,
                    updated_at_ms
                ) VALUES (
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                )
                ON CONFLICT(
                    exchange,
                    market_type,
                    symbol,
                    bucket_open_ms,
                    position_side
                ) DO UPDATE SET
                    bucket_close_ms = excluded.bucket_close_ms,
                    filled_quantity = excluded.filled_quantity,
                    filled_notional = excluded.filled_notional,
                    event_count = excluded.event_count,
                    max_event_notional = excluded.max_event_notional,
                    first_event_time_ms = excluded.first_event_time_ms,
                    last_event_time_ms = excluded.last_event_time_ms,
                    is_final = excluded.is_final,
                    revision = excluded.revision,
                    source = excluded.source,
                    received_at_ms = excluded.received_at_ms,
                    updated_at_ms = excluded.updated_at_ms
                WHERE
                    excluded.is_final >= liquidation_rollup_1m.is_final
                    AND (
                        excluded.received_at_ms >
                            liquidation_rollup_1m.received_at_ms
                        OR (
                            excluded.received_at_ms =
                                liquidation_rollup_1m.received_at_ms
                            AND excluded.revision >=
                                liquidation_rollup_1m.revision
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
        position_side: str | None,
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
            params.append(start_ms)
        if end_ms is not None:
            where.append("bucket_open_ms <= ?")
            params.append(end_ms)
        if position_side is not None:
            where.append("position_side = ?")
            params.append(position_side)
        with closing(_connect(self.db_path)) as conn:
            rows = conn.execute(
                f"""
                SELECT {_SELECT_COLUMNS}
                FROM liquidation_rollup_1m
                WHERE {" AND ".join(where)}
                ORDER BY bucket_open_ms ASC, position_side ASC
                LIMIT ?
                """,
                [*params, limit],
            ).fetchall()
        return [dict(row) for row in rows]

    def _query_recent_sync(
        self,
        *,
        exchange: str,
        market_type: str,
        symbol: str,
        position_side: str | None,
        limit: int,
    ) -> list[dict[str, Any]]:
        self._ensure_initialized()
        where = ["exchange = ?", "market_type = ?", "symbol = ?"]
        params: list[Any] = [
            _identity(exchange, "exchange", lower=True),
            _identity(market_type, "market_type", lower=True),
            _identity(symbol, "symbol", upper=True),
        ]
        if position_side is not None:
            where.append("position_side = ?")
            params.append(position_side)
        with closing(_connect(self.db_path)) as conn:
            rows = conn.execute(
                f"""
                SELECT *
                FROM (
                    SELECT {_SELECT_COLUMNS}
                    FROM liquidation_rollup_1m
                    WHERE {" AND ".join(where)}
                    ORDER BY bucket_open_ms DESC, position_side DESC
                    LIMIT ?
                )
                ORDER BY bucket_open_ms ASC, position_side ASC
                """,
                [*params, limit],
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
                       SUM(CASE WHEN is_final = 0 THEN 1 ELSE 0 END)
                           AS provisional_rows,
                       SUM(CASE WHEN position_side = 'long' THEN 1 ELSE 0 END)
                           AS long_rows,
                       SUM(CASE WHEN position_side = 'short' THEN 1 ELSE 0 END)
                           AS short_rows
                FROM liquidation_rollup_1m
                """
            ).fetchone()
        return {
            "backend": self.backend_name,
            "db_path": str(self.db_path),
            "state": "closed" if self._closed else "ready",
            "rollups": dict(row) if row is not None else {},
        }


_SELECT_COLUMNS = """
    exchange, market_type, symbol,
    bucket_open_ms, bucket_close_ms, position_side,
    filled_quantity, filled_notional, event_count, max_event_notional,
    first_event_time_ms, last_event_time_ms,
    is_final, revision, source, received_at_ms
""".strip()


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

    first_event_time_ms = _non_negative_int(
        row.get("first_event_time_ms"),
        "first_event_time_ms",
    )
    last_event_time_ms = _non_negative_int(
        row.get("last_event_time_ms"),
        "last_event_time_ms",
    )
    if first_event_time_ms > last_event_time_ms:
        raise ValueError("first_event_time_ms cannot exceed last_event_time_ms")

    received_at_ms = _non_negative_int(
        row.get("received_at_ms", row.get("updated_at_ms")),
        "received_at_ms",
    )
    revision = _non_negative_int(
        row.get("revision", received_at_ms),
        "revision",
    )
    return (
        _identity(row.get("exchange"), "exchange", lower=True),
        _identity(row.get("market_type"), "market_type", lower=True),
        _identity(row.get("symbol"), "symbol", upper=True),
        bucket_open_ms,
        bucket_close_ms,
        _position_side(row.get("position_side")),
        _non_negative_float(row.get("filled_quantity"), "filled_quantity"),
        _non_negative_float(row.get("filled_notional"), "filled_notional"),
        _non_negative_int(row.get("event_count"), "event_count"),
        _non_negative_float(
            row.get("max_event_notional"),
            "max_event_notional",
        ),
        first_event_time_ms,
        last_event_time_ms,
        _boolean_flag(row.get("is_final", False), "is_final"),
        revision,
        _identity(row.get("source", "liquidation"), "source", lower=True),
        received_at_ms,
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


def _position_side(value: Any) -> str:
    side = _identity(value, "position_side", lower=True)
    if side not in {"long", "short"}:
        raise ValueError("position_side must be 'long' or 'short'")
    return side


def _optional_position_side(value: Any) -> str | None:
    if value is None:
        return None
    return _position_side(value)


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
    if isinstance(value, float) and not value.is_integer():
        raise ValueError(f"{label} must be a non-negative integer")
    if number < 0:
        raise ValueError(f"{label} must be a non-negative integer")
    return number


def _optional_non_negative_int(value: Any, label: str) -> int | None:
    if value is None:
        return None
    return _non_negative_int(value, label)


def _boolean_flag(value: Any, label: str) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int) and value in {0, 1}:
        return value
    raise ValueError(f"{label} must be a boolean")


def _bounded_limit(value: Any) -> int:
    limit = _non_negative_int(value, "limit")
    if limit < 1:
        raise ValueError("limit must be a positive integer")
    # Public APIs expose at most 5000 rows; one internal look-ahead row is
    # allowed so pagination can report ``has_more`` without guessing.
    return min(limit, 5001)


__all__ = [
    "LiquidationRollupStore",
    "SQLiteLiquidationRollupStore",
    "init_liquidation_storage",
]
