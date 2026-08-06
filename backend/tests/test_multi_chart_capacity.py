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


def test_exchange_ingestion_factory_snapshot_does_not_initialize_ingress() -> None:
    factory = ExchangeIngestionFactory()

    snapshot = factory.snapshot()

    assert snapshot == {
        "initialized": False,
        "failed_stream_stops": [],
        "ingress": None,
    }
