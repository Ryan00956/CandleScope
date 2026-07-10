from __future__ import annotations

import asyncio
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1 import indicators as indicators_api
from app.api.v1.indicator_range_batch import (
    IndicatorRangeBatchJob,
    compute_indicator_range_batch_async,
)
from app.data_engine.data_manager.models import BarData
from app.indicator.engine import indicator_code_hash
from app.indicator.range_result_service import IndicatorRangeResultService
from app.indicator.series_revision import SeriesRevisionRegistry
from app.indicator.types import IndicatorKey


class _CountingDataManager:
    def __init__(self, bars: list[BarData]) -> None:
        self.bars = bars
        self.query_calls = 0

    def query(self, *args, **kwargs):
        self.query_calls += 1
        return SimpleNamespace(bars=self.bars, missing_ranges=[], metadata={})


def _bars(count: int = 300) -> list[BarData]:
    return [
        BarData(
            time=1_700_000_000 + index * 60,
            open=100 + index,
            high=101 + index,
            low=99 + index,
            close=100 + index,
            volume=10 + index,
            is_closed=True,
        )
        for index in range(count)
    ]


def _job(name: str, params: dict, bars: list[BarData]) -> IndicatorRangeBatchJob:
    key = IndicatorKey(
        "BTCUSDT",
        "1m",
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
            "interval": "1m",
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
        })

    response = client.post("/api/v1/indicators/range/batch", json={"requests": requests})
    payload = response.json()

    assert response.status_code == 200
    assert payload["type"] == "indicator.range_batch"
    assert payload["ok"] is True
    assert dm.query_calls == 1
    assert [item["clientId"] for item in payload["results"]] == ["vol", "boll", "macd"]
    assert all(item["payload"]["type"] == "indicator.replace_range" for item in payload["results"])


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
