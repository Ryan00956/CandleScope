from __future__ import annotations

import pytest

from app.data_engine.data_manager import BarData, DataManager, SeriesKey
from app.data_engine.data_manager.auto_gc import AutoGcPolicy, filter_auto_storage_plan


class _Storage:
    def __init__(self) -> None:
        self.delete_called = False

    def list_series(self):
        return [
            {
                "exchange": "binance",
                "market_type": "spot",
                "symbol": "ETHUSDT",
                "interval": "1m",
                "earliest_open_time": 1_000,
                "latest_open_time": 10_000,
                "total_count": 10,
            },
            {
                "exchange": "binance",
                "market_type": "spot",
                "symbol": "BTCUSDT",
                "interval": "1m",
                "earliest_open_time": 1_000,
                "latest_open_time": 5_000,
                "total_count": 5,
            },
            {
                "exchange": "binance",
                "market_type": "spot",
                "symbol": "SOLUSDT",
                "interval": "1d",
                "earliest_open_time": 1_000,
                "latest_open_time": 2_000,
                "total_count": 2,
            },
        ]

    def delete_oldest(self, *args, **kwargs):
        self.delete_called = True
        raise AssertionError("dry-run must not delete storage rows")


def test_storage_gc_dry_run_uses_retention_limits_without_deleting() -> None:
    storage = _Storage()
    dm = DataManager()
    dm.set_storage(storage)
    dm.update_retention_limits(
        db_limits={"minutes": 3, "hours": 0, "daily": 0},
        storage_row_limits_enabled=True,
    )

    report = dm.plan_storage_gc(file_snapshot={
        "db_size_bytes": 900,
        "wal_size_bytes": 100,
        "total_size_bytes": 1_000,
    })

    assert report["mode"] == "dry-run"
    assert report["owner"] == "sqlite-storage"
    assert report["would_delete_rows"] == 9
    assert report["victim_count"] == 2
    assert [row["symbol"] for row in report["series"]] == ["ETHUSDT", "BTCUSDT"]
    assert report["series"][0]["keep_rows"] == 3
    assert report["series"][0]["would_delete_rows"] == 7
    assert not storage.delete_called


def test_storage_gc_dry_run_marks_active_or_subscribed_risk() -> None:
    storage = _Storage()
    dm = DataManager()
    dm.set_storage(storage)
    dm.update_retention_limits(db_limits={"minutes": 3}, storage_row_limits_enabled=True)
    dm._register_stream_leases(
        (SeriesKey("BTCUSDT", "1m"),),
        consumer_id="watchlist:full:test",
    )

    report = dm.plan_storage_gc()
    btc = next(row for row in report["series"] if row["symbol"] == "BTCUSDT")

    assert "active-or-subscribed" in btc["risk_flags"]


def test_storage_gc_respects_watchlist_storage_intent() -> None:
    storage = _Storage()
    dm = DataManager()
    dm.set_storage(storage)
    dm.update_retention_limits(db_limits={"minutes": 3}, storage_row_limits_enabled=True)
    dm.register_storage_intent(
        "BTCUSDT",
        "*",
        source="watchlist:spot:BTCUSDT",
        priority="weak",
    )

    report = dm.plan_storage_gc()

    assert report["storage_intents"]["intent_count"] == 1
    assert [row["symbol"] for row in report["series"]] == ["ETHUSDT"]


def test_storage_gc_marks_explicit_storage_intent_risk() -> None:
    storage = _Storage()
    dm = DataManager()
    dm.set_storage(storage)
    dm.update_retention_limits(db_limits={"minutes": 3}, storage_row_limits_enabled=True)
    dm.register_storage_intent(
        "ETHUSDT",
        "1m",
        source="alert:rule:a",
        priority="weak",
        keep_rows=4,
    )

    report = dm.plan_storage_gc()
    eth = next(row for row in report["series"] if row["symbol"] == "ETHUSDT")

    assert eth["base_keep_rows"] == 3
    assert eth["keep_rows"] == 4
    assert eth["would_delete_rows"] == 6
    assert "storage-intent" in eth["risk_flags"]
    assert eth["storage_intents"][0]["source"] == "alert:rule:a"


def test_storage_gc_smart_plan_includes_watermarks_and_scores() -> None:
    storage = _Storage()
    dm = DataManager()
    dm.set_storage(storage)
    dm.update_retention_limits(db_limits={"minutes": 3}, storage_row_limits_enabled=True)

    report = dm.plan_storage_gc(file_snapshot={
        "db_size_bytes": 900,
        "wal_size_bytes": 100,
        "total_size_bytes": 1_000,
        "path": ".",
    })

    assert report["scoringVersion"] == 1
    assert report["watermarks"]["sqlite_total_bytes"] == 1_000
    assert "scores" in report["series"][0]
    assert "restoreCostReason" in report["series"][0]
    assert "reuseReason" in report["series"][0]


def test_storage_gc_budget_pressure_creates_victims_without_row_limits() -> None:
    storage = _Storage()
    dm = DataManager()
    dm.set_storage(storage)
    dm.update_retention_limits(sqlite_budget_bytes=900, storage_row_limits_enabled=False)

    report = dm.plan_storage_gc(file_snapshot={
        "db_size_bytes": 900,
        "wal_size_bytes": 100,
        "total_size_bytes": 1_000,
    })

    assert report["watermarks"]["level"] == "over_budget"
    assert report["policy"]["storage_row_limits_enabled"] is False
    assert report["would_delete_rows"] > 0
    assert report["series"][0]["reason"] == "sqlite-budget-pressure"
    assert report["series"][0]["scores"]["pressureScore"] == 100.0


def test_storage_gc_reports_budget_gap_when_auto_protected_data_blocks_target() -> None:
    storage = _Storage()
    dm = DataManager()
    dm.set_storage(storage)
    dm.update_retention_limits(sqlite_budget_bytes=900, storage_row_limits_enabled=False)
    dm._register_stream_leases(
        (SeriesKey("ETHUSDT", "1m"), SeriesKey("BTCUSDT", "1m")),
        consumer_id="watchlist:full:test",
    )

    report = dm.plan_storage_gc(file_snapshot={
        "db_size_bytes": 900,
        "wal_size_bytes": 100,
        "total_size_bytes": 1_000,
    })

    assert report["unable_to_reach_budget"] is True
    assert report["budget_gap_bytes"] > 0


def test_auto_storage_gc_requires_high_watermark_and_skips_intents() -> None:
    policy = AutoGcPolicy(min_final_evict_score=70)
    base_series = [
        {
            "key": "binance:spot:ETHUSDT:1m",
            "symbol": "ETHUSDT",
            "interval": "1m",
            "would_delete_rows": 100,
            "would_free_estimated_bytes": 1_000,
            "risk_flags": [],
            "scores": {"finalEvictScore": 90},
        },
        {
            "key": "binance:spot:BTCUSDT:1m",
            "symbol": "BTCUSDT",
            "interval": "1m",
            "would_delete_rows": 100,
            "would_free_estimated_bytes": 1_000,
            "risk_flags": ["storage-intent"],
            "scores": {"finalEvictScore": 95},
        },
    ]

    normal = filter_auto_storage_plan(
        {"mode": "dry-run", "watermarks": {"level": "normal"}, "series": base_series},
        policy,
    )
    unconfigured = filter_auto_storage_plan(
        {"mode": "dry-run", "watermarks": {"level": "unconfigured"}, "series": base_series},
        policy,
    )
    high = filter_auto_storage_plan(
        {"mode": "dry-run", "watermarks": {"level": "high"}, "series": base_series},
        policy,
    )
    over_budget = filter_auto_storage_plan(
        {"mode": "dry-run", "watermarks": {"level": "over_budget"}, "series": base_series},
        policy,
    )

    assert normal["series"] == []
    assert normal["autoSkipped"][0]["reason"] == "watermark-normal"
    assert unconfigured["series"] == []
    assert unconfigured["autoSkipped"][0]["reason"] == "watermark-unconfigured"
    assert [item["symbol"] for item in high["series"]] == ["ETHUSDT"]
    assert high["autoSkipped"][0]["reason"] == "storage-intent"
    assert [item["symbol"] for item in over_budget["series"]] == ["ETHUSDT"]


class _MutableStorage:
    def __init__(self) -> None:
        self.counts = {"ETHUSDT": 10, "BTCUSDT": 5}
        self.batches: list[tuple[str, int]] = []
        self.checkpoint_called = False
        self.vacuum_called = False

    def list_series(self):
        return [
            {
                "exchange": "binance",
                "market_type": "spot",
                "symbol": symbol,
                "interval": "1m",
                "earliest_open_time": 1_000,
                "latest_open_time": 10_000,
                "total_count": count,
            }
            for symbol, count in self.counts.items()
        ]

    def delete_oldest_batch(
        self,
        *,
        symbol: str,
        interval: str,
        keep: int,
        batch_size: int,
        exchange: str,
        market_type: str,
    ) -> int:
        del interval, exchange, market_type
        removable = max(0, self.counts[symbol] - keep)
        deleted = min(batch_size, removable)
        self.counts[symbol] -= deleted
        self.batches.append((symbol, deleted))
        return deleted

    def wal_checkpoint_truncate(self) -> dict:
        self.checkpoint_called = True
        return {"mode": "TRUNCATE", "result": [0, 0, 0]}

    def vacuum(self) -> dict:
        self.vacuum_called = True
        return {"status": "ok"}


@pytest.mark.anyio
async def test_storage_gc_run_deletes_in_batches_and_invalidates_cache() -> None:
    storage = _MutableStorage()
    dm = DataManager()
    dm.set_storage(storage)
    dm.update_retention_limits(db_limits={"minutes": 3}, storage_row_limits_enabled=True)
    dm.cache.bulk_load(SeriesKey("ETHUSDT", "1m"), [
        BarData(time=index, open=1, high=1, low=1, close=1, volume=1)
        for index in range(2)
    ])

    report = await dm.run_storage_gc(batch_size=4)

    assert report["mode"] == "execute"
    assert report["deleted_rows"] == 9
    assert report["affected_series"] == 2
    assert storage.counts == {"ETHUSDT": 3, "BTCUSDT": 3}
    assert storage.batches == [("ETHUSDT", 4), ("ETHUSDT", 3), ("BTCUSDT", 2)]
    assert storage.checkpoint_called
    assert not dm.cache.has_series(SeriesKey("ETHUSDT", "1m"))


@pytest.mark.anyio
async def test_storage_vacuum_uses_maintenance_entrypoint() -> None:
    storage = _MutableStorage()
    dm = DataManager()
    dm.set_storage(storage)

    report = await dm.vacuum_storage()

    assert report["mode"] == "vacuum"
    assert report["status"] == "ok"
    assert storage.vacuum_called
