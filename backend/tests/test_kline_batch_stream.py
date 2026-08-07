from __future__ import annotations

import asyncio

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.stream import router as stream_router
from app.core import config
from app.data_engine.data_manager.models import (
    BarData,
    DataEvent,
    DataEventType,
    SeriesKey,
)
from app.data_engine.interval_resolution import (
    IntervalPurpose,
    IntervalResolutionError,
    IntervalResolutionErrorCode,
)


class _BatchDataManager:
    def __init__(
        self,
        *,
        fail_interval: str | None = None,
        emit: bool = False,
        ensure_delay: float = 0,
    ) -> None:
        self.fail_interval = fail_interval
        self.emit = emit
        self.ensure_delay = ensure_delay
        self.ensure_active = 0
        self.ensure_max_active = 0
        self.ensure_calls: list[dict] = []
        self.release_calls: list[dict] = []
        self.subscribe_calls: list[dict] = []
        self.unsubscribed: list[object] = []

    async def ensure_stream(self, symbol: str, interval: str, **kwargs):
        self.ensure_calls.append({"symbol": symbol, "interval": interval, **kwargs})
        self.ensure_active += 1
        self.ensure_max_active = max(self.ensure_max_active, self.ensure_active)
        try:
            if self.ensure_delay:
                await asyncio.sleep(self.ensure_delay)
            if interval == self.fail_interval:
                raise IntervalResolutionError(
                    IntervalResolutionErrorCode.NO_EXACT_BASE,
                    f"cannot reconstruct {interval}",
                    exchange=kwargs["exchange"],
                    market_type=kwargs["market_type"],
                    interval=interval,
                    purpose=IntervalPurpose.REALTIME,
                )
            return None
        finally:
            self.ensure_active -= 1

    async def release_stream(self, symbol: str, interval: str, **kwargs) -> None:
        self.release_calls.append({"symbol": symbol, "interval": interval, **kwargs})

    def subscribe(self, *, callback, symbol, interval, exchange, market_type, event_types):
        handle = object()
        self.subscribe_calls.append({
            "callback": callback,
            "symbol": symbol,
            "interval": interval,
            "exchange": exchange,
            "market_type": market_type,
            "event_types": event_types,
            "handle": handle,
        })
        if self.emit:
            async def _emit() -> None:
                await asyncio.sleep(0)
                await callback(DataEvent(
                    event_type=DataEventType.BAR_AMENDED,
                    key=SeriesKey(
                        symbol,
                        interval,
                        exchange=exchange,
                        market_type=market_type,
                    ),
                    bar=BarData(
                        time=1_700_000_000,
                        open=1,
                        high=2,
                        low=0.5,
                        close=1.5,
                        volume=10,
                    ),
                ))
            asyncio.create_task(_emit())
        return handle

    def unsubscribe(self, handle: object) -> None:
        self.unsubscribed.append(handle)


def _client(dm: _BatchDataManager) -> TestClient:
    app = FastAPI()
    app.include_router(stream_router, prefix="/api/v1")
    app.state.data_manager = dm
    return TestClient(app)


def _item(client_id: str, symbol: str, intervals: list[str]) -> dict:
    return {
        "clientId": client_id,
        "exchange": "binance",
        "marketType": "spot",
        "symbol": symbol,
        "intervals": intervals,
    }


def test_batch_endpoint_is_default_off(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(config, "KLINE_BATCH_STREAM_ENABLED", False)
    client = _client(_BatchDataManager())
    capabilities = client.get("/api/v1/stream/klines_batch/capabilities").json()
    assert capabilities == {
        "protocol": "candlescope.kline-batch/1",
        "enabled": False,
        "limits": {
            "maxSeriesPerClient": 64,
            "maxIntervalsPerSeries": 16,
            "maxTotalSubscriptions": 128,
            "outboxSize": 1024,
            "appMaxActiveSeries": 128,
        },
    }
    with client.websocket_connect(
        "/api/v1/stream/klines_batch"
    ) as ws:
        error = ws.receive_json()
        assert error["code"] == "kline_batch_disabled"
        assert error["protocol"] == "candlescope.kline-batch/1"


def test_batch_subscribe_is_idempotent_and_forwards_amendment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(config, "KLINE_BATCH_STREAM_ENABLED", True)
    dm = _BatchDataManager(emit=True)
    client = _client(dm)
    with client.websocket_connect("/api/v1/stream/klines_batch") as ws:
        connected = ws.receive_json()
        assert connected["type"] == "connected"
        assert connected["capabilities"]["maxSeriesPerClient"] == 64

        command = {
            "action": "subscribe",
            "request_id": "batch-1",
            "items": [_item("cell-1", "BTCUSDT", ["1m"])],
        }
        ws.send_json(command)
        ack = ws.receive_json()
        event = ws.receive_json()
        assert ack == {
            "type": "subscription_ack",
            "protocol": "candlescope.kline-batch/1",
            "action": "subscribe",
            "ok": True,
            "status": "ok",
            "client_id": "cell-1",
            "exchange": "binance",
            "market_type": "spot",
            "symbol": "BTCUSDT",
            "active_intervals": ["1m"],
            "failed": [],
            "request_id": "batch-1",
            "item_index": 0,
        }
        assert event["type"] == "kline"
        assert event["client_id"] == "cell-1"
        assert event["event_type"] == "bar.amended"
        assert event["data"]["is_closed"] is True

        diagnostics = client.app.state.kline_batch_registry.snapshot(limit=10)
        assert diagnostics["connections"][0]["sent_by_type"]["bar.amended"] == 1
        assert diagnostics["connections"][0]["sent_by_type"]["subscription_ack"] == 1
        assert diagnostics["sent_by_type"]["bar.amended"] == 1

        ws.send_json({**command, "request_id": "batch-2"})
        replay_ack = ws.receive_json()
        assert replay_ack["ok"] is True
        assert replay_ack["active_intervals"] == ["1m"]

    assert len(dm.ensure_calls) == 1
    assert len(dm.subscribe_calls) == 1
    assert len(dm.release_calls) == 1
    assert dm.release_calls[0]["consumer_id"] == dm.ensure_calls[0]["consumer_id"]
    retained = client.app.state.kline_batch_registry.snapshot(limit=10)
    assert retained["websocket_connections"] == 0
    assert retained["sent_by_type"]["bar.amended"] == 1


def test_batch_partial_failure_and_item_ack_are_isolated(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(config, "KLINE_BATCH_STREAM_ENABLED", True)
    dm = _BatchDataManager(fail_interval="7s")
    client = _client(dm)
    with client.websocket_connect("/api/v1/stream/klines_batch") as ws:
        ws.receive_json()
        ws.send_json({
            "action": "subscribe",
            "request_id": "mixed",
            "items": [
                _item("cell-1", "BTCUSDT", ["7s", "1m"]),
                _item("cell-2", "ETHUSDT", ["5m"]),
            ],
        })
        first = ws.receive_json()
        second = ws.receive_json()
        diagnostics = client.app.state.kline_batch_registry.snapshot(limit=10)
        connection = diagnostics["connections"][0]
        assert connection["interval_failures"] == 1
        assert connection["recent_failures"] == [{
            "action": "subscribe",
            "client_id": "cell-1",
            "interval": "7s",
            "code": "no_exact_base",
            "message": "cannot reconstruct 7s",
        }]
        assert connection["subscriptions_by_client"]["cell-2"] == {
            "exchange": "binance",
            "market_type": "spot",
            "symbol": "ETHUSDT",
            "intervals": ["5m"],
        }

    assert first["status"] == "partial"
    assert first["active_intervals"] == ["1m"]
    assert first["failed"] == [{
        "interval": "7s",
        "code": "no_exact_base",
        "message": "cannot reconstruct 7s",
    }]
    assert second["status"] == "ok"
    assert second["client_id"] == "cell-2"
    assert second["active_intervals"] == ["5m"]
    assert {call["symbol"] for call in dm.ensure_calls} == {"BTCUSDT", "ETHUSDT"}


def test_batch_initial_subscribe_admits_upstream_streams_in_bounded_groups(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(config, "KLINE_BATCH_STREAM_ENABLED", True)
    dm = _BatchDataManager(ensure_delay=0.02)
    items = [
        _item(f"cell-{index}", f"ASSET{index}USDT", ["1m"])
        for index in range(9)
    ]

    with _client(dm).websocket_connect("/api/v1/stream/klines_batch") as ws:
        ws.receive_json()
        ws.send_json({"action": "subscribe", "request_id": "bounded", "items": items})
        acknowledgements = [ws.receive_json() for _index in items]

    assert [ack["item_index"] for ack in acknowledgements] == list(range(len(items)))
    assert all(ack["ok"] is True for ack in acknowledgements)
    assert dm.ensure_max_active == 4


def test_batch_update_and_unsubscribe_release_only_owned_intervals(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(config, "KLINE_BATCH_STREAM_ENABLED", True)
    dm = _BatchDataManager()
    with _client(dm).websocket_connect("/api/v1/stream/klines_batch") as ws:
        ws.receive_json()
        ws.send_json({
            "action": "subscribe",
            "items": [_item("cell-1", "BTCUSDT", ["1m", "5m"])],
        })
        assert ws.receive_json()["active_intervals"] == ["1m", "5m"]

        ws.send_json({
            "action": "update",
            "items": [_item("cell-1", "BTCUSDT", ["5m", "15m"])],
        })
        assert ws.receive_json()["active_intervals"] == ["15m", "5m"]

        ws.send_json({
            "action": "unsubscribe",
            "items": [{"clientId": "cell-1", "intervals": ["5m"]}],
        })
        assert ws.receive_json()["active_intervals"] == ["15m"]

    released = [call["interval"] for call in dm.release_calls]
    assert released.count("1m") == 1
    assert released.count("5m") == 1
    assert released.count("15m") == 1


def test_batch_capacity_rejects_new_items_without_disturbing_existing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(config, "KLINE_BATCH_STREAM_ENABLED", True)
    monkeypatch.setattr(config, "KLINE_BATCH_MAX_SERIES_PER_CLIENT", 1)
    monkeypatch.setattr(config, "KLINE_BATCH_MAX_TOTAL_SUBSCRIPTIONS", 1)
    dm = _BatchDataManager()
    with _client(dm).websocket_connect("/api/v1/stream/klines_batch") as ws:
        ws.receive_json()
        ws.send_json({
            "action": "subscribe",
            "items": [_item("cell-1", "BTCUSDT", ["1m"])],
        })
        assert ws.receive_json()["ok"] is True

        ws.send_json({
            "action": "subscribe",
            "items": [_item("cell-2", "ETHUSDT", ["1m"])],
        })
        rejected = ws.receive_json()
        assert rejected["ok"] is False
        assert rejected["code"] == "series_limit"

        ws.send_json({
            "action": "subscribe",
            "items": [_item("cell-1", "BTCUSDT", ["1m"])],
        })
        assert ws.receive_json()["active_intervals"] == ["1m"]

    assert [call["symbol"] for call in dm.ensure_calls] == ["BTCUSDT"]


def test_batch_default_64_series_boundary_rejects_only_the_new_item(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(config, "KLINE_BATCH_STREAM_ENABLED", True)
    dm = _BatchDataManager()
    with _client(dm).websocket_connect("/api/v1/stream/klines_batch") as ws:
        ws.receive_json()
        items = [
            _item(f"cell-{index:02d}", f"ASSET{index:02d}USDT", ["1m"])
            for index in range(64)
        ]
        ws.send_json({"action": "subscribe", "items": items})
        assert all(ws.receive_json()["ok"] is True for _index in range(64))

        ws.send_json({
            "action": "subscribe",
            "items": [_item("cell-overflow", "OVERFLOWUSDT", ["1m"])],
        })
        rejected = ws.receive_json()
        assert rejected["code"] == "series_limit"

        ws.send_json({"action": "subscribe", "items": [items[0]]})
        assert ws.receive_json()["active_intervals"] == ["1m"]

    assert len(dm.ensure_calls) == 64


def test_batch_default_128_logical_subscription_boundary_is_fail_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(config, "KLINE_BATCH_STREAM_ENABLED", True)
    dm = _BatchDataManager()
    intervals = [f"{index}m" for index in range(1, 17)]
    with _client(dm).websocket_connect("/api/v1/stream/klines_batch") as ws:
        ws.receive_json()
        ws.send_json({
            "action": "subscribe",
            "items": [
                _item(f"cell-{index}", f"ASSET{index}USDT", intervals)
                for index in range(9)
            ],
        })
        accepted = [ws.receive_json() for _index in range(8)]
        rejected = ws.receive_json()

        assert all(item["ok"] is True for item in accepted)
        assert rejected["ok"] is False
        assert rejected["code"] == "total_subscription_limit"
        assert len(dm.ensure_calls) == 128
