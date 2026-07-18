from __future__ import annotations

import asyncio
from dataclasses import dataclass

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.api.v1.stream import router
from app.replay.actor import ActorSnapshot, ReplaySessionActor
from app.replay.constants import REPLAY_PROTOCOL, CommandType
from app.replay.errors import ReplayDomainError, ReplayErrorCode
from app.replay.models import ReplayCommand, ReplayCursor, ReplayEvent
from tests.fixtures.replay.actor_fakes import (
    CountingReducer,
    event_fixture,
    session_config,
    source_factory,
)


DIGEST = "sha256:" + ("a" * 64)


def _command(
    command_id: str,
    command_type: CommandType,
    revision: int,
) -> ReplayCommand:
    return ReplayCommand(
        protocol=REPLAY_PROTOCOL,
        command_id=command_id,
        client_instance_id="browser-tab-1",
        expected_revision=revision,
        type=command_type,
        payload={},
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
        self.unsubscribed.append(token)


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
