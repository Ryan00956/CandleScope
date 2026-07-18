from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from app.replay.constants import REPLAY_PROTOCOL, CommandType, SessionState
from app.replay.errors import ReplayDomainError, ReplayErrorCode
from app.replay.models import ReplayCommand
from app.replay.runtime import ReplayStartupError, start_replay_runtime
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
    command_id: str, command_type: CommandType, revision: int
) -> ReplayCommand:
    return ReplayCommand(
        protocol=REPLAY_PROTOCOL,
        command_id=command_id,
        client_instance_id="browser-tab-1",
        expected_revision=revision,
        type=command_type,
        payload={"count": 1} if command_type is CommandType.STEP else {},
    )


async def _service(path: Path) -> ReplayService:
    store = ReplaySQLiteStore(path, now_ms=lambda: NOW_MS)
    service = ReplayService(
        settings=replay_settings(path),
        store=store,
        repository=replay_repository(),
        now_ms=lambda: NOW_MS,
        session_id_factory=SessionIdFactory(),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    return service


async def test_disabled_runtime_opens_no_database_and_starts_no_replay_task(
    tmp_path: Path,
) -> None:
    path = tmp_path / "disabled.db"
    called = False

    def forbidden_store(_path: str) -> ReplaySQLiteStore:
        nonlocal called
        called = True
        raise AssertionError("disabled replay must not construct a store")

    before = {task.get_name() for task in asyncio.all_tasks()}
    runtime = await start_replay_runtime(
        replay_settings(path, enabled=False),
        store_factory=forbidden_store,
    )
    after = {task.get_name() for task in asyncio.all_tasks()}
    assert runtime.service is None
    assert called is False
    assert not path.exists()
    assert not any(name.startswith("replay-actor-") for name in after - before)
    await runtime.shutdown()


async def test_enabled_runtime_start_failure_closes_store_and_fails_startup(
    tmp_path: Path,
) -> None:
    path = tmp_path / "failed.db"
    store = ReplaySQLiteStore(path, now_ms=lambda: NOW_MS)

    def service_failure(**_kwargs):
        raise RuntimeError("injected service construction failure")

    with pytest.raises(ReplayStartupError):
        await start_replay_runtime(
            replay_settings(path),
            store_factory=lambda _path: store,
            service_factory=service_failure,
        )
    assert store.closed is True


async def test_persistence_failure_rolls_back_event_and_stops_further_playback(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = await _service(tmp_path / "replay.db")
    created = await service.create_session(replay_config())
    session_id = str(created["session_id"])
    await service.command(
        session_id,
        _command("acquire", CommandType.ACQUIRE_CONTROLLER, 0),
    )
    original = service.store.commit_command

    async def fail_commit(**_kwargs):
        service.store._degraded_reason = "injected durable write failure"
        raise ReplayDomainError(
            ReplayErrorCode.PERSISTENCE_DEGRADED,
            "injected durable write failure",
        )

    monkeypatch.setattr(service.store, "commit_command", fail_commit)
    with pytest.raises(ReplayDomainError) as failed:
        await service.command(session_id, _command("step", CommandType.STEP, 1))
    assert failed.value.code is ReplayErrorCode.PERSISTENCE_DEGRADED
    snapshot = (await service.get_session(session_id))["snapshot"]
    assert snapshot["state"] == SessionState.PAUSED.value
    assert snapshot["cursor"]["source_sequence"] == 0
    assert snapshot["degraded_reason"] is not None
    assert service.capabilities()["available"] is False

    with pytest.raises(ReplayDomainError) as sticky:
        await service.command(session_id, _command("step-2", CommandType.STEP, 1))
    assert sticky.value.code is ReplayErrorCode.PERSISTENCE_DEGRADED

    monkeypatch.setattr(service.store, "commit_command", original)
    service.store._degraded_reason = None
    await service.shutdown(step_timeout=0.2)


async def test_shutdown_finishes_actor_barriers_before_closing_store(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = await _service(tmp_path / "replay.db")
    await service.create_session(replay_config())
    actors = [handle.actor for handle in service._sessions.values()]
    original_close = service.store.close
    close_observation: list[bool] = []

    async def observed_close() -> None:
        close_observation.append(
            all(actor.task is not None and actor.task.done() for actor in actors)
        )
        await original_close()

    monkeypatch.setattr(service.store, "close", observed_close)
    await service.shutdown(step_timeout=0.2)
    assert close_observation == [True]
    assert all(actor.task is not None and actor.task.done() for actor in actors)
