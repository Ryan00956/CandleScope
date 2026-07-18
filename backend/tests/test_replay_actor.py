from __future__ import annotations

import asyncio
from functools import wraps

import pytest

from app.replay.actor import ReplaySessionActor
from app.replay.checkpoints import CheckpointCodec
from app.replay.constants import REPLAY_PROTOCOL, CommandType, SessionState
from app.replay.errors import ReplayDomainError, ReplayErrorCode
from app.replay.models import ReplayCommand
from tests.fixtures.replay.actor_fakes import (
    DATA_EPOCH,
    CountingReducer,
    FixtureEvent,
    FixtureSource,
    GateReducer,
    event_fixture,
    session_config,
    source_factory,
)


def _async_test(function):
    @wraps(function)
    def _wrapped(*args, **kwargs):
        return asyncio.run(function(*args, **kwargs))

    return _wrapped


def _command(
    command_id: str,
    command_type: CommandType,
    *,
    revision: int,
    client: str = "tab-a",
    payload: dict[str, object] | None = None,
) -> ReplayCommand:
    return ReplayCommand(
        protocol=REPLAY_PROTOCOL,
        command_id=command_id,
        client_instance_id=client,
        expected_revision=revision,
        type=command_type,
        payload=payload or {},
    )


async def _wait_for_state(
    actor: ReplaySessionActor,
    expected: SessionState,
    *,
    timeout: float = 0.5,
) -> None:
    async def _wait() -> None:
        while True:
            if (await actor.snapshot()).state is expected:
                return
            await asyncio.sleep(0.001)

    await asyncio.wait_for(_wait(), timeout=timeout)


def _actor(**kwargs) -> ReplaySessionActor:
    events = kwargs.pop("events", event_fixture())
    return ReplaySessionActor(
        session_id="session-actor",
        config=kwargs.pop("config", session_config()),
        source_factory=source_factory(events),
        initial_virtual_time_ms=1_000,
        command_queue_size=kwargs.pop("command_queue_size", 8),
        event_buffer_size=kwargs.pop("event_buffer_size", 64),
        max_emit_fps=30,
        controller_ttl_seconds=kwargs.pop("controller_ttl_seconds", 1.0),
        checkpoint_event_interval=kwargs.pop("checkpoint_event_interval", 2),
        checkpoint_virtual_ms=kwargs.pop("checkpoint_virtual_ms", 1_000),
        **kwargs,
    )


@_async_test
async def test_actor_state_machine_controller_requirement_and_illegal_transitions() -> (
    None
):
    actor = _actor()
    await actor.start()
    initial = await actor.snapshot()
    assert initial.state is SessionState.PAUSED
    assert initial.revision == 0

    with pytest.raises(ReplayDomainError) as no_controller:
        await actor.submit(_command("play-none", CommandType.PLAY, revision=0))
    assert no_controller.value.code is ReplayErrorCode.CONTROLLER_CONFLICT

    acquired = await actor.submit(
        _command("acquire", CommandType.ACQUIRE_CONTROLLER, revision=0)
    )
    assert acquired.revision == 1
    stepped = await actor.submit(
        _command("step", CommandType.STEP, revision=1, payload={"count": 1})
    )
    assert stepped.cursor.source_sequence == 1
    assert stepped.cursor.virtual_time_ms == 1_100

    playing = await actor.submit(_command("play", CommandType.PLAY, revision=2))
    assert playing.state is SessionState.PLAYING
    with pytest.raises(ReplayDomainError) as step_while_playing:
        await actor.submit(
            _command("bad-step", CommandType.STEP, revision=3, payload={"count": 1})
        )
    assert step_while_playing.value.code is ReplayErrorCode.INVALID_STATE_TRANSITION

    paused = await actor.submit(_command("pause", CommandType.PAUSE, revision=3))
    assert paused.state is SessionState.PAUSED
    ended = await actor.submit(_command("end", CommandType.END_SESSION, revision=4))
    assert ended.state is SessionState.ENDED
    with pytest.raises(ReplayDomainError) as ended_play:
        await actor.submit(_command("play-ended", CommandType.PLAY, revision=5))
    assert ended_play.value.code is ReplayErrorCode.SESSION_ENDED
    await actor.shutdown()


@_async_test
async def test_same_timestamp_events_and_long_gap_are_consumed_in_source_order() -> (
    None
):
    events = (
        FixtureEvent(event_time_ms=1_100, value=1),
        FixtureEvent(event_time_ms=1_100, value=2),
        FixtureEvent(event_time_ms=101_100, value=3),
    )
    reducer = CountingReducer()
    actor = _actor(events=events, reducer=reducer)
    await actor.start()
    await actor.submit(_command("acquire", CommandType.ACQUIRE_CONTROLLER, revision=0))
    first = await actor.submit(
        _command(
            "advance-same-time", CommandType.ADVANCE_BY, revision=1, payload={"ms": 100}
        )
    )
    assert first.data["consumed"] == 2
    assert first.cursor.source_sequence == 2
    assert reducer.snapshot() == {"count": 2, "total": 3}

    final = await actor.submit(
        _command(
            "advance-long-gap",
            CommandType.ADVANCE_BY,
            revision=2,
            payload={"ms": 100_000},
        )
    )
    assert final.data["consumed"] == 1
    assert final.cursor.source_sequence == 3
    assert reducer.snapshot() == {"count": 3, "total": 6}
    await actor.shutdown()


@_async_test
async def test_reducer_failure_does_not_advance_source_cursor_or_partial_state() -> (
    None
):
    class RejectingReducer(CountingReducer):
        def apply_source_event(self, event: FixtureEvent):
            del event
            raise ReplayDomainError(
                ReplayErrorCode.ORDER_REJECTED,
                "injected atomic reducer failure",
            )

    reducer = RejectingReducer()
    actor = _actor(reducer=reducer, events=event_fixture(count=2))
    await actor.start()
    await actor.submit(
        _command("acquire-atomic", CommandType.ACQUIRE_CONTROLLER, revision=0)
    )
    with pytest.raises(ReplayDomainError) as failure:
        await actor.submit(
            _command(
                "step-atomic",
                CommandType.STEP,
                revision=1,
                payload={"count": 1},
            )
        )
    assert failure.value.code is ReplayErrorCode.ORDER_REJECTED
    snapshot = await actor.snapshot()
    assert snapshot.state is SessionState.ERROR
    assert snapshot.cursor.source_sequence == 0
    assert reducer.snapshot() == {"count": 0, "total": 0}
    await actor.shutdown()


@_async_test
async def test_step_overrun_is_rejected_without_partial_mutation() -> None:
    actor = _actor(reducer=CountingReducer())
    await actor.start()
    await actor.submit(_command("acquire", CommandType.ACQUIRE_CONTROLLER, revision=0))
    with pytest.raises(ReplayDomainError) as overrun:
        await actor.submit(
            _command("too-many", CommandType.STEP, revision=1, payload={"count": 6})
        )
    assert overrun.value.code is ReplayErrorCode.SESSION_ENDED
    snapshot = await actor.snapshot()
    assert snapshot.revision == 1
    assert snapshot.cursor.source_sequence == 0
    await actor.shutdown()


@_async_test
async def test_actor_command_idempotency_revision_conflict_and_id_reuse() -> None:
    actor = _actor()
    await actor.start()
    await actor.submit(_command("acquire", CommandType.ACQUIRE_CONTROLLER, revision=0))
    step = _command("same-step", CommandType.STEP, revision=1, payload={"count": 1})
    first = await actor.submit(step)
    second = await actor.submit(step)
    assert second == first
    assert (await actor.snapshot()).cursor.source_sequence == 1

    with pytest.raises(ReplayDomainError) as reused:
        await actor.submit(
            _command("same-step", CommandType.STEP, revision=1, payload={"count": 2})
        )
    assert reused.value.code is ReplayErrorCode.COMMAND_ID_REUSED

    stale = _command("stale", CommandType.PAUSE, revision=1)
    for _ in range(2):
        with pytest.raises(ReplayDomainError) as conflict:
            await actor.submit(stale)
        assert conflict.value.code is ReplayErrorCode.REVISION_CONFLICT
        assert conflict.value.details["latest_revision"] == 2
    assert (await actor.snapshot()).revision == 2
    await actor.shutdown()


@_async_test
async def test_command_history_capacity_is_checked_before_domain_mutation() -> None:
    actor = _actor(max_command_records=1)
    await actor.start()
    await actor.submit(_command("acquire", CommandType.ACQUIRE_CONTROLLER, revision=0))

    with pytest.raises(ReplayDomainError) as full:
        await actor.submit(
            _command(
                "step-over-capacity", CommandType.STEP, revision=1, payload={"count": 1}
            )
        )
    assert full.value.code is ReplayErrorCode.SCAN_LIMIT_EXCEEDED
    snapshot = await actor.snapshot()
    assert snapshot.revision == 1
    assert snapshot.cursor.source_sequence == 0
    await actor.shutdown()


@_async_test
async def test_source_factory_identity_change_fails_before_event_mutation() -> None:
    events = event_fixture()
    calls = 0

    class ChangedSnapshotSource(FixtureSource):
        def snapshot_ref(self) -> dict[str, str]:
            return {
                "data_epoch": DATA_EPOCH,
                "schema_version": "fixture-source.changed",
            }

    def unstable_factory() -> FixtureSource:
        nonlocal calls
        calls += 1
        if calls == 1:
            return FixtureSource(events)
        return ChangedSnapshotSource(events)

    actor = ReplaySessionActor(
        session_id="session-unstable-source",
        config=session_config(),
        source_factory=unstable_factory,
        initial_virtual_time_ms=1_000,
        command_queue_size=8,
        event_buffer_size=64,
        max_emit_fps=30,
        controller_ttl_seconds=1,
        checkpoint_event_interval=2,
        checkpoint_virtual_ms=1_000,
    )
    await actor.start()
    await actor.submit(_command("acquire", CommandType.ACQUIRE_CONTROLLER, revision=0))
    with pytest.raises(ReplayDomainError) as mismatch:
        await actor.submit(
            _command("step", CommandType.STEP, revision=1, payload={"count": 1})
        )
    assert mismatch.value.code is ReplayErrorCode.DATASET_MISMATCH
    snapshot = await actor.snapshot()
    assert snapshot.revision == 1
    assert snapshot.cursor.source_sequence == 0
    await actor.shutdown()


@_async_test
async def test_controller_takeover_heartbeat_release_and_ttl_auto_pause() -> None:
    actor = _actor(controller_ttl_seconds=0.03)
    await actor.start()
    await actor.submit(
        _command("acquire-a", CommandType.ACQUIRE_CONTROLLER, revision=0)
    )
    with pytest.raises(ReplayDomainError) as held:
        await actor.submit(
            _command(
                "acquire-b-no",
                CommandType.ACQUIRE_CONTROLLER,
                revision=1,
                client="tab-b",
            )
        )
    assert held.value.code is ReplayErrorCode.CONTROLLER_CONFLICT
    takeover = await actor.submit(
        _command(
            "acquire-b-yes",
            CommandType.ACQUIRE_CONTROLLER,
            revision=1,
            client="tab-b",
            payload={"takeover": True},
        )
    )
    assert takeover.revision == 2
    with pytest.raises(ReplayDomainError):
        await actor.heartbeat("tab-a")
    await actor.heartbeat("tab-b")

    await actor.submit(_command("play-b", CommandType.PLAY, revision=2, client="tab-b"))
    await _wait_for_state(actor, SessionState.PAUSED, timeout=0.3)
    expired = await actor.snapshot()
    assert expired.controller_client_id is None
    assert expired.revision == 4
    assert actor.diagnostics()["controller_expirations"] == 1
    await actor.shutdown()


@_async_test
async def test_pause_ack_waits_for_atomic_event_and_queue_overflow_is_diagnostic() -> (
    None
):
    reducer = GateReducer()
    actor = _actor(
        reducer=reducer,
        command_queue_size=1,
        events=event_fixture(step_ms=1),
    )
    await actor.start()
    await actor.submit(_command("acquire", CommandType.ACQUIRE_CONTROLLER, revision=0))
    await actor.submit(
        _command("speed", CommandType.SET_SPEED, revision=1, payload={"speed": "MAX"})
    )
    await actor.submit(_command("play", CommandType.PLAY, revision=2))
    await asyncio.wait_for(reducer.started.wait(), timeout=0.2)

    pause_task = asyncio.create_task(
        actor.submit(_command("pause", CommandType.PAUSE, revision=3))
    )
    await asyncio.sleep(0)
    assert not pause_task.done()
    with pytest.raises(ReplayDomainError) as full:
        await actor.submit(
            _command("queued-step", CommandType.STEP, revision=3, payload={"count": 1})
        )
    assert full.value.code is ReplayErrorCode.SCAN_LIMIT_EXCEEDED

    reducer.release.set()
    paused = await asyncio.wait_for(pause_task, timeout=0.2)
    assert paused.cursor.source_sequence == 1
    sequence_at_ack = paused.sequence
    await asyncio.sleep(0.02)
    after = await actor.snapshot()
    assert after.cursor.source_sequence == 1
    assert after.sequence == sequence_at_ack
    diagnostics = actor.diagnostics()
    assert diagnostics["command_queue_overflows"] == 1
    assert diagnostics["command_queue_high_water"] == 1
    assert diagnostics["pause_latency_ms"]["samples"] == 1
    await actor.shutdown()


@_async_test
async def test_seek_uses_checkpoint_rebuild_and_trading_state_fails_closed() -> None:
    reducer = CountingReducer()
    actor = _actor(reducer=reducer, checkpoint_event_interval=2)
    await actor.start()
    await actor.submit(_command("acquire", CommandType.ACQUIRE_CONTROLLER, revision=0))
    await actor.submit(
        _command("step-four", CommandType.STEP, revision=1, payload={"count": 4})
    )
    sought = await actor.submit(
        _command(
            "seek",
            CommandType.SEEK_TO,
            revision=2,
            payload={"virtual_time_ms": 1_250},
        )
    )
    assert sought.cursor.virtual_time_ms == 1_250
    assert sought.cursor.source_sequence == 2
    assert reducer.snapshot() == {"count": 2, "total": 3}

    fresh = _actor(reducer=CountingReducer())
    await fresh.start()
    await fresh.submit(
        _command("fresh-acquire", CommandType.ACQUIRE_CONTROLLER, revision=0)
    )
    advanced = await fresh.submit(
        _command(
            "fresh-advance", CommandType.ADVANCE_BY, revision=1, payload={"ms": 250}
        )
    )
    assert advanced.state_hash == sought.state_hash

    trading = _actor(reducer=CountingReducer(trading_state=True))
    await trading.start()
    await trading.submit(
        _command("trade-acquire", CommandType.ACQUIRE_CONTROLLER, revision=0)
    )
    with pytest.raises(ReplayDomainError) as blocked:
        await trading.submit(
            _command(
                "trade-seek",
                CommandType.SEEK_TO,
                revision=1,
                payload={"virtual_time_ms": 1_000},
            )
        )
    assert blocked.value.code is ReplayErrorCode.SEEK_REQUIRES_FORK_OR_RESET
    await actor.shutdown()
    persisted = actor.latest_checkpoint_blob()
    assert persisted is not None
    assert CheckpointCodec().decode(persisted)["command_log_offset"] == 3
    await fresh.shutdown()
    await trading.shutdown()


@_async_test
async def test_checkpoint_restore_validates_the_exact_source_cursor() -> None:
    actor = _actor(reducer=CountingReducer(), checkpoint_event_interval=1)
    await actor.start()
    await actor.submit(_command("acquire", CommandType.ACQUIRE_CONTROLLER, revision=0))
    await actor.submit(
        _command("step", CommandType.STEP, revision=1, payload={"count": 1})
    )
    blob = actor.latest_checkpoint_blob()
    assert blob is not None
    codec = CheckpointCodec()
    payload = codec.decode(blob)
    source_cursor = dict(payload["source_cursor"])
    source_cursor["last_event_time_ms"] = 1_099
    payload["source_cursor"] = source_cursor

    restored = _actor(
        reducer=CountingReducer(),
        restore_checkpoint=codec.encode(payload),
        checkpoint_event_interval=1,
    )
    with pytest.raises(ReplayDomainError) as mismatch:
        await restored.start()
    assert mismatch.value.code is ReplayErrorCode.DATASET_MISMATCH
    assert restored.task is not None and restored.task.done()
    await actor.shutdown()


@_async_test
async def test_checkpoint_restore_rejects_valid_checksum_with_wrong_state_hash() -> (
    None
):
    actor = _actor(reducer=CountingReducer(), checkpoint_event_interval=1)
    await actor.start()
    await actor.submit(_command("acquire", CommandType.ACQUIRE_CONTROLLER, revision=0))
    await actor.submit(
        _command("step", CommandType.STEP, revision=1, payload={"count": 1})
    )
    blob = actor.latest_checkpoint_blob()
    assert blob is not None
    codec = CheckpointCodec()
    payload = codec.decode(blob)
    payload["component_state"] = {"count": 1, "total": 999}

    restored = _actor(
        reducer=CountingReducer(),
        restore_checkpoint=codec.encode(payload),
        checkpoint_event_interval=1,
    )
    with pytest.raises(ReplayDomainError) as mismatch:
        await restored.start()
    assert mismatch.value.code is ReplayErrorCode.DATASET_MISMATCH
    assert "state hash" in mismatch.value.details["reason"]
    await actor.shutdown()


@_async_test
async def test_checkpoint_restore_and_shutdown_are_bounded_and_leave_no_actor_task() -> (
    None
):
    order: list[str] = []

    async def flush() -> None:
        order.append("flush")

    async def persist_checkpoint(_blob: bytes) -> None:
        order.append("checkpoint")

    actor = _actor(
        reducer=CountingReducer(),
        flush_hook=flush,
        checkpoint_hook=persist_checkpoint,
        checkpoint_event_interval=1,
    )
    await actor.start()
    await actor.submit(_command("acquire", CommandType.ACQUIRE_CONTROLLER, revision=0))
    stepped = await actor.submit(
        _command("step", CommandType.STEP, revision=1, payload={"count": 2})
    )
    checkpoint = actor.latest_checkpoint_blob()
    assert checkpoint is not None

    restored = _actor(
        reducer=CountingReducer(),
        restore_checkpoint=checkpoint,
        checkpoint_event_interval=1,
    )
    await restored.start()
    restored_snapshot = await restored.snapshot()
    assert restored_snapshot.state is SessionState.PAUSED
    assert restored_snapshot.state_hash == stepped.state_hash
    assert restored_snapshot.cursor.source_sequence == 2

    task = actor.task
    await actor.shutdown(step_timeout=0.1)
    assert order == ["flush", "checkpoint"]
    assert task is not None and task.done()
    assert task not in asyncio.all_tasks()
    await restored.shutdown()


@_async_test
async def test_shutdown_hook_timeout_sets_error_but_still_terminates_task() -> None:
    async def blocked_flush() -> None:
        await asyncio.Event().wait()

    actor = _actor(flush_hook=blocked_flush)
    await actor.start()
    with pytest.raises(ReplayDomainError) as degraded:
        await actor.shutdown(step_timeout=0.01)
    assert degraded.value.code is ReplayErrorCode.PERSISTENCE_DEGRADED
    assert actor.task is not None and actor.task.done()
    assert actor.current_snapshot().state is SessionState.ERROR
    assert actor.diagnostics()["shutdown_timeouts"] == 1


@_async_test
async def test_shutdown_timeout_cancels_a_stuck_atomic_event_without_task_leak() -> (
    None
):
    reducer = GateReducer()
    actor = _actor(reducer=reducer, events=event_fixture(step_ms=1))
    await actor.start()
    await actor.submit(_command("acquire", CommandType.ACQUIRE_CONTROLLER, revision=0))
    await actor.submit(
        _command("speed", CommandType.SET_SPEED, revision=1, payload={"speed": "MAX"})
    )
    await actor.submit(_command("play", CommandType.PLAY, revision=2))
    await asyncio.wait_for(reducer.started.wait(), timeout=0.2)

    with pytest.raises(ReplayDomainError) as degraded:
        await actor.shutdown(step_timeout=0.01)
    assert degraded.value.code is ReplayErrorCode.PERSISTENCE_DEGRADED
    assert actor.task is not None and actor.task.done()
    assert actor.current_snapshot().state is SessionState.ERROR
