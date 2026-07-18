from __future__ import annotations

import sqlite3
import time

import pytest

from app.data_engine.data_manager import BarData, DataManager, SeriesKey
from app.data_engine.data_manager import runtime_pressure as runtime_pressure_module
from app.data_engine.data_manager.auto_gc import AutoGcPolicy, filter_auto_storage_plan
from app.data_engine.data_manager.runtime_pressure import (
    build_storage_watermarks,
    storage_file_snapshot,
)
from app.data_engine.storage import klines_repo


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


def test_gc_sqlite_delete_fails_fast_on_writer_contention(
    monkeypatch,
    tmp_path,
) -> None:
    db_path = tmp_path / "gc-busy.sqlite3"
    monkeypatch.setattr(klines_repo, "KLINES_DB_PATH", db_path)
    with sqlite3.connect(db_path) as conn:
        assert conn.execute("PRAGMA journal_mode=WAL").fetchone()[0] == "wal"
        conn.execute(
            "CREATE TABLE klines ("
            "exchange TEXT, market_type TEXT, symbol TEXT, interval TEXT, "
            "open_time INTEGER)"
        )
        conn.executemany(
            "INSERT INTO klines VALUES ('binance', 'spot', 'BTCUSDT', '1m', ?)",
            [(index,) for index in range(5)],
        )

    blocker = sqlite3.connect(db_path, timeout=1)
    try:
        blocker.execute("BEGIN IMMEDIATE")
        blocker.execute("UPDATE klines SET open_time = open_time WHERE open_time = 0")
        started = time.perf_counter()
        with pytest.raises(sqlite3.OperationalError):
            klines_repo.delete_oldest_klines_batch(
                "BTCUSDT",
                "1m",
                keep=1,
                batch_size=1,
            )
        assert time.perf_counter() - started < 1.0
    finally:
        blocker.rollback()
        blocker.close()
    with sqlite3.connect(db_path) as conn:
        assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"


def test_gc_wal_truncate_checkpoint_returns_busy_without_long_wait(
    monkeypatch,
    tmp_path,
) -> None:
    db_path = tmp_path / "gc-checkpoint-busy.sqlite3"
    monkeypatch.setattr(klines_repo, "KLINES_DB_PATH", db_path)
    writer = sqlite3.connect(db_path, timeout=1)
    reader = sqlite3.connect(db_path, timeout=1)
    try:
        assert writer.execute("PRAGMA journal_mode=WAL").fetchone()[0] == "wal"
        writer.execute("PRAGMA wal_autocheckpoint=0")
        writer.execute("CREATE TABLE sample (value INTEGER)")
        writer.execute("INSERT INTO sample VALUES (1)")
        writer.commit()

        reader.execute("BEGIN")
        assert reader.execute("SELECT COUNT(*) FROM sample").fetchone()[0] == 1
        writer.execute("INSERT INTO sample VALUES (2)")
        writer.commit()

        started = time.perf_counter()
        result = klines_repo.wal_checkpoint_truncate()

        assert time.perf_counter() - started < 1.0
        assert result["busy"] == 1
    finally:
        reader.rollback()
        reader.close()
        writer.close()


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
        "physical_size_bytes": 1_000,
        "total_size_bytes": 1_000,
        "page_metrics_available": True,
        "checkpoint_reclaimable_available": True,
        "checkpoint_reclaimable_bytes": 100,
        "logical_allocated_bytes": 900,
        "logical_used_bytes": 900,
    })

    assert report["mode"] == "dry-run"
    assert report["owner"] == "sqlite-storage"
    assert report["planner_version"] == 2
    assert report["expires_at_ms"] > report["generated_at_ms"]
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
        "physical_size_bytes": 1_000,
        "total_size_bytes": 1_000,
        "page_metrics_available": True,
        "checkpoint_reclaimable_available": True,
        "checkpoint_reclaimable_bytes": 100,
        "logical_allocated_bytes": 900,
        "logical_used_bytes": 900,
        "owner_attribution_available": True,
        "klines_managed_bytes": 900,
        "unmanaged_bytes": 0,
    })

    assert report["watermarks"]["level"] == "over_budget"
    assert report["policy"]["storage_row_limits_enabled"] is False
    assert report["would_delete_rows"] > 0
    assert report["series"][0]["reason"] == "sqlite-budget-required-relief"
    assert report["series"][0]["scores"]["pressureScore"] == 100.0


def test_storage_gc_budget_allocates_only_required_relief() -> None:
    storage = _Storage()
    dm = DataManager()
    dm.set_storage(storage)
    dm.update_retention_limits(sqlite_budget_bytes=1_000, storage_row_limits_enabled=False)

    report = dm.plan_storage_gc(file_snapshot={
        "db_size_bytes": 900,
        "wal_size_bytes": 0,
        "physical_size_bytes": 900,
        "total_size_bytes": 900,
        "page_metrics_available": True,
        "checkpoint_reclaimable_available": True,
        "checkpoint_reclaimable_bytes": 0,
        "logical_allocated_bytes": 900,
        "logical_used_bytes": 900,
        "owner_attribution_available": True,
        "klines_managed_bytes": 900,
        "unmanaged_bytes": 0,
    })

    # Target is 800 bytes, so 100 bytes of logical relief are needed.  With
    # 17 rows sharing 900 estimated bytes, two rows are sufficient.  The old
    # fixed-ratio planner deleted a percentage from every eligible series.
    assert report["watermarks"]["level"] == "high"
    assert report["required_logical_relief_bytes"] == 100
    assert report["would_delete_rows"] == 2
    assert report["would_free_estimated_bytes"] >= 100
    assert report["would_free_estimated_bytes"] < 160


def test_wal_only_pressure_requests_checkpoint_without_logical_deletion() -> None:
    watermarks = build_storage_watermarks(
        storage_files={
            "db_size_bytes": 700,
            "wal_size_bytes": 200,
            "physical_size_bytes": 900,
            "total_size_bytes": 900,
            "page_metrics_available": True,
            "checkpoint_reclaimable_available": True,
            "checkpoint_reclaimable_bytes": 200,
            "logical_allocated_bytes": 700,
            "logical_used_bytes": 700,
        },
        sqlite_budget_bytes=1_000,
    )

    assert watermarks["level"] == "high"
    assert watermarks["required_physical_relief_bytes"] == 100
    assert watermarks["checkpoint_relief_bytes"] == 100
    assert watermarks["required_logical_relief_bytes"] == 0
    assert watermarks["checkpoint_first"] is True


def test_wal_growth_is_not_counted_as_checkpoint_relief() -> None:
    watermarks = build_storage_watermarks(
        storage_files={
            "db_size_bytes": 700,
            "wal_size_bytes": 200,
            "physical_size_bytes": 900,
            "page_metrics_available": True,
            "checkpoint_reclaimable_available": True,
            # The WAL contains 150 bytes of newly allocated logical pages, so
            # checkpointing grows the main DB and only releases 50 bytes net.
            "logical_allocated_bytes": 850,
            "logical_used_bytes": 850,
            "checkpoint_reclaimable_bytes": 50,
        },
        sqlite_budget_bytes=1_000,
    )

    assert watermarks["required_physical_relief_bytes"] == 100
    assert watermarks["checkpoint_relief_bytes"] == 50
    assert watermarks["required_logical_relief_bytes"] == 50
    assert watermarks["physical_compaction_pending"] is True


def test_kline_relief_is_allowed_when_managed_bytes_can_reach_target() -> None:
    watermarks = build_storage_watermarks(
        storage_files={
            "db_size_bytes": 1_100,
            "wal_size_bytes": 0,
            "physical_size_bytes": 1_100,
            "page_metrics_available": True,
            "checkpoint_reclaimable_available": True,
            "checkpoint_reclaimable_bytes": 0,
            "logical_allocated_bytes": 1_100,
            "logical_used_bytes": 1_100,
            "owner_attribution_available": True,
            "klines_managed_bytes": 500,
            "unmanaged_bytes": 600,
        },
        # The 80% target is 1,000 bytes.  Although unmanaged bytes are the
        # majority, deleting 100 managed bytes can still reach the target.
        sqlite_budget_bytes=1_250,
    )

    assert watermarks["level"] == "high"
    assert watermarks["required_logical_relief_bytes"] == 100
    assert watermarks["klines_relief_insufficient"] is False
    assert watermarks["required_klines_relief_bytes"] == 100
    assert watermarks["owner_relief_gap_bytes"] == 0


def test_budget_gc_fails_closed_when_page_metrics_are_unavailable() -> None:
    watermarks = build_storage_watermarks(
        storage_files={
            "db_size_bytes": 900,
            "wal_size_bytes": 100,
            "physical_size_bytes": 1_000,
        },
        sqlite_budget_bytes=900,
    )

    assert watermarks["level"] == "over_budget"
    assert watermarks["relief_planning_available"] is False
    assert watermarks["planning_blocked_reason"] == "sqlite-page-metrics-unavailable"
    assert watermarks["required_logical_relief_bytes"] == 0


def test_budget_gc_fails_closed_when_owner_attribution_is_unavailable() -> None:
    storage = _Storage()
    dm = DataManager()
    dm.set_storage(storage)
    dm.update_retention_limits(
        sqlite_budget_bytes=1_000,
        storage_row_limits_enabled=False,
    )

    report = dm.plan_storage_gc(file_snapshot={
        "db_size_bytes": 900,
        "wal_size_bytes": 0,
        "physical_size_bytes": 900,
        "page_metrics_available": True,
        "checkpoint_reclaimable_available": True,
        "checkpoint_reclaimable_bytes": 0,
        "logical_allocated_bytes": 900,
        "logical_used_bytes": 900,
        "owner_attribution_available": False,
    })

    assert report["watermarks"]["level"] == "high"
    assert report["watermarks"]["owner_planning_blocked_reason"] == (
        "sqlite-owner-attribution-unavailable"
    )
    assert report["series"] == []
    assert report["unable_to_reach_budget"] is True
    assert report["budget_gap_bytes"] == 100


def test_storage_file_snapshot_separates_physical_and_logical_bytes(tmp_path) -> None:
    db_path = tmp_path / "gc.sqlite"
    with sqlite3.connect(db_path) as conn:
        conn.execute("CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT)")
        conn.executemany(
            "INSERT INTO sample(value) VALUES (?)",
            [("x" * 128,) for _ in range(200)],
        )
        conn.commit()
        conn.execute("DELETE FROM sample WHERE id <= 100")
        conn.commit()

    snapshot = storage_file_snapshot(db_path)

    assert snapshot["exists"] is True
    assert snapshot["file_set_stable"] is True
    assert snapshot["db_size_bytes"] > 0
    assert snapshot["physical_size_bytes"] == (
        snapshot["db_size_bytes"] + snapshot["wal_size_bytes"]
    )
    assert snapshot["total_size_bytes"] == (
        snapshot["physical_size_bytes"] + snapshot["shm_size_bytes"]
    )
    assert snapshot["page_metrics_available"] is True
    assert snapshot["checkpoint_reclaimable_available"] is True
    assert snapshot["logical_allocated_bytes"] == (
        snapshot["page_count"] * snapshot["page_size_bytes"]
    )
    assert snapshot["logical_used_bytes"] <= snapshot["db_size_bytes"]
    assert snapshot["reclaimable_bytes"] >= 0
    assert "owner_attribution_available" in snapshot
    if snapshot["owner_attribution_available"]:
        assert snapshot["klines_managed_bytes"] == 0
        assert snapshot["unmanaged_bytes"] > 0
    else:
        assert snapshot["owner_attribution_error"]


def test_budget_gc_fails_closed_when_file_set_changes_during_snapshot(
    tmp_path,
    monkeypatch,
) -> None:
    db_path = tmp_path / "moving.sqlite"
    with sqlite3.connect(db_path) as conn:
        conn.execute("CREATE TABLE klines (open_time INTEGER PRIMARY KEY)")
        conn.execute("INSERT INTO klines VALUES (1)")
        conn.commit()

    initial_size = db_path.stat().st_size
    observed_sizes = iter([
        initial_size,
        0,
        0,
        initial_size + 4096,
        0,
        0,
    ])
    monkeypatch.setattr(
        runtime_pressure_module,
        "_safe_file_size",
        lambda _path: next(observed_sizes),
    )

    snapshot = storage_file_snapshot(db_path)
    watermarks = build_storage_watermarks(
        storage_files=snapshot,
        sqlite_budget_bytes=max(1, snapshot["physical_size_bytes"]),
    )

    assert snapshot["file_set_stable"] is False
    assert watermarks["level"] == "over_budget"
    assert watermarks["relief_planning_available"] is False
    assert watermarks["planning_blocked_reason"] == (
        "sqlite-file-set-changed-during-snapshot"
    )
    assert watermarks["required_klines_relief_bytes"] == 0


def test_unmanaged_table_growth_does_not_create_kline_budget_victim(tmp_path) -> None:
    db_path = tmp_path / "shared.sqlite"
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "CREATE TABLE klines ("
            "symbol TEXT NOT NULL, interval TEXT NOT NULL, open_time INTEGER NOT NULL)"
        )
        conn.execute(
            "CREATE INDEX idx_klines_lookup "
            "ON klines(symbol, interval, open_time)"
        )
        conn.executemany(
            "INSERT INTO klines VALUES ('ETHUSDT', '1m', ?)",
            [(index,) for index in range(10)],
        )
        conn.execute(
            "CREATE TABLE unrelated_payloads (id INTEGER PRIMARY KEY, payload BLOB)"
        )
        conn.executemany(
            "INSERT INTO unrelated_payloads(payload) VALUES (?)",
            [(b"x" * 4096,) for _ in range(512)],
        )
        conn.commit()

    snapshot = storage_file_snapshot(db_path)
    if not snapshot["owner_attribution_available"]:
        # Some bundled SQLite builds omit SQLITE_ENABLE_DBSTAT_VTAB.  Exercise
        # the attributed policy branch with the page ownership that dbstat
        # would expose for this deliberately tiny klines table.
        managed_bytes = snapshot["page_size_bytes"] * 2
        snapshot = {
            **snapshot,
            "owner_attribution_available": True,
            "klines_managed_bytes": managed_bytes,
            "unmanaged_bytes": max(
                0,
                snapshot["logical_used_bytes"] - managed_bytes,
            ),
        }
    assert snapshot["unmanaged_bytes"] > snapshot["klines_managed_bytes"]

    storage = _Storage()
    dm = DataManager()
    dm.set_storage(storage)
    dm.update_retention_limits(
        sqlite_budget_bytes=max(1, snapshot["physical_size_bytes"] // 2),
        storage_row_limits_enabled=False,
    )

    report = dm.plan_storage_gc(file_snapshot=snapshot)

    assert report["watermarks"]["level"] == "over_budget"
    assert report["watermarks"]["unmanaged_pressure_dominant"] is True
    assert report["watermarks"]["owner_planning_blocked_reason"] == (
        "insufficient-klines-owned-bytes-for-target"
    )
    assert report["series"] == []
    assert report["unable_to_reach_budget"] is True
    assert report["budget_gap_bytes"] > 0


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
        "physical_size_bytes": 1_000,
        "total_size_bytes": 1_000,
        "page_metrics_available": True,
        "checkpoint_reclaimable_available": True,
        "checkpoint_reclaimable_bytes": 100,
        "logical_allocated_bytes": 900,
        "logical_used_bytes": 900,
        "owner_attribution_available": True,
        "klines_managed_bytes": 900,
        "unmanaged_bytes": 0,
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


def test_auto_storage_gc_truncates_first_victim_to_hard_byte_limit() -> None:
    plan = {
        "mode": "dry-run",
        "watermarks": {"level": "over_budget"},
        "series": [{
            "key": "binance:spot:ETHUSDT:1m",
            "symbol": "ETHUSDT",
            "interval": "1m",
            "current_rows": 1_000,
            "keep_rows": 0,
            "would_delete_rows": 1_000,
            "would_free_estimated_bytes": 1_000_000,
            "risk_flags": [],
            "scores": {"finalEvictScore": 100},
        }],
    }

    filtered = filter_auto_storage_plan(
        plan,
        AutoGcPolicy(max_bytes_per_run=32_000, min_final_evict_score=70),
    )

    assert filtered["victim_count"] == 1
    assert filtered["would_free_estimated_bytes"] <= 32_000
    assert filtered["series"][0]["would_delete_rows"] == 32
    assert filtered["series"][0]["keep_rows"] == 968
    assert filtered["series"][0]["auto_truncated_to_hard_limit"] is True


def test_auto_storage_gc_hard_pressure_does_not_veto_low_score() -> None:
    plan = {
        "mode": "dry-run",
        "watermarks": {
            "level": "critical",
            "owner_attribution_available": True,
        },
        "series": [{
            "key": "binance:spot:ETHUSDT:1m",
            "symbol": "ETHUSDT",
            "interval": "1m",
            "current_rows": 100,
            "keep_rows": 50,
            "would_delete_rows": 50,
            "would_free_estimated_bytes": 5_000,
            "risk_flags": [],
            "scores": {"finalEvictScore": 0},
        }],
    }

    filtered = filter_auto_storage_plan(plan, AutoGcPolicy())

    assert filtered["victim_count"] == 1
    assert filtered["series"][0]["symbol"] == "ETHUSDT"


def test_auto_storage_gc_blocks_delete_when_disk_free_is_critical() -> None:
    plan = {
        "mode": "dry-run",
        "watermarks": {
            "level": "critical",
            "disk_free_critical": True,
        },
        "series": [{
            "key": "binance:spot:ETHUSDT:1m",
            "symbol": "ETHUSDT",
            "interval": "1m",
            "current_rows": 100,
            "keep_rows": 50,
            "would_delete_rows": 50,
            "would_free_estimated_bytes": 5_000,
            "risk_flags": [],
            "scores": {"finalEvictScore": 100},
        }],
    }

    filtered = filter_auto_storage_plan(plan, AutoGcPolicy())

    assert filtered["series"] == []
    assert filtered["autoSkipped"][0]["reason"] == "disk-free-critical"


class _MutableStorage:
    storage_gc_delete_max_batch_rows = 1_000
    storage_gc_delete_deadline_ms = 50

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
