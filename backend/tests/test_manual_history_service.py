from __future__ import annotations

import pytest

from app.core import config as core_config
from app.data_engine.data_manager import DataManager
from app.data_engine.manual_history.planner import ManualHistoryPlanner
from app.data_engine.manual_history.repository import ManualHistoryRepository
from app.data_engine.manual_history.service import ManualHistoryService
from app.data_engine.storage import klines_repo
from app.data_engine.storage.klines_repo import KlinesRepoAdapter
from tests.test_manual_history_planner import FakeResolver


START = 1_700_000_040_000
STEP = 60_000
BARS = 5


def _row(open_time: int) -> dict:
    return {
        "open_time": open_time,
        "close_time": open_time + STEP - 1,
        "open": 1.0,
        "high": 2.0,
        "low": 1.0,
        "close": 1.5,
        "volume": 1.0,
        "quote_volume": 1.5,
        "trades": 1,
        "taker_buy_base": 0.5,
        "taker_buy_quote": 0.75,
    }


def _plan(end_open: int = START + (BARS - 1) * STEP) -> dict:
    return {
        "can_start": True,
        "plan_hash": "sha256:phase4-native",
        "selection": {
            "exchange": "binance",
            "market_type": "spot",
            "symbols": ["BTCUSDT"],
            "intervals": ["1m"],
            "requested_start_ms": START,
            "target_count": 1,
        },
        "targets": [{
            "symbol": "BTCUSDT",
            "requested_interval": "1m",
            "canonical_interval": "1m",
            "route_kind": "NATIVE",
            "source_interval": "1m",
            "effective_start_ms": START,
            "initial_end_open_ms": end_open,
            "source_strategy": "REST",
            "estimated_target_rows": BARS,
            "estimated_source_rows": BARS,
            "existing_coverage": "NONE",
            "error": None,
            "boundary_reason": None,
        }],
        "storage": {"estimated_db_growth_bytes": 1000, "estimated_temp_bytes": 100},
    }


def _setup(monkeypatch, tmp_path):
    db_path = tmp_path / "klines.db"
    monkeypatch.setattr(klines_repo, "KLINES_DB_PATH", db_path)
    monkeypatch.setattr(core_config, "KLINES_DB_PATH", db_path)
    klines_repo.init_klines_storage()
    repo = ManualHistoryRepository(db_path)
    dm = DataManager()
    dm.set_storage(KlinesRepoAdapter())
    return db_path, repo, dm


async def _write_range(*, start_ms: int, end_ms: int, skip: int | None = None, **_kwargs) -> int:
    rows = []
    open_time = start_ms
    while open_time <= end_ms:
        if skip is None or open_time != skip:
            rows.append(_row(open_time))
        open_time += STEP
    return klines_repo.upsert_klines(
        "BTCUSDT",
        "1m",
        rows,
        source="binance",
        exchange="binance",
        market_type="spot",
    )


@pytest.mark.anyio
async def test_native_job_seals_when_range_is_contiguous(monkeypatch, tmp_path) -> None:
    db_path, repo, dm = _setup(monkeypatch, tmp_path)
    service = ManualHistoryService(
        repository=repo,
        planner=ManualHistoryPlanner(resolver=FakeResolver()),
        data_manager=dm,
        storage=KlinesRepoAdapter(),
        fetch_native=_write_range,
        enabled=True,
    )
    created = service.create_from_plan(_plan(), idempotency_key="k1")
    result = await service.run_job(created.job.job_id)
    assert result.state.value == "SUCCEEDED"
    target = repo.list_job_targets(created.job.job_id)[0]
    assert target.state.value == "READY"
    verification = KlinesRepoAdapter().verify_contiguous_range(
        "BTCUSDT",
        "1m",
        START,
        START + (BARS - 1) * STEP,
        exchange="binance",
        market_type="spot",
    )
    assert verification["verified_contiguous"] is True
    floors = repo.active_protection_snapshot()
    assert len(floors) == 1
    assert floors[0].durable_owner_count == 1
    assert floors[0].protected_start_ms == START
    dm.reload_durable_protections()
    assert dm.durable_protections.floor_for(floors[0].key) is not None


@pytest.mark.anyio
async def test_gap_prevents_ready(monkeypatch, tmp_path) -> None:
    db_path, repo, dm = _setup(monkeypatch, tmp_path)

    async def write_with_gap(**kwargs) -> int:
        return await _write_range(skip=START + STEP, **kwargs)

    service = ManualHistoryService(
        repository=repo,
        data_manager=dm,
        storage=KlinesRepoAdapter(),
        fetch_native=write_with_gap,
        enabled=True,
    )
    created = service.create_from_plan(_plan(), idempotency_key="gap")
    result = await service.run_job(created.job.job_id)
    assert result.state.value == "FAILED"
    assert repo.list_job_targets(created.job.job_id)[0].state.value == "FAILED"
    assert repo.active_protection_snapshot()[0].durable_owner_count == 0


@pytest.mark.anyio
async def test_duplicate_create_reuses_job(monkeypatch, tmp_path) -> None:
    _, repo, dm = _setup(monkeypatch, tmp_path)
    service = ManualHistoryService(
        repository=repo,
        data_manager=dm,
        storage=KlinesRepoAdapter(),
        fetch_native=_write_range,
        enabled=True,
    )
    first = service.create_from_plan(_plan(), idempotency_key="dup")
    second = service.create_from_plan(_plan(), idempotency_key="dup")
    assert second.reused_existing is True
    assert second.job.job_id == first.job.job_id


@pytest.mark.anyio
async def test_replay_does_not_corrupt_existing_contiguous_range(monkeypatch, tmp_path) -> None:
    _, repo, dm = _setup(monkeypatch, tmp_path)
    service = ManualHistoryService(
        repository=repo,
        data_manager=dm,
        storage=KlinesRepoAdapter(),
        fetch_native=_write_range,
        enabled=True,
    )
    created = service.create_from_plan(_plan(), idempotency_key="replay")
    await service.run_job(created.job.job_id)
    again = service.create_from_plan(_plan(), idempotency_key="replay-2")
    await service.run_job(again.job.job_id)
    verification = KlinesRepoAdapter().verify_contiguous_range(
        "BTCUSDT",
        "1m",
        START,
        START + (BARS - 1) * STEP,
        exchange="binance",
        market_type="spot",
    )
    assert verification["verified_contiguous"] is True
    rows = klines_repo.query_klines(
        "BTCUSDT", "1m", exchange="binance", market_type="spot"
    )
    assert len(rows) == BARS
