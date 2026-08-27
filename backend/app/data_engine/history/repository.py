"""SQLite persistence for learned series-level history boundaries."""
from __future__ import annotations

import json
import logging
import sqlite3
import time
from dataclasses import replace
from pathlib import Path
from typing import Any

from app.core.config import KLINES_DB_PATH
from app.data_engine.history.models import (
    BoundaryReason,
    BoundarySide,
    BoundaryState,
    HistoryAvailability,
    HistorySeriesKey,
    StoredHistoryBoundary,
    TimeBound,
)
from app.data_engine.storage.sqlite_runtime import open_sqlite


logger = logging.getLogger("candlescope.storage.history_boundaries")


def _now_ms() -> int:
    return int(time.time() * 1000)


class HistoryBoundaryRepository:
    """Persist evidence about the left/right edge of one historical series.

    Rolling-retention cutoffs are intentionally rejected: callers persist the
    retention duration in capabilities and let the planner recalculate its
    absolute cutoff against the current clock.
    """

    def __init__(self, db_path: Path | str | None = None) -> None:
        self._db_path = Path(db_path or KLINES_DB_PATH)
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self.init_storage()

    def _connect(self) -> sqlite3.Connection:
        return open_sqlite(self._db_path, logger=logger)

    def init_storage(self) -> None:
        with self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS history_series_boundaries (
                    exchange TEXT NOT NULL,
                    market_type TEXT NOT NULL,
                    symbol TEXT NOT NULL,
                    channel TEXT NOT NULL,
                    variant TEXT NOT NULL DEFAULT '',
                    params_hash TEXT NOT NULL DEFAULT '',
                    side TEXT NOT NULL,
                    value_ms INTEGER NOT NULL,
                    state TEXT NOT NULL,
                    reason TEXT NOT NULL,
                    retryable INTEGER NOT NULL DEFAULT 0,
                    revision TEXT NOT NULL DEFAULT '',
                    revalidate_at_ms INTEGER,
                    evidence_count INTEGER NOT NULL DEFAULT 1,
                    first_seen_at_ms INTEGER NOT NULL,
                    last_seen_at_ms INTEGER NOT NULL,
                    metadata_json TEXT,
                    PRIMARY KEY (
                        exchange, market_type, symbol, channel,
                        variant, params_hash, side
                    )
                );

                CREATE INDEX IF NOT EXISTS idx_history_boundary_revalidate
                ON history_series_boundaries(revalidate_at_ms);

                CREATE INDEX IF NOT EXISTS idx_history_boundary_state
                ON history_series_boundaries(state, retryable);
                """
            )

    @staticmethod
    def _key_values(key: HistorySeriesKey) -> tuple[str, ...]:
        return (
            key.exchange,
            key.market_type,
            key.symbol,
            key.channel,
            key.variant,
            key.params_hash,
        )
    def upsert(
        self,
        key: HistorySeriesKey,
        side: BoundarySide | str,
        bound: TimeBound,
        *,
        evidence_increment: int = 1,
        observed_at_ms: int | None = None,
        allow_downgrade: bool = False,
    ) -> StoredHistoryBoundary:
        side = BoundarySide(side)
        if bound.dynamic:
            raise ValueError("dynamic rolling-retention bounds must not be persisted")
        increment = max(1, int(evidence_increment))
        observed_at = _now_ms() if observed_at_ms is None else int(observed_at_ms)
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            existing = conn.execute(
                """
                SELECT * FROM history_series_boundaries
                WHERE exchange = ? AND market_type = ? AND symbol = ?
                  AND channel = ? AND variant = ? AND params_hash = ? AND side = ?
                """,
                (*self._key_values(key), side.value),
            ).fetchone()
            if existing is not None:
                existing_state = BoundaryState(existing["state"])
                same_evidence = (
                    int(existing["value_ms"]) == bound.value_ms
                    and existing["reason"] == bound.reason.value
                    and existing["revision"] == bound.revision
                )
                if (
                    existing_state is BoundaryState.CONFIRMED
                    and bound.state is BoundaryState.CANDIDATE
                    and not allow_downgrade
                ):
                    if same_evidence:
                        conn.execute(
                            """
                            UPDATE history_series_boundaries
                            SET evidence_count = evidence_count + ?, last_seen_at_ms = ?
                            WHERE exchange = ? AND market_type = ? AND symbol = ?
                              AND channel = ? AND variant = ? AND params_hash = ? AND side = ?
                            """,
                            (increment, observed_at, *self._key_values(key), side.value),
                        )
                        conn.commit()
                        record = self.get(key, side, include_stale=True)
                        assert record is not None
                        return record
                    raise ValueError("candidate boundary cannot replace a confirmed boundary")
                evidence_count = (
                    int(existing["evidence_count"]) + increment
                    if same_evidence
                    else increment
                )
                first_seen_at = (
                    int(existing["first_seen_at_ms"]) if same_evidence else observed_at
                )
                conn.execute(
                    """
                    UPDATE history_series_boundaries
                    SET value_ms = ?, state = ?, reason = ?, retryable = ?,
                        revision = ?, revalidate_at_ms = ?, evidence_count = ?,
                        first_seen_at_ms = ?, last_seen_at_ms = ?, metadata_json = ?
                    WHERE exchange = ? AND market_type = ? AND symbol = ?
                      AND channel = ? AND variant = ? AND params_hash = ? AND side = ?
                    """,
                    (
                        bound.value_ms,
                        bound.state.value,
                        bound.reason.value,
                        int(bound.retryable),
                        bound.revision,
                        bound.revalidate_at_ms,
                        evidence_count,
                        first_seen_at,
                        observed_at,
                        json.dumps(dict(bound.metadata), sort_keys=True, default=str),
                        *self._key_values(key),
                        side.value,
                    ),
                )
            else:
                conn.execute(
                    """
                    INSERT INTO history_series_boundaries (
                        exchange, market_type, symbol, channel, variant, params_hash,
                        side, value_ms, state, reason, retryable, revision,
                        revalidate_at_ms, evidence_count, first_seen_at_ms,
                        last_seen_at_ms, metadata_json
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        *self._key_values(key),
                        side.value,
                        bound.value_ms,
                        bound.state.value,
                        bound.reason.value,
                        int(bound.retryable),
                        bound.revision,
                        bound.revalidate_at_ms,
                        increment,
                        observed_at,
                        observed_at,
                        json.dumps(dict(bound.metadata), sort_keys=True, default=str),
                    ),
                )
            conn.commit()
        record = self.get(key, side, include_stale=True)
        assert record is not None
        return record

    def get(
        self,
        key: HistorySeriesKey,
        side: BoundarySide | str,
        *,
        now_ms: int | None = None,
        revision: str | None = None,
        include_stale: bool = False,
    ) -> StoredHistoryBoundary | None:
        side = BoundarySide(side)
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT * FROM history_series_boundaries
                WHERE exchange = ? AND market_type = ? AND symbol = ?
                  AND channel = ? AND variant = ? AND params_hash = ? AND side = ?
                """,
                (*self._key_values(key), side.value),
            ).fetchone()
        if row is None:
            return None
        record = self._row_to_record(row)
        if not include_stale and not record.bound.is_active(
            now_ms=now_ms,
            revision=revision,
        ):
            return None
        return record

    def list_for_series(
        self,
        key: HistorySeriesKey,
        *,
        now_ms: int | None = None,
        revision: str | None = None,
        include_stale: bool = False,
    ) -> tuple[StoredHistoryBoundary, ...]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM history_series_boundaries
                WHERE exchange = ? AND market_type = ? AND symbol = ?
                  AND channel = ? AND variant = ? AND params_hash = ?
                ORDER BY side
                """,
                self._key_values(key),
            ).fetchall()
        records = tuple(self._row_to_record(row) for row in rows)
        if include_stale:
            return records
        return tuple(
            record
            for record in records
            if record.bound.is_active(now_ms=now_ms, revision=revision)
        )

    def confirm(
        self,
        key: HistorySeriesKey,
        side: BoundarySide | str,
        *,
        observed_at_ms: int | None = None,
    ) -> StoredHistoryBoundary | None:
        record = self.get(key, side, include_stale=True)
        if record is None:
            return None
        if record.bound.state is BoundaryState.CONFIRMED:
            return record
        return self.upsert(
            key,
            side,
            replace(record.bound, state=BoundaryState.CONFIRMED),
            observed_at_ms=observed_at_ms,
        )

    def delete(
        self,
        key: HistorySeriesKey,
        side: BoundarySide | str | None = None,
    ) -> int:
        params: tuple[Any, ...] = self._key_values(key)
        side_clause = ""
        if side is not None:
            side_clause = " AND side = ?"
            params = (*params, BoundarySide(side).value)
        with self._connect() as conn:
            cursor = conn.execute(
                f"""
                DELETE FROM history_series_boundaries
                WHERE exchange = ? AND market_type = ? AND symbol = ?
                  AND channel = ? AND variant = ? AND params_hash = ?{side_clause}
                """,
                params,
            )
            conn.commit()
            return int(cursor.rowcount)

    def delete_stale(self, *, now_ms: int | None = None) -> int:
        current_ms = _now_ms() if now_ms is None else int(now_ms)
        with self._connect() as conn:
            cursor = conn.execute(
                """
                DELETE FROM history_series_boundaries
                WHERE revalidate_at_ms IS NOT NULL AND revalidate_at_ms <= ?
                """,
                (current_ms,),
            )
            conn.commit()
            return int(cursor.rowcount)

    def load_availability(
        self,
        key: HistorySeriesKey,
        availability: HistoryAvailability | None = None,
        *,
        now_ms: int | None = None,
        revision: str | None = None,
    ) -> HistoryAvailability:
        """Overlay confirmed, non-retryable learned bounds onto capabilities."""
        base = availability or HistoryAvailability(revision=revision or "")
        requested_revision = revision if revision is not None else (base.revision or None)
        left = self.get(
            key,
            BoundarySide.LEFT,
            now_ms=now_ms,
            revision=requested_revision,
        )
        right = self.get(
            key,
            BoundarySide.RIGHT,
            now_ms=now_ms,
            revision=requested_revision,
        )
        left_bound = self._usable_bound(left)
        right_bound = self._usable_bound(right)
        upstream_start = self._stricter_lower(base.upstream_start, left_bound)
        upstream_end = self._stricter_upper(base.upstream_end, right_bound)
        return replace(
            base,
            upstream_start=upstream_start,
            upstream_end=upstream_end,
        )

    @staticmethod
    def _usable_bound(record: StoredHistoryBoundary | None) -> TimeBound | None:
        if record is None or not record.bound.confirmed or record.bound.retryable:
            return None
        return record.bound

    @staticmethod
    def _stricter_lower(first: TimeBound | None, second: TimeBound | None) -> TimeBound | None:
        if first is None:
            return second
        if second is None:
            return first
        return max((first, second), key=lambda item: item.value_ms)

    @staticmethod
    def _stricter_upper(first: TimeBound | None, second: TimeBound | None) -> TimeBound | None:
        if first is None:
            return second
        if second is None:
            return first
        return min((first, second), key=lambda item: item.value_ms)

    @staticmethod
    def _row_to_record(row: sqlite3.Row) -> StoredHistoryBoundary:
        metadata: dict[str, Any] = {}
        if row["metadata_json"]:
            try:
                decoded = json.loads(row["metadata_json"])
                if isinstance(decoded, dict):
                    metadata = decoded
            except (TypeError, ValueError, json.JSONDecodeError):
                metadata = {}
        key = HistorySeriesKey(
            exchange=row["exchange"],
            market_type=row["market_type"],
            symbol=row["symbol"],
            channel=row["channel"],
            variant=row["variant"],
            params_hash=row["params_hash"],
        )
        bound = TimeBound(
            value_ms=int(row["value_ms"]),
            reason=BoundaryReason(row["reason"]),
            state=BoundaryState(row["state"]),
            retryable=bool(row["retryable"]),
            revision=row["revision"],
            revalidate_at_ms=row["revalidate_at_ms"],
            metadata=metadata,
        )
        return StoredHistoryBoundary(
            key=key,
            side=BoundarySide(row["side"]),
            bound=bound,
            evidence_count=int(row["evidence_count"]),
            first_seen_at_ms=int(row["first_seen_at_ms"]),
            last_seen_at_ms=int(row["last_seen_at_ms"]),
        )
