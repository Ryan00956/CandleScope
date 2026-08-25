"""Run-centric replay.v3 MarketTrack projection stream."""

from __future__ import annotations

import asyncio
from contextlib import suppress
from typing import Mapping, Sequence

from fastapi import WebSocket, WebSocketDisconnect

from app.api.v1.stream_utils import send_json_with_timeout
from app.replay.training.errors import TrainingRunError


_COALESCE_SECONDS = 0.25
MARKET_TRACK_STREAM_DELTA_MODE = "delta.v1"
MARKET_TRACK_STREAM_SCHEMA_VERSION = "replay.training.market-tracks-stream.v1"
_MAX_PATCH_OPERATIONS = 4_096


def _snapshot_message(
    projection: Mapping[str, object],
    *,
    sequence: int,
) -> dict[str, object]:
    return {
        "protocol": projection.get("protocol"),
        "schema_version": MARKET_TRACK_STREAM_SCHEMA_VERSION,
        "type": "SNAPSHOT",
        "run_id": projection.get("run_id"),
        "sequence": sequence,
        "projection": dict(projection),
    }


def _projection_patch(
    previous: object,
    current: object,
) -> list[dict[str, object]] | None:
    """Build a bounded structural patch without weakening projection validation.

    Stable objects and fixed-length arrays are compared recursively. Append-only
    audit arrays stay append-only on the wire; structural churn falls back to a
    replacement operation. Returning ``None`` asks the caller for a new snapshot.
    """

    operations: list[dict[str, object]] = []

    def add(operation: dict[str, object]) -> bool:
        operations.append(operation)
        return len(operations) <= _MAX_PATCH_OPERATIONS

    def visit(before: object, after: object, path: tuple[str | int, ...]) -> bool:
        if before == after:
            return True
        if isinstance(before, Mapping) and isinstance(after, Mapping):
            before_keys = set(before)
            after_keys = set(after)
            for key in sorted(before_keys - after_keys):
                if not isinstance(key, str) or not add(
                    {"op": "REMOVE", "path": [*path, key]}
                ):
                    return False
            for key in sorted(after_keys):
                if not isinstance(key, str):
                    return False
                next_path = (*path, key)
                if key not in before:
                    if not add(
                        {"op": "SET", "path": list(next_path), "value": after[key]}
                    ):
                        return False
                elif not visit(before[key], after[key], next_path):
                    return False
            return True
        if (
            isinstance(before, Sequence)
            and not isinstance(before, (str, bytes, bytearray))
            and isinstance(after, Sequence)
            and not isinstance(after, (str, bytes, bytearray))
        ):
            if len(after) >= len(before) and list(before) == list(after[: len(before)]):
                appended = list(after[len(before) :])
                return not appended or add(
                    {"op": "APPEND", "path": list(path), "items": appended}
                )
            if len(before) == len(after):
                for index, item in enumerate(after):
                    if not visit(before[index], item, (*path, index)):
                        return False
                return True
        return add({"op": "SET", "path": list(path), "value": after})

    if not visit(previous, current, ()):
        return None
    return operations


def _delta_message(
    projection: Mapping[str, object],
    *,
    base_sequence: int,
    sequence: int,
    operations: list[dict[str, object]],
) -> dict[str, object]:
    return {
        "protocol": projection.get("protocol"),
        "schema_version": MARKET_TRACK_STREAM_SCHEMA_VERSION,
        "type": "DELTA",
        "run_id": projection.get("run_id"),
        "base_sequence": base_sequence,
        "sequence": sequence,
        "operations": operations,
    }


async def stream_replay_training_run(
    websocket: WebSocket,
    *,
    training,
    run_id: str,
    delta_enabled: bool = False,
) -> None:
    """Send a gap-free initial projection followed by coalesced updates."""

    queue: asyncio.Queue[None] | None = None
    try:
        initial, queue = await training.subscribe_market_tracks(
            run_id,
            live=delta_enabled,
        )
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
        await send_json_with_timeout(
            websocket,
            _snapshot_message(initial, sequence=0) if delta_enabled else initial,
        )
        sender = asyncio.create_task(
            _send_market_tracks(
                websocket,
                training,
                run_id,
                queue,
                initial=initial if delta_enabled else None,
            ),
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


async def _send_market_tracks(
    websocket,
    training,
    run_id,
    queue,
    *,
    initial: Mapping[str, object] | None = None,
) -> None:
    previous = None if initial is None else dict(initial)
    sequence = 0
    while True:
        await queue.get()
        await asyncio.sleep(_COALESCE_SECONDS)
        while not queue.empty():
            queue.get_nowait()
        projection = await (
            training.get_live_market_tracks(run_id)
            if initial is not None
            else training.get_market_tracks(run_id)
        )
        if previous is None:
            await send_json_with_timeout(websocket, projection)
            continue
        operations = _projection_patch(previous, projection)
        if operations == []:
            previous = projection
            continue
        next_sequence = sequence + 1
        message = (
            _snapshot_message(projection, sequence=next_sequence)
            if operations is None
            else _delta_message(
                projection,
                base_sequence=sequence,
                sequence=next_sequence,
                operations=operations,
            )
        )
        await send_json_with_timeout(websocket, message)
        previous = projection
        sequence = next_sequence


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


__all__ = [
    "MARKET_TRACK_STREAM_DELTA_MODE",
    "MARKET_TRACK_STREAM_SCHEMA_VERSION",
    "stream_replay_training_run",
]
