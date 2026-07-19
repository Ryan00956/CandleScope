from __future__ import annotations

import asyncio
import json
import time
from dataclasses import FrozenInstanceError

import pytest

from app.data_engine.data_manager import BarData, DataManager, SeriesKey
from app.data_engine.data_manager.models import DataEventType, StreamInfo, StreamStatus
from app.data_engine.data_manager import auto_gc as auto_gc_module
from app.data_engine.data_manager import manager as manager_module
from app.data_engine.data_manager import runtime_pressure as runtime_pressure_module
from app.data_engine.data_manager.auto_gc import (
    AutoGcPolicy,
    filter_auto_memory_plan,
    filter_auto_storage_plan,
)
from app.data_engine.data_manager.cache_behavior import CacheAccessEvent, CacheBehaviorStore
from app.data_engine.data_manager.runtime_pressure import disk_pressure_snapshot, process_memory_snapshot
from app.data_engine.data_manager.storage_intents import StorageIntentRegistry


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


def test_cache_behavior_store_updates_heat(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(
        "app.data_engine.data_manager.cache_behavior.time.time",
        lambda: 2.0,
    )
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
    calls: list[list[CacheAccessEvent]] = []

    def fake_record_batch(events, *, refresh_heat=False) -> dict:
        calls.append(list(events))
        return {}

    monkeypatch.setattr(dm.cache_behavior, "record_batch", fake_record_batch)

    async def run() -> None:
        dm._cache_access_loop = asyncio.get_running_loop()
        dm.record_cache_access_deferred(
            "BTCUSDT",
            "1m",
            action="history-query",
            source="test",
        )
        await asyncio.sleep(0)
        if dm._cache_access_writer_task is not None:
            await dm._cache_access_writer_task

    asyncio.run(run())

    assert len(calls) == 1
    assert len(calls[0]) == 1
    assert calls[0][0].key == SeriesKey("BTCUSDT", "1m")
    assert calls[0][0].action == "history-query"
    assert calls[0][0].source == "test"


def test_cache_access_deferred_coalesces_repeated_signals(monkeypatch) -> None:
    dm = DataManager()
    calls: list[list[CacheAccessEvent]] = []

    def fake_record_batch(events, *, refresh_heat=False) -> dict:
        calls.append(list(events))
        return {}

    monkeypatch.setattr(dm.cache_behavior, "record_batch", fake_record_batch)

    async def run() -> None:
        dm._cache_access_loop = asyncio.get_running_loop()
        for _ in range(1_000):
            dm.record_cache_access_deferred(
                "BTCUSDT",
                "1m",
                action="history-query",
                source="test",
            )
        await asyncio.sleep(0)
        if dm._cache_access_writer_task is not None:
            await dm._cache_access_writer_task

    asyncio.run(run())

    assert len(calls) == 1
    assert len(calls[0]) == 1
    assert calls[0][0].count == 1_000
    stats = dm._cache_access_writer_snapshot()
    assert stats["signals"] == 1_000
    assert stats["coalesced"] == 999
    assert stats["persisted_signals"] == 1_000
    assert stats["pending_signals"] == 0


def test_cache_access_deferred_clamps_future_time_before_bucket_identity(
    monkeypatch,
) -> None:
    server_now_ms = 1_700_000_012_345
    monkeypatch.setattr(
        manager_module.time,
        "time",
        lambda: server_now_ms / 1000,
    )
    dm = DataManager()

    async def run() -> None:
        blocker = asyncio.create_task(asyncio.Event().wait())
        dm._cache_access_writer_task = blocker
        try:
            dm._enqueue_cache_access(CacheAccessEvent(
                key=SeriesKey("BTCUSDT", "1m"),
                action="history-query",
                source="test",
                occurred_at_ms=server_now_ms + 8 * 24 * 60 * 60 * 1000,
            ))
            dm._enqueue_cache_access(CacheAccessEvent(
                key=SeriesKey("BTCUSDT", "1m"),
                action="history-query",
                source="test",
                occurred_at_ms=server_now_ms,
            ))

            pending = list(dm._cache_access_pending.values())
            assert len(pending) == 1
            assert pending[0].count == 2
            assert pending[0].occurred_at_ms == server_now_ms
        finally:
            blocker.cancel()
            await asyncio.gather(blocker, return_exceptions=True)

    asyncio.run(run())


def test_cache_access_writer_flushes_on_fixed_cadence_under_continuous_signals(
    monkeypatch,
) -> None:
    dm = DataManager()
    flush_times: list[float] = []

    def fake_record_batch(events, *, refresh_heat=False) -> dict:
        flush_times.append(time.monotonic())
        return {}

    monkeypatch.setattr(dm.cache_behavior, "record_batch", fake_record_batch)

    async def run() -> float:
        dm._started = True
        dm._cache_access_loop = asyncio.get_running_loop()
        started_at = time.monotonic()
        for _ in range(14):
            dm.record_cache_access_deferred(
                "BTCUSDT",
                "1m",
                action="history-query",
                source="continuous-test",
            )
            await asyncio.sleep(0.05)
        dm._started = False
        dm._cache_access_stopping = True
        dm._cache_access_wakeup.set()
        if dm._cache_access_writer_task is not None:
            await dm._cache_access_writer_task
        return started_at

    started_at = asyncio.run(run())

    assert len(flush_times) >= 2
    assert flush_times[0] - started_at < 0.45


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


def test_auto_gc_policy_rejects_unsupported_automatic_vacuum(monkeypatch) -> None:
    with pytest.raises(ValueError, match="automatic SQLite VACUUM is unsupported"):
        AutoGcPolicy(sqlite_auto_vacuum=True)

    monkeypatch.setenv("CANDLESCOPE_AUTO_GC_SQLITE_VACUUM", "true")
    with pytest.raises(ValueError, match="automatic SQLite VACUUM is unsupported"):
        AutoGcPolicy.from_env()
    monkeypatch.delenv("CANDLESCOPE_AUTO_GC_SQLITE_VACUUM")
    with pytest.raises(ValueError, match="automatic SQLite VACUUM is unsupported"):
        AutoGcPolicy.from_mapping({"sqlite_auto_vacuum": True})

    policy = AutoGcPolicy()
    assert policy.to_dict()["sqlite_auto_vacuum_supported"] is False


def test_auto_gc_invalid_storage_delete_env_stays_fail_closed(monkeypatch) -> None:
    monkeypatch.setenv("CANDLESCOPE_AUTO_GC_STORAGE_DELETE_ENABLED", "fasle")

    policy = AutoGcPolicy.from_env()

    assert policy.sqlite_auto_delete_enabled is False


def test_storage_intent_registry_does_not_expose_guarded_records() -> None:
    key = SeriesKey("BTCUSDT", "1m")
    detail = {"scope": "original", "nested": {"owner": "input"}}
    registry = StorageIntentRegistry()

    returned = registry.register(
        key,
        source="test:mutable-alias",
        priority="weak",
        keep_rows=2,
        stream_required=False,
        detail=detail,
    )
    detail["scope"] = "input-mutated"
    detail["nested"]["owner"] = "input-mutated"
    returned.priority = "strong"
    returned.keep_rows = 50_000
    returned.stream_required = True
    returned.detail["scope"] = "return-mutated"
    returned.detail["nested"]["owner"] = "return-mutated"

    first_read = registry.match(key)[0]
    assert first_read.priority == "weak"
    assert first_read.keep_rows == 2
    assert first_read.stream_required is False
    assert first_read.detail == {"scope": "original", "nested": {"owner": "input"}}

    first_read.keep_rows = 99_999
    first_read.detail["scope"] = "match-mutated"
    first_read.detail["nested"]["owner"] = "match-mutated"
    second_read = registry.match(key)[0]
    assert second_read.keep_rows == 2
    assert second_read.detail == {"scope": "original", "nested": {"owner": "input"}}


def test_event_subscription_handle_is_immutable_and_copies_filters() -> None:
    dm = DataManager()
    key = SeriesKey("BTCUSDT", "1m")
    event_types = {DataEventType.BAR_CLOSED}

    async def _callback(_event) -> None:
        return None

    handle = dm.event_bus.subscribe(
        _callback,
        key=key,
        event_types=event_types,
    )
    event_types.add(DataEventType.BAR_UPDATED)

    assert handle.event_types == frozenset({DataEventType.BAR_CLOSED})
    assert dm.event_bus.get_all_subscribed_keys() == {key}
    with pytest.raises(FrozenInstanceError):
        handle.key = SeriesKey("ETHUSDT", "1m")
    with pytest.raises(AttributeError):
        handle.event_types.add(DataEventType.BAR_UPDATED)

    dm.event_bus.unsubscribe(handle)


def test_wildcard_observer_does_not_protect_every_gc_series() -> None:
    dm = DataManager()
    wildcard_key = SeriesKey("ETHUSDT", "1m")
    exact_key = SeriesKey("BTCUSDT", "1m")
    dm.cache.bulk_load(wildcard_key, _bars(5))
    dm.cache.bulk_load(exact_key, _bars(5))

    async def _callback(_event) -> None:
        return None

    wildcard = dm.event_bus.subscribe(
        _callback,
        event_types={DataEventType.BAR_CLOSED},
    )
    exact = dm.event_bus.subscribe(
        _callback,
        key=exact_key,
        event_types={DataEventType.BAR_CLOSED},
    )

    assert dm.event_bus.get_subscriber_count(exact_key) == 2
    assert dm.event_bus.get_direct_subscriber_count(exact_key) == 1
    assert dm.event_bus.get_subscriber_count(wildcard_key) == 1
    assert dm.event_bus.get_direct_subscriber_count(wildcard_key) == 0

    report = dm.plan_memory_gc({"cold_idle_seconds": 0})
    victim_keys = {item["key"] for item in report["victims"]}

    assert report["protected_count"] == 1
    assert str(wildcard_key) in victim_keys
    assert str(exact_key) not in victim_keys

    dm.event_bus.unsubscribe(exact)
    assert dm.event_bus.get_subscriber_count(exact_key) == 1
    assert dm.event_bus.get_direct_subscriber_count(exact_key) == 0
    dm.event_bus.unsubscribe(wildcard)


@pytest.mark.anyio
async def test_wildcard_observer_does_not_block_ephemeral_trim() -> None:
    dm = DataManager()
    key = SeriesKey("BTCUSDT", "1s")
    dm.cache.bulk_load(key, _bars(5))
    dm.cache.set_ephemeral_limit(2)

    async def _callback(_event) -> None:
        return None

    dm.event_bus.subscribe(
        _callback,
        event_types={DataEventType.BAR_CLOSED},
    )
    await dm.retention.run_ephemeral_trim()

    assert dm.cache.series_count(key) == 2
    await dm.event_bus.close()


def test_auto_gc_invalid_min_score_env_stays_conservative(monkeypatch) -> None:
    monkeypatch.setenv("CANDLESCOPE_AUTO_GC_MIN_SCORE", "nan")

    policy = AutoGcPolicy.from_env()

    assert policy.min_final_evict_score == 70
    with pytest.raises(ValueError, match="must be finite"):
        AutoGcPolicy(min_final_evict_score=float("nan"))


def test_auto_storage_plan_preserves_manual_vacuum_recommendation() -> None:
    filtered = filter_auto_storage_plan(
        {
            "mode": "dry-run",
            "watermarks": {"level": "high"},
            "vacuum_recommended": True,
            "series": [],
        },
        AutoGcPolicy(),
    )

    assert filtered["vacuum_recommended"] is True
    assert filtered["vacuum_recommended_now"] is False
    assert filtered["vacuum_recommended_after_delete"] is False
    assert filtered["sqlite_auto_vacuum_supported"] is False


def test_auto_memory_gc_hard_byte_limit_does_not_allow_oversized_first_victim() -> None:
    plan = {
        "mode": "dry-run",
        "victims": [{
            "key": "binance:spot:ETHUSDT:1m",
            "action": "delete-series",
            "would_free_bars": 100,
            "would_free_estimated_bytes": 1_000_000,
            "scores": {"finalEvictScore": 100},
        }],
    }

    filtered = filter_auto_memory_plan(
        plan,
        AutoGcPolicy(max_bytes_per_run=32_000, min_final_evict_score=70),
    )

    assert filtered["victims"] == []
    assert filtered["autoSkipped"] == [{
        "key": "binance:spot:ETHUSDT:1m",
        "reason": "per-run-limit",
        "score": 100.0,
    }]


def test_auto_memory_gc_hard_rss_uses_score_only_for_ordering() -> None:
    plan = {
        "mode": "dry-run",
        "pressure": {
            "over_total_bars": 0,
            "over_series": 0,
        },
        "runtimePressure": {
            "processMemory": {
                "available": True,
                "rss_bytes": 1024 * 1024 * 1024,
            },
        },
        "victims": [{
            "key": "binance:spot:ETHUSDT:1m",
            "action": "delete-series",
            "would_free_bars": 5_000,
            "would_free_estimated_bytes": 5_000 * 96,
            "last_access_ms": int(auto_gc_module.time.time() * 1000),
            "scores": {"finalEvictScore": 0},
        }],
    }

    filtered = filter_auto_memory_plan(plan, AutoGcPolicy())

    assert filtered["hardPressure"]["active"] is True
    assert filtered["hardPressure"]["rss_hard_pressure"] is True
    assert len(filtered["victims"]) == 1
    assert filtered["would_free_bars"] == 5_000


def test_auto_memory_gc_stops_after_required_bar_relief() -> None:
    plan = {
        "mode": "dry-run",
        "pressure": {
            "over_total_bars": 150,
            "over_series": 0,
        },
        "victims": [
            {
                "key": f"binance:spot:TEST{index}:1m",
                "action": "delete-series",
                "would_free_bars": 100,
                "would_free_estimated_bytes": 9_600,
                "scores": {"finalEvictScore": 0},
            }
            for index in range(3)
        ],
    }

    filtered = filter_auto_memory_plan(plan, AutoGcPolicy())

    assert len(filtered["victims"]) == 2
    assert filtered["would_free_bars"] == 200
    assert filtered["autoSkipped"][-1]["reason"] == "pressure-target-satisfied"


@pytest.mark.anyio
async def test_auto_gc_offloads_planning_and_audit(monkeypatch) -> None:
    calls: list[str] = []
    loop_calls: list[str] = []

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
        storage_file_snapshot = None

        def plan_memory_gc(self):
            loop_calls.append("plan_memory_gc")
            return {"mode": "dry-run", "victims": []}

        async def plan_storage_gc_async(self, *, file_snapshot=None):
            loop_calls.append("plan_storage_gc_async")
            self.storage_file_snapshot = file_snapshot
            return {"mode": "dry-run", "series": [], "watermarks": {"level": "normal"}}

        def plan_storage_gc(self, **_kwargs):
            raise AssertionError("async storage planner should be preferred")

    monkeypatch.setattr(auto_gc_module, "run_storage", fake_run_storage)

    report = await auto_gc_module.run_auto_gc_once(
        _Manager(),
        AutoGcPolicy(enabled=True, audit_path="unused.jsonl"),
    )

    assert report["status"] == "ok"
    assert calls == [
        "storage_file_snapshot",
        "append_auto_gc_audit",
    ]
    assert loop_calls == ["plan_memory_gc", "plan_storage_gc_async"]
    assert isinstance(report["storage_plan"]["storageFileSnapshot"], dict)
    assert report["storage_plan"]["storageFileSnapshot"]["path"]


@pytest.mark.anyio
async def test_auto_gc_collects_storage_plan_but_keeps_auto_delete_disabled(monkeypatch) -> None:
    maintenance_calls = 0

    async def fake_run_storage(func, *args, **kwargs):
        return func(*args, **kwargs)

    class _Maintenance:
        async def run_storage_gc(self, *args, **kwargs):
            nonlocal maintenance_calls
            maintenance_calls += 1
            return {"status": "ok", "deleted_rows": 1}

    class _Manager:
        maintenance = _Maintenance()

        def plan_memory_gc(self):
            return {"mode": "dry-run", "victims": []}

        def plan_storage_gc(self, *, file_snapshot=None):
            assert file_snapshot["physical_size_bytes"] == 900
            return {
                "mode": "dry-run",
                "watermarks": {"level": "over_budget"},
                "series": [{
                    "key": "binance:spot:ETHUSDT:1m",
                    "symbol": "ETHUSDT",
                    "interval": "1m",
                    "current_rows": 10,
                    "keep_rows": 5,
                    "would_delete_rows": 5,
                    "would_free_estimated_bytes": 500,
                    "risk_flags": [],
                    "scores": {"finalEvictScore": 100},
                }],
            }

    monkeypatch.setattr(auto_gc_module, "run_storage", fake_run_storage)
    monkeypatch.setattr(
        auto_gc_module,
        "storage_file_snapshot",
        lambda _path: {
            "path": "gc.sqlite",
            "physical_size_bytes": 900,
            "total_size_bytes": 900,
        },
    )
    monkeypatch.setattr(auto_gc_module, "append_auto_gc_audit", lambda *args, **kwargs: None)

    report = await auto_gc_module.run_auto_gc_once(
        _Manager(),
        AutoGcPolicy(enabled=True, min_final_evict_score=70),
    )

    assert maintenance_calls == 0
    assert report["storage_plan"]["victim_count"] == 1
    assert report["storage"]["status"] == "skipped"
    assert report["storage"]["reason"] == "storage-auto-delete-disabled"
    assert report["status"] == "constrained"
    assert {item["reason"] for item in report["constraints"]} == {
        "storage-auto-delete-disabled",
    }


@pytest.mark.anyio
async def test_auto_gc_reports_unavailable_storage_planner_as_partial(monkeypatch) -> None:
    async def fake_run_storage(func, *args, **kwargs):
        return func(*args, **kwargs)

    class _Manager:
        def plan_memory_gc(self):
            return {"mode": "dry-run", "victims": []}

        async def plan_storage_gc_async(self, *, file_snapshot=None):
            assert file_snapshot["path"] == "gc.sqlite"
            return {
                "mode": "dry-run",
                "available": False,
                "reason": "list-series-failed",
                "error": "database unavailable",
                "watermarks": {"level": "high"},
                "series": [],
            }

    monkeypatch.setattr(auto_gc_module, "run_storage", fake_run_storage)
    monkeypatch.setattr(
        auto_gc_module,
        "storage_file_snapshot",
        lambda _path: {"path": "gc.sqlite"},
    )
    monkeypatch.setattr(auto_gc_module, "append_auto_gc_audit", lambda *args, **kwargs: None)

    report = await auto_gc_module.run_auto_gc_once(_Manager(), AutoGcPolicy())

    assert report["status"] == "partial"
    assert report["storage"]["status"] == "blocked"
    assert report["storage"]["reason"] == "list-series-failed"
    assert report["storage"]["error"] == "database unavailable"
    assert report["constraints"] == [
        {
            "component": "storage",
            "reason": "list-series-failed",
        },
        {
            "component": "storage",
            "reason": "storage-execution-blocked",
        },
    ]


@pytest.mark.anyio
async def test_auto_gc_reports_unrelieved_hard_memory_pressure(monkeypatch) -> None:
    async def fake_run_storage(func, *args, **kwargs):
        return func(*args, **kwargs)

    class _Manager:
        def plan_memory_gc(self):
            return {
                "mode": "dry-run",
                "pressure": {"over_total_bars": 1, "over_series": 0},
                "victims": [],
            }

        async def plan_storage_gc_async(self, *, file_snapshot=None):
            return {
                "mode": "dry-run",
                "available": True,
                "watermarks": {"level": "normal"},
                "series": [],
            }

    monkeypatch.setattr(auto_gc_module, "run_storage", fake_run_storage)
    monkeypatch.setattr(
        auto_gc_module,
        "storage_file_snapshot",
        lambda _path: {"path": "gc.sqlite"},
    )
    monkeypatch.setattr(auto_gc_module, "append_auto_gc_audit", lambda *args, **kwargs: None)

    report = await auto_gc_module.run_auto_gc_once(_Manager(), AutoGcPolicy())

    assert report["status"] == "constrained"
    assert report["memory"]["status"] == "constrained"
    assert report["constraints"] == [{
        "component": "memory",
        "reason": "hard-memory-pressure-no-auto-eligible-victims",
    }]


@pytest.mark.anyio
async def test_auto_gc_treats_memory_safety_drift_as_constraint(monkeypatch) -> None:
    async def fake_run_storage(func, *args, **kwargs):
        return func(*args, **kwargs)

    class _Manager:
        def plan_memory_gc(self):
            return {
                "mode": "dry-run",
                "pressure": {"over_total_bars": 1, "over_series": 0},
                "victims": [{
                    "key": "binance:spot:BTCUSDT:1m",
                    "symbol": "BTCUSDT",
                    "interval": "1m",
                    "action": "delete-series",
                    "active": False,
                    "subscribed": False,
                    "would_free_bars": 1,
                    "would_free_estimated_bytes": 96,
                    "scores": {"finalEvictScore": 100},
                }],
            }

        async def plan_storage_gc_async(self, *, file_snapshot=None):
            return {
                "mode": "dry-run",
                "available": True,
                "watermarks": {"level": "normal"},
                "series": [],
            }

    def constrained_execute(_manager, plan):
        return {
            **plan,
            "mode": "execute",
            "status": "constrained",
            "removed_bars": 0,
            "skipped_count": 1,
            "results": [{"status": "stale"}],
        }

    monkeypatch.setattr(auto_gc_module, "run_storage", fake_run_storage)
    monkeypatch.setattr(
        auto_gc_module,
        "storage_file_snapshot",
        lambda _path: {"path": "gc.sqlite"},
    )
    monkeypatch.setattr(
        auto_gc_module,
        "execute_memory_gc_plan",
        constrained_execute,
    )
    monkeypatch.setattr(
        auto_gc_module,
        "append_auto_gc_audit",
        lambda *args, **kwargs: None,
    )

    report = await auto_gc_module.run_auto_gc_once(_Manager(), AutoGcPolicy())

    assert report["status"] == "constrained"
    assert report["constraints"] == [{
        "component": "memory",
        "reason": "memory-execution-stale",
    }]


@pytest.mark.anyio
async def test_auto_gc_can_checkpoint_without_enabling_storage_deletion(monkeypatch) -> None:
    executed_plan = None

    async def fake_run_storage(func, *args, **kwargs):
        return func(*args, **kwargs)

    class _Maintenance:
        async def run_storage_gc(self, *, plan, batch_size):
            nonlocal executed_plan
            del batch_size
            executed_plan = plan
            return {
                **plan,
                "mode": "execute",
                "status": "ok",
                "deleted_rows": 0,
                "affected_series": 0,
                "checkpoint_result": {"status": "ok"},
            }

    class _Manager:
        maintenance = _Maintenance()

        def plan_memory_gc(self):
            return {"mode": "dry-run", "victims": []}

        async def plan_storage_gc_async(self, *, file_snapshot=None):
            assert file_snapshot["path"] == "gc.sqlite"
            return {
                "mode": "dry-run",
                "checkpoint_recommended": True,
                "watermarks": {"level": "high"},
                "series": [{
                    "key": "binance:spot:ETHUSDT:1m",
                    "would_delete_rows": 5,
                    "would_free_estimated_bytes": 500,
                    "risk_flags": [],
                    "scores": {"finalEvictScore": 0},
                }],
            }

    monkeypatch.setattr(auto_gc_module, "run_storage", fake_run_storage)
    monkeypatch.setattr(
        auto_gc_module,
        "storage_file_snapshot",
        lambda _path: {"path": "gc.sqlite"},
    )
    monkeypatch.setattr(
        auto_gc_module,
        "append_auto_gc_audit",
        lambda *args, **kwargs: None,
    )

    report = await auto_gc_module.run_auto_gc_once(
        _Manager(),
        AutoGcPolicy(sqlite_auto_delete_enabled=False),
    )

    assert executed_plan is not None
    assert executed_plan["series"] == []
    assert executed_plan["checkpoint_only"] is True
    assert report["storage_plan"]["victim_count"] == 1
    assert report["storage"]["checkpoint_only"] is True
    assert report["storage"]["deleted_rows"] == 0
    assert report["storage"]["reason"] == "storage-auto-delete-disabled"
    assert report["status"] == "constrained"


@pytest.mark.anyio
async def test_auto_gc_surfaces_fresh_disk_constraint_from_execution_revalidation(
    monkeypatch,
) -> None:
    async def fake_run_storage(func, *args, **kwargs):
        return func(*args, **kwargs)

    class _Maintenance:
        async def run_storage_gc(self, *, plan, batch_size):
            del batch_size
            return {
                **plan,
                "mode": "execute",
                "status": "ok",
                "deleted_rows": 0,
                "affected_series": 0,
                "execution_revalidation": {
                    "status": "ok",
                    "adjusted": True,
                    "fresh_watermarks": {
                        "level": "critical",
                        "disk_free_critical": True,
                    },
                    "fresh_auto_skipped": [{
                        "key": "binance:spot:ETHUSDT:1m",
                        "reason": "disk-free-critical",
                    }],
                },
            }

    class _Manager:
        maintenance = _Maintenance()

        def plan_memory_gc(self):
            return {"mode": "dry-run", "victims": []}

        async def plan_storage_gc_async(self, *, file_snapshot=None):
            return {
                "mode": "dry-run",
                "available": True,
                "watermarks": {"level": "high"},
                "series": [{
                    "key": "binance:spot:ETHUSDT:1m",
                    "current_rows": 10,
                    "keep_rows": 5,
                    "would_delete_rows": 5,
                    "would_free_estimated_bytes": 500,
                    "risk_flags": [],
                    "scores": {"finalEvictScore": 100},
                }],
            }

    monkeypatch.setattr(auto_gc_module, "run_storage", fake_run_storage)
    monkeypatch.setattr(
        auto_gc_module,
        "storage_file_snapshot",
        lambda _path: {"path": "gc.sqlite"},
    )
    monkeypatch.setattr(
        auto_gc_module,
        "append_auto_gc_audit",
        lambda *args, **kwargs: None,
    )

    report = await auto_gc_module.run_auto_gc_once(
        _Manager(),
        AutoGcPolicy(sqlite_auto_delete_enabled=True),
    )

    assert report["status"] == "constrained"
    assert {item["reason"] for item in report["constraints"]} == {
        "disk-free-critical",
        "execution-revalidation-disk-free-critical",
    }


@pytest.mark.anyio
async def test_auto_gc_surfaces_storage_execution_reasons_and_errors(monkeypatch) -> None:
    async def fake_run_storage(func, *args, **kwargs):
        return func(*args, **kwargs)

    class _Maintenance:
        async def run_storage_gc(self, *, plan, batch_size):
            del batch_size
            return {
                **plan,
                "mode": "execute",
                "status": "partial",
                "reason": "row-delete-deferred",
                "stale_reason": "plan-expired-during-execution",
                "errors": [
                    "wal_checkpoint_truncate: checkpoint-busy",
                    "bounded delete exceeded declared deadline target",
                ],
                "deleted_rows": 0,
                "affected_series": 0,
            }

    class _Manager:
        maintenance = _Maintenance()

        def plan_memory_gc(self):
            return {"mode": "dry-run", "victims": []}

        async def plan_storage_gc_async(self, *, file_snapshot=None):
            return {
                "mode": "dry-run",
                "available": True,
                "watermarks": {"level": "high"},
                "series": [{
                    "key": "binance:spot:ETHUSDT:1m",
                    "current_rows": 10,
                    "keep_rows": 5,
                    "would_delete_rows": 5,
                    "would_free_estimated_bytes": 500,
                    "risk_flags": [],
                    "scores": {"finalEvictScore": 100},
                }],
            }

    monkeypatch.setattr(auto_gc_module, "run_storage", fake_run_storage)
    monkeypatch.setattr(
        auto_gc_module,
        "storage_file_snapshot",
        lambda _path: {"path": "gc.sqlite"},
    )
    monkeypatch.setattr(
        auto_gc_module,
        "append_auto_gc_audit",
        lambda *args, **kwargs: None,
    )

    report = await auto_gc_module.run_auto_gc_once(
        _Manager(),
        AutoGcPolicy(sqlite_auto_delete_enabled=True),
    )

    assert report["status"] == "partial"
    assert {item["reason"] for item in report["constraints"]} == {
        "row-delete-deferred",
        "plan-expired-during-execution",
        "wal_checkpoint_truncate: checkpoint-busy",
        "bounded delete exceeded declared deadline target",
        "storage-execution-partial",
    }


@pytest.mark.anyio
async def test_auto_gc_loop_survives_one_failed_pass(monkeypatch) -> None:
    run_count = 0
    sleep_count = 0

    async def fake_run_once(data_manager, policy):
        nonlocal run_count
        del data_manager, policy
        run_count += 1
        if run_count == 1:
            raise RuntimeError("transient planning failure")
        return {"mode": "auto-gc", "status": "ok"}

    async def fake_sleep(_seconds):
        nonlocal sleep_count
        sleep_count += 1
        if sleep_count >= 3:
            raise asyncio.CancelledError

    async def fake_run_storage(func, *args, **kwargs):
        return func(*args, **kwargs)

    class _Manager:
        pass

    manager = _Manager()
    monkeypatch.setattr(auto_gc_module, "run_auto_gc_once", fake_run_once)
    monkeypatch.setattr(auto_gc_module.asyncio, "sleep", fake_sleep)
    monkeypatch.setattr(auto_gc_module, "run_storage", fake_run_storage)
    monkeypatch.setattr(auto_gc_module, "append_auto_gc_audit", lambda *args, **kwargs: None)

    await auto_gc_module.auto_gc_loop(
        manager,
        AutoGcPolicy(enabled=True, audit_path="unused.jsonl"),
    )

    assert run_count == 2
    assert manager._auto_gc_last_report["status"] == "ok"
    assert manager._auto_gc_health["total_runs"] == 2
    assert manager._auto_gc_health["total_failures"] == 1
    assert manager._auto_gc_health["consecutive_failures"] == 0
    assert manager._auto_gc_health["status"] == "stopped"
    assert manager._auto_gc_health["task_alive"] is False


@pytest.mark.anyio
async def test_auto_gc_loop_marks_partial_report_as_failure(monkeypatch) -> None:
    sleep_count = 0

    async def fake_run_once(data_manager, policy):
        del data_manager, policy
        return {
            "mode": "auto-gc",
            "status": "partial",
            "storage": {"status": "error", "error": "checkpoint failed"},
        }

    async def fake_sleep(_seconds):
        nonlocal sleep_count
        sleep_count += 1
        if sleep_count >= 2:
            raise asyncio.CancelledError

    class _Manager:
        pass

    manager = _Manager()
    monkeypatch.setattr(auto_gc_module, "run_auto_gc_once", fake_run_once)
    monkeypatch.setattr(auto_gc_module.asyncio, "sleep", fake_sleep)

    await auto_gc_module.auto_gc_loop(manager, AutoGcPolicy(enabled=True))

    assert manager._auto_gc_health["total_runs"] == 1
    assert manager._auto_gc_health["total_failures"] == 1
    assert manager._auto_gc_health["consecutive_failures"] == 1
    assert manager._auto_gc_health["last_success_at_ms"] is None
    assert manager._auto_gc_health["last_error"] == "checkpoint failed"


@pytest.mark.anyio
async def test_auto_gc_loop_retains_storage_error_list_in_health(monkeypatch) -> None:
    sleep_count = 0

    async def fake_run_once(data_manager, policy):
        del data_manager, policy
        return {
            "mode": "auto-gc",
            "status": "partial",
            "storage": {
                "status": "partial",
                "reason": "row-delete-deferred",
                "errors": [
                    "checkpoint-busy",
                    "deadline target exceeded",
                ],
            },
            "constraints": [{
                "component": "storage",
                "reason": "storage-execution-partial",
            }],
        }

    async def fake_sleep(_seconds):
        nonlocal sleep_count
        sleep_count += 1
        if sleep_count >= 2:
            raise asyncio.CancelledError

    class _Manager:
        pass

    manager = _Manager()
    monkeypatch.setattr(auto_gc_module, "run_auto_gc_once", fake_run_once)
    monkeypatch.setattr(auto_gc_module.asyncio, "sleep", fake_sleep)

    await auto_gc_module.auto_gc_loop(manager, AutoGcPolicy(enabled=True))

    assert manager._auto_gc_health["total_failures"] == 1
    assert manager._auto_gc_health["last_error"] == (
        "checkpoint-busy; deadline target exceeded"
    )


@pytest.mark.anyio
async def test_auto_gc_loop_tracks_policy_constraints_without_counting_failure(monkeypatch) -> None:
    sleep_count = 0

    async def fake_run_once(data_manager, policy):
        del data_manager, policy
        return {
            "mode": "auto-gc",
            "status": "constrained",
            "constraints": [{
                "component": "storage",
                "reason": "storage-auto-delete-disabled",
            }],
        }

    async def fake_sleep(_seconds):
        nonlocal sleep_count
        sleep_count += 1
        if sleep_count >= 2:
            raise asyncio.CancelledError

    class _Manager:
        pass

    manager = _Manager()
    monkeypatch.setattr(auto_gc_module, "run_auto_gc_once", fake_run_once)
    monkeypatch.setattr(auto_gc_module.asyncio, "sleep", fake_sleep)

    await auto_gc_module.auto_gc_loop(manager, AutoGcPolicy(enabled=True))

    health = manager._auto_gc_health
    assert health["total_runs"] == 1
    assert health["total_constrained"] == 1
    assert health["total_failures"] == 0
    assert health["consecutive_failures"] == 0
    assert health["last_error"] is None
    assert health["last_constraint"] == "storage-auto-delete-disabled"
    assert health["last_constrained_at_ms"] is not None


def test_auto_gc_audit_rotates_with_bounded_backups(tmp_path) -> None:
    audit_path = tmp_path / "gc-audit.jsonl"
    policy = AutoGcPolicy(
        audit_path=audit_path,
        audit_max_bytes=1,
        audit_backup_count=3,
    )
    report = {
        "mode": "auto-gc",
        "status": "ok",
        "storage": {"checkpoint_only": True},
    }

    for _ in range(5):
        auto_gc_module.append_auto_gc_audit(report, policy)

    paths = [
        audit_path,
        audit_path.with_name(f"{audit_path.name}.1"),
        audit_path.with_name(f"{audit_path.name}.2"),
        audit_path.with_name(f"{audit_path.name}.3"),
    ]
    assert all(path.exists() for path in paths)
    assert not audit_path.with_name(f"{audit_path.name}.4").exists()
    for path in paths:
        record = json.loads(path.read_text(encoding="utf-8"))
        assert record["mode"] == "auto-gc"
        assert record["storage"]["checkpoint_only"] is True


def test_auto_gc_audit_rotation_failure_never_escapes(tmp_path, monkeypatch) -> None:
    audit_path = tmp_path / "gc-audit.jsonl"
    policy = AutoGcPolicy(
        audit_path=audit_path,
        audit_max_bytes=1,
        audit_backup_count=3,
    )
    report = {"mode": "auto-gc", "status": "ok"}
    auto_gc_module.append_auto_gc_audit(report, policy)

    def fail_rotation(*_args, **_kwargs):
        raise OSError("rotation failed")

    monkeypatch.setattr(auto_gc_module, "_rotate_auto_gc_audit", fail_rotation)
    auto_gc_module.append_auto_gc_audit(report, policy)

    assert audit_path.exists()


def test_runtime_pressure_helpers_are_structured(tmp_path) -> None:
    memory = process_memory_snapshot()
    disk = disk_pressure_snapshot(tmp_path)

    assert memory["available"] is True
    assert disk["available"] is True
    assert disk["total_bytes"] >= disk["free_bytes"]


def test_linux_memory_probe_uses_current_proc_rss(monkeypatch) -> None:
    monkeypatch.setattr(runtime_pressure_module.sys, "platform", "linux")
    monkeypatch.setattr(
        runtime_pressure_module.Path,
        "read_text",
        lambda _path, **_kwargs: "100 25 0 0 0 0 0",
    )
    monkeypatch.setattr(
        runtime_pressure_module.os,
        "sysconf",
        lambda _name: 4_096,
        raising=False,
    )

    memory = runtime_pressure_module._posix_process_memory()

    assert memory == {
        "available": True,
        "source": "linux./proc/self/statm",
        "rss_bytes": 25 * 4_096,
    }


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
