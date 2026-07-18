from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from app.replay.constants import REPLAY_PROTOCOL, CommandType, SessionState
from app.replay.models import ReplayCommand
from app.replay.service import ReplayService, SYNTHETIC_TIME_ANCHOR_MS
from app.replay.storage import ReplaySQLiteStore
from tests.fixtures.replay.service_fakes import (
    INTERVAL_MS,
    NOW_MS,
    START_MS,
    SessionIdFactory,
    replay_config,
    replay_repository,
    replay_settings,
)


pytestmark = pytest.mark.anyio


def _command(
    command_id: str,
    command_type: CommandType,
    *,
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


async def _service(path: Path, *, prefix: str = "session") -> ReplayService:
    settings = replay_settings(path)
    store = ReplaySQLiteStore(path, now_ms=lambda: NOW_MS)
    service = ReplayService(
        settings=settings,
        store=store,
        repository=replay_repository(),
        now_ms=lambda: NOW_MS,
        session_id_factory=SessionIdFactory(prefix),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    return service


async def test_service_create_command_idempotency_fork_and_shutdown(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "replay.db")
    created = await service.create_session(replay_config())
    session_id = str(created["session_id"])
    assert created["protocol"] == REPLAY_PROTOCOL
    assert created["snapshot"]["state"] == SessionState.PAUSED.value

    acquired = await service.command(
        session_id,
        _command("acquire-1", CommandType.ACQUIRE_CONTROLLER, revision=0),
    )
    step = _command("step-1", CommandType.STEP, revision=1, payload={"count": 2})
    stepped = await service.command(session_id, step)
    replayed = await service.command(session_id, step)
    assert acquired["revision"] == 1
    assert stepped == replayed
    assert stepped["cursor"]["source_sequence"] == 2
    noted = await service.command(
        session_id,
        _command(
            "note-1",
            CommandType.ADD_JOURNAL_NOTE,
            revision=2,
            payload={"text": "waited for confirmation"},
        ),
    )
    journal = await service.journal(session_id)
    assert journal["entries"][0]["text"] == "waited for confirmation"

    forked = await service.fork_session(session_id)
    assert forked["forked"] is True
    assert forked["forked_from_session_id"] == session_id
    assert forked["snapshot"]["state_hash"] == noted["state_hash"]
    assert forked["session_id"] != session_id

    tasks = [handle.actor.task for handle in service._sessions.values()]
    await service.shutdown(step_timeout=0.2)
    assert service.store.closed is True
    assert all(task is not None and task.done() for task in tasks)
    with sqlite3.connect(tmp_path / "replay.db") as connection:
        assert (
            connection.execute(
                "SELECT COUNT(*) FROM replay_journal_entry WHERE session_id = ?",
                (session_id,),
            ).fetchone()[0]
            == 1
        )


async def test_blind_service_redacts_actual_time_until_explicit_reveal(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "replay.db", prefix="blind")
    created = await service.create_session(replay_config(blind_mode=True))
    session_id = str(created["session_id"])
    serialized = json.dumps(created, sort_keys=True)
    assert str(START_MS) not in serialized
    assert str(tmp_path) not in serialized
    assert created["snapshot"]["cursor"]["virtual_time_ms"] == SYNTHETIC_TIME_ANCHOR_MS

    await service.command(
        session_id,
        _command("acquire", CommandType.ACQUIRE_CONTROLLER, revision=0),
    )
    ended = await service.command(
        session_id,
        _command(
            "end",
            CommandType.END_SESSION,
            revision=1,
            payload={
                "open_order_disposition": "expire",
                "position_disposition": "keep",
            },
        ),
    )
    assert ended["state"] == SessionState.ENDED.value
    await service.command(
        session_id,
        _command("acquire-ended", CommandType.ACQUIRE_CONTROLLER, revision=2),
    )
    revealed = await service.command(
        session_id,
        _command("reveal", CommandType.REVEAL_HISTORY, revision=3),
    )
    assert revealed["data"]["actual_history"] == {
        "replay_start_ms": START_MS + 4 * INTERVAL_MS,
        "replay_end_open_ms": START_MS + 8 * INTERVAL_MS,
    }
    await service.shutdown(step_timeout=0.2)
