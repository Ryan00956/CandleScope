from __future__ import annotations

from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.stream import router as stream_router
from app.data_engine.ingestion.models import DataSource
from app.data_engine.market_data.append_hub import AppendBatchHub
from app.data_engine.market_data.liquidation import NormalizedLiquidation
from app.data_engine.market_data.models import MarketStreamKey


class _LiquidationDataManager:
    liquidation_ready = True

    def __init__(self, *, discontinuous: bool = False) -> None:
        self.hub = AppendBatchHub[NormalizedLiquidation](
            max_pending_records=1 if discontinuous else 16,
        )
        self.discontinuous = discontinuous
        self.ensure_calls: list[tuple[MarketStreamKey, str]] = []
        self.release_calls: list[tuple[MarketStreamKey, str]] = []
        self.attach_calls: list[tuple[list[MarketStreamKey], int, int]] = []
        self._leases: set[tuple[MarketStreamKey, str]] = set()
        self.subscription = None

    async def ensure_liquidation_stream(
        self,
        key: MarketStreamKey,
        *,
        consumer_id: str,
    ) -> bool:
        if key.market_type != "futures":
            raise ValueError("liquidation streams require market_type='futures'")
        lease = (key, consumer_id)
        if lease in self._leases:
            return False
        self._leases.add(lease)
        self.ensure_calls.append(lease)
        return True

    async def release_liquidation_stream(
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

    def attach_liquidations(
        self,
        keys: list[MarketStreamKey],
        *,
        recent_limit: int,
        max_pending_records: int,
    ):
        self.attach_calls.append((keys, recent_limit, max_pending_records))
        identities = {(key.exchange, key.market_type, key.symbol) for key in keys}
        self.subscription = self.hub.subscribe(
            max_pending_records=max_pending_records,
            predicate=lambda event: event.stream_identity in identities,
        )
        recent = {
            (key.exchange, key.market_type, key.symbol): (_liquidation(key, 10),)
            for key in keys
        }

        # Queue live data before returning.  The handler must still send the
        # atomic recent snapshot before it starts forwarding these records.
        if self.discontinuous:
            self.hub.append(_liquidation(keys[0], 11))
            self.hub.append(_liquidation(keys[0], 12))
        else:
            self.hub.append(_liquidation(keys[0], 11))
        self.hub.flush_all()
        return SimpleNamespace(subscription=self.subscription, recent=recent)

    def liquidation_recent(self, *args, **kwargs):
        raise AssertionError("WebSocket handoff must use attach_liquidations")


def _client(data_manager: object | None = None) -> TestClient:
    app = FastAPI()
    app.include_router(stream_router, prefix="/api/v1")
    if data_manager is not None:
        app.state.data_manager = data_manager
    return TestClient(app)


def _stream(
    symbol: str = "BTCUSDT",
    *,
    channel: str = "liquidation",
    market_type: str = "futures",
) -> dict[str, str]:
    return {
        "exchange": "binance",
        "market_type": market_type,
        "symbol": symbol,
        "channel": channel,
    }


def _liquidation(key: MarketStreamKey, sequence: int) -> NormalizedLiquidation:
    return NormalizedLiquidation(
        exchange=key.exchange,
        market_type=key.market_type,
        symbol=key.symbol,
        pair_symbol=key.symbol,
        symbol_type="UM",
        order_side="SELL" if sequence % 2 else "BUY",
        order_type="LIMIT",
        time_in_force="IOC",
        original_quantity=0.2,
        order_price=60_000 + sequence,
        average_price=60_000 + sequence,
        order_status="FILLED",
        last_filled_quantity=0.1,
        filled_quantity=0.2,
        trade_time_ms=1_700_000_000_000 + sequence,
        event_time_ms=1_700_000_000_010 + sequence,
        received_at_ms=1_700_000_000_020 + sequence,
        source=DataSource.WEBSOCKET,
    )


def _assert_quality_metadata(payload: dict) -> None:
    assert payload["source_quality"] == "sampled_best_effort"
    assert payload["source_exhaustive"] is False
    assert payload["sampling_mode"] == "latest_per_symbol_1000ms"
    assert payload["lossy_snapshot"] is True
    assert payload["backfillable"] is False
    assert payload["exchange_update_interval_ms"] == 1000


def test_liquidation_ws_orders_connected_subscribed_recent_then_batch() -> None:
    dm = _LiquidationDataManager()
    command = {
        "action": "subscribe",
        "request_id": "s1",
        "streams": [_stream()],
        "recent_limit": 25,
    }

    with _client(dm).websocket_connect("/api/v1/stream/liquidations") as ws:
        connected = ws.receive_json()
        assert connected["type"] == "connected"
        assert connected["protocol"] == "liquidation.v1"
        _assert_quality_metadata(connected)

        ws.send_json(command)
        subscribed = ws.receive_json()
        recent = ws.receive_json()
        batch = ws.receive_json()

        assert subscribed["type"] == "subscribed"
        assert subscribed["protocol"] == "liquidation.v1"
        assert subscribed["request_id"] == "s1"
        assert recent["type"] == "recent"
        assert [item["trade_time_ms"] for item in recent["data"]] == [
            1_700_000_000_010,
        ]
        assert batch["type"] == "liquidation.batch"
        assert batch["protocol"] == "liquidation.v1"
        assert batch["sequence"] == 1
        assert batch["delivery_continuity"] is True
        assert batch["resync_required"] is False
        assert batch["dropped_before"] == 0
        assert [item["trade_time_ms"] for item in batch["data"]] == [
            1_700_000_000_011,
        ]
        for payload in (subscribed, recent, batch):
            _assert_quality_metadata(payload)

        ws.send_json(command)
        immutable = ws.receive_json()
        assert immutable["code"] == "IMMUTABLE_SUBSCRIPTION"
        assert immutable["detail"] == "Reconnect to change liquidation streams"

        ws.send_json({"action": "unsubscribe", "request_id": "u1"})
        unsubscribed = ws.receive_json()
        assert unsubscribed["type"] == "unsubscribed"
        assert unsubscribed["protocol"] == "liquidation.v1"
        assert unsubscribed["request_id"] == "u1"

    assert len(dm.ensure_calls) == 1
    assert dm.release_calls == dm.ensure_calls
    assert dm.attach_calls[0][1:] == (25, 4_096)
    assert dm.subscription.closed is True
    assert dm._leases == set()


def test_liquidation_ws_discontinuity_signals_resync_and_closes_1013() -> None:
    dm = _LiquidationDataManager(discontinuous=True)

    with _client(dm).websocket_connect("/api/v1/stream/liquidations") as ws:
        assert ws.receive_json()["type"] == "connected"
        ws.send_json({"action": "subscribe", "streams": [_stream()]})
        assert ws.receive_json()["type"] == "subscribed"
        assert ws.receive_json()["type"] == "recent"
        resync = ws.receive_json()

        assert resync == {
            "type": "resync_required",
            "protocol": "liquidation.v1",
            "code": "LIQUIDATION_DELIVERY_DISCONTINUITY",
            "sequence": 1,
            "delivery_continuity": False,
            "resync_required": True,
            "dropped_before": 1,
            "source_quality": "sampled_best_effort",
            "source_exhaustive": False,
            "sampling_mode": "latest_per_symbol_1000ms",
            "lossy_snapshot": True,
            "backfillable": False,
            "exchange_update_interval_ms": 1000,
        }
        closed = ws.receive()
        assert closed["type"] == "websocket.close"
        assert closed["code"] == 1013

    assert dm.release_calls == dm.ensure_calls
    assert dm.subscription.closed is True
    assert dm._leases == set()


def test_liquidation_ws_rejects_invalid_channel_and_spot_stream() -> None:
    dm = _LiquidationDataManager()

    with _client(dm).websocket_connect("/api/v1/stream/liquidations") as ws:
        assert ws.receive_json()["type"] == "connected"

        ws.send_json({
            "action": "subscribe",
            "request_id": "bad-channel",
            "streams": [_stream(channel="basis")],
        })
        invalid_channel = ws.receive_json()
        assert invalid_channel["code"] == "INVALID_SUBSCRIPTION"
        assert invalid_channel["request_id"] == "bad-channel"
        assert "only support channel 'liquidation'" in invalid_channel["detail"]

        ws.send_json({
            "action": "subscribe",
            "request_id": "spot",
            "streams": [_stream(market_type="spot")],
        })
        spot = ws.receive_json()
        assert spot == {
            "type": "error",
            "request_id": "spot",
            "code": "SUBSCRIBE_FAILED",
            "detail": "liquidation streams require market_type='futures'",
        }

        ws.send_json({
            "action": "subscribe",
            "request_id": "valid",
            "streams": [_stream()],
            "recent_limit": 0,
        })
        assert ws.receive_json()["type"] == "subscribed"
        assert ws.receive_json()["type"] == "recent"
        assert ws.receive_json()["type"] == "liquidation.batch"
        ws.send_json({"action": "unsubscribe"})
        assert ws.receive_json()["type"] == "unsubscribed"

    assert len(dm.ensure_calls) == 1
    assert dm.release_calls == dm.ensure_calls


def test_liquidation_ws_unready_and_internal_errors_are_redacted() -> None:
    with _client().websocket_connect("/api/v1/stream/liquidations") as ws:
        assert ws.receive_json() == {
            "type": "error",
            "code": "LIQUIDATION_STREAM_NOT_READY",
            "detail": "Liquidation market data is not initialized.",
        }
        closed = ws.receive()
        assert closed["type"] == "websocket.close"
        assert closed["code"] == 1013

    class _FailingManager(_LiquidationDataManager):
        async def ensure_liquidation_stream(
            self,
            key: MarketStreamKey,
            *,
            consumer_id: str,
        ) -> bool:
            raise RuntimeError("https://internal.example/?token=secret")

    with _client(_FailingManager()).websocket_connect(
        "/api/v1/stream/liquidations",
    ) as ws:
        assert ws.receive_json()["type"] == "connected"
        ws.send_json({"action": "subscribe", "streams": [_stream()]})
        error = ws.receive_json()
        assert error["code"] == "SUBSCRIBE_FAILED"
        assert error["detail"] == (
            "liquidation subscription is temporarily unavailable"
        )
        assert "secret" not in error["detail"]


def test_liquidation_ws_disconnect_releases_lease_and_attachment() -> None:
    dm = _LiquidationDataManager()

    with _client(dm).websocket_connect("/api/v1/stream/liquidations") as ws:
        assert ws.receive_json()["type"] == "connected"
        ws.send_json({"action": "subscribe", "streams": [_stream()]})
        assert ws.receive_json()["type"] == "subscribed"
        assert ws.receive_json()["type"] == "recent"
        assert ws.receive_json()["type"] == "liquidation.batch"
        # Exiting without unsubscribe exercises WebSocketDisconnect cleanup.

    assert dm.release_calls == dm.ensure_calls
    assert dm.subscription.closed is True
    assert dm._leases == set()
