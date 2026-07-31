from __future__ import annotations

import asyncio
import sqlite3
import threading
from pathlib import Path

import pytest

from app.replay.canonical import canonical_sha256
from app.replay.errors import ReplayDomainError, ReplayErrorCode
from app.replay.storage import REPLAY_SCHEMA_VERSION, ReplaySQLiteStore


pytestmark = pytest.mark.anyio


def _state(
    *,
    source_sequence: int = 0,
    event_sequence: int = 1,
    revision: int = 0,
    command_log_offset: int = 0,
    state_hash: str | None = None,
    state: str = "PAUSED",
) -> dict[str, object]:
    return {
        "state": state,
        "status_reason": "initialized",
        "revision": revision,
        "event_sequence": event_sequence,
        "source_sequence": source_sequence,
        "command_log_offset": command_log_offset,
        "state_hash": state_hash or canonical_sha256({"source": source_sequence}),
        "data_epoch": canonical_sha256({"dataset": 1}),
        "cursor": {
            "virtual_time_ms": 1_700_000_000_000 + source_sequence,
            "source_sequence": source_sequence,
            "last_base_bar_open_ms": None,
            "last_trade_time_ms": None,
            "last_agg_trade_id": None,
            "at_end": False,
        },
        "revealed": False,
        "accepting": True,
        "degraded_reason": None,
    }


async def _created_store(path: Path, **kwargs) -> ReplaySQLiteStore:
    store = ReplaySQLiteStore(path, now_ms=lambda: 1_800_000_000_000, **kwargs)
    await store.create_session(
        session_id="session-1",
        config={"protocol": "replay.v1"},
        broker_config={"model": "BAR_CONSERVATIVE_V1"},
        session_state=_state(),
        dataset_ref={"data_epoch": canonical_sha256({"dataset": 1})},
        dataset_blob=b'{"rows":[]}',
        actual_replay_start_ms=1_700_000_000_000,
        actual_replay_end_ms=1_700_000_060_000,
        synthetic_origin_ms=946_684_800_000,
        initial_checkpoint=b"checkpoint-initial",
    )
    return store


async def test_schema_migration_is_versioned_and_does_not_touch_klines_db(
    tmp_path: Path,
) -> None:
    klines_path = tmp_path / "candlescope.db"
    with sqlite3.connect(klines_path) as connection:
        connection.execute("CREATE TABLE sentinel(value TEXT NOT NULL)")
        connection.execute("INSERT INTO sentinel VALUES ('untouched')")

    replay_path = tmp_path / "replay.db"
    store = ReplaySQLiteStore(replay_path, now_ms=lambda: 123)
    try:
        with sqlite3.connect(replay_path) as connection:
            version = connection.execute(
                "SELECT version FROM replay_schema_version WHERE singleton = 1"
            ).fetchone()[0]
            tables = {
                row[0]
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                )
            }
        assert version == REPLAY_SCHEMA_VERSION
        assert {
            "replay_session",
            "replay_dataset_ref",
            "replay_command_log",
            "replay_source_event",
            "replay_checkpoint",
            "replay_order",
            "replay_fill",
            "replay_ledger_entry",
            "replay_journal_entry",
            "replay_report",
        }.issubset(tables)
        with sqlite3.connect(klines_path) as connection:
            assert (
                connection.execute("SELECT value FROM sentinel").fetchone()[0]
                == "untouched"
            )
            assert (
                connection.execute(
                    "SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'replay_%'"
                ).fetchone()[0]
                == 0
            )
    finally:
        await store.close()


async def test_wal_checkpoint_window_preserves_full_commit_durability(
    tmp_path: Path,
) -> None:
    store = ReplaySQLiteStore(tmp_path / "wal-policy.db", now_ms=lambda: 123)
    try:
        assert store._connection.execute(  # noqa: SLF001
            "PRAGMA journal_mode"
        ).fetchone()[0] == "wal"
        assert store._connection.execute(  # noqa: SLF001
            "PRAGMA synchronous"
        ).fetchone()[0] == 2
        assert store._connection.execute(  # noqa: SLF001
            "PRAGMA wal_autocheckpoint"
        ).fetchone()[0] == 256
    finally:
        await store.close()


async def test_dataset_snapshots_are_external_deduplicated_and_gc_safe(
    tmp_path: Path,
) -> None:
    path = tmp_path / "external-dataset.db"
    store = await _created_store(path)
    object_root = path.parent / f"{path.name}.datasets"
    try:
        with sqlite3.connect(path) as connection:
            row = connection.execute(
                """
                SELECT length(snapshot_blob), snapshot_object_id, snapshot_size_bytes
                FROM replay_dataset_ref
                WHERE session_id = 'session-1'
                """
            ).fetchone()
        assert row is not None
        assert row[0] == 0
        assert str(row[1]).startswith("sha256:")
        assert row[2] == len(b'{"rows":[]}')
        assert len(list(object_root.glob("*/*.json.zlib"))) == 1
        first_dataset = await store.load_dataset("session-1")
        assert first_dataset is not None
        assert first_dataset["snapshot_blob"] == b'{"rows":[]}'

        await store.create_session(
            session_id="session-2",
            config={"protocol": "replay.v1"},
            broker_config={"model": "BAR_CONSERVATIVE_V1"},
            session_state=_state(),
            dataset_ref={"data_epoch": canonical_sha256({"dataset": 1})},
            dataset_blob=b'{"rows":[]}',
            actual_replay_start_ms=1_700_000_000_000,
            actual_replay_end_ms=1_700_000_060_000,
            synthetic_origin_ms=946_684_800_000,
            initial_checkpoint=b"checkpoint-initial",
        )
        assert len(list(object_root.glob("*/*.json.zlib"))) == 1

        assert await store.delete_session("session-1") is True
        assert len(list(object_root.glob("*/*.json.zlib"))) == 1
        second_dataset = await store.load_dataset("session-2")
        assert second_dataset is not None
        assert second_dataset["snapshot_blob"] == b'{"rows":[]}'

        assert await store.delete_session("session-2") is True
        assert list(object_root.glob("*/*.json.zlib")) == []
    finally:
        await store.close()


async def test_dataset_gc_serializes_a_new_pending_object(
    tmp_path: Path,
) -> None:
    path = tmp_path / "dataset-gc-race.db"
    store = ReplaySQLiteStore(path, now_ms=lambda: 1_800_000_000_000)
    collect_started = threading.Event()
    collect_release = threading.Event()
    original_collect = store._dataset_objects.collect  # noqa: SLF001

    def blocked_collect(referenced: set[str]) -> dict[str, int]:
        collect_started.set()
        if not collect_release.wait(timeout=5):
            raise TimeoutError("dataset object GC test did not release")
        return original_collect(referenced)

    store._dataset_objects.collect = blocked_collect  # type: ignore[method-assign]  # noqa: SLF001
    try:
        gc_task = asyncio.create_task(store.collect_dataset_objects())
        assert await asyncio.to_thread(collect_started.wait, 5)
        create_task = asyncio.create_task(
            store.create_session(
                session_id="session-racing-gc",
                config={"protocol": "replay.v1"},
                broker_config={"model": "BAR_CONSERVATIVE_V1"},
                session_state=_state(),
                dataset_ref={"data_epoch": canonical_sha256({"dataset": 1})},
                dataset_blob=b'{"rows":["created-after-gc-snapshot"]}',
                actual_replay_start_ms=1_700_000_000_000,
                actual_replay_end_ms=1_700_000_060_000,
                synthetic_origin_ms=946_684_800_000,
                initial_checkpoint=b"checkpoint-initial",
            )
        )
        await asyncio.sleep(0.01)
        assert not create_task.done()
        collect_release.set()
        await gc_task
        await create_task

        dataset = await store.load_dataset("session-racing-gc")
        assert dataset is not None
        assert dataset["snapshot_blob"] == b'{"rows":["created-after-gc-snapshot"]}'
    finally:
        collect_release.set()
        await store.close()


async def test_newer_schema_fails_closed_without_mutating_version(
    tmp_path: Path,
) -> None:
    path = tmp_path / "future.db"
    with sqlite3.connect(path) as connection:
        connection.execute(
            """
            CREATE TABLE replay_schema_version (
                singleton INTEGER PRIMARY KEY,
                version INTEGER NOT NULL,
                applied_at_ms INTEGER NOT NULL
            )
            """
        )
        connection.execute("INSERT INTO replay_schema_version VALUES (1, 99, 1)")
    with pytest.raises(RuntimeError, match="newer than supported"):
        ReplaySQLiteStore(path)
    with sqlite3.connect(path) as connection:
        assert (
            connection.execute("SELECT version FROM replay_schema_version").fetchone()[
                0
            ]
            == 99
        )


async def test_delete_session_compensation_cascades_even_when_store_is_degraded(
    tmp_path: Path,
) -> None:
    store = await _created_store(tmp_path / "delete-compensation.db")
    try:
        store._degraded_reason = "H:\\private\\replay.db @ 1700000123456"
        assert await store.delete_session("session-1") is True
        assert await store.delete_session("session-1") is False
        with sqlite3.connect(store.path) as connection:
            counts = {
                table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[
                    0
                ]
                for table in (
                    "replay_session",
                    "replay_dataset_ref",
                    "replay_checkpoint",
                )
            }
        assert counts == {
            "replay_session": 0,
            "replay_dataset_ref": 0,
            "replay_checkpoint": 0,
        }
    finally:
        await store.close()


async def test_v1_migration_keeps_legacy_checkpoint_watermark_ambiguous(
    tmp_path: Path,
) -> None:
    path = tmp_path / "legacy-v1.db"
    store = await _created_store(path)
    await store.close()

    with sqlite3.connect(path) as connection:
        connection.execute("ALTER TABLE replay_checkpoint DROP COLUMN mutation_id")
        connection.execute(
            "UPDATE replay_schema_version SET version = 1 WHERE singleton = 1"
        )

    migrated = ReplaySQLiteStore(path, now_ms=lambda: 1_800_000_000_000)
    try:
        checkpoints = await migrated.load_valid_checkpoints("session-1")
        assert len(checkpoints) == 1
        assert checkpoints[0].mutation_id is None
        assert checkpoints[0].is_latest is True
        with sqlite3.connect(path) as connection:
            assert connection.execute(
                "SELECT version FROM replay_schema_version WHERE singleton = 1"
            ).fetchone()[0] == REPLAY_SCHEMA_VERSION
    finally:
        await migrated.close()


async def test_command_is_one_transaction_and_same_payload_is_idempotent(
    tmp_path: Path,
) -> None:
    store = await _created_store(tmp_path / "replay.db")
    command = {
        "protocol": "replay.v1",
        "command_id": "command-1",
        "client_instance_id": "tab-1",
        "expected_revision": 0,
        "type": "step",
        "payload": {"count": 1},
    }
    state = _state(
        source_sequence=1, event_sequence=3, revision=1, command_log_offset=1
    )
    try:
        first = await store.commit_command(
            session_id="session-1",
            command=command,
            accepted=True,
            result={"command_id": "command-1", "revision": 1},
            error_code=None,
            error_message=None,
            error_details=None,
            session_state=state,
            checkpoint=b"checkpoint-command-1",
        )
        second = await store.commit_command(
            session_id="session-1",
            command=command,
            accepted=True,
            result={"ignored": "idempotent replay"},
            error_code=None,
            error_message=None,
            error_details=None,
            session_state=state,
            checkpoint=b"different-but-not-written",
        )
        assert first == second
        assert first.accepted is True
        assert first.log_offset == 1
        persisted = await store.get_session("session-1")
        assert persisted is not None
        assert persisted["source_sequence"] == 1
        assert persisted["command_log_offset"] == 1
        assert len(await store.load_valid_checkpoints("session-1")) == 2
        with sqlite3.connect(store.path) as connection:
            assert (
                connection.execute(
                    "SELECT COUNT(*) FROM replay_command_log"
                ).fetchone()[0]
                == 1
            )
    finally:
        await store.close()


async def test_command_id_reuse_with_different_payload_is_rejected(
    tmp_path: Path,
) -> None:
    store = await _created_store(tmp_path / "replay.db")
    command = {
        "protocol": "replay.v1",
        "command_id": "same-id",
        "client_instance_id": "tab-1",
        "expected_revision": 0,
        "type": "pause",
        "payload": {},
    }
    state = _state(revision=1, command_log_offset=1)
    try:
        await store.commit_command(
            session_id="session-1",
            command=command,
            accepted=False,
            result=None,
            error_code="INVALID_STATE_TRANSITION",
            error_message="not playing",
            error_details={},
            session_state=state,
            checkpoint=None,
        )
        changed = {**command, "payload": {"unexpected": True}}
        with pytest.raises(ReplayDomainError) as captured:
            await store.commit_command(
                session_id="session-1",
                command=changed,
                accepted=False,
                result=None,
                error_code="INVALID_STATE_TRANSITION",
                error_message="not playing",
                error_details={},
                session_state=state,
                checkpoint=None,
            )
        assert captured.value.code is ReplayErrorCode.COMMAND_ID_REUSED
    finally:
        await store.close()


async def test_failed_component_projection_rolls_back_entire_command_transaction(
    tmp_path: Path,
) -> None:
    store = await _created_store(tmp_path / "replay.db")
    command = {
        "protocol": "replay.v1",
        "command_id": "atomic-command",
        "client_instance_id": "tab-1",
        "expected_revision": 0,
        "type": "step",
        "payload": {"count": 1},
    }
    try:
        with pytest.raises(TypeError, match="orders contains an invalid record"):
            await store.commit_command(
                session_id="session-1",
                command=command,
                accepted=True,
                result={"ok": True},
                error_code=None,
                error_message=None,
                error_details={},
                session_state=_state(
                    source_sequence=1,
                    event_sequence=2,
                    revision=1,
                    command_log_offset=1,
                ),
                checkpoint=b"candidate",
                component_state={"orders": [{"not_an_order_id": "x"}]},
            )
        assert await store.get_command("session-1", "atomic-command") is None
        session = await store.get_session("session-1")
        assert session is not None
        assert session["command_log_offset"] == 0
        assert len(await store.load_valid_checkpoints("session-1")) == 1
    finally:
        await store.close()


async def test_source_event_commit_is_atomic_and_exact_retry_is_a_noop(
    tmp_path: Path,
) -> None:
    store = await _created_store(tmp_path / "replay.db")
    event = {"open_time_ms": 1_700_000_000_000, "close": "101"}
    state = _state(source_sequence=1, event_sequence=2)
    try:
        await store.commit_source_event(
            session_id="session-1",
            source_event=event,
            session_state=state,
            checkpoint=None,
        )
        await store.commit_source_event(
            session_id="session-1",
            source_event=event,
            session_state=state,
            checkpoint=None,
        )
        tail = await store.source_events_after("session-1", 0)
        assert len(tail) == 1
        assert tail[0]["event"] == event
        recovery_tail = await store.recovery_mutations_after(
            "session-1",
            mutation_id=0,
        )
        assert [item["source_sequence"] for item in recovery_tail] == [1]
        assert [item["event"] for item in recovery_tail] == [event]
        assert len(await store.load_valid_checkpoints("session-1")) == 1
    finally:
        await store.close()


async def test_source_event_retry_conflict_fails_closed_without_mutation(
    tmp_path: Path,
) -> None:
    store = await _created_store(tmp_path / "replay.db")
    event = {"open_time_ms": 1_700_000_000_000, "close": "101"}
    state = _state(source_sequence=1, event_sequence=2)
    try:
        await store.commit_source_event(
            session_id="session-1",
            source_event=event,
            session_state=state,
            checkpoint=None,
        )
        with pytest.raises(ReplayDomainError) as captured:
            await store.commit_source_event(
                session_id="session-1",
                source_event={**event, "close": "999"},
                session_state=state,
                checkpoint=None,
            )
        assert captured.value.code is ReplayErrorCode.DATASET_MISMATCH
        recovery_tail = await store.recovery_mutations_after(
            "session-1",
            mutation_id=0,
        )
        assert len(recovery_tail) == 1
        assert recovery_tail[0]["event"] == event
    finally:
        await store.close()


async def test_source_sequence_can_be_reused_after_durable_seek(
    tmp_path: Path,
) -> None:
    store = await _created_store(tmp_path / "replay.db")
    event = {"open_time_ms": 1_700_000_000_000, "close": "101"}
    first_state = _state(source_sequence=1, event_sequence=2)
    seek_state = _state(
        source_sequence=0,
        event_sequence=3,
        revision=1,
        command_log_offset=1,
    )
    replayed_state = _state(
        source_sequence=1,
        event_sequence=4,
        revision=1,
        command_log_offset=1,
    )
    try:
        await store.commit_source_event(
            session_id="session-1",
            source_event=event,
            session_state=first_state,
            checkpoint=None,
        )
        await store.commit_state(
            session_id="session-1",
            kind="seek",
            payload={"target_source_sequence": 0},
            session_state=seek_state,
            checkpoint=b"seek-checkpoint",
        )
        await store.commit_source_event(
            session_id="session-1",
            source_event=event,
            session_state=replayed_state,
            checkpoint=None,
        )
        recovery_tail = await store.recovery_mutations_after(
            "session-1",
            mutation_id=0,
        )
        assert [item["kind"] for item in recovery_tail] == [
            "source_event",
            "internal_state",
            "source_event",
        ]
        assert [
            item["source_sequence"]
            for item in recovery_tail
            if item["kind"] == "source_event"
        ] == [1, 1]
    finally:
        await store.close()


async def test_busy_retry_exhaustion_is_sticky_degraded(tmp_path: Path) -> None:
    store = await _created_store(
        tmp_path / "replay.db",
        busy_retry_delays=(0.0, 0.0, 0.0),
    )
    blocker = sqlite3.connect(store.path, timeout=0, isolation_level=None)
    blocker.execute("PRAGMA journal_mode=WAL")
    blocker.execute("BEGIN IMMEDIATE")
    try:
        with pytest.raises(ReplayDomainError) as captured:
            await store.commit_state(
                session_id="session-1",
                kind="test",
                payload={},
                session_state=_state(),
                checkpoint=b"checkpoint",
            )
        assert captured.value.code is ReplayErrorCode.PERSISTENCE_DEGRADED
        assert store.degraded_reason is not None
        assert store.diagnostics()["busy_exhaustions"] == 1
    finally:
        blocker.rollback()
        blocker.close()
    try:
        with pytest.raises(ReplayDomainError) as captured:
            await store.commit_state(
                session_id="session-1",
                kind="after-unlock",
                payload={},
                session_state=_state(),
                checkpoint=b"checkpoint",
            )
        assert captured.value.code is ReplayErrorCode.PERSISTENCE_DEGRADED
    finally:
        await store.close()


async def test_corrupt_latest_checkpoint_falls_back_and_dataset_checksum_fails_closed(
    tmp_path: Path,
) -> None:
    store = await _created_store(tmp_path / "replay.db")
    try:
        await store.commit_state(
            session_id="session-1",
            kind="checkpoint",
            payload={},
            session_state=_state(source_sequence=1, event_sequence=2),
            checkpoint=b"checkpoint-latest",
        )
        with sqlite3.connect(store.path) as connection:
            connection.execute(
                """
                UPDATE replay_checkpoint SET payload = X'00'
                WHERE checkpoint_id = (SELECT MAX(checkpoint_id) FROM replay_checkpoint)
                """
            )
        recovery_tail = await store.recovery_mutations_after(
            "session-1",
            mutation_id=0,
        )
        assert recovery_tail == (
            {
                "kind": "internal_state",
                "mutation_kind": "checkpoint",
                "checkpoint": b"checkpoint-latest",
                "state_hash": _state(
                    source_sequence=1,
                    event_sequence=2,
                )["state_hash"],
            },
        )
        checkpoints = await store.load_valid_checkpoints("session-1")
        assert len(checkpoints) == 1
        assert checkpoints[0].is_initial is True
        assert store.diagnostics()["corrupt_checkpoints_skipped"] == 1

        with sqlite3.connect(store.path) as connection:
            connection.execute(
                "UPDATE replay_dataset_ref SET snapshot_blob = X'7B7D' WHERE session_id = 'session-1'"
            )
        with pytest.raises(ReplayDomainError) as captured:
            await store.load_dataset("session-1")
        assert captured.value.code is ReplayErrorCode.DATASET_MISMATCH
    finally:
        await store.close()


async def test_checkpoint_retention_keeps_initial_plus_recent_budget(
    tmp_path: Path,
) -> None:
    store = await _created_store(tmp_path / "replay.db", max_recent_checkpoints=2)
    try:
        for sequence in range(1, 5):
            await store.commit_state(
                session_id="session-1",
                kind="checkpoint",
                payload={"sequence": sequence},
                session_state=_state(
                    source_sequence=sequence,
                    event_sequence=sequence + 1,
                ),
                checkpoint=f"checkpoint-{sequence}".encode(),
            )
        checkpoints = await store.load_valid_checkpoints("session-1")
        assert len(checkpoints) == 3
        assert sum(item.is_initial for item in checkpoints) == 1
        assert {
            item.source_sequence for item in checkpoints if not item.is_initial
        } == {3, 4}
    finally:
        await store.close()
