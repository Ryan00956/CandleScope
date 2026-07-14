from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.stream import router as stream_router
from app.data_engine.ingestion.models import DataSource
from app.data_engine.market_data.events import MarketStateEvent
from app.data_engine.market_data.hub import MarketEventHub
from app.data_engine.market_data.models import MarketStreamKey


class _MarketStreamDataManager:
    market_data_ready = True

    def __init__(self) -> None:
        self.hub = MarketEventHub()
        self.ensure_calls: list[tuple[MarketStreamKey, str]] = []
        self.release_calls: list[tuple[MarketStreamKey, str]] = []
        self._leases: set[tuple[MarketStreamKey, str]] = set()

    def subscribe_market(self, keys, *, max_pending: int, replay: bool):
        return self.hub.subscribe(keys, max_pending=max_pending, replay=replay)

    async def ensure_market_stream(self, key: MarketStreamKey, *, consumer_id: str) -> bool:
        lease = (key, consumer_id)
        if lease in self._leases:
            return False
        self._leases.add(lease)
        self.ensure_calls.append(lease)
        return True

    async def release_market_stream(self, key: MarketStreamKey, *, consumer_id: str) -> bool:
        lease = (key, consumer_id)
        if lease not in self._leases:
            return False
        self._leases.remove(lease)
        self.release_calls.append(lease)
        return True

    async def market_snapshot(self, keys, *, refresh_missing: bool):
        for offset, key in enumerate(keys, start=1):
            if self.hub.snapshot([key]):
                continue
            self.hub.publish(MarketStateEvent(
                key=key,
                event_time_ms=1_700_000_000_000 + offset,
                received_at_ms=1_700_000_000_100 + offset,
                source=DataSource.HTTP,
                data={key.channel.value: float(offset)},
            ))
        return self.hub.snapshot(keys)


def _client(data_manager: object | None = None) -> TestClient:
    app = FastAPI()
    app.include_router(stream_router, prefix="/api/v1")
    if data_manager is not None:
        app.state.data_manager = data_manager
    return TestClient(app)


def _stream(channel: str, symbol: str = "BTCUSDT") -> dict[str, str]:
    return {
        "exchange": "binance",
        "market_type": "futures",
        "symbol": symbol,
        "channel": channel,
    }


def test_market_ws_multiplexes_snapshot_update_and_unsubscribe() -> None:
    dm = _MarketStreamDataManager()
    client = _client(dm)
    streams = [_stream("mark_price"), _stream("open_interest")]

    with client.websocket_connect("/api/v1/stream/market") as ws:
        assert ws.receive_json() == {
            "type": "connected",
            "protocol": "market.v1",
            "max_subscriptions": 64,
        }
        ws.send_json({"action": "subscribe", "request_id": "s1", "streams": streams})
        subscribed = ws.receive_json()
        snapshot = ws.receive_json()
        update = ws.receive_json()

        assert subscribed["type"] == "subscribed"
        assert subscribed["request_id"] == "s1"
        assert snapshot["type"] == "snapshot"
        assert len(snapshot["data"]) == 2
        assert snapshot["missing"] == []
        assert update["type"] == "update"
        assert update["protocol"] == "market.v1"
        assert {item["channel"] for item in update["data"]} == {
            "mark_price",
            "open_interest",
        }

        ws.send_json({"action": "unsubscribe", "request_id": "u1", "streams": streams})
        unsubscribed = ws.receive_json()
        assert unsubscribed["type"] == "unsubscribed"
        assert unsubscribed["request_id"] == "u1"

    assert len(dm.ensure_calls) == 2
    assert len(dm.release_calls) == 2
    assert dm._leases == set()


def test_market_ws_duplicate_subscribe_is_idempotent_and_disconnect_releases() -> None:
    dm = _MarketStreamDataManager()
    client = _client(dm)
    command = {"action": "subscribe", "request_id": "s1", "streams": [_stream("basis")]}

    with client.websocket_connect("/api/v1/stream/market") as ws:
        assert ws.receive_json()["type"] == "connected"
        ws.send_json(command)
        assert ws.receive_json()["type"] == "subscribed"
        assert ws.receive_json()["type"] == "snapshot"
        assert ws.receive_json()["type"] == "update"

        command["request_id"] = "s2"
        ws.send_json(command)
        assert ws.receive_json()["type"] == "subscribed"
        assert ws.receive_json()["type"] == "snapshot"

    assert len(dm.ensure_calls) == 1
    assert len(dm.release_calls) == 1
    assert dm.ensure_calls[0] == dm.release_calls[0]


def test_market_ws_reports_invalid_streams_and_unready_runtime() -> None:
    dm = _MarketStreamDataManager()
    with _client(dm).websocket_connect("/api/v1/stream/market") as ws:
        assert ws.receive_json()["type"] == "connected"
        ws.send_json({"action": "subscribe", "request_id": "bad", "streams": []})
        assert ws.receive_json() == {
            "type": "error",
            "request_id": "bad",
            "code": "INVALID_STREAMS",
            "detail": "streams must be a non-empty list",
        }

    with _client().websocket_connect("/api/v1/stream/market") as ws:
        assert ws.receive_json()["code"] == "MARKET_STREAM_NOT_READY"


def test_market_ws_bounds_commands_rejects_params_and_cleans_empty_subscription() -> None:
    dm = _MarketStreamDataManager()
    with _client(dm).websocket_connect("/api/v1/stream/market") as ws:
        assert ws.receive_json()["type"] == "connected"

        ws.send_json([])
        assert ws.receive_json()["code"] == "INVALID_MESSAGE"

        stream_with_params = {**_stream("mark_price"), "params": {"alias": "one"}}
        ws.send_json({"action": "subscribe", "streams": [stream_with_params]})
        assert ws.receive_json()["code"] == "INVALID_STREAMS"

        ws.send_json({
            "action": "subscribe",
            "streams": [_stream("mark_price", f"SYM{index}") for index in range(65)],
        })
        bounded = ws.receive_json()
        assert bounded["code"] == "INVALID_STREAMS"
        assert "at most 64" in bounded["detail"]

    assert dm.hub.diagnostics()["active_subscribers"] == 0
    assert dm._leases == set()


def test_market_ws_rolls_back_new_lease_when_initial_snapshot_is_missing() -> None:
    class _MissingSnapshotManager(_MarketStreamDataManager):
        async def market_snapshot(self, keys, *, refresh_missing: bool):
            return []

    dm = _MissingSnapshotManager()
    with _client(dm).websocket_connect("/api/v1/stream/market") as ws:
        assert ws.receive_json()["type"] == "connected"
        ws.send_json({"action": "subscribe", "streams": [_stream("open_interest")]})
        error = ws.receive_json()
        assert error["code"] == "SUBSCRIBE_FAILED"
        assert "initial market snapshot unavailable" in error["detail"]

    assert len(dm.ensure_calls) == 1
    assert dm.release_calls == dm.ensure_calls
    assert dm._leases == set()


def test_market_ws_does_not_expose_internal_subscribe_errors() -> None:
    class _FailingManager(_MarketStreamDataManager):
        async def ensure_market_stream(self, key: MarketStreamKey, *, consumer_id: str) -> bool:
            raise RuntimeError("https://internal.example/?token=secret")

    with _client(_FailingManager()).websocket_connect("/api/v1/stream/market") as ws:
        assert ws.receive_json()["type"] == "connected"
        ws.send_json({"action": "subscribe", "streams": [_stream("mark_price")]})
        error = ws.receive_json()
        assert error["code"] == "SUBSCRIBE_FAILED"
        assert error["detail"] == (
            "advanced market subscription is temporarily unavailable"
        )
        assert "secret" not in error["detail"]
