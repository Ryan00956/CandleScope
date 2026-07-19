from __future__ import annotations

from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1 import symbols as symbols_api
from app.api.v1.stream import router as stream_router
from app.data_engine.ingestion.models import DataSource
from app.data_engine.market_data.events import MarketStateEvent
from app.data_engine.market_data.hub import MarketEventHub
from app.data_engine.market_data.models import MarketStreamKey


class _FullOrderBookDataManager:
    full_order_book_ready = True

    def __init__(self) -> None:
        self.hub = MarketEventHub(max_states=32, default_max_pending=16)
        self.ensure_calls: list[tuple[MarketStreamKey, str]] = []
        self.release_calls: list[tuple[MarketStreamKey, str]] = []
        self._leases: set[tuple[MarketStreamKey, str]] = set()
        self.subscription = None

    async def ensure_full_order_book_stream(
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

    async def release_full_order_book_stream(
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

    def attach_full_order_books(
        self,
        keys: list[MarketStreamKey],
        *,
        max_pending: int,
    ):
        self.subscription = self.hub.subscribe(
            keys,
            max_pending=max_pending,
            replay=False,
        )
        current = {key: self.hub.snapshot([key])[0] for key in keys}
        self.hub.publish(_stale_event(keys[0], update_id=10))
        return SimpleNamespace(subscription=self.subscription, current=current)


def _client(data_manager: object | None = None) -> TestClient:
    app = FastAPI()
    app.include_router(stream_router, prefix="/api/v1")
    if data_manager is not None:
        app.state.data_manager = data_manager
    return TestClient(app)


def _stream(
    symbol: object = "BTCUSDT",
    *,
    channel: str = "full_depth",
    market_type: str = "futures",
    update_interval_ms: object = 250,
    snapshot_limit: object = 1000,
    output_limit: object = 2,
    price_grouping: object = "raw",
    mode: str = "full",
) -> dict:
    return {
        "exchange": "binance",
        "market_type": market_type,
        "symbol": symbol,
        "channel": channel,
        "params": {
            "mode": mode,
            "snapshot_limit": snapshot_limit,
            "update_interval_ms": update_interval_ms,
            "output_limit": output_limit,
            "price_grouping": price_grouping,
        },
    }


def _event(key: MarketStreamKey, *, update_id: int) -> MarketStateEvent:
    return MarketStateEvent(
        key=key,
        event_time_ms=1_700_000_000_000 + update_id,
        received_at_ms=1_700_000_000_010 + update_id,
        source=DataSource.WEBSOCKET,
        sequence=update_id,
        data={
            "state": "live",
            "live": True,
            "stale": False,
            "last_update_id": update_id,
            "snapshot_limit": 1000,
            "book_bid_levels": 3,
            "book_ask_levels": 3,
            "bids": [[100.0, 1.0], [99.0, 2.0], [98.0, 3.0]],
            "asks": [[101.0, 1.0], [102.0, 2.0], [103.0, 3.0]],
        },
    )


def _stale_event(key: MarketStreamKey, *, update_id: int) -> MarketStateEvent:
    return MarketStateEvent(
        key=key,
        event_time_ms=1_700_000_100_000 + update_id,
        received_at_ms=1_700_000_100_010 + update_id,
        source=DataSource.WEBSOCKET,
        sequence=update_id,
        data={
            "state": "stale",
            "live": False,
            "stale": True,
            "stale_reason": "ingestion_reconnecting",
            "last_update_id": None,
            "last_live_update_id": update_id,
            "snapshot_limit": 1000,
            "book_bid_levels": 0,
            "book_ask_levels": 0,
            "bids": [],
            "asks": [],
        },
    )


def test_full_order_book_ws_separates_live_snapshots_from_stale_status() -> None:
    dm = _FullOrderBookDataManager()

    with _client(dm).websocket_connect("/api/v1/stream/full-order-book") as ws:
        connected = ws.receive_json()
        assert connected["type"] == "connected"
        assert connected["protocol"] == "orderbook.full.v1"
        assert connected["source_delivery"] == "ordered_delta"
        assert connected["fail_closed_on_gap"] is True
        assert connected["allowed_update_intervals_ms"] == [100, 250, 500, 1000]
        assert connected["allowed_update_intervals_ms_by_market"] == {
            "spot": [100, 1000],
            "futures": [100, 250, 500],
        }
        assert connected["allowed_price_groupings"] == ["auto", "raw", "10", "100", "1000"]

        ws.send_json({
            "action": "subscribe",
            "request_id": "s1",
            "streams": [_stream()],
        })
        subscribed = ws.receive_json()
        snapshot = ws.receive_json()
        stale = ws.receive_json()

        assert subscribed["type"] == "subscribed"
        assert subscribed["streams"][0]["price_grouping"] == "raw"
        assert snapshot["type"] == "snapshot"
        assert snapshot["data"][0]["data"]["bids"] == [
            [100.0, 1.0],
            [99.0, 2.0],
        ]
        assert snapshot["data"][0]["data"]["projection_depth"] == 2
        assert snapshot["data"][0]["data"]["full_projection"] is False
        assert stale["type"] == "full_order_book.status"
        assert stale["state"] == "stale"
        assert stale["backend_sequence_continuity"] is False
        assert stale["data"]["data"]["bids"] == []
        assert stale["data"]["data"]["last_live_update_id"] == 10

        ws.send_json({"action": "unsubscribe", "request_id": "u1"})
        assert ws.receive_json()["type"] == "unsubscribed"

    assert dm.release_calls == dm.ensure_calls
    assert dm.subscription.closed is True
    assert dm._leases == set()


def test_full_order_book_ws_applies_requested_grouping_from_cached_tick(monkeypatch) -> None:
    monkeypatch.setitem(
        symbols_api._symbol_cache,
        ("binance", "futures"),
        [{"symbol": "BTCUSDT", "priceTickSize": "0.1"}],
    )
    dm = _FullOrderBookDataManager()

    with _client(dm).websocket_connect("/api/v1/stream/full-order-book") as ws:
        assert ws.receive_json()["type"] == "connected"
        ws.send_json({
            "action": "subscribe",
            "request_id": "grouped",
            "streams": [_stream(price_grouping="10")],
        })
        subscribed = ws.receive_json()
        snapshot = ws.receive_json()

        assert subscribed["streams"][0]["price_grouping"] == "10"
        assert subscribed["streams"][0]["price_tick_size"] == 0.1
        data = snapshot["data"][0]["data"]
        assert data["price_step"] == 1.0
        assert data["aggregation_applied"] is True

        ws.send_json({"action": "unsubscribe"})
        terminal_types = {
            ws.receive_json()["type"],
            ws.receive_json()["type"],
        }
        assert terminal_types == {"full_order_book.status", "unsubscribed"}


def test_full_order_book_ws_rejects_ambiguous_or_unsupported_streams() -> None:
    dm = _FullOrderBookDataManager()
    invalid = [
        _stream(channel="depth"),
        _stream(market_type="margin"),
        _stream(market_type="spot", update_interval_ms=250),
        _stream(update_interval_ms=1000),
        _stream(snapshot_limit=500),
        _stream(output_limit=0),
        _stream(output_limit=1001),
        _stream(price_grouping="7"),
        _stream(mode="partial"),
        _stream(symbol=None),
    ]

    with _client(dm).websocket_connect("/api/v1/stream/full-order-book") as ws:
        assert ws.receive_json()["type"] == "connected"
        for index, stream in enumerate(invalid):
            ws.send_json({
                "action": "subscribe",
                "request_id": str(index),
                "streams": [stream],
            })
            error = ws.receive_json()
            assert error["code"] == "INVALID_SUBSCRIPTION"
            assert error["request_id"] == str(index)

        duplicate = _stream()
        ws.send_json({
            "action": "subscribe",
            "request_id": "duplicate",
            "streams": [duplicate, duplicate],
        })
        assert ws.receive_json()["code"] == "INVALID_SUBSCRIPTION"

        ws.send_json({"action": "subscribe", "streams": [_stream()]})
        assert ws.receive_json()["type"] == "subscribed"
        assert ws.receive_json()["type"] == "snapshot"
        assert ws.receive_json()["type"] == "full_order_book.status"
        ws.send_json({"action": "unsubscribe"})
        assert ws.receive_json()["type"] == "unsubscribed"

    assert dm.release_calls == dm.ensure_calls


def test_full_order_book_ws_accepts_spot_continuous_stream() -> None:
    dm = _FullOrderBookDataManager()

    with _client(dm).websocket_connect("/api/v1/stream/full-order-book") as ws:
        assert ws.receive_json()["type"] == "connected"
        ws.send_json({
            "action": "subscribe",
            "request_id": "spot",
            "streams": [_stream(market_type="spot", update_interval_ms=1000)],
        })
        subscribed = ws.receive_json()
        snapshot = ws.receive_json()
        stale = ws.receive_json()
        assert subscribed["type"] == "subscribed"
        assert subscribed["streams"][0]["market_type"] == "spot"
        assert subscribed["streams"][0]["params"]["update_interval_ms"] == "1000"
        assert snapshot["data"][0]["key"]["market_type"] == "spot"
        assert stale["type"] == "full_order_book.status"
        assert stale["data"]["key"]["market_type"] == "spot"
        ws.send_json({"action": "unsubscribe"})
        assert ws.receive_json()["type"] == "unsubscribed"

    assert dm.release_calls == dm.ensure_calls


def test_full_order_book_ws_unready_and_internal_errors_are_redacted() -> None:
    with _client().websocket_connect("/api/v1/stream/full-order-book") as ws:
        assert ws.receive_json() == {
            "type": "error",
            "code": "FULL_ORDER_BOOK_STREAM_NOT_READY",
            "detail": "Full order-book market data is not initialized.",
        }
        closed = ws.receive()
        assert closed["type"] == "websocket.close"
        assert closed["code"] == 1013

    class _FailingManager(_FullOrderBookDataManager):
        async def ensure_full_order_book_stream(self, key, *, consumer_id):
            raise RuntimeError("wss://internal.example/?token=secret")

    with _client(_FailingManager()).websocket_connect(
        "/api/v1/stream/full-order-book",
    ) as ws:
        assert ws.receive_json()["type"] == "connected"
        ws.send_json({"action": "subscribe", "streams": [_stream()]})
        error = ws.receive_json()
        assert error["code"] == "SUBSCRIBE_FAILED"
        assert error["detail"] == (
            "full order-book subscription is temporarily unavailable"
        )
        assert "secret" not in error["detail"]
