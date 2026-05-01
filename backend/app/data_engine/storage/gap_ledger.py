from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from typing import Any

from app.core.config import KLINES_DB_PATH
from app.data_engine.interval_policy import parse_interval_ms


def _connect(db_path: Path | str | None = None) -> sqlite3.Connection:
    path = Path(db_path or KLINES_DB_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    return conn


def _now_ms() -> int:
    return int(time.time() * 1000)


def _estimate_count(start_ms: int, end_ms: int, interval: str) -> int:
    interval_ms = parse_interval_ms(interval) or 60_000
    if end_ms < start_ms:
        return 0
    return int((end_ms - start_ms) // interval_ms) + 1


class GapLedger:
    """Persistent ledger for detected and repaired K-line gaps."""

    def __init__(self, db_path: Path | str | None = None) -> None:
        self._db_path = Path(db_path or KLINES_DB_PATH)
        self.init_storage()

    def init_storage(self) -> None:
        with _connect(self._db_path) as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS kline_gap_ledger (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    exchange TEXT NOT NULL,
                    market_type TEXT NOT NULL,
                    symbol TEXT NOT NULL,
                    interval TEXT NOT NULL,
                    start_ms INTEGER NOT NULL,
                    end_ms INTEGER NOT NULL,
                    expected_count INTEGER NOT NULL,
                    missing_count INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    priority INTEGER NOT NULL DEFAULT 100,
                    reason TEXT NOT NULL,
                    repair_ticket TEXT,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT,
                    first_seen_at INTEGER NOT NULL,
                    last_seen_at INTEGER NOT NULL,
                    last_checked_at INTEGER,
                    resolved_at INTEGER,
                    next_retry_at INTEGER,
                    metadata_json TEXT,
                    UNIQUE(exchange, market_type, symbol, interval, start_ms, end_ms)
                );

                CREATE INDEX IF NOT EXISTS idx_gap_ledger_status_priority
                ON kline_gap_ledger(status, priority, next_retry_at);

                CREATE INDEX IF NOT EXISTS idx_gap_ledger_series
                ON kline_gap_ledger(exchange, market_type, symbol, interval, start_ms, end_ms);
                """
            )

    def upsert_detected(self, request: Any, *, status: str = "queued") -> None:
        now = _now_ms()
        expected = _estimate_count(request.start_ms, request.end_ms, request.interval)
        metadata = dict(getattr(request, "metadata", {}) or {})
        priority = int(metadata.get("priority", 100))
        with _connect(self._db_path) as conn:
            conn.execute(
                """
                INSERT INTO kline_gap_ledger (
                    exchange, market_type, symbol, interval, start_ms, end_ms,
                    expected_count, missing_count, status, priority, reason,
                    repair_ticket, attempts, first_seen_at, last_seen_at,
                    metadata_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
                ON CONFLICT(exchange, market_type, symbol, interval, start_ms, end_ms)
                DO UPDATE SET
                    expected_count = excluded.expected_count,
                    missing_count = excluded.missing_count,
                    status = excluded.status,
                    priority = excluded.priority,
                    reason = excluded.reason,
                    repair_ticket = excluded.repair_ticket,
                    last_seen_at = excluded.last_seen_at,
                    metadata_json = excluded.metadata_json
                """,
                (
                    request.exchange,
                    request.market_type,
                    request.symbol,
                    request.interval,
                    int(request.start_ms),
                    int(request.end_ms),
                    expected,
                    expected,
                    status,
                    priority,
                    request.reason,
                    request.request_id,
                    now,
                    now,
                    json.dumps(metadata, sort_keys=True),
                ),
            )
            conn.commit()

    def mark_started(self, request: Any, *, attempt: int) -> None:
        self._update(
            request,
            status="repairing",
            attempts=attempt,
            last_error=None,
            next_retry_at=None,
        )

    def mark_retry_wait(
        self,
        request: Any,
        *,
        attempt: int,
        error: str | None,
        next_retry_at: int,
    ) -> None:
        self._update(
            request,
            status="retry_wait",
            attempts=attempt,
            last_error=error,
            next_retry_at=next_retry_at,
        )

    def mark_verifying(self, request: Any) -> None:
        self._update(request, status="verifying", last_checked_at=_now_ms())

    def mark_resolved(
        self,
        request: Any,
        *,
        status: str,
        missing_count: int | None = None,
        error: str | None = None,
    ) -> None:
        now = _now_ms()
        values: dict[str, Any] = {
            "status": status,
            "last_error": error,
            "last_checked_at": now,
            "resolved_at": now if status in {"filled", "source_empty", "failed"} else None,
            "next_retry_at": now + 86_400_000 if status == "source_empty" else None,
        }
        if status == "filled" and missing_count is None:
            missing_count = 0
        if missing_count is not None:
            values["missing_count"] = max(0, int(missing_count))
        self._update(request, **values)

    def get_status(self, request: Any) -> dict[str, Any] | None:
        with _connect(self._db_path) as conn:
            row = conn.execute(
                """
                SELECT
                    status,
                    attempts,
                    missing_count,
                    last_error,
                    last_checked_at,
                    resolved_at,
                    next_retry_at
                FROM kline_gap_ledger
                WHERE exchange = ?
                  AND market_type = ?
                  AND symbol = ?
                  AND interval = ?
                  AND start_ms = ?
                  AND end_ms = ?
                """,
                (
                    request.exchange,
                    request.market_type,
                    request.symbol,
                    request.interval,
                    int(request.start_ms),
                    int(request.end_ms),
                ),
            ).fetchone()
        return dict(row) if row is not None else None

    def list_open(self, *, limit: int = 100) -> list[dict[str, Any]]:
        with _connect(self._db_path) as conn:
            rows = conn.execute(
                """
                SELECT *
                FROM kline_gap_ledger
                WHERE status NOT IN ('filled', 'source_empty')
                ORDER BY priority ASC, first_seen_at ASC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [dict(row) for row in rows]

    def _update(self, request: Any, **values: Any) -> None:
        if not values:
            return
        assignments = []
        params: list[Any] = []
        for key, value in values.items():
            assignments.append(f"{key} = ?")
            params.append(value)
        params.extend([
            request.exchange,
            request.market_type,
            request.symbol,
            request.interval,
            int(request.start_ms),
            int(request.end_ms),
        ])
        with _connect(self._db_path) as conn:
            conn.execute(
                f"""
                UPDATE kline_gap_ledger
                SET {", ".join(assignments)}
                WHERE exchange = ?
                  AND market_type = ?
                  AND symbol = ?
                  AND interval = ?
                  AND start_ms = ?
                  AND end_ms = ?
                """,
                params,
            )
            conn.commit()
