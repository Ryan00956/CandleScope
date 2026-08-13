"""Run-centric replay.v3 MarketTrack projection stream."""

from __future__ import annotations

import asyncio
from contextlib import suppress
from typing import Mapping

from fastapi import WebSocket, WebSocketDisconnect

from app.api.v1.stream_utils import send_json_with_timeout
from app.replay.training.errors import TrainingRunError


_COALESCE_SECONDS = 0.25


async def stream_replay_training_run(
    websocket: WebSocket,
    *,
    training,
    run_id: str,
) -> None:
    """Send a gap-free initial projection followed by coalesced snapshots."""

    queue: asyncio.Queue[None] | None = None
    try:
        initial, queue = await training.subscribe_market_tracks(run_id)
    except TrainingRunError as error:
        await websocket.accept()
        await send_json_with_timeout(websocket, error.to_payload())
        await websocket.close(
            code=1008 if error.status_code < 500 else 1013,
            reason=error.code,
        )
        return

    sender: asyncio.Task[None] | None = None
    receiver: asyncio.Task[None] | None = None
    try:
        await websocket.accept()
        await send_json_with_timeout(websocket, initial)
        sender = asyncio.create_task(
            _send_market_tracks(websocket, training, run_id, queue),
            name=f"replay-v3-run-send-{run_id}",
        )
        receiver = asyncio.create_task(
            _receive_disconnect(websocket),
            name=f"replay-v3-run-receive-{run_id}",
        )
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
            raise error
    except (WebSocketDisconnect, RuntimeError, asyncio.TimeoutError):
        return
    finally:
        for task in (sender, receiver):
            if task is not None and not task.done():
                task.cancel()
        tasks = tuple(task for task in (sender, receiver) if task is not None)
        if tasks:
            with suppress(Exception):
                await asyncio.gather(*tasks, return_exceptions=True)
        training.unsubscribe_market_tracks(run_id, queue)


async def _send_market_tracks(websocket, training, run_id, queue) -> None:
    while True:
        await queue.get()
        await asyncio.sleep(_COALESCE_SECONDS)
        while not queue.empty():
            queue.get_nowait()
        projection = await training.get_market_tracks(run_id)
        await send_json_with_timeout(websocket, projection)


async def _receive_disconnect(websocket: WebSocket) -> None:
    while True:
        message = await websocket.receive()
        if not isinstance(message, Mapping):
            continue
        if message.get("type") == "websocket.disconnect":
            raise WebSocketDisconnect(int(message.get("code", 1000)))
        if message.get("type") == "websocket.receive":
            await websocket.close(
                code=1008,
                reason="replay.v3 run stream is server-push only",
            )
            return


__all__ = ["stream_replay_training_run"]
