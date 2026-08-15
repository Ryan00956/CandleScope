from __future__ import annotations

import hashlib
import json
import shutil
import sqlite3
from pathlib import Path

import pytest

from app.backtest.errors import BacktestError
from app.backtest.identity import canonical_json
from app.backtest.runtime import BacktestRuntime
from app.backtest.service import BacktestService, _event_wire_bytes
from app.backtest.strategy.protocol import (
    DeterministicFakeProvider,
    StrategyProviderError,
)
from app.backtest.strategy.registry import build_default_strategy_registry
from app.core.config import load_backtest_settings
from app.market_dataset.snapshot import MarketEvent
from app.local_data.service import LocalDatasetService, LocalImportOptions
from app.simulation.execution_realism import BAR_PATH_SCENARIO, EXECUTION_REALISM_V2
from scripts.rollback_backtest_m10_schema import rollback


def _settings(tmp_path: Path):
    return load_backtest_settings(
        {
            "BACKTEST_ENABLED": "1",
            "BACKTEST_TRADE_TAPE_ENABLED": "1",
            "BACKTEST_CHECKPOINT_EVENT_INTERVAL": "2",
        },
        data_dir=tmp_path,
        klines_db_path=tmp_path / "candlescope.db",
        replay_db_path=tmp_path / "replay.db",
    )


def _bar_settings(tmp_path: Path):
    return load_backtest_settings(
        {
            "BACKTEST_ENABLED": "1",
            "BACKTEST_BAR_ENABLED": "1",
            "BACKTEST_CHECKPOINT_EVENT_INTERVAL": "2",
        },
        data_dir=tmp_path,
        klines_db_path=tmp_path / "candlescope.db",
        replay_db_path=tmp_path / "replay.db",
    )


def _payload() -> dict[str, object]:
    return {
        "strategy_revision_id": "rev-m10",
        "dataset_id": "ds-m10",
        "data_epoch": "sha256:" + "ab" * 32,
        "snapshot_hash": "sha256:" + "cd" * 32,
        "fidelity_mode": "TRADE_TAPE",
        "start_time_ms": 1,
        "end_time_ms": 10_000,
    }


def _events() -> tuple[MarketEvent, ...]:
    return tuple(
        MarketEvent(
            sequence=index,
            event_time_ms=index * 1_000,
            role="TRADES",
            payload={
                "source_event_kind": "RAW_TRADE",
                "source_sequence": index,
                "tie_break": str(index),
                "price": str(100 + index),
                "qty": "1",
            },
        )
        for index in range(1, 9)
    )


def test_streamed_event_budget_matches_frozen_canonical_wire_size() -> None:
    events = _events()
    materialized = canonical_json(
        [
            {
                "sequence": event.sequence,
                "event_time_ms": event.event_time_ms,
                "role": event.role,
                "payload": dict(event.payload),
            }
            for event in events
        ]
    ).encode("utf-8")
    assert _event_wire_bytes(events) == len(materialized)


class _TimeoutOnce(DeterministicFakeProvider):
    def step(self, frame):
        if frame.sequence == 3:
            raise StrategyProviderError("PROVIDER_TIMEOUT", "forced M10 timeout")
        return super().step(frame)


def test_trade_timeout_preserves_v2_checkpoint_and_explicit_resume_is_exact(
    tmp_path: Path,
) -> None:
    service = BacktestService.start(_settings(tmp_path), now_ms=1)
    failed = service.create_run(_payload(), idempotency_key="failed", now_ms=2)

    with pytest.raises(StrategyProviderError, match="PROVIDER_TIMEOUT"):
        service.execute_trade_run(
            str(failed["run_id"]),
            events=_events(),
            provider=_TimeoutOnce(),
            now_ms=3,
        )

    failed_record = service.get_run(str(failed["run_id"]))
    checkpoint = service.repository.latest_checkpoint(str(failed["run_id"]))
    assert failed_record["state"] == "FAILED"
    assert failed_record["failure_code"] == "PROVIDER_TIMEOUT"
    assert checkpoint is not None and checkpoint["sequence"] == 2
    checkpoint_payload = json.loads(str(checkpoint["payload_json"]))
    assert checkpoint_payload["schemaVersion"] == "candlescope.backtest-checkpoint/2"
    assert checkpoint_payload["checkpointMode"] == "TRADE_TAPE"
    assert checkpoint_payload["providerSnapshotCapable"] is True
    assert checkpoint_payload["aggregateState"]["close"] == "102"

    queued = service.resume_failed_run(str(failed["run_id"]), now_ms=4)
    assert queued["state"] == "QUEUED"
    assert queued["generation"] == 2
    resumed = service.execute_trade_run(
        str(failed["run_id"]),
        events=_events(),
        provider=DeterministicFakeProvider(),
        now_ms=5,
    )

    clean = service.create_run(_payload(), idempotency_key="clean", now_ms=6)
    uninterrupted = service.execute_trade_run(
        str(clean["run_id"]),
        events=_events(),
        provider=DeterministicFakeProvider(),
        now_ms=7,
    )
    for name in ("decision_hash", "fill_hash", "ledger_hash", "report_hash"):
        assert resumed["result"][name] == uninterrupted["result"][name], {
            "name": name,
            "differing": {
                key: (resumed["result"].get(key), uninterrupted["result"].get(key))
                for key in resumed["result"]
                if resumed["result"].get(key) != uninterrupted["result"].get(key)
            },
        }
    assert service.repository.latest_checkpoint(str(failed["run_id"])) is None
    audit = service.repository.list_audit(str(failed["run_id"]))
    assert [row["action"] for row in audit][-3:] == [
        "fail",
        "resume_from_checkpoint",
        "complete",
    ]
    service.shutdown()


def test_corrupt_checkpoint_rejects_resume_without_state_change(tmp_path: Path) -> None:
    service = BacktestService.start(_settings(tmp_path), now_ms=1)
    failed = service.create_run(_payload(), idempotency_key="corrupt", now_ms=2)
    with pytest.raises(StrategyProviderError, match="PROVIDER_TIMEOUT"):
        service.execute_trade_run(
            str(failed["run_id"]),
            events=_events(),
            provider=_TimeoutOnce(),
            now_ms=3,
        )
    service.repository.connection.execute(
        "UPDATE backtest_checkpoints SET payload_json = '{}' WHERE run_id = ?",
        (str(failed["run_id"]),),
    )
    service.repository.connection.commit()

    with pytest.raises(BacktestError, match="CHECKPOINT_CORRUPT"):
        service.resume_failed_run(str(failed["run_id"]), now_ms=4)
    assert service.get_run(str(failed["run_id"]))["state"] == "FAILED"
    assert service.repository.latest_checkpoint(str(failed["run_id"])) is not None
    service.shutdown()


class _InjectedWorkerDeath(KeyboardInterrupt):
    pass


def _bar(index: int, *, volume: str = "1") -> MarketEvent:
    return MarketEvent(
        sequence=index,
        event_time_ms=index * 60_000,
        role="BARS",
        payload={
            "open": "100",
            "high": "101",
            "low": "99",
            "close": "100",
            "volume": volume,
        },
    )


@pytest.mark.parametrize(
    "fault_point",
    ["before_decision", "after_order", "after_partial_fill", "before_report_seal"],
)
def test_bar_worker_fault_points_resume_without_hash_drift(
    tmp_path: Path, fault_point: str
) -> None:
    fired = False

    def inject(point: str, _details) -> None:
        nonlocal fired
        if point == fault_point and not fired:
            fired = True
            raise _InjectedWorkerDeath(point)

    registry = build_default_strategy_registry()
    service = BacktestService.start(
        _bar_settings(tmp_path),
        strategy_registry=registry,
        fault_injector=inject,
        now_ms=1,
    )
    payload = {
        "strategy_revision_id": "builtin-order-command-v1",
        "dataset_id": "bars-m10",
        "data_epoch": "sha256:" + "11" * 32,
        "snapshot_hash": "sha256:" + "22" * 32,
        "fidelity_mode": "BAR_APPROX",
        "start_time_ms": 0,
        "end_time_ms": 600_000,
        "strategy_source": json.dumps(
            {"commands": [{"sequence": 1, "action": "OPEN_LONG", "qty": "3"}]}
        ),
        "output_mode": "ORDER_INTENT",
        "execution_model_revision": EXECUTION_REALISM_V2,
        "participation_rate": "0.1",
        "bar_path_scenario": BAR_PATH_SCENARIO,
        "order_end_policy": "CANCEL_AT_END",
    }
    events = tuple(_bar(index, volume="10") for index in range(1, 7))
    interrupted = service.create_run(
        payload, idempotency_key=f"fault-{fault_point}", now_ms=2
    )
    with pytest.raises(_InjectedWorkerDeath, match=fault_point):
        service.execute_bar_run(
            str(interrupted["run_id"]),
            events=events,
            provider=registry.require("builtin-order-command-v1").factory(),
            now_ms=3,
        )
    assert fired is True
    checkpoint = service.repository.latest_checkpoint(str(interrupted["run_id"]))
    assert checkpoint is not None
    assert service.requeue_interrupted_run(
        str(interrupted["run_id"]), expected_generation=1, now_ms=4
    )
    service._fault_injector = None
    resumed = service.execute_bar_run(
        str(interrupted["run_id"]),
        events=events,
        provider=registry.require("builtin-order-command-v1").factory(),
        now_ms=5,
    )
    clean = service.create_run(payload, idempotency_key="clean", now_ms=6)
    uninterrupted = service.execute_bar_run(
        str(clean["run_id"]),
        events=events,
        provider=registry.require("builtin-order-command-v1").factory(),
        now_ms=7,
    )
    for name in ("decision_hash", "fill_hash", "ledger_hash", "report_hash"):
        assert resumed["result"][name] == uninterrupted["result"][name], {
            "name": name,
            "differing": {
                key: (resumed["result"].get(key), uninterrupted["result"].get(key))
                for key in resumed["result"]
                if resumed["result"].get(key) != uninterrupted["result"].get(key)
            },
        }
    service.shutdown()


def test_funding_fault_resume_does_not_duplicate_settlement(tmp_path: Path) -> None:
    fired = False

    def inject(point: str, _details) -> None:
        nonlocal fired
        if point == "after_funding" and not fired:
            fired = True
            raise _InjectedWorkerDeath(point)

    service = BacktestService.start(
        _bar_settings(tmp_path), fault_injector=inject, now_ms=1
    )
    payload = {
        "strategy_revision_id": "rev-funding-m10",
        "dataset_id": "funding-m10",
        "data_epoch": "sha256:" + "33" * 32,
        "snapshot_hash": "sha256:" + "44" * 32,
        "fidelity_mode": "BAR_APPROX",
        "start_time_ms": 0,
        "end_time_ms": 600_000,
        "funding_rate": "0",
    }
    events = (
        _bar(1),
        _bar(2),
        MarketEvent(
            sequence=3,
            event_time_ms=150_000,
            role="FUNDING",
            payload={"period_id": "m10-period-1", "rate": "0.001"},
        ),
        _bar(4),
    )
    interrupted = service.create_run(payload, idempotency_key="funding-fault", now_ms=2)
    with pytest.raises(_InjectedWorkerDeath, match="after_funding"):
        service.execute_bar_run(
            str(interrupted["run_id"]),
            events=events,
            provider=DeterministicFakeProvider(),
            now_ms=3,
        )
    assert service.requeue_interrupted_run(
        str(interrupted["run_id"]), expected_generation=1, now_ms=4
    )
    service._fault_injector = None
    resumed = service.execute_bar_run(
        str(interrupted["run_id"]),
        events=events,
        provider=DeterministicFakeProvider(),
        now_ms=5,
    )
    clean = service.create_run(payload, idempotency_key="funding-clean", now_ms=6)
    uninterrupted = service.execute_bar_run(
        str(clean["run_id"]),
        events=events,
        provider=DeterministicFakeProvider(),
        now_ms=7,
    )
    assert resumed["result"]["ledger"]["account"]["funding_event_count"] == 1
    for name in ("decision_hash", "fill_hash", "ledger_hash", "report_hash"):
        assert resumed["result"][name] == uninterrupted["result"][name]
    service.shutdown()


def test_sqlite_busy_keeps_prior_safe_checkpoint_and_can_resume(tmp_path: Path) -> None:
    service = BacktestService.start(_settings(tmp_path), now_ms=1)
    run = service.create_run(_payload(), idempotency_key="sqlite-busy", now_ms=2)
    original_save = service.repository.save_checkpoint
    calls = 0

    def busy_after_initial(payload):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise sqlite3.OperationalError("database is locked")
        return original_save(payload)

    service.repository.save_checkpoint = busy_after_initial  # type: ignore[method-assign]
    with pytest.raises(BacktestError, match="BACKTEST_STORAGE_TRANSIENT"):
        service.execute_trade_run(
            str(run["run_id"]),
            events=_events(),
            provider=DeterministicFakeProvider(),
            now_ms=3,
        )
    service.repository.save_checkpoint = original_save  # type: ignore[method-assign]
    failed = service.get_run(str(run["run_id"]))
    checkpoint = service.repository.latest_checkpoint(str(run["run_id"]))
    assert failed["failure_code"] == "BACKTEST_STORAGE_TRANSIENT"
    assert checkpoint is not None and checkpoint["sequence"] == 0
    service.resume_failed_run(str(run["run_id"]), now_ms=4)
    resumed = service.execute_trade_run(
        str(run["run_id"]),
        events=_events(),
        provider=DeterministicFakeProvider(),
        now_ms=5,
    )
    clean = service.create_run(_payload(), idempotency_key="sqlite-clean", now_ms=6)
    uninterrupted = service.execute_trade_run(
        str(clean["run_id"]),
        events=_events(),
        provider=DeterministicFakeProvider(),
        now_ms=7,
    )
    for name in ("decision_hash", "fill_hash", "ledger_hash", "report_hash"):
        assert resumed["result"][name] == uninterrupted["result"][name]
    service.shutdown()


def test_schema_v5_to_v4_rollback_uses_consistent_backup_and_preserves_authority(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    service = BacktestService.start(settings, now_ms=1)
    run = service.create_run(_payload(), idempotency_key="rollback", now_ms=2)
    completed = service.execute_trade_run(
        str(run["run_id"]),
        events=_events(),
        provider=DeterministicFakeProvider(),
        now_ms=3,
    )
    bars_json = '[{"close":1,"high":1,"low":1,"open":1,"time":1,"volume":1}]'
    service.repository.connection.execute(
        "INSERT INTO backtest_chart_cache VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            str(run["run_id"]),
            "BACKTEST_CHART_CACHE_V1",
            "1m",
            bars_json,
            1,
            "sha256:" + hashlib.sha256(bars_json.encode()).hexdigest(),
            3,
        ),
    )
    service.repository.connection.commit()
    assert completed["state"] == "COMPLETED"
    service.shutdown()

    backup = tmp_path / "rollback" / "backtest-v5.db"
    receipt_path = tmp_path / "rollback" / "receipt.json"
    receipt = rollback(settings.db_path, backup, receipt_path)
    assert receipt["targetSchemaVersion"] == 4
    assert receipt["droppedDerivedChartCacheRows"] == 1
    assert receipt["authoritativeRunsReportsAndAuditPreserved"] is True
    assert receipt_path.is_file() and backup.is_file()

    rolled_back = sqlite3.connect(settings.db_path)
    assert rolled_back.execute(
        "SELECT schema_version FROM backtest_schema_meta"
    ).fetchone()[0] == 4
    assert rolled_back.execute("SELECT COUNT(*) FROM backtest_runs").fetchone()[0] == 1
    assert rolled_back.execute("SELECT COUNT(*) FROM backtest_reports").fetchone()[0] == 1
    assert rolled_back.execute("SELECT COUNT(*) FROM backtest_audit").fetchone()[0] > 0
    assert rolled_back.execute(
        "SELECT 1 FROM sqlite_master WHERE name='backtest_chart_cache'"
    ).fetchone() is None
    rolled_back.close()

    backup_db = sqlite3.connect(backup)
    assert backup_db.execute(
        "SELECT schema_version FROM backtest_schema_meta"
    ).fetchone()[0] == 5
    assert backup_db.execute("SELECT COUNT(*) FROM backtest_chart_cache").fetchone()[0] == 1
    backup_db.close()


@pytest.mark.parametrize("mutation", ["truncated", "replaced", "hash_changed"])
def test_mutated_local_dataset_rejects_checkpoint_resume_and_preserves_audit(
    tmp_path: Path, mutation: str,
) -> None:
    local_root = tmp_path / "local-data"
    csv_path = tmp_path / "bars.csv"
    csv_path.write_text(
        "time,open,high,low,close,volume\n"
        + "\n".join(
            f"{index * 60000},100,101,99,100,1" for index in range(8)
        ),
        encoding="utf-8",
    )
    manifest = LocalDatasetService(local_root).import_csv(
        csv_path,
        LocalImportOptions(
            name="M10 mutation fixture",
            symbol="BTCUSDT",
            interval="1m",
            timestamp_unit="ms",
        ),
    )
    settings = _bar_settings(tmp_path)
    service = BacktestService.start(
        settings,
        strategy_registry=build_default_strategy_registry(),
        enforce_registered_revisions=True,
        now_ms=1,
    )
    runtime = BacktestRuntime(
        settings=settings,
        local_data_dir=local_root,
        service=service,
    )
    preview = runtime.preview_snapshot(
        dataset_id=str(manifest["dataset_id"]),
        data_epoch=str(manifest["data_epoch"]),
        start_time_ms=0,
        end_time_ms=8 * 60_000 - 1,
        interval="1m",
    )
    run = service.create_run(
        {
            "strategy_revision_id": "builtin-sma-cross-v1",
            "dataset_id": manifest["dataset_id"],
            "data_epoch": manifest["data_epoch"],
            "snapshot_hash": preview["snapshot_hash"],
            "fidelity_mode": "BAR_APPROX",
            "start_time_ms": 0,
            "end_time_ms": 8 * 60_000 - 1,
            "interval": "1m",
            "parameters": {"fast": 2, "slow": 3},
        },
        idempotency_key="mutated-dataset",
        now_ms=2,
    )
    with pytest.raises(StrategyProviderError, match="PROVIDER_TIMEOUT"):
        service.execute_bar_run(
            str(run["run_id"]),
            events=tuple(_bar(index) for index in range(1, 9)),
            provider=_TimeoutOnce(),
            now_ms=3,
        )
    checkpoint = service.repository.latest_checkpoint(str(run["run_id"]))
    assert checkpoint is not None and checkpoint["sequence"] == 2
    service.resume_failed_run(str(run["run_id"]), now_ms=4)

    revision = str(manifest["data_epoch"]).removeprefix("sha256:")
    bars_path = local_root / str(manifest["dataset_id"]) / revision / "bars.sqlite"
    original_size = bars_path.stat().st_size
    if mutation == "truncated":
        with bars_path.open("r+b") as handle:
            handle.truncate(original_size - 16)
    elif mutation == "hash_changed":
        with bars_path.open("r+b") as handle:
            handle.seek(original_size - 1)
            original = handle.read(1)
            handle.seek(original_size - 1)
            handle.write(bytes([original[0] ^ 1]))
    else:
        replacement_csv = tmp_path / "replacement.csv"
        replacement_csv.write_text(
            "time,open,high,low,close,volume\n"
            + "\n".join(
                f"{index * 60000},200,201,199,200,1" for index in range(8)
            ),
            encoding="utf-8",
        )
        replacement = LocalDatasetService(local_root).import_csv(
            replacement_csv,
            LocalImportOptions(
                name="M10 replacement fixture",
                symbol="BTCUSDT",
                interval="1m",
                timestamp_unit="ms",
            ),
        )
        replacement_path = (
            local_root
            / str(replacement["dataset_id"])
            / str(replacement["data_epoch"]).removeprefix("sha256:")
            / "bars.sqlite"
        )
        shutil.copyfile(replacement_path, bars_path)

    claimed = service.repository.claim_next_queued(
        owner="m10-mutation-worker", now_ms=5, lease_ms=60_000
    )
    assert claimed is not None and claimed["run_id"] == run["run_id"]
    runtime.worker._execute(service, claimed, owner="m10-mutation-worker")
    failed = service.get_run(str(run["run_id"]))
    assert failed["state"] == "FAILED"
    assert failed["failure_code"] == "DATA_SNAPSHOT_MISMATCH"
    assert service.repository.latest_checkpoint(str(run["run_id"])) is not None
    failure_details = json.loads(service.repository.list_audit(str(run["run_id"]))[-1]["details_json"])
    assert failure_details["checkpointPreserved"] is True
    runtime.shutdown()
