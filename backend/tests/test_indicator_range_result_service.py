from __future__ import annotations

import asyncio
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1 import indicators as indicators_api
from app.data_engine.data_manager.models import BarData
from app.indicator import create_engine
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
