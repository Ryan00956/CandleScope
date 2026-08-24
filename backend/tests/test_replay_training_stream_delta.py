from __future__ import annotations

import asyncio
from copy import deepcopy

import pytest

from app.api.v1 import stream_replay_training


def _apply_patch(projection: object, operations: list[dict[str, object]]) -> object:
    current = deepcopy(projection)
    for operation in operations:
        path = list(operation["path"])
        parent = current
        for segment in path[:-1]:
            parent = parent[segment]  # type: ignore[index]
        key = path[-1]
        if operation["op"] == "SET":
            parent[key] = deepcopy(operation["value"])  # type: ignore[index]
        elif operation["op"] == "REMOVE":
            if isinstance(parent, list):
                parent.pop(key)
            else:
                del parent[key]  # type: ignore[index]
        else:
            assert operation["op"] == "APPEND"
            parent[key].extend(deepcopy(operation["items"]))  # type: ignore[index]
    return current


def test_projection_patch_reconstructs_nested_track_and_account_changes() -> None:
    previous = {
        "run_id": "run-1",
        "tracks": [
            {"track_id": "track-1", "cursor": {"revision": 3}},
            {"track_id": "track-2", "cursor": {"revision": 4}},
        ],
        "portfolio": {
            "status": "ACTIVE",
            "hedge_state": {"risk_snapshots": [{"sequence": 1}]},
            "obsolete": True,
        },
    }
    current = {
        "run_id": "run-1",
        "tracks": [
            {"track_id": "track-1", "cursor": {"revision": 5}},
            {"track_id": "track-2", "cursor": {"revision": 4}},
        ],
        "portfolio": {
            "status": "ACTIVE",
            "hedge_state": {"risk_snapshots": [{"sequence": 1}, {"sequence": 2}]},
        },
    }

    operations = stream_replay_training._projection_patch(previous, current)

    assert operations is not None
    assert _apply_patch(previous, operations) == current
    assert {
        (operation["op"], tuple(operation["path"])) for operation in operations
    } == {
        ("SET", ("tracks", 0, "cursor", "revision")),
        ("REMOVE", ("portfolio", "obsolete")),
        ("APPEND", ("portfolio", "hedge_state", "risk_snapshots")),
    }


def test_projection_patch_falls_back_to_snapshot_when_operation_bound_is_exceeded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(stream_replay_training, "_MAX_PATCH_OPERATIONS", 1)

    assert (
        stream_replay_training._projection_patch(
            {"first": 1, "second": 2},
            {"first": 3, "second": 4},
        )
        is None
    )


def test_delta_messages_bind_their_base_sequence() -> None:
    projection = {"protocol": "replay.v3", "run_id": "run-1"}

    assert stream_replay_training._snapshot_message(
        projection,
        sequence=3,
    ) == {
        "protocol": "replay.v3",
        "schema_version": "replay.training.market-tracks-stream.v1",
        "type": "SNAPSHOT",
        "run_id": "run-1",
        "sequence": 3,
        "projection": projection,
    }
    assert (
        stream_replay_training._delta_message(
            projection,
            base_sequence=3,
            sequence=4,
            operations=[],
        )["base_sequence"]
        == 3
    )


@pytest.mark.anyio
async def test_delta_sender_emits_a_patch_after_the_initial_snapshot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    initial = {
        "protocol": "replay.v3",
        "run_id": "run-1",
        "tracks": [{"track_id": "track-1", "revision": 1}],
    }
    updated = {
        "protocol": "replay.v3",
        "run_id": "run-1",
        "tracks": [{"track_id": "track-1", "revision": 2}],
    }
    delivered = asyncio.Event()

    class Training:
        async def get_live_market_tracks(self, run_id: str) -> dict[str, object]:
            assert run_id == "run-1"
            return updated

    class WebSocket:
        def __init__(self) -> None:
            self.messages: list[dict[str, object]] = []

        async def send_json(self, message: dict[str, object]) -> None:
            self.messages.append(message)
            delivered.set()

    monkeypatch.setattr(stream_replay_training, "_COALESCE_SECONDS", 0)
    queue: asyncio.Queue[None] = asyncio.Queue(maxsize=1)
    queue.put_nowait(None)
    websocket = WebSocket()
    sender = asyncio.create_task(
        stream_replay_training._send_market_tracks(
            websocket,
            Training(),
            "run-1",
            queue,
            initial=initial,
        )
    )
    try:
        await asyncio.wait_for(delivered.wait(), timeout=0.5)
    finally:
        sender.cancel()
        await asyncio.gather(sender, return_exceptions=True)

    assert websocket.messages == [
        {
            "protocol": "replay.v3",
            "schema_version": "replay.training.market-tracks-stream.v1",
            "type": "DELTA",
            "run_id": "run-1",
            "base_sequence": 0,
            "sequence": 1,
            "operations": [
                {"op": "SET", "path": ["tracks", 0, "revision"], "value": 2}
            ],
        }
    ]


@pytest.mark.anyio
async def test_snapshot_sender_keeps_the_full_projection_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    updated = {
        "protocol": "replay.v3",
        "run_id": "run-1",
        "portfolio": {
            "hedge_state": {
                "schema_version": "replay.hedge-relational-state.v1",
                "risk_snapshots": [{"snapshot_sequence": 1}],
            }
        },
    }
    delivered = asyncio.Event()

    class Training:
        async def get_market_tracks(self, run_id: str) -> dict[str, object]:
            assert run_id == "run-1"
            return updated

    class WebSocket:
        def __init__(self) -> None:
            self.messages: list[dict[str, object]] = []

        async def send_json(self, message: dict[str, object]) -> None:
            self.messages.append(message)
            delivered.set()

    monkeypatch.setattr(stream_replay_training, "_COALESCE_SECONDS", 0)
    queue: asyncio.Queue[None] = asyncio.Queue(maxsize=1)
    queue.put_nowait(None)
    websocket = WebSocket()
    sender = asyncio.create_task(
        stream_replay_training._send_market_tracks(
            websocket,
            Training(),
            "run-1",
            queue,
            initial=None,
        )
    )
    try:
        await asyncio.wait_for(delivered.wait(), timeout=0.5)
    finally:
        sender.cancel()
        await asyncio.gather(sender, return_exceptions=True)

    assert websocket.messages == [updated]
