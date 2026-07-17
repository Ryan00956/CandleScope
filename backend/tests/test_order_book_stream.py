from __future__ import annotations

from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.stream import router as stream_router
from app.data_engine.ingestion.models import DataSource
from app.data_engine.market_data.events import MarketStateEvent
from app.data_engine.market_data.hub import MarketEventHub
from app.data_engine.market_data.models import MarketStreamKey


class _OrderBookDataManager:
    order_book_ready = True

    def __init__(self) -> None:
        self.hub = MarketEventHub(max_states=64, default_max_pending=32)
        self.ensure_calls: list[tuple[MarketStreamKey, str]] = []
        self.release_calls: list[tuple[MarketStreamKey, str]] = []
        self.attach_calls: list[tuple[list[MarketStreamKey], int]] = []
        self._leases: set[tuple[MarketStreamKey, str]] = set()
        self.subscription = None

    async def ensure_order_book_stream(
        self,
        key: MarketStreamKey,
        *,
        consumer_id: str,
    ) -> bool:
        lease = (key, consumer_id)
        if lease in self._leases:
            return False
        self._leases.add(lease)
        self.ensure_calls.append(lease)
        self.hub.publish(_event(key, update_id=10))
        return True

    async def release_order_book_stream(
        self,
        key: MarketStreamKey,
        *,
        consumer_id: str,
    ) -> bool:
        lease = (key, consumer_id)
        if lease not in self._leases:
            return False
        self._leases.remove(lease)
        self.release_calls.append(lease)
        return True

    def attach_order_books(
        self,
        keys: list[MarketStreamKey],
        *,
        max_pending: int,
    ):
        self.attach_calls.append((keys, max_pending))
        self.subscription = self.hub.subscribe(
            keys,
            max_pending=max_pending,
            replay=False,
        )
        current = {
            key: self.hub.snapshot([key])[0]
            for key in keys
        }
        self.hub.publish(_event(keys[0], update_id=11))
        return SimpleNamespace(subscription=self.subscription, current=current)


def _client(data_manager: object | None = None) -> TestClient:
    app = FastAPI()
    app.include_router(stream_router, prefix="/api/v1")
    if data_manager is not None:
        app.state.data_manager = data_manager
    return TestClient(app)


def _stream(
    symbol: str = "BTCUSDT",
    *,
    channel: str = "depth",
    market_type: str = "futures",
    depth_levels: object = 20,
    update_interval_ms: object = 250,
    mode: str = "partial",
) -> dict:
    return {
        "exchange": "binance",
        "market_type": market_type,
        "symbol": symbol,
        "channel": channel,
        "params": {
            "mode": mode,
            "depth_levels": depth_levels,
            "update_interval_ms": update_interval_ms,
        },
    }


def _event(key: MarketStreamKey, *, update_id: int) -> MarketStateEvent:
    params = dict(key.params)
    return MarketStateEvent(
        key=key,
        event_time_ms=1_700_000_000_000 + update_id,
        received_at_ms=1_700_000_000_010 + update_id,
        source=DataSource.WEBSOCKET,
        sequence=update_id,
        data={
            "last_update_id": update_id,
            "depth_levels": int(params["depth_levels"]),
            "update_interval_ms": int(params["update_interval_ms"]),
            "best_bid_price": 60_000.0,
            "best_ask_price": 60_001.0,
            "mid_price": 60_000.5,
            "spread": 1.0,
            "spread_bps": 1 / 60_000.5 * 10_000,
            "bid_notional": 60_000.0,
            "ask_notional": 60_001.0,
            "notional_imbalance": -1 / 120_001,
            "bids": [[60_000.0, 1.0]],
            "asks": [[60_001.0, 1.0]],
        },
    )


def _assert_contract(payload: dict) -> None:
    assert payload["delivery"] == "latest_snapshot"
    assert payload["snapshot_replaceable"] is True
    assert payload["full_depth"] is False
    assert payload["sequence_continuity"] is False
    assert payload["backfillable"] is False
    assert payload["persisted"] is False


def test_order_book_ws_orders_snapshot_before_live_latest_state() -> None:
    dm = _OrderBookDataManager()
    command = {
        "action": "subscribe",
        "request_id": "s1",
        "streams": [_stream()],
    }

    with _client(dm).websocket_connect("/api/v1/stream/order-book") as ws:
        connected = ws.receive_json()
        assert connected["type"] == "connected"
        assert connected["protocol"] == "orderbook.v1"
        assert connected["allowed_depth_levels"] == [5, 10, 20]
        assert connected["allowed_update_intervals_ms"] == [100, 250, 500]
        _assert_contract(connected)

        ws.send_json(command)
        subscribed = ws.receive_json()
        snapshot = ws.receive_json()
        live = ws.receive_json()

        assert subscribed["type"] == "subscribed"
        assert subscribed["request_id"] == "s1"
        assert snapshot["type"] == "snapshot"
        assert snapshot["data"][0]["sequence"] == 10
        assert live["type"] == "order_book.snapshot"
        assert live["data"]["sequence"] == 11
        for payload in (subscribed, snapshot, live):
            _assert_contract(payload)

        ws.send_json(command)
        immutable = ws.receive_json()
        assert immutable["code"] == "IMMUTABLE_SUBSCRIPTION"

        ws.send_json({"action": "unsubscribe", "request_id": "u1"})
        assert ws.receive_json()["type"] == "unsubscribed"

    assert dm.release_calls == dm.ensure_calls
    assert dm.attach_calls[0][1] == 32
    assert dm.subscription.closed is True
    assert dm._leases == set()


def test_order_book_ws_rejects_non_partial_or_unsupported_streams() -> None:
    dm = _OrderBookDataManager()

    with _client(dm).websocket_connect("/api/v1/stream/order-book") as ws:
        assert ws.receive_json()["type"] == "connected"
        invalid_streams = [
            _stream(channel="trade"),
            _stream(market_type="spot"),
            _stream(depth_levels=50),
            _stream(update_interval_ms=1000),
            _stream(mode="delta"),
            _stream(mode="Partial"),
        ]
        for index, stream in enumerate(invalid_streams):
            ws.send_json({
                "action": "subscribe",
                "request_id": str(index),
                "streams": [stream],
            })
            error = ws.receive_json()
            assert error["code"] == "INVALID_SUBSCRIPTION"
            assert error["request_id"] == str(index)

        ws.send_json({"action": "subscribe", "streams": [_stream()]})
        assert ws.receive_json()["type"] == "subscribed"
        assert ws.receive_json()["type"] == "snapshot"
        assert ws.receive_json()["type"] == "order_book.snapshot"
        ws.send_json({"action": "unsubscribe"})
        assert ws.receive_json()["type"] == "unsubscribed"

    assert len(dm.ensure_calls) == 1
    assert dm.release_calls == dm.ensure_calls


def test_order_book_ws_rejects_falsey_non_object_params_and_non_string_symbol() -> None:
    dm = _OrderBookDataManager()

    with _client(dm).websocket_connect("/api/v1/stream/order-book") as ws:
        assert ws.receive_json()["type"] == "connected"
        invalid_streams = [
            {**_stream(), "params": None},
            {**_stream(), "params": []},
            {**_stream(), "params": ""},
            {**_stream(), "symbol": None},
            {**_stream(), "symbol": 123},
        ]
        for stream in invalid_streams:
            ws.send_json({"action": "subscribe", "streams": [stream]})
            error = ws.receive_json()
            assert error["code"] == "INVALID_SUBSCRIPTION"

        ws.send_json({"action": "subscribe", "streams": [_stream()]})
        assert ws.receive_json()["type"] == "subscribed"
        assert ws.receive_json()["type"] == "snapshot"
        assert ws.receive_json()["type"] == "order_book.snapshot"
        ws.send_json({"action": "unsubscribe"})
        assert ws.receive_json()["type"] == "unsubscribed"

    assert len(dm.ensure_calls) == 1
    assert dm.release_calls == dm.ensure_calls


def test_order_book_ws_unready_and_internal_errors_are_redacted() -> None:
    with _client().websocket_connect("/api/v1/stream/order-book") as ws:
        assert ws.receive_json() == {
            "type": "error",
            "code": "ORDER_BOOK_STREAM_NOT_READY",
            "detail": "Order-book market data is not initialized.",
        }
        closed = ws.receive()
        assert closed["type"] == "websocket.close"
        assert closed["code"] == 1013

    class _FailingManager(_OrderBookDataManager):
        async def ensure_order_book_stream(self, key, *, consumer_id):
            raise RuntimeError("wss://internal.example/?token=secret")

    with _client(_FailingManager()).websocket_connect(
        "/api/v1/stream/order-book",
    ) as ws:
        assert ws.receive_json()["type"] == "connected"
        ws.send_json({"action": "subscribe", "streams": [_stream()]})
        error = ws.receive_json()
        assert error["code"] == "SUBSCRIBE_FAILED"
        assert error["detail"] == "order-book subscription is temporarily unavailable"
        assert "secret" not in error["detail"]


def test_order_book_ws_disconnect_releases_stream_and_attachment() -> None:
    dm = _OrderBookDataManager()

    with _client(dm).websocket_connect("/api/v1/stream/order-book") as ws:
        assert ws.receive_json()["type"] == "connected"
        ws.send_json({"action": "subscribe", "streams": [_stream()]})
        assert ws.receive_json()["type"] == "subscribed"
        assert ws.receive_json()["type"] == "snapshot"
        assert ws.receive_json()["type"] == "order_book.snapshot"

    assert dm.release_calls == dm.ensure_calls
    assert dm.subscription.closed is True
    assert dm._leases == set()
