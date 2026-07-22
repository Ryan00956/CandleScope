from __future__ import annotations

import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor

from app.core.executors import run_storage
from app.data_engine.backfill.config import BackfillConfig
from app.data_engine.backfill.models import FetchedBar
from app.data_engine.backfill.reconciler import Reconciler
from app.data_engine.custom_materialization import (
    CustomMaterializationRegistry,
    custom_materialization_registry,
)
from app.data_engine.data_manager import custom_query as custom_query_module
from app.data_engine.data_manager.cache import BarCache
from app.data_engine.data_manager.config import QueryConfig
from app.data_engine.data_manager.custom_query import CustomIntervalQueryService
from app.data_engine.data_manager.models import BarData, QueryResult


def test_query_and_reconciler_join_one_covering_target_materialization() -> None:
    entered = threading.Event()
    release = threading.Event()
    query_write_calls: list[list[dict]] = []

    def _target_writer(symbol: str, interval: str, rows: list[dict], **kwargs) -> int:
        query_write_calls.append(rows)
        entered.set()
        assert release.wait(timeout=2)
        # SQLite-style idempotent upserts may report no physical mutation
        # even though the full requested target range is durably covered.
        return 0

    service = CustomIntervalQueryService(
        cache=BarCache(),
        config=QueryConfig(),
        base_query=lambda *args, **kwargs: QueryResult(),
        target_writer=_target_writer,
    )
    target_ms = 91 * 60_000
    query_bars = [
        BarData(
            time=open_ms // 1000,
            open=1,
            high=2,
            low=1,
            close=2,
            volume=1,
            source="backfill_aggregated",
        )
        for open_ms in (0, target_ms)
    ]
    base_result = QueryResult(metadata={"all_rows_final": True})

    reconciler_bars = [
        FetchedBar(
            symbol="BTCUSDT",
            interval="91m",
            open_time=open_ms,
            close_time=open_ms + target_ms - 1,
            open=1,
            high=2,
            low=1,
            close=2,
            volume=1,
        )
        for open_ms in (0, target_ms)
    ]

    class _Storage:
        def __init__(self) -> None:
            self.write_calls = 0

        async def upsert_bars(self, *args, **kwargs) -> int:
            self.write_calls += 1
            return len(args[2])

    storage = _Storage()
    reconciler = Reconciler(
        BackfillConfig(reconcile_enable_cache_push=False),
        storage,
    )

    def _query_write() -> tuple[int, str]:
        return service._persist_rebuilt_target(
            query_bars,
            base_result,
            symbol="BTCUSDT",
            interval="91m",
            exchange="binance",
            market_type="spot",
        )

    async def _run() -> None:
        with ThreadPoolExecutor(max_workers=1) as executor:
            query_future = executor.submit(_query_write)
            assert await asyncio.to_thread(entered.wait, 1)
            # A running synchronous query cannot be force-cancelled; its
            # materialization lease therefore remains tied to the writer.
            assert query_future.cancel() is False
            reconcile_future = asyncio.create_task(
                reconciler._write_custom_materialization(
                    exchange="binance",
                    market_type="spot",
                    symbol="BTCUSDT",
                    interval="91m",
                    bars=reconciler_bars,
                    phase="custom",
                ),
            )
            await asyncio.sleep(0.05)
            assert storage.write_calls == 0
            release.set()
            query_outcome = await asyncio.wrap_future(query_future)
            reconcile_outcome = await reconcile_future

        assert query_outcome == (0, "owner")
        written, failures, ranges = reconcile_outcome
        assert written == 2
        assert failures == []
        assert len(ranges) == 1
        assert ranges[0].phase == "custom_joined_query"
        assert ranges[0].bars_written == 2
        assert (
            reconciler.snapshot()["metrics"]["counters"][
                "custom_materialization_joins"
            ]
            == 1
        )

    asyncio.run(_run())

    assert len(query_write_calls) == 1
    assert storage.write_calls == 0


def test_cancelled_reconciler_holds_lease_until_executor_write_finishes() -> None:
    entered = threading.Event()
    release = threading.Event()
    state_lock = threading.Lock()
    target_ms = 91 * 60_000
    bars = [FetchedBar(
        symbol="BTCUSDT",
        interval="91m",
        open_time=0,
        close_time=target_ms - 1,
        open=1,
        high=2,
        low=1,
        close=2,
        volume=1,
    )]

    class _Storage:
        def __init__(self) -> None:
            self.active = 0
            self.calls = 0
            self.max_active = 0

        def _write_in_worker(self, row_count: int) -> int:
            with state_lock:
                self.active += 1
                self.calls += 1
                self.max_active = max(self.max_active, self.active)
            entered.set()
            try:
                assert release.wait(timeout=2)
                return row_count
            finally:
                with state_lock:
                    self.active -= 1

        async def upsert_bars(self, *args, **kwargs) -> int:
            return await run_storage(self._write_in_worker, len(args[2]))

    storage = _Storage()
    reconciler = Reconciler(
        BackfillConfig(reconcile_enable_cache_push=False),
        storage,
    )
    series = custom_materialization_registry.series_key(
        exchange="binance",
        market_type="spot",
        symbol="BTCUSDT",
        interval="91m",
    )

    async def _run() -> None:
        owner_task = asyncio.create_task(
            reconciler._write_custom_materialization(
                exchange="binance",
                market_type="spot",
                symbol="BTCUSDT",
                interval="91m",
                bars=bars,
                phase="custom",
            ),
        )
        assert await asyncio.to_thread(entered.wait, 1)
        owner_task.cancel()
        try:
            await asyncio.wait_for(owner_task, timeout=0.5)
        except asyncio.CancelledError:
            pass
        else:  # pragma: no cover - cancellation is the contract under test
            raise AssertionError("materialization owner was not cancelled")

        joined, partial_overlap = custom_materialization_registry.claim_nowait(
            series=series,
            start_ms=0,
            end_ms=0,
            owner="probe",
        )
        assert joined is not None and joined.is_owner is False
        assert partial_overlap is None
        assert reconciler.snapshot()["materialization_writes_draining"] == 1

        successor_task = asyncio.create_task(
            reconciler._write_custom_materialization(
                exchange="binance",
                market_type="spot",
                symbol="BTCUSDT",
                interval="91m",
                bars=bars,
                phase="custom",
            ),
        )
        await asyncio.sleep(0.05)
        assert successor_task.done() is False
        assert storage.calls == 1
        assert storage.max_active == 1

        release.set()
        written, failures, ranges = await asyncio.wait_for(
            successor_task,
            timeout=2,
        )
        assert written == 1
        assert failures == []
        assert len(ranges) == 1
        assert storage.calls == 2
        assert storage.max_active == 1
        assert reconciler.snapshot()["materialization_writes_draining"] == 0

        successor, wait_for_overlap = (
            custom_materialization_registry.claim_nowait(
                series=series,
                start_ms=0,
                end_ms=0,
                owner="successor",
            )
        )
        assert successor is not None and successor.is_owner is True
        assert wait_for_overlap is None
        successor.fail("test cleanup")

    asyncio.run(_run())


def test_sparse_query_rebuild_never_claims_covering_materialization() -> None:
    writes = 0

    def _target_writer(*args, **kwargs) -> int:
        nonlocal writes
        writes += 1
        return 2

    service = CustomIntervalQueryService(
        cache=BarCache(),
        config=QueryConfig(),
        base_query=lambda *args, **kwargs: QueryResult(),
        target_writer=_target_writer,
    )
    target_seconds = 91 * 60
    bars = [
        BarData(
            time=open_seconds,
            open=1,
            high=2,
            low=1,
            close=2,
            volume=1,
            source="backfill_aggregated",
        )
        for open_seconds in (0, 2 * target_seconds)
    ]

    outcome = service._persist_rebuilt_target(
        bars,
        QueryResult(metadata={"all_rows_final": True}),
        symbol="BTCUSDT",
        interval="91m",
        exchange="binance",
        market_type="spot",
    )

    assert outcome == (0, "skipped_noncontiguous")
    assert writes == 0


def _query_materialization_fixture(
    *,
    open_times: tuple[int, ...],
    writes: list[list[dict]],
) -> tuple[CustomIntervalQueryService, list[BarData], QueryResult]:
    def _target_writer(
        symbol: str,
        interval: str,
        rows: list[dict],
        **kwargs,
    ) -> int:
        writes.append(rows)
        return len(rows)

    service = CustomIntervalQueryService(
        cache=BarCache(),
        config=QueryConfig(),
        base_query=lambda *args, **kwargs: QueryResult(),
        target_writer=_target_writer,
    )
    bars = [
        BarData(
            time=open_ms // 1000,
            open=1,
            high=2,
            low=1,
            close=2,
            volume=1,
            source="backfill_aggregated",
        )
        for open_ms in open_times
    ]
    return service, bars, QueryResult(metadata={"all_rows_final": True})


def test_query_materialization_does_not_wait_for_covering_owner(
    monkeypatch,
) -> None:
    registry = CustomMaterializationRegistry()
    monkeypatch.setattr(
        custom_query_module,
        "custom_materialization_registry",
        registry,
    )
    target_ms = 91 * 60_000
    writes: list[list[dict]] = []
    service, bars, base_result = _query_materialization_fixture(
        open_times=(0, target_ms),
        writes=writes,
    )
    series = registry.series_key(
        exchange="binance",
        market_type="spot",
        symbol="BTCUSDT",
        interval="91m",
    )
    owner = registry.claim(
        series=series,
        start_ms=0,
        end_ms=target_ms,
        owner="reconciler",
    )

    def _query_write() -> tuple[int, str]:
        return service._persist_rebuilt_target(
            bars,
            base_result,
            symbol="BTCUSDT",
            interval="91m",
            exchange="binance",
            market_type="spot",
        )

    with ThreadPoolExecutor(max_workers=1) as executor:
        query_future = executor.submit(_query_write)
        try:
            assert query_future.result(timeout=0.25) == (0, "join_pending")
            assert writes == []
            completion = executor.submit(owner.complete, 2, rows_covered=2)
            assert completion.result(timeout=0.25).success is True
        finally:
            if not owner.future.done():
                owner.fail("test cleanup")
            query_future.result(timeout=1)


def test_query_materialization_does_not_wait_for_partial_overlap(
    monkeypatch,
) -> None:
    registry = CustomMaterializationRegistry()
    monkeypatch.setattr(
        custom_query_module,
        "custom_materialization_registry",
        registry,
    )
    target_ms = 91 * 60_000
    writes: list[list[dict]] = []
    service, bars, base_result = _query_materialization_fixture(
        open_times=(target_ms, 2 * target_ms),
        writes=writes,
    )
    series = registry.series_key(
        exchange="binance",
        market_type="spot",
        symbol="BTCUSDT",
        interval="91m",
    )
    owner = registry.claim(
        series=series,
        start_ms=0,
        end_ms=target_ms,
        owner="reconciler",
    )

    def _query_write() -> tuple[int, str]:
        return service._persist_rebuilt_target(
            bars,
            base_result,
            symbol="BTCUSDT",
            interval="91m",
            exchange="binance",
            market_type="spot",
        )

    with ThreadPoolExecutor(max_workers=1) as executor:
        query_future = executor.submit(_query_write)
        try:
            assert query_future.result(timeout=0.25) == (0, "overlap_busy")
            assert writes == []
            completion = executor.submit(owner.complete, 2, rows_covered=2)
            assert completion.result(timeout=0.25).success is True
        finally:
            if not owner.future.done():
                owner.fail("test cleanup")
            query_future.result(timeout=1)
