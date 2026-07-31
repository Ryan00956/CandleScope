"""Single-writer SQLite store for replay sessions and durable actor mutations."""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import json
import os
import queue
import re
import sqlite3
import threading
import time
import uuid
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Mapping, Sequence

from ..canonical import canonical_json, canonical_sha256
from ..errors import ReplayDomainError, ReplayErrorCode
from .schema import REPLAY_SCHEMA_VERSION, migrate_replay_schema


_BUSY_MARKERS = ("database is locked", "database table is locked", "database is busy")
_WAL_AUTOCHECKPOINT_PAGES = 256
_DATASET_OBJECT_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
ExtensionWriter = Callable[[sqlite3.Connection, int], None]
SessionSummaryWriter = Callable[
    [sqlite3.Connection, str, Mapping[str, object], Mapping[str, object], int],
    None,
]
SessionMutationWriter = Callable[
    [
        sqlite3.Connection,
        str,
        Mapping[str, object],
        bool,
        Mapping[str, object] | None,
        Mapping[str, object],
        Mapping[str, object],
        int,
    ],
    None,
]
SessionReviewWriter = Callable[
    [
        sqlite3.Connection,
        str,
        Mapping[str, object],
        Mapping[str, object],
        Mapping[str, object],
        bytes | None,
        int,
    ],
    None,
]


def _blob_sha256(value: bytes) -> str:
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


def _decode_json(value: str | None) -> object | None:
    return None if value is None else json.loads(value)


class _DatasetObjectStore:
    """Content-addressed compressed replay snapshots outside SQLite."""

    def __init__(self, root: Path) -> None:
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def put(self, payload: bytes) -> str:
        object_id = _blob_sha256(payload)
        destination = self._path(object_id)
        if destination.is_file():
            if self.get(object_id) != payload:
                raise RuntimeError("replay dataset object content changed")
            return object_id
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(
            f".{destination.name}.{uuid.uuid4().hex}.tmp"
        )
        try:
            with temporary.open("xb") as handle:
                handle.write(zlib.compress(payload, level=6))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, destination)
        finally:
            temporary.unlink(missing_ok=True)
        return object_id

    def get(self, object_id: str) -> bytes:
        path = self._path(object_id)
        try:
            payload = zlib.decompress(path.read_bytes())
        except (OSError, zlib.error) as exc:
            raise RuntimeError("replay dataset object is unavailable") from exc
        if _blob_sha256(payload) != object_id:
            raise RuntimeError("replay dataset object checksum changed")
        return payload

    def collect(self, referenced: set[str]) -> dict[str, int]:
        removed = 0
        removed_bytes = 0
        for path in sorted(self.root.glob("*/*.json.zlib")):
            token = path.name.removesuffix(".json.zlib")
            if f"sha256:{token}" in referenced:
                continue
            try:
                size = path.stat().st_size
                path.unlink()
            except OSError:
                continue
            removed += 1
            removed_bytes += size
        return {"objects_removed": removed, "bytes_removed": removed_bytes}

    def _path(self, object_id: str) -> Path:
        if _DATASET_OBJECT_PATTERN.fullmatch(object_id) is None:
            raise ValueError("replay dataset object id is invalid")
        token = object_id.removeprefix("sha256:")
        candidate = (self.root / token[:2] / f"{token}.json.zlib").resolve()
        if not candidate.is_relative_to(self.root):
            raise ValueError("replay dataset object escaped its root")
        return candidate


@dataclass(frozen=True, slots=True)
class StoredCommand:
    fingerprint: str
    command: Mapping[str, object]
    accepted: bool
    result: Mapping[str, object] | None
    error_code: str | None
    error_message: str | None
    error_details: Mapping[str, object]
    cursor: Mapping[str, object]
    result_sequence: int
    result_state_hash: str
    log_offset: int


@dataclass(frozen=True, slots=True)
class StoredCheckpoint:
    checkpoint_id: int
    session_id: str
    mutation_id: int | None
    source_sequence: int
    command_log_offset: int
    event_sequence: int
    state_hash: str
    payload: bytes
    is_initial: bool
    is_latest: bool


class ReplaySQLiteStore:
    """One connection, one lock, explicit transactions, bounded busy retry."""

    def __init__(
        self,
        path: str | Path,
        *,
        busy_retry_delays: Sequence[float] = (0.0, 0.005, 0.02, 0.05),
        sleep: Callable[[float], None] = time.sleep,
        now_ms: Callable[[], int] = lambda: int(time.time() * 1_000),
        max_recent_checkpoints: int = 32,
        read_pool_size: int = 4,
        dataset_object_dir: str | Path | None = None,
    ) -> None:
        self.path = Path(path).expanduser().resolve()
        delays = tuple(float(value) for value in busy_retry_delays)
        if not delays or any(value < 0 for value in delays):
            raise ValueError(
                "busy_retry_delays must be a non-empty non-negative sequence"
            )
        if max_recent_checkpoints < 1:
            raise ValueError("max_recent_checkpoints must be positive")
        if read_pool_size < 1 or read_pool_size > 16:
            raise ValueError("read_pool_size must be between 1 and 16")
        self._busy_retry_delays = delays
        self._sleep = sleep
        self._now_ms = now_ms
        self._max_recent_checkpoints = max_recent_checkpoints
        self._thread_lock = threading.RLock()
        self._async_lock = asyncio.Lock()
        self._read_condition = threading.Condition()
        self._active_reads = 0
        self._read_pool_size = int(read_pool_size)
        self._dataset_pending_lock = threading.Lock()
        self._pending_dataset_objects: dict[str, int] = {}
        self._dataset_gc_lock = asyncio.Lock()
        self._closed = False
        self._degraded_reason: str | None = None
        self._session_summary_writer: SessionSummaryWriter | None = None
        self._session_mutation_writer: SessionMutationWriter | None = None
        self._session_review_writer: SessionReviewWriter | None = None
        self._metrics = {
            "transactions": 0,
            "transaction_failures": 0,
            "busy_retries": 0,
            "busy_exhaustions": 0,
            "checkpoints_written": 0,
            "corrupt_checkpoints_skipped": 0,
            "dataset_objects_removed": 0,
            "dataset_object_bytes_removed": 0,
            "database_compactions": 0,
            "database_compaction_failures": 0,
        }

        self.path.parent.mkdir(parents=True, exist_ok=True)
        object_root = (
            Path(dataset_object_dir).expanduser().resolve()
            if dataset_object_dir is not None
            else self.path.parent / f"{self.path.name}.datasets"
        )
        self._dataset_objects = _DatasetObjectStore(object_root)
        self._connection = sqlite3.connect(
            str(self.path),
            timeout=0,
            check_same_thread=False,
            isolation_level=None,
        )
        self._connection.row_factory = sqlite3.Row
        self._connection.execute("PRAGMA foreign_keys=ON")
        self._connection.execute("PRAGMA busy_timeout=0")
        self._connection.execute("PRAGMA synchronous=FULL")
        try:
            journal_mode = str(
                self._connection.execute("PRAGMA journal_mode=WAL").fetchone()[0]
            ).lower()
        except sqlite3.OperationalError:
            self._connection.execute("PRAGMA journal_mode=DELETE")
            journal_mode = "delete"
        if journal_mode == "wal":
            # FULL still fsyncs every committed WAL transaction. Keep each
            # automatic merge small so positioned multi-track replay spreads
            # checkpoint work across commands instead of paying one large,
            # latency-spiking merge. Recovery semantics stay unchanged and the
            # normal WAL window remains near 1 MiB.
            self._connection.execute(
                f"PRAGMA wal_autocheckpoint={_WAL_AUTOCHECKPOINT_PAGES}"
            )
        try:
            self._run_write(
                lambda connection: migrate_replay_schema(
                    connection, now_ms=self._validated_now_ms()
                )
            )
            self._compact_database_if_needed()
        except BaseException:
            self._connection.close()
            self._closed = True
            raise
        self._read_connections: queue.LifoQueue[sqlite3.Connection] = (
            queue.LifoQueue(maxsize=self._read_pool_size)
        )
        try:
            for _ in range(self._read_pool_size):
                connection = sqlite3.connect(
                    f"{self.path.as_uri()}?mode=ro",
                    uri=True,
                    timeout=5,
                    check_same_thread=False,
                    isolation_level=None,
                )
                connection.row_factory = sqlite3.Row
                connection.execute("PRAGMA query_only=ON")
                connection.execute("PRAGMA busy_timeout=5000")
                self._read_connections.put(connection)
            self._collect_dataset_objects_sync()
        except BaseException:
            while not self._read_connections.empty():
                self._read_connections.get_nowait().close()
            self._connection.close()
            self._closed = True
            raise

    @property
    def degraded_reason(self) -> str | None:
        return self._degraded_reason

    @property
    def closed(self) -> bool:
        return self._closed

    @property
    def schema_version(self) -> int:
        return REPLAY_SCHEMA_VERSION

    async def create_session(
        self,
        *,
        session_id: str,
        config: Mapping[str, object],
        broker_config: Mapping[str, object],
        session_state: Mapping[str, object],
        dataset_ref: Mapping[str, object],
        dataset_blob: bytes,
        actual_replay_start_ms: int,
        actual_replay_end_ms: int,
        synthetic_origin_ms: int | None,
        initial_checkpoint: bytes,
        component_state: Mapping[str, object] | None = None,
        extension_write: ExtensionWriter | None = None,
    ) -> None:
        now = self._validated_now_ms()
        dataset_bytes = bytes(dataset_blob)
        expected_object_id = _blob_sha256(dataset_bytes)
        async with self._dataset_gc_lock:
            with self._dataset_pending_lock:
                self._pending_dataset_objects[expected_object_id] = (
                    self._pending_dataset_objects.get(expected_object_id, 0) + 1
                )
        try:
            dataset_object_id = await asyncio.to_thread(
                self._dataset_objects.put,
                dataset_bytes,
            )
        except BaseException:
            self._release_pending_dataset_object(expected_object_id)
            raise
        checkpoint_bytes = bytes(initial_checkpoint)

        def write(connection: sqlite3.Connection) -> None:
            state = self._normalize_session_state(session_state)
            connection.execute(
                """
                INSERT INTO replay_session(
                    session_id, config_json, broker_config_json, state, status_reason,
                    revision, event_sequence, source_sequence, command_log_offset,
                    state_hash, data_epoch, revealed, accepting, degraded_reason,
                    created_at_ms, updated_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
                """,
                (
                    session_id,
                    canonical_json(config),
                    canonical_json(broker_config),
                    state["state"],
                    state["status_reason"],
                    state["revision"],
                    state["event_sequence"],
                    state["source_sequence"],
                    state["command_log_offset"],
                    state["state_hash"],
                    state["data_epoch"],
                    int(state["revealed"]),
                    int(state["accepting"]),
                    now,
                    now,
                ),
            )
            connection.execute(
                """
                INSERT INTO replay_dataset_ref(
                    session_id, data_epoch, snapshot_ref_json, snapshot_blob,
                    snapshot_sha256, snapshot_object_id, snapshot_size_bytes,
                    actual_replay_start_ms, actual_replay_end_ms,
                    synthetic_origin_ms, created_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    session_id,
                    state["data_epoch"],
                    canonical_json(dataset_ref),
                    b"",
                    _blob_sha256(dataset_bytes),
                    dataset_object_id,
                    len(dataset_bytes),
                    actual_replay_start_ms,
                    actual_replay_end_ms,
                    synthetic_origin_ms,
                    now,
                ),
            )
            self._insert_checkpoint(
                connection,
                session_id=session_id,
                state=state,
                payload=checkpoint_bytes,
                initial=True,
                mutation_id=0,
                now_ms=now,
            )
            self._replace_component_rows(
                connection, session_id, component_state or {}, now_ms=now
            )
            if extension_write is not None:
                extension_write(connection, now)
            self._write_session_review(
                connection,
                session_id,
                {"kind": "INITIAL"},
                state,
                component_state or {},
                checkpoint_bytes,
                now_ms=now,
            )

        try:
            await self._write_async(write)
        finally:
            self._release_pending_dataset_object(expected_object_id)

    async def delete_session(self, session_id: str) -> bool:
        """Compensate a create that persisted but was never service-registered.

        Foreign-key cascades remove the immutable dataset and every derived replay
        row in the same transaction.  Compensation remains available in sticky
        degraded mode because retaining a caller-invisible partial session is less
        safe than attempting the bounded delete.
        """

        def write(connection: sqlite3.Connection) -> bool:
            cursor = connection.execute(
                "DELETE FROM replay_session WHERE session_id = ?",
                (session_id,),
            )
            return cursor.rowcount == 1

        deleted = await self._write_async(write, allow_degraded=True)
        if deleted:
            await self.collect_dataset_objects()
        return deleted

    async def commit_command(
        self,
        *,
        session_id: str,
        command: Mapping[str, object],
        accepted: bool,
        result: Mapping[str, object] | None,
        error_code: str | None,
        error_message: str | None,
        error_details: Mapping[str, object] | None,
        session_state: Mapping[str, object],
        checkpoint: bytes | None,
        source_events: Sequence[Mapping[str, object]] = (),
        component_state: Mapping[str, object] | None = None,
    ) -> StoredCommand:
        command_payload = dict(command)
        fingerprint = canonical_sha256(command_payload)
        command_id = str(command_payload.get("command_id", ""))
        now = self._validated_now_ms()

        def write(connection: sqlite3.Connection) -> StoredCommand:
            existing = self._load_command_row(connection, session_id, command_id)
            if existing is not None:
                if existing.fingerprint != fingerprint:
                    raise ReplayDomainError(
                        ReplayErrorCode.COMMAND_ID_REUSED,
                        "command_id was reused with a different canonical command",
                        details={"command_id": command_id},
                    )
                return existing
            state = self._normalize_session_state(session_state)
            if accepted and checkpoint is None:
                raise ValueError("accepted command requires a durable checkpoint")
            connection.execute(
                """
                INSERT INTO replay_command_log(
                    session_id, command_id, fingerprint, command_json, accepted,
                    error_code, error_message, error_details_json, result_json,
                    cursor_json, result_sequence, result_state_hash, log_offset,
                    created_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    session_id,
                    command_id,
                    fingerprint,
                    canonical_json(command_payload),
                    int(accepted),
                    error_code,
                    error_message,
                    canonical_json(error_details or {}),
                    None if result is None else canonical_json(result),
                    canonical_json(state["cursor"]),
                    state["event_sequence"],
                    state["state_hash"],
                    state["command_log_offset"],
                    now,
                ),
            )
            mutation_cursor = connection.execute(
                """
                INSERT INTO replay_mutation_log(
                    session_id, kind, command_id, payload_json, state_hash, created_at_ms
                ) VALUES (?, 'command', ?, ?, ?, ?)
                """,
                (
                    session_id,
                    command_id,
                    canonical_json(command_payload),
                    state["state_hash"],
                    now,
                ),
            )
            mutation_id = int(mutation_cursor.lastrowid)
            first_source_sequence = (
                int(state["source_sequence"]) - len(source_events) + 1
            )
            for index, source_event in enumerate(source_events):
                self._insert_source_event(
                    connection,
                    session_id=session_id,
                    source_sequence=first_source_sequence + index,
                    source_event=source_event,
                    result_sequence=int(state["event_sequence"]),
                    state_hash=str(state["state_hash"]),
                    now_ms=now,
                )
            if checkpoint is not None:
                self._insert_checkpoint(
                    connection,
                    session_id=session_id,
                    state=state,
                    payload=bytes(checkpoint),
                    initial=False,
                    mutation_id=mutation_id,
                    now_ms=now,
                )
            self._update_session(connection, session_id, state, now_ms=now)
            self._replace_component_rows(
                connection, session_id, component_state or {}, now_ms=now
            )
            self._write_session_mutation(
                connection,
                session_id,
                command_payload,
                accepted,
                result,
                state,
                component_state or {},
                now_ms=now,
            )
            self._write_session_summary(
                connection,
                session_id,
                state,
                component_state or {},
                now_ms=now,
            )
            self._write_session_review(
                connection,
                session_id,
                {
                    "kind": "COMMAND",
                    "accepted": accepted,
                    "command": command_payload,
                    "result": result,
                },
                state,
                component_state or {},
                None if checkpoint is None else bytes(checkpoint),
                now_ms=now,
            )
            row = self._load_command_row(connection, session_id, command_id)
            assert row is not None
            return row

        return await self._write_async(write)

    async def commit_source_event(
        self,
        *,
        session_id: str,
        source_event: Mapping[str, object],
        session_state: Mapping[str, object],
        checkpoint: bytes | None,
        component_state: Mapping[str, object] | None = None,
    ) -> None:
        event_payload = dict(source_event)
        now = self._validated_now_ms()

        def write(connection: sqlite3.Connection) -> None:
            state = self._normalize_session_state(session_state)
            source_sequence = int(state["source_sequence"])
            event_json = canonical_json(event_payload)
            durable = connection.execute(
                """
                SELECT
                    state, status_reason, revision, event_sequence,
                    source_sequence, command_log_offset, state_hash, data_epoch,
                    revealed, accepting, degraded_reason
                FROM replay_session
                WHERE session_id = ?
                """,
                (session_id,),
            ).fetchone()
            if durable is None:
                raise ReplayDomainError(
                    ReplayErrorCode.SESSION_NOT_FOUND,
                    "replay session does not exist",
                    details={"session_id": session_id},
                )
            durable_source_sequence = int(durable["source_sequence"])
            if durable_source_sequence == source_sequence:
                existing = connection.execute(
                    """
                    SELECT event_json, result_sequence, state_hash
                    FROM replay_source_event
                    WHERE session_id = ? AND source_sequence = ?
                    """,
                    (session_id, source_sequence),
                ).fetchone()
                if existing is not None and self._durable_state_matches(
                    durable,
                    state,
                ) and (
                    existing["event_json"] == event_json
                    and int(existing["result_sequence"])
                    == int(state["event_sequence"])
                    and existing["state_hash"] == state["state_hash"]
                ):
                    # The previous transaction committed in full but its caller
                    # did not observe the result.  A retry must be a true no-op:
                    # a duplicate mutation would poison contiguous recovery.
                    return
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "replay source retry conflicts with durable session state",
                    details={"source_sequence": source_sequence},
                )
            if source_sequence != durable_source_sequence + 1:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "replay source sequence is not contiguous with durable state",
                    details={
                        "expected": durable_source_sequence + 1,
                        "actual": source_sequence,
                    },
                )
            existing = connection.execute(
                """
                SELECT event_json FROM replay_source_event
                WHERE session_id = ? AND source_sequence = ?
                """,
                (session_id, source_sequence),
            ).fetchone()
            if existing is not None and existing["event_json"] != event_json:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "replay source event conflicts with the immutable dataset",
                    details={"source_sequence": source_sequence},
                )
            self._insert_source_event(
                connection,
                session_id=session_id,
                source_sequence=source_sequence,
                source_event=event_payload,
                result_sequence=int(state["event_sequence"]),
                state_hash=str(state["state_hash"]),
                now_ms=now,
            )
            mutation_cursor = connection.execute(
                """
                INSERT INTO replay_mutation_log(
                    session_id, kind, source_sequence, payload_json, state_hash, created_at_ms
                ) VALUES (?, 'source_event', ?, ?, ?, ?)
                """,
                (session_id, source_sequence, event_json, state["state_hash"], now),
            )
            mutation_id = int(mutation_cursor.lastrowid)
            if checkpoint is not None:
                self._insert_checkpoint(
                    connection,
                    session_id=session_id,
                    state=state,
                    payload=bytes(checkpoint),
                    initial=False,
                    mutation_id=mutation_id,
                    now_ms=now,
                )
            self._update_session(connection, session_id, state, now_ms=now)
            self._replace_component_rows(
                connection, session_id, component_state or {}, now_ms=now
            )
            self._write_session_summary(
                connection,
                session_id,
                state,
                component_state or {},
                now_ms=now,
            )
            self._write_session_review(
                connection,
                session_id,
                {"kind": "SOURCE_EVENT", "source_event": event_payload},
                state,
                component_state or {},
                None if checkpoint is None else bytes(checkpoint),
                now_ms=now,
            )

        await self._write_async(write)

    async def commit_state(
        self,
        *,
        session_id: str,
        kind: str,
        payload: Mapping[str, object],
        session_state: Mapping[str, object],
        checkpoint: bytes,
        component_state: Mapping[str, object] | None = None,
    ) -> None:
        now = self._validated_now_ms()

        def write(connection: sqlite3.Connection) -> None:
            state = self._normalize_session_state(session_state)
            encoded_checkpoint = base64.b64encode(bytes(checkpoint)).decode("ascii")
            durable_payload = {
                "mutation": dict(payload),
                "checkpoint_b64": encoded_checkpoint,
                "checkpoint_sha256": _blob_sha256(bytes(checkpoint)),
            }
            mutation_cursor = connection.execute(
                """
                INSERT INTO replay_mutation_log(
                    session_id, kind, payload_json, state_hash, created_at_ms
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (
                    session_id,
                    kind,
                    canonical_json(durable_payload),
                    state["state_hash"],
                    now,
                ),
            )
            mutation_id = int(mutation_cursor.lastrowid)
            self._insert_checkpoint(
                connection,
                session_id=session_id,
                state=state,
                payload=bytes(checkpoint),
                initial=False,
                mutation_id=mutation_id,
                now_ms=now,
            )
            self._update_session(connection, session_id, state, now_ms=now)
            self._replace_component_rows(
                connection, session_id, component_state or {}, now_ms=now
            )
            self._write_session_summary(
                connection,
                session_id,
                state,
                component_state or {},
                now_ms=now,
            )
            self._write_session_review(
                connection,
                session_id,
                {"kind": "STATE", "state_kind": kind, "payload": dict(payload)},
                state,
                component_state or {},
                bytes(checkpoint),
                now_ms=now,
            )

        await self._write_async(write)

    async def mark_degraded(self, session_id: str, reason: str) -> None:
        now = self._validated_now_ms()

        def write(connection: sqlite3.Connection) -> None:
            connection.execute(
                """
                UPDATE replay_session
                SET state = 'PAUSED', accepting = 0, degraded_reason = ?,
                    status_reason = 'persistence_degraded', updated_at_ms = ?
                WHERE session_id = ?
                """,
                (reason[:500], now, session_id),
            )

        await self._write_async(write, allow_degraded=True)

    async def get_command(
        self, session_id: str, command_id: str
    ) -> StoredCommand | None:
        return await self._read_async(
            lambda connection: self._load_command_row(
                connection, session_id, command_id
            )
        )

    async def get_session(self, session_id: str) -> dict[str, object] | None:
        def read(connection: sqlite3.Connection) -> dict[str, object] | None:
            row = connection.execute(
                "SELECT * FROM replay_session WHERE session_id = ?", (session_id,)
            ).fetchone()
            return None if row is None else self._session_row(row)

        return await self._read_async(read)

    async def load_recoverable_sessions(self) -> tuple[dict[str, object], ...]:
        def read(connection: sqlite3.Connection) -> tuple[dict[str, object], ...]:
            rows = connection.execute(
                """
                SELECT * FROM replay_session
                WHERE state != 'ENDED' AND degraded_reason IS NULL
                ORDER BY created_at_ms, session_id
                """
            ).fetchall()
            return tuple(self._session_row(row) for row in rows)

        return await self._read_async(read)

    async def load_dataset(self, session_id: str) -> dict[str, object] | None:
        def read(connection: sqlite3.Connection) -> dict[str, object] | None:
            row = connection.execute(
                "SELECT * FROM replay_dataset_ref WHERE session_id = ?", (session_id,)
            ).fetchone()
            if row is None:
                return None
            stored_blob = bytes(row["snapshot_blob"])
            object_id = row["snapshot_object_id"]
            if object_id is not None:
                if stored_blob:
                    raise ReplayDomainError(
                        ReplayErrorCode.DATASET_MISMATCH,
                        "external replay dataset row contains an inline body",
                    )
                try:
                    blob = self._dataset_objects.get(str(object_id))
                except (OSError, RuntimeError, ValueError) as exc:
                    raise ReplayDomainError(
                        ReplayErrorCode.DATASET_MISMATCH,
                        "persisted replay dataset object is unavailable",
                    ) from exc
                expected_size = row["snapshot_size_bytes"]
                if expected_size is None or int(expected_size) != len(blob):
                    raise ReplayDomainError(
                        ReplayErrorCode.DATASET_MISMATCH,
                        "persisted replay dataset object size does not match",
                    )
            else:
                blob = stored_blob
            if _blob_sha256(blob) != row["snapshot_sha256"]:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "persisted replay dataset checksum does not match",
                )
            return {
                "session_id": row["session_id"],
                "data_epoch": row["data_epoch"],
                "snapshot_ref": _decode_json(row["snapshot_ref_json"]),
                "snapshot_blob": blob,
                "actual_replay_start_ms": row["actual_replay_start_ms"],
                "actual_replay_end_ms": row["actual_replay_end_ms"],
                "synthetic_origin_ms": row["synthetic_origin_ms"],
            }

        return await self._read_async(read)

    async def load_valid_checkpoints(
        self, session_id: str
    ) -> tuple[StoredCheckpoint, ...]:
        def read(connection: sqlite3.Connection) -> tuple[StoredCheckpoint, ...]:
            latest_row = connection.execute(
                """
                SELECT MAX(checkpoint_id) AS checkpoint_id
                FROM replay_checkpoint
                WHERE session_id = ? AND active = 1
                """,
                (session_id,),
            ).fetchone()
            latest_checkpoint_id = (
                None
                if latest_row is None or latest_row["checkpoint_id"] is None
                else int(latest_row["checkpoint_id"])
            )
            rows = connection.execute(
                """
                SELECT * FROM replay_checkpoint
                WHERE session_id = ? AND active = 1
                ORDER BY checkpoint_id DESC
                """,
                (session_id,),
            ).fetchall()
            valid: list[StoredCheckpoint] = []
            for row in rows:
                payload = bytes(row["payload"])
                if _blob_sha256(payload) != row["payload_sha256"]:
                    self._metrics["corrupt_checkpoints_skipped"] += 1
                    continue
                valid.append(
                    StoredCheckpoint(
                        checkpoint_id=int(row["checkpoint_id"]),
                        session_id=row["session_id"],
                        mutation_id=(
                            None
                            if row["mutation_id"] is None
                            else int(row["mutation_id"])
                        ),
                        source_sequence=int(row["source_sequence"]),
                        command_log_offset=int(row["command_log_offset"]),
                        event_sequence=int(row["event_sequence"]),
                        state_hash=row["state_hash"],
                        payload=payload,
                        is_initial=bool(row["is_initial"]),
                        is_latest=int(row["checkpoint_id"]) == latest_checkpoint_id,
                    )
                )
            return tuple(valid)

        return await self._read_async(read)

    async def source_events_after(
        self, session_id: str, source_sequence: int
    ) -> tuple[dict[str, object], ...]:
        def read(connection: sqlite3.Connection) -> tuple[dict[str, object], ...]:
            rows = connection.execute(
                """
                SELECT source_sequence, event_json, result_sequence, state_hash
                FROM replay_source_event
                WHERE session_id = ? AND source_sequence > ?
                ORDER BY source_sequence
                """,
                (session_id, source_sequence),
            ).fetchall()
            return tuple(
                {
                    "source_sequence": int(row["source_sequence"]),
                    "event": _decode_json(row["event_json"]),
                    "result_sequence": int(row["result_sequence"]),
                    "state_hash": row["state_hash"],
                }
                for row in rows
            )

        return await self._read_async(read)

    async def recovery_mutations_after(
        self,
        session_id: str,
        *,
        mutation_id: int,
    ) -> tuple[dict[str, object], ...]:
        """Load ordered domain mutations after a checkpoint position."""

        def read(connection: sqlite3.Connection) -> tuple[dict[str, object], ...]:
            rows = connection.execute(
                """
                SELECT
                    mutation.mutation_id,
                    mutation.kind,
                    mutation.source_sequence,
                    mutation.payload_json AS mutation_payload_json,
                    mutation.state_hash AS mutation_state_hash,
                    command.command_json,
                    command.accepted,
                    command.log_offset,
                    command.result_state_hash AS command_state_hash
                FROM replay_mutation_log AS mutation
                LEFT JOIN replay_command_log AS command
                  ON command.session_id = mutation.session_id
                 AND command.command_id = mutation.command_id
                WHERE mutation.session_id = ?
                  AND mutation.mutation_id > ?
                ORDER BY mutation.mutation_id
                """,
                (session_id, mutation_id),
            ).fetchall()
            mutations: list[dict[str, object]] = []
            for row in rows:
                if row["kind"] == "command":
                    command = _decode_json(row["command_json"])
                    if not isinstance(command, Mapping):
                        raise ReplayDomainError(
                            ReplayErrorCode.DATASET_MISMATCH,
                            "persisted replay command tail is invalid",
                        )
                    mutations.append(
                        {
                            "kind": "command",
                            "command": command,
                            "accepted": bool(row["accepted"]),
                            "command_log_offset": int(row["log_offset"]),
                            "state_hash": row["command_state_hash"],
                        }
                    )
                    continue
                mutation_payload = _decode_json(row["mutation_payload_json"])
                if row["kind"] == "source_event":
                    if not isinstance(mutation_payload, Mapping):
                        raise ReplayDomainError(
                            ReplayErrorCode.DATASET_MISMATCH,
                            "persisted replay source tail is invalid",
                        )
                    mutations.append(
                        {
                            "kind": "source_event",
                            "source_sequence": int(row["source_sequence"]),
                            "event": mutation_payload,
                            "state_hash": row["mutation_state_hash"],
                        }
                    )
                    continue
                if not isinstance(mutation_payload, Mapping) or set(
                    mutation_payload
                ) != {"mutation", "checkpoint_b64", "checkpoint_sha256"}:
                    raise ReplayDomainError(
                        ReplayErrorCode.DATASET_MISMATCH,
                        "persisted replay internal mutation is invalid",
                    )
                encoded = mutation_payload["checkpoint_b64"]
                if not isinstance(encoded, str) or not isinstance(
                    mutation_payload["checkpoint_sha256"], str
                ):
                    raise ReplayDomainError(
                        ReplayErrorCode.DATASET_MISMATCH,
                        "persisted replay internal checkpoint is invalid",
                    )
                try:
                    checkpoint = base64.b64decode(encoded, validate=True)
                except (ValueError, binascii.Error) as exc:
                    raise ReplayDomainError(
                        ReplayErrorCode.DATASET_MISMATCH,
                        "persisted replay internal checkpoint encoding is invalid",
                    ) from exc
                if _blob_sha256(checkpoint) != mutation_payload["checkpoint_sha256"]:
                    raise ReplayDomainError(
                        ReplayErrorCode.DATASET_MISMATCH,
                        "persisted replay internal checkpoint checksum does not match",
                    )
                mutations.append(
                    {
                        "kind": "internal_state",
                        "mutation_kind": str(row["kind"]),
                        "checkpoint": checkpoint,
                        "state_hash": row["mutation_state_hash"],
                    }
                )
            return tuple(mutations)

        return await self._read_async(read)

    async def save_report(
        self, session_id: str, report: Mapping[str, object], report_hash: str
    ) -> None:
        now = self._validated_now_ms()
        await self._write_async(
            lambda connection: connection.execute(
                """
                INSERT INTO replay_report(session_id, report_json, report_hash, created_at_ms)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET
                    report_json = excluded.report_json,
                    report_hash = excluded.report_hash,
                    created_at_ms = excluded.created_at_ms
                """,
                (session_id, canonical_json(report), report_hash, now),
            )
        )

    async def close(self) -> None:
        async with self._async_lock:
            async with self._dataset_gc_lock:
                if self._closed:
                    return
                await asyncio.to_thread(self._close_sync)

    async def collect_dataset_objects(self) -> dict[str, int]:
        async with self._dataset_gc_lock:
            referenced = await self._read_async(
                lambda connection: {
                    str(row[0])
                    for row in connection.execute(
                        "SELECT snapshot_object_id FROM replay_dataset_ref "
                        "WHERE snapshot_object_id IS NOT NULL"
                    ).fetchall()
                }
            )
            with self._dataset_pending_lock:
                referenced.update(self._pending_dataset_objects)
            result = await asyncio.to_thread(
                self._dataset_objects.collect,
                referenced,
            )
        self._metrics["dataset_objects_removed"] += result["objects_removed"]
        self._metrics["dataset_object_bytes_removed"] += result["bytes_removed"]
        return result

    def register_session_summary_writer(self, writer: SessionSummaryWriter) -> None:
        """Register one additive schema projection inside v1 mutations."""

        if self._session_summary_writer is not None and self._session_summary_writer != writer:
            raise RuntimeError("replay session summary writer is already registered")
        self._session_summary_writer = writer

    def register_session_mutation_writer(self, writer: SessionMutationWriter) -> None:
        """Register one additive command projection in the v1 transaction."""

        if (
            self._session_mutation_writer is not None
            and self._session_mutation_writer != writer
        ):
            raise RuntimeError("replay session mutation writer is already registered")
        self._session_mutation_writer = writer

    def register_session_review_writer(self, writer: SessionReviewWriter) -> None:
        """Register one content-addressed review projection in v1 transactions."""

        if self._session_review_writer is not None and self._session_review_writer != writer:
            raise RuntimeError("replay session review writer is already registered")
        self._session_review_writer = writer

    async def run_extension_write(self, operation, *, allow_degraded: bool = False):
        """Run a trusted additive-schema write under the replay transaction lock."""

        return await self._write_async(operation, allow_degraded=allow_degraded)

    async def run_extension_read(self, operation):
        """Run a trusted additive-schema read under the replay connection lock."""

        return await self._read_async(operation)

    def diagnostics(self) -> dict[str, object]:
        return {
            **self._metrics,
            "path": str(self.path),
            "schema_version": REPLAY_SCHEMA_VERSION,
            "closed": self._closed,
            "degraded": self._degraded_reason is not None,
            "degraded_reason": self._degraded_reason,
            "busy_attempts": len(self._busy_retry_delays),
            "read_pool_size": self._read_pool_size,
            "dataset_object_dir": str(self._dataset_objects.root),
        }

    def _close_sync(self) -> None:
        with self._read_condition:
            if self._closed:
                return
            self._closed = True
            while self._active_reads:
                self._read_condition.wait()
        with self._thread_lock:
            while not self._read_connections.empty():
                self._read_connections.get_nowait().close()
            self._connection.close()

    async def _write_async(self, operation, *, allow_degraded: bool = False):
        async with self._async_lock:
            return await asyncio.to_thread(self._run_write, operation, allow_degraded)

    async def _read_async(self, operation):
        return await asyncio.to_thread(self._run_read, operation)

    def _run_write(self, operation, allow_degraded: bool = False):
        with self._thread_lock:
            self._ensure_open()
            if self._degraded_reason is not None and not allow_degraded:
                raise ReplayDomainError(
                    ReplayErrorCode.PERSISTENCE_DEGRADED,
                    "replay persistence is in sticky degraded mode",
                    details={"reason": self._degraded_reason},
                )
            last_busy: sqlite3.OperationalError | None = None
            for attempt, delay in enumerate(self._busy_retry_delays):
                if delay:
                    self._sleep(delay)
                try:
                    self._connection.execute("BEGIN IMMEDIATE")
                    result = operation(self._connection)
                    self._connection.commit()
                    self._metrics["transactions"] += 1
                    return result
                except sqlite3.OperationalError as exc:
                    self._connection.rollback()
                    if not self._is_busy(exc):
                        self._metrics["transaction_failures"] += 1
                        raise
                    last_busy = exc
                    if attempt + 1 < len(self._busy_retry_delays):
                        self._metrics["busy_retries"] += 1
                        continue
                    break
                except BaseException:
                    self._connection.rollback()
                    self._metrics["transaction_failures"] += 1
                    raise
            self._metrics["transaction_failures"] += 1
            self._metrics["busy_exhaustions"] += 1
            reason = f"sqlite busy retry exhausted after {len(self._busy_retry_delays)} attempts"
            self._degraded_reason = reason
            raise ReplayDomainError(
                ReplayErrorCode.PERSISTENCE_DEGRADED,
                "replay persistence busy retry budget was exhausted",
                details={"reason": reason, "sqlite_error": str(last_busy)},
            ) from last_busy

    def _run_read(self, operation):
        with self._read_condition:
            self._ensure_open()
            self._active_reads += 1
        connection = self._read_connections.get()
        try:
            return operation(connection)
        finally:
            self._read_connections.put(connection)
            with self._read_condition:
                self._active_reads -= 1
                self._read_condition.notify_all()

    def _collect_dataset_objects_sync(self) -> dict[str, int]:
        columns = {
            str(row[1])
            for row in self._connection.execute(
                "PRAGMA table_info(replay_dataset_ref)"
            ).fetchall()
        }
        referenced = (
            {
                str(row[0])
                for row in self._connection.execute(
                    "SELECT snapshot_object_id FROM replay_dataset_ref "
                    "WHERE snapshot_object_id IS NOT NULL"
                ).fetchall()
            }
            if "snapshot_object_id" in columns
            else set()
        )
        with self._dataset_pending_lock:
            referenced.update(self._pending_dataset_objects)
        result = self._dataset_objects.collect(referenced)
        self._metrics["dataset_objects_removed"] += result["objects_removed"]
        self._metrics["dataset_object_bytes_removed"] += result["bytes_removed"]
        return result

    def _release_pending_dataset_object(self, object_id: str) -> None:
        with self._dataset_pending_lock:
            remaining = self._pending_dataset_objects.get(object_id, 0) - 1
            if remaining <= 0:
                self._pending_dataset_objects.pop(object_id, None)
            else:
                self._pending_dataset_objects[object_id] = remaining

    def _compact_database_if_needed(self) -> None:
        page_count = int(self._connection.execute("PRAGMA page_count").fetchone()[0])
        free_pages = int(
            self._connection.execute("PRAGMA freelist_count").fetchone()[0]
        )
        if page_count < 4_096 or free_pages * 2 < page_count:
            return
        try:
            self._connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            self._connection.execute("PRAGMA auto_vacuum=INCREMENTAL")
            self._connection.execute("VACUUM")
        except sqlite3.Error:
            self._metrics["database_compaction_failures"] += 1
        else:
            self._metrics["database_compactions"] += 1

    def _write_session_summary(
        self,
        connection: sqlite3.Connection,
        session_id: str,
        state: Mapping[str, object],
        component_state: Mapping[str, object],
        *,
        now_ms: int,
    ) -> None:
        writer = self._session_summary_writer
        if writer is not None:
            writer(connection, session_id, state, component_state, now_ms)

    def _write_session_mutation(
        self,
        connection: sqlite3.Connection,
        session_id: str,
        command: Mapping[str, object],
        accepted: bool,
        result: Mapping[str, object] | None,
        state: Mapping[str, object],
        component_state: Mapping[str, object],
        *,
        now_ms: int,
    ) -> None:
        writer = self._session_mutation_writer
        if writer is None:
            return
        writer(
            connection,
            session_id,
            command,
            accepted,
            result,
            state,
            component_state,
            now_ms,
        )

    def _write_session_review(
        self,
        connection: sqlite3.Connection,
        session_id: str,
        context: Mapping[str, object],
        state: Mapping[str, object],
        component_state: Mapping[str, object],
        checkpoint: bytes | None,
        *,
        now_ms: int,
    ) -> None:
        writer = self._session_review_writer
        if writer is None:
            return
        writer(
            connection,
            session_id,
            context,
            state,
            component_state,
            checkpoint,
            now_ms,
        )

    def _insert_checkpoint(
        self,
        connection: sqlite3.Connection,
        *,
        session_id: str,
        state: Mapping[str, object],
        payload: bytes,
        initial: bool,
        mutation_id: int,
        now_ms: int,
    ) -> int:
        cursor = connection.execute(
            """
            INSERT INTO replay_checkpoint(
                session_id, mutation_id, source_sequence, command_log_offset,
                event_sequence, state_hash, payload, payload_sha256, is_initial,
                active, created_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
            """,
            (
                session_id,
                mutation_id,
                state["source_sequence"],
                state["command_log_offset"],
                state["event_sequence"],
                state["state_hash"],
                payload,
                _blob_sha256(payload),
                int(initial),
                now_ms,
            ),
        )
        checkpoint_id = int(cursor.lastrowid)
        connection.execute(
            "UPDATE replay_checkpoint SET active = 1 WHERE checkpoint_id = ?",
            (checkpoint_id,),
        )
        connection.execute(
            """
            DELETE FROM replay_checkpoint
            WHERE session_id = ? AND is_initial = 0 AND checkpoint_id NOT IN (
                SELECT checkpoint_id FROM replay_checkpoint
                WHERE session_id = ? AND is_initial = 0 AND active = 1
                ORDER BY checkpoint_id DESC LIMIT ?
            )
            """,
            (session_id, session_id, self._max_recent_checkpoints),
        )
        self._metrics["checkpoints_written"] += 1
        return checkpoint_id

    @staticmethod
    def _insert_source_event(
        connection: sqlite3.Connection,
        *,
        session_id: str,
        source_sequence: int,
        source_event: Mapping[str, object],
        result_sequence: int,
        state_hash: str,
        now_ms: int,
    ) -> None:
        connection.execute(
            """
            INSERT INTO replay_source_event(
                session_id, source_sequence, event_json, result_sequence,
                state_hash, created_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id, source_sequence) DO UPDATE SET
                event_json = excluded.event_json,
                result_sequence = excluded.result_sequence,
                state_hash = excluded.state_hash,
                created_at_ms = excluded.created_at_ms
            """,
            (
                session_id,
                source_sequence,
                canonical_json(source_event),
                result_sequence,
                state_hash,
                now_ms,
            ),
        )

    @staticmethod
    def _update_session(
        connection: sqlite3.Connection,
        session_id: str,
        state: Mapping[str, object],
        *,
        now_ms: int,
    ) -> None:
        cursor = connection.execute(
            """
            UPDATE replay_session SET
                state = ?, status_reason = ?, revision = ?, event_sequence = ?,
                source_sequence = ?, command_log_offset = ?, state_hash = ?,
                data_epoch = ?, revealed = ?, accepting = ?, degraded_reason = ?,
                updated_at_ms = ?
            WHERE session_id = ?
            """,
            (
                state["state"],
                state["status_reason"],
                state["revision"],
                state["event_sequence"],
                state["source_sequence"],
                state["command_log_offset"],
                state["state_hash"],
                state["data_epoch"],
                int(state["revealed"]),
                int(state["accepting"]),
                state["degraded_reason"],
                now_ms,
                session_id,
            ),
        )
        if cursor.rowcount != 1:
            raise ReplayDomainError(
                ReplayErrorCode.SESSION_NOT_FOUND,
                "replay session does not exist",
                details={"session_id": session_id},
            )

    @staticmethod
    def _durable_state_matches(
        durable: sqlite3.Row,
        candidate: Mapping[str, object],
    ) -> bool:
        return (
            durable["state"] == candidate["state"]
            and durable["status_reason"] == candidate["status_reason"]
            and int(durable["revision"]) == candidate["revision"]
            and int(durable["event_sequence"]) == candidate["event_sequence"]
            and int(durable["source_sequence"]) == candidate["source_sequence"]
            and int(durable["command_log_offset"])
            == candidate["command_log_offset"]
            and durable["state_hash"] == candidate["state_hash"]
            and durable["data_epoch"] == candidate["data_epoch"]
            and bool(durable["revealed"]) is candidate["revealed"]
            and bool(durable["accepting"]) is candidate["accepting"]
            and durable["degraded_reason"] == candidate["degraded_reason"]
        )

    @staticmethod
    def _replace_component_rows(
        connection: sqlite3.Connection,
        session_id: str,
        component_state: Mapping[str, object],
        *,
        now_ms: int,
    ) -> None:
        if not component_state:
            return
        for table in (
            "replay_order",
            "replay_fill",
            "replay_ledger_entry",
            "replay_journal_entry",
        ):
            connection.execute(
                f"DELETE FROM {table} WHERE session_id = ?", (session_id,)
            )
        collections = (
            ("replay_order", "orders", "order_id"),
            ("replay_fill", "fills", "fill_id"),
            ("replay_journal_entry", "journal", "entry_id"),
        )
        for table, key, id_field in collections:
            values = component_state.get(key, ())
            if not isinstance(values, (list, tuple)):
                raise TypeError(f"component_state.{key} must be an array")
            for value in values:
                if not isinstance(value, Mapping) or id_field not in value:
                    raise TypeError(f"component_state.{key} contains an invalid record")
                connection.execute(
                    f"INSERT INTO {table}(session_id, {id_field}, payload_json, "
                    f"{'updated_at_ms' if table == 'replay_order' else 'created_at_ms'}) "
                    "VALUES (?, ?, ?, ?)",
                    (session_id, str(value[id_field]), canonical_json(value), now_ms),
                )
        ledger = component_state.get("ledger")
        if isinstance(ledger, Mapping):
            entries = ledger.get("entries", ())
            if not isinstance(entries, (list, tuple)):
                raise TypeError("component_state.ledger.entries must be an array")
            for value in entries:
                if not isinstance(value, Mapping) or "entry_id" not in value:
                    raise TypeError(
                        "component_state.ledger.entries contains an invalid record"
                    )
                connection.execute(
                    """
                    INSERT INTO replay_ledger_entry(
                        session_id, entry_id, payload_json, created_at_ms
                    ) VALUES (?, ?, ?, ?)
                    """,
                    (session_id, str(value["entry_id"]), canonical_json(value), now_ms),
                )

    @staticmethod
    def _normalize_session_state(state: Mapping[str, object]) -> dict[str, object]:
        required = {
            "state",
            "status_reason",
            "revision",
            "event_sequence",
            "source_sequence",
            "command_log_offset",
            "state_hash",
            "data_epoch",
            "cursor",
            "revealed",
            "accepting",
            "degraded_reason",
        }
        if set(state) != required:
            raise ValueError(
                "session_state fields are incompatible with replay storage"
            )
        normalized = dict(state)
        for field in (
            "revision",
            "event_sequence",
            "source_sequence",
            "command_log_offset",
        ):
            value = normalized[field]
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise ValueError(
                    f"session_state.{field} must be a non-negative integer"
                )
        if not isinstance(normalized["cursor"], Mapping):
            raise TypeError("session_state.cursor must be an object")
        for field in ("revealed", "accepting"):
            if not isinstance(normalized[field], bool):
                raise TypeError(f"session_state.{field} must be a boolean")
        return normalized

    @staticmethod
    def _load_command_row(
        connection: sqlite3.Connection, session_id: str, command_id: str
    ) -> StoredCommand | None:
        row = connection.execute(
            """
            SELECT * FROM replay_command_log
            WHERE session_id = ? AND command_id = ?
            """,
            (session_id, command_id),
        ).fetchone()
        if row is None:
            return None
        return StoredCommand(
            fingerprint=row["fingerprint"],
            command=_decode_json(row["command_json"]),  # type: ignore[arg-type]
            accepted=bool(row["accepted"]),
            result=_decode_json(row["result_json"]),  # type: ignore[arg-type]
            error_code=row["error_code"],
            error_message=row["error_message"],
            error_details=_decode_json(row["error_details_json"]) or {},  # type: ignore[arg-type]
            cursor=_decode_json(row["cursor_json"]),  # type: ignore[arg-type]
            result_sequence=int(row["result_sequence"]),
            result_state_hash=row["result_state_hash"],
            log_offset=int(row["log_offset"]),
        )

    @staticmethod
    def _session_row(row: sqlite3.Row) -> dict[str, object]:
        return {
            "session_id": row["session_id"],
            "config": _decode_json(row["config_json"]),
            "broker_config": _decode_json(row["broker_config_json"]),
            "state": row["state"],
            "status_reason": row["status_reason"],
            "revision": int(row["revision"]),
            "event_sequence": int(row["event_sequence"]),
            "source_sequence": int(row["source_sequence"]),
            "command_log_offset": int(row["command_log_offset"]),
            "state_hash": row["state_hash"],
            "data_epoch": row["data_epoch"],
            "revealed": bool(row["revealed"]),
            "accepting": bool(row["accepting"]),
            "degraded_reason": row["degraded_reason"],
            "created_at_ms": int(row["created_at_ms"]),
            "updated_at_ms": int(row["updated_at_ms"]),
        }

    def _validated_now_ms(self) -> int:
        value = self._now_ms()
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ValueError("replay store clock must return a non-negative integer")
        return value

    def _ensure_open(self) -> None:
        if self._closed:
            raise RuntimeError("replay SQLite store is closed")

    @staticmethod
    def _is_busy(error: sqlite3.OperationalError) -> bool:
        message = str(error).lower()
        return any(marker in message for marker in _BUSY_MARKERS)
