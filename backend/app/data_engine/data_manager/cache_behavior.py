"""Persistent cache behavior learning for GC value scoring."""
from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from threading import RLock
from typing import Any

from app.core.config import DATA_DIR

from .models import SeriesKey

EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
CLEANUP_INTERVAL_MS = 60 * 1000
MAX_FUTURE_EVENT_SKEW_MS = 5 * 60 * 1000
BUCKET_INTERVAL_MS = 60 * 1000
DEFAULT_CACHE_BEHAVIOR_DB_PATH = DATA_DIR / "cache_behavior.sqlite"
_LEGACY_BUCKET_MIGRATION_KEY = "legacy-events-to-minute-buckets-v1"

ACTION_WEIGHTS = {
    "chart-active": 6.0,
    "chart-switch": 5.0,
    "history-query": 4.0,
    "range-query": 4.0,
    "query-before": 3.0,
    "indicator-range": 4.0,
    "watchlist-tier": 3.0,
    "price-stream": 1.5,
    "alert-stream": 6.0,
    "frontend-full-cache-hit": 4.0,
    "stream": 3.0,
}


@dataclass(frozen=True, slots=True)
class CacheAccessEvent:
    key: SeriesKey
    action: str
    source: str = "backend"
    weight: float | None = None
    detail: dict[str, Any] | None = None
    occurred_at_ms: int | None = None
    count: int = 1


class CacheBehaviorStore:
    """SQLite-backed rolling heat table for symbol/interval reuse."""

    def __init__(self, db_path: str | Path | None = None) -> None:
        self.db_path = Path(db_path or DEFAULT_CACHE_BEHAVIOR_DB_PATH)
        self._lock = RLock()
        self._initialized = False
        self._last_cleanup_ms = 0
        self._last_refresh_ms = 0
        self._dirty = False
        self._init_db()

    def record(self, event: CacheAccessEvent) -> dict[str, Any]:
        return self.record_batch([event], refresh_heat=True)

    def record_batch(
        self,
        events: list[CacheAccessEvent] | tuple[CacheAccessEvent, ...],
        *,
        refresh_heat: bool = False,
    ) -> dict[str, Any]:
        """Persist access signals in one transaction using minute buckets.

        The previous implementation inserted one row and rescanned seven days
        of history for every access.  Runtime callers can now coalesce signals
        and call this method once per flush.  Bucket upserts are O(number of
        distinct series/minutes in the batch); exact heat materialisation is
        deferred until a GC/diagnostic read.  ``record()`` still refreshes the
        touched series immediately for the synchronous settings API.
        """
        if not events:
            return {}

        server_now_ms = int(time.time() * 1000)
        normalized: dict[tuple[str, str, str, str, int], list[Any]] = {}
        last_key: SeriesKey | None = None
        latest_ms = 0
        total_signals = 0
        for event in events:
            occurred_at_ms = (
                server_now_ms
                if event.occurred_at_ms is None
                else min(server_now_ms, max(0, int(event.occurred_at_ms)))
            )
            action = str(event.action or "access").strip() or "access"
            count = max(1, int(event.count or 1))
            weight = float(
                event.weight
                if event.weight is not None
                else ACTION_WEIGHTS.get(action, 1.0)
            )
            bucket_start_ms = occurred_at_ms - (occurred_at_ms % BUCKET_INTERVAL_MS)
            identity = (
                event.key.exchange,
                event.key.market_type,
                event.key.symbol,
                event.key.interval,
                bucket_start_ms,
            )
            aggregate = normalized.setdefault(identity, [0, 0, 0.0, 0])
            aggregate[0] += count
            if action.startswith("chart"):
                aggregate[1] += count
            aggregate[2] += weight * count
            aggregate[3] = max(int(aggregate[3]), occurred_at_ms)
            total_signals += count
            if occurred_at_ms >= latest_ms:
                latest_ms = occurred_at_ms
                last_key = event.key

        self._init_db()
        with self._lock, self._connect() as conn:
            conn.executemany(
                """
                INSERT INTO cache_access_buckets (
                    exchange, market_type, symbol, interval, bucket_start_ms,
                    access_count, switch_count, weight_sum, last_seen_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(exchange, market_type, symbol, interval, bucket_start_ms)
                DO UPDATE SET
                    access_count = access_count + excluded.access_count,
                    switch_count = switch_count + excluded.switch_count,
                    weight_sum = weight_sum + excluded.weight_sum,
                    last_seen_ms = MAX(last_seen_ms, excluded.last_seen_ms)
                """,
                [
                    (*identity, *aggregate)
                    for identity, aggregate in normalized.items()
                ],
            )
            self._dirty = True
            self._cleanup_old_events(conn, server_now_ms)
            row = None
            if refresh_heat and last_key is not None:
                self._refresh_heat(conn, last_key, server_now_ms)
                row = self._heat_for_conn(conn, last_key)
            conn.commit()

        if row is not None:
            return _heat_row(row)
        return {
            "recorded": total_signals,
            "bucket_updates": len(normalized),
        }

    def heat_for(self, key: SeriesKey) -> dict[str, Any] | None:
        self._init_db()
        with self._lock, self._connect() as conn:
            now_ms = int(time.time() * 1000)
            self._cleanup_old_events(conn, now_ms)
            self._refresh_heat(conn, key, now_ms)
            row = self._heat_for_conn(conn, key)
            conn.commit()
        return _heat_row(row) if row else None

    def snapshot(self, *, limit: int = 50) -> dict[str, Any]:
        self._init_db()
        with self._lock, self._connect() as conn:
            now_ms = int(time.time() * 1000)
            self._cleanup_old_events(conn, now_ms)
            self._refresh_all_heat(conn, now_ms)
            rows = conn.execute(
                """
                SELECT exchange, market_type, symbol, interval, heat_score, last_seen_ms,
                       access_count_1h, access_count_24h, access_count_7d, switch_count_24h
                FROM cache_series_heat
                ORDER BY heat_score DESC, last_seen_ms DESC
                LIMIT ?
                """,
                (max(1, int(limit or 50)),),
            ).fetchall()
            conn.commit()
        return {
            "owner": "cache-behavior",
            "db_path": str(self.db_path),
            "storage_model": "minute-buckets",
            "bucket_interval_ms": BUCKET_INTERVAL_MS,
            "series": [_heat_row(row) for row in rows],
        }

    def heat_map(self) -> dict[str, dict[str, Any]]:
        snapshot = self.snapshot(limit=10_000)
        return {item["key"]: item for item in snapshot["series"]}

    def _init_db(self) -> None:
        if self._initialized:
            return
        with self._lock:
            if self._initialized:
                return
            self.db_path.parent.mkdir(parents=True, exist_ok=True)
            with self._connect() as conn:
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS cache_access_events (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        exchange TEXT NOT NULL,
                        market_type TEXT NOT NULL,
                        symbol TEXT NOT NULL,
                        interval TEXT NOT NULL,
                        action TEXT NOT NULL,
                        source TEXT NOT NULL,
                        weight REAL NOT NULL DEFAULT 1,
                        occurred_at_ms INTEGER NOT NULL
                    )
                    """
                )
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS cache_access_buckets (
                        exchange TEXT NOT NULL,
                        market_type TEXT NOT NULL,
                        symbol TEXT NOT NULL,
                        interval TEXT NOT NULL,
                        bucket_start_ms INTEGER NOT NULL,
                        access_count INTEGER NOT NULL DEFAULT 0,
                        switch_count INTEGER NOT NULL DEFAULT 0,
                        weight_sum REAL NOT NULL DEFAULT 0,
                        last_seen_ms INTEGER NOT NULL DEFAULT 0,
                        PRIMARY KEY (
                            exchange, market_type, symbol, interval,
                            bucket_start_ms
                        )
                    )
                    """
                )
                conn.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_cache_access_buckets_time
                    ON cache_access_buckets (last_seen_ms)
                    """
                )
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS cache_behavior_meta (
                        key TEXT PRIMARY KEY,
                        value TEXT NOT NULL
                    )
                    """
                )
                conn.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_cache_access_events_series_time
                    ON cache_access_events (exchange, market_type, symbol, interval, occurred_at_ms)
                    """
                )
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS cache_series_heat (
                        exchange TEXT NOT NULL,
                        market_type TEXT NOT NULL,
                        symbol TEXT NOT NULL,
                        interval TEXT NOT NULL,
                        heat_score REAL NOT NULL DEFAULT 0,
                        last_seen_ms INTEGER NOT NULL DEFAULT 0,
                        access_count_1h INTEGER NOT NULL DEFAULT 0,
                        access_count_24h INTEGER NOT NULL DEFAULT 0,
                        access_count_7d INTEGER NOT NULL DEFAULT 0,
                        switch_count_24h INTEGER NOT NULL DEFAULT 0,
                        PRIMARY KEY (exchange, market_type, symbol, interval)
                    )
                    """
                )
                migrated = conn.execute(
                    "SELECT value FROM cache_behavior_meta WHERE key = ?",
                    (_LEGACY_BUCKET_MIGRATION_KEY,),
                ).fetchone()
                if migrated is None:
                    conn.execute(
                        """
                        INSERT INTO cache_access_buckets (
                            exchange, market_type, symbol, interval,
                            bucket_start_ms, access_count, switch_count,
                            weight_sum, last_seen_ms
                        )
                        SELECT exchange, market_type, symbol, interval,
                               (occurred_at_ms / ?) * ?,
                               COUNT(*),
                               SUM(CASE WHEN action LIKE 'chart%' THEN 1 ELSE 0 END),
                               SUM(weight),
                               MAX(occurred_at_ms)
                        FROM cache_access_events
                        GROUP BY exchange, market_type, symbol, interval,
                                 (occurred_at_ms / ?)
                        ON CONFLICT(
                            exchange, market_type, symbol, interval,
                            bucket_start_ms
                        ) DO NOTHING
                        """,
                        (
                            BUCKET_INTERVAL_MS,
                            BUCKET_INTERVAL_MS,
                            BUCKET_INTERVAL_MS,
                        ),
                    )
                    conn.execute(
                        "INSERT INTO cache_behavior_meta (key, value) VALUES (?, ?)",
                        (_LEGACY_BUCKET_MIGRATION_KEY, "complete"),
                    )
                conn.commit()
            self._initialized = True

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), timeout=10.0)
        conn.execute("PRAGMA busy_timeout = 5000")
        return conn

    def _cleanup_old_events(self, conn: sqlite3.Connection, now_ms: int) -> None:
        if now_ms - self._last_cleanup_ms < CLEANUP_INTERVAL_MS:
            return
        cutoff = now_ms - EVENT_RETENTION_MS
        conn.execute(
            """
            DELETE FROM cache_access_events
            WHERE occurred_at_ms < ? OR occurred_at_ms > ?
            """,
            (cutoff, now_ms),
        )
        conn.execute(
            """
            DELETE FROM cache_access_buckets
            WHERE last_seen_ms < ? OR last_seen_ms > ? OR bucket_start_ms > ?
            """,
            (cutoff, now_ms, now_ms),
        )
        self._last_cleanup_ms = now_ms

    def _refresh_all_heat(self, conn: sqlite3.Connection, now_ms: int) -> None:
        """Refresh every materialized heat row with time-decayed values."""
        if not self._dirty and now_ms - self._last_refresh_ms < CLEANUP_INTERVAL_MS:
            return
        one_hour = now_ms - 60 * 60 * 1000
        one_day = now_ms - 24 * 60 * 60 * 1000
        seven_days = now_ms - EVENT_RETENTION_MS
        conn.execute(
            """
            INSERT INTO cache_series_heat
                (exchange, market_type, symbol, interval, heat_score, last_seen_ms,
                 access_count_1h, access_count_24h, access_count_7d, switch_count_24h)
            SELECT exchange, market_type, symbol, interval,
                   SUM(weight_sum / (1.0 + MAX(0.0, ((? - last_seen_ms) / 3600000.0)) / 24.0)),
                   MAX(last_seen_ms),
                   SUM(CASE WHEN last_seen_ms >= ? THEN access_count ELSE 0 END),
                   SUM(CASE WHEN last_seen_ms >= ? THEN access_count ELSE 0 END),
                   SUM(access_count),
                   SUM(CASE WHEN last_seen_ms >= ? THEN switch_count ELSE 0 END)
            FROM cache_access_buckets
            WHERE last_seen_ms >= ? AND last_seen_ms <= ?
            GROUP BY exchange, market_type, symbol, interval
            ON CONFLICT(exchange, market_type, symbol, interval)
            DO UPDATE SET
                heat_score = excluded.heat_score,
                last_seen_ms = excluded.last_seen_ms,
                access_count_1h = excluded.access_count_1h,
                access_count_24h = excluded.access_count_24h,
                access_count_7d = excluded.access_count_7d,
                switch_count_24h = excluded.switch_count_24h
            """,
            (now_ms, one_hour, one_day, one_day, seven_days, now_ms),
        )
        conn.execute(
            """
            DELETE FROM cache_series_heat
            WHERE NOT EXISTS (
                SELECT 1 FROM cache_access_buckets AS buckets
                WHERE buckets.exchange = cache_series_heat.exchange
                  AND buckets.market_type = cache_series_heat.market_type
                  AND buckets.symbol = cache_series_heat.symbol
                  AND buckets.interval = cache_series_heat.interval
                  AND buckets.last_seen_ms >= ?
                  AND buckets.last_seen_ms <= ?
            )
            """,
            (seven_days, now_ms),
        )
        self._last_refresh_ms = now_ms
        self._dirty = False

    @staticmethod
    def _heat_for_conn(conn: sqlite3.Connection, key: SeriesKey) -> tuple[Any, ...] | None:
        return conn.execute(
            """
            SELECT exchange, market_type, symbol, interval, heat_score, last_seen_ms,
                   access_count_1h, access_count_24h, access_count_7d, switch_count_24h
            FROM cache_series_heat
            WHERE exchange = ? AND market_type = ? AND symbol = ? AND interval = ?
            """,
            (key.exchange, key.market_type, key.symbol, key.interval),
        ).fetchone()

    @staticmethod
    def _refresh_heat(conn: sqlite3.Connection, key: SeriesKey, now_ms: int) -> None:
        one_hour = now_ms - 60 * 60 * 1000
        one_day = now_ms - 24 * 60 * 60 * 1000
        seven_days = now_ms - EVENT_RETENTION_MS
        row = conn.execute(
            """
            SELECT
                SUM(weight_sum / (1.0 + MAX(0.0, ((? - last_seen_ms) / 3600000.0)) / 24.0)),
                MAX(last_seen_ms),
                SUM(CASE WHEN last_seen_ms >= ? THEN access_count ELSE 0 END),
                SUM(CASE WHEN last_seen_ms >= ? THEN access_count ELSE 0 END),
                SUM(access_count),
                SUM(CASE WHEN last_seen_ms >= ? THEN switch_count ELSE 0 END)
            FROM cache_access_buckets
            WHERE exchange = ? AND market_type = ? AND symbol = ? AND interval = ?
              AND last_seen_ms >= ? AND last_seen_ms <= ?
            """,
            (
                now_ms,
                one_hour,
                one_day,
                one_day,
                key.exchange,
                key.market_type,
                key.symbol,
                key.interval,
                seven_days,
                now_ms,
            ),
        ).fetchone()
        heat, last_seen, count_1h, count_24h, count_7d, switch_count = row or (
            None,
            None,
            None,
            None,
            None,
            None,
        )
        if last_seen is None:
            conn.execute(
                """
                DELETE FROM cache_series_heat
                WHERE exchange = ? AND market_type = ? AND symbol = ? AND interval = ?
                """,
                (key.exchange, key.market_type, key.symbol, key.interval),
            )
            return
        conn.execute(
            """
            INSERT INTO cache_series_heat
                (exchange, market_type, symbol, interval, heat_score, last_seen_ms,
                 access_count_1h, access_count_24h, access_count_7d, switch_count_24h)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(exchange, market_type, symbol, interval)
            DO UPDATE SET
                heat_score = excluded.heat_score,
                last_seen_ms = excluded.last_seen_ms,
                access_count_1h = excluded.access_count_1h,
                access_count_24h = excluded.access_count_24h,
                access_count_7d = excluded.access_count_7d,
                switch_count_24h = excluded.switch_count_24h
            """,
            (
                key.exchange,
                key.market_type,
                key.symbol,
                key.interval,
                float(heat or 0),
                int(last_seen or 0),
                int(count_1h or 0),
                int(count_24h or 0),
                int(count_7d or 0),
                int(switch_count or 0),
            ),
        )


def _heat_row(row: tuple[Any, ...]) -> dict[str, Any]:
    exchange, market_type, symbol, interval, heat, last_seen, c1h, c24h, c7d, switches = row
    key = SeriesKey(symbol, interval, exchange=exchange, market_type=market_type)
    return {
        "key": str(key),
        "exchange": key.exchange,
        "market_type": key.market_type,
        "symbol": key.symbol,
        "interval": key.interval,
        "heat_score": float(heat or 0),
        "last_seen_ms": int(last_seen or 0),
        "access_count_1h": int(c1h or 0),
        "access_count_24h": int(c24h or 0),
        "access_count_7d": int(c7d or 0),
        "switch_count_24h": int(switches or 0),
    }
