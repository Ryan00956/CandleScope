from __future__ import annotations

import json
from pathlib import Path
from typing import Mapping

import pytest

from app.replay.constants import REPLAY_PROTOCOL, CommandType
from app.replay.models import ReplayCommand
from app.replay.service import ReplayService, SYNTHETIC_TIME_ANCHOR_MS
from app.replay.storage import ReplaySQLiteStore
from tests.fixtures.replay.service_fakes import (
    INTERVAL_MS,
    NOW_MS,
    ROW_COUNT,
    START_MS,
    SessionIdFactory,
    replay_config,
    replay_repository,
    replay_settings,
)


pytestmark = pytest.mark.anyio


def _command(
    command_id: str,
    command_type: CommandType,
    revision: int,
    payload: Mapping[str, object] | None = None,
) -> ReplayCommand:
    return ReplayCommand(
        protocol=REPLAY_PROTOCOL,
        command_id=command_id,
        client_instance_id="no-lookahead-browser",
        expected_revision=revision,
        type=command_type,
        payload=payload or {},
    )


async def _service(path: Path) -> ReplayService:
    service = ReplayService(
        settings=replay_settings(path),
        store=ReplaySQLiteStore(path, now_ms=lambda: NOW_MS),
        repository=replay_repository(),
        now_ms=lambda: NOW_MS,
        session_id_factory=SessionIdFactory("no-lookahead"),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    return service


def _walk(value: object):
    yield value
    if isinstance(value, Mapping):
        for child in value.values():
            yield from _walk(child)
    elif isinstance(value, (list, tuple)):
        for child in value:
            yield from _walk(child)


def _assert_no_future_public_records(payload: object) -> None:
    for value in _walk(payload):
        if not isinstance(value, Mapping):
            continue
        cursor_value = value.get("cursor")
        cursor = (
            cursor_value.get("virtual_time_ms")
            if isinstance(cursor_value, Mapping)
            else value.get("virtual_time_ms")
        )
        if not isinstance(cursor, int):
            continue
        for nested in _walk(value):
            if not isinstance(nested, Mapping):
                continue
            for field in (
                "open_time_ms",
                "last_base_open_ms",
                "base_open_time_ms",
                "event_time_ms",
            ):
                timestamp = nested.get(field)
                if isinstance(timestamp, int):
                    assert timestamp <= cursor, (field, timestamp, cursor)


def _assert_blind(payload: object, *, path: Path) -> None:
    serialized = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    actual_times = {START_MS + index * INTERVAL_MS for index in range(ROW_COUNT + 3)}
    for timestamp in actual_times:
        assert str(timestamp) not in serialized
    assert str(path) not in serialized
    assert "source_fingerprint" not in serialized
    _assert_no_future_public_records(payload)


async def test_blind_public_boundary_never_leaks_future_or_actual_history_before_reveal(
    tmp_path: Path,
) -> None:
    database = tmp_path / "replay.db"
    service = await _service(database)
    try:
        catalog = await service.catalog(
            warmup_bars=2,
            horizon_ms=5 * INTERVAL_MS,
            quality_mode="exact",
            blind_mode=True,
        )
        assert catalog["blind_mode"] is True
        assert catalog["entries"][0]["bounds"] is None  # type: ignore[index]
        assert catalog["entries"][0]["eligible_ranges"] == []  # type: ignore[index]
        _assert_blind(catalog, path=database)

        created = await service.create_session(replay_config(blind_mode=True))
        session_id = str(created["session_id"])
        assert (
            created["snapshot"]["cursor"]["virtual_time_ms"] == SYNTHETIC_TIME_ANCHOR_MS
        )  # type: ignore[index]
        assert (
            created["snapshot"]["config"]["requested_start_ms"]
            == SYNTHETIC_TIME_ANCHOR_MS
        )  # type: ignore[index]
        _assert_blind(created, path=database)

        restored = await service.get_session(session_id)
        _assert_blind(restored, path=database)

        actor, subscription = await service.subscribe(
            session_id,
            after_sequence=None,
            data_epoch=None,
        )
        try:
            initial_events = [event.to_dict() for event in subscription.initial_events]
            assert initial_events[0]["type"] == "replay.snapshot"
            _assert_blind(initial_events, path=database)
        finally:
            await actor.unsubscribe(subscription.token)

        acquired = await service.command(
            session_id,
            _command("acquire", CommandType.ACQUIRE_CONTROLLER, 0),
        )
        _assert_blind(acquired, path=database)
        noted = await service.command(
            session_id,
            _command(
                "journal",
                CommandType.ADD_JOURNAL_NOTE,
                int(acquired["revision"]),
                {"text": "breakout confirmation"},
            ),
        )
        _assert_blind(noted, path=database)
        stepped = await service.command(
            session_id,
            _command(
                "step",
                CommandType.STEP,
                int(noted["revision"]),
                {"count": 3},
            ),
        )
        _assert_blind(stepped, path=database)
        _assert_blind(await service.journal(session_id), path=database)
        _assert_blind(await service.get_session(session_id), path=database)

        pre_end_report = await service.report(session_id)
        assert pre_end_report["revealed"] is False
        assert "actual_history" not in pre_end_report
        _assert_blind(pre_end_report, path=database)

        ended = await service.command(
            session_id,
            _command(
                "end",
                CommandType.END_SESSION,
                int(stepped["revision"]),
                {
                    "open_order_disposition": "expire",
                    "position_disposition": "keep",
                },
            ),
        )
        _assert_blind(ended, path=database)
        ended_report = await service.report(session_id)
        assert ended_report["revealed"] is False
        assert "actual_history" not in ended_report
        _assert_blind(ended_report, path=database)

        acquired_ended = await service.command(
            session_id,
            _command(
                "acquire-ended",
                CommandType.ACQUIRE_CONTROLLER,
                int(ended["revision"]),
            ),
        )
        revealed = await service.command(
            session_id,
            _command(
                "reveal",
                CommandType.REVEAL_HISTORY,
                int(acquired_ended["revision"]),
            ),
        )
        assert revealed["data"]["actual_history"] == {
            "replay_start_ms": START_MS + 4 * INTERVAL_MS,
            "replay_end_open_ms": START_MS + 8 * INTERVAL_MS,
        }
        revealed_report = await service.report(session_id)
        assert revealed_report["revealed"] is True
        assert revealed_report["actual_history"] == revealed["data"]["actual_history"]
    finally:
        await service.shutdown(step_timeout=1.0)
