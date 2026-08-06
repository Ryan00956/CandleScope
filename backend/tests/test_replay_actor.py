from __future__ import annotations

import asyncio
from dataclasses import replace
from functools import wraps

import pytest

import app.replay.actor as actor_module
from app.replay.actor import ReplaySessionActor
from app.replay.checkpoints import CheckpointCodec
from app.replay.constants import (
    REPLAY_PROTOCOL,
    CommandType,
    ReplayEventType,
    SessionState,
)
from app.replay.errors import ReplayDomainError, ReplayErrorCode
from app.replay.models import ReplayCommand, ReplayEvent
from app.replay.projection import ProjectionBatch
from tests.fixtures.replay.actor_fakes import (
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


def test_public_snapshot_reuses_current_actor_state_hash(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    actor = _actor()
    original = actor_module.canonical_sha256
    hash_calls = 0

    def counted_hash(value: object) -> str:
        nonlocal hash_calls
        hash_calls += 1
        return original(value)

    monkeypatch.setattr(actor_module, "canonical_sha256", counted_hash)
    actor._state_hash_cache_key = None  # noqa: SLF001
    actor._state_hash_cache = None  # noqa: SLF001

    first = actor._public_snapshot_value()  # noqa: SLF001
    second = actor._public_snapshot_value()  # noqa: SLF001

    assert first["state_hash"] == second["state_hash"]
    assert hash_calls == 1


def test_projection_buffer_is_bounded_by_domain_events_and_drops_oversize_batch() -> (
    None
):
    actor = _actor(event_buffer_size=5)
    digest = "sha256:" + ("a" * 64)

    def batch(sequence_from: int, sequence_to: int) -> ProjectionBatch:
        event = ReplayEvent(
            type=ReplayEventType.DELTA,
            protocol=REPLAY_PROTOCOL,
            session_id="session-actor",
            sequence=sequence_to,
            revision=0,
            virtual_time_ms=1_000 + sequence_to,
            state_hash=digest,
            data_epoch=digest,
            data={},
        )
        return ProjectionBatch(sequence_from, sequence_to, event, False)

    actor._store_projection_batches((batch(1, 2), batch(3, 5)))
    assert [(item.sequence_from, item.sequence_to) for item in actor.projections()] == [
        (1, 2),
        (3, 5),
    ]
    assert actor.diagnostics()["projection_buffer_domain_events"] == 5

    actor._store_projection_batches((batch(6, 7),))
    assert [(item.sequence_from, item.sequence_to) for item in actor.projections()] == [
        (3, 5),
        (6, 7),
    ]
    actor._store_projection_batches((batch(8, 13),))
    diagnostics = actor.diagnostics()
    assert actor.projections() == ()
    assert diagnostics["projection_buffer_domain_events"] == 0
    assert diagnostics["projection_buffer_capacity_events"] == 5
    assert diagnostics["projection_buffer_evictions"] == 3
    assert diagnostics["projection_buffer_evicted_domain_events"] == 7
    assert diagnostics["projection_buffer_oversize_drops"] == 1


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
async def test_step_and_advance_reject_over_atomic_event_budget_before_mutation() -> None:
    for command_type, payload in (
        (CommandType.STEP, {"count": 3}),
        (CommandType.ADVANCE_BY, {"ms": 500}),
    ):
        reducer = CountingReducer()
        actor = _actor(
            reducer=reducer,
            events=event_fixture(count=5),
            event_buffer_size=2,
        )
        await actor.start()
        await actor.submit(
            _command("acquire", CommandType.ACQUIRE_CONTROLLER, revision=0)
        )
        with pytest.raises(ReplayDomainError) as limited:
            await actor.submit(
                _command(
                    f"limited-{command_type.value}",
                    command_type,
                    revision=1,
                    payload=payload,
                )
            )
        assert limited.value.code is ReplayErrorCode.SCAN_LIMIT_EXCEEDED
        snapshot = await actor.snapshot()
        assert snapshot.revision == 1
        assert snapshot.cursor.source_sequence == 0
        assert reducer.snapshot() == {"count": 0, "total": 0}
        assert actor.diagnostics()["command_resource_rejections"] == 1
        await actor.shutdown()


@_async_test
async def test_seek_rejects_over_budget_without_domain_or_checkpoint_mutation() -> None:
    mutations = []

    async def capture(mutation) -> None:
        mutations.append(mutation)

    reducer = CountingReducer()
    actor = _actor(
        reducer=reducer,
        events=event_fixture(count=5),
        event_buffer_size=2,
        mutation_hook=capture,
    )
    await actor.start()
    await actor.submit(_command("acquire", CommandType.ACQUIRE_CONTROLLER, revision=0))
    before = await actor.durable_state()
    with pytest.raises(ReplayDomainError) as limited:
        await actor.submit(
            _command(
                "limited-seek",
                CommandType.SEEK_TO,
                revision=1,
                payload={"virtual_time_ms": 1_500},
            )
        )
    assert limited.value.code is ReplayErrorCode.SCAN_LIMIT_EXCEEDED
    after = await actor.durable_state()
    for field_name in (
        "state",
        "revision",
        "event_sequence",
        "source_sequence",
        "state_hash",
        "cursor",
    ):
        assert after[field_name] == before[field_name]
    assert reducer.snapshot() == {"count": 0, "total": 0}
    rejection = next(
        mutation
        for mutation in mutations
        if mutation.command is not None
        and mutation.command.command_id == "limited-seek"
    )
    assert rejection.error is not None
    assert rejection.error.code is ReplayErrorCode.SCAN_LIMIT_EXCEEDED
    assert rejection.checkpoint is None
    assert rejection.events == ()
    assert rejection.source_events == ()
    await actor.shutdown()


@_async_test
async def test_seek_succeeds_at_budget_and_current_target_consumes_zero_events() -> None:
    reducer = CountingReducer()
    actor = _actor(
        reducer=reducer,
        events=event_fixture(count=5),
        event_buffer_size=2,
    )
    await actor.start()
    await actor.submit(_command("acquire", CommandType.ACQUIRE_CONTROLLER, revision=0))
    sought = await actor.submit(
        _command(
            "seek-at-budget",
            CommandType.SEEK_TO,
            revision=1,
            payload={"virtual_time_ms": 1_200},
        )
    )
    assert sought.cursor.source_sequence == 2
    assert reducer.snapshot() == {"count": 2, "total": 3}
    preflight_events = actor.diagnostics()["command_preflight_events"]

    identity = await actor.submit(
        _command(
            "seek-current",
            CommandType.SEEK_TO,
            revision=2,
            payload={"virtual_time_ms": 1_200},
        )
    )
    assert identity.cursor.source_sequence == 2
    assert reducer.snapshot() == {"count": 2, "total": 3}
    assert actor.diagnostics()["command_preflight_events"] == preflight_events
    await actor.shutdown()


@_async_test
async def test_seek_at_current_time_counts_only_unconsumed_same_time_events() -> None:
    reducer = CountingReducer()
    events = (
        FixtureEvent(event_time_ms=1_100, value=1),
        FixtureEvent(event_time_ms=1_100, value=2),
        FixtureEvent(event_time_ms=1_200, value=3),
    )
    actor = _actor(reducer=reducer, events=events, event_buffer_size=1)
    await actor.start()
    await actor.submit(_command("acquire", CommandType.ACQUIRE_CONTROLLER, revision=0))
    stepped = await actor.submit(
        _command("step-one", CommandType.STEP, revision=1, payload={"count": 1})
    )
    assert stepped.cursor.virtual_time_ms == 1_100
    assert stepped.cursor.source_sequence == 1

    sought = await actor.submit(
        _command(
            "seek-same-time",
            CommandType.SEEK_TO,
            revision=2,
            payload={"virtual_time_ms": 1_100},
        )
    )
    assert sought.cursor.source_sequence == 2
    assert reducer.snapshot() == {"count": 2, "total": 3}
    await actor.shutdown()


@_async_test
async def test_seek_preflight_and_replay_cooperatively_yield() -> None:
    event_count = 129
    reducer = CountingReducer()
    actor = _actor(
        reducer=reducer,
        events=event_fixture(count=event_count, step_ms=1),
        event_buffer_size=event_count,
    )
    await actor.start()
    await actor.submit(_command("acquire", CommandType.ACQUIRE_CONTROLLER, revision=0))

    ticks = 0
    stopped = False

    async def ticker() -> None:
        nonlocal ticks
        while not stopped:
            ticks += 1
            await asyncio.sleep(0)

    ticker_task = asyncio.create_task(ticker())
    await asyncio.sleep(0)
    before = ticks
    try:
        sought = await actor.submit(
            _command(
                "yielding-seek",
                CommandType.SEEK_TO,
                revision=1,
                payload={"virtual_time_ms": 1_000 + event_count},
            )
        )
    finally:
        stopped = True
        await ticker_task
    assert sought.cursor.source_sequence == event_count
    # 129 events cross the 64-event cadence twice in preflight and twice in
    # reducer replay. The independent ticker must therefore run at least four
    # times while the command is in flight.
    assert ticks - before >= 4
    assert reducer.snapshot()["count"] == event_count
    await actor.shutdown()


@_async_test
async def test_step_command_persists_final_checkpoint_without_source_event_batch() -> None:
    mutations = []

    async def capture(mutation) -> None:
        mutations.append(mutation)

    actor = _actor(
        reducer=CountingReducer(),
        events=event_fixture(count=60, step_ms=1),
        event_buffer_size=64,
        mutation_hook=capture,
    )
    await actor.start()
    await actor.submit(_command("acquire", CommandType.ACQUIRE_CONTROLLER, revision=0))
    await actor.submit(
        _command("step-sixty", CommandType.STEP, revision=1, payload={"count": 60})
    )
    mutation = next(
        item
        for item in mutations
        if item.command is not None and item.command.command_id == "step-sixty"
    )
    assert mutation.checkpoint is not None
    assert mutation.source_events == ()
    assert len(mutation.events) == 61
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
async def test_step_preflight_forks_current_source_without_reopening_factory() -> None:
    events = event_fixture()
    calls = 0

    def counted_factory() -> FixtureSource:
        nonlocal calls
        calls += 1
        return FixtureSource(events)

    actor = ReplaySessionActor(
        session_id="session-counted-source",
        config=session_config(),
        source_factory=counted_factory,
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
    await actor.submit(
        _command("step-1", CommandType.STEP, revision=1, payload={"count": 1})
    )
    await actor.submit(
        _command("step-2", CommandType.STEP, revision=2, payload={"count": 1})
    )
    assert calls == 1
    assert (await actor.snapshot()).cursor.source_sequence == 2
    await actor.shutdown()


@_async_test
async def test_source_fork_that_returns_shared_instance_fails_closed() -> None:
    events = event_fixture()

    class SharedForkSource(FixtureSource):
        def fork(self):
            return self

    actor = ReplaySessionActor(
        session_id="session-shared-source",
        config=session_config(),
        source_factory=lambda: SharedForkSource(events),
        initial_virtual_time_ms=1_000,
        command_queue_size=8,
        event_buffer_size=64,
        max_emit_fps=30,
        controller_ttl_seconds=1,
        checkpoint_event_interval=2,
        checkpoint_virtual_ms=1_000,
    )
    await actor.start()
    with pytest.raises(ReplayDomainError) as failure:
        await actor.submit(
            _command("acquire", CommandType.ACQUIRE_CONTROLLER, revision=0)
        )
    assert failure.value.code is ReplayErrorCode.DATASET_MISMATCH
    assert (await actor.snapshot()).cursor.source_sequence == 0
    with pytest.raises(ReplayDomainError):
        await actor.shutdown(step_timeout=0.1)


@_async_test
async def test_source_fork_that_changes_snapshot_identity_fails_closed() -> None:
    events = event_fixture()

    class ForgedIdentityForkSource(FixtureSource):
        def fork(self):
            forked = FixtureSource(
                events,
                data_epoch="sha256:" + ("e" * 64),
            )
            forked._index = self._index
            return forked

    actor = ReplaySessionActor(
        session_id="session-forged-fork-source",
        config=session_config(),
        source_factory=lambda: ForgedIdentityForkSource(events),
        initial_virtual_time_ms=1_000,
        command_queue_size=8,
        event_buffer_size=64,
        max_emit_fps=30,
        controller_ttl_seconds=1,
        checkpoint_event_interval=2,
        checkpoint_virtual_ms=1_000,
    )
    await actor.start()
    with pytest.raises(ReplayDomainError) as failure:
        await actor.submit(
            _command("acquire-forged-fork", CommandType.ACQUIRE_CONTROLLER, revision=0)
        )
    assert failure.value.code is ReplayErrorCode.DATASET_MISMATCH
    assert (await actor.snapshot()).cursor.source_sequence == 0
    with pytest.raises(ReplayDomainError):
        await actor.shutdown(step_timeout=0.1)


def test_lightweight_rollback_capture_reuses_hash_without_checkpoint_materialization(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    actor = _actor(reducer=CountingReducer())
    expected_state_hash = actor._compute_state_hash()

    def unexpected(*_args, **_kwargs):
        raise AssertionError("rollback capture performed duplicate canonical work")

    monkeypatch.setattr(actor, "_checkpoint_payload", unexpected)
    monkeypatch.setattr(actor_module, "canonical_sha256", unexpected)
    rollback = actor._capture_rollback()

    assert rollback.expected_state_hash == expected_state_hash
    assert dict(rollback.component_state) == {"count": 0, "total": 0}
    assert rollback.source_cursor.source_sequence == 0


def test_lightweight_rollback_rejects_fork_cursor_drift() -> None:
    actor = _actor(reducer=CountingReducer())
    rollback = actor._capture_rollback()
    assert rollback.source.next() is not None

    with pytest.raises(ReplayDomainError) as mismatch:
        actor._restore_rollback(rollback, force_paused=False)

    assert mismatch.value.code is ReplayErrorCode.DATASET_MISMATCH
    assert "cursor" in mismatch.value.message


def test_lightweight_rollback_rejects_reducer_that_silently_restores_wrong_state() -> (
    None
):
    class BadRestoreReducer(CountingReducer):
        def restore(self, state) -> None:
            del state
            self.count = 999
            self.total = 999

    actor = _actor(reducer=BadRestoreReducer())
    rollback = actor._capture_rollback()

    with pytest.raises(ReplayDomainError) as mismatch:
        actor._restore_rollback(rollback, force_paused=False)

    assert mismatch.value.code is ReplayErrorCode.DATASET_MISMATCH
    assert mismatch.value.details["expected_state_hash"] == rollback.expected_state_hash
    assert mismatch.value.details["actual_state_hash"] != rollback.expected_state_hash


@_async_test
async def test_mutating_reducer_exception_restores_exact_lightweight_state() -> None:
    class MutatingRaiseReducer(CountingReducer):
        def apply_source_event(self, event: FixtureEvent):
            super().apply_source_event(event)
            raise RuntimeError("injected reducer failure after mutation")

    reducer = MutatingRaiseReducer()
    actor = _actor(reducer=reducer)
    await actor.start()
    before = await actor.durable_state()
    before_components = actor._component_state()
    before_journal = tuple(dict(entry) for entry in actor._journal_entries)

    with pytest.raises(RuntimeError, match="after mutation"):
        await actor._process_source_event(publish=True)

    after = await actor.durable_state()
    for field_name in (
        "state",
        "revision",
        "event_sequence",
        "source_sequence",
        "state_hash",
        "cursor",
    ):
        assert after[field_name] == before[field_name]
    assert actor._component_state() == before_components
    assert tuple(dict(entry) for entry in actor._journal_entries) == before_journal
    assert reducer.snapshot() == {"count": 0, "total": 0}
    await actor.shutdown()


@_async_test
async def test_source_persistence_failure_restores_exact_lightweight_state() -> None:
    async def reject_source(mutation) -> None:
        if mutation.kind == "source_event":
            raise RuntimeError("injected source persistence failure")

    reducer = CountingReducer()
    actor = _actor(reducer=reducer, mutation_hook=reject_source)
    await actor.start()
    before = await actor.durable_state()
    before_components = actor._component_state()
    before_journal = tuple(dict(entry) for entry in actor._journal_entries)

    await actor._process_source_event(publish=True)

    after = await actor.durable_state()
    for field_name in (
        "revision",
        "event_sequence",
        "source_sequence",
        "state_hash",
        "cursor",
    ):
        assert after[field_name] == before[field_name]
    assert actor._component_state() == before_components
    assert tuple(dict(entry) for entry in actor._journal_entries) == before_journal
    assert after["state"] == "PAUSED"
    assert reducer.snapshot() == {"count": 0, "total": 0}
    assert actor.diagnostics()["persistence_failures"] == 1
    await actor.shutdown()


@_async_test
async def test_optional_mutation_hook_preserves_actor_state_events_and_checkpoints() -> (
    None
):
    mutations = []

    async def capture(mutation) -> None:
        mutations.append(mutation)

    without_hook = _actor(
        reducer=CountingReducer(),
        events=event_fixture(count=3),
        checkpoint_event_interval=1,
    )
    with_hook = _actor(
        reducer=CountingReducer(),
        events=event_fixture(count=3),
        checkpoint_event_interval=1,
        mutation_hook=capture,
    )
    for actor in (without_hook, with_hook):
        await actor.start()
        await actor.submit(
            _command("parity-acquire", CommandType.ACQUIRE_CONTROLLER, revision=0)
        )
        await actor.submit(
            _command(
                "parity-step",
                CommandType.STEP,
                revision=1,
                payload={"count": 2},
            )
        )

    without_snapshot = await without_hook.snapshot()
    with_snapshot = await with_hook.snapshot()
    assert without_snapshot.to_dict() == with_snapshot.to_dict()
    assert [
        event.to_dict() for event in without_hook.event_buffer_after(0) or ()
    ] == [event.to_dict() for event in with_hook.event_buffer_after(0) or ()]
    assert without_hook.latest_checkpoint_blob() == with_hook.latest_checkpoint_blob()

    step_mutation = next(
        mutation
        for mutation in mutations
        if mutation.command is not None
        and mutation.command.command_id == "parity-step"
    )
    # Atomic STEP remains checkpoint-backed and deliberately does not persist
    # a duplicate source-event batch.
    assert step_mutation.source_events == ()

    for actor in (without_hook, with_hook):
        await actor.submit(_command("parity-play", CommandType.PLAY, revision=2))
        await _wait_for_state(actor, SessionState.ENDED)

    without_ended = await without_hook.snapshot()
    with_ended = await with_hook.snapshot()
    assert without_ended.to_dict() == with_ended.to_dict()
    assert [
        event.to_dict() for event in without_hook.event_buffer_after(0) or ()
    ] == [event.to_dict() for event in with_hook.event_buffer_after(0) or ()]
    assert without_hook.latest_checkpoint_blob() == with_hook.latest_checkpoint_blob()

    source_mutation = next(
        mutation for mutation in mutations if mutation.kind == "source_event"
    )
    assert len(source_mutation.source_events) == 1
    assert source_mutation.source_events[0]["value"] == 3
    assert source_mutation.checkpoint is not None
    assert with_hook.latest_checkpoint_blob() == source_mutation.checkpoint

    await without_hook.shutdown()
    await with_hook.shutdown()


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
async def test_atomic_owner_command_longer_than_ttl_renews_controller_lease() -> None:
    reducer = GateReducer()
    actor = _actor(
        reducer=reducer,
        controller_ttl_seconds=0.03,
        events=event_fixture(count=3),
    )
    await actor.start()
    await actor.submit(
        _command("long-command-acquire", CommandType.ACQUIRE_CONTROLLER, revision=0)
    )

    step = asyncio.create_task(
        actor.submit(
            _command(
                "long-command-step",
                CommandType.STEP,
                revision=1,
                payload={"count": 1},
            )
        )
    )
    await asyncio.wait_for(reducer.started.wait(), timeout=1.0)
    await asyncio.sleep(0.05)
    reducer.release.set()

    completed = await asyncio.wait_for(step, timeout=1.0)
    assert completed.revision == 2
    await actor.heartbeat("tab-a")
    snapshot = await actor.snapshot()
    assert snapshot.controller_client_id == "tab-a"
    assert snapshot.revision == 2
    assert actor.diagnostics()["controller_expirations"] == 0
    await actor.shutdown()


@_async_test
async def test_heartbeat_queued_across_terminal_controller_release_is_idempotent() -> (
    None
):
    actor = _actor(events=event_fixture(count=5))
    await actor.start()
    await actor.submit(
        _command("terminal-heartbeat-acquire", CommandType.ACQUIRE_CONTROLLER, revision=0)
    )
    ended = await actor.submit(
        _command("terminal-heartbeat-end", CommandType.END_SESSION, revision=1)
    )
    sequence = ended.sequence
    revision = ended.revision

    # The former owner's browser timer can already have queued a heartbeat
    # while END_SESSION is committing. No client can mutate an ended actor, so
    # both the former owner and a stale viewer are harmless terminal no-ops.
    await actor.heartbeat("tab-a")
    await actor.heartbeat("tab-b")

    after = await actor.snapshot()
    assert after.state is SessionState.ENDED
    assert after.controller_client_id is None
    assert after.sequence == sequence
    assert after.revision == revision
    await actor.shutdown()


@_async_test
async def test_explicit_terminal_controller_heartbeat_renews_lease() -> None:
    actor = _actor(controller_ttl_seconds=0.15, events=event_fixture(count=5))
    await actor.start()
    await actor.submit(
        _command("terminal-renew-acquire", CommandType.ACQUIRE_CONTROLLER, revision=0)
    )
    ended = await actor.submit(
        _command("terminal-renew-end", CommandType.END_SESSION, revision=1)
    )
    assert ended.state is SessionState.ENDED
    assert (await actor.snapshot()).controller_client_id is None

    reacquired = await actor.submit(
        _command(
            "terminal-renew-reacquire",
            CommandType.ACQUIRE_CONTROLLER,
            revision=2,
        )
    )
    assert reacquired.state is SessionState.ENDED
    assert (await actor.snapshot()).controller_client_id == "tab-a"

    await asyncio.sleep(0.09)
    await actor.heartbeat("tab-a")
    await asyncio.sleep(0.09)
    renewed = await actor.snapshot()
    assert renewed.controller_client_id == "tab-a"
    assert renewed.revision == 3
    assert actor.diagnostics()["controller_expirations"] == 0

    async def _wait_for_expiration() -> None:
        while (await actor.snapshot()).controller_client_id is not None:
            await asyncio.sleep(0.001)

    await asyncio.wait_for(_wait_for_expiration(), timeout=0.3)
    expired = await actor.snapshot()
    assert expired.state is SessionState.ENDED
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
async def test_saturated_snapshot_mailbox_does_not_starve_max_playback() -> None:
    reducer = GateReducer()
    event_count = 20
    actor = _actor(
        reducer=reducer,
        command_queue_size=event_count + 8,
        events=event_fixture(count=event_count, step_ms=1),
    )
    await actor.start()
    await actor.submit(_command("acquire", CommandType.ACQUIRE_CONTROLLER, revision=0))
    await actor.submit(
        _command("speed", CommandType.SET_SPEED, revision=1, payload={"speed": "MAX"})
    )
    await actor.submit(_command("play", CommandType.PLAY, revision=2))
    await asyncio.wait_for(reducer.started.wait(), timeout=0.2)

    pending = [asyncio.create_task(actor.snapshot()) for _ in range(event_count)]

    async def _wait_for_saturated_mailbox() -> None:
        while actor.diagnostics()["queue_size"] < event_count:
            await asyncio.sleep(0)

    await asyncio.wait_for(_wait_for_saturated_mailbox(), timeout=0.2)
    reducer.release.set()
    snapshots = await asyncio.wait_for(asyncio.gather(*pending), timeout=0.5)

    assert [snapshot.cursor.source_sequence for snapshot in snapshots] == list(
        range(1, event_count + 1)
    )
    await _wait_for_state(actor, SessionState.ENDED)
    assert (await actor.snapshot()).cursor.source_sequence == event_count
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
async def test_seek_preserves_speed_and_resets_periodic_checkpoint_cadence() -> None:
    actor = _actor(
        reducer=CountingReducer(),
        checkpoint_event_interval=2,
        checkpoint_virtual_ms=10_000,
    )
    await actor.start()
    assert (await actor.snapshot()).checkpoint_count == 1
    await actor.submit(_command("cadence-acquire", CommandType.ACQUIRE_CONTROLLER, revision=0))
    await actor.submit(
        _command(
            "cadence-speed-60",
            CommandType.SET_SPEED,
            revision=1,
            payload={"speed": 60},
        )
    )
    await actor.submit(
        _command(
            "cadence-step-four",
            CommandType.STEP,
            revision=2,
            payload={"count": 4},
        )
    )
    assert (await actor.snapshot()).checkpoint_count == 2
    await actor.submit(
        _command(
            "cadence-speed-300",
            CommandType.SET_SPEED,
            revision=3,
            payload={"speed": 300},
        )
    )

    sought = await actor.submit(
        _command(
            "cadence-seek-two",
            CommandType.SEEK_TO,
            revision=4,
            payload={"virtual_time_ms": 1_250},
        )
    )
    after_seek = await actor.snapshot()
    assert sought.cursor.source_sequence == 2
    assert after_seek.state is SessionState.PAUSED
    assert after_seek.speed == 300
    assert after_seek.checkpoint_count == 3
    latest = actor.latest_checkpoint_blob()
    assert latest is not None
    latest_payload = CheckpointCodec().decode(latest)
    assert latest_payload["source_sequence"] == 2
    assert latest_payload["clock_speed"] == 300

    await actor.submit(
        _command(
            "cadence-step-one",
            CommandType.STEP,
            revision=5,
            payload={"count": 1},
        )
    )
    assert (await actor.snapshot()).checkpoint_count == 3
    await actor.submit(
        _command(
            "cadence-step-two",
            CommandType.STEP,
            revision=6,
            payload={"count": 1},
        )
    )
    after_budget = await actor.snapshot()
    assert after_budget.cursor.source_sequence == 4
    assert after_budget.speed == 300
    assert after_budget.checkpoint_count == 4
    latest = actor.latest_checkpoint_blob()
    assert latest is not None
    assert CheckpointCodec().decode(latest)["source_sequence"] == 4
    await actor.shutdown()


@_async_test
async def test_failed_seek_persistence_restores_speed_and_does_not_pollute_ring() -> None:
    reject_seek = False

    async def persist(mutation) -> None:
        if (
            reject_seek
            and mutation.command is not None
            and mutation.command.type is CommandType.SEEK_TO
        ):
            raise RuntimeError("injected seek persistence failure")

    actor = _actor(
        reducer=CountingReducer(),
        checkpoint_event_interval=2,
        checkpoint_virtual_ms=10_000,
        mutation_hook=persist,
    )
    await actor.start()
    await actor.submit(_command("rollback-acquire", CommandType.ACQUIRE_CONTROLLER, revision=0))
    await actor.submit(
        _command(
            "rollback-speed-60",
            CommandType.SET_SPEED,
            revision=1,
            payload={"speed": 60},
        )
    )
    await actor.submit(
        _command(
            "rollback-step-four",
            CommandType.STEP,
            revision=2,
            payload={"count": 4},
        )
    )
    await actor.submit(
        _command(
            "rollback-speed-300",
            CommandType.SET_SPEED,
            revision=3,
            payload={"speed": 300},
        )
    )
    before = await actor.snapshot()
    before_checkpoint = actor.latest_checkpoint_blob()
    assert before.cursor.source_sequence == 4
    assert before.speed == 300
    assert before.checkpoint_count == 2
    assert before_checkpoint is not None

    reject_seek = True
    with pytest.raises(ReplayDomainError) as degraded:
        await actor.submit(
            _command(
                "rollback-seek-two",
                CommandType.SEEK_TO,
                revision=4,
                payload={"virtual_time_ms": 1_250},
            )
        )
    assert degraded.value.code is ReplayErrorCode.PERSISTENCE_DEGRADED
    after = await actor.snapshot()
    assert after.state is SessionState.PAUSED
    assert after.revision == before.revision
    assert after.sequence == before.sequence
    assert after.cursor == before.cursor
    assert after.speed == 300
    assert after.checkpoint_count == before.checkpoint_count
    assert actor.latest_checkpoint_blob() == before_checkpoint
    await actor.shutdown()


@_async_test
async def test_backward_seek_preserves_journal_domain_position_and_checkpoint() -> None:
    reducer = CountingReducer()
    actor = _actor(reducer=reducer, checkpoint_event_interval=2)
    await actor.start()
    await actor.submit(_command("acquire", CommandType.ACQUIRE_CONTROLLER, revision=0))
    noted = await actor.submit(
        _command(
            "note-before-seek",
            CommandType.ADD_JOURNAL_NOTE,
            revision=1,
            payload={"text": "keep this training note"},
        )
    )
    assert noted.cursor.virtual_time_ms == 1_000
    await actor.submit(
        _command("step-four", CommandType.STEP, revision=2, payload={"count": 4})
    )
    sought = await actor.submit(
        _command(
            "seek-back-with-note",
            CommandType.SEEK_TO,
            revision=3,
            payload={"virtual_time_ms": 1_250},
        )
    )
    assert sought.cursor.source_sequence == 2
    public = await actor.public_snapshot()
    assert public["journal"] == [
        {
            "entry_id": "note-before-seek",
            "virtual_time_ms": 1_000,
            "text": "keep this training note",
        }
    ]

    checkpoint = await actor.checkpoint()
    checkpoint_payload = CheckpointCodec().decode(checkpoint)
    assert checkpoint_payload["domain_command_position"] == 1
    assert checkpoint_payload["journal_entries"] == public["journal"]
    assert checkpoint_payload["state_hash"] == sought.state_hash

    no_journal = _actor(reducer=CountingReducer())
    await no_journal.start()
    await no_journal.submit(
        _command("no-journal-acquire", CommandType.ACQUIRE_CONTROLLER, revision=0)
    )
    market_only = await no_journal.submit(
        _command(
            "no-journal-advance",
            CommandType.ADVANCE_BY,
            revision=1,
            payload={"ms": 250},
        )
    )
    # Journal text is stored in the durable journal payload; the accepted
    # domain-command position is the journal command's state-hash influence.
    assert market_only.cursor == sought.cursor
    assert market_only.state_hash != sought.state_hash

    recovered = _actor(
        reducer=CountingReducer(),
        restore_checkpoint=checkpoint,
        checkpoint_event_interval=2,
    )
    await recovered.start()
    recovered_public = await recovered.public_snapshot()
    assert recovered_public["journal"] == public["journal"]
    assert recovered_public["state_hash"] == sought.state_hash
    assert recovered_public["cursor"] == public["cursor"]
    recovered_checkpoint = CheckpointCodec().decode(await recovered.checkpoint())
    assert recovered_checkpoint["domain_command_position"] == 1
    assert recovered_checkpoint["journal_entries"] == public["journal"]

    await actor.shutdown()
    await recovered.shutdown()
    await no_journal.shutdown()


@_async_test
async def test_backward_seek_cannot_cross_a_durable_journal_entry() -> None:
    mutations = []

    async def capture(mutation) -> None:
        mutations.append(mutation)

    reducer = CountingReducer()
    actor = _actor(
        reducer=reducer,
        checkpoint_event_interval=2,
        mutation_hook=capture,
    )
    await actor.start()
    await actor.submit(_command("acquire", CommandType.ACQUIRE_CONTROLLER, revision=0))
    await actor.submit(
        _command("step-four", CommandType.STEP, revision=1, payload={"count": 4})
    )
    await actor.submit(
        _command(
            "late-note",
            CommandType.ADD_JOURNAL_NOTE,
            revision=2,
            payload={"text": "do not expose this note before its time"},
        )
    )
    before = await actor.public_snapshot()
    before_reducer = reducer.snapshot()

    with pytest.raises(ReplayDomainError) as blocked:
        await actor.submit(
            _command(
                "seek-before-note",
                CommandType.SEEK_TO,
                revision=3,
                payload={"virtual_time_ms": 1_250},
            )
        )
    assert blocked.value.code is ReplayErrorCode.SEEK_REQUIRES_FORK_OR_RESET
    assert blocked.value.details == {
        "target_virtual_time_ms": 1_250,
        "earliest_blocking_journal_time_ms": 1_400,
        "blocking_journal_entries": 1,
    }
    after = await actor.public_snapshot()
    for field_name in (
        "state",
        "revision",
        "sequence",
        "cursor",
        "state_hash",
        "components",
        "journal",
    ):
        assert after[field_name] == before[field_name]
    assert reducer.snapshot() == before_reducer
    rejection = next(
        mutation
        for mutation in mutations
        if mutation.command is not None
        and mutation.command.command_id == "seek-before-note"
    )
    assert rejection.error is not None
    assert rejection.error.code is ReplayErrorCode.SEEK_REQUIRES_FORK_OR_RESET
    assert rejection.checkpoint is None
    assert rejection.events == ()
    assert rejection.source_events == ()
    await actor.shutdown()


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
async def test_checkpoint_restore_rejects_future_journal_entry() -> None:
    actor = _actor(reducer=CountingReducer())
    await actor.start()
    await actor.submit(_command("acquire", CommandType.ACQUIRE_CONTROLLER, revision=0))
    await actor.submit(
        _command(
            "journal-at-start",
            CommandType.ADD_JOURNAL_NOTE,
            revision=1,
            payload={"text": "valid at the current replay time"},
        )
    )
    codec = CheckpointCodec()
    payload = codec.decode(await actor.checkpoint())
    journal = [dict(entry) for entry in payload["journal_entries"]]
    journal[0]["virtual_time_ms"] = 1_100
    payload["journal_entries"] = journal

    restored = _actor(
        reducer=CountingReducer(),
        restore_checkpoint=codec.encode(payload),
    )
    with pytest.raises(ReplayDomainError) as mismatch:
        await restored.start()
    assert mismatch.value.code is ReplayErrorCode.DATASET_MISMATCH
    assert restored.task is not None and restored.task.done()
    await actor.shutdown()


@_async_test
async def test_manual_ended_checkpoint_restores_as_ended_before_source_exhaustion() -> None:
    actor = _actor(reducer=CountingReducer(), events=event_fixture(count=5))
    await actor.start()
    await actor.submit(_command("acquire", CommandType.ACQUIRE_CONTROLLER, revision=0))
    ended = await actor.submit(
        _command("manual-end", CommandType.END_SESSION, revision=1)
    )
    checkpoint = await actor.checkpoint()
    assert ended.state is SessionState.ENDED
    assert ended.cursor.source_sequence == 0
    await actor.shutdown()

    restored = _actor(
        reducer=CountingReducer(),
        events=event_fixture(count=5),
        restore_checkpoint=checkpoint,
    )
    await restored.start()
    snapshot = await restored.snapshot()
    assert snapshot.state is SessionState.ENDED
    assert snapshot.cursor.source_sequence == 0
    assert snapshot.controller_client_id is None
    await restored.shutdown()


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
async def test_ended_shutdown_is_a_resource_barrier_without_redundant_persistence() -> (
    None
):
    mutations = []

    async def capture(mutation) -> None:
        mutations.append(mutation)

    async def reject_flush() -> None:
        raise AssertionError("durable ENDED actor must not flush during eviction")

    async def reject_checkpoint(_blob: bytes) -> None:
        raise AssertionError("durable ENDED actor must not checkpoint during eviction")

    actor = _actor(
        reducer=CountingReducer(),
        mutation_hook=capture,
        flush_hook=reject_flush,
        checkpoint_hook=reject_checkpoint,
    )
    await actor.start()
    acquired = await actor.submit(
        _command("terminal-acquire", CommandType.ACQUIRE_CONTROLLER, revision=0)
    )
    ended = await actor.submit(
        _command(
            "terminal-end",
            CommandType.END_SESSION,
            revision=acquired.revision,
            payload={
                "open_order_disposition": "expire",
                "position_disposition": "keep",
            },
        )
    )
    assert ended.state is SessionState.ENDED
    terminal = next(
        mutation
        for mutation in mutations
        if mutation.command is not None
        and mutation.command.command_id == "terminal-end"
    )
    assert terminal.checkpoint is not None
    assert actor.latest_checkpoint_blob() == terminal.checkpoint
    mutation_count = len(mutations)

    await actor.shutdown(step_timeout=0.01)

    assert len(mutations) == mutation_count
    assert all(mutation.kind != "shutdown" for mutation in mutations)
    assert actor.current_snapshot().state is SessionState.ENDED
    assert actor.task is not None and actor.task.done()
    diagnostics = actor.diagnostics()
    assert diagnostics["shutdown_failures"] == 0
    assert diagnostics["shutdown_timeouts"] == 0


@_async_test
async def test_blind_actor_persistence_failure_redacts_the_original_exception() -> None:
    secret = "SENSITIVE_ARCHIVE_PATH=H:/private/hidden-bars.parquet"
    fail_persistence = True

    async def persist(_mutation) -> None:
        if fail_persistence:
            raise RuntimeError(secret)

    actor = _actor(
        config=replace(session_config(), blind_mode=True),
        reducer=CountingReducer(),
        mutation_hook=persist,
    )
    await actor.start()
    with pytest.raises(ReplayDomainError) as degraded:
        await actor.submit(
            _command("blind-acquire", CommandType.ACQUIRE_CONTROLLER, revision=0)
        )

    assert degraded.value.code is ReplayErrorCode.PERSISTENCE_DEGRADED
    assert degraded.value.message == (
        "replay mutation was rolled back because persistence failed"
    )
    assert dict(degraded.value.details) == {
        "blind_redacted": True,
        "reason": "blind replay persistence failed",
    }
    public = await actor.public_snapshot()
    assert public["status_reason"] == "persistence_degraded"
    assert public["degraded_reason"] == "blind replay persistence failed"
    assert secret not in repr(public)
    assert secret not in degraded.value.message
    assert secret not in repr(dict(degraded.value.details))

    fail_persistence = False
    await actor.shutdown()


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


@_async_test
async def test_queue_full_shutdown_cancels_blocked_mutation_without_task_leak() -> (
    None
):
    persistence_started = asyncio.Event()

    async def blocked_persistence(_mutation) -> None:
        persistence_started.set()
        await asyncio.Event().wait()

    actor = _actor(
        reducer=CountingReducer(),
        command_queue_size=1,
        mutation_hook=blocked_persistence,
    )
    await actor.start()
    actor_task = actor.task
    command_task = asyncio.create_task(
        actor.submit(
            _command(
                "blocked-persistence-acquire",
                CommandType.ACQUIRE_CONTROLLER,
                revision=0,
            )
        )
    )
    await asyncio.wait_for(persistence_started.wait(), timeout=0.2)
    queued_snapshot = asyncio.create_task(actor.snapshot())

    async def wait_for_full_queue() -> None:
        while actor.diagnostics()["queue_size"] != 1:
            await asyncio.sleep(0)

    await asyncio.wait_for(wait_for_full_queue(), timeout=0.2)
    with pytest.raises(ReplayDomainError) as degraded:
        await actor.shutdown(step_timeout=0.01)
    assert degraded.value.code is ReplayErrorCode.PERSISTENCE_DEGRADED

    outcomes = await asyncio.gather(
        command_task,
        queued_snapshot,
        return_exceptions=True,
    )
    assert isinstance(outcomes[0], asyncio.CancelledError)
    assert isinstance(outcomes[1], RuntimeError)
    assert actor_task is not None and actor_task.done()
    assert actor_task.cancelled()
    assert actor_task not in asyncio.all_tasks()
    snapshot = actor.current_snapshot()
    assert snapshot.state is SessionState.ERROR
    assert snapshot.revision == 0
    assert snapshot.sequence == 1
    assert snapshot.cursor.source_sequence == 0
    assert snapshot.checkpoint_count == 1
    assert actor.diagnostics()["queue_size"] == 0


@_async_test
async def test_clean_shutdown_fails_every_read_queued_behind_its_barrier() -> None:
    persistence_started = asyncio.Event()
    release_persistence = asyncio.Event()

    async def gated_persistence(_mutation) -> None:
        persistence_started.set()
        await release_persistence.wait()

    actor = _actor(
        reducer=CountingReducer(),
        command_queue_size=8,
        mutation_hook=gated_persistence,
    )
    await actor.start()
    command_task = asyncio.create_task(
        actor.submit(
            _command(
                "gated-acquire-before-shutdown",
                CommandType.ACQUIRE_CONTROLLER,
                revision=0,
            )
        )
    )
    await asyncio.wait_for(persistence_started.wait(), timeout=0.2)

    shutdown_task = asyncio.create_task(actor.shutdown(step_timeout=1.0))

    async def wait_for_shutdown_barrier() -> None:
        while not actor.diagnostics()["closing"]:
            await asyncio.sleep(0)

    await asyncio.wait_for(wait_for_shutdown_barrier(), timeout=0.2)
    queued_reads = (
        asyncio.create_task(actor.snapshot()),
        asyncio.create_task(actor.public_snapshot()),
        asyncio.create_task(actor.report()),
        asyncio.create_task(actor.checkpoint()),
        asyncio.create_task(actor.durable_state()),
    )

    async def wait_for_mailbox_tail() -> None:
        while actor.diagnostics()["queue_size"] != 6:
            await asyncio.sleep(0)

    await asyncio.wait_for(wait_for_mailbox_tail(), timeout=0.2)
    release_persistence.set()

    await asyncio.wait_for(shutdown_task, timeout=1)
    await asyncio.wait_for(command_task, timeout=0.2)
    outcomes = await asyncio.wait_for(
        asyncio.gather(*queued_reads, return_exceptions=True),
        timeout=0.2,
    )
    assert all(isinstance(outcome, RuntimeError) for outcome in outcomes)
    assert actor.task is not None and actor.task.done()
    assert actor.diagnostics()["queue_size"] == 0
