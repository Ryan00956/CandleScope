"""Atomic snapshot-to-live replay.v1 WebSocket delivery."""

from __future__ import annotations

import asyncio
from contextlib import suppress
from typing import Mapping

from fastapi import WebSocket, WebSocketDisconnect

from app.api.v1.replay import replay_error_payload, replay_service_from_state
from app.api.v1.stream_utils import send_json_with_timeout
from app.replay.actor import ActorStreamSubscription, ReplaySessionActor
from app.replay.constants import REPLAY_PROTOCOL, ReplayEventType
from app.replay.errors import ReplayDomainError, ReplayErrorCode
from app.replay.models import ReplayEvent, validate_identifier


async def stream_replay_session(
    websocket: WebSocket,
    *,
    session_id: str,
    after_sequence: int | None,
    data_epoch: str | None,
) -> None:
    """Register inside the actor boundary, then deliver its atomic handoff."""

    actor: ReplaySessionActor | None = None
    subscription: ActorStreamSubscription | None = None
    try:
        normalized_session = validate_identifier(session_id, field_name="session_id")
        service = replay_service_from_state(websocket.app.state)
        actor, subscription = await service.subscribe(
            normalized_session,
            after_sequence=after_sequence,
            data_epoch=data_epoch,
        )
    except (TypeError, ValueError):
        error = ReplayDomainError(
            ReplayErrorCode.SESSION_NOT_FOUND,
            "replay session does not exist",
        )
        await _reject(websocket, error, close_code=1008)
        return
    except ReplayDomainError as exc:
        close_code = (
            1013
            if exc.code
            in {ReplayErrorCode.REPLAY_DISABLED, ReplayErrorCode.PERSISTENCE_DEGRADED}
            else 1008
        )
        await _reject(websocket, exc, close_code=close_code)
        return

    await websocket.accept()
    sender = asyncio.create_task(
        _send_events(websocket, subscription),
        name=f"replay-ws-send-{normalized_session}",
    )
    receiver = asyncio.create_task(
        _receive_heartbeats(websocket, service, normalized_session),
        name=f"replay-ws-receive-{normalized_session}",
    )
    try:
        done, pending = await asyncio.wait(
            {sender, receiver},
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        for task in done:
            error = task.exception()
            if error is None or isinstance(error, WebSocketDisconnect):
                continue
            if (
                isinstance(error, ReplayDomainError)
                and error.code is ReplayErrorCode.SCAN_LIMIT_EXCEEDED
            ):
                await _send_resync_required(websocket, actor)
                with suppress(Exception):
                    await websocket.close(code=1013, reason="replay resync required")
                return
            if isinstance(error, ReplayDomainError):
                with suppress(Exception):
                    await send_json_with_timeout(websocket, replay_error_payload(error))
                with suppress(Exception):
                    await websocket.close(code=1008, reason=error.code.value)
                return
            raise error
    except (WebSocketDisconnect, RuntimeError, asyncio.TimeoutError):
        return
    finally:
        for task in (sender, receiver):
            if not task.done():
                task.cancel()
        await asyncio.gather(sender, receiver, return_exceptions=True)
        if actor is not None and subscription is not None:
            with suppress(Exception):
                await actor.unsubscribe(subscription.token)


async def _send_events(
    websocket: WebSocket,
    subscription: ActorStreamSubscription,
) -> None:
    for event in subscription.initial_events:
        await send_json_with_timeout(websocket, event.to_dict())
    while True:
        event = await subscription.next_event()
        await send_json_with_timeout(websocket, event.to_dict())


async def _receive_heartbeats(websocket: WebSocket, service, session_id: str) -> None:
    while True:
        message = await websocket.receive_json()
        if not isinstance(message, Mapping) or set(message) != {
            "type",
            "protocol",
            "client_instance_id",
        }:
            raise ReplayDomainError(
                ReplayErrorCode.INVALID_STATE_TRANSITION,
                "replay WebSocket accepts heartbeat messages only",
            )
        if (
            message["type"] != "replay.heartbeat"
            or message["protocol"] != REPLAY_PROTOCOL
        ):
            raise ReplayDomainError(
                ReplayErrorCode.INVALID_STATE_TRANSITION,
                "invalid replay heartbeat envelope",
            )
        try:
            client_id = validate_identifier(
                message["client_instance_id"],
                field_name="client_instance_id",
            )
        except (TypeError, ValueError) as exc:
            raise ReplayDomainError(
                ReplayErrorCode.INVALID_STATE_TRANSITION,
                "invalid replay heartbeat client_instance_id",
            ) from exc
        await service.heartbeat(session_id, client_id)


async def _send_resync_required(
    websocket: WebSocket,
    actor: ReplaySessionActor,
) -> None:
    snapshot = actor.current_snapshot()
    event = ReplayEvent(
        type=ReplayEventType.RESYNC_REQUIRED,
        protocol=REPLAY_PROTOCOL,
        session_id=snapshot.session_id,
        sequence=snapshot.sequence,
        revision=snapshot.revision,
        virtual_time_ms=snapshot.cursor.virtual_time_ms,
        state_hash=snapshot.state_hash,
        data_epoch=snapshot.data_epoch,
        data={"reset": True, "reason": "slow_client"},
    )
    with suppress(Exception):
        await send_json_with_timeout(websocket, event.to_dict())


async def _reject(
    websocket: WebSocket,
    error: ReplayDomainError,
    *,
    close_code: int,
) -> None:
    await websocket.accept()
    with suppress(Exception):
        await send_json_with_timeout(websocket, replay_error_payload(error))
    with suppress(Exception):
        await websocket.close(code=close_code, reason=error.code.value)


__all__ = ["stream_replay_session"]
