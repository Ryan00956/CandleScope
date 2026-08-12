from __future__ import annotations

import asyncio
import json
import sqlite3
from dataclasses import replace
from pathlib import Path

import pytest

from app.replay.constants import REPLAY_PROTOCOL, CommandType
from app.replay.errors import ReplayDomainError, ReplayErrorCode
from app.replay.models import ReplayCommand
from app.replay.service import ReplayService
from app.replay.storage import REPLAY_SCHEMA_VERSION, ReplaySQLiteStore
from app.replay.training.errors import TrainingRunError
from app.replay.training.models import StartMode, TrainingRunCreateRequest
from app.replay.training.schema import (
    TRAINING_SCHEMA_VERSION,
    migrate_training_schema,
)
from tests.fixtures.replay.service_fakes import (
    INTERVAL_MS,
    NOW_MS,
    START_MS,
    SessionIdFactory,
    replay_config,
    replay_repository,
    replay_settings,
)


pytestmark = pytest.mark.anyio


async def _service(path: Path, *, run_prefix: str = "run") -> ReplayService:
    settings = replay_settings(path)
    store = ReplaySQLiteStore(path, now_ms=lambda: NOW_MS)
    service = ReplayService(
        settings=settings,
        store=store,
        repository=replay_repository(),
        now_ms=lambda: NOW_MS,
        session_id_factory=SessionIdFactory("adapter"),
        training_run_id_factory=SessionIdFactory(run_prefix),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    assert service.training is not None
    return service


async def _request(
    service: ReplayService,
    *,
    name: str | None = "BTC 手动训练",
    time_disclosure_policy: str = "NONE",
) -> TrainingRunCreateRequest:
    catalog = await service.catalog(
        warmup_bars=2,
        horizon_ms=5 * INTERVAL_MS,
        quality_mode="exact",
        blind_mode=time_disclosure_policy != "NONE",
    )
    return TrainingRunCreateRequest.from_dict(
        {
            "protocol": "replay.v3",
            "catalog_epoch": catalog["catalog_epoch"],
            "name": name,
            "source_kind": "BAR",
            "start_mode": "MANUAL",
            "exchange": "binance",
            "market_type": "spot",
            "symbol": "BTCUSDT",
            "settlement_asset": "USDT",
            "base_interval": "1m",
            "display_interval": "1m",
            "requested_start_ms": START_MS + 4 * INTERVAL_MS,
            "warmup_bars": 2,
            "forward_cache_ms": 5 * INTERVAL_MS,
            "random_seed": 42,
            "initial_equity": "10000",
            "max_leverage": "3",
            "maker_fee_bps": "2",
            "taker_fee_bps": "5",
            "market_slippage_bps": "1",
            "integrity_mode": "CHALLENGE",
            "time_disclosure_policy": time_disclosure_policy,
            "book_mode": "OFF",
            "margin_mode": "CROSS",
            "position_mode": "ONE_WAY",
            "funding_mode": "OFF",
            "account_data_mode": "APPROX_PROXY",
            "allow_rule_changes": False,
        }
    )


def _command(
    command_id: str,
    command_type: CommandType,
    *,
    revision: int,
) -> ReplayCommand:
    return ReplayCommand(
        protocol=REPLAY_PROTOCOL,
        command_id=command_id,
        client_instance_id="phase1-browser",
        expected_revision=revision,
        type=command_type,
        payload={},
    )


async def test_training_schema_is_separate_from_internal_adapter_schema(
    tmp_path: Path,
) -> None:
    path = tmp_path / "replay.db"
    service = await _service(path)
    await service.shutdown(step_timeout=1.0)

    with sqlite3.connect(path) as connection:
        assert connection.execute(
            "SELECT version FROM replay_schema_version WHERE singleton = 1"
        ).fetchone() == (REPLAY_SCHEMA_VERSION,)
        assert connection.execute(
            "SELECT version FROM replay_training_schema_version WHERE singleton = 1"
        ).fetchone() == (TRAINING_SCHEMA_VERSION,)
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
    assert {
        "replay_training_run",
        "replay_training_market_track",
        "replay_training_rule",
        "replay_training_action",
        "replay_training_pin",
        "replay_training_selection_preparation",
    }.issubset(tables)
    assert "replay_training_track" not in tables


@pytest.mark.parametrize("obsolete_version", range(1, TRAINING_SCHEMA_VERSION))
def test_obsolete_training_schema_requires_a_fresh_database(
    obsolete_version: int,
) -> None:
    with sqlite3.connect(":memory:") as connection:
        connection.execute(
            "CREATE TABLE replay_training_schema_version "
            "(singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL)"
        )
        connection.execute(
            "INSERT INTO replay_training_schema_version VALUES (1, ?)",
            (obsolete_version,),
        )
        with pytest.raises(
            RuntimeError,
            match=rf"schema {obsolete_version} is obsolete.*clear replay training data",
        ):
            migrate_training_schema(connection, now_ms=NOW_MS)

async def test_enabled_replay_always_creates_training_schema(tmp_path: Path) -> None:
    path = tmp_path / "training-required.db"
    settings = replay_settings(path)
    service = ReplayService(
        settings=settings,
        store=ReplaySQLiteStore(path, now_ms=lambda: NOW_MS),
        repository=replay_repository(),
        now_ms=lambda: NOW_MS,
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    try:
        assert service.training is not None
        with sqlite3.connect(path) as connection:
            assert connection.execute(
                "SELECT COUNT(*) FROM sqlite_master "
                "WHERE type = 'table' AND name LIKE 'replay_training_%'"
            ).fetchone()[0] > 0
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_return_to_hub_transfers_recovery_lease_before_idle_reaper(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "return-hub-recovery-race.db"
    now = [NOW_MS]
    settings = replace(
        replay_settings(path),
        idle_ttl_seconds=60,
    )
    service = ReplayService(
        settings=settings,
        store=ReplaySQLiteStore(path, now_ms=lambda: now[0]),
        repository=replay_repository(),
        now_ms=lambda: now[0],
        session_id_factory=SessionIdFactory("adapter-race"),
        training_run_id_factory=SessionIdFactory("run-race"),
        native_intervals=lambda _identity: ("1m",),
    )
    await service.start()
    assert service.training is not None
    prune_task: asyncio.Task[None] | None = None
    try:
        created = await service.training.create_run(await _request(service))
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])
        first_return = await service.training.return_to_hub(run_id)
        assert first_return["released"] is True
        assert session_id not in service._sessions

        lease_released = asyncio.Event()
        prune_complete = asyncio.Event()
        original_release_lease = service._release_handle_lease
        original_get_session = service.get_session

        def release_lease_and_open_reaper_window(handle) -> None:
            original_release_lease(handle)
            if handle.session_id == session_id and handle.in_flight == 0:
                now[0] += 60_001
                lease_released.set()

        async def wait_for_adversarial_prune(
            requested_session_id: str,
        ) -> dict[str, object]:
            payload = await original_get_session(requested_session_id)
            if requested_session_id == session_id:
                await asyncio.wait_for(prune_complete.wait(), timeout=1.0)
            return payload

        monkeypatch.setattr(
            service,
            "_release_handle_lease",
            release_lease_and_open_reaper_window,
        )
        monkeypatch.setattr(service, "get_session", wait_for_adversarial_prune)

        async def prune_as_soon_as_the_recovery_lease_is_released() -> None:
            await asyncio.wait_for(lease_released.wait(), timeout=1.0)
            await service._prune_reclaimable_sessions()
            prune_complete.set()

        prune_task = asyncio.create_task(
            prune_as_soon_as_the_recovery_lease_is_released()
        )
        returned = await asyncio.wait_for(
            service.training.return_to_hub(run_id),
            timeout=2.0,
        )
        await asyncio.wait_for(prune_task, timeout=2.0)

        assert returned["released"] is True
        assert prune_complete.is_set()
        assert session_id not in service._sessions
    finally:
        if prune_task is not None and not prune_task.done():
            prune_task.cancel()
            await asyncio.gather(prune_task, return_exceptions=True)
        await service.shutdown(step_timeout=1.0)


async def test_create_run_atomically_persists_adapter_track_rule_action_and_pin(
    tmp_path: Path,
) -> None:
    path = tmp_path / "replay.db"
    service = await _service(path)
    try:
        created = await service.training.create_run(await _request(service))  # type: ignore[union-attr]
        assert created["protocol"] == "replay.v3"
        run = created["run"]
        assert run["run_id"] == "run-1"
        assert run["adapter_session_id"] == "adapter-1"
        assert run["kind"] == "V2"
        assert run["state"] == "PAUSED"
        assert run["equity"] == "10000"
        assert run["equity_status"] == "CURRENT"
        assert run["subscribed_track_count"] == 1

        with sqlite3.connect(path) as connection:
            counts = {
                table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                for table in (
                    "replay_session",
                    "replay_dataset_ref",
                    "replay_checkpoint",
                    "replay_training_run",
                    "replay_training_launch_context",
                    "replay_training_market_track",
                    "replay_training_rule",
                    "replay_training_action",
                    "replay_training_pin",
                    "replay_training_selection_preparation",
                )
            }
        assert counts == {
            "replay_session": 1,
            "replay_dataset_ref": 1,
            "replay_checkpoint": 1,
            "replay_training_run": 1,
            "replay_training_launch_context": 1,
            "replay_training_market_track": 1,
            "replay_training_rule": 1,
            "replay_training_action": 1,
            "replay_training_pin": 1,
            "replay_training_selection_preparation": 1,
        }
        preparation = await service.training.get_selection_preparation("run-1")  # type: ignore[union-attr]
        assert preparation["preparation"]["status"] == "READY"
        assert str(preparation["preparation"]["dataset_epoch"]).startswith("sha256:")
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_create_run_rolls_back_every_row_and_runtime_pin_on_late_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "atomic-failure.db"
    service = await _service(path)
    training = service.training
    assert training is not None

    def fail_action(*_args, **_kwargs) -> None:
        raise RuntimeError("injected initial action failure")

    monkeypatch.setattr(training.store, "_insert_initial_action", fail_action)
    try:
        with pytest.raises(RuntimeError, match="initial action failure"):
            await training.create_run(await _request(service))
        assert service._sessions == {}
        with sqlite3.connect(path) as connection:
            for table in (
                "replay_session",
                "replay_dataset_ref",
                "replay_checkpoint",
                "replay_training_run",
                "replay_training_launch_context",
                "replay_training_market_track",
                "replay_training_rule",
                "replay_training_action",
                "replay_training_pin",
            ):
                assert connection.execute(
                    f"SELECT COUNT(*) FROM {table}"
                ).fetchone() == (0,)
            failed = connection.execute(
                """
                SELECT status, error_code
                FROM replay_training_selection_preparation
                """
            ).fetchone()
            assert failed == ("FAILED", "RuntimeError")
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_failed_materialization_retry_reuses_committed_random_selection(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "prepare-before-materialize.db"
    service = await _service(path)
    training = service.training
    assert training is not None
    request = replace(
        await _request(service),
        start_mode=StartMode.RANDOM,
        requested_start_ms=None,
    )

    original_select = service.select_training_window
    original_create = service._dataset_builder.create
    selection_attempts = 0
    materialization_attempts = 0

    async def track_selection(*args, **kwargs):
        nonlocal selection_attempts
        selection_attempts += 1
        return await original_select(*args, **kwargs)

    def fail_first_materialization(*args, **kwargs):
        nonlocal materialization_attempts
        materialization_attempts += 1
        if materialization_attempts == 1:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_INCOMPLETE,
                "injected remote download failure",
            )
        return original_create(*args, **kwargs)

    monkeypatch.setattr(
        service._dataset_builder,
        "create",
        fail_first_materialization,
    )
    monkeypatch.setattr(service, "select_training_window", track_selection)
    try:
        with pytest.raises(TrainingRunError) as failed:
            await training.create_run(request)
        assert failed.value.details["preparation_id"] == "run-1"
        with sqlite3.connect(path) as connection:
            connection.row_factory = sqlite3.Row
            row = connection.execute(
                "SELECT * FROM replay_training_selection_preparation"
            ).fetchone()
            assert row is not None
            assert row["status"] == "FAILED"
            assert row["error_code"] == "DATASET_INCOMPLETE"
            assert row["start_mode"] == "RANDOM"
            assert row["random_seed"] is not None
            assert row["selected_start_ms"] >= row["required_start_ms"]
            assert row["selection_hash"].startswith("sha256:")
            committed = {
                "random_seed": row["random_seed"],
                "selected_start_ms": row["selected_start_ms"],
                "selection_hash": row["selection_hash"],
                "catalog_epoch": row["catalog_epoch"],
                "source_fingerprint": row["source_fingerprint"],
            }
            assert (
                connection.execute(
                    "SELECT COUNT(*) FROM replay_training_run"
                ).fetchone()[0]
                == 0
            )

        retried = await training.retry_selection_preparation("run-1")
        assert retried["run"]["run_id"] == "run-1"
        assert selection_attempts == 1
        assert materialization_attempts == 2
        with sqlite3.connect(path) as connection:
            connection.row_factory = sqlite3.Row
            row = connection.execute(
                "SELECT * FROM replay_training_selection_preparation"
            ).fetchone()
            assert row is not None
            assert row["status"] == "READY"
            assert row["retry_count"] == 1
            assert row["error_code"] is None
            assert {
                "random_seed": row["random_seed"],
                "selected_start_ms": row["selected_start_ms"],
                "selection_hash": row["selection_hash"],
                "catalog_epoch": row["catalog_epoch"],
                "source_fingerprint": row["source_fingerprint"],
            } == committed
            assert (
                connection.execute(
                    "SELECT COUNT(*) FROM replay_training_run"
                ).fetchone()[0]
                == 1
            )

        with pytest.raises(TrainingRunError) as not_retryable:
            await training.retry_selection_preparation("run-1")
        assert not_retryable.value.code == "TRAINING_PREPARATION_NOT_RETRYABLE"
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_restart_marks_interrupted_preparation_retryable_and_reuses_commitment(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "restart-interrupted-preparation.db"
    service = await _service(path)
    training = service.training
    assert training is not None
    request = replace(
        await _request(service),
        start_mode=StartMode.RANDOM,
        requested_start_ms=None,
    )
    selection = await service.select_training_window(
        service.training._adapter_config(request),
        expected_catalog_epoch=request.catalog_epoch,
        minimum_history_bars=request.indicator_warmup_bars,
    )
    selected_start_ms = int(selection["selected_start_ms"])
    await training.store.create_selection_preparation(
        preparation_id="restart-retry-1",
        start_mode=request.start_mode.value,
        random_seed=request.random_seed,
        catalog_epoch=request.catalog_epoch,
        source_fingerprint=str(selection["source_fingerprint"]),
        selected_start_ms=selected_start_ms,
        required_start_ms=selected_start_ms - 2 * INTERVAL_MS,
        required_end_ms=selected_start_ms + 4 * INTERVAL_MS,
        interval_ms=INTERVAL_MS,
        request=request,
        selection=selection,
    )
    await service.shutdown(step_timeout=1.0)

    restarted = await _service(path, run_prefix="restart-run")
    assert restarted.training is not None
    selection_attempts = 0
    original_select = restarted.select_training_window

    async def track_selection(*args, **kwargs):
        nonlocal selection_attempts
        selection_attempts += 1
        return await original_select(*args, **kwargs)

    monkeypatch.setattr(restarted, "select_training_window", track_selection)
    try:
        interrupted = await restarted.training.get_selection_preparation(
            "restart-retry-1"
        )
        assert interrupted["preparation"]["status"] == "FAILED"
        assert interrupted["preparation"]["error_code"] == "PROCESS_RESTARTED"

        retried = await restarted.training.retry_selection_preparation(
            "restart-retry-1"
        )
        assert retried["run"]["run_id"] == "restart-retry-1"
        assert selection_attempts == 0
        completed = await restarted.training.get_selection_preparation(
            "restart-retry-1"
        )
        assert completed["preparation"]["status"] == "READY"
        assert completed["preparation"]["retry_count"] == 1
    finally:
        await restarted.shutdown(step_timeout=1.0)


async def test_create_rejects_catalog_epoch_drift_without_partial_rows(
    tmp_path: Path,
) -> None:
    path = tmp_path / "epoch-drift.db"
    service = await _service(path)
    request = replace(
        await _request(service),
        catalog_epoch=f"sha256:{'f' * 64}",
    )
    try:
        with pytest.raises(TrainingRunError) as stale:
            await service.training.create_run(request)  # type: ignore[union-attr]
        assert stale.value.code == "CATALOG_EPOCH_MISMATCH"
        with sqlite3.connect(path) as connection:
            assert connection.execute(
                "SELECT COUNT(*) FROM replay_session"
            ).fetchone() == (0,)
            assert connection.execute(
                "SELECT COUNT(*) FROM replay_training_run"
            ).fetchone() == (0,)
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_unowned_adapter_sessions_never_enter_the_training_hub(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "adapter-only.db")
    training = service.training
    assert training is not None
    try:
        adapter = await service.create_session(replay_config())
        listed = await training.list_runs(
            limit=50,
            cursor=None,
            state=None,
            source_kind=None,
            compatibility=None,
        )
        assert listed["items"] == []

        with pytest.raises(TrainingRunError) as invalid_filter:
            await training.list_runs(
                limit=50,
                cursor=None,
                state=None,
                source_kind=None,
                compatibility="LEGACY_V1",
            )
        assert invalid_filter.value.code == "TRAINING_RUN_INVALID"

        with pytest.raises(TrainingRunError) as unowned_session:
            await training.store.run_id_for_session(str(adapter["session_id"]))
        assert unowned_session.value.code == "TRAINING_RUN_NOT_FOUND"
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_blind_run_card_never_exposes_history_identity_or_actual_time(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "blind.db")
    try:
        created = await service.training.create_run(  # type: ignore[union-attr]
            await _request(service, time_disclosure_policy="HIDE_ALL")
        )
        listed = await service.training.list_runs(  # type: ignore[union-attr]
            limit=20,
            cursor=None,
            state=None,
            source_kind=None,
            compatibility=None,
        )
        serialized = json.dumps(
            {"created": created, "listed": listed},
            sort_keys=True,
        )
        assert str(START_MS) not in serialized
        assert "dataset_epoch" not in serialized
        assert "snapshot" not in serialized
        assert "partition" not in serialized
        assert listed["items"][0]["time_disclosure_policy"] == "HIDE_ALL"
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_return_to_hub_pauses_checkpoints_releases_and_recovers(
    tmp_path: Path,
) -> None:
    path = tmp_path / "return-hub.db"
    service = await _service(path)
    try:
        created = await service.training.create_run(await _request(service))  # type: ignore[union-attr]
        run_id = str(created["run"]["run_id"])
        session_id = created["run"]["adapter_session_id"]
        await service.command(
            session_id,
            _command("acquire", CommandType.ACQUIRE_CONTROLLER, revision=0),
        )
        await service.command(
            session_id,
            _command("play", CommandType.PLAY, revision=1),
        )
        returned = await service.training.return_to_hub(run_id)  # type: ignore[union-attr]
        assert returned == {
            "protocol": "replay.v3",
            "run_id": "run-1",
            "state": "PAUSED",
            "checkpointed": True,
            "released": True,
        }
        assert session_id not in service._sessions
        with sqlite3.connect(path) as connection:
            assert connection.execute(
                "SELECT state FROM replay_session WHERE session_id = ?",
                (session_id,),
            ).fetchone() == ("PAUSED",)
            durable = connection.execute(
                "SELECT source_sequence, state_hash FROM replay_session WHERE session_id = ?",
                (session_id,),
            ).fetchone()
            latest_checkpoint = connection.execute(
                "SELECT source_sequence, state_hash FROM replay_checkpoint "
                "WHERE session_id = ? AND active = 1 ORDER BY checkpoint_id DESC LIMIT 1",
                (session_id,),
            ).fetchone()
            assert latest_checkpoint == durable
        recovered = await service.get_session(session_id)
        assert recovered["snapshot"]["state"] == "PAUSED"
    finally:
        await service.shutdown(step_timeout=1.0)


async def test_ended_run_card_is_labeled_for_review_instead_of_continue(
    tmp_path: Path,
) -> None:
    service = await _service(tmp_path / "ended-card.db")
    try:
        training = service.training
        assert training is not None
        created = await training.create_run(await _request(service))
        run_id = str(created["run"]["run_id"])
        session_id = str(created["run"]["adapter_session_id"])
        await service.command(
            session_id,
            _command("acquire-ended", CommandType.ACQUIRE_CONTROLLER, revision=0),
        )
        revision = 1
        ended: dict[str, object] | None = None
        for index in range(30):
            result = await service.command(
                session_id,
                ReplayCommand(
                    protocol=REPLAY_PROTOCOL,
                    command_id=f"step-to-end-{index}",
                    client_instance_id="phase1-browser",
                    expected_revision=revision,
                    type=CommandType.STEP,
                    payload={"count": 1},
                ),
            )
            revision = int(result["revision"])
            if result["state"] == "ENDED":
                ended = result
                break
        assert ended is not None
        assert ended["state"] == "ENDED"

        listed = await training.list_runs(
            limit=20,
            cursor=None,
            state="ENDED",
            source_kind=None,
            compatibility=None,
        )
        assert len(listed["items"]) == 1
        card = listed["items"][0]
        assert card["state"] == "ENDED"
        assert card["resume_action"] == "OPEN_ADAPTER"
        assert card["status"] == {
            "code": "ENDED",
            "message": "训练已结束，可打开复盘。",
        }
        returned = await training.return_to_hub(run_id)
        assert returned == {
            "protocol": "replay.v3",
            "run_id": "run-1",
            "state": "ENDED",
            "checkpointed": True,
            "released": True,
        }
        assert session_id not in service._sessions
        durable = await service.store.get_session(session_id)
        assert durable is not None
        assert durable["state"] == "ENDED"
    finally:
        await service.shutdown(step_timeout=1.0)
