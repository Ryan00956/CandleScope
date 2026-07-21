from __future__ import annotations

import json
import sqlite3
from dataclasses import replace
from pathlib import Path

import pytest

from app.replay.constants import REPLAY_PROTOCOL, CommandType
from app.replay.models import ReplayCommand
from app.replay.service import ReplayService
from app.replay.storage import REPLAY_SCHEMA_VERSION, ReplaySQLiteStore
from app.replay.training.errors import TrainingRunError
from app.replay.training.models import TrainingRunCreateRequest
from app.replay.training.schema import TRAINING_SCHEMA_VERSION
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
    settings = replace(replay_settings(path), product_v2_enabled=True)
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
            "protocol": "replay.v2",
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
            "funding_mode": "OFF",
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


async def test_training_schema_is_additive_and_old_v1_store_ignores_it(
    tmp_path: Path,
) -> None:
    path = tmp_path / "replay.db"
    service = await _service(path)
    await service.shutdown(step_timeout=0.2)

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
        "replay_training_track",
        "replay_training_rule",
        "replay_training_action",
        "replay_training_pin",
    }.issubset(tables)

    old_build_store = ReplaySQLiteStore(path, now_ms=lambda: NOW_MS)
    try:
        assert old_build_store.schema_version == REPLAY_SCHEMA_VERSION
    finally:
        await old_build_store.close()


async def test_v2_flag_off_does_not_create_training_schema(tmp_path: Path) -> None:
    path = tmp_path / "v1-only.db"
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
        assert service.training is None
        with sqlite3.connect(path) as connection:
            assert connection.execute(
                "SELECT COUNT(*) FROM sqlite_master "
                "WHERE type = 'table' AND name LIKE 'replay_training_%'"
            ).fetchone() == (0,)
    finally:
        await service.shutdown(step_timeout=0.2)


async def test_create_run_atomically_persists_adapter_track_rule_action_and_pin(
    tmp_path: Path,
) -> None:
    path = tmp_path / "replay.db"
    service = await _service(path)
    try:
        created = await service.training.create_run(await _request(service))  # type: ignore[union-attr]
        assert created["protocol"] == "replay.v2"
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
                    "replay_training_track",
                    "replay_training_rule",
                    "replay_training_action",
                    "replay_training_pin",
                )
            }
        assert counts == {
            "replay_session": 1,
            "replay_dataset_ref": 1,
            "replay_checkpoint": 1,
            "replay_training_run": 1,
            "replay_training_track": 1,
            "replay_training_rule": 1,
            "replay_training_action": 1,
            "replay_training_pin": 1,
        }
    finally:
        await service.shutdown(step_timeout=0.2)


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
                "replay_training_track",
                "replay_training_rule",
                "replay_training_action",
                "replay_training_pin",
            ):
                assert connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone() == (0,)
    finally:
        await service.shutdown(step_timeout=0.2)


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
            assert connection.execute("SELECT COUNT(*) FROM replay_session").fetchone() == (0,)
            assert connection.execute("SELECT COUNT(*) FROM replay_training_run").fetchone() == (0,)
    finally:
        await service.shutdown(step_timeout=0.2)


async def test_thousands_of_legacy_saves_page_without_reading_dataset_blob(
    tmp_path: Path,
) -> None:
    path = tmp_path / "paging.db"
    service = await _service(path)
    training = service.training
    assert training is not None
    rows = []
    for index in range(2_000):
        session_id = f"legacy-{index:04d}"
        blind = index % 2 == 0
        config = {
            **replay_config(blind_mode=blind).to_dict(),
            "requested_start_ms": START_MS + index * INTERVAL_MS,
        }
        rows.append(
            (
                session_id,
                json.dumps(config, separators=(",", ":")),
                json.dumps({"initial_equity": "10000", "quote_asset": "USDT"}),
                "PAUSED",
                "initialized",
                index,
                index,
                index,
                0,
                f"sha256:{index:064x}",
                f"sha256:{(index + 1):064x}",
                0,
                1,
                None,
                NOW_MS + index,
                NOW_MS + index,
            )
        )
    with sqlite3.connect(path) as connection:
        connection.executemany(
            """
            INSERT INTO replay_session(
                session_id, config_json, broker_config_json, state, status_reason,
                revision, event_sequence, source_sequence, command_log_offset,
                state_hash, data_epoch, revealed, accepting, degraded_reason,
                created_at_ms, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )

    statements: list[str] = []
    service.store._connection.set_trace_callback(statements.append)
    try:
        first = await training.list_runs(
            limit=50,
            cursor=None,
            state="PAUSED",
            source_kind="BAR",
            compatibility="LEGACY_V1",
        )
        second = await training.list_runs(
            limit=50,
            cursor=first["next_cursor"],
            state="PAUSED",
            source_kind="BAR",
            compatibility="LEGACY_V1",
        )
    finally:
        service.store._connection.set_trace_callback(None)
        await service.shutdown(step_timeout=0.2)

    assert len(first["items"]) == len(second["items"]) == 50
    assert {item["run_id"] for item in first["items"]}.isdisjoint(
        item["run_id"] for item in second["items"]
    )
    assert all(item["kind"] == "LEGACY_V1" for item in first["items"])
    assert all("actual" not in json.dumps(item).lower() for item in first["items"])
    traced = "\n".join(statements).lower()
    assert "replay_dataset_ref" not in traced
    assert "snapshot_blob" not in traced


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
        await service.shutdown(step_timeout=0.2)


async def test_legacy_migration_creates_wrapper_without_changing_v1_hashes(
    tmp_path: Path,
) -> None:
    path = tmp_path / "legacy.db"
    service = await _service(path, run_prefix="migrated")
    try:
        legacy = await service.create_session(replay_config())
        legacy_id = str(legacy["session_id"])
        with sqlite3.connect(path) as connection:
            before = connection.execute(
                """
                SELECT s.config_json, s.state_hash, d.snapshot_sha256
                FROM replay_session AS s
                JOIN replay_dataset_ref AS d USING(session_id)
                WHERE s.session_id = ?
                """,
                (legacy_id,),
            ).fetchone()
        listed = await service.training.list_runs(  # type: ignore[union-attr]
            limit=20,
            cursor=None,
            state=None,
            source_kind=None,
            compatibility="LEGACY_V1",
        )
        assert [item["run_id"] for item in listed["items"]] == [legacy_id]
        assert listed["items"][0]["resume_action"] == "OPEN_V1"

        migrated = await service.training.migrate_legacy(  # type: ignore[union-attr]
            legacy_id,
            name="迁移后的训练",
        )
        assert migrated["run"]["run_id"] == "migrated-1"
        assert migrated["run"]["adapter_session_id"] == legacy_id
        assert migrated["run"]["parent_legacy_session_id"] == legacy_id
        with sqlite3.connect(path) as connection:
            after = connection.execute(
                """
                SELECT s.config_json, s.state_hash, d.snapshot_sha256
                FROM replay_session AS s
                JOIN replay_dataset_ref AS d USING(session_id)
                WHERE s.session_id = ?
                """,
                (legacy_id,),
            ).fetchone()
        assert after == before
        repeated = await service.training.migrate_legacy(legacy_id, name=None)  # type: ignore[union-attr]
        assert repeated["run"]["run_id"] == "migrated-1"
    finally:
        await service.shutdown(step_timeout=0.2)


async def test_return_to_hub_pauses_checkpoints_releases_and_recovers(
    tmp_path: Path,
) -> None:
    path = tmp_path / "return-hub.db"
    service = await _service(path)
    try:
        created = await service.training.create_run(await _request(service))  # type: ignore[union-attr]
        session_id = created["run"]["adapter_session_id"]
        await service.command(
            session_id,
            _command("acquire", CommandType.ACQUIRE_CONTROLLER, revision=0),
        )
        await service.command(
            session_id,
            _command("play", CommandType.PLAY, revision=1),
        )
        returned = await service.training.return_to_hub_by_session(session_id)  # type: ignore[union-attr]
        assert returned == {
            "protocol": "replay.v2",
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
        await service.shutdown(step_timeout=0.2)
