from __future__ import annotations

from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.stream import router as stream_router
from app.data_engine.ingestion.models import DataSource
from app.data_engine.market_data.append_hub import AppendBatchHub
from app.data_engine.market_data.models import MarketChannel, MarketStreamKey
from app.data_engine.market_data.trade_flow import NormalizedAggTrade
from app.data_engine.market_data.trade_tape import ObservedTrade


class _TradeFlowDataManager:
    trade_flow_ready = True

    def __init__(self, *, discontinuous: bool = False) -> None:
        self.hub = AppendBatchHub[NormalizedAggTrade | ObservedTrade](
            max_pending_records=1 if discontinuous else 16,
        )
        self.discontinuous = discontinuous
        self.ensure_calls: list[tuple[MarketStreamKey, str]] = []
        self.release_calls: list[tuple[MarketStreamKey, str]] = []
        self.attach_calls: list[tuple[list[MarketStreamKey], int, int]] = []
        self._leases: set[tuple[MarketStreamKey, str]] = set()
        self.subscription = None

    async def ensure_trade_flow_stream(
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
        return True

    async def release_trade_flow_stream(
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

    def attach_trade_flow(
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
            predicate=lambda trade: trade.stream_identity in identities,
        )
        recent = {
            (key.exchange, key.market_type, key.symbol): (_trade(key, 10),)
            for key in keys
        }

        # Queue live data before returning.  The handler must still send recent
        # first because forwarding only starts after the atomic attachment.
        if self.discontinuous:
            self.hub.append(_trade(keys[0], 11))
            self.hub.append(_trade(keys[0], 12))
        else:
            self.hub.append(_trade(keys[0], 11))
        self.hub.flush_all()
        return SimpleNamespace(subscription=self.subscription, recent=recent)

    def trade_flow_recent(self, *args, **kwargs):
        raise AssertionError("WebSocket handoff must use attach_trade_flow")


def _client(data_manager: object | None = None) -> TestClient:
    app = FastAPI()
    app.include_router(stream_router, prefix="/api/v1")
    if data_manager is not None:
        app.state.data_manager = data_manager
    return TestClient(app)


def _stream(symbol: str = "BTCUSDT", *, channel: str = "agg_trade") -> dict[str, str]:
    return {
        "exchange": "binance",
        "market_type": "futures",
        "symbol": symbol,
        "channel": channel,
    }


def _trade(
    key: MarketStreamKey,
    agg_trade_id: int,
) -> NormalizedAggTrade | ObservedTrade:
    if key.channel is MarketChannel.TRADE:
        return ObservedTrade(
            exchange=key.exchange,
            market_type=key.market_type,
            symbol=key.symbol,
            observation_sequence=agg_trade_id,
            trade_id=f"trade-{agg_trade_id}",
            exchange_trade_id=str(agg_trade_id),
            price=60_000.0 + agg_trade_id,
            quantity=0.1,
            trade_time_ms=1_700_000_000_000 + agg_trade_id,
            event_time_ms=1_700_000_000_010 + agg_trade_id,
            received_at_ms=1_700_000_000_020 + agg_trade_id,
            aggressor_side="buy",
            source=DataSource.PLUGIN,
        )
    return NormalizedAggTrade(
        exchange=key.exchange,
        market_type=key.market_type,
        symbol=key.symbol,
        agg_trade_id=agg_trade_id,
        price=60_000.0 + agg_trade_id,
        quantity=0.1,
        trade_time_ms=1_700_000_000_000 + agg_trade_id,
        event_time_ms=1_700_000_000_010 + agg_trade_id,
        received_at_ms=1_700_000_000_020 + agg_trade_id,
        is_buyer_maker=False,
        source=DataSource.WEBSOCKET,
        first_trade_id=agg_trade_id * 2,
        last_trade_id=agg_trade_id * 2 + 1,
    )


def test_trade_flow_ws_sends_atomic_recent_then_append_batch_and_releases() -> None:
    dm = _TradeFlowDataManager()
    command = {
        "action": "subscribe",
        "request_id": "s1",
        "streams": [_stream()],
        "recent_limit": 25,
    }

    with _client(dm).websocket_connect("/api/v1/stream/trade-flow") as ws:
        connected = ws.receive_json()
        assert connected["type"] == "connected"
        assert connected["protocol"] == "tradeflow.v1"

        ws.send_json(command)
        subscribed = ws.receive_json()
        recent = ws.receive_json()
        batch = ws.receive_json()

        assert subscribed["type"] == "subscribed"
        assert subscribed["protocol"] == "tradeflow.v1"
        assert recent["type"] == "recent"
        assert [item["agg_trade_id"] for item in recent["data"]] == [10]
        assert batch["type"] == "trade.batch"
        assert batch["protocol"] == "tradeflow.v1"
        assert batch["continuity"] is True
        assert batch["resync_required"] is False
        assert [item["agg_trade_id"] for item in batch["data"]] == [11]

        ws.send_json(command)
        assert ws.receive_json()["code"] == "IMMUTABLE_SUBSCRIPTION"
        ws.send_json({"action": "unsubscribe", "request_id": "u1"})
        unsubscribed = ws.receive_json()
        assert unsubscribed["type"] == "unsubscribed"
        assert unsubscribed["protocol"] == "tradeflow.v1"

    assert len(dm.ensure_calls) == 1
    assert dm.release_calls == dm.ensure_calls
    consumer_id = dm.ensure_calls[0][1]
    connection_id = consumer_id.removeprefix("ws:trade-flow:")
    assert len(connection_id) == 32
    assert int(connection_id, 16) >= 0
    assert dm.attach_calls[0][1:] == (25, 4_096)
    assert dm.subscription.closed is True
    assert dm._leases == set()


def test_trade_flow_ws_discontinuity_requires_resync_and_closes_fail_closed() -> None:
    dm = _TradeFlowDataManager(discontinuous=True)

    with _client(dm).websocket_connect("/api/v1/stream/trade-flow") as ws:
        assert ws.receive_json()["type"] == "connected"
        ws.send_json({"action": "subscribe", "streams": [_stream()]})
        assert ws.receive_json()["type"] == "subscribed"
        assert ws.receive_json()["type"] == "recent"
        resync = ws.receive_json()
        assert resync == {
            "type": "resync_required",
            "protocol": "tradeflow.v1",
            "code": "TRADE_FLOW_DISCONTINUITY",
            "sequence": 1,
            "continuity": False,
            "resync_required": True,
            "dropped_before": 1,
        }
        closed = ws.receive()
        assert closed["type"] == "websocket.close"
        assert closed["code"] == 1013

    assert dm.release_calls == dm.ensure_calls
    assert dm.subscription.closed is True


def test_trade_flow_ws_validates_commands_and_stays_protocol_isolated() -> None:
    dm = _TradeFlowDataManager()

    with _client(dm).websocket_connect("/api/v1/stream/trade-flow") as ws:
        connected = ws.receive_json()
        assert connected["protocol"] == "tradeflow.v1"

        ws.send_json({"action": "subscribe", "streams": [_stream(channel="basis")]})
        error = ws.receive_json()
        assert error["code"] == "INVALID_SUBSCRIPTION"
        assert "support channel 'agg_trade' or 'trade'" in error["detail"]

        ws.send_json({
            "action": "subscribe",
            "streams": [_stream()],
            "recent_limit": 1.5,
        })
        assert ws.receive_json()["detail"] == "recent_limit must be an integer"

        ws.send_json({
            "action": "subscribe",
            "streams": [_stream("BTCUSDT"), _stream("ETHUSDT"), _stream("SOLUSDT")],
            "recent_limit": 2_000,
        })
        bounded = ws.receive_json()
        assert bounded["code"] == "INVALID_SUBSCRIPTION"
        assert "at most 5000 records" in bounded["detail"]

        ws.send_text("ping")
        assert ws.receive_text() == "pong"


def test_trade_flow_ws_unready_and_internal_subscribe_errors_are_safe() -> None:
    with _client().websocket_connect("/api/v1/stream/trade-flow") as ws:
        assert ws.receive_json() == {
            "type": "error",
            "code": "TRADE_FLOW_STREAM_NOT_READY",
            "detail": "Trade-flow market data is not initialized.",
        }

    class _FailingManager(_TradeFlowDataManager):
        async def ensure_trade_flow_stream(
            self,
            key: MarketStreamKey,
            *,
            consumer_id: str,
        ) -> bool:
            raise RuntimeError("https://internal.example/?token=secret")

    with _client(_FailingManager()).websocket_connect(
        "/api/v1/stream/trade-flow",
    ) as ws:
        assert ws.receive_json()["type"] == "connected"
        ws.send_json({"action": "subscribe", "streams": [_stream()]})
        error = ws.receive_json()
        assert error["code"] == "SUBSCRIBE_FAILED"
        assert error["detail"] == "trade-flow subscription is temporarily unavailable"
        assert "secret" not in error["detail"]


def test_trade_flow_ws_labels_observational_trade_contract() -> None:
    dm = _TradeFlowDataManager()

    with _client(dm).websocket_connect("/api/v1/stream/trade-flow") as ws:
        assert ws.receive_json()["type"] == "connected"
        ws.send_json({
            "action": "subscribe",
            "request_id": "observed",
            "streams": [_stream(channel="trade")],
        })
        subscribed = ws.receive_json()
        recent = ws.receive_json()
        batch = ws.receive_json()
        assert subscribed["continuity_mode"] == "observational"
        assert recent["continuity_mode"] == "observational"
        assert recent["data"][0]["record_kind"] == "trade"
        assert recent["data"][0]["continuity_mode"] == "observational"
        assert batch["continuity_mode"] == "observational"
        assert batch["data"][0]["trade_id"] == "trade-11"
        ws.send_json({"action": "unsubscribe"})
        assert ws.receive_json()["type"] == "unsubscribed"
