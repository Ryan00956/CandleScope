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
    await service.shutdown(step_timeout=0.2)
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
    await service.shutdown(step_timeout=0.2)


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
    await service.shutdown(step_timeout=0.2)


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
    await service.shutdown(step_timeout=0.2)

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
    await recovered_service.shutdown(step_timeout=0.2)


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
    await service.shutdown(step_timeout=0.2)
