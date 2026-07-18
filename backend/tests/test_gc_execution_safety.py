from __future__ import annotations

import asyncio
import threading
import time

import pytest

from app.data_engine.data_manager import BarData, DataManager, SeriesKey
from app.data_engine.data_manager import cache as cache_module
from app.data_engine.data_manager import manager as manager_module
from app.data_engine.data_manager.auto_gc import AutoGcPolicy
from app.data_engine.data_manager.gc import (
    HARD_PROCESS_RSS_BYTES,
    execute_memory_gc_plan,
    plan_memory_gc,
)
from app.data_engine.data_manager.maintenance import MaintenanceService, _run_storage_batch


def _bars(count: int) -> list[BarData]:
    return [
        BarData(time=index, open=1, high=1, low=1, close=1, volume=1)
        for index in range(count)
    ]


def test_memory_gc_revalidates_new_lease_before_execute() -> None:
    dm = DataManager()
    key = SeriesKey("BTCUSDT", "1m")
    dm.cache.bulk_load(key, _bars(5))
    plan = dm.plan_memory_gc({"cold_idle_seconds": 0})

    dm._register_stream_leases((key,), consumer_id="test:late-lease")
    report = execute_memory_gc_plan(dm, plan)

    assert report["removed_bars"] == 0
    assert report["skipped_count"] == 1
    assert report["results"][0]["status"] == "protected-at-execute"
    assert dm.cache.series_count(key) == 5


def test_memory_gc_rejects_series_mutated_after_plan() -> None:
    dm = DataManager()
    key = SeriesKey("ETHUSDT", "1m")
    dm.cache.bulk_load(key, _bars(5))
    plan = dm.plan_memory_gc({"cold_idle_seconds": 0})

    dm.cache.append(key, BarData(time=5, open=1, high=1, low=1, close=1, volume=1))
    report = execute_memory_gc_plan(dm, plan)

    assert report["removed_bars"] == 0
    assert report["skipped_count"] == 1
    assert report["results"][0]["status"] == "stale"
    assert dm.cache.series_count(key) == 6


def test_memory_gc_rejects_series_read_after_plan_even_within_same_millisecond() -> None:
    dm = DataManager()
    key = SeriesKey("XRPUSDT", "1m")
    dm.cache.bulk_load(key, _bars(5))
    plan = dm.plan_memory_gc({"cold_idle_seconds": 0})

    assert dm.cache.get_bar_at(key, 2) is not None
    report = execute_memory_gc_plan(dm, plan)

    assert report["removed_bars"] == 0
    assert report["skipped_count"] == 1
    assert report["results"][0]["status"] == "stale"
    assert dm.cache.series_count(key) == 5


@pytest.mark.parametrize(
    ("interval", "policy", "expected_action"),
    [
        ("1m", {"cold_idle_seconds": 0}, "delete-series"),
        (
            "1s",
            {"cold_idle_seconds": 0, "ephemeral_keep_bars": 2},
            "trim-series",
        ),
    ],
)
def test_memory_gc_generation_rejects_same_millisecond_recreated_series(
    monkeypatch,
    interval: str,
    policy: dict,
    expected_action: str,
) -> None:
    dm = DataManager()
    key = SeriesKey("ADAUSDT", interval)
    monkeypatch.setattr(cache_module.time, "time", lambda: 1_234.567)
    dm.cache.bulk_load(key, _bars(5))
    plan = plan_memory_gc(
        dm,
        policy,
        behavior_heat={},
        runtime_pressure={},
    )
    assert plan["victims"][0]["action"] == expected_action
    old_generation = plan["victims"][0]["generation"]

    dm.cache.invalidate(key)
    dm.cache.bulk_load(key, _bars(5))
    new_generation = dm.cache.snapshot()["series"][str(key)]["generation"]
    assert new_generation > old_generation

    report = execute_memory_gc_plan(dm, plan)

    assert report["status"] == "constrained"
    assert report["removed_bars"] == 0
    assert report["results"][0]["status"] == "stale"
    assert dm.cache.series_count(key) == 5


@pytest.mark.anyio
async def test_async_memory_gc_prefetches_slow_inputs_off_event_loop(
    monkeypatch,
) -> None:
    dm = DataManager()
    loop_thread = threading.get_ident()
    heat_thread: list[int] = []
    planner_thread: list[int] = []
    original_planner = manager_module.plan_memory_gc

    def heat_map() -> dict:
        heat_thread.append(threading.get_ident())
        time.sleep(0.02)
        return {}

    def planner(*args, **kwargs):
        planner_thread.append(threading.get_ident())
        return original_planner(*args, **kwargs)

    monkeypatch.setattr(dm.cache_behavior, "heat_map", heat_map)
    monkeypatch.setattr(dm, "runtime_pressure_snapshot", lambda: {})
    monkeypatch.setattr(manager_module, "plan_memory_gc", planner)

    report = await dm.plan_memory_gc_async({"cold_idle_seconds": 0})

    assert report["mode"] == "dry-run"
    assert heat_thread and heat_thread[0] != loop_thread
    assert planner_thread == [loop_thread]


@pytest.mark.parametrize("action", ["delete-series", "trim-series"])
def test_memory_gc_fails_closed_without_conditional_cache_contract(
    action: str,
) -> None:
    class _UnsafeCache:
        def __init__(self) -> None:
            self.remove_called = False
            self.trim_called = False

        def remove_series(self, _key: SeriesKey) -> int:
            self.remove_called = True
            return 5

        def trim_series(self, _key: SeriesKey, _keep: int) -> int:
            self.trim_called = True
            return 3

    dm = DataManager()
    unsafe_cache = _UnsafeCache()
    dm.cache = unsafe_cache  # type: ignore[assignment]
    victim = {
        "symbol": "DOGEUSDT",
        "interval": "1s" if action == "trim-series" else "1m",
        "exchange": "binance",
        "market_type": "spot",
        "action": action,
        "keep_bars": 2,
        "generation": 1,
        "revision": 1,
        "access_revision": 0,
        "last_access_ms": 1,
    }

    report = execute_memory_gc_plan(dm, {"victims": [victim]})

    assert report["status"] == "partial"
    assert report["unsupported_count"] == 1
    assert report["results"][0]["status"] == "unsupported"
    assert unsafe_cache.remove_called is False
    assert unsafe_cache.trim_called is False


def test_memory_gc_hard_rss_admits_recent_unprotected_series() -> None:
    dm = DataManager()
    key = SeriesKey("SOLUSDT", "1m")
    dm.cache.bulk_load(key, _bars(5))

    plan = plan_memory_gc(
        dm,
        {
            "cold_idle_seconds": 60 * 60,
            "max_total_bars": 10_000,
            "max_series": 100,
        },
        runtime_pressure={
            "processMemory": {
                "available": True,
                "rss_bytes": HARD_PROCESS_RSS_BYTES,
            },
        },
    )

    assert plan["pressure"]["runtime_hard_pressure"] is True
    assert [victim["key"] for victim in plan["victims"]] == [str(key)]


@pytest.mark.parametrize("limit", [-1, 0, 1_000_001])
def test_ephemeral_cache_limit_rejects_unsafe_values(limit: int) -> None:
    dm = DataManager()
    with pytest.raises(ValueError, match="ephemeral cache limit"):
        dm.cache.set_ephemeral_limit(limit)


class _Storage:
    storage_gc_delete_max_batch_rows = 1_000
    storage_gc_delete_deadline_ms = 50

    def __init__(self) -> None:
        self.count = 10
        self.checkpoint_called = False

    def list_all_series(self) -> list[dict]:
        return [{
            "exchange": "binance",
            "market_type": "spot",
            "symbol": "BTCUSDT",
            "interval": "1m",
            "earliest_open_time": 1_000,
            "latest_open_time": 10_000,
            "total_count": self.count,
        }]

    def delete_oldest_batch(self, *, keep: int, batch_size: int, **_: object) -> int:
        removable = max(0, self.count - keep)
        deleted = min(removable, batch_size)
        self.count -= deleted
        return deleted

    def wal_checkpoint_truncate(self) -> dict:
        self.checkpoint_called = True
        return {"mode": "TRUNCATE", "busy": 0, "log": 0, "checkpointed": 0}


@pytest.mark.anyio
async def test_storage_gc_revalidates_new_lease_before_execute() -> None:
    storage = _Storage()
    dm = DataManager()
    dm.set_storage(storage)
    dm.update_retention_limits(db_limits={"minutes": 3}, storage_row_limits_enabled=True)
    plan = dm.plan_storage_gc()
    key = SeriesKey("BTCUSDT", "1m")

    dm._register_stream_leases((key,), consumer_id="test:late-storage-lease")
    report = await dm.maintenance.run_storage_gc(plan=plan, batch_size=2)

    assert report["status"] == "constrained"
    assert report["deleted_rows"] == 0
    assert report["results"][0]["status"] == "protected-at-execute"
    assert storage.count == 10


@pytest.mark.anyio
async def test_storage_gc_revalidates_new_strong_intent_before_execute() -> None:
    storage = _Storage()
    dm = DataManager()
    dm.set_storage(storage)
    dm.update_retention_limits(db_limits={"minutes": 3}, storage_row_limits_enabled=True)
    plan = dm.plan_storage_gc()

    dm.register_storage_intent(
        "BTCUSDT",
        "1m",
        source="test:late-intent",
        priority="strong",
    )
    report = await dm.maintenance.run_storage_gc(plan=plan, batch_size=2)

    assert report["status"] == "constrained"
    assert report["deleted_rows"] == 0
    assert report["results"][0]["status"] == "protected-at-execute"
    assert storage.count == 10


@pytest.mark.anyio
async def test_storage_gc_rejects_same_id_intent_upgraded_after_plan() -> None:
    storage = _Storage()
    dm = DataManager()
    dm.set_storage(storage)
    dm.update_retention_limits(db_limits={"minutes": 3}, storage_row_limits_enabled=True)
    dm.register_storage_intent(
        "BTCUSDT",
        "1m",
        source="test:same-id",
        priority="weak",
        keep_rows=2,
    )
    plan = dm.plan_storage_gc()
    assert plan["series"][0]["would_delete_rows"] == 7

    dm.register_storage_intent(
        "BTCUSDT",
        "1m",
        source="test:same-id",
        priority="strong",
        keep_rows=8,
        stream_required=True,
    )
    report = await dm.maintenance.run_storage_gc(plan=plan, batch_size=2)

    assert report["status"] == "constrained"
    assert report["deleted_rows"] == 0
    assert report["results"][0]["status"] == "protected-at-execute"
    assert "became stronger" in report["results"][0]["message"]
    assert storage.count == 10


def test_storage_delete_batch_linearizes_with_new_intent_registration() -> None:
    dm = DataManager()
    key = SeriesKey("BTCUSDT", "1m")
    delete_started = threading.Event()
    allow_delete = threading.Event()
    batch_result: dict = {}

    def blocking_delete(**_: object) -> int:
        delete_started.set()
        assert allow_delete.wait(timeout=2)
        return 2

    def run_batch() -> None:
        batch_result.update(dm._storage_gc_delete_batch(
            key=key,
            planned_intents=[],
            planned_keep_rows=3,
            delete_func=blocking_delete,
            delete_kwargs={},
        ))

    batch_thread = threading.Thread(target=run_batch)
    batch_thread.start()
    assert delete_started.wait(timeout=1)

    def register_and_load() -> None:
        dm.register_storage_intent(
            "BTCUSDT",
            "1m",
            source="test:during-batch",
            priority="strong",
            keep_rows=50_000,
            stream_required=True,
        )
        dm.cache.bulk_load(key, _bars(1))

    registration_thread = threading.Thread(target=register_and_load)
    registration_thread.start()
    time.sleep(0.02)
    assert registration_thread.is_alive()

    allow_delete.set()
    batch_thread.join(timeout=1)
    registration_thread.join(timeout=1)
    assert not batch_thread.is_alive()
    assert not registration_thread.is_alive()
    assert batch_result["deleted_rows"] == 2
    assert batch_result["cache_invalidated"] is True
    assert dm.cache.series_count(key) == 1

    next_result = dm._storage_gc_delete_batch(
        key=key,
        planned_intents=[],
        planned_keep_rows=3,
        delete_func=lambda **_: 2,
        delete_kwargs={},
    )
    assert next_result["deleted_rows"] == 0
    assert next_result["protection_reason"]
    assert dm.cache.series_count(key) == 1


def test_storage_delete_batch_rejects_expired_plan_at_final_authorization() -> None:
    dm = DataManager()
    delete_called = False

    def delete(**_: object) -> int:
        nonlocal delete_called
        delete_called = True
        return 1

    result = dm._storage_gc_delete_batch(
        key=SeriesKey("BTCUSDT", "1m"),
        planned_intents=[],
        planned_keep_rows=3,
        expires_at_ms=int(time.time() * 1000) - 1,
        delete_func=delete,
        delete_kwargs={"batch_size": 1},
    )

    assert result["deleted_rows"] == 0
    assert result["stale_reason"]
    assert delete_called is False


@pytest.mark.anyio
async def test_storage_gc_fails_closed_without_bounded_delete_support() -> None:
    class _LegacyStorage(_Storage):
        delete_oldest_batch = None

        def __init__(self) -> None:
            super().__init__()
            self.unbounded_delete_called = False

        def delete_oldest(self, **_: object) -> int:
            self.unbounded_delete_called = True
            return 7

    storage = _LegacyStorage()
    dm = DataManager()
    dm.set_storage(storage)
    report = await dm.maintenance.run_storage_gc(plan={
        "mode": "dry-run",
        "owner": "sqlite-storage",
        "series": [{
            "exchange": "binance",
            "market_type": "spot",
            "symbol": "BTCUSDT",
            "interval": "1m",
            "keep_rows": 3,
            "would_delete_rows": 7,
        }],
    }, batch_size=100_000)

    assert report["status"] == "partial"
    assert report["batch_size"] == 1_000
    assert report["deleted_rows"] == 0
    assert report["results"][0]["status"] == "unsupported"
    assert storage.unbounded_delete_called is False


@pytest.mark.anyio
async def test_storage_gc_rejects_undeclared_custom_delete_latency() -> None:
    class _UndeclaredStorage(_Storage):
        storage_gc_delete_max_batch_rows = 0
        storage_gc_delete_deadline_ms = 0

    storage = _UndeclaredStorage()
    dm = DataManager()
    dm.set_storage(storage)
    report = await dm.maintenance.run_storage_gc(plan={
        "mode": "dry-run",
        "owner": "sqlite-storage",
        "series": [{
            "exchange": "binance",
            "market_type": "spot",
            "symbol": "BTCUSDT",
            "interval": "1m",
            "keep_rows": 3,
            "would_delete_rows": 7,
        }],
    }, batch_size=2)

    assert report["status"] == "partial"
    assert report["deleted_rows"] == 0
    assert report["backend_delete_contract"]["supported"] is False
    assert report["results"][0]["status"] == "unsupported"
    assert storage.count == 10


@pytest.mark.anyio
async def test_storage_gc_fails_closed_without_guarded_delete_integration() -> None:
    storage = _Storage()

    async def noop_async(*_args, **_kwargs) -> None:
        return None

    maintenance = MaintenanceService(
        storage_provider=lambda: storage,
        aggregator_config_snapshot=lambda: {},
        cache_invalidator=lambda *_args, **_kwargs: None,
        bars_backfilled=noop_async,
        active_targets=lambda: [],
        seed_active_bar=noop_async,
    )
    report = await maintenance.run_storage_gc(plan={
        "mode": "dry-run",
        "owner": "sqlite-storage",
        "series": [{
            "exchange": "binance",
            "market_type": "spot",
            "symbol": "BTCUSDT",
            "interval": "1m",
            "keep_rows": 3,
            "would_delete_rows": 7,
        }],
    }, batch_size=2)

    assert report["status"] == "partial"
    assert report["deleted_rows"] == 0
    assert report["backend_delete_contract"]["ordering_guard_supported"] is False
    assert report["backend_delete_contract"]["supported"] is False
    assert report["results"][0]["status"] == "unsupported"
    assert storage.count == 10


@pytest.mark.anyio
async def test_storage_gc_stops_after_declared_deadline_target_is_exceeded() -> None:
    class _SlowDeclaredStorage(_Storage):
        storage_gc_delete_deadline_ms = 1

        def __init__(self) -> None:
            super().__init__()
            self.calls = 0

        def delete_oldest_batch(
            self,
            *,
            keep: int,
            batch_size: int,
            **kwargs: object,
        ) -> int:
            self.calls += 1
            time.sleep(0.03)
            return super().delete_oldest_batch(
                keep=keep,
                batch_size=batch_size,
                **kwargs,
            )

    storage = _SlowDeclaredStorage()
    dm = DataManager()
    dm.set_storage(storage)
    report = await dm.maintenance.run_storage_gc(plan={
        "mode": "dry-run",
        "owner": "sqlite-storage",
        "series": [{
            "exchange": "binance",
            "market_type": "spot",
            "symbol": "BTCUSDT",
            "interval": "1m",
            "keep_rows": 3,
            "would_delete_rows": 4,
        }],
    }, batch_size=2)

    assert report["status"] == "partial"
    assert report["deleted_rows"] == 2
    assert storage.count == 8
    assert storage.calls == 1
    assert report["backend_delete_contract"]["deadline_target_ms"] == 1
    assert report["backend_delete_contract"]["deadline_semantics"] == (
        "observable-target-not-hard-realtime-guarantee"
    )
    assert report["results"][0]["status"] == "error"
    assert "deadline target" in report["results"][0]["contract_error"]
    assert report["results"][0]["max_backend_delete_elapsed_ms"] > 1
    assert report["results"][0]["max_guard_hold_ms"] > 1


@pytest.mark.anyio
async def test_storage_deadline_excludes_guarded_cache_invalidation_delay() -> None:
    class _FastStorage(_Storage):
        storage_gc_delete_deadline_ms = 10

    storage = _FastStorage()
    dm = DataManager()
    dm.set_storage(storage)
    original_invalidate = dm.cache.invalidate

    def slow_invalidate(key: SeriesKey) -> None:
        time.sleep(0.03)
        original_invalidate(key)

    dm.cache.invalidate = slow_invalidate  # type: ignore[method-assign]
    report = await dm.maintenance.run_storage_gc(plan={
        "mode": "dry-run",
        "owner": "sqlite-storage",
        "series": [{
            "exchange": "binance",
            "market_type": "spot",
            "symbol": "BTCUSDT",
            "interval": "1m",
            "keep_rows": 9,
            "would_delete_rows": 1,
        }],
    }, batch_size=1)

    assert report["status"] == "ok"
    assert report["errors"] == []
    assert report["results"][0]["contract_error"] is None
    assert report["results"][0]["max_backend_delete_elapsed_ms"] < 10
    assert report["results"][0]["max_guard_hold_ms"] >= 20


@pytest.mark.anyio
async def test_storage_gc_accounts_each_committed_batch_before_later_failure() -> None:
    class _FailingSecondBatchStorage(_Storage):
        def __init__(self) -> None:
            super().__init__()
            self.calls = 0

        def delete_oldest_batch(self, *, keep: int, batch_size: int, **kwargs: object) -> int:
            self.calls += 1
            if self.calls == 2:
                raise RuntimeError("second batch failed")
            return super().delete_oldest_batch(
                keep=keep,
                batch_size=batch_size,
                **kwargs,
            )

    storage = _FailingSecondBatchStorage()
    dm = DataManager()
    dm.set_storage(storage)
    key = SeriesKey("BTCUSDT", "1m")
    dm.cache.bulk_load(key, _bars(2))
    report = await dm.maintenance.run_storage_gc(plan={
        "mode": "dry-run",
        "owner": "sqlite-storage",
        "series": [{
            "exchange": "binance",
            "market_type": "spot",
            "symbol": "BTCUSDT",
            "interval": "1m",
            "keep_rows": 3,
            "would_delete_rows": 7,
        }],
    }, batch_size=2)

    assert report["status"] == "partial"
    assert report["deleted_rows"] == 2
    assert report["affected_series"] == 1
    assert report["results"][0]["deleted_rows"] == 2
    assert report["results"][0]["status"] == "error"
    assert storage.count == 8
    assert not dm.cache.has_series(key)


@pytest.mark.anyio
async def test_storage_gc_reports_bounded_delete_contract_violation() -> None:
    class _OverDeletingStorage(_Storage):
        def delete_oldest_batch(self, *, batch_size: int, **_: object) -> int:
            deleted = batch_size + 1
            self.count -= deleted
            return deleted

    storage = _OverDeletingStorage()
    dm = DataManager()
    dm.set_storage(storage)
    report = await dm.maintenance.run_storage_gc(plan={
        "mode": "dry-run",
        "owner": "sqlite-storage",
        "series": [{
            "exchange": "binance",
            "market_type": "spot",
            "symbol": "BTCUSDT",
            "interval": "1m",
            "keep_rows": 3,
            "would_delete_rows": 7,
        }],
    }, batch_size=2)

    assert report["status"] == "partial"
    assert report["deleted_rows"] == 3
    assert report["results"][0]["status"] == "error"
    assert report["results"][0]["contract_error"]


@pytest.mark.anyio
async def test_budget_gc_revalidates_after_checkpoint_and_skips_resolved_pressure() -> None:
    storage = _Storage()
    dm = DataManager()
    dm.set_storage(storage)

    def resolved_replan(_plan: dict) -> dict:
        assert storage.checkpoint_called is True
        return {
            "available": True,
            "generated_at_ms": int(time.time() * 1000),
            "series": [],
            "watermarks": {"level": "normal"},
        }

    dm.maintenance._storage_gc_replanner = resolved_replan
    report = await dm.maintenance.run_storage_gc(plan={
        "mode": "dry-run",
        "owner": "sqlite-storage",
        "planner_version": 2,
        "checkpoint_recommended": True,
        "series": [{
            "exchange": "binance",
            "market_type": "spot",
            "symbol": "BTCUSDT",
            "interval": "1m",
            "current_rows": 10,
            "keep_rows": 3,
            "would_delete_rows": 7,
            "would_free_estimated_bytes": 700,
            "reason": "sqlite-budget-required-relief",
        }],
    }, batch_size=2)

    assert report["status"] == "ok"
    assert report["deleted_rows"] == 0
    assert report["execution_revalidation"]["authorized_victim_count"] == 0
    assert report["results"][0]["status"] == "adjusted-at-revalidation"
    assert storage.count == 10


@pytest.mark.anyio
async def test_budget_gc_intersects_confirmed_and_fresh_delete_limits() -> None:
    storage = _Storage()
    dm = DataManager()
    dm.set_storage(storage)
    dm.maintenance._storage_gc_replanner = lambda _plan: {
        "available": True,
        "generated_at_ms": int(time.time() * 1000),
        "series": [{
            "exchange": "binance",
            "market_type": "spot",
            "symbol": "BTCUSDT",
            "interval": "1m",
            "current_rows": 10,
            "keep_rows": 8,
            "would_delete_rows": 2,
            "would_free_estimated_bytes": 200,
            "reason": "minutes-tier-retention",
        }, {
            "exchange": "binance",
            "market_type": "spot",
            "symbol": "ETHUSDT",
            "interval": "1m",
            "current_rows": 100,
            "keep_rows": 1,
            "would_delete_rows": 99,
            "would_free_estimated_bytes": 9_900,
            "reason": "sqlite-budget-required-relief",
        }],
        "watermarks": {"level": "high"},
    }
    report = await dm.maintenance.run_storage_gc(plan={
        "mode": "dry-run",
        "owner": "sqlite-storage",
        "planner_version": 2,
        "series": [{
            "exchange": "binance",
            "market_type": "spot",
            "symbol": "BTCUSDT",
            "interval": "1m",
            "current_rows": 10,
            "keep_rows": 3,
            "would_delete_rows": 7,
            "would_free_estimated_bytes": 700,
            "reason": "minutes-tier-retention+sqlite-budget-required-relief",
        }],
    }, batch_size=10)

    assert report["status"] == "ok"
    assert report["deleted_rows"] == 2
    assert report["results"][0]["would_delete_rows"] == 2
    assert report["results"][0]["keep_rows"] == 8
    assert len(report["results"]) == 1
    assert storage.count == 8


@pytest.mark.parametrize(
    ("fresh_watermarks", "expected_reason"),
    [
        ({"level": "normal"}, "watermark-normal"),
        (
            {"level": "critical", "disk_free_critical": True},
            "disk-free-critical",
        ),
    ],
)
def test_auto_execution_replan_reapplies_original_auto_policy(
    monkeypatch,
    fresh_watermarks: dict,
    expected_reason: str,
) -> None:
    dm = DataManager()
    raw_fresh_plan = {
        "available": True,
        "mode": "dry-run",
        "generated_at_ms": int(time.time() * 1000),
        "watermarks": fresh_watermarks,
        "series": [{
            "exchange": "binance",
            "market_type": "spot",
            "symbol": "BTCUSDT",
            "interval": "1m",
            "current_rows": 10,
            "keep_rows": 8,
            "would_delete_rows": 2,
            "would_free_estimated_bytes": 200,
            "reason": "minutes-tier-retention",
            "risk_flags": [],
            "scores": {"finalEvictScore": 100},
        }],
    }
    monkeypatch.setattr(
        manager_module,
        "storage_file_snapshot",
        lambda _path: {"path": "test.sqlite3"},
    )
    monkeypatch.setattr(
        dm.retention,
        "plan_storage_gc",
        lambda **_kwargs: raw_fresh_plan,
    )
    monkeypatch.setattr(
        dm,
        "runtime_pressure_snapshot",
        lambda **_kwargs: {},
    )

    fresh = dm._storage_gc_replan_for_execution({
        "mode": "auto-plan",
        "generated_at_ms": 1,
        "scoringVersion": 1,
        "policy": {},
        "autoPolicy": AutoGcPolicy(
            sqlite_auto_delete_enabled=True,
        ).to_dict(),
    })

    assert fresh["mode"] == "auto-plan"
    assert fresh["series"] == []
    assert fresh["autoSkipped"][0]["reason"] == expected_reason


@pytest.mark.anyio
@pytest.mark.parametrize("fresh_watermarks", [
    {
        "level": "over_budget",
        "required_physical_relief_bytes": 100,
        "required_logical_relief_bytes": 0,
        "relief_planning_available": False,
    },
    {
        "level": "over_budget",
        "required_physical_relief_bytes": 100,
        "required_logical_relief_bytes": 100,
        "relief_planning_available": True,
        "klines_budget_planning_available": False,
    },
])
async def test_budget_gc_blocks_when_fresh_relief_math_is_unavailable(
    fresh_watermarks: dict,
) -> None:
    storage = _Storage()
    dm = DataManager()
    dm.set_storage(storage)
    dm.maintenance._storage_gc_replanner = lambda _plan: {
        "available": True,
        "series": [],
        "watermarks": fresh_watermarks,
    }
    report = await dm.maintenance.run_storage_gc(plan={
        "mode": "dry-run",
        "owner": "sqlite-storage",
        "planner_version": 2,
        "series": [{
            "exchange": "binance",
            "market_type": "spot",
            "symbol": "BTCUSDT",
            "interval": "1m",
            "current_rows": 10,
            "keep_rows": 3,
            "would_delete_rows": 7,
            "would_free_estimated_bytes": 700,
            "reason": "sqlite-budget-required-relief",
        }],
    }, batch_size=2)

    assert report["status"] == "blocked"
    assert report["deleted_rows"] == 0
    assert report["execution_revalidation"]["status"] == "blocked"
    assert storage.count == 10


@pytest.mark.anyio
async def test_budget_gc_blocks_when_execution_revalidation_is_unavailable() -> None:
    storage = _Storage()
    dm = DataManager()
    dm.set_storage(storage)
    dm.maintenance._storage_gc_replanner = lambda _plan: {
        "available": False,
        "reason": "sqlite-page-metrics-unavailable",
        "series": [],
    }
    report = await dm.maintenance.run_storage_gc(plan={
        "mode": "dry-run",
        "owner": "sqlite-storage",
        "planner_version": 2,
        "series": [{
            "exchange": "binance",
            "market_type": "spot",
            "symbol": "BTCUSDT",
            "interval": "1m",
            "current_rows": 10,
            "keep_rows": 3,
            "would_delete_rows": 7,
            "would_free_estimated_bytes": 700,
            "reason": "sqlite-budget-required-relief",
        }],
    }, batch_size=2)

    assert report["status"] == "blocked"
    assert report["deleted_rows"] == 0
    assert report["execution_revalidation"]["status"] == "blocked"
    assert storage.count == 10


@pytest.mark.anyio
async def test_storage_gc_cancellation_keeps_committed_batch_cache_coherent() -> None:
    class _BlockingStorage(_Storage):
        def __init__(self) -> None:
            super().__init__()
            self.started = threading.Event()
            self.release = threading.Event()

        def delete_oldest_batch(self, *, keep: int, batch_size: int, **kwargs: object) -> int:
            self.started.set()
            assert self.release.wait(timeout=2)
            return super().delete_oldest_batch(
                keep=keep,
                batch_size=batch_size,
                **kwargs,
            )

    storage = _BlockingStorage()
    dm = DataManager()
    dm.set_storage(storage)
    key = SeriesKey("BTCUSDT", "1m")
    dm.cache.bulk_load(key, _bars(2))
    task = asyncio.create_task(dm.maintenance.run_storage_gc(plan={
        "mode": "dry-run",
        "owner": "sqlite-storage",
        "series": [{
            "exchange": "binance",
            "market_type": "spot",
            "symbol": "BTCUSDT",
            "interval": "1m",
            "keep_rows": 3,
            "would_delete_rows": 2,
        }],
    }, batch_size=2))

    for _ in range(100):
        if storage.started.is_set():
            break
        await asyncio.sleep(0.01)
    assert storage.started.is_set()
    task.cancel()
    await asyncio.sleep(0)
    storage.release.set()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert storage.count == 8
    assert not dm.cache.has_series(key)


@pytest.mark.anyio
async def test_storage_gc_runs_checkpoint_without_row_victims() -> None:
    storage = _Storage()
    dm = DataManager()
    dm.set_storage(storage)

    report = await dm.maintenance.run_storage_gc(plan={
        "mode": "dry-run",
        "owner": "sqlite-storage",
        "checkpoint_recommended": True,
        "series": [],
    })

    assert report["status"] == "ok"
    assert report["deleted_rows"] == 0
    assert storage.checkpoint_called is True
    assert report["checkpoint_before_result"]["busy"] == 0


@pytest.mark.anyio
async def test_storage_gc_stops_before_deletion_when_checkpoint_is_busy() -> None:
    class _BusyStorage(_Storage):
        def wal_checkpoint_truncate(self) -> dict:
            self.checkpoint_called = True
            return {"mode": "TRUNCATE", "busy": 1, "log": 5, "checkpointed": 0}

    storage = _BusyStorage()
    dm = DataManager()
    dm.set_storage(storage)
    report = await dm.maintenance.run_storage_gc(plan={
        "mode": "dry-run",
        "owner": "sqlite-storage",
        "checkpoint_recommended": True,
        "series": [{
            "exchange": "binance",
            "market_type": "spot",
            "symbol": "BTCUSDT",
            "interval": "1m",
            "keep_rows": 3,
            "would_delete_rows": 7,
        }],
    })

    assert report["status"] == "blocked"
    assert report["deleted_rows"] == 0
    assert storage.count == 10


@pytest.mark.anyio
async def test_shutdown_cancellation_waits_for_current_storage_batch() -> None:
    started = threading.Event()
    release = threading.Event()

    def blocking_batch() -> int:
        started.set()
        assert release.wait(timeout=2)
        return 1

    task = asyncio.create_task(_run_storage_batch(blocking_batch))
    for _ in range(100):
        if started.is_set():
            break
        await asyncio.sleep(0.01)
    assert started.is_set()

    task.cancel()
    await asyncio.sleep(0)
    assert task.done() is False
    task.cancel()
    await asyncio.sleep(0)
    assert task.done() is False
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
