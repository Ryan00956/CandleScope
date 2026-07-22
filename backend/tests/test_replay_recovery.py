from __future__ import annotations

import asyncio
import sqlite3
from pathlib import Path

import pytest

from app.replay.constants import REPLAY_PROTOCOL, CommandType, SessionState
from app.replay.errors import ReplayDomainError, ReplayErrorCode
from app.replay.models import ReplayCommand
from app.replay.service import ReplayService
from app.replay.storage import ReplaySQLiteStore
from tests.fixtures.replay.service_fakes import (
    NOW_MS,
    SessionIdFactory,
    replay_config,
    replay_repository,
    replay_settings,
)


pytestmark = pytest.mark.anyio


def _command(
    command_id: str,
    command_type: CommandType,
    revision: int,
    payload: dict[str, object] | None = None,
) -> ReplayCommand:
    return ReplayCommand(
        protocol=REPLAY_PROTOCOL,
        command_id=command_id,
        client_instance_id="browser-tab-1",
        expected_revision=revision,
        type=command_type,
        payload=payload or {},
    )


async def _service(path: Path) -> ReplayService:
    store = ReplaySQLiteStore(path, now_ms=lambda: NOW_MS)
    service = ReplayService(
        settings=replay_settings(path),
        store=store,
        repository=replay_repository(),
        now_ms=lambda: NOW_MS,
        session_id_factory=SessionIdFactory("recovered"),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    return service


async def _durable_session(
    path: Path,
    *,
    playing: bool = False,
) -> tuple[str, str, int]:
    service = await _service(path)
    created = await service.create_session(replay_config())
    session_id = str(created["session_id"])
    await service.command(
        session_id,
        _command("acquire", CommandType.ACQUIRE_CONTROLLER, 0),
    )
    stepped = await service.command(
        session_id,
        _command("step", CommandType.STEP, 1, {"count": 2}),
    )
    if playing:
        await service.command(
            session_id,
            _command("play", CommandType.PLAY, 2),
        )
    await service.shutdown(step_timeout=1.0)
    return (
        session_id,
        str(stepped["state_hash"]),
        int(stepped["cursor"]["source_sequence"]),
    )


async def test_restart_recovers_paused_without_autoplay_and_matches_durable_hash(
    tmp_path: Path,
) -> None:
    path = tmp_path / "replay.db"
    session_id, _, _ = await _durable_session(path, playing=True)

    service = await _service(path)
    durable = await service.store.get_session(session_id)
    assert durable is not None
    recovered = await service.get_session(session_id)
    snapshot = recovered["snapshot"]
    assert snapshot["state"] == SessionState.PAUSED.value
    assert snapshot["status_reason"] == "recovered_after_restart"
    assert snapshot["controller_client_id"] is None
    assert snapshot["state_hash"] == durable["state_hash"]

    cursor_before = dict(snapshot["cursor"])
    await asyncio.sleep(0.03)
    cursor_after = (await service.get_session(session_id))["snapshot"]["cursor"]
    assert cursor_after == cursor_before
    await service.shutdown(step_timeout=1.0)


async def test_corrupt_recent_checkpoints_fall_back_and_replay_command_tail(
    tmp_path: Path,
) -> None:
    path = tmp_path / "replay.db"
    session_id, _, source_sequence = await _durable_session(path)
    with sqlite3.connect(path) as connection:
        connection.execute(
            "UPDATE replay_checkpoint SET payload = X'00' WHERE is_initial = 0"
        )
        connection.commit()

    service = await _service(path)
    recovered = await service.get_session(session_id)
    snapshot = recovered["snapshot"]
    assert snapshot["cursor"]["source_sequence"] == source_sequence
    assert snapshot["state"] == SessionState.PAUSED.value
    assert service.store.diagnostics()["corrupt_checkpoints_skipped"] >= 1
    await service.shutdown(step_timeout=1.0)


async def test_recovered_actor_retains_original_initial_checkpoint_for_seek(
    tmp_path: Path,
) -> None:
    path = tmp_path / "replay.db"
    service = await _service(path)
    created = await service.create_session(replay_config())
    session_id = str(created["session_id"])
    initial_time_ms = int(created["snapshot"]["cursor"]["virtual_time_ms"])
    await service.command(
        session_id,
        _command("acquire-before-restart", CommandType.ACQUIRE_CONTROLLER, 0),
    )
    stepped = await service.command(
        session_id,
        _command("step-before-restart", CommandType.STEP, 1, {"count": 4}),
    )
    assert stepped["cursor"]["source_sequence"] == 4
    await service.shutdown(step_timeout=1.0)

    recovered_service = await _service(path)
    recovered = (await recovered_service.get_session(session_id))["snapshot"]
    acquired = await recovered_service.command(
        session_id,
        _command(
            "acquire-after-restart",
            CommandType.ACQUIRE_CONTROLLER,
            int(recovered["revision"]),
        ),
    )
    sought = await recovered_service.command(
        session_id,
        _command(
            "seek-after-restart",
            CommandType.SEEK_TO,
            int(acquired["revision"]),
            {"virtual_time_ms": initial_time_ms},
        ),
    )
    assert sought["cursor"]["source_sequence"] == 0
    await recovered_service.shutdown(step_timeout=1.0)


@pytest.mark.parametrize("corrupt_latest", [False, True])
async def test_v1_recovery_uses_only_exact_latest_legacy_checkpoint(
    tmp_path: Path,
    corrupt_latest: bool,
) -> None:
    path = tmp_path / "legacy.db"
    session_id, _state_hash, _source_sequence = await _durable_session(path)
    with sqlite3.connect(path) as connection:
        connection.row_factory = sqlite3.Row
        durable = connection.execute(
            "SELECT * FROM replay_session WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        assert durable is not None
        if corrupt_latest:
            # Make every older row look identical at the V1 metadata level.
            # Recovery must still reject it after the physical latest row is
            # corrupted because speed/controller/status are not hash-bound.
            connection.execute(
                """
                UPDATE replay_checkpoint
                SET source_sequence = ?, command_log_offset = ?,
                    event_sequence = ?, state_hash = ?, created_at_ms = ?
                WHERE session_id = ?
                """,
                (
                    durable["source_sequence"],
                    durable["command_log_offset"],
                    durable["event_sequence"],
                    durable["state_hash"],
                    durable["updated_at_ms"],
                    session_id,
                ),
            )
            connection.execute(
                """
                UPDATE replay_checkpoint SET payload = X'00'
                WHERE checkpoint_id = (
                    SELECT MAX(checkpoint_id) FROM replay_checkpoint
                    WHERE session_id = ?
                )
                """,
                (session_id,),
            )
        connection.execute("ALTER TABLE replay_checkpoint DROP COLUMN mutation_id")
        connection.execute(
            "UPDATE replay_schema_version SET version = 1 WHERE singleton = 1"
        )

    recovered_service = await _service(path)
    try:
        if corrupt_latest:
            with pytest.raises(ReplayDomainError) as captured:
                await recovered_service.get_session(session_id)
            assert captured.value.code is ReplayErrorCode.DATASET_MISMATCH
        else:
            snapshot = (await recovered_service.get_session(session_id))["snapshot"]
            assert snapshot["state"] == SessionState.PAUSED.value
            assert snapshot["state_hash"] == _state_hash
            assert snapshot["cursor"]["source_sequence"] == _source_sequence
    finally:
        await recovered_service.shutdown(step_timeout=1.0)


async def test_old_checkpoint_replays_play_command_and_autonomous_source_tail(
    tmp_path: Path,
) -> None:
    path = tmp_path / "replay.db"
    service = await _service(path)
    created = await service.create_session(replay_config())
    session_id = str(created["session_id"])
    acquired = await service.command(
        session_id,
        _command("acquire", CommandType.ACQUIRE_CONTROLLER, 0),
    )
    speed = await service.command(
        session_id,
        _command(
            "speed", CommandType.SET_SPEED, acquired["revision"], {"speed": "MAX"}
        ),
    )
    await service.command(
        session_id,
        _command("play", CommandType.PLAY, speed["revision"]),
    )
    for _ in range(100):
        snapshot = (await service.get_session(session_id))["snapshot"]
        if snapshot["state"] == SessionState.ENDED.value:
            break
        await asyncio.sleep(0)
    else:
        raise AssertionError("MAX replay did not reach ENDED")
    final_hash = str(snapshot["state_hash"])
    final_source = int(snapshot["cursor"]["source_sequence"])
    await service.shutdown(step_timeout=1.0)

    with sqlite3.connect(path) as connection:
        connection.execute(
            "UPDATE replay_checkpoint SET payload = X'00' WHERE is_initial = 0"
        )
        connection.commit()
    recovered_service = await _service(path)
    recovered = (await recovered_service.get_session(session_id))["snapshot"]
    assert recovered["state"] == SessionState.ENDED.value
    assert recovered["state_hash"] == final_hash
    assert recovered["cursor"]["source_sequence"] == final_source
    await recovered_service.shutdown(step_timeout=1.0)


async def test_recovery_tail_preserves_autonomous_events_replayed_after_seek(
    tmp_path: Path,
) -> None:
    path = tmp_path / "rewound-autonomous.db"
    service = await _service(path)
    created = await service.create_session(replay_config())
    session_id = str(created["session_id"])
    initial_time_ms = int(created["snapshot"]["cursor"]["virtual_time_ms"])

    acquired = await service.command(
        session_id,
        _command("acquire-rewind", CommandType.ACQUIRE_CONTROLLER, 0),
    )
    fast = await service.command(
        session_id,
        _command(
            "speed-rewind",
            CommandType.SET_SPEED,
            int(acquired["revision"]),
            {"speed": "MAX"},
        ),
    )
    playing = await service.command(
        session_id,
        _command("play-before-rewind", CommandType.PLAY, int(fast["revision"])),
    )
    paused = await service.command(
        session_id,
        _command("pause-before-rewind", CommandType.PAUSE, int(playing["revision"])),
    )
    first_pass_sequence = int(paused["cursor"]["source_sequence"])
    assert 0 < first_pass_sequence < 6

    sought = await service.command(
        session_id,
        _command(
            "seek-rewind",
            CommandType.SEEK_TO,
            int(paused["revision"]),
            {"virtual_time_ms": initial_time_ms},
        ),
    )
    assert sought["cursor"]["source_sequence"] == 0
    fast_after_seek = await service.command(
        session_id,
        _command(
            "speed-after-rewind",
            CommandType.SET_SPEED,
            int(sought["revision"]),
            {"speed": "MAX"},
        ),
    )
    await service.command(
        session_id,
        _command(
            "play-after-rewind",
            CommandType.PLAY,
            int(fast_after_seek["revision"]),
        ),
    )
    for _ in range(400):
        final_snapshot = (await service.get_session(session_id))["snapshot"]
        if final_snapshot["state"] == SessionState.ENDED.value:
            break
        await asyncio.sleep(0.005)
    else:
        raise AssertionError("MAX replay did not finish after rewind")
    final_hash = str(final_snapshot["state_hash"])
    final_source_sequence = int(final_snapshot["cursor"]["source_sequence"])
    await service.shutdown(step_timeout=1.0)

    with sqlite3.connect(path) as connection:
        seek_mutation_id = connection.execute(
            """
            SELECT mutation_id FROM replay_mutation_log
            WHERE session_id = ? AND command_id = 'seek-rewind'
            """,
            (session_id,),
        ).fetchone()[0]
        repeated_rows = connection.execute(
            """
            SELECT source_sequence, COUNT(*)
            FROM replay_mutation_log
            WHERE session_id = ? AND kind = 'source_event'
            GROUP BY source_sequence HAVING COUNT(*) > 1
            """,
            (session_id,),
        ).fetchall()
        assert repeated_rows
        connection.execute(
            """
            UPDATE replay_checkpoint SET payload = X'00'
            WHERE session_id = ? AND mutation_id > ?
            """,
            (session_id, seek_mutation_id),
        )

    recovered_service = await _service(path)
    recovered = (await recovered_service.get_session(session_id))["snapshot"]
    assert recovered["state"] == SessionState.ENDED.value
    assert recovered["state_hash"] == final_hash
    assert recovered["cursor"]["source_sequence"] == final_source_sequence
    assert recovered_service.store.diagnostics()["corrupt_checkpoints_skipped"] >= 1
    await recovered_service.shutdown(step_timeout=1.0)


@pytest.mark.parametrize("target", ["dataset", "checkpoint"])
async def test_dataset_or_all_checkpoint_corruption_fails_closed_per_session(
    tmp_path: Path,
    target: str,
) -> None:
    path = tmp_path / "replay.db"
    session_id, _, _ = await _durable_session(path)
    with sqlite3.connect(path) as connection:
        if target == "dataset":
            connection.execute(
                "UPDATE replay_dataset_ref SET snapshot_blob = X'00' WHERE session_id = ?",
                (session_id,),
            )
        else:
            connection.execute(
                "UPDATE replay_checkpoint SET payload = X'00' WHERE session_id = ?",
                (session_id,),
            )
        connection.commit()

    service = await _service(path)
    with pytest.raises(ReplayDomainError) as unavailable:
        await service.get_session(session_id)
    assert unavailable.value.code is ReplayErrorCode.DATASET_MISMATCH
    diagnostics = service.diagnostics(redact_paths=True)
    assert diagnostics["recovery_failures"] == 1
    assert diagnostics["persistence"]["path"] == "<redacted>"
    await service.shutdown(step_timeout=1.0)
