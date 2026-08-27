from __future__ import annotations

import pytest

from app.core import config as core_config
from app.data_engine.data_manager import DataManager, SeriesKey
from app.data_engine.manual_history.models import (
    ManualHistoryCreateSpec,
    ManualHistoryTargetSpec,
    RouteKind,
    StorageProtectionFloor,
)
from app.data_engine.manual_history.repository import ManualHistoryRepository
from app.data_engine.storage import klines_repo
from app.data_engine.storage.klines_repo import KlinesRepoAdapter


START_MS = 1_700_000_000_000
STEP_MS = 60_000


def _row(open_time: int) -> dict:
    return {
        "open_time": open_time,
        "close_time": open_time + STEP_MS - 1,
        "open": 100.0,
        "high": 110.0,
        "low": 90.0,
        "close": 105.0,
        "volume": 1.0,
        "quote_volume": 100.0,
        "trades": 1,
        "taker_buy_base": 0.4,
        "taker_buy_quote": 40.0,
    }


def _seed_series(monkeypatch, tmp_path, *, rows: int = 20) -> DataManager:
    db_path = tmp_path / "klines.db"
    monkeypatch.setattr(klines_repo, "KLINES_DB_PATH", db_path)
    monkeypatch.setattr(core_config, "KLINES_DB_PATH", db_path)
    klines_repo.init_klines_storage()
    klines_repo.upsert_klines(
        "BTCUSDT",
        "1m",
        [_row(START_MS + index * STEP_MS) for index in range(rows)],
        source="binance",
        exchange="binance",
        market_type="spot",
    )
    dm = DataManager()
    dm.set_storage(KlinesRepoAdapter())
    return dm


def _floor(start_ms: int, *, owners: tuple[str, ...] = ("COLLECTION:col-1",)) -> StorageProtectionFloor:
    return StorageProtectionFloor(
        key=SeriesKey("BTCUSDT", "1m", exchange="binance", market_type="spot"),
        protected_start_ms=start_ms,
        owner_count=len(owners),
        transient_owner_count=sum(1 for item in owners if item.startswith("JOB:")),
        durable_owner_count=sum(1 for item in owners if item.startswith("COLLECTION:")),
        owner_ids=owners,
    )


def _plan(dm: DataManager, *, keep: int = 5, budget: int | None = None) -> dict:
    dm.update_retention_limits(
        db_limits={"minutes": keep, "hours": 0, "daily": 0},
        sqlite_budget_bytes=budget,
        storage_row_limits_enabled=True,
    )
    return dm.plan_storage_gc(file_snapshot={
        "db_size_bytes": 10_000_000,
        "wal_size_bytes": 0,
        "physical_size_bytes": 10_000_000,
        "total_size_bytes": 10_000_000,
        "page_metrics_available": True,
        "owner_attribution_available": True,
        "klines_managed_bytes": 10_000_000,
        "checkpoint_reclaimable_available": True,
        "checkpoint_reclaimable_bytes": 0,
        "logical_allocated_bytes": 10_000_000,
        "logical_used_bytes": 10_000_000,
        "file_set_stable": True,
    }, scoring="legacy")


def test_no_floor_matches_current_row_limit_gc(monkeypatch, tmp_path) -> None:
    dm = _seed_series(monkeypatch, tmp_path, rows=20)
    report = _plan(dm, keep=5)
    btc = next(row for row in report["series"] if row["symbol"] == "BTCUSDT")
    assert btc["keep_rows"] == 5
    assert btc["would_delete_rows"] == 15
    assert btc["protected_start_ms"] is None
    assert btc["protection_clamped"] is False


def test_floor_only_deletes_rows_before_protected_start(monkeypatch, tmp_path) -> None:
    dm = _seed_series(monkeypatch, tmp_path, rows=20)
    floor_ms = START_MS + 10 * STEP_MS
    dm.durable_protections.replace([_floor(floor_ms)])
    report = _plan(dm, keep=5)
    btc = next(row for row in report["series"] if row["symbol"] == "BTCUSDT")
    assert btc["rows_before_protected_floor"] == 10
    assert btc["keep_rows"] == 10
    assert btc["would_delete_rows"] == 10
    assert btc["protection_clamped"] is True
    assert btc["protected_start_ms"] == floor_ms


def test_row_limit_cannot_cross_floor(monkeypatch, tmp_path) -> None:
    dm = _seed_series(monkeypatch, tmp_path, rows=20)
    floor_ms = START_MS + 2 * STEP_MS
    dm.durable_protections.replace([_floor(floor_ms)])
    report = _plan(dm, keep=5)
    btc = next(row for row in report["series"] if row["symbol"] == "BTCUSDT")
    assert btc["keep_rows"] == 18
    assert btc["would_delete_rows"] == 2
    assert btc["blocked_delete_rows"] == 13


def test_budget_overrun_cannot_cross_floor(monkeypatch, tmp_path) -> None:
    dm = _seed_series(monkeypatch, tmp_path, rows=20)
    floor_ms = START_MS
    dm.durable_protections.replace([_floor(floor_ms, owners=("COLLECTION:col-budget",))])
    report = _plan(dm, keep=5, budget=100)
    btc_rows = [row for row in report["series"] if row["symbol"] == "BTCUSDT"]
    if btc_rows:
        assert btc_rows[0]["would_delete_rows"] == 0
        assert btc_rows[0]["keep_rows"] == 20
    assert report["unable_to_reach_budget"] is True
    assert "COLLECTION:col-budget" in report["blocking_owners"]
    remaining = klines_repo.query_klines(
        "BTCUSDT", "1m", exchange="binance", market_type="spot"
    )
    assert len(remaining) == 20


@pytest.mark.anyio
async def test_new_owner_after_plan_blocks_execute(monkeypatch, tmp_path) -> None:
    dm = _seed_series(monkeypatch, tmp_path, rows=20)
    plan = _plan(dm, keep=5)
    dm.durable_protections.replace([_floor(START_MS + 5 * STEP_MS)])
    report = await dm.maintenance.run_storage_gc(plan=plan, batch_size=1_000)
    statuses = {row["status"] for row in report["results"]}
    assert "protected-at-execute" in statuses
    assert len(klines_repo.query_klines(
        "BTCUSDT", "1m", exchange="binance", market_type="spot"
    )) == 20


@pytest.mark.anyio
async def test_earlier_floor_after_plan_blocks_execute(monkeypatch, tmp_path) -> None:
    dm = _seed_series(monkeypatch, tmp_path, rows=20)
    dm.durable_protections.replace([_floor(START_MS + 10 * STEP_MS)])
    plan = _plan(dm, keep=5)
    dm.durable_protections.replace([_floor(START_MS + 2 * STEP_MS)])
    report = await dm.maintenance.run_storage_gc(plan=plan, batch_size=1_000)
    assert any(row["status"] == "protected-at-execute" for row in report["results"])
    remaining = klines_repo.query_klines(
        "BTCUSDT", "1m", exchange="binance", market_type="spot"
    )
    assert len(remaining) == 20
    assert min(row["open_time"] for row in remaining) == START_MS


@pytest.mark.anyio
async def test_owner_release_after_plan_cannot_enlarge_delete(monkeypatch, tmp_path) -> None:
    dm = _seed_series(monkeypatch, tmp_path, rows=20)
    dm.durable_protections.replace([_floor(START_MS + 10 * STEP_MS)])
    plan = _plan(dm, keep=5)
    planned_delete = next(
        row["would_delete_rows"] for row in plan["series"] if row["symbol"] == "BTCUSDT"
    )
    assert planned_delete == 10
    dm.durable_protections.replace(())
    report = await dm.maintenance.run_storage_gc(plan=plan, batch_size=1_000)
    assert any(row["status"] == "protected-at-execute" for row in report["results"])
    assert len(klines_repo.query_klines(
        "BTCUSDT", "1m", exchange="binance", market_type="spot"
    )) == 20


@pytest.mark.anyio
async def test_startup_cleanup_does_not_cross_floor(monkeypatch, tmp_path) -> None:
    dm = _seed_series(monkeypatch, tmp_path, rows=20)
    repo = ManualHistoryRepository(core_config.KLINES_DB_PATH)
    created = repo.create_collection_and_job(
        ManualHistoryCreateSpec(
            collection_id="col-start",
            job_id="job-start",
            exchange="binance",
            market_type="spot",
            requested_start_ms=START_MS + 12 * STEP_MS,
            idempotency_key="start-1",
            request_hash="req-start",
            plan_hash="plan-start",
            targets=(
                ManualHistoryTargetSpec(
                    symbol="BTCUSDT",
                    requested_interval="1m",
                    canonical_interval="1m",
                    route_kind=RouteKind.NATIVE,
                    source_interval="1m",
                    effective_start_ms=START_MS + 12 * STEP_MS,
                    initial_end_open_ms=START_MS + 19 * STEP_MS,
                ),
            ),
        )
    )
    repo.seal_target(
        created.job.job_id,
        "BTCUSDT",
        "1m",
        sealed_end_open_ms=START_MS + 19 * STEP_MS,
        verified_rows=8,
    )
    dm.update_retention_limits(
        db_limits={"minutes": 5, "hours": 0, "daily": 0},
        storage_row_limits_enabled=True,
    )
    dm.reload_durable_protections()
    await dm.run_storage_gc()
    remaining = klines_repo.query_klines(
        "BTCUSDT", "1m", exchange="binance", market_type="spot"
    )
    opens = [row["open_time"] for row in remaining]
    assert min(opens) == START_MS + 12 * STEP_MS
    assert len(remaining) == 8


def test_transient_and_durable_are_hard_floors(monkeypatch, tmp_path) -> None:
    dm = _seed_series(monkeypatch, tmp_path, rows=20)
    transient = _floor(
        START_MS + 15 * STEP_MS,
        owners=("JOB:job-t",),
    )
    durable = _floor(
        START_MS + 8 * STEP_MS,
        owners=("COLLECTION:col-d",),
    )
    # The registry keeps one floor per series: the caller must pass the MIN.
    combined = StorageProtectionFloor(
        key=durable.key,
        protected_start_ms=min(transient.protected_start_ms, durable.protected_start_ms),
        owner_count=2,
        transient_owner_count=1,
        durable_owner_count=1,
        owner_ids=("JOB:job-t", "COLLECTION:col-d"),
    )
    dm.durable_protections.replace([combined])
    report = _plan(dm, keep=5)
    btc = next(row for row in report["series"] if row["symbol"] == "BTCUSDT")
    assert btc["protected_start_ms"] == START_MS + 8 * STEP_MS
    assert btc["would_delete_rows"] == 8
    assert btc["keep_rows"] == 12


def test_unconfigured_budget_does_not_auto_delete(monkeypatch, tmp_path) -> None:
    dm = _seed_series(monkeypatch, tmp_path, rows=20)
    dm.update_retention_limits(
        db_limits={"minutes": 5},
        sqlite_budget_bytes=None,
        storage_row_limits_enabled=False,
    )
    report = dm.plan_storage_gc(file_snapshot={
        "physical_size_bytes": 10_000_000,
        "total_size_bytes": 10_000_000,
        "db_size_bytes": 10_000_000,
        "wal_size_bytes": 0,
    })
    assert report["watermarks"]["level"] == "unconfigured"
    assert report["would_delete_rows"] == 0
    assert report["series"] == []
    assert len(klines_repo.query_klines(
        "BTCUSDT", "1m", exchange="binance", market_type="spot"
    )) == 20


def test_startup_direct_delete_oldest_is_disabled(monkeypatch, tmp_path) -> None:
    dm = _seed_series(monkeypatch, tmp_path, rows=20)
    dm.update_retention_limits(db_limits={"minutes": 5}, storage_row_limits_enabled=True)
    dm.retention.run_startup_db_cleanup()
    assert len(klines_repo.query_klines(
        "BTCUSDT", "1m", exchange="binance", market_type="spot"
    )) == 20
