from __future__ import annotations

import sqlite3
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.data_engine.data_manager import capacity
from app.data_engine.ingestion.factory import ExchangeIngestionFactory


pytestmark = pytest.mark.anyio


class _Snapshot:
    def __init__(self, value):
        self.value = value

    def snapshot(self):
        return self.value


class _Backfill(_Snapshot):
    async def snapshot_async(self):
        return self.value


def _database(path: Path) -> None:
    with sqlite3.connect(path) as connection:
        connection.execute(
            "CREATE TABLE klines (exchange TEXT, market_type TEXT, symbol TEXT, "
            "interval TEXT, open_time INTEGER)"
        )
        connection.executemany(
            "INSERT INTO klines VALUES (?, ?, ?, ?, ?)",
            [
                ("binance", "spot", "BTCUSDT", "1m", 1_000),
                ("binance", "spot", "BTCUSDT", "1m", 2_000),
                ("binance", "spot", "ETHUSDT", "5m", 3_000),
            ],
        )


async def test_capacity_snapshot_aggregates_read_only_runtime_counts(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = tmp_path / "capacity.sqlite"
    _database(database)
    monkeypatch.setattr(capacity, "KLINES_DB_PATH", database)

    manager = _Snapshot({
        "coordinator": {
            "streams": [{"key": "a"}, {"key": "b"}],
        },
        "event_bus": {
            "callback_subscriptions": 3,
            "queue_subscriptions": 1,
            "direct_subscriptions_by_key": {"a": 2, "b": 1},
            "callback_lag": {
                "callback-a": {"queue_size": 2, "queue_max_size": 10},
                "callback-b": {"queue_size": 1, "queue_max_size": 10},
            },
            "queue_lag": {
                "iterator-a": {"queue_size": 4, "queue_max_size": 20},
            },
        },
        "cache": {"total_series": 2, "total_bars": 90},
    })
    ingress = _Snapshot({
        "initialized": True,
        "ingress": {
            "shared_ws": {"physical_websockets": 1},
            "pipelines": {
                "shared": {
                    "feed_control": {
                        "mode": "websocket",
                        "session": {"layer": "L2_SharedSession", "health": "connected"},
                    }
                },
                "direct": {
                    "feed_control": {
                        "mode": "websocket",
                        "session": {"layer": "L2_Session", "health": "connected"},
                    }
                },
            },
        },
    })
    state = SimpleNamespace(
        data_manager=manager,
        data_engine_runtime=SimpleNamespace(
            backfill_coordinator=_Backfill({
                "active": [{"request_id": "1"}],
                "pending": [{"request_id": "2"}],
                "running_chunks": 1,
                "ready_chunks": 2,
            }),
            ingestion_factory=ingress,
        ),
        indicator_engine=_Snapshot({"instance_count": 4, "stream_count": 3}),
        indicator_range_service=_Snapshot({"entries": 2}),
        indicator_runtime_service=_Snapshot({"started": True}),
        event_loop_lag_monitor=_Snapshot({"p99_ms": 4.5}),
    )

    snapshot = await capacity.build_capacity_snapshot(
        state,
        include_database_hash=True,
    )

    assert snapshot["schemaVersion"] == "candlescope.backend.capacity/1"
    assert snapshot["readOnly"] is True
    assert snapshot["ok"] is True
    assert snapshot["dataManager"]["activeSeries"] == 2
    assert snapshot["dataManager"]["streamLeases"] == 3
    assert snapshot["dataManager"]["logicalSubscribers"] == 4
    assert snapshot["dataManager"]["eventBus"]["callbackQueueDepth"] == 3
    assert snapshot["dataManager"]["eventBus"]["callbackQueueCapacity"] == 20
    assert snapshot["dataManager"]["eventBus"]["callbackQueueMaxDepth"] == 2
    assert snapshot["dataManager"]["eventBus"]["iteratorQueueDepth"] == 4
    assert snapshot["dataManager"]["eventBus"]["iteratorQueueCapacity"] == 20
    assert snapshot["exchange"]["physicalWebSockets"] == 2
    assert snapshot["backfill"]["activeRequests"] == 1
    assert snapshot["backfill"]["pendingRequests"] == 1
    assert snapshot["indicators"]["activeInstances"] == 4
    assert snapshot["database"]["state"] == "warm"
    assert snapshot["database"]["rowCount"] == 3
    assert snapshot["database"]["seriesCount"] == 2
    assert snapshot["database"]["sha256"].startswith("sha256:")


async def test_capacity_snapshot_is_fail_closed_when_components_are_absent(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    missing = tmp_path / "missing.sqlite"
    monkeypatch.setattr(capacity, "KLINES_DB_PATH", missing)

    snapshot = await capacity.build_capacity_snapshot(SimpleNamespace())

    assert snapshot["ok"] is True
    assert snapshot["dataManager"]["activeSeries"] == 0
    assert snapshot["exchange"]["physicalWebSockets"] == 0
    assert snapshot["database"]["state"] == "missing"


async def test_capacity_details_are_paged_and_capped_at_constant_bound(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(capacity, "KLINES_DB_PATH", tmp_path / "missing.sqlite")
    series_count = 180
    manager = _Snapshot({
        "coordinator": {
            "streams": [{"key": f"series-{index}"} for index in range(series_count)],
        },
        "event_bus": {
            "callback_subscriptions": series_count,
            "queue_subscriptions": 0,
            "direct_subscriptions_by_key": {
                f"series-{index}": 1 for index in range(series_count)
            },
        },
        "stream_leases": {
            "series_count": series_count,
            "consumer_claims": series_count,
            "unique_consumers": 64,
        },
        "cache": {"total_series": series_count, "total_bars": 10_000},
    })
    backfill = _Backfill({
        "active": [{"request_id": f"active-{index}"} for index in range(series_count)],
        "pending": [{"request_id": f"pending-{index}"} for index in range(series_count)],
        "deferred": [{"chunk_id": f"deferred-{index}"} for index in range(series_count)],
    })

    snapshot = await capacity.build_capacity_snapshot(
        SimpleNamespace(
            data_manager=manager,
            data_engine_runtime=SimpleNamespace(
                backfill_coordinator=backfill,
                ingestion_factory=None,
            ),
        ),
        detail_offset=10,
        detail_limit=999,
    )

    assert snapshot["detail"] == {"offset": 10, "limit": 100, "maxLimit": 100}
    assert snapshot["dataManager"]["activeSeries"] == series_count
    assert snapshot["dataManager"]["streamDetailTotal"] == series_count
    assert len(snapshot["dataManager"]["streams"]) == 100
    assert len(snapshot["dataManager"]["directSubscriptionsBySeries"]) == 100
    assert snapshot["backfill"]["detail"]["activeTotal"] == series_count
    assert len(snapshot["backfill"]["detail"]["active"]) == 100
    assert len(snapshot["backfill"]["detail"]["pending"]) == 100
    assert len(snapshot["backfill"]["detail"]["deferred"]) == 100


def test_multi_chart_capacity_environment_can_tighten_but_not_expand(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TEST_MULTI_CHART_LIMIT", "32")
    assert capacity.config._bounded_multi_chart_int(
        "TEST_MULTI_CHART_LIMIT", 64, 64
    ) == 32

    monkeypatch.setenv("TEST_MULTI_CHART_LIMIT", "65")
    with pytest.raises(ValueError, match="frozen safety limit 64"):
        capacity.config._bounded_multi_chart_int("TEST_MULTI_CHART_LIMIT", 64, 64)

    monkeypatch.setenv("TEST_MULTI_CHART_FLAG", "maybe")
    with pytest.raises(ValueError, match="must be one of"):
        capacity.config._strict_multi_chart_bool("TEST_MULTI_CHART_FLAG")


def test_exchange_ingestion_factory_snapshot_does_not_initialize_ingress() -> None:
    factory = ExchangeIngestionFactory()

    snapshot = factory.snapshot()

    assert snapshot == {
        "initialized": False,
        "failed_stream_stops": [],
        "ingress": None,
    }
