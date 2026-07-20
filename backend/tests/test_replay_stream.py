from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.api.v1.stream import router
from app.api.v1.stream_replay import stream_replay_session
from app.replay.actor import ActorSnapshot, ReplaySessionActor
from app.replay.constants import REPLAY_PROTOCOL, CommandType, ReplayEventType
from app.replay.errors import ReplayDomainError, ReplayErrorCode
from app.replay.models import ReplayCommand, ReplayCursor, ReplayEvent
from app.replay.service import ReplayService
from app.replay.storage.sqlite_store import ReplaySQLiteStore
from tests.fixtures.replay.actor_fakes import (
    CountingReducer,
    FixtureEvent,
    GateReducer,
    event_fixture,
    session_config,
    source_factory,
)
from tests.fixtures.replay.service_fakes import (
    NOW_MS,
    SessionIdFactory,
    replay_config,
    replay_repository,
    replay_settings,
)


DIGEST = "sha256:" + ("a" * 64)


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


def _actor() -> ReplaySessionActor:
    events = event_fixture(count=5)
    return ReplaySessionActor(
        session_id="session-1",
        config=session_config(),
        source_factory=source_factory(events),
        initial_virtual_time_ms=1_000,
        command_queue_size=16,
        event_buffer_size=2,
        max_emit_fps=30,
        controller_ttl_seconds=1,
        checkpoint_event_interval=10,
        checkpoint_virtual_ms=10_000,
        reducer=CountingReducer(),
    )


@pytest.mark.anyio
async def test_actor_subscription_is_atomic_resumable_and_bounded() -> None:
    actor = _actor()
    await actor.start()
    reset = await actor.subscribe(after_sequence=None, max_pending=4)
    assert reset.reset is True
    assert reset.initial_events[0].type.value == "replay.snapshot"
    assert reset.initial_events[0].sequence == 1

    acquired = await actor.submit(
        _command("acquire-1", CommandType.ACQUIRE_CONTROLLER, 0)
    )
    live = await reset.next_event()
    assert live.sequence == acquired.sequence == 2

    resume = await actor.subscribe(after_sequence=1, max_pending=4)
    assert resume.reset is False
    assert [event.sequence for event in resume.initial_events] == [2]

    released = await actor.submit(
        _command("release-1", CommandType.RELEASE_CONTROLLER, 1)
    )
    reacquired = await actor.submit(
        _command("acquire-2", CommandType.ACQUIRE_CONTROLLER, released.revision)
    )
    missed = await actor.subscribe(after_sequence=0, max_pending=4)
    assert missed.reset is True
    assert missed.initial_events[0].sequence == reacquired.sequence

    overflow = await actor.subscribe(
        after_sequence=reacquired.sequence,
        max_pending=1,
    )
    assert overflow.reset is True
    assert overflow.initial_events[0].type.value == "replay.snapshot"
    assert overflow.initial_events[0].sequence == reacquired.sequence
    released_again = await actor.submit(
        _command("release-2", CommandType.RELEASE_CONTROLLER, reacquired.revision)
    )
    await actor.submit(
        _command(
            "acquire-3",
            CommandType.ACQUIRE_CONTROLLER,
            released_again.revision,
        )
    )
    with pytest.raises(ReplayDomainError) as slow:
        await overflow.next_event()
    assert slow.value.code is ReplayErrorCode.SCAN_LIMIT_EXCEEDED
    assert actor.diagnostics()["subscriber_overflows"] == 1

    for subscription in (reset, resume, missed, overflow):
        await actor.unsubscribe(subscription.token)
    await actor.shutdown(step_timeout=0.2)


@pytest.mark.anyio
async def test_cancelled_queued_subscribe_never_registers_an_orphan_token() -> None:
    reducer = GateReducer()
    actor = ReplaySessionActor(
        session_id="session-cancelled-subscribe",
        config=session_config(),
        source_factory=source_factory(event_fixture(count=1, step_ms=1)),
        initial_virtual_time_ms=1_000,
        command_queue_size=4,
        event_buffer_size=16,
        max_emit_fps=30,
        controller_ttl_seconds=1,
        checkpoint_event_interval=10,
        checkpoint_virtual_ms=10_000,
        reducer=reducer,
    )
    await actor.start()
    await actor.submit(_command("acquire", CommandType.ACQUIRE_CONTROLLER, 0))
    await actor.submit(
        _command("speed", CommandType.SET_SPEED, 1, {"speed": "MAX"})
    )
    await actor.submit(_command("play", CommandType.PLAY, 2))
    await asyncio.wait_for(reducer.started.wait(), timeout=0.5)

    subscribe_task = asyncio.create_task(
        actor.subscribe(after_sequence=None, max_pending=4)
    )
    await asyncio.sleep(0)
    subscribe_task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await subscribe_task

    reducer.release.set()
    for _ in range(100):
        if actor.diagnostics()["queue_size"] == 0:
            break
        await asyncio.sleep(0.001)
    diagnostics = actor.diagnostics()
    assert diagnostics["subscribers"] == 0
    assert diagnostics["subscriber_opens"] == 0
    assert diagnostics["pending_unsubscribes"] == 0
    await actor.shutdown(step_timeout=0.2)


@pytest.mark.anyio
async def test_unsubscribe_cleanup_bypasses_a_saturated_business_mailbox() -> None:
    reducer = GateReducer()
    actor = ReplaySessionActor(
        session_id="session-saturated-unsubscribe",
        config=session_config(),
        source_factory=source_factory(event_fixture(count=1, step_ms=1)),
        initial_virtual_time_ms=1_000,
        command_queue_size=1,
        event_buffer_size=16,
        max_emit_fps=30,
        controller_ttl_seconds=1,
        checkpoint_event_interval=10,
        checkpoint_virtual_ms=10_000,
        reducer=reducer,
    )
    await actor.start()
    await actor.submit(_command("acquire", CommandType.ACQUIRE_CONTROLLER, 0))
    subscription = await actor.subscribe(after_sequence=None, max_pending=8)
    await actor.submit(
        _command("speed", CommandType.SET_SPEED, 1, {"speed": "MAX"})
    )
    await actor.submit(_command("play", CommandType.PLAY, 2))
    await asyncio.wait_for(reducer.started.wait(), timeout=0.5)

    snapshot_task = asyncio.create_task(actor.snapshot())
    await asyncio.sleep(0)
    assert actor.diagnostics()["queue_size"] == 1
    unsubscribe_task = asyncio.create_task(actor.unsubscribe(subscription.token))
    await asyncio.sleep(0)
    duplicate_waiters = [
        asyncio.create_task(actor.unsubscribe(subscription.token)) for _ in range(16)
    ]
    await asyncio.sleep(0)
    diagnostics = actor.diagnostics()
    assert diagnostics["pending_unsubscribes"] == 1
    assert diagnostics["subscriber_cleanup_deferrals"] == 1
    assert not unsubscribe_task.done()

    reducer.release.set()
    await asyncio.wait_for(unsubscribe_task, timeout=0.5)
    await asyncio.wait_for(asyncio.gather(*duplicate_waiters), timeout=0.5)
    await asyncio.wait_for(snapshot_task, timeout=0.5)
    diagnostics = actor.diagnostics()
    assert diagnostics["subscribers"] == 0
    assert diagnostics["pending_unsubscribes"] == 0
    assert diagnostics["subscriber_closes"] == 1
    await actor.shutdown(step_timeout=0.2)


@pytest.mark.anyio
async def test_actor_flushes_pending_projection_on_fps_deadline_without_new_event() -> None:
    events = (
        FixtureEvent(event_time_ms=1_001, value=1),
        FixtureEvent(event_time_ms=1_002, value=2),
        FixtureEvent(event_time_ms=101_000, value=3),
    )
    actor = ReplaySessionActor(
        session_id="session-timed-flush",
        config=session_config(),
        source_factory=source_factory(events),
        initial_virtual_time_ms=1_000,
        command_queue_size=16,
        event_buffer_size=16,
        max_emit_fps=30,
        controller_ttl_seconds=1,
        checkpoint_event_interval=10,
        checkpoint_virtual_ms=10_000,
        reducer=CountingReducer(),
    )
    await actor.start()
    subscription = await actor.subscribe(after_sequence=None, max_pending=8)
    await actor.submit(_command("acquire", CommandType.ACQUIRE_CONTROLLER, 0))
    await actor.submit(_command("play", CommandType.PLAY, 1))

    frames = [
        await asyncio.wait_for(subscription.next_event(), timeout=0.2)
        for _ in range(4)
    ]
    assert [frame.sequence for frame in frames[:3]] == [2, 3, 4]
    assert frames[3].sequence_from == frames[3].sequence_to == 5
    assert frames[3].latest_event.data["source_sequence"] == 2

    await actor.submit(_command("pause", CommandType.PAUSE, 2))
    await actor.unsubscribe(subscription.token)
    await actor.shutdown(step_timeout=0.2)


@pytest.mark.anyio
async def test_subscription_snapshot_closes_old_pending_projection_range() -> None:
    wall = [10.0]
    actor = ReplaySessionActor(
        session_id="session-handoff-floor",
        config=session_config(),
        source_factory=source_factory(event_fixture(count=3)),
        initial_virtual_time_ms=1_000,
        command_queue_size=16,
        event_buffer_size=16,
        max_emit_fps=30,
        controller_ttl_seconds=1,
        checkpoint_event_interval=10,
        checkpoint_virtual_ms=10_000,
        reducer=CountingReducer(),
        monotonic=lambda: wall[0],
    )
    await actor.start()

    def projection(action: str, open_time_ms: int) -> dict[str, object]:
        return {
            "source_sequence": open_time_ms,
            "projection": {
                "bar_update": {
                    "action": action,
                    "bar": {"open_time_ms": open_time_ms},
                },
                "orders": [],
                "fills": [],
                "warnings": [],
                "position": {},
                "account": {},
            },
        }

    # Drive the projection handoff directly while the paused actor is idle:
    # seq=2 is emitted, seq=3 remains pending behind the FPS gate.
    actor._emit(  # noqa: SLF001 - focused atomic-handoff regression
        ReplayEventType.DELTA,
        projection("append", 2_000),
        mandatory=False,
    )
    wall[0] = 10.001
    actor._emit(  # noqa: SLF001 - focused atomic-handoff regression
        ReplayEventType.DELTA,
        projection("tick", 2_000),
        mandatory=False,
    )
    subscription = await actor.subscribe(after_sequence=None, max_pending=8)
    snapshot_sequence = subscription.initial_events[0].sequence
    assert subscription.reset is True

    # A post-snapshot append must be a fresh single frame. It cannot reuse the
    # closed seq=3 range and replay the old bar append/tick to the subscriber.
    wall[0] = 10.04
    actor._emit(  # noqa: SLF001 - focused atomic-handoff regression
        ReplayEventType.DELTA,
        projection("append", 3_000),
        mandatory=False,
    )
    frame = await asyncio.wait_for(subscription.next_event(), timeout=0.2)
    assert frame.sequence_from == frame.sequence_to == snapshot_sequence + 1
    update = frame.latest_event.data["projection"]["bar_update"]
    assert update["bar"]["open_time_ms"] == 3_000

    await actor.unsubscribe(subscription.token)
    await actor.shutdown(step_timeout=0.2)


def _event(event_type: str = "replay.snapshot") -> ReplayEvent:
    return ReplayEvent(
        type=event_type,  # type: ignore[arg-type]
        protocol=REPLAY_PROTOCOL,
        session_id="session-1",
        sequence=4,
        revision=2,
        virtual_time_ms=1_200,
        state_hash=DIGEST,
        data_epoch=DIGEST,
        data={"reset": True},
    )


@dataclass
class FakeSubscription:
    token: int = 1
    initial_events: tuple[ReplayEvent, ...] = (_event(),)
    mode: str = "wait"

    async def next_event(self) -> ReplayEvent:
        if self.mode == "overflow":
            raise ReplayDomainError(
                ReplayErrorCode.SCAN_LIMIT_EXCEEDED,
                "slow client",
            )
        await asyncio.Event().wait()
        raise AssertionError("unreachable")


class FakeActor:
    def __init__(self) -> None:
        self.unsubscribed: list[int] = []

    def current_snapshot(self) -> ActorSnapshot:
        return ActorSnapshot(
            session_id="session-1",
            state="PAUSED",  # type: ignore[arg-type]
            revision=2,
            sequence=4,
            cursor=ReplayCursor(virtual_time_ms=1_200, source_sequence=1),
            state_hash=DIGEST,
            data_epoch=DIGEST,
            controller_client_id=None,
            speed=1,
            checkpoint_count=1,
        )

    async def unsubscribe(self, token: int) -> None:
        completion = self.request_unsubscribe(token)
        if completion is not None:
            await asyncio.shield(completion)

    def request_unsubscribe(self, token: int) -> asyncio.Future[None]:
        self.unsubscribed.append(token)
        completion = asyncio.get_running_loop().create_future()
        completion.set_result(None)
        return completion


class FakeReplayService:
    def __init__(self, *, mode: str = "wait", wrong_epoch: bool = False) -> None:
        self.actor = FakeActor()
        self.subscription = FakeSubscription(mode=mode)
        self.wrong_epoch = wrong_epoch
        self.subscribe_args: tuple[int | None, str | None] | None = None
        self.heartbeats: list[tuple[str, str]] = []

    async def subscribe(
        self,
        session_id: str,
        *,
        after_sequence: int | None,
        data_epoch: str | None,
    ):
        del session_id
        self.subscribe_args = (after_sequence, data_epoch)
        if self.wrong_epoch:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "wrong replay epoch",
            )
        return self.actor, self.subscription

    async def heartbeat(self, session_id: str, client_instance_id: str) -> None:
        self.heartbeats.append((session_id, client_instance_id))


def _app(service: FakeReplayService) -> FastAPI:
    app = FastAPI()
    app.state.replay_service = service
    app.include_router(router, prefix="/api/v1")
    return app


@pytest.mark.anyio
async def test_websocket_double_cancel_transfers_unsubscribe_before_any_cleanup_await() -> (
    None
):
    service = FakeReplayService()
    service.subscription.initial_events = ()
    ownership_transferred = asyncio.Event()
    unsubscribe_completion: asyncio.Future[None] | None = None

    def blocked_request_unsubscribe(token: int) -> asyncio.Future[None]:
        nonlocal unsubscribe_completion
        service.actor.unsubscribed.append(token)
        unsubscribe_completion = asyncio.get_running_loop().create_future()
        ownership_transferred.set()
        return unsubscribe_completion

    service.actor.request_unsubscribe = blocked_request_unsubscribe  # type: ignore[method-assign]

    class BlockingWebSocket:
        def __init__(self) -> None:
            self.app = SimpleNamespace(
                state=SimpleNamespace(replay_service=service)
            )
            self.accepted = asyncio.Event()

        async def accept(self) -> None:
            self.accepted.set()

        async def receive_json(self) -> object:
            await asyncio.Event().wait()
            raise AssertionError("unreachable")

    websocket = BlockingWebSocket()
    stream = asyncio.create_task(
        stream_replay_session(
            websocket,  # type: ignore[arg-type]
            session_id="session-1",
            after_sequence=None,
            data_epoch=None,
        )
    )
    await asyncio.wait_for(websocket.accepted.wait(), timeout=0.2)
    stream.cancel()
    await asyncio.wait_for(ownership_transferred.wait(), timeout=0.2)
    # This cancellation lands while sender/receiver and actor completion are
    # still inside the endpoint's finally block.
    stream.cancel()
    assert unsubscribe_completion is not None
    unsubscribe_completion.set_result(None)

    with pytest.raises(asyncio.CancelledError):
        await stream
    assert service.actor.unsubscribed == [1]
    assert not any(
        task.get_name().startswith("replay-ws-")
        for task in asyncio.all_tasks()
        if task is not asyncio.current_task()
    )


@pytest.mark.anyio
async def test_websocket_cancel_during_service_handoff_cannot_orphan_actor_token(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = ReplayService(
        settings=replay_settings(tmp_path / "stream-handoff-cancel.db"),
        store=ReplaySQLiteStore(
            tmp_path / "stream-handoff-cancel.db",
            now_ms=lambda: NOW_MS,
        ),
        repository=replay_repository(),
        now_ms=lambda: NOW_MS,
        session_id_factory=SessionIdFactory("stream-handoff"),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    created = await service.create_session(replay_config())
    session_id = str(created["session_id"])
    actor = service._sessions[session_id].actor
    original_lease_handle = service._lease_handle
    handoff_exit_entered = asyncio.Event()
    release_handoff_exit = asyncio.Event()

    @asynccontextmanager
    async def blocked_lease_handle(requested_session_id: str):
        async with original_lease_handle(requested_session_id) as handle:
            try:
                yield handle
            finally:
                # At this point actor.subscribe has returned a token, but the
                # service tuple has not crossed the WebSocket API boundary.
                handoff_exit_entered.set()
                await release_handoff_exit.wait()

    monkeypatch.setattr(service, "_lease_handle", blocked_lease_handle)

    class NeverAcceptedWebSocket:
        app = SimpleNamespace(state=SimpleNamespace(replay_service=service))
        accepted = False

        async def accept(self) -> None:
            self.accepted = True

    websocket = NeverAcceptedWebSocket()
    try:
        stream = asyncio.create_task(
            stream_replay_session(
                websocket,  # type: ignore[arg-type]
                session_id=session_id,
                after_sequence=None,
                data_epoch=None,
            )
        )
        await asyncio.wait_for(handoff_exit_entered.wait(), timeout=0.5)
        stream.cancel()
        with pytest.raises(asyncio.CancelledError):
            await stream

        for _ in range(100):
            diagnostics = actor.diagnostics()
            if (
                diagnostics["subscribers"] == 0
                and diagnostics["pending_unsubscribes"] == 0
            ):
                break
            await asyncio.sleep(0.001)
        diagnostics = actor.diagnostics()
        assert websocket.accepted is False
        assert diagnostics["subscribers"] == 0
        assert diagnostics["pending_unsubscribes"] == 0
        assert diagnostics["subscriber_opens"] == 1
        assert diagnostics["subscriber_closes"] == 1
    finally:
        release_handoff_exit.set()
        await service.shutdown(step_timeout=0.2)


def test_websocket_handoff_heartbeat_and_disconnect_cleanup() -> None:
    service = FakeReplayService()
    with TestClient(_app(service)) as client:
        with client.websocket_connect(
            f"/api/v1/stream/replay/session-1?after_sequence=3&data_epoch={DIGEST}"
        ) as websocket:
            first = websocket.receive_json()
            assert first["type"] == "replay.snapshot"
            websocket.send_json(
                {
                    "type": "replay.heartbeat",
                    "protocol": REPLAY_PROTOCOL,
                    "client_instance_id": "browser-tab-1",
                }
            )
            websocket.send_json({"type": "unsupported"})
            error = websocket.receive_json()
            assert error["error"]["code"] == "INVALID_STATE_TRANSITION"
    assert service.subscribe_args == (3, DIGEST)
    assert service.heartbeats == [("session-1", "browser-tab-1")]
    assert service.actor.unsubscribed == [1]


def test_websocket_slow_client_requires_resync_and_closes_1013() -> None:
    service = FakeReplayService(mode="overflow")
    service.subscription.initial_events = ()
    with TestClient(_app(service)) as client:
        with client.websocket_connect("/api/v1/stream/replay/session-1") as websocket:
            resync = websocket.receive_json()
            assert resync["type"] == "replay.resync_required"
            with pytest.raises(WebSocketDisconnect) as closed:
                websocket.receive_json()
            assert closed.value.code == 1013


def test_websocket_wrong_epoch_fails_before_subscription_handoff() -> None:
    service = FakeReplayService(wrong_epoch=True)
    with TestClient(_app(service)) as client:
        with client.websocket_connect(
            f"/api/v1/stream/replay/session-1?data_epoch={DIGEST}"
        ) as websocket:
            error = websocket.receive_json()
            assert error["error"]["code"] == "DATASET_MISMATCH"
            with pytest.raises(WebSocketDisconnect) as closed:
                websocket.receive_json()
            assert closed.value.code == 1008


@pytest.mark.anyio
async def test_websocket_accept_failure_still_unsubscribes_atomic_handoff() -> None:
    service = FakeReplayService()

    class FailingAcceptWebSocket:
        app = SimpleNamespace(state=SimpleNamespace(replay_service=service))

        async def accept(self) -> None:
            raise RuntimeError("injected accept failure")

    await stream_replay_session(
        FailingAcceptWebSocket(),  # type: ignore[arg-type]
        session_id="session-1",
        after_sequence=None,
        data_epoch=None,
    )
    assert service.actor.unsubscribed == [1]
