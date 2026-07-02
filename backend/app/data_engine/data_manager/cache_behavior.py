"""Persistent cache behavior learning for GC value scoring."""
from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import Any

from app.core.config import DATA_DIR

from .models import SeriesKey

EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
CLEANUP_INTERVAL_MS = 60 * 1000
DEFAULT_CACHE_BEHAVIOR_DB_PATH = DATA_DIR / "cache_behavior.sqlite"

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


class CacheBehaviorStore:
    """SQLite-backed rolling heat table for symbol/interval reuse."""

    def __init__(self, db_path: str | Path | None = None) -> None:
        self.db_path = Path(db_path or DEFAULT_CACHE_BEHAVIOR_DB_PATH)
        self._init_lock = Lock()
        self._initialized = False
        self._last_cleanup_ms = 0
        self._init_db()

    def record(self, event: CacheAccessEvent) -> dict[str, Any]:
        now_ms = int(event.occurred_at_ms or time.time() * 1000)
        action = str(event.action or "access").strip() or "access"
        source = str(event.source or "backend").strip() or "backend"
        weight = float(event.weight if event.weight is not None else ACTION_WEIGHTS.get(action, 1.0))
        self._init_db()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO cache_access_events
                    (exchange, market_type, symbol, interval, action, source, weight, occurred_at_ms)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    event.key.exchange,
                    event.key.market_type,
                    event.key.symbol,
                    event.key.interval,
                    action,
                    source,
                    weight,
                    now_ms,
                ),
            )
            self._cleanup_old_events(conn, now_ms)
            self._refresh_heat(conn, event.key, now_ms)
            row = self._heat_for_conn(conn, event.key)
            conn.commit()
        return _heat_row(row) if row else {}

    def heat_for(self, key: SeriesKey) -> dict[str, Any] | None:
        self._init_db()
        with self._connect() as conn:
            row = self._heat_for_conn(conn, key)
        return _heat_row(row) if row else None

    def snapshot(self, *, limit: int = 50) -> dict[str, Any]:
        self._init_db()
        with self._connect() as conn:
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
        return {
            "owner": "cache-behavior",
            "db_path": str(self.db_path),
            "series": [_heat_row(row) for row in rows],
        }

    def heat_map(self) -> dict[str, dict[str, Any]]:
        snapshot = self.snapshot(limit=10_000)
        return {item["key"]: item for item in snapshot["series"]}

    def _init_db(self) -> None:
        if self._initialized:
            return
        with self._init_lock:
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
        conn.execute("DELETE FROM cache_access_events WHERE occurred_at_ms < ?", (cutoff,))
        self._last_cleanup_ms = now_ms

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
        rows = conn.execute(
            """
            SELECT action, weight, occurred_at_ms
            FROM cache_access_events
            WHERE exchange = ? AND market_type = ? AND symbol = ? AND interval = ?
              AND occurred_at_ms >= ?
            """,
            (key.exchange, key.market_type, key.symbol, key.interval, seven_days),
        ).fetchall()
        count_1h = sum(1 for _, _, ts in rows if int(ts) >= one_hour)
        count_24h = sum(1 for _, _, ts in rows if int(ts) >= one_day)
        count_7d = len(rows)
        switch_count = sum(1 for action, _, ts in rows if str(action).startswith("chart") and int(ts) >= one_day)
        heat = 0.0
        for _action, weight, ts in rows:
            age_hours = max(0.0, (now_ms - int(ts)) / 3_600_000)
            heat += float(weight or 1.0) / (1.0 + age_hours / 24.0)
        last_seen = max((int(ts) for _, _, ts in rows), default=0)
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
                heat,
                last_seen,
                count_1h,
                count_24h,
                count_7d,
                switch_count,
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
