from __future__ import annotations

import pytest

from app.core import config as core_config
from app.data_engine.data_manager import DataManager
from app.data_engine.manual_history.models import JobState
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


def _service(repo, dm, **kwargs):
    kwargs.setdefault("clock_ms", lambda: START + BARS * STEP)
    kwargs.setdefault("enabled", True)
    kwargs.setdefault("storage", KlinesRepoAdapter())
    return ManualHistoryService(repository=repo, data_manager=dm, **kwargs)


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
    service = _service(
        repo, dm,
        planner=ManualHistoryPlanner(resolver=FakeResolver()),
        fetch_native=_write_range,
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

    service = _service(repo, dm, fetch_native=write_with_gap)
    created = service.create_from_plan(_plan(), idempotency_key="gap")
    result = await service.run_job(created.job.job_id)
    assert result.state.value == "FAILED"
    assert repo.list_job_targets(created.job.job_id)[0].state.value == "FAILED"
    assert repo.active_protection_snapshot()[0].durable_owner_count == 0


@pytest.mark.anyio
async def test_duplicate_create_reuses_job(monkeypatch, tmp_path) -> None:
    _, repo, dm = _setup(monkeypatch, tmp_path)
    service = _service(repo, dm, fetch_native=_write_range)
    first = service.create_from_plan(_plan(), idempotency_key="dup")
    second = service.create_from_plan(_plan(), idempotency_key="dup")
    assert second.reused_existing is True
    assert second.job.job_id == first.job.job_id


@pytest.mark.anyio
async def test_replay_does_not_corrupt_existing_contiguous_range(monkeypatch, tmp_path) -> None:
    _, repo, dm = _setup(monkeypatch, tmp_path)
    service = _service(repo, dm, fetch_native=_write_range)
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


@pytest.mark.anyio
async def test_native_fetch_marks_explicit_archive_demand(monkeypatch, tmp_path) -> None:
    captured: list[object] = []

    class _Coordinator:
        async def request_and_wait(self, request):
            captured.append(request)

    _, repo, dm = _setup(monkeypatch, tmp_path)
    service = _service(
        repo, dm,
        coordinator=_Coordinator(),
        fetch_native=None,
        verify_range=lambda *args, **kwargs: {
            "verified_contiguous": True,
            "expected_count": BARS,
            "actual_count": BARS,
        },
        enabled=True,
    )
    created = service.create_from_plan(_plan(), idempotency_key="explicit")
    await service.run_job(created.job.job_id)
    assert captured
    request = captured[0]
    assert request.reason == "manual_history_download"
    assert request.metadata["archive_explicit_demand"] is True
    assert request.metadata["requires_trusted_finality"] is True


@pytest.mark.anyio
async def test_shared_source_is_fetched_once_for_native_and_derived(monkeypatch, tmp_path) -> None:
    calls: list[tuple[str, str]] = []
    aligned = 318_353 * 89 * 60_000
    source_end = aligned + 88 * 60_000

    async def write_counted(*, symbol: str, interval: str, start_ms: int, end_ms: int, **kwargs) -> int:
        calls.append((symbol, interval))
        rows = []
        open_time = start_ms
        while open_time <= end_ms:
            rows.append(_row(open_time))
            open_time += STEP
        return klines_repo.upsert_klines(
            symbol,
            interval,
            rows,
            source="binance",
            exchange="binance",
            market_type="spot",
        )

    _, repo, dm = _setup(monkeypatch, tmp_path)
    plan = {
        "can_start": True,
        "plan_hash": "sha256:phase6-shared",
        "selection": {
            "exchange": "binance",
            "market_type": "spot",
            "symbols": ["BTCUSDT"],
            "intervals": ["1m", "89m"],
            "requested_start_ms": aligned,
            "target_count": 2,
        },
        "targets": [
            {
                "symbol": "BTCUSDT",
                "requested_interval": "1m",
                "canonical_interval": "1m",
                "route_kind": "NATIVE",
                "source_interval": "1m",
                "effective_start_ms": aligned,
                "initial_end_open_ms": source_end,
                "source_strategy": "REST",
                "estimated_target_rows": 89,
                "estimated_source_rows": 89,
                "existing_coverage": "NONE",
                "error": None,
                "boundary_reason": None,
            },
            {
                "symbol": "BTCUSDT",
                "requested_interval": "89m",
                "canonical_interval": "89m",
                "route_kind": "DERIVED",
                "source_interval": "1m",
                "effective_start_ms": aligned,
                "initial_end_open_ms": aligned,
                "source_strategy": "REST",
                "estimated_target_rows": 1,
                "estimated_source_rows": 89,
                "existing_coverage": "NONE",
                "error": None,
                "boundary_reason": None,
            },
        ],
        "storage": {},
    }
    service = _service(repo, dm, fetch_native=write_counted)
    created = service.create_from_plan(plan, idempotency_key="shared-1m")
    result = await service.run_job(created.job.job_id)
    assert result.state.value in {"SUCCEEDED", "PARTIAL"}
    assert calls == [("BTCUSDT", "1m")]
    states = {item.canonical_interval: item.state.value for item in repo.list_job_targets(created.job.job_id)}
    assert states["1m"] == "READY"


@pytest.mark.anyio
async def test_cancel_queued_job_is_cancelled(monkeypatch, tmp_path) -> None:
    _, repo, dm = _setup(monkeypatch, tmp_path)
    service = _service(repo, dm, fetch_native=_write_range)
    created = service.create_from_plan(_plan(), idempotency_key="cancel-q")
    cancelled = service.cancel_job(created.job.job_id)
    assert cancelled.state.value == "CANCELLED"
    assert repo.list_job_targets(created.job.job_id)[0].state.value == "CANCELLED"


@pytest.mark.anyio
async def test_recover_running_job_requeues(monkeypatch, tmp_path) -> None:
    _, repo, dm = _setup(monkeypatch, tmp_path)
    service = _service(repo, dm, fetch_native=_write_range)
    created = service.create_from_plan(_plan(), idempotency_key="recover-1")
    repo.cas_job_state(
        created.job.job_id,
        from_state=created.job.state,
        to_state=JobState.RUNNING,
        stage="fetching",
    )
    recovered = service.recover_jobs()
    assert recovered[0].state.value == "QUEUED"
    assert recovered[0].recovery_count == 1


@pytest.mark.anyio
async def test_blocked_storage_when_disk_is_critical(monkeypatch, tmp_path) -> None:
    _, repo, dm = _setup(monkeypatch, tmp_path)
    service = _service(repo, dm, fetch_native=_write_range)
    service._disk_free_bytes = lambda: 0
    created = service.create_from_plan(_plan(), idempotency_key="disk-0")
    result = await service.run_job(created.job.job_id)
    assert result.state.value == "BLOCKED_STORAGE"


@pytest.mark.anyio
async def test_feature_flag_off_keeps_durable_floor(monkeypatch, tmp_path) -> None:
    _, repo, dm = _setup(monkeypatch, tmp_path)
    service = _service(repo, dm, fetch_native=_write_range)
    created = service.create_from_plan(_plan(), idempotency_key="flag-off-floor")
    await service.run_job(created.job.job_id)
    service.enabled = False
    dm.reload_durable_protections()
    floors = dm.durable_protections.clone()
    assert floors
    collections = repo.list_collections()
    assert collections[0].collection_id == created.collection.collection_id


@pytest.mark.anyio
async def test_seal_recomputes_last_closed_and_fills_tail(monkeypatch, tmp_path) -> None:
    calls: list[tuple[int, int]] = []

    async def write_counted(*, start_ms: int, end_ms: int, **kwargs) -> int:
        calls.append((start_ms, end_ms))
        return await _write_range(start_ms=start_ms, end_ms=end_ms, **kwargs)

    _, repo, dm = _setup(monkeypatch, tmp_path)
    ticks = {"n": 0}

    def clock_ms() -> int:
        ticks["n"] += 1
        if ticks["n"] <= 1:
            return START + BARS * STEP
        return START + (BARS + 1) * STEP

    extra_end = START + BARS * STEP
    service = _service(repo, dm, fetch_native=write_counted, clock_ms=clock_ms)
    created = service.create_from_plan(_plan(), idempotency_key="tail")
    result = await service.run_job(created.job.job_id)
    assert result.state.value == "SUCCEEDED"
    assert calls[0] == (START, START + (BARS - 1) * STEP)
    assert calls[-1] == (extra_end, extra_end)
    target = repo.list_job_targets(created.job.job_id)[0]
    assert target.sealed_end_open_ms == extra_end
    verification = KlinesRepoAdapter().verify_contiguous_range(
        "BTCUSDT",
        "1m",
        START,
        extra_end,
        exchange="binance",
        market_type="spot",
    )
    assert verification["verified_contiguous"] is True
