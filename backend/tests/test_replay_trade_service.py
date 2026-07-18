from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.data_engine.storage.raw_trade_archive import ParquetRawAggTradeArchive
from app.replay.constants import REPLAY_PROTOCOL, CommandType, SessionState
from app.replay.models import ReplayCommand
from app.replay.service import ReplayService, SYNTHETIC_TIME_ANCHOR_MS
from app.replay.storage import ReplaySQLiteStore
from tests.fixtures.replay.service_fakes import SessionIdFactory, replay_settings
from tests.fixtures.replay.trade_service_fakes import (
    TRADE_NOW_MS,
    TRADE_REPLAY_START_MS,
    trade_replay_config,
    trade_replay_repository,
    verified_trade_archive,
)


pytestmark = pytest.mark.anyio


def _command(
    command_id: str,
    command_type: CommandType,
    revision: int,
    payload: dict[str, object] | None = None,
) -> ReplayCommand:
    return ReplayCommand(
        protocol=REPLAY_PROTOCOL,
        command_id=command_id,
        client_instance_id="trade-browser",
        expected_revision=revision,
        type=command_type,
        payload=payload or {},
    )


async def _service(
    database: Path,
    archive,
    *,
    prefix: str,
) -> ReplayService:
    service = ReplayService(
        settings=replay_settings(database),
        store=ReplaySQLiteStore(database, now_ms=lambda: TRADE_NOW_MS),
        repository=trade_replay_repository(),
        raw_trade_archive=archive,
        now_ms=lambda: TRADE_NOW_MS,
        session_id_factory=SessionIdFactory(prefix),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    return service


async def test_trade_service_uses_shared_actor_api_and_pin_lifecycle(
    tmp_path: Path,
) -> None:
    archive = verified_trade_archive(tmp_path / "archive")
    service = await _service(tmp_path / "replay.db", archive, prefix="trade")
    capability = service.capabilities()["sources"]["agg_trade"]
    assert capability["enabled"] is True
    assert capability["fidelity"] == "EXACT_AGG_TRADE_COVERAGE"

    created = await service.create_session(trade_replay_config())
    session_id = str(created["session_id"])
    assert created["data_fidelity"] == "EXACT_AGG_TRADE_COVERAGE"
    assert created["execution_fidelity"] == "AGG_TRADE_TAPE"
    assert created["snapshot"]["state"] == SessionState.PAUSED.value
    assert archive.diagnostics()["active_pins"] == 1

    acquired = await service.command(
        session_id,
        _command("acquire", CommandType.ACQUIRE_CONTROLLER, 0),
    )
    stepped = await service.command(
        session_id,
        _command("step", CommandType.STEP, acquired["revision"], {"count": 3}),
    )
    assert stepped["cursor"]["source_sequence"] == 3
    assert stepped["cursor"]["last_agg_trade_id"] == 1_002
    assert stepped["cursor"]["last_trade_time_ms"] is not None
    assert stepped["cursor"]["last_base_bar_open_ms"] is None

    forked = await service.fork_session(session_id)
    assert forked["snapshot"]["state_hash"] == stepped["state_hash"]
    assert archive.diagnostics()["active_pins"] == 2
    await service.shutdown(step_timeout=0.2)
    assert archive.diagnostics()["active_pins"] == 0


async def test_trade_capability_stays_closed_without_a_verified_exact_partition(
    tmp_path: Path,
) -> None:
    archive = ParquetRawAggTradeArchive(tmp_path / "empty-archive")
    service = await _service(tmp_path / "empty.db", archive, prefix="empty-trade")

    capability = service.capabilities()["sources"]["agg_trade"]
    assert capability == {
        "enabled": False,
        "reason": "DATASET_INCOMPLETE",
    }
    await service.shutdown(step_timeout=0.2)


async def test_blind_trade_service_never_exposes_archive_paths_or_actual_time(
    tmp_path: Path,
) -> None:
    archive = verified_trade_archive(tmp_path / "private-archive")
    service = await _service(tmp_path / "replay.db", archive, prefix="blind-trade")
    created = await service.create_session(trade_replay_config(blind_mode=True))
    session_id = str(created["session_id"])
    serialized = json.dumps(created, sort_keys=True)
    assert str(TRADE_REPLAY_START_MS) not in serialized
    assert "date=2026-06-01" not in serialized
    assert ".parquet" not in serialized
    assert str(tmp_path) not in serialized
    assert created["snapshot"]["cursor"]["virtual_time_ms"] == (
        SYNTHETIC_TIME_ANCHOR_MS
    )

    acquired = await service.command(
        session_id,
        _command("acquire", CommandType.ACQUIRE_CONTROLLER, 0),
    )
    stepped = await service.command(
        session_id,
        _command("step", CommandType.STEP, acquired["revision"], {"count": 1}),
    )
    serialized_step = json.dumps(stepped, sort_keys=True)
    assert str(TRADE_REPLAY_START_MS) not in serialized_step
    assert "date=2026-06-01" not in serialized_step
    assert stepped["cursor"]["last_trade_time_ms"] == SYNTHETIC_TIME_ANCHOR_MS + 1_000
    await service.shutdown(step_timeout=0.2)


async def test_trade_service_recovers_checkpoint_and_revalidates_generation(
    tmp_path: Path,
) -> None:
    archive = verified_trade_archive(tmp_path / "archive")
    database = tmp_path / "replay.db"
    service = await _service(database, archive, prefix="first")
    created = await service.create_session(trade_replay_config())
    session_id = str(created["session_id"])
    acquired = await service.command(
        session_id,
        _command("acquire", CommandType.ACQUIRE_CONTROLLER, 0),
    )
    stepped = await service.command(
        session_id,
        _command("step", CommandType.STEP, acquired["revision"], {"count": 3}),
    )
    expected_hash = stepped["state_hash"]
    await service.shutdown(step_timeout=0.2)
    assert archive.diagnostics()["active_pins"] == 0

    recovered_service = await _service(database, archive, prefix="second")
    recovered = await recovered_service.get_session(session_id)
    assert recovered["snapshot"]["state"] == SessionState.PAUSED.value
    assert recovered["snapshot"]["state_hash"] == expected_hash
    assert recovered["snapshot"]["cursor"]["last_agg_trade_id"] == 1_002
    assert archive.diagnostics()["active_pins"] == 1
    await recovered_service.shutdown(step_timeout=0.2)
    assert archive.diagnostics()["active_pins"] == 0
