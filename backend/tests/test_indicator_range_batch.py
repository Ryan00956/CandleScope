from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1 import indicators as indicators_api
from app.api.v1.indicator_range_batch import (
    IndicatorRangeBatchJob,
    compute_indicator_range_batch_async,
)
from app.data_engine.data_manager.models import BarData
from app.indicator.engine import indicator_code_hash
from app.indicator.range_result_service import (
    IndicatorRangeResultService,
    IndicatorRangeRevisionChangedError,
)
from app.indicator.series_revision import SeriesRevisionRegistry
from app.indicator.types import IndicatorKey


class _CountingDataManager:
    def __init__(self, bars: list[BarData]) -> None:
        self.bars = bars
        self.query_calls = 0
        self.query_kwargs: list[dict] = []

    def query(self, *args, **kwargs):
        self.query_calls += 1
        self.query_kwargs.append(dict(kwargs))
        return SimpleNamespace(bars=self.bars, missing_ranges=[], metadata={})


def _bars(count: int = 300, *, step_seconds: int = 60) -> list[BarData]:
    return [
        BarData(
            time=1_700_000_000 + index * step_seconds,
            open=100 + index,
            high=101 + index,
            low=99 + index,
            close=100 + index,
            volume=10 + index,
            is_closed=True,
        )
        for index in range(count)
    ]


def _job(
    name: str,
    params: dict,
    bars: list[BarData],
    *,
    interval: str = "1m",
) -> IndicatorRangeBatchJob:
    key = IndicatorKey(
        "BTCUSDT",
        interval,
        name,
        params,
        exchange="binance",
        market_type="spot",
        code_hash=indicator_code_hash(name),
    )
    return IndicatorRangeBatchJob(
        client_id=name.lower(),
        meta={
            "kind": "builtin",
            "exchange": "binance",
            "market_type": "spot",
            "symbol": "BTCUSDT",
            "interval": interval,
            "name": name,
            "params": params,
            "indicatorId": key.uid,
        },
        start=bars[-60].time,
        end=bars[-1].time,
        reason="test-batch",
    )


def test_builtin_batch_queries_bars_once_and_reuses_results():
    async def _run() -> None:
        bars = _bars()
        dm = _CountingDataManager(bars)
        service = IndicatorRangeResultService(
            enabled=True,
            max_entries=16,
            ttl_seconds=60,
            revision_registry=SeriesRevisionRegistry(server_epoch="test"),
        )
        jobs = [
            _job("VOL", {}, bars),
            _job("BOLL", {"period": 20}, bars),
            _job("MACD", {"fast": 12, "slow": 26, "signal": 9}, bars),
        ]

        first = await compute_indicator_range_batch_async(
            dm=dm,
            jobs=jobs,
            range_service=service,
        )
        second = await compute_indicator_range_batch_async(
            dm=dm,
            jobs=jobs,
            range_service=service,
        )

        assert dm.query_calls == 1
        assert all(not isinstance(item, BaseException) and item["ok"] for item in first)
        assert all(not isinstance(item, BaseException) and item["cacheHit"] for item in second)
        assert [item["clientId"] for item in second] == ["vol", "boll", "macd"]

    asyncio.run(_run())


def test_builtin_batch_rejects_extreme_warmup_before_query():
    async def _run() -> None:
        bars = _bars()
        dm = _CountingDataManager(bars)
        service = IndicatorRangeResultService(
            enabled=True,
            max_entries=16,
            ttl_seconds=60,
            revision_registry=SeriesRevisionRegistry(server_epoch="test"),
        )

        with pytest.raises(ValueError, match="Too many indicator bars"):
            await compute_indicator_range_batch_async(
                dm=dm,
                jobs=[_job("EMA", {"period": 10_000}, bars)],
                range_service=service,
            )

        assert dm.query_calls == 0
        assert service.snapshot()["barsEntries"] == 0

    asyncio.run(_run())


def test_partial_batch_result_does_not_cover_or_cache_uncomputed_prefix():
    async def _run() -> None:
        bars = _bars()
        dm = _CountingDataManager(bars[-3:])
        service = IndicatorRangeResultService(
            enabled=True,
            max_entries=16,
            ttl_seconds=60,
            revision_registry=SeriesRevisionRegistry(server_epoch="test"),
        )
        job = _job("VOL", {}, bars)

        first = await compute_indicator_range_batch_async(
            dm=dm,
            jobs=[job],
            range_service=service,
        )

        assert not isinstance(first[0], BaseException)
        assert first[0]["cacheHit"] is False
        assert first[0]["range"] == {
            "start": bars[-3].time,
            "end": bars[-1].time,
        }
        assert dm.query_calls == 1

        dm.bars = bars
        second = await compute_indicator_range_batch_async(
            dm=dm,
            jobs=[job],
            range_service=service,
        )
        third = await compute_indicator_range_batch_async(
            dm=dm,
            jobs=[job],
            range_service=service,
        )

        assert not isinstance(second[0], BaseException)
        assert second[0]["cacheHit"] is False
        assert second[0]["range"] == {"start": job.start, "end": job.end}
        assert not isinstance(third[0], BaseException)
        assert third[0]["cacheHit"] is True
        assert dm.query_calls == 2

    asyncio.run(_run())


def test_adjacent_batch_reuses_short_lived_covering_series_bars():
    async def _run() -> None:
        bars = _bars()
        dm = _CountingDataManager(bars)
        service = IndicatorRangeResultService(
            enabled=True,
            max_entries=16,
            ttl_seconds=60,
            bars_cache_max_entries=4,
            bars_cache_ttl_seconds=5,
            revision_registry=SeriesRevisionRegistry(server_epoch="test"),
        )
        wide = _job("VOL", {}, bars)
        narrower = IndicatorRangeBatchJob(
            client_id="vol-second-instance",
            meta={
                **wide.meta,
                "indicatorId": f"{wide.meta['indicatorId']}:second-instance",
            },
            start=bars[-30].time,
            end=wide.end,
            reason="adjacent-batch",
        )

        first = await compute_indicator_range_batch_async(
            dm=dm,
            jobs=[wide],
            range_service=service,
        )
        second = await compute_indicator_range_batch_async(
            dm=dm,
            jobs=[narrower],
            range_service=service,
        )

        assert not isinstance(first[0], BaseException)
        assert not isinstance(second[0], BaseException)
        assert second[0]["cacheHit"] is False
        assert dm.query_calls == 1
        snapshot = service.snapshot()
        assert snapshot["barsHits"] >= 1
        assert snapshot["barsQueries"] == 1

    asyncio.run(_run())


def test_repeated_89m_left_expansion_queries_new_prefix_not_growing_window():
    async def _run() -> None:
        step_seconds = 89 * 60
        bars = _bars(2_000, step_seconds=step_seconds)

        class WindowDataManager(_CountingDataManager):
            def query(self, *args, **kwargs):
                self.query_calls += 1
                self.query_kwargs.append(dict(kwargs))
                start_s = int(kwargs["start_ms"]) // 1000
                end_s = int(kwargs["end_ms"]) // 1000
                selected = [
                    bar for bar in self.bars
                    if start_s <= bar.time <= end_s
                ]
                return SimpleNamespace(
                    bars=selected,
                    missing_ranges=[],
                    metadata={},
                )

        dm = WindowDataManager(bars)
        service = IndicatorRangeResultService(
            enabled=True,
            max_entries=32,
            ttl_seconds=60,
            bars_cache_max_entries=4,
            bars_cache_ttl_seconds=60,
            revision_registry=SeriesRevisionRegistry(server_epoch="test"),
        )
        end_index = len(bars) - 1
        visible_count = 221
        page_size = 109
        page_count = 10
        previous_start_index: int | None = None

        for page in range(page_count + 1):
            start_index = end_index - visible_count + 1 - page * page_size
            if previous_start_index is not None:
                service.note_correction(
                    series_key="binance:spot:BTCUSDT:89m",
                    start=bars[start_index].time,
                    end=bars[previous_start_index - 1].time,
                    event_id=f"89m-left-page-{page}",
                )
            base_job = _job(
                "MACD",
                {"fast": 12, "slow": 26, "signal": 9},
                bars,
                interval="89m",
            )
            job = IndicatorRangeBatchJob(
                client_id="macd",
                meta=base_job.meta,
                start=bars[start_index].time,
                end=bars[end_index].time,
                reason="89m-left-expansion",
            )
            result = await compute_indicator_range_batch_async(
                dm=dm,
                jobs=[job],
                range_service=service,
            )
            assert not isinstance(result[0], BaseException)
            previous_start_index = start_index

        warmup = 26 * 5 + 9 * 3
        queried_rows = sum(
            (
                int(call["end_ms"]) - int(call["start_ms"])
            ) // (step_seconds * 1000) + 1
            for call in dm.query_kwargs
        )
        initial_rows = visible_count + warmup
        expected_incremental_rows = initial_rows + page_count * (
            page_size + warmup
        )
        naive_full_window_rows = sum(
            visible_count + page * page_size + warmup
            for page in range(page_count + 1)
        )

        assert dm.query_calls == page_count + 1
        assert queried_rows == expected_incremental_rows
        assert queried_rows < naive_full_window_rows // 2
        assert all(
            int(dm.query_kwargs[index]["end_ms"])
            == bars[
                end_index - visible_count + 1 - (index - 1) * page_size
            ].time * 1000 - step_seconds * 1000
            for index in range(1, len(dm.query_kwargs))
        )
        snapshot = service.snapshot()
        assert snapshot["barsDeltaQueries"] == page_count
        assert snapshot["barsRevisionRebases"] == page_count

    asyncio.run(_run())


@pytest.mark.parametrize("shape", ["gap", "duplicate"])
def test_sparse_or_duplicate_series_bars_are_never_cached_as_covering(shape: str):
    async def _run() -> None:
        complete = _bars(step_seconds=89 * 60)
        if shape == "gap":
            returned = [*complete[:150], *complete[151:]]
        else:
            returned = [*complete[:150], complete[149], *complete[150:]]
        dm = _CountingDataManager(returned)
        service = IndicatorRangeResultService(
            enabled=True,
            max_entries=16,
            ttl_seconds=60,
            bars_cache_max_entries=4,
            bars_cache_ttl_seconds=5,
            revision_registry=SeriesRevisionRegistry(server_epoch="test"),
        )
        first_job = _job("VOL", {}, complete, interval="89m")
        second_job = IndicatorRangeBatchJob(
            client_id=f"vol-{shape}-second",
            meta={
                **first_job.meta,
                "indicatorId": f"{first_job.meta['indicatorId']}:{shape}:second",
            },
            start=first_job.start,
            end=first_job.end,
            reason=f"{shape}-cache-guard",
        )

        first = await compute_indicator_range_batch_async(
            dm=dm,
            jobs=[first_job],
            range_service=service,
        )
        second = await compute_indicator_range_batch_async(
            dm=dm,
            jobs=[second_job],
            range_service=service,
        )

        assert not isinstance(first[0], BaseException)
        assert not isinstance(second[0], BaseException)
        assert dm.query_calls == 2
        snapshot = service.snapshot()
        assert snapshot["barsEntries"] == 0
        assert snapshot["barsPuts"] == 0
        assert snapshot["barsHits"] == 0

    asyncio.run(_run())


def test_batch_http_contract_preserves_request_order_and_queries_once():
    bars = _bars()
    dm = _CountingDataManager(bars)
    app = FastAPI()
    app.include_router(indicators_api.router, prefix="/api/v1")
    app.state.data_manager = dm
    client = TestClient(app)
    requests = []
    for name, params in [
        ("VOL", {}),
        ("BOLL", {"period": 20}),
        ("MACD", {"fast": 12, "slow": 26, "signal": 9}),
    ]:
        requests.append({
            "clientId": name.lower(),
            "kind": "builtin",
            "exchange": "binance",
            "marketType": "spot",
            "symbol": "BTCUSDT",
            "interval": "1m",
            "name": name,
            "params": params,
            "start": bars[-60].time,
            "end": bars[-1].time,
            "reason": "test-http-batch",
            "requestScope": "chart:test:pane-1",
            "requestGeneration": 7,
        })

    response = client.post("/api/v1/indicators/range/batch", json={"requests": requests})
    payload = response.json()

    assert response.status_code == 200
    assert payload["type"] == "indicator.range_batch"
    assert payload["ok"] is True
    assert dm.query_calls == 1
    assert dm.query_kwargs[0]["auto_backfill"] is False
    assert "backfill_metadata" not in dm.query_kwargs[0]
    assert [item["clientId"] for item in payload["results"]] == ["vol", "boll", "macd"]
    assert all(item["payload"]["type"] == "indicator.replace_range" for item in payload["results"])


def test_batch_http_not_ready_is_event_driven_and_does_not_claim_backfill():
    bars = _bars()

    class MissingDataManager(_CountingDataManager):
        def query(self, *args, **kwargs):
            self.query_calls += 1
            self.query_kwargs.append(dict(kwargs))
            missing = SimpleNamespace(
                start_ms=bars[-60].time * 1000,
                end_ms=bars[-1].time * 1000,
            )
            return SimpleNamespace(
                bars=self.bars,
                missing_ranges=[missing],
                metadata={},
            )

    dm = MissingDataManager(bars)
    app = FastAPI()
    app.include_router(indicators_api.router, prefix="/api/v1")
    app.state.data_manager = dm
    client = TestClient(app)
    response = client.post("/api/v1/indicators/range/batch", json={"requests": [{
        "clientId": "ema",
        "kind": "builtin",
        "exchange": "binance",
        "marketType": "spot",
        "symbol": "BTCUSDT",
        "interval": "1m",
        "name": "EMA",
        "params": {"period": 20},
        "start": bars[-60].time,
        "end": bars[-1].time,
        "reason": "test-not-ready",
        "requestScope": "chart:test:pane-1",
        "requestGeneration": 7,
    }]})
    payload = response.json()

    assert response.status_code == 200
    assert payload["ok"] is False
    item = payload["results"][0]["payload"]
    assert item["code"] == "INDICATOR_RANGE_NOT_READY"
    assert item["detail"]["retryMode"] == "event"
    assert item["detail"]["backfillRequestIds"] == []
    assert "retryAfterMs" not in item["detail"]
    assert item["dataRevision"]["revisionToken"]
    assert dm.query_calls == 1
    assert dm.query_kwargs[0]["auto_backfill"] is False
    assert "backfill_metadata" not in dm.query_kwargs[0]


def test_batch_runtime_failure_is_not_misreported_as_not_ready():
    payload = indicators_api._batch_range_error_payload(
        RuntimeError("indicator execution failed"),
        start_s=1_700_000_000,
        end_s=1_700_000_060,
    )

    assert payload["code"] == "INDICATOR_RANGE_COMPUTE_FAILED"
    assert payload["ok"] is False
    assert "retryMode" not in payload.get("detail", {})


def test_batch_revision_race_is_event_driven_not_ready():
    payload = indicators_api._batch_range_error_payload(
        IndicatorRangeRevisionChangedError("revision changed during compute"),
        start_s=1_700_000_000,
        end_s=1_700_000_060,
    )

    assert payload["code"] == "INDICATOR_RANGE_NOT_READY"
    assert payload["detail"]["retryMode"] == "event"
    assert payload["detail"]["backfillRequestIds"] == []
    assert "retryAfterMs" not in payload["detail"]


def test_batch_requeries_shared_bars_when_revision_changes_during_query():
    async def _run() -> None:
        bars = _bars()
        service = IndicatorRangeResultService(
            enabled=True,
            max_entries=16,
            ttl_seconds=60,
            revision_registry=SeriesRevisionRegistry(server_epoch="test"),
        )

        class RaceDataManager(_CountingDataManager):
            def query(self, *args, **kwargs):
                self.query_calls += 1
                if self.query_calls == 1:
                    service.note_correction(
                        series_key="binance:spot:BTCUSDT:1m",
                        start=bars[-10].time,
                        end=bars[-10].time,
                        event_id="during-batch-query",
                    )
                return SimpleNamespace(bars=self.bars, missing_ranges=[], metadata={})

        dm = RaceDataManager(bars)
        result = await compute_indicator_range_batch_async(
            dm=dm,
            jobs=[_job("VOL", {}, bars)],
            range_service=service,
        )

        assert dm.query_calls == 2
        assert not isinstance(result[0], BaseException)
        assert result[0]["dataRevision"]["correctionRevision"] == 1

    asyncio.run(_run())
