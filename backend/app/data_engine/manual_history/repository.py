"""SQLite repository for manual-history collections, jobs, and protections.

Tables live in the same KLINES_DB_PATH as ``klines``.  All writers use
parameterized SQL and compare-and-set transitions; a failed create
transaction must not leave orphan collection/job/protection rows.
"""

from __future__ import annotations

import sqlite3
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

from app.core.config import KLINES_DB_PATH
from app.data_engine.data_manager.models import SeriesKey
from app.data_engine.storage.sqlite_runtime import SQLiteConnectionPolicy, open_sqlite

from .models import (
    ALLOWED_JOB_TARGET_TRANSITIONS,
    ALLOWED_JOB_TRANSITIONS,
    RECOVERABLE_JOB_STATES,
    CollectionStatus,
    JobState,
    JobTargetState,
    ManualHistoryCollectionRecord,
    ManualHistoryCollectionTargetRecord,
    ManualHistoryCreateResult,
    ManualHistoryCreateSpec,
    ManualHistoryIdempotencyConflict,
    ManualHistoryIllegalTransition,
    ManualHistoryJobRecord,
    ManualHistoryJobTargetRecord,
    ManualHistoryNotFound,
    ManualHistoryProtectionRecord,
    ProtectionKind,
    ProtectionOwnerKind,
    ProtectionState,
    RouteKind,
    StorageProtectionFloor,
    TargetStatus,
    parse_enum,
)

MANUAL_HISTORY_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS manual_history_collections (
    collection_id TEXT PRIMARY KEY,
    exchange TEXT NOT NULL,
    market_type TEXT NOT NULL,
    requested_start_ms INTEGER NOT NULL CHECK (requested_start_ms >= 0),
    status TEXT NOT NULL CHECK (
        status IN ('BUILDING', 'ACTIVE', 'PARTIAL', 'RELEASED')
    ),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    released_at_ms INTEGER,
    revision INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS manual_history_collection_targets (
    collection_id TEXT NOT NULL,
    exchange TEXT NOT NULL,
    market_type TEXT NOT NULL,
    symbol TEXT NOT NULL,
    requested_interval TEXT NOT NULL,
    canonical_interval TEXT NOT NULL,
    route_kind TEXT NOT NULL CHECK (route_kind IN ('NATIVE', 'DERIVED')),
    source_interval TEXT NOT NULL,
    effective_start_ms INTEGER NOT NULL,
    continuous_end_ms INTEGER,
    status TEXT NOT NULL CHECK (
        status IN ('PENDING', 'BUILDING', 'READY', 'FAILED', 'RELEASED')
    ),
    expected_rows INTEGER,
    verified_rows INTEGER,
    verified_at_ms INTEGER,
    boundary_reason TEXT,
    last_error TEXT,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (collection_id, symbol, canonical_interval),
    FOREIGN KEY (collection_id)
        REFERENCES manual_history_collections(collection_id)
        ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS manual_history_jobs (
    job_id TEXT PRIMARY KEY,
    collection_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    request_hash TEXT NOT NULL,
    plan_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK (
        state IN (
            'QUEUED', 'RUNNING', 'SEALING', 'SUCCEEDED', 'PARTIAL',
            'FAILED', 'BLOCKED_STORAGE', 'CANCELLING', 'CANCELLED'
        )
    ),
    stage TEXT NOT NULL,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    total_targets INTEGER NOT NULL,
    ready_targets INTEGER NOT NULL DEFAULT 0,
    failed_targets INTEGER NOT NULL DEFAULT 0,
    estimated_db_bytes INTEGER,
    estimated_temp_bytes INTEGER,
    reserved_bytes INTEGER,
    recovery_count INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL,
    started_at_ms INTEGER,
    finished_at_ms INTEGER,
    updated_at_ms INTEGER NOT NULL,
    last_error TEXT,
    FOREIGN KEY (collection_id)
        REFERENCES manual_history_collections(collection_id)
        ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS manual_history_job_targets (
    job_id TEXT NOT NULL,
    collection_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    canonical_interval TEXT NOT NULL,
    source_interval TEXT NOT NULL,
    state TEXT NOT NULL CHECK (
        state IN (
            'QUEUED', 'FETCHING', 'MATERIALIZING', 'VERIFYING',
            'READY', 'FAILED', 'BLOCKED_STORAGE', 'CANCELLED'
        )
    ),
    initial_end_open_ms INTEGER NOT NULL,
    sealed_end_open_ms INTEGER,
    backfill_request_id TEXT,
    attempt INTEGER NOT NULL DEFAULT 0,
    estimated_rows INTEGER,
    written_rows INTEGER NOT NULL DEFAULT 0,
    verified_rows INTEGER,
    last_error TEXT,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (job_id, symbol, canonical_interval),
    FOREIGN KEY (job_id) REFERENCES manual_history_jobs(job_id) ON DELETE RESTRICT,
    FOREIGN KEY (collection_id, symbol, canonical_interval)
        REFERENCES manual_history_collection_targets(
            collection_id, symbol, canonical_interval
        ) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS manual_history_protections (
    protection_id TEXT PRIMARY KEY,
    owner_kind TEXT NOT NULL CHECK (owner_kind IN ('JOB', 'COLLECTION')),
    owner_id TEXT NOT NULL,
    protection_kind TEXT NOT NULL CHECK (
        protection_kind IN ('TRANSIENT', 'DURABLE')
    ),
    exchange TEXT NOT NULL,
    market_type TEXT NOT NULL,
    symbol TEXT NOT NULL,
    interval TEXT NOT NULL,
    protected_start_ms INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('ACTIVE', 'RELEASED')),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    released_at_ms INTEGER,
    UNIQUE (owner_kind, owner_id, exchange, market_type, symbol, interval)
);

CREATE INDEX IF NOT EXISTS idx_manual_history_jobs_state
ON manual_history_jobs(state, updated_at_ms);

CREATE INDEX IF NOT EXISTS idx_manual_history_targets_series
ON manual_history_collection_targets(
    exchange, market_type, symbol, canonical_interval, status
);

CREATE INDEX IF NOT EXISTS idx_manual_history_active_protection
ON manual_history_protections(
    state, exchange, market_type, symbol, interval, protected_start_ms
);
"""

_SEALABLE_JOB_TARGET_STATES = frozenset({
    JobTargetState.QUEUED,
    JobTargetState.FETCHING,
    JobTargetState.MATERIALIZING,
    JobTargetState.VERIFYING,
})


def init_manual_history_storage(connection: sqlite3.Connection | None = None) -> None:
    """Create manual-history tables in the current K-lines database.

    Safe to call repeatedly.  When *connection* is omitted a short-lived
    connection is opened against ``KLINES_DB_PATH``.
    """

    owns_connection = connection is None
    conn = connection
    if conn is None:
        path = Path(KLINES_DB_PATH)
        path.parent.mkdir(parents=True, exist_ok=True)
        conn = _open(path)
    try:
        conn.execute("PRAGMA foreign_keys=ON")
        conn.executescript(MANUAL_HISTORY_SCHEMA_SQL)
        if owns_connection:
            conn.commit()
    finally:
        if owns_connection:
            conn.close()


def _open(db_path: Path) -> sqlite3.Connection:
    connection = open_sqlite(
        db_path,
        policy=SQLiteConnectionPolicy(
            timeout_seconds=30.0,
            busy_timeout_ms=30_000,
            use_row_factory=True,
            configure_journal_mode=True,
        ),
    )
    connection.execute("PRAGMA foreign_keys=ON")
    return connection


def _optional_int(value: Any) -> int | None:
    if value is None:
        return None
    return int(value)


def _optional_str(value: Any) -> str | None:
    if value is None:
        return None
    return str(value)


class ManualHistoryRepository:
    """Durable source of truth for collections, jobs, and protections."""

    def __init__(
        self,
        db_path: Path | str | None = None,
        *,
        clock: Callable[[], int] | None = None,
    ) -> None:
        self._db_path = Path(db_path or KLINES_DB_PATH)
        self._clock = clock or (lambda: int(time.time() * 1000))

    def _connect(self) -> sqlite3.Connection:
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        return _open(self._db_path)

    def init_storage(self) -> None:
        with self._connect() as conn:
            init_manual_history_storage(conn)
            conn.commit()

    def create_collection_and_job(
        self,
        spec: ManualHistoryCreateSpec,
    ) -> ManualHistoryCreateResult:
        if not spec.targets:
            raise ValueError("manual history create requires at least one target")
        if spec.requested_start_ms < 0:
            raise ValueError("requested_start_ms must be >= 0")

        now_ms = self._clock()
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                existing = conn.execute(
                    "SELECT * FROM manual_history_jobs WHERE idempotency_key = ?",
                    (spec.idempotency_key,),
                ).fetchone()
                if existing is not None:
                    if str(existing["request_hash"]) != spec.request_hash:
                        raise ManualHistoryIdempotencyConflict(
                            idempotency_key=spec.idempotency_key,
                            existing_job_id=str(existing["job_id"]),
                        )
                    conn.commit()
                    return self._load_create_result(
                        conn,
                        job_id=str(existing["job_id"]),
                        reused_existing=True,
                    )

                conn.execute(
                    """
                    INSERT INTO manual_history_collections (
                        collection_id, exchange, market_type, requested_start_ms,
                        status, created_at_ms, updated_at_ms, released_at_ms, revision
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0)
                    """,
                    (
                        spec.collection_id,
                        spec.exchange,
                        spec.market_type,
                        int(spec.requested_start_ms),
                        CollectionStatus.BUILDING.value,
                        now_ms,
                        now_ms,
                    ),
                )
                for target in spec.targets:
                    conn.execute(
                        """
                        INSERT INTO manual_history_collection_targets (
                            collection_id, exchange, market_type, symbol,
                            requested_interval, canonical_interval, route_kind,
                            source_interval, effective_start_ms, continuous_end_ms,
                            status, expected_rows, verified_rows, verified_at_ms,
                            boundary_reason, last_error, updated_at_ms
                        ) VALUES (
                            ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, ?, NULL, ?
                        )
                        """,
                        (
                            spec.collection_id,
                            spec.exchange,
                            spec.market_type,
                            target.symbol,
                            target.requested_interval,
                            target.canonical_interval,
                            target.route_kind.value,
                            target.source_interval,
                            int(target.effective_start_ms),
                            TargetStatus.PENDING.value,
                            target.expected_rows,
                            target.boundary_reason,
                            now_ms,
                        ),
                    )
                conn.execute(
                    """
                    INSERT INTO manual_history_jobs (
                        job_id, collection_id, idempotency_key, request_hash,
                        plan_hash, state, stage, cancel_requested, total_targets,
                        ready_targets, failed_targets, estimated_db_bytes,
                        estimated_temp_bytes, reserved_bytes, recovery_count,
                        revision, created_at_ms, started_at_ms, finished_at_ms,
                        updated_at_ms, last_error
                    ) VALUES (
                        ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, 0, ?, ?, ?, 0, 0,
                        ?, NULL, NULL, ?, NULL
                    )
                    """,
                    (
                        spec.job_id,
                        spec.collection_id,
                        spec.idempotency_key,
                        spec.request_hash,
                        spec.plan_hash,
                        JobState.QUEUED.value,
                        spec.stage,
                        len(spec.targets),
                        spec.estimated_db_bytes,
                        spec.estimated_temp_bytes,
                        spec.reserved_bytes,
                        now_ms,
                        now_ms,
                    ),
                )
                for target in spec.targets:
                    conn.execute(
                        """
                        INSERT INTO manual_history_job_targets (
                            job_id, collection_id, symbol, canonical_interval,
                            source_interval, state, initial_end_open_ms,
                            sealed_end_open_ms, backfill_request_id, attempt,
                            estimated_rows, written_rows, verified_rows,
                            last_error, updated_at_ms
                        ) VALUES (
                            ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, 0, NULL, NULL, ?
                        )
                        """,
                        (
                            spec.job_id,
                            spec.collection_id,
                            target.symbol,
                            target.canonical_interval,
                            target.source_interval,
                            JobTargetState.QUEUED.value,
                            int(target.initial_end_open_ms),
                            target.estimated_rows,
                            now_ms,
                        ),
                    )
                    self._insert_protection(
                        conn,
                        owner_kind=ProtectionOwnerKind.JOB,
                        owner_id=spec.job_id,
                        protection_kind=ProtectionKind.TRANSIENT,
                        exchange=spec.exchange,
                        market_type=spec.market_type,
                        symbol=target.symbol,
                        interval=target.canonical_interval,
                        protected_start_ms=int(target.effective_start_ms),
                        now_ms=now_ms,
                    )
                    if (
                        target.route_kind is RouteKind.DERIVED
                        and target.source_interval != target.canonical_interval
                    ):
                        self._insert_protection(
                            conn,
                            owner_kind=ProtectionOwnerKind.JOB,
                            owner_id=spec.job_id,
                            protection_kind=ProtectionKind.TRANSIENT,
                            exchange=spec.exchange,
                            market_type=spec.market_type,
                            symbol=target.symbol,
                            interval=target.source_interval,
                            protected_start_ms=int(target.effective_start_ms),
                            now_ms=now_ms,
                        )
                for extra in spec.extra_source_protections:
                    self._insert_protection(
                        conn,
                        owner_kind=ProtectionOwnerKind.JOB,
                        owner_id=spec.job_id,
                        protection_kind=ProtectionKind.TRANSIENT,
                        exchange=spec.exchange,
                        market_type=spec.market_type,
                        symbol=extra.symbol,
                        interval=extra.interval,
                        protected_start_ms=int(extra.protected_start_ms),
                        now_ms=now_ms,
                    )
                conn.commit()
            except Exception:
                conn.rollback()
                raise
            return self._load_create_result(
                conn,
                job_id=spec.job_id,
                reused_existing=False,
            )

    def get_job_by_idempotency_key(
        self,
        idempotency_key: str,
    ) -> ManualHistoryJobRecord | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM manual_history_jobs WHERE idempotency_key = ?",
                (idempotency_key,),
            ).fetchone()
        return None if row is None else self._job_from_row(row)

    def get_job(self, job_id: str) -> ManualHistoryJobRecord:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM manual_history_jobs WHERE job_id = ?",
                (job_id,),
            ).fetchone()
        if row is None:
            raise ManualHistoryNotFound(f"job not found: {job_id}")
        return self._job_from_row(row)

    def get_collection(self, collection_id: str) -> ManualHistoryCollectionRecord:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM manual_history_collections WHERE collection_id = ?",
                (collection_id,),
            ).fetchone()
        if row is None:
            raise ManualHistoryNotFound(f"collection not found: {collection_id}")
        return self._collection_from_row(row)

    def list_job_targets(self, job_id: str) -> tuple[ManualHistoryJobTargetRecord, ...]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM manual_history_job_targets
                WHERE job_id = ?
                ORDER BY symbol, canonical_interval
                """,
                (job_id,),
            ).fetchall()
        return tuple(self._job_target_from_row(row) for row in rows)

    def list_collection_targets(
        self,
        collection_id: str,
    ) -> tuple[ManualHistoryCollectionTargetRecord, ...]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM manual_history_collection_targets
                WHERE collection_id = ?
                ORDER BY symbol, canonical_interval
                """,
                (collection_id,),
            ).fetchall()
        return tuple(self._collection_target_from_row(row) for row in rows)

    def list_protections(
        self,
        *,
        state: ProtectionState | None = None,
    ) -> tuple[ManualHistoryProtectionRecord, ...]:
        sql = "SELECT * FROM manual_history_protections"
        params: tuple[object, ...] = ()
        if state is not None:
            sql += " WHERE state = ?"
            params = (state.value,)
        sql += " ORDER BY exchange, market_type, symbol, interval, owner_kind, owner_id"
        with self._connect() as conn:
            rows = conn.execute(sql, params).fetchall()
        return tuple(self._protection_from_row(row) for row in rows)

    def cas_job_state(
        self,
        job_id: str,
        *,
        from_state: JobState,
        to_state: JobState,
        stage: str | None = None,
        last_error: str | None = None,
        expected_revision: int | None = None,
    ) -> ManualHistoryJobRecord:
        allowed = ALLOWED_JOB_TRANSITIONS.get(from_state, frozenset())
        if to_state not in allowed:
            raise ManualHistoryIllegalTransition(
                entity="job",
                current=from_state.value,
                requested=to_state.value,
            )
        now_ms = self._clock()
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                row = conn.execute(
                    "SELECT state, revision FROM manual_history_jobs WHERE job_id = ?",
                    (job_id,),
                ).fetchone()
                if row is None:
                    raise ManualHistoryNotFound(f"job not found: {job_id}")
                current = str(row["state"])
                if current != from_state.value:
                    raise ManualHistoryIllegalTransition(
                        entity="job",
                        current=current,
                        expected=from_state.value,
                        requested=to_state.value,
                    )
                if (
                    expected_revision is not None
                    and int(row["revision"]) != int(expected_revision)
                ):
                    raise ManualHistoryIllegalTransition(
                        entity="job-revision",
                        current=str(row["revision"]),
                        expected=str(expected_revision),
                        requested=to_state.value,
                    )
                started_value: object = None
                finished_value: object = None
                if to_state is JobState.RUNNING and from_state is JobState.QUEUED:
                    started_sql = "?"
                    started_value = now_ms
                terminal = {
                    JobState.SUCCEEDED,
                    JobState.PARTIAL,
                    JobState.FAILED,
                    JobState.CANCELLED,
                }
                if to_state in terminal:
                    finished_sql = "?"
                    finished_value = now_ms
                cancel_requested = 1 if to_state is JobState.CANCELLING else None
                assignments = [
                    "state = ?",
                    "revision = revision + 1",
                    "updated_at_ms = ?",
                    "last_error = ?",
                ]
                params: list[object] = [to_state.value, now_ms, last_error]
                if stage is not None:
                    assignments.append("stage = ?")
                    params.append(stage)
                if started_value is not None:
                    assignments.append("started_at_ms = ?")
                    params.append(started_value)
                if finished_value is not None:
                    assignments.append("finished_at_ms = ?")
                    params.append(finished_value)
                if cancel_requested is not None:
                    assignments.append("cancel_requested = ?")
                    params.append(cancel_requested)
                params.append(job_id)
                conn.execute(
                    f"UPDATE manual_history_jobs SET {', '.join(assignments)} "
                    "WHERE job_id = ?",
                    params,
                )
                conn.commit()
            except Exception:
                conn.rollback()
                raise
        return self.get_job(job_id)

    def cas_job_target_state(
        self,
        job_id: str,
        symbol: str,
        canonical_interval: str,
        *,
        from_state: JobTargetState,
        to_state: JobTargetState,
        last_error: str | None = None,
    ) -> ManualHistoryJobTargetRecord:
        allowed = ALLOWED_JOB_TARGET_TRANSITIONS.get(from_state, frozenset())
        if to_state not in allowed:
            raise ManualHistoryIllegalTransition(
                entity="job-target",
                current=from_state.value,
                requested=to_state.value,
            )
        now_ms = self._clock()
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                row = conn.execute(
                    """
                    SELECT state FROM manual_history_job_targets
                    WHERE job_id = ? AND symbol = ? AND canonical_interval = ?
                    """,
                    (job_id, symbol, canonical_interval),
                ).fetchone()
                if row is None:
                    raise ManualHistoryNotFound(
                        f"job target not found: {job_id} {symbol} {canonical_interval}"
                    )
                current = str(row["state"])
                if current != from_state.value:
                    raise ManualHistoryIllegalTransition(
                        entity="job-target",
                        current=current,
                        expected=from_state.value,
                        requested=to_state.value,
                    )
                conn.execute(
                    """
                    UPDATE manual_history_job_targets
                    SET state = ?, last_error = ?, updated_at_ms = ?,
                        attempt = attempt + 1
                    WHERE job_id = ? AND symbol = ? AND canonical_interval = ?
                    """,
                    (
                        to_state.value,
                        last_error,
                        now_ms,
                        job_id,
                        symbol,
                        canonical_interval,
                    ),
                )
                if to_state is JobTargetState.FAILED:
                    conn.execute(
                        """
                        UPDATE manual_history_jobs
                        SET failed_targets = failed_targets + 1,
                            revision = revision + 1,
                            updated_at_ms = ?
                        WHERE job_id = ?
                        """,
                        (now_ms, job_id),
                    )
                    conn.execute(
                        """
                        UPDATE manual_history_collection_targets
                        SET status = ?, last_error = ?, updated_at_ms = ?
                        WHERE collection_id = (
                            SELECT collection_id FROM manual_history_jobs
                            WHERE job_id = ?
                        ) AND symbol = ? AND canonical_interval = ?
                        """,
                        (
                            TargetStatus.FAILED.value,
                            last_error,
                            now_ms,
                            job_id,
                            symbol,
                            canonical_interval,
                        ),
                    )
                conn.commit()
            except Exception:
                conn.rollback()
                raise
        targets = [
            target
            for target in self.list_job_targets(job_id)
            if target.symbol == symbol and target.canonical_interval == canonical_interval
        ]
        return targets[0]

    def active_protection_snapshot(self) -> tuple[StorageProtectionFloor, ...]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT
                    exchange, market_type, symbol, interval,
                    MIN(protected_start_ms) AS protected_start_ms,
                    COUNT(*) AS owner_count,
                    SUM(CASE WHEN protection_kind = 'TRANSIENT' THEN 1 ELSE 0 END)
                        AS transient_owner_count,
                    SUM(CASE WHEN protection_kind = 'DURABLE' THEN 1 ELSE 0 END)
                        AS durable_owner_count,
                    GROUP_CONCAT(owner_kind || ':' || owner_id, ',') AS owner_ids
                FROM manual_history_protections
                WHERE state = 'ACTIVE'
                GROUP BY exchange, market_type, symbol, interval
                ORDER BY exchange, market_type, symbol, interval
                """
            ).fetchall()
        floors: list[StorageProtectionFloor] = []
        for row in rows:
            owner_ids = tuple(
                part
                for part in str(row["owner_ids"] or "").split(",")
                if part
            )
            floors.append(
                StorageProtectionFloor(
                    key=SeriesKey(
                        symbol=str(row["symbol"]),
                        interval=str(row["interval"]),
                        exchange=str(row["exchange"]),
                        market_type=str(row["market_type"]),
                    ),
                    protected_start_ms=int(row["protected_start_ms"]),
                    owner_count=int(row["owner_count"]),
                    transient_owner_count=int(row["transient_owner_count"] or 0),
                    durable_owner_count=int(row["durable_owner_count"] or 0),
                    owner_ids=owner_ids,
                )
            )
        return tuple(floors)

    def seal_target(
        self,
        job_id: str,
        symbol: str,
        canonical_interval: str,
        *,
        sealed_end_open_ms: int,
        verified_rows: int,
    ) -> ManualHistoryCreateResult:
        """Upgrade one verified target to READY + durable protection.

        Transient job protection for this series is released in the same
        transaction after the durable collection protection is inserted.
        """

        now_ms = self._clock()
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                job_row = conn.execute(
                    "SELECT * FROM manual_history_jobs WHERE job_id = ?",
                    (job_id,),
                ).fetchone()
                if job_row is None:
                    raise ManualHistoryNotFound(f"job not found: {job_id}")
                collection_id = str(job_row["collection_id"])
                target_row = conn.execute(
                    """
                    SELECT * FROM manual_history_job_targets
                    WHERE job_id = ? AND symbol = ? AND canonical_interval = ?
                    """,
                    (job_id, symbol, canonical_interval),
                ).fetchone()
                if target_row is None:
                    raise ManualHistoryNotFound(
                        f"job target not found: {job_id} {symbol} {canonical_interval}"
                    )
                current = parse_enum(
                    JobTargetState, target_row["state"], field_name="job_target.state"
                )
                if current is JobTargetState.READY:
                    conn.commit()
                    return self._load_create_result(
                        conn, job_id=job_id, reused_existing=False
                    )
                if current not in _SEALABLE_JOB_TARGET_STATES:
                    raise ManualHistoryIllegalTransition(
                        entity="job-target-seal",
                        current=current.value,
                        requested=JobTargetState.READY.value,
                    )
                collection_target = conn.execute(
                    """
                    SELECT * FROM manual_history_collection_targets
                    WHERE collection_id = ? AND symbol = ? AND canonical_interval = ?
                    """,
                    (collection_id, symbol, canonical_interval),
                ).fetchone()
                if collection_target is None:
                    raise ManualHistoryNotFound(
                        f"collection target not found: {collection_id} {symbol} {canonical_interval}"
                    )
                conn.execute(
                    """
                    UPDATE manual_history_job_targets
                    SET state = ?, sealed_end_open_ms = ?, verified_rows = ?,
                        last_error = NULL, updated_at_ms = ?
                    WHERE job_id = ? AND symbol = ? AND canonical_interval = ?
                    """,
                    (
                        JobTargetState.READY.value,
                        int(sealed_end_open_ms),
                        int(verified_rows),
                        now_ms,
                        job_id,
                        symbol,
                        canonical_interval,
                    ),
                )
                conn.execute(
                    """
                    UPDATE manual_history_collection_targets
                    SET status = ?, continuous_end_ms = ?, verified_rows = ?,
                        verified_at_ms = ?, last_error = NULL, updated_at_ms = ?
                    WHERE collection_id = ? AND symbol = ? AND canonical_interval = ?
                    """,
                    (
                        TargetStatus.READY.value,
                        int(sealed_end_open_ms),
                        int(verified_rows),
                        now_ms,
                        now_ms,
                        collection_id,
                        symbol,
                        canonical_interval,
                    ),
                )
                self._insert_protection(
                    conn,
                    owner_kind=ProtectionOwnerKind.COLLECTION,
                    owner_id=collection_id,
                    protection_kind=ProtectionKind.DURABLE,
                    exchange=str(collection_target["exchange"]),
                    market_type=str(collection_target["market_type"]),
                    symbol=symbol,
                    interval=canonical_interval,
                    protected_start_ms=int(collection_target["effective_start_ms"]),
                    now_ms=now_ms,
                )
                conn.execute(
                    """
                    UPDATE manual_history_protections
                    SET state = ?, released_at_ms = ?, updated_at_ms = ?
                    WHERE owner_kind = ? AND owner_id = ?
                      AND exchange = ? AND market_type = ?
                      AND symbol = ? AND interval = ?
                      AND protection_kind = ? AND state = ?
                    """,
                    (
                        ProtectionState.RELEASED.value,
                        now_ms,
                        now_ms,
                        ProtectionOwnerKind.JOB.value,
                        job_id,
                        str(collection_target["exchange"]),
                        str(collection_target["market_type"]),
                        symbol,
                        canonical_interval,
                        ProtectionKind.TRANSIENT.value,
                        ProtectionState.ACTIVE.value,
                    ),
                )
                conn.execute(
                    """
                    UPDATE manual_history_jobs
                    SET ready_targets = ready_targets + 1,
                        revision = revision + 1,
                        updated_at_ms = ?
                    WHERE job_id = ?
                    """,
                    (now_ms, job_id),
                )
                conn.execute(
                    """
                    UPDATE manual_history_collections
                    SET revision = revision + 1, updated_at_ms = ?
                    WHERE collection_id = ?
                    """,
                    (now_ms, collection_id),
                )
                conn.commit()
            except Exception:
                conn.rollback()
                raise
            return self._load_create_result(conn, job_id=job_id, reused_existing=False)

    def release_collection(self, collection_id: str) -> ManualHistoryCollectionRecord:
        now_ms = self._clock()
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                row = conn.execute(
                    "SELECT status FROM manual_history_collections WHERE collection_id = ?",
                    (collection_id,),
                ).fetchone()
                if row is None:
                    raise ManualHistoryNotFound(f"collection not found: {collection_id}")
                conn.execute(
                    """
                    UPDATE manual_history_collections
                    SET status = ?, released_at_ms = ?, updated_at_ms = ?,
                        revision = revision + 1
                    WHERE collection_id = ?
                    """,
                    (
                        CollectionStatus.RELEASED.value,
                        now_ms,
                        now_ms,
                        collection_id,
                    ),
                )
                conn.execute(
                    """
                    UPDATE manual_history_collection_targets
                    SET status = ?, updated_at_ms = ?
                    WHERE collection_id = ?
                    """,
                    (TargetStatus.RELEASED.value, now_ms, collection_id),
                )
                conn.execute(
                    """
                    UPDATE manual_history_protections
                    SET state = ?, released_at_ms = ?, updated_at_ms = ?
                    WHERE owner_kind = ? AND owner_id = ? AND state = ?
                    """,
                    (
                        ProtectionState.RELEASED.value,
                        now_ms,
                        now_ms,
                        ProtectionOwnerKind.COLLECTION.value,
                        collection_id,
                        ProtectionState.ACTIVE.value,
                    ),
                )
                conn.commit()
            except Exception:
                conn.rollback()
                raise
        return self.get_collection(collection_id)

    def increment_recovery_count(self, job_id: str) -> ManualHistoryJobRecord:
        now_ms = self._clock()
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE manual_history_jobs
                SET recovery_count = recovery_count + 1,
                    revision = revision + 1,
                    updated_at_ms = ?
                WHERE job_id = ?
                """,
                (now_ms, job_id),
            )
            conn.commit()
        return self.get_job(job_id)

    def list_jobs(self, *, limit: int = 50) -> tuple[ManualHistoryJobRecord, ...]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM manual_history_jobs
                ORDER BY created_at_ms DESC, job_id DESC
                LIMIT ?
                """,
                (max(1, min(int(limit), 200)),),
            ).fetchall()
        return tuple(self._job_from_row(row) for row in rows)

    def list_collections(self, *, limit: int = 50) -> tuple[ManualHistoryCollectionRecord, ...]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM manual_history_collections
                ORDER BY created_at_ms DESC, collection_id DESC
                LIMIT ?
                """,
                (max(1, min(int(limit), 200)),),
            ).fetchall()
        return tuple(self._collection_from_row(row) for row in rows)

    def list_recoverable_jobs(self) -> tuple[ManualHistoryJobRecord, ...]:
        placeholders = ",".join("?" for _ in RECOVERABLE_JOB_STATES)
        params = tuple(state.value for state in RECOVERABLE_JOB_STATES)
        with self._connect() as conn:
            rows = conn.execute(
                f"""
                SELECT * FROM manual_history_jobs
                WHERE state IN ({placeholders})
                ORDER BY created_at_ms, job_id
                """,
                params,
            ).fetchall()
        return tuple(self._job_from_row(row) for row in rows)

    def count_rows(self, table: str) -> int:
        allowed = {
            "manual_history_collections",
            "manual_history_collection_targets",
            "manual_history_jobs",
            "manual_history_job_targets",
            "manual_history_protections",
        }
        if table not in allowed:
            raise ValueError(f"unsupported table: {table}")
        with self._connect() as conn:
            row = conn.execute(f"SELECT COUNT(*) AS cnt FROM {table}").fetchone()
        return int(row["cnt"] if row is not None else 0)

    def _insert_protection(
        self,
        conn: sqlite3.Connection,
        *,
        owner_kind: ProtectionOwnerKind,
        owner_id: str,
        protection_kind: ProtectionKind,
        exchange: str,
        market_type: str,
        symbol: str,
        interval: str,
        protected_start_ms: int,
        now_ms: int,
    ) -> None:
        existing = conn.execute(
            """
            SELECT protection_id, state, protected_start_ms
            FROM manual_history_protections
            WHERE owner_kind = ? AND owner_id = ? AND exchange = ?
              AND market_type = ? AND symbol = ? AND interval = ?
            """,
            (owner_kind.value, owner_id, exchange, market_type, symbol, interval),
        ).fetchone()
        if existing is not None:
            conn.execute(
                """
                UPDATE manual_history_protections
                SET protection_kind = ?, protected_start_ms = MIN(protected_start_ms, ?),
                    state = ?, released_at_ms = NULL, updated_at_ms = ?
                WHERE protection_id = ?
                """,
                (
                    protection_kind.value,
                    int(protected_start_ms),
                    ProtectionState.ACTIVE.value,
                    now_ms,
                    str(existing["protection_id"]),
                ),
            )
            return
        conn.execute(
            """
            INSERT INTO manual_history_protections (
                protection_id, owner_kind, owner_id, protection_kind,
                exchange, market_type, symbol, interval, protected_start_ms,
                state, created_at_ms, updated_at_ms, released_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
            """,
            (
                f"prot:{uuid.uuid4()}",
                owner_kind.value,
                owner_id,
                protection_kind.value,
                exchange,
                market_type,
                symbol,
                interval,
                int(protected_start_ms),
                ProtectionState.ACTIVE.value,
                now_ms,
                now_ms,
            ),
        )

    def _load_create_result(
        self,
        conn: sqlite3.Connection,
        *,
        job_id: str,
        reused_existing: bool,
    ) -> ManualHistoryCreateResult:
        job_row = conn.execute(
            "SELECT * FROM manual_history_jobs WHERE job_id = ?",
            (job_id,),
        ).fetchone()
        if job_row is None:
            raise ManualHistoryNotFound(f"job not found: {job_id}")
        collection_id = str(job_row["collection_id"])
        collection_row = conn.execute(
            "SELECT * FROM manual_history_collections WHERE collection_id = ?",
            (collection_id,),
        ).fetchone()
        collection_targets = conn.execute(
            """
            SELECT * FROM manual_history_collection_targets
            WHERE collection_id = ?
            ORDER BY symbol, canonical_interval
            """,
            (collection_id,),
        ).fetchall()
        job_targets = conn.execute(
            """
            SELECT * FROM manual_history_job_targets
            WHERE job_id = ?
            ORDER BY symbol, canonical_interval
            """,
            (job_id,),
        ).fetchall()
        protections = conn.execute(
            """
            SELECT * FROM manual_history_protections
            WHERE (owner_kind = 'JOB' AND owner_id = ?)
               OR (owner_kind = 'COLLECTION' AND owner_id = ?)
            ORDER BY owner_kind, symbol, interval
            """,
            (job_id, collection_id),
        ).fetchall()
        assert collection_row is not None
        return ManualHistoryCreateResult(
            collection=self._collection_from_row(collection_row),
            job=self._job_from_row(job_row),
            collection_targets=tuple(
                self._collection_target_from_row(row) for row in collection_targets
            ),
            job_targets=tuple(self._job_target_from_row(row) for row in job_targets),
            protections=tuple(self._protection_from_row(row) for row in protections),
            reused_existing=reused_existing,
        )

    def _collection_from_row(self, row: sqlite3.Row) -> ManualHistoryCollectionRecord:
        return ManualHistoryCollectionRecord(
            collection_id=str(row["collection_id"]),
            exchange=str(row["exchange"]),
            market_type=str(row["market_type"]),
            requested_start_ms=int(row["requested_start_ms"]),
            status=parse_enum(
                CollectionStatus, row["status"], field_name="collection.status"
            ),
            created_at_ms=int(row["created_at_ms"]),
            updated_at_ms=int(row["updated_at_ms"]),
            released_at_ms=_optional_int(row["released_at_ms"]),
            revision=int(row["revision"]),
        )

    def _collection_target_from_row(
        self,
        row: sqlite3.Row,
    ) -> ManualHistoryCollectionTargetRecord:
        return ManualHistoryCollectionTargetRecord(
            collection_id=str(row["collection_id"]),
            exchange=str(row["exchange"]),
            market_type=str(row["market_type"]),
            symbol=str(row["symbol"]),
            requested_interval=str(row["requested_interval"]),
            canonical_interval=str(row["canonical_interval"]),
            route_kind=parse_enum(
                RouteKind, row["route_kind"], field_name="collection_target.route_kind"
            ),
            source_interval=str(row["source_interval"]),
            effective_start_ms=int(row["effective_start_ms"]),
            continuous_end_ms=_optional_int(row["continuous_end_ms"]),
            status=parse_enum(
                TargetStatus, row["status"], field_name="collection_target.status"
            ),
            expected_rows=_optional_int(row["expected_rows"]),
            verified_rows=_optional_int(row["verified_rows"]),
            verified_at_ms=_optional_int(row["verified_at_ms"]),
            boundary_reason=_optional_str(row["boundary_reason"]),
            last_error=_optional_str(row["last_error"]),
            updated_at_ms=int(row["updated_at_ms"]),
        )

    def _job_from_row(self, row: sqlite3.Row) -> ManualHistoryJobRecord:
        return ManualHistoryJobRecord(
            job_id=str(row["job_id"]),
            collection_id=str(row["collection_id"]),
            idempotency_key=str(row["idempotency_key"]),
            request_hash=str(row["request_hash"]),
            plan_hash=str(row["plan_hash"]),
            state=parse_enum(JobState, row["state"], field_name="job.state"),
            stage=str(row["stage"]),
            cancel_requested=bool(int(row["cancel_requested"])),
            total_targets=int(row["total_targets"]),
            ready_targets=int(row["ready_targets"]),
            failed_targets=int(row["failed_targets"]),
            estimated_db_bytes=_optional_int(row["estimated_db_bytes"]),
            estimated_temp_bytes=_optional_int(row["estimated_temp_bytes"]),
            reserved_bytes=_optional_int(row["reserved_bytes"]),
            recovery_count=int(row["recovery_count"]),
            revision=int(row["revision"]),
            created_at_ms=int(row["created_at_ms"]),
            started_at_ms=_optional_int(row["started_at_ms"]),
            finished_at_ms=_optional_int(row["finished_at_ms"]),
            updated_at_ms=int(row["updated_at_ms"]),
            last_error=_optional_str(row["last_error"]),
        )

    def _job_target_from_row(self, row: sqlite3.Row) -> ManualHistoryJobTargetRecord:
        return ManualHistoryJobTargetRecord(
            job_id=str(row["job_id"]),
            collection_id=str(row["collection_id"]),
            symbol=str(row["symbol"]),
            canonical_interval=str(row["canonical_interval"]),
            source_interval=str(row["source_interval"]),
            state=parse_enum(
                JobTargetState, row["state"], field_name="job_target.state"
            ),
            initial_end_open_ms=int(row["initial_end_open_ms"]),
            sealed_end_open_ms=_optional_int(row["sealed_end_open_ms"]),
            backfill_request_id=_optional_str(row["backfill_request_id"]),
            attempt=int(row["attempt"]),
            estimated_rows=_optional_int(row["estimated_rows"]),
            written_rows=int(row["written_rows"]),
            verified_rows=_optional_int(row["verified_rows"]),
            last_error=_optional_str(row["last_error"]),
            updated_at_ms=int(row["updated_at_ms"]),
        )

    def _protection_from_row(self, row: sqlite3.Row) -> ManualHistoryProtectionRecord:
        return ManualHistoryProtectionRecord(
            protection_id=str(row["protection_id"]),
            owner_kind=parse_enum(
                ProtectionOwnerKind, row["owner_kind"], field_name="protection.owner_kind"
            ),
            owner_id=str(row["owner_id"]),
            protection_kind=parse_enum(
                ProtectionKind, row["protection_kind"], field_name="protection.kind"
            ),
            exchange=str(row["exchange"]),
            market_type=str(row["market_type"]),
            symbol=str(row["symbol"]),
            interval=str(row["interval"]),
            protected_start_ms=int(row["protected_start_ms"]),
            state=parse_enum(
                ProtectionState, row["state"], field_name="protection.state"
            ),
            created_at_ms=int(row["created_at_ms"]),
            updated_at_ms=int(row["updated_at_ms"]),
            released_at_ms=_optional_int(row["released_at_ms"]),
        )
