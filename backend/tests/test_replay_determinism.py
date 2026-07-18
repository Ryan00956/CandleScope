from __future__ import annotations

import asyncio
import json
from functools import wraps
from pathlib import Path

from app.replay.actor import ReplaySessionActor
from app.replay.constants import REPLAY_PROTOCOL, CommandType, SessionState
from app.replay.models import ReplayCommand
from tests.fixtures.replay.actor_fakes import (
    CountingReducer,
    event_fixture,
    session_config,
    source_factory,
)


FIXTURE_PATH = Path(__file__).parent / "fixtures" / "replay" / "actor_determinism_v1.json"


def _async_test(function):
    @wraps(function)
    def _wrapped(*args, **kwargs):
        return asyncio.run(function(*args, **kwargs))

    return _wrapped


def _command(
    command_id: str,
    command_type: CommandType,
    revision: int,
    payload: dict[str, object] | None = None,
) -> ReplayCommand:
    return ReplayCommand(
        protocol=REPLAY_PROTOCOL,
        command_id=command_id,
        client_instance_id="determinism-client",
        expected_revision=revision,
        type=command_type,
        payload=payload or {},
    )


def _actor(*, restore_checkpoint: bytes | None = None) -> ReplaySessionActor:
    events = event_fixture(count=6, step_ms=1)
    return ReplaySessionActor(
        session_id="session-determinism",
        config=session_config(),
        source_factory=source_factory(events),
        initial_virtual_time_ms=1_000,
        command_queue_size=8,
        event_buffer_size=64,
        max_emit_fps=30,
        controller_ttl_seconds=5,
        checkpoint_event_interval=1,
        checkpoint_virtual_ms=100,
        reducer=CountingReducer(),
        restore_checkpoint=restore_checkpoint,
    )


async def _wait_ended(actor: ReplaySessionActor) -> None:
    async def _wait() -> None:
        while (await actor.snapshot()).state is not SessionState.ENDED:
            await asyncio.sleep(0.001)

    await asyncio.wait_for(_wait(), timeout=0.5)


async def _run_path(path: str) -> tuple[str, int, int]:
    actor = _actor()
    await actor.start()
    await actor.submit(_command(f"{path}-acquire", CommandType.ACQUIRE_CONTROLLER, 0))
    revision = 1
    if path in {"MAX", "60x"}:
        speed: int | str = "MAX" if path == "MAX" else 60
        await actor.submit(
            _command(f"{path}-speed", CommandType.SET_SPEED, revision, {"speed": speed})
        )
        revision += 1
    if path in {"1x", "60x", "MAX"}:
        await actor.submit(_command(f"{path}-play", CommandType.PLAY, revision))
        await _wait_ended(actor)
    elif path == "step":
        await actor.submit(
            _command("step-all", CommandType.STEP, revision, {"count": 6})
        )
    elif path == "advance":
        await actor.submit(
            _command("advance-all", CommandType.ADVANCE_BY, revision, {"ms": 6})
        )
    else:
        raise AssertionError(path)
    snapshot = await actor.snapshot()
    result = (
        snapshot.state_hash,
        snapshot.cursor.virtual_time_ms,
        snapshot.cursor.source_sequence,
    )
    await actor.shutdown()
    return result


@_async_test
async def test_play_step_advance_and_checkpoint_restore_have_one_golden_state_hash() -> None:
    results = {
        path: await _run_path(path)
        for path in ("1x", "60x", "MAX", "step", "advance")
    }

    prefix = _actor()
    await prefix.start()
    await prefix.submit(_command("prefix-acquire", CommandType.ACQUIRE_CONTROLLER, 0))
    await prefix.submit(_command("prefix-step", CommandType.STEP, 1, {"count": 3}))
    checkpoint = prefix.latest_checkpoint_blob()
    assert checkpoint is not None
    await prefix.shutdown()

    restored = _actor(restore_checkpoint=checkpoint)
    await restored.start()
    restored_revision = (await restored.snapshot()).revision
    await restored.submit(
        _command("restore-acquire", CommandType.ACQUIRE_CONTROLLER, restored_revision)
    )
    await restored.submit(
        _command(
            "restore-speed",
            CommandType.SET_SPEED,
            restored_revision + 1,
            {"speed": "MAX"},
        )
    )
    await restored.submit(
        _command("restore-play", CommandType.PLAY, restored_revision + 2)
    )
    await _wait_ended(restored)
    restored_snapshot = await restored.snapshot()
    results["restore+play"] = (
        restored_snapshot.state_hash,
        restored_snapshot.cursor.virtual_time_ms,
        restored_snapshot.cursor.source_sequence,
    )
    await restored.shutdown()

    assert len(set(results.values())) == 1, results
    fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    assert results["MAX"][0] == fixture["state_hash"]
    assert results["MAX"][1] == fixture["virtual_time_ms"]
    assert results["MAX"][2] == fixture["source_sequence"]
