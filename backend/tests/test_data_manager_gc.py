from __future__ import annotations

import asyncio

import pytest

from app.data_engine.data_manager import BarData, DataManager, SeriesKey
from app.data_engine.data_manager.models import StreamInfo, StreamStatus
from app.data_engine.data_manager import auto_gc as auto_gc_module
from app.data_engine.data_manager.auto_gc import AutoGcPolicy, filter_auto_memory_plan
from app.data_engine.data_manager.cache_behavior import CacheAccessEvent, CacheBehaviorStore
from app.data_engine.data_manager.runtime_pressure import disk_pressure_snapshot, process_memory_snapshot


def _bars(count: int) -> list[BarData]:
    return [
        BarData(time=index, open=1, high=1, low=1, close=1, volume=1)
        for index in range(count)
    ]


def test_memory_gc_dry_run_does_not_mutate_cache() -> None:
    dm = DataManager()
    key = SeriesKey("ETHUSDT", "1m")
    dm.cache.bulk_load(key, _bars(5))

    report = dm.plan_memory_gc({"cold_idle_seconds": 0})

    assert report["mode"] == "dry-run"
    assert report["would_free_bars"] == 5
    assert dm.cache.has_series(key)
    assert dm.cache.series_count(key) == 5


def test_memory_gc_run_deletes_cold_storage_backed_series_and_preserves_leases() -> None:
    dm = DataManager()
    cold_key = SeriesKey("ETHUSDT", "1m")
    leased_key = SeriesKey("BTCUSDT", "1m")
    dm.cache.bulk_load(cold_key, _bars(5))
    dm.cache.bulk_load(leased_key, _bars(7))
    dm._register_stream_leases((leased_key,), consumer_id="watchlist:full:test")

    report = dm.run_memory_gc({"cold_idle_seconds": 0})

    assert report["mode"] == "execute"
    assert report["removed_series"] == 1
    assert report["removed_bars"] == 5
    assert not dm.cache.has_series(cold_key)
    assert dm.cache.has_series(leased_key)
    assert dm.cache.series_count(leased_key) == 7


def test_memory_gc_trims_ephemeral_series_instead_of_deleting() -> None:
    dm = DataManager()
    key = SeriesKey("BTCUSDT", "1s")
    dm.cache.bulk_load(key, _bars(5))
    dm.cache.set_ephemeral_limit(2)

    report = dm.run_memory_gc({"cold_idle_seconds": 0})

    assert report["trimmed_series"] == 1
    assert report["removed_series"] == 0
    assert report["removed_bars"] == 3
    assert dm.cache.has_series(key)
    assert dm.cache.series_count(key) == 2


def test_cache_behavior_store_updates_heat(tmp_path) -> None:
    store = CacheBehaviorStore(tmp_path / "behavior.sqlite")
    key = SeriesKey("BTCUSDT", "1m")

    store.record(CacheAccessEvent(key=key, action="chart-active", source="test", occurred_at_ms=1_000))
    heat = store.record(CacheAccessEvent(key=key, action="chart-switch", source="test", occurred_at_ms=2_000))

    assert heat["symbol"] == "BTCUSDT"
    assert heat["access_count_24h"] == 2
    assert heat["switch_count_24h"] == 2
    assert heat["heat_score"] > 0


def test_memory_gc_smart_scoring_prefers_low_heat_series(tmp_path) -> None:
    dm = DataManager()
    dm.cache_behavior = CacheBehaviorStore(tmp_path / "behavior.sqlite")
    cold_key = SeriesKey("ETHUSDT", "1m")
    hot_key = SeriesKey("BTCUSDT", "1m")
    dm.cache.bulk_load(cold_key, _bars(5))
    dm.cache.bulk_load(hot_key, _bars(5))
    dm.record_cache_access("BTCUSDT", "1m", action="chart-active", source="test")

    report = dm.plan_memory_gc({"cold_idle_seconds": 0, "max_victims": 2})

    assert report["scoringVersion"] == 1
    assert report["victims"][0]["symbol"] == "ETHUSDT"
    assert "scores" in report["victims"][0]
    assert report["victims"][1]["reuseReason"] in {"hot-series", "recently-reused"}


def test_cache_access_deferred_uses_background_storage_executor(monkeypatch) -> None:
    dm = DataManager()
    calls: list[tuple[str, str, dict]] = []

    def fake_record(symbol: str, interval: str, **kwargs) -> dict:
        calls.append((symbol, interval, kwargs))
        return {}

    monkeypatch.setattr(dm, "record_cache_access", fake_record)

    async def run() -> None:
        dm._cache_access_loop = asyncio.get_running_loop()
        dm.record_cache_access_deferred(
            "BTCUSDT",
            "1m",
            action="history-query",
            source="test",
        )
        await asyncio.sleep(0)
        if dm._cache_access_tasks:
            await asyncio.gather(*dm._cache_access_tasks)

    asyncio.run(run())

    assert calls == [("BTCUSDT", "1m", {"action": "history-query", "source": "test"})]


def test_auto_memory_gc_filter_only_keeps_high_confidence_victims() -> None:
    plan = {
        "mode": "dry-run",
        "victims": [
            {
                "key": "binance:spot:ETHUSDT:1m",
                "action": "delete-series",
                "would_free_bars": 10,
                "would_free_estimated_bytes": 1_000,
                "scores": {"finalEvictScore": 90},
            },
            {
                "key": "binance:spot:BTCUSDT:1m",
                "action": "delete-series",
                "would_free_bars": 10,
                "would_free_estimated_bytes": 1_000,
                "scores": {"finalEvictScore": 20},
            },
        ],
    }

    filtered = filter_auto_memory_plan(plan, AutoGcPolicy(min_final_evict_score=70))

    assert filtered["mode"] == "auto-plan"
    assert [item["key"] for item in filtered["victims"]] == ["binance:spot:ETHUSDT:1m"]
    assert filtered["autoSkipped"][0]["reason"] == "score-below-threshold"


@pytest.mark.anyio
async def test_auto_gc_offloads_planning_and_audit(monkeypatch) -> None:
    calls: list[str] = []

    async def fake_run_storage(func, *args, **kwargs):
        name = getattr(func, "__name__", str(func))
        calls.append(name)
        if name == "append_auto_gc_audit":
            return None
        return func(*args, **kwargs)

    class _Maintenance:
        async def run_storage_gc(self, *args, **kwargs):
            return {"mode": "execute", "status": "ok", "deleted_rows": 0}

    class _Manager:
        maintenance = _Maintenance()

        def plan_memory_gc(self):
            return {"mode": "dry-run", "victims": []}

        def plan_storage_gc(self):
            return {"mode": "dry-run", "series": [], "watermarks": {"level": "normal"}}

    monkeypatch.setattr(auto_gc_module, "run_storage", fake_run_storage)

    report = await auto_gc_module.run_auto_gc_once(
        _Manager(),
        AutoGcPolicy(enabled=True, audit_path="unused.jsonl"),
    )

    assert report["status"] == "ok"
    assert calls == ["plan_memory_gc", "plan_storage_gc", "append_auto_gc_audit"]


def test_runtime_pressure_helpers_are_structured(tmp_path) -> None:
    memory = process_memory_snapshot()
    disk = disk_pressure_snapshot(tmp_path)

    assert "available" in memory
    assert disk["available"] is True
    assert disk["total_bytes"] >= disk["free_bytes"]


class _RollbackCoordinator:
    def __init__(self) -> None:
        self.stopped: list[SeriesKey] = []

    def has_stream(self, *args, **kwargs) -> bool:
        return False

    async def ensure_stream(self, symbol, interval, exchange="binance", market_type="spot"):
        return StreamInfo(
            SeriesKey(symbol, interval, exchange=exchange, market_type=market_type),
            status=StreamStatus.ACTIVE,
        )

    async def stop_stream(self, symbol, interval, exchange="binance", market_type="spot"):
        self.stopped.append(SeriesKey(symbol, interval, exchange=exchange, market_type=market_type))


class _FailingWarmStart:
    async def seed_if_needed(self, *args, **kwargs):
        raise RuntimeError("warm start failed")


@pytest.mark.anyio
async def test_ensure_stream_rolls_back_leases_and_intents_when_warm_start_fails() -> None:
    dm = DataManager()
    coordinator = _RollbackCoordinator()
    dm.coordinator = coordinator
    dm.warm_start = _FailingWarmStart()

    with pytest.raises(RuntimeError, match="warm start failed"):
        await dm.ensure_stream(
            "BTCUSDT",
            "1m",
            focus_scope="websocket",
            subscription_tier="indicator",
            consumer_id="ws:indicator:test",
        )

    key = SeriesKey("BTCUSDT", "1m")
    assert key not in dm._stream_leases
    assert dm.storage_intents.snapshot()["intent_count"] == 0
    assert coordinator.stopped == [key]
