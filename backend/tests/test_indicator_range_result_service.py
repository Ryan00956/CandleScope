from __future__ import annotations

import asyncio
import threading
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1 import indicators as indicators_api
from app.core import config
from app.data_engine.data_manager.models import BarData
from app.indicator import create_engine
from app.indicator.events import IndicatorEvent, IndicatorEventType
from app.indicator.range_result_service import IndicatorRangeResultService
from app.indicator.series_revision import SeriesRevisionRegistry


def _bars(count: int, *, start: int = 1_700_000_000) -> list[BarData]:
    return [
        BarData.from_dict({
            "time": start + index * 60,
            "open": 100 + index,
            "high": 101 + index,
            "low": 99 + index,
            "close": 100 + index,
            "volume": 10 + index,
        }).with_closed_state(True)
        for index in range(count)
    ]


def _meta() -> dict:
    return {
        "kind": "builtin",
        "exchange": "binance",
        "market_type": "spot",
        "symbol": "BTCUSDT",
        "interval": "1m",
        "name": "MA",
        "params": {"period": 3},
        "indicatorId": "binance:spot:BTCUSDT:1m:MA:test:params",
    }


def _payload(start: int, end: int) -> dict:
    return {
        "type": "indicator.replace_range",
        "clientId": "source",
        "lines": [{
            "name": "MA",
            "data": [
                {"time": timestamp, "value": 1.0}
                for timestamp in range(start, end + 1, 60)
            ],
        }],
        "range": {"start": start, "end": end},
    }


def test_result_service_singleflight_and_revision_invalidation() -> None:
    async def _run() -> None:
        registry = SeriesRevisionRegistry(server_epoch="epoch-test")
        service = IndicatorRangeResultService(
            revision_registry=registry,
            ttl_seconds=60,
            max_entries=8,
        )
        meta = _meta()
        start = 1_700_000_000
        end = start + 120
        release = asyncio.Event()
        calls = 0

        async def compute() -> dict:
            nonlocal calls
            calls += 1
            await release.wait()
            return _payload(start, end)

        first = asyncio.create_task(service.get_or_compute(
            meta=meta, start=start, end=end, compute=compute,
        ))
        await asyncio.sleep(0)
        second = asyncio.create_task(service.get_or_compute(
            meta=meta, start=start + 60, end=end, compute=compute,
        ))
        await asyncio.sleep(0)
        release.set()
        first_result, second_result = await asyncio.gather(first, second)

        assert calls == 1
        assert first_result[1] is False
        assert second_result[1] is True
        assert service.lookup_snapshot(meta, start, end) is not None

        correction = service.note_correction(
            series_key="binance:spot:BTCUSDT:1m",
            start=start + 60,
            end=start + 60,
            event_id="amend-1",
        )
        assert service.lookup_snapshot(meta, start, end) is None
        revision = service.data_revision_for_meta(meta)
        assert revision["serverEpoch"] == "epoch-test"
        assert revision["correctionRevision"] == 1
        assert correction["dirtyRange"] == {"start": start + 60, "end": start + 60}

    asyncio.run(_run())


def test_singleflight_cancels_physical_compute_after_last_waiter_leaves() -> None:
    async def _run() -> None:
        service = IndicatorRangeResultService(
            revision_registry=SeriesRevisionRegistry(server_epoch="epoch-test"),
        )
        started = asyncio.Event()
        cancelled = asyncio.Event()

        async def compute() -> dict:
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()
            raise AssertionError("unreachable")

        waiter = asyncio.create_task(service.get_or_compute(
            meta=_meta(),
            start=1_700_000_000,
            end=1_700_000_120,
            compute=compute,
        ))
        await started.wait()
        waiter.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiter
        await asyncio.wait_for(cancelled.wait(), timeout=1)
        for _ in range(20):
            if service.snapshot()["inFlight"] == 0:
                break
            await asyncio.sleep(0)

        snapshot = service.snapshot()
        assert snapshot["inFlight"] == 0
        assert snapshot["cancelledOrphanComputes"] == 1

    asyncio.run(_run())


def test_cancelling_one_joined_waiter_does_not_cancel_shared_compute() -> None:
    async def _run() -> None:
        service = IndicatorRangeResultService(
            revision_registry=SeriesRevisionRegistry(server_epoch="epoch-test"),
        )
        start = 1_700_000_000
        end = start + 120
        started = asyncio.Event()
        release = asyncio.Event()
        cancelled = False

        async def compute() -> dict:
            nonlocal cancelled
            started.set()
            try:
                await release.wait()
            except asyncio.CancelledError:
                cancelled = True
                raise
            return _payload(start, end)

        first = asyncio.create_task(service.get_or_compute(
            meta=_meta(), start=start, end=end, compute=compute,
        ))
        await started.wait()
        second = asyncio.create_task(service.get_or_compute(
            meta=_meta(), start=start + 60, end=end, compute=compute,
        ))
        for _ in range(20):
            if service.snapshot()["singleflightJoins"] == 1:
                break
            await asyncio.sleep(0)

        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        assert cancelled is False
        assert second.done() is False

        release.set()
        payload, cache_hit, _revision = await second
        assert payload["range"] == {"start": start, "end": end}
        assert cache_hit is True
        assert cancelled is False
        assert service.snapshot()["cancelledOrphanComputes"] == 0

    asyncio.run(_run())


def test_cancelling_one_bars_waiter_does_not_cancel_shared_series_query() -> None:
    async def _run() -> None:
        service = IndicatorRangeResultService(
            revision_registry=SeriesRevisionRegistry(server_epoch="epoch-test"),
            bars_cache_ttl_seconds=5,
        )
        bars = _bars(10)
        started = asyncio.Event()
        release = asyncio.Event()
        query_cancelled = False
        query_calls = 0

        async def query() -> list[BarData]:
            nonlocal query_cancelled, query_calls
            query_calls += 1
            started.set()
            try:
                await release.wait()
            except asyncio.CancelledError:
                query_cancelled = True
                raise
            return bars

        kwargs = {
            "meta": _meta(),
            "start": bars[0].time,
            "end": bars[-1].time,
            "warmup_bars": 0,
            "query": query,
        }
        first = asyncio.create_task(service.get_or_query_bars(**kwargs))
        await started.wait()
        second = asyncio.create_task(service.get_or_query_bars(**kwargs))
        for _ in range(20):
            if service.snapshot()["barsSingleflightJoins"] == 1:
                break
            await asyncio.sleep(0)

        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        assert query_cancelled is False

        release.set()
        assert await second == bars
        assert query_calls == 1
        assert query_cancelled is False
        assert service.snapshot()["cancelledOrphanBarsQueries"] == 0

    asyncio.run(_run())


def test_disabled_result_cache_also_bypasses_bars_cache_and_singleflight(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _run() -> None:
        monkeypatch.setattr(config, "INDICATOR_RANGE_CACHE_ENABLED", False)
        service = IndicatorRangeResultService.from_config(
            revision_registry=SeriesRevisionRegistry(server_epoch="epoch-test"),
        )
        bars = _bars(10)
        both_started = asyncio.Event()
        release = asyncio.Event()
        query_calls = 0

        async def query() -> list[BarData]:
            nonlocal query_calls
            query_calls += 1
            if query_calls == 2:
                both_started.set()
            await release.wait()
            return bars

        kwargs = {
            "meta": _meta(),
            "start": bars[0].time,
            "end": bars[-1].time,
            "warmup_bars": 0,
            "query": query,
        }
        first = asyncio.create_task(service.get_or_query_bars(**kwargs))
        second = asyncio.create_task(service.get_or_query_bars(**kwargs))
        await asyncio.wait_for(both_started.wait(), timeout=1)
        release.set()

        first_result, second_result = await asyncio.gather(first, second)
        assert first_result == bars
        assert second_result == bars
        assert query_calls == 2
        snapshot = service.snapshot()
        assert snapshot["enabled"] is False
        assert snapshot["barsEntries"] == 0
        assert snapshot["barsInFlight"] == 0
        assert snapshot["barsSingleflightJoins"] == 0

    asyncio.run(_run())


def test_snapshot_prunes_expired_bars_entries() -> None:
    async def _run() -> None:
        service = IndicatorRangeResultService(
            revision_registry=SeriesRevisionRegistry(server_epoch="epoch-test"),
            bars_cache_max_entries=4,
            bars_cache_ttl_seconds=60,
        )
        bars = _bars(10)

        async def query() -> list[BarData]:
            return bars

        await service.get_or_query_bars(
            meta=_meta(),
            start=bars[0].time,
            end=bars[-1].time,
            warmup_bars=0,
            query=query,
        )
        assert service.snapshot()["barsEntries"] == 1

        service.bars_cache_ttl_seconds = 0
        snapshot = service.snapshot()
        assert snapshot["barsEntries"] == 0
        assert snapshot["barsEvictions"] == 1

    asyncio.run(_run())


def test_monthly_bars_are_not_reused_as_fixed_interval_cache_entries() -> None:
    async def _run() -> None:
        service = IndicatorRangeResultService(
            revision_registry=SeriesRevisionRegistry(server_epoch="epoch-test"),
            bars_cache_ttl_seconds=60,
        )
        bars = [
            _bars(1, start=1_704_067_200)[0],  # 2024-01-01 UTC
            _bars(1, start=1_706_745_600)[0],  # 2024-02-01 UTC
        ]
        meta = {**_meta(), "interval": "1M", "indicatorId": "monthly-ma"}
        query_calls = 0

        async def query() -> list[BarData]:
            nonlocal query_calls
            query_calls += 1
            return bars

        for _ in range(2):
            await service.get_or_query_bars(
                meta=meta,
                start=bars[0].time,
                end=bars[-1].time,
                warmup_bars=0,
                query=query,
            )

        assert query_calls == 2
        assert service.snapshot()["barsEntries"] == 0

    asyncio.run(_run())


def test_bars_cache_does_not_share_across_series() -> None:
    async def _run() -> None:
        service = IndicatorRangeResultService(
            revision_registry=SeriesRevisionRegistry(server_epoch="epoch-test"),
            bars_cache_ttl_seconds=60,
        )
        bars = _bars(10)
        query_calls = 0

        async def query() -> list[BarData]:
            nonlocal query_calls
            query_calls += 1
            return bars

        btc_meta = _meta()
        eth_meta = {
            **_meta(),
            "symbol": "ETHUSDT",
            "indicatorId": "binance:spot:ETHUSDT:1m:MA:test:params",
        }
        for meta in (btc_meta, eth_meta):
            await service.get_or_query_bars(
                meta=meta,
                start=bars[0].time,
                end=bars[-1].time,
                warmup_bars=0,
                query=query,
            )

        assert query_calls == 2
        assert service.snapshot()["barsEntries"] == 2

    asyncio.run(_run())


def test_delta_merge_preserves_higher_quality_provenance() -> None:
    start = 1_700_000_060
    low_warmup = _bars(1, start=start - 60)[0].with_source("data_manager_closed")
    high_warmup = _bars(1, start=start - 60)[0].with_source("backfill")
    low_target = _bars(1, start=start)[0].with_source("data_manager_closed")
    high_target = _bars(1, start=start)[0].with_source("repair_binance_rest_verified")

    merged = IndicatorRangeResultService._merge_bars(
        [low_warmup, high_target],
        [high_warmup, low_target],
        start=start,
        end=start,
        warmup_bars=1,
        interval="1m",
    )

    assert [(bar.time, bar.source) for bar in merged] == [
        (start - 60, "backfill"),
        (start, "repair_binance_rest_verified"),
    ]


def test_different_request_owners_do_not_share_an_unfinished_bars_query() -> None:
    async def _run() -> None:
        service = IndicatorRangeResultService(
            revision_registry=SeriesRevisionRegistry(server_epoch="epoch-test"),
            bars_cache_ttl_seconds=5,
        )
        bars = _bars(10)
        started_a = asyncio.Event()
        started_b = asyncio.Event()
        release = asyncio.Event()

        async def query_a() -> list[BarData]:
            started_a.set()
            await release.wait()
            return bars

        async def query_b() -> list[BarData]:
            started_b.set()
            await release.wait()
            return bars

        common = {
            "meta": _meta(),
            "start": bars[0].time,
            "end": bars[-1].time,
            "warmup_bars": 0,
        }
        first = asyncio.create_task(service.get_or_query_bars(
            **common,
            query=query_a,
            query_owner_id="request-owner-a",
        ))
        await started_a.wait()
        second = asyncio.create_task(service.get_or_query_bars(
            **common,
            query=query_b,
            query_owner_id="request-owner-b",
        ))
        await asyncio.wait_for(started_b.wait(), timeout=1)

        snapshot = service.snapshot()
        assert snapshot["barsQueries"] == 2
        assert snapshot["barsSingleflightJoins"] == 0

        release.set()
        first_result, second_result = await asyncio.gather(first, second)
        assert first_result == bars
        assert second_result == bars

    asyncio.run(_run())


def test_left_history_correction_rebases_suffix_and_queries_only_new_prefix() -> None:
    async def _run() -> None:
        service = IndicatorRangeResultService(
            revision_registry=SeriesRevisionRegistry(server_epoch="epoch-test"),
            bars_cache_ttl_seconds=60,
        )
        bars = _bars(300)
        old_start = bars[100].time
        end = bars[-1].time

        async def initial_query() -> list[BarData]:
            return bars

        initial = await service.get_or_query_bars(
            meta=_meta(),
            start=old_start,
            end=end,
            warmup_bars=100,
            query=initial_query,
        )
        assert initial == bars

        # A newly loaded page amends only the older warmup side.  The target
        # suffix [100, 299] is unchanged and can be moved to the new revision.
        service.note_correction(
            series_key="binance:spot:BTCUSDT:1m",
            start=bars[50].time,
            end=bars[99].time,
            event_id="left-page-1",
        )

        full_query_calls = 0
        segment_calls: list[tuple[int, int, int]] = []

        async def full_query() -> list[BarData]:
            nonlocal full_query_calls
            full_query_calls += 1
            return bars[30:]

        async def query_segment(
            start: int,
            segment_end: int,
            warmup: int,
        ) -> list[BarData]:
            segment_calls.append((start, segment_end, warmup))
            return [
                bar for bar in bars
                if start - warmup * 60 <= bar.time <= segment_end
            ]

        expanded = await service.get_or_query_bars(
            meta=_meta(),
            start=bars[50].time,
            end=end,
            warmup_bars=20,
            query=full_query,
            query_segment=query_segment,
        )

        assert full_query_calls == 0
        assert segment_calls == [(bars[50].time, bars[99].time, 20)]
        assert [bar.time for bar in expanded] == [bar.time for bar in bars[30:]]
        snapshot = service.snapshot()
        assert snapshot["barsRevisionRebases"] == 1
        assert snapshot["barsDeltaQueries"] == 1
        assert snapshot["barsDeltaRowsReused"] == 200

        async def should_not_query() -> list[BarData]:
            raise AssertionError("expanded window should now be a covering hit")

        cached = await service.get_or_query_bars(
            meta=_meta(),
            start=bars[50].time,
            end=end,
            warmup_bars=20,
            query=should_not_query,
        )
        assert [bar.time for bar in cached] == [bar.time for bar in bars[30:]]

    asyncio.run(_run())


def test_interior_correction_evicts_bars_instead_of_reusing_across_gap() -> None:
    async def _run() -> None:
        service = IndicatorRangeResultService(
            revision_registry=SeriesRevisionRegistry(server_epoch="epoch-test"),
            bars_cache_ttl_seconds=60,
        )
        bars = _bars(100)

        async def initial_query() -> list[BarData]:
            return bars

        await service.get_or_query_bars(
            meta=_meta(),
            start=bars[10].time,
            end=bars[-1].time,
            warmup_bars=10,
            query=initial_query,
        )
        service.note_correction(
            series_key="binance:spot:BTCUSDT:1m",
            start=bars[40].time,
            end=bars[50].time,
            event_id="interior-amendment",
        )

        full_query_calls = 0
        segment_calls = 0

        async def full_query() -> list[BarData]:
            nonlocal full_query_calls
            full_query_calls += 1
            return bars

        async def query_segment(*_args: int) -> list[BarData]:
            nonlocal segment_calls
            segment_calls += 1
            return bars

        result = await service.get_or_query_bars(
            meta=_meta(),
            start=bars[10].time,
            end=bars[-1].time,
            warmup_bars=10,
            query=full_query,
            query_segment=query_segment,
        )
        assert result == bars
        assert full_query_calls == 1
        assert segment_calls == 0
        snapshot = service.snapshot()
        assert snapshot["barsRevisionRebases"] == 0
        assert snapshot["barsEvictions"] == 1

    asyncio.run(_run())


def test_request_disconnect_monitor_cancels_request_owned_work() -> None:
    async def _run() -> None:
        disconnected = asyncio.Event()
        started = asyncio.Event()
        work_cancelled = asyncio.Event()

        class Request:
            async def is_disconnected(self) -> bool:
                return disconnected.is_set()

        async def work() -> None:
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                work_cancelled.set()

        running = asyncio.create_task(indicators_api._run_until_request_disconnect(
            Request(),
            work(),
            task_name="test-indicator-disconnect",
        ))
        await started.wait()
        disconnected.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(running, timeout=1)
        assert work_cancelled.is_set()

    asyncio.run(_run())


def test_request_disconnect_monitor_failure_does_not_cancel_normal_work() -> None:
    async def _run() -> None:
        work_cancelled = False

        class Request:
            async def is_disconnected(self) -> bool:
                raise RuntimeError("receive channel unavailable")

        async def work() -> str:
            nonlocal work_cancelled
            try:
                await asyncio.sleep(0)
                return "completed"
            except asyncio.CancelledError:
                work_cancelled = True
                raise

        result = await indicators_api._run_until_request_disconnect(
            Request(),
            work(),
            task_name="test-indicator-disconnect-fail-open",
        )
        assert result == "completed"
        assert work_cancelled is False

    asyncio.run(_run())


def test_disconnected_range_revokes_owner_before_late_storage_query_returns() -> None:
    async def _run() -> None:
        bars = _bars(10)
        query_entered = threading.Event()
        release_query = threading.Event()
        captured_query: dict = {}

        class DataManager:
            def query(self, *args, **kwargs):
                query_entered.set()
                if not release_query.wait(timeout=2):
                    raise TimeoutError("test query was not released")
                captured_query.update(kwargs)
                return SimpleNamespace(bars=bars, missing_ranges=[], metadata={})

        class Coordinator:
            def __init__(self) -> None:
                self.generations: dict[str, int] = {}
                self.revoked: list[tuple[str, str]] = []

            async def advance_demand_scope(self, scope: str, generation: int) -> int:
                self.generations[scope] = max(generation, self.generations.get(scope, -1))
                return 0

            def is_demand_generation_current(self, scope: str, generation: int) -> bool:
                return generation >= self.generations.get(scope, generation)

            async def revoke_demand_owner(self, owner_id: str, *, reason: str) -> int:
                self.revoked.append((owner_id, reason))
                return 0

        coordinator = Coordinator()

        class Request:
            disconnected = False
            state = SimpleNamespace()
            app = SimpleNamespace(state=SimpleNamespace(
                data_manager=DataManager(),
                backfill_coordinator=coordinator,
            ))

            async def is_disconnected(self) -> bool:
                return self.disconnected

        request = Request()
        body = indicators_api.IndicatorRangeRequest(
            clientId="ma-disconnect",
            kind="builtin",
            symbol="BTCUSDT",
            interval="1m",
            name="MA",
            params={"period": 3},
            start=bars[0].time,
            end=bars[-1].time,
            requestScope="chart:test:disconnect",
            requestGeneration=4,
        )
        running = asyncio.create_task(indicators_api.compute_range(body, request))
        try:
            for _ in range(100):
                if query_entered.is_set():
                    break
                await asyncio.sleep(0.01)
            assert query_entered.is_set()
            request.disconnected = True
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(running, timeout=1)

            assert len(coordinator.revoked) == 1
            revoked_owner, reason = coordinator.revoked[0]
            assert reason == "indicator_http_disconnected"
            assert revoked_owner.startswith("indicator:chart:test:disconnect:4:")

            # The sync storage read can return after the HTTP coroutine was
            # cancelled, but it is read-only and therefore cannot enqueue any
            # late indicator-owned repair.
            release_query.set()
            for _ in range(100):
                if captured_query:
                    break
                await asyncio.sleep(0.01)
            assert captured_query["auto_backfill"] is False
            assert "backfill_metadata" not in captured_query
        finally:
            release_query.set()
            if not running.done():
                running.cancel()
                await asyncio.gather(running, return_exceptions=True)

    asyncio.run(_run())


def test_stale_indicator_generation_is_rejected_before_storage_query() -> None:
    bars = _bars(10)

    class DataManager:
        calls = 0

        def query(self, *args, **kwargs):
            self.calls += 1
            return SimpleNamespace(bars=bars, missing_ranges=[], metadata={})

    class Coordinator:
        current = 5

        def is_demand_generation_current(self, scope: str, generation: int) -> bool:
            assert scope == "chart:test:stale"
            return generation >= self.current

        async def advance_demand_scope(self, scope: str, generation: int) -> int:
            self.current = max(self.current, generation)
            return 0

    dm = DataManager()
    app = FastAPI()
    app.include_router(indicators_api.router, prefix="/api/v1")
    app.state.data_manager = dm
    app.state.backfill_coordinator = Coordinator()
    client = TestClient(app)

    response = client.post("/api/v1/indicators/range", json={
        "clientId": "ma-stale",
        "kind": "builtin",
        "symbol": "BTCUSDT",
        "interval": "1m",
        "name": "MA",
        "params": {"period": 3},
        "start": bars[0].time,
        "end": bars[-1].time,
        "requestScope": "chart:test:stale",
        "requestGeneration": 4,
    })

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "stale_request_generation"
    assert dm.calls == 0


def test_singleflight_join_recomputes_when_wide_flight_only_returns_tail() -> None:
    async def _run() -> None:
        service = IndicatorRangeResultService(
            revision_registry=SeriesRevisionRegistry(server_epoch="epoch-test"),
            ttl_seconds=60,
            max_entries=8,
        )
        meta = _meta()
        start = 1_700_000_000
        prefix_end = start + 4 * 60
        tail_start = start + 7 * 60
        end = start + 9 * 60
        wide_started = asyncio.Event()
        release_wide = asyncio.Event()
        wide_calls = 0
        prefix_calls = 0

        async def compute_wide_tail() -> dict:
            nonlocal wide_calls
            wide_calls += 1
            wide_started.set()
            await release_wide.wait()
            return _payload(tail_start, end)

        async def compute_prefix() -> dict:
            nonlocal prefix_calls
            prefix_calls += 1
            return _payload(start, prefix_end)

        wide_task = asyncio.create_task(service.get_or_compute(
            meta=meta,
            start=start,
            end=end,
            compute=compute_wide_tail,
        ))
        await wide_started.wait()
        prefix_task = asyncio.create_task(service.get_or_compute(
            meta=meta,
            start=start,
            end=prefix_end,
            compute=compute_prefix,
        ))

        for _ in range(10):
            await asyncio.sleep(0)
            if service.snapshot()["singleflightJoins"] == 1:
                break
        assert service.snapshot()["singleflightJoins"] == 1

        release_wide.set()
        wide_result, prefix_result = await asyncio.gather(wide_task, prefix_task)

        assert wide_result[0]["range"] == {"start": tail_start, "end": end}
        assert wide_result[1] is False
        assert prefix_result[0]["range"] == {"start": start, "end": prefix_end}
        assert prefix_result[1] is False
        assert wide_calls == 1
        assert prefix_calls == 1
        assert service.lookup_snapshot(meta, start, prefix_end) is not None
        assert service.snapshot()["computes"] == 2

    asyncio.run(_run())


def test_result_service_recomputes_when_revision_changes_mid_compute() -> None:
    async def _run() -> None:
        service = IndicatorRangeResultService(
            revision_registry=SeriesRevisionRegistry(server_epoch="epoch-test"),
            ttl_seconds=60,
            max_entries=8,
        )
        meta = _meta()
        start = 1_700_000_000
        end = start + 120
        calls = 0

        async def compute() -> dict:
            nonlocal calls
            calls += 1
            payload = _payload(start, end)
            payload["generation"] = calls
            if calls == 1:
                service.note_correction(
                    series_key="binance:spot:BTCUSDT:1m",
                    start=start + 60,
                    end=start + 60,
                    event_id="during-compute",
                )
            return payload

        payload, cache_hit, revision = await service.get_or_compute(
            meta=meta,
            start=start,
            end=end,
            compute=compute,
        )

        assert calls == 2
        assert cache_hit is False
        assert payload["generation"] == 2
        assert revision["correctionRevision"] == 1
        cached = service.lookup_snapshot(meta, start, end)
        assert cached is not None
        assert cached["generation"] == 2

    asyncio.run(_run())


def test_engine_seed_result_cache_uses_seed_bar_coverage_not_output_hull() -> None:
    service = IndicatorRangeResultService(ttl_seconds=60, max_entries=8)
    engine = create_engine()
    service.bind_engine(engine)
    bars = _bars(5)

    key, _result = engine.subscribe(
        "BTCUSDT",
        "1m",
        "spot",
        "MA",
        {"period": 20},
        bars,
        exchange="binance",
    )
    meta = {
        **_meta(),
        "params": {"period": 20},
        "indicatorId": key.uid,
    }

    # MA(20) has no non-null output in this seed, but all five input bars were
    # computed and therefore form authoritative coverage.
    assert service.lookup_snapshot(meta, bars[0].time, bars[-1].time) is not None


def test_engine_warm_resume_catches_up_and_backfill_evicts_idle_state() -> None:
    engine = create_engine()
    engine._warm_ttl_seconds = 60
    engine._warm_max_instances = 8
    initial = _bars(5)
    key, _ = engine.subscribe(
        "BTCUSDT", "1m", "spot", "MA", {"period": 3}, initial,
    )
    first_instance = engine.get_instance(key)
    engine.unsubscribe(key)

    assert engine.get_instance(key) is first_instance
    assert engine.snapshot()["warm_idle_count"] == 1

    resumed_bars = [*initial, *_bars(2, start=initial[-1].time + 60)]
    resumed_key, result = engine.subscribe(
        "BTCUSDT", "1m", "spot", "MA", {"period": 3}, resumed_bars,
    )
    assert resumed_key == key
    assert engine.get_instance(key) is first_instance
    assert result.outputs["ma"].data[-1].timestamp == resumed_bars[-1].time

    engine.unsubscribe(key)
    engine.on_bars_backfilled("BTCUSDT", "1m", resumed_bars)
    assert engine.get_instance(key) is None

    next_key, _ = engine.subscribe(
        "BTCUSDT", "1m", "spot", "MA", {"period": 3}, resumed_bars,
    )
    assert next_key == key
    assert engine.get_instance(key) is not first_instance


def test_engine_warm_resume_full_recomputes_when_seed_no_longer_overlaps_checkpoint() -> None:
    engine = create_engine()
    engine._warm_ttl_seconds = 60
    engine._warm_max_instances = 8
    initial = _bars(5)
    key, _ = engine.subscribe("BTCUSDT", "1m", "spot", "MA", {"period": 3}, initial)
    engine.unsubscribe(key)
    truncated = _bars(3, start=initial[-1].time + 120)

    _, resumed = engine.subscribe(
        "BTCUSDT", "1m", "spot", "MA", {"period": 3}, truncated,
    )
    fresh = create_engine().compute(
        "BTCUSDT", "1m", "spot", "MA", {"period": 3}, truncated,
    )

    assert resumed.to_dict() == fresh.to_dict()


def test_engine_warm_resume_full_recomputes_when_seed_extends_left() -> None:
    engine = create_engine()
    engine._warm_ttl_seconds = 60
    engine._warm_max_instances = 8
    full_history = _bars(12)
    initial_tail = full_history[5:10]
    initialized_events: list[IndicatorEvent] = []
    engine.add_listener(
        lambda event: initialized_events.append(event)
        if event.event_type == IndicatorEventType.INSTANCE_INITIALIZED
        else None
    )

    key, _ = engine.subscribe(
        "BTCUSDT", "1m", "spot", "MA", {"period": 3}, initial_tail,
    )
    first_instance = engine.get_instance(key)
    engine.unsubscribe(key)

    resumed_key, resumed = engine.subscribe(
        "BTCUSDT", "1m", "spot", "MA", {"period": 3}, full_history,
    )
    fresh = create_engine().compute(
        "BTCUSDT", "1m", "spot", "MA", {"period": 3}, full_history,
    )

    assert resumed_key == key
    assert engine.get_instance(key) is first_instance
    assert resumed.to_dict() == fresh.to_dict()
    assert engine.get_instance(key).bar_count == len(full_history)
    assert initialized_events[-1].detail["computedRange"] == {
        "start": full_history[0].time,
        "end": full_history[-1].time,
    }
    instance_snapshot = next(
        item for item in engine.snapshot()["instances"] if item["key"] == key.uid
    )
    assert instance_snapshot["first_committed"] == full_history[0].time
    assert instance_snapshot["last_committed"] == full_history[-1].time


def test_engine_prepend_resume_caches_complete_wide_result() -> None:
    service = IndicatorRangeResultService(ttl_seconds=60, max_entries=8)
    engine = create_engine()
    service.bind_engine(engine)
    full_history = _bars(12)
    initial_tail = full_history[-5:]

    key, _ = engine.subscribe(
        "BTCUSDT", "1m", "spot", "VOL", {}, initial_tail,
        exchange="binance",
    )
    engine.unsubscribe(key)
    engine.subscribe(
        "BTCUSDT", "1m", "spot", "VOL", {}, full_history,
        exchange="binance",
    )
    meta = {
        "kind": "builtin",
        "exchange": "binance",
        "market_type": "spot",
        "symbol": "BTCUSDT",
        "interval": "1m",
        "name": "VOL",
        "params": {},
        "indicatorId": key.uid,
    }

    cached = service.lookup_snapshot(
        meta, full_history[0].time, full_history[-1].time,
    )

    assert cached is not None
    assert cached["range"] == {
        "start": full_history[0].time,
        "end": full_history[-1].time,
    }
    assert len(cached["series"][0]["data"]) == len(full_history)
    assert cached["series"][0]["data"][0]["time"] == full_history[0].time
    assert cached["series"][0]["data"][-1]["time"] == full_history[-1].time


def test_engine_event_range_without_computed_range_cannot_poison_wide_cache() -> None:
    service = IndicatorRangeResultService(ttl_seconds=60, max_entries=8)
    engine = create_engine()
    full_history = _bars(12)
    actual_tail = full_history[-5:]
    key, result = engine.subscribe(
        "BTCUSDT", "1m", "spot", "VOL", {}, actual_tail,
        exchange="binance",
    )
    service._on_engine_event(IndicatorEvent(
        event_type=IndicatorEventType.INSTANCE_INITIALIZED,
        key=key,
        full_result=result,
        detail={"range": {
            "start": full_history[0].time,
            "end": full_history[-1].time,
        }},
    ))
    meta = {
        "kind": "builtin",
        "exchange": "binance",
        "market_type": "spot",
        "symbol": "BTCUSDT",
        "interval": "1m",
        "name": "VOL",
        "params": {},
        "indicatorId": key.uid,
    }

    assert service.lookup_snapshot(
        meta, full_history[0].time, full_history[-1].time,
    ) is None
    cached_tail = service.lookup_snapshot(
        meta, actual_tail[0].time, actual_tail[-1].time,
    )
    assert cached_tail is not None
    assert cached_tail["range"] == {
        "start": actual_tail[0].time,
        "end": actual_tail[-1].time,
    }


@pytest.mark.parametrize(
    "event_type",
    [
        IndicatorEventType.INSTANCE_INITIALIZED,
        IndicatorEventType.INDICATOR_RECOMPUTED,
    ],
)
def test_stale_engine_event_revision_cannot_write_current_cache(event_type) -> None:
    service = IndicatorRangeResultService(
        ttl_seconds=60,
        max_entries=8,
        revision_registry=SeriesRevisionRegistry(server_epoch="epoch-test"),
    )
    bars = _bars(5)
    engine = create_engine()
    key, result = engine.subscribe(
        "BTCUSDT", "1m", "spot", "VOL", {}, bars, exchange="binance",
    )
    meta = {
        "kind": "builtin",
        "exchange": "binance",
        "market_type": "spot",
        "symbol": "BTCUSDT",
        "interval": "1m",
        "name": "VOL",
        "params": {},
        "indicatorId": key.uid,
    }
    stale_revision = service.data_revision_for_meta(meta)
    service.note_correction(
        series_key="binance:spot:BTCUSDT:1m",
        start=bars[0].time,
        end=bars[-1].time,
        event_id="newer-revision",
    )

    service._on_engine_event(IndicatorEvent(
        event_type=event_type,
        key=key,
        full_result=result,
        detail={
            "computedRange": {"start": bars[0].time, "end": bars[-1].time},
            "dataRevision": stale_revision,
        },
    ))

    assert service.lookup_snapshot(meta, bars[0].time, bars[-1].time) is None
    assert service.snapshot()["puts"] == 0


class _CountingRangeDataManager:
    def __init__(self, bars: list[BarData]) -> None:
        self.bars = bars
        self.calls = 0

    def query(self, *args, **kwargs):
        self.calls += 1
        return SimpleNamespace(bars=self.bars, missing_ranges=[], metadata={})


def test_http_range_reuses_app_scoped_result_without_second_query() -> None:
    bars = _bars(10)
    dm = _CountingRangeDataManager(bars)
    app = FastAPI()
    app.include_router(indicators_api.router, prefix="/api/v1")
    app.state.data_manager = dm
    app.state.indicator_range_service = IndicatorRangeResultService(
        ttl_seconds=60,
        max_entries=8,
    )
    client = TestClient(app)
    body = {
        "clientId": "ma-1",
        "kind": "builtin",
        "symbol": "BTCUSDT",
        "interval": "1m",
        "name": "MA",
        "params": {"period": 3},
        "start": bars[0].time,
        "end": bars[-1].time,
    }

    first = client.post("/api/v1/indicators/range", json=body)
    second_body = {**body, "start": bars[5].time}
    second = client.post("/api/v1/indicators/range", json=second_body)

    assert first.status_code == 200
    assert first.json()["cacheHit"] is False
    assert second.status_code == 200
    assert second.json()["cacheHit"] is True
    assert dm.calls == 1
    assert second.json()["dataRevision"]["closedThrough"] == bars[-1].time
    assert second.json()["range"] == {"start": bars[5].time, "end": bars[-1].time}
    assert second.json()["result"]["outputs"]["ma"]["data"][0]["time"] >= bars[5].time


def test_partial_http_result_does_not_cache_uncomputed_prefix_as_covered() -> None:
    bars = _bars(10)
    dm = _CountingRangeDataManager(bars[-3:])
    app = FastAPI()
    app.include_router(indicators_api.router, prefix="/api/v1")
    app.state.data_manager = dm
    app.state.indicator_range_service = IndicatorRangeResultService(
        ttl_seconds=60,
        max_entries=8,
    )
    client = TestClient(app)
    body = {
        "clientId": "ma-partial",
        "kind": "builtin",
        "symbol": "BTCUSDT",
        "interval": "1m",
        "name": "MA",
        "params": {"period": 3},
        "start": bars[0].time,
        "end": bars[-1].time,
    }

    first = client.post("/api/v1/indicators/range", json=body)

    assert first.status_code == 200
    assert first.json()["cacheHit"] is False
    assert first.json()["range"] == {
        "start": bars[-3].time,
        "end": bars[-1].time,
    }
    assert dm.calls == 1

    dm.bars = bars
    second = client.post("/api/v1/indicators/range", json=body)
    third = client.post("/api/v1/indicators/range", json=body)

    assert second.status_code == 200
    assert second.json()["cacheHit"] is False
    assert second.json()["range"] == {
        "start": bars[0].time,
        "end": bars[-1].time,
    }
    assert third.status_code == 200
    assert third.json()["cacheHit"] is True
    assert dm.calls == 2


def test_http_range_waits_for_exact_backfill_future_then_requeries() -> None:
    bars = _bars(5)

    class DataManager(_CountingRangeDataManager):
        ready = False

        def query(self, *args, **kwargs):
            self.calls += 1
            if not self.ready:
                missing = SimpleNamespace(
                    start_ms=bars[0].time * 1000,
                    end_ms=bars[-1].time * 1000,
                )
                return SimpleNamespace(
                    bars=bars,
                    missing_ranges=[missing],
                    metadata={"backfill_request_ids": ["repair-1"]},
                )
            return SimpleNamespace(bars=bars, missing_ranges=[], metadata={})

    dm = DataManager(bars)

    class Coordinator:
        async def wait_for_request(self, request_id: str):
            assert request_id == "repair-1"
            dm.ready = True
            return SimpleNamespace(bars_loaded=5)

    app = FastAPI()
    app.include_router(indicators_api.router, prefix="/api/v1")
    app.state.data_manager = dm
    app.state.backfill_coordinator = Coordinator()
    client = TestClient(app)

    response = client.post("/api/v1/indicators/range", json={
        "clientId": "ma-1",
        "kind": "builtin",
        "symbol": "BTCUSDT",
        "interval": "1m",
        "name": "MA",
        "params": {"period": 3},
        "start": bars[0].time,
        "end": bars[-1].time,
    })

    assert response.status_code == 200
    assert response.json()["type"] == "indicator.replace_range"
    assert dm.calls == 2


def test_http_range_timeout_returns_202_with_exact_request_ids(monkeypatch) -> None:
    bars = _bars(5)

    class DataManager(_CountingRangeDataManager):
        def query(self, *args, **kwargs):
            self.calls += 1
            missing = SimpleNamespace(
                start_ms=bars[0].time * 1000,
                end_ms=bars[-1].time * 1000,
            )
            return SimpleNamespace(
                bars=bars,
                missing_ranges=[missing],
                metadata={"backfill_request_ids": ["repair-timeout"]},
            )

    class Coordinator:
        async def wait_for_request(self, _request_id: str):
            await asyncio.Event().wait()

    monkeypatch.setattr(
        indicators_api.config,
        "INDICATOR_RANGE_BACKFILL_WAIT_SECONDS",
        0.01,
    )
    app = FastAPI()
    app.include_router(indicators_api.router, prefix="/api/v1")
    app.state.data_manager = DataManager(bars)
    app.state.backfill_coordinator = Coordinator()
    client = TestClient(app)

    response = client.post("/api/v1/indicators/range", json={
        "clientId": "ma-1",
        "kind": "builtin",
        "symbol": "BTCUSDT",
        "interval": "1m",
        "name": "MA",
        "params": {"period": 3},
        "start": bars[0].time,
        "end": bars[-1].time,
    })

    assert response.status_code == 202
    detail = response.json()["detail"]
    assert detail["backfillRequestIds"] == ["repair-timeout"]
    assert "retryAfterMs" not in detail
