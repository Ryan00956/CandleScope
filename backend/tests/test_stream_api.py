from __future__ import annotations

import asyncio

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.stream import router as stream_router
from app.api.v1.subscriptions import price_ws_router, router as subscriptions_router
from app.data_engine.data_manager.models import (
    BarData,
    DataEvent,
    DataEventType,
    SeriesKey,
    StreamInfo,
    StreamStatus,
)
from app.data_engine.data_manager.manager import DataManager
from app.data_engine.data_manager.subscriptions import SubscriptionTier
from app.data_engine.interval_resolution import (
    IntervalPurpose,
    IntervalResolutionError,
    IntervalResolutionErrorCode,
)


class _SingleStreamDataManager:
    def __init__(self, event_type: DataEventType = DataEventType.BAR_UPDATED) -> None:
        self.ensure_stream_calls: list[dict] = []
        self.release_stream_calls: list[dict] = []
        self.event_type = event_type

    async def ensure_stream(
        self,
        symbol: str,
        interval: str,
        *,
        exchange: str,
        market_type: str,
        focus_scope: str = "foreground",
        consumer_id: str | None = None,
    ) -> None:
        self.ensure_stream_calls.append({
            "symbol": symbol,
            "interval": interval,
            "exchange": exchange,
            "market_type": market_type,
            "focus_scope": focus_scope,
            "consumer_id": consumer_id,
        })

    async def release_stream(
        self,
        symbol: str,
        interval: str,
        *,
        exchange: str,
        market_type: str,
        focus_scope: str = "foreground",
        consumer_id: str | None = None,
    ) -> None:
        self.release_stream_calls.append({
            "symbol": symbol,
            "interval": interval,
            "exchange": exchange,
            "market_type": market_type,
            "focus_scope": focus_scope,
            "consumer_id": consumer_id,
        })

    async def subscribe_iter(self, *, symbol, interval, exchange, market_type, event_types):
        yield DataEvent(
            event_type=self.event_type,
            key=SeriesKey(symbol, interval, exchange=exchange, market_type=market_type),
            detail={"bars_count": 2}
            if self.event_type is DataEventType.BACKFILL_COMPLETED else {},
            bar=BarData(
                time=1_700_000_000,
                open=1,
                high=2,
                low=0.5,
                close=1.5,
                volume=10,
                quote_volume=15,
                trades=7,
                taker_buy_base=6,
                taker_buy_quote=9,
            ) if self.event_type is not DataEventType.BACKFILL_COMPLETED else None,
        )


class _MultiStreamDataManager:
    def __init__(
        self,
        *,
        emit_backfill: bool = True,
        event_type: DataEventType = DataEventType.BACKFILL_COMPLETED,
    ) -> None:
        self.ensure_stream_calls: list[dict] = []
        self.release_stream_calls: list[dict] = []
        self.subscribe_calls: list[dict] = []
        self.unsubscribed: list[object] = []
        self.emit_backfill = emit_backfill
        self.event_type = event_type

    async def ensure_stream(
        self,
        symbol: str,
        interval: str,
        *,
        exchange: str,
        market_type: str,
        focus_scope: str = "foreground",
        consumer_id: str | None = None,
    ) -> None:
        self.ensure_stream_calls.append({
            "symbol": symbol,
            "interval": interval,
            "exchange": exchange,
            "market_type": market_type,
            "focus_scope": focus_scope,
            "consumer_id": consumer_id,
        })

    async def release_stream(
        self,
        symbol: str,
        interval: str,
        *,
        exchange: str,
        market_type: str,
        focus_scope: str = "foreground",
        consumer_id: str | None = None,
    ) -> None:
        self.release_stream_calls.append({
            "symbol": symbol,
            "interval": interval,
            "exchange": exchange,
            "market_type": market_type,
            "focus_scope": focus_scope,
            "consumer_id": consumer_id,
        })

    def subscribe(
        self,
        *,
        callback,
        symbol,
        interval,
        exchange,
        market_type,
        event_types,
    ):
        self.subscribe_calls.append({
            "symbol": symbol,
            "interval": interval,
            "exchange": exchange,
            "market_type": market_type,
            "event_types": event_types,
        })

        async def _emit() -> None:
            await asyncio.sleep(0)
            event = DataEvent(
                event_type=self.event_type,
                key=SeriesKey(symbol, interval, exchange=exchange, market_type=market_type),
                detail={"bars_count": 2}
                if self.event_type is DataEventType.BACKFILL_COMPLETED else {},
                bar=BarData(
                    time=1_700_000_000,
                    open=1,
                    high=2,
                    low=0.5,
                    close=1.5,
                    volume=10,
                    quote_volume=15,
                    trades=7,
                    taker_buy_base=6,
                    taker_buy_quote=9,
                )
                if self.event_type is not DataEventType.BACKFILL_COMPLETED else None,
            )
            await callback(event)

        if self.emit_backfill:
            asyncio.create_task(_emit())
        return object()

    def unsubscribe(self, handle) -> None:
        self.unsubscribed.append(handle)


class _StoppedStatusSingleStreamDataManager(_SingleStreamDataManager):
    async def ensure_stream(self, symbol: str, interval: str, **kwargs) -> StreamInfo:
        await super().ensure_stream(symbol, interval, **kwargs)
        return StreamInfo(
            SeriesKey(
                symbol,
                interval,
                exchange=kwargs["exchange"],
                market_type=kwargs["market_type"],
            ),
            status=StreamStatus.STOPPED,
            error="ingestion disabled",
        )


class _PartiallyFailingMultiStreamDataManager(_MultiStreamDataManager):
    async def ensure_stream(self, symbol: str, interval: str, **kwargs) -> None:
        await super().ensure_stream(symbol, interval, **kwargs)
        if interval == "7s":
            raise IntervalResolutionError(
                IntervalResolutionErrorCode.NO_EXACT_BASE,
                "No exact realtime base can reconstruct 7s",
                exchange=kwargs["exchange"],
                market_type=kwargs["market_type"],
                interval=interval,
                purpose=IntervalPurpose.REALTIME,
            )


class _StoppedStatusMultiStreamDataManager(_MultiStreamDataManager):
    async def ensure_stream(self, symbol: str, interval: str, **kwargs) -> StreamInfo:
        await super().ensure_stream(symbol, interval, **kwargs)
        return StreamInfo(
            SeriesKey(
                symbol,
                interval,
                exchange=kwargs["exchange"],
                market_type=kwargs["market_type"],
            ),
            status=StreamStatus.STOPPED,
            error="ingestion disabled",
        )


class _FailingKlineIngestionFactory:
    async def start(self, **_kwargs):
        raise RuntimeError("injected ingestion failure")


class _PriceDataManager:
    def get_prices_snapshot(self) -> list[dict]:
        return [{
            "symbol": "BTCUSDT",
            "exchange": "binance",
            "market_type": "spot",
            "price": 100.0,
        }]

    async def subscribe_iter(self, *, event_types):
        yield DataEvent(
            event_type=DataEventType.PRICE_UPDATED,
            key=SeriesKey("BTCUSDT", "price"),
            detail={
                "price": {
                    "symbol": "BTCUSDT",
                    "exchange": "binance",
                    "market_type": "spot",
                    "price": 101.0,
                }
            },
        )


class _SubscriptionService:
    def __init__(self) -> None:
        self.subscriptions: dict[str, dict] = {}
        self.set_tier_calls: list[dict] = []

    def normalize_symbol(self, symbol: str) -> str:
        return symbol

    def get_tier(self, symbol: str) -> SubscriptionTier:
        sub = self.subscriptions.get(symbol)
        if sub is None:
            return SubscriptionTier.NONE
        return SubscriptionTier(sub["tier"])

    async def set_tier(
        self,
        symbol: str,
        tier: SubscriptionTier,
        *,
        intervals=None,
        consumer_id=None,
        storage_intent=True,
    ) -> dict:
        self.set_tier_calls.append({
            "symbol": symbol,
            "tier": tier,
            "intervals": intervals,
            "consumer_id": consumer_id,
            "storage_intent": storage_intent,
        })
        self.subscriptions[symbol] = {
            "symbol": symbol,
            "tier": tier.value,
            "intervals": intervals or [],
        }
        return {"symbol": symbol, "tier": tier.value, "changed": True}

    def get(self, symbol: str):
        return None

    def get_all(self) -> list[dict]:
        return list(self.subscriptions.values())

    def sync_watchlist_storage_intents(self, symbols: set[str]) -> None:
        self.synced_storage_intents = set(symbols)


class _SubscriptionDataManager:
    def __init__(self, service: _SubscriptionService) -> None:
        self.service = service

    def get_subscription_service(self) -> _SubscriptionService:
        return self.service


def _stream_client(data_manager) -> TestClient:
    app = FastAPI()
    app.include_router(stream_router, prefix="/api/v1")
    app.state.data_manager = data_manager
    return TestClient(app)


def _subscription_client(data_manager) -> TestClient:
    app = FastAPI()
    app.include_router(subscriptions_router, prefix="/api/v1")
    app.include_router(price_ws_router, prefix="/api/v1")
    app.state.data_manager = data_manager
    return TestClient(app)


def test_kline_ws_forwards_bar_updated_event_from_data_manager() -> None:
    dm = _SingleStreamDataManager(DataEventType.BAR_UPDATED)
    client = _stream_client(dm)

    with client.websocket_connect("/api/v1/stream/klines?symbol=BTCUSDT&interval=1m") as ws:
        assert ws.receive_json() == {
            "type": "subscribed",
            "exchange": "binance",
            "symbol": "BTCUSDT",
            "interval": "1m",
            "market_type": "spot",
        }
        message = ws.receive_json()

        assert message == {
            "type": "kline",
            "event_type": "bar.updated",
            "exchange": "binance",
        "symbol": "BTCUSDT",
        "interval": "1m",
        "market_type": "spot",
        "data": {
            "time": 1_700_000_000,
            "open": 1,
            "high": 2,
            "low": 0.5,
            "close": 1.5,
            "volume": 10,
            "is_closed": False,
            "quote_volume": 15,
            "trades": 7,
            "taker_buy_base": 6,
            "taker_buy_quote": 9,
            "order_flow": {
                "taker_sell_base": 4,
                "volume_delta_base": 2,
                "taker_buy_ratio_base": 0.6,
                "cvd_contribution_base": 2,
            },
        },
    }
    assert dm.ensure_stream_calls == [{
        "symbol": "BTCUSDT",
        "interval": "1m",
        "exchange": "binance",
        "market_type": "spot",
        "focus_scope": "websocket",
        "consumer_id": dm.ensure_stream_calls[0]["consumer_id"],
    }]
    assert dm.ensure_stream_calls[0]["consumer_id"].startswith(
        "ws:klines:binance:spot:BTCUSDT:1m:"
    )
    assert dm.release_stream_calls == [{
        "symbol": "BTCUSDT",
        "interval": "1m",
        "exchange": "binance",
        "market_type": "spot",
        "focus_scope": "websocket",
        "consumer_id": dm.ensure_stream_calls[0]["consumer_id"],
    }]


def test_single_kline_ws_canonicalises_alias_for_entire_lifecycle() -> None:
    dm = _SingleStreamDataManager()
    client = _stream_client(dm)

    with client.websocket_connect("/api/v1/stream/klines?symbol=BTCUSDT&interval=60m") as ws:
        subscribed = ws.receive_json()
        message = ws.receive_json()

    assert subscribed["interval"] == "1h"
    assert message["interval"] == "1h"
    assert dm.ensure_stream_calls[0]["interval"] == "1h"
    assert dm.release_stream_calls[0]["interval"] == "1h"


def test_single_kline_ws_sends_failed_ack_for_explicit_stopped_stream_info() -> None:
    dm = _StoppedStatusSingleStreamDataManager()
    client = _stream_client(dm)

    with client.websocket_connect(
        "/api/v1/stream/klines?symbol=BTCUSDT&interval=1m"
    ) as ws:
        assert ws.receive_json() == {
            "type": "error",
            "detail": "Stream could not be subscribed",
            "failed": [{
                "interval": "1m",
                "code": "stream_subscription_failed",
                "message": "stream 1m is stopped: ingestion disabled",
            }],
        }

    assert [call["interval"] for call in dm.release_stream_calls] == ["1m"]


def test_kline_ws_forwards_amended_bar_as_closed_replacement() -> None:
    dm = _SingleStreamDataManager(DataEventType.BAR_AMENDED)
    client = _stream_client(dm)

    with client.websocket_connect("/api/v1/stream/klines?symbol=BTCUSDT&interval=1m") as ws:
        assert ws.receive_json()["type"] == "subscribed"
        message = ws.receive_json()

    assert message["type"] == "kline"
    assert message["data"]["is_closed"] is True
    assert message["data"]["order_flow"]["cvd_contribution_base"] == 2


def test_kline_ws_forwards_backfill_completion_for_cvd_refetch() -> None:
    dm = _SingleStreamDataManager(DataEventType.BACKFILL_COMPLETED)
    client = _stream_client(dm)

    with client.websocket_connect("/api/v1/stream/klines?symbol=BTCUSDT&interval=1m") as ws:
        assert ws.receive_json()["type"] == "subscribed"
        message = ws.receive_json()

    assert message == {
        "type": "backfill_completed",
        "exchange": "binance",
        "symbol": "BTCUSDT",
        "interval": "1m",
        "market_type": "spot",
        "detail": {"bars_count": 2},
    }


def test_kline_multi_ws_forwards_backfill_completed_event() -> None:
    dm = _MultiStreamDataManager()
    client = _stream_client(dm)

    with client.websocket_connect("/api/v1/stream/klines_multi?symbol=BTCUSDT") as ws:
        assert ws.receive_json() == {
            "type": "connected",
            "exchange": "binance",
            "symbol": "BTCUSDT",
            "market_type": "spot",
        }
        ws.send_json({"action": "subscribe", "intervals": ["1m"]})
        assert ws.receive_json() == {
            "type": "subscribed",
            "exchange": "binance",
            "symbol": "BTCUSDT",
            "intervals": ["1m"],
            "requested_intervals": ["1m"],
            "failed": [],
            "active_intervals": ["1m"],
            "market_type": "spot",
        }
        message = ws.receive_json()

    assert message == {
        "type": "backfill_completed",
        "exchange": "binance",
        "symbol": "BTCUSDT",
        "interval": "1m",
        "market_type": "spot",
        "detail": {"bars_count": 2},
    }
    assert dm.ensure_stream_calls == [{
        "symbol": "BTCUSDT",
        "interval": "1m",
        "exchange": "binance",
        "market_type": "spot",
        "focus_scope": "websocket",
        "consumer_id": dm.ensure_stream_calls[0]["consumer_id"],
    }]
    assert dm.ensure_stream_calls[0]["consumer_id"].startswith(
        "ws:klines_multi:binance:spot:BTCUSDT:"
    )
    assert dm.release_stream_calls == [{
        "symbol": "BTCUSDT",
        "interval": "1m",
        "exchange": "binance",
        "market_type": "spot",
        "focus_scope": "websocket",
        "consumer_id": dm.ensure_stream_calls[0]["consumer_id"],
    }]
    assert len(dm.subscribe_calls) == 1


def test_kline_multi_ws_forwards_amended_enhanced_bar() -> None:
    dm = _MultiStreamDataManager(event_type=DataEventType.BAR_AMENDED)
    client = _stream_client(dm)

    with client.websocket_connect("/api/v1/stream/klines_multi?symbol=BTCUSDT") as ws:
        assert ws.receive_json()["type"] == "connected"
        ws.send_json({"action": "subscribe", "intervals": ["1m"]})
        assert ws.receive_json()["type"] == "subscribed"
        message = ws.receive_json()

    assert message["type"] == "kline"
    assert message["data"]["is_closed"] is True
    assert message["data"]["order_flow"]["cvd_contribution_base"] == 2
    assert DataEventType.BAR_AMENDED in dm.subscribe_calls[0]["event_types"]


def test_kline_multi_ws_unsubscribe_releases_stream_consumer() -> None:
    dm = _MultiStreamDataManager(emit_backfill=False)
    client = _stream_client(dm)

    with client.websocket_connect("/api/v1/stream/klines_multi?symbol=BTCUSDT") as ws:
        assert ws.receive_json()["type"] == "connected"
        ws.send_json({"action": "subscribe", "intervals": ["1m"]})
        assert ws.receive_json()["type"] == "subscribed"

        ws.send_json({"action": "unsubscribe", "intervals": ["1m"]})
        assert ws.receive_json() == {
            "type": "unsubscribed",
            "exchange": "binance",
            "symbol": "BTCUSDT",
            "intervals": ["1m"],
            "active_intervals": [],
            "market_type": "spot",
        }

    assert dm.release_stream_calls == [{
        "symbol": "BTCUSDT",
        "interval": "1m",
        "exchange": "binance",
        "market_type": "spot",
        "focus_scope": "websocket",
        "consumer_id": dm.ensure_stream_calls[0]["consumer_id"],
    }]


def test_kline_multi_ws_isolates_one_interval_ensure_failure() -> None:
    dm = _PartiallyFailingMultiStreamDataManager(emit_backfill=False)
    client = _stream_client(dm)

    with client.websocket_connect(
        "/api/v1/stream/klines_multi?symbol=BTCUSDT&market_type=futures"
    ) as ws:
        assert ws.receive_json()["type"] == "connected"
        ws.send_json({
            "action": "subscribe",
            "intervals": ["7s", "1m"],
            "request_id": "mixed-1",
        })
        warning = ws.receive_json()
        subscribed = ws.receive_json()

    assert warning["type"] == "warning"
    assert warning["failed"] == [{
        "interval": "7s",
        "error": "No exact realtime base can reconstruct 7s",
    }]
    expected_failure = [{
        "interval": "7s",
        "code": "no_exact_base",
        "message": "No exact realtime base can reconstruct 7s",
    }]
    assert subscribed == {
        "type": "subscribed",
        "exchange": "binance",
        "symbol": "BTCUSDT",
        "intervals": ["1m"],
        "requested_intervals": ["7s", "1m"],
        "failed": expected_failure,
        "active_intervals": ["1m"],
        "market_type": "futures",
        "request_id": "mixed-1",
    }
    assert [call["interval"] for call in dm.subscribe_calls] == ["1m"]


def test_kline_multi_ws_rejects_explicit_stopped_stream_info() -> None:
    dm = _StoppedStatusMultiStreamDataManager(emit_backfill=False)
    client = _stream_client(dm)

    with client.websocket_connect("/api/v1/stream/klines_multi?symbol=BTCUSDT") as ws:
        assert ws.receive_json()["type"] == "connected"
        ws.send_json({
            "action": "subscribe",
            "intervals": ["1m"],
            "request_id": "stopped-1",
        })
        assert ws.receive_json()["type"] == "warning"
        subscribed = ws.receive_json()

    assert subscribed["intervals"] == []
    assert subscribed["active_intervals"] == []
    assert subscribed["failed"] == [{
        "interval": "1m",
        "code": "stream_subscription_failed",
        "message": "stream 1m is stopped: ingestion disabled",
    }]
    assert dm.subscribe_calls == []
    assert [call["interval"] for call in dm.release_stream_calls] == ["1m"]


def test_kline_multi_ws_failing_real_coordinator_rolls_back_and_acks_failure() -> None:
    dm = DataManager()
    dm.set_ingestion_factory(_FailingKlineIngestionFactory())  # type: ignore[arg-type]
    client = _stream_client(dm)

    with client.websocket_connect("/api/v1/stream/klines_multi?symbol=BTCUSDT") as ws:
        assert ws.receive_json()["type"] == "connected"
        ws.send_json({
            "action": "subscribe",
            "intervals": ["45m"],
            "request_id": "failed-start-1",
        })
        assert ws.receive_json()["type"] == "warning"
        subscribed = ws.receive_json()

    assert subscribed["intervals"] == []
    assert subscribed["active_intervals"] == []
    assert subscribed["failed"][0]["interval"] == "45m"
    assert subscribed["failed"][0]["code"] == "stream_subscription_failed"
    assert "injected ingestion failure" in subscribed["failed"][0]["message"]
    assert dm._stream_leases == {}
    assert dm.storage_intents.snapshot()["intent_count"] == 0
    assert dm.bar_aggregator.get_targets() == []
    assert dm.coordinator.health_snapshot()["active_streams"] == 0


def test_kline_multi_ws_dedupes_semantic_interval_aliases() -> None:
    dm = _MultiStreamDataManager(emit_backfill=False)
    client = _stream_client(dm)

    with client.websocket_connect("/api/v1/stream/klines_multi?symbol=BTCUSDT") as ws:
        assert ws.receive_json()["type"] == "connected"
        ws.send_json({"action": "subscribe", "intervals": ["60m", "1h"]})
        subscribed = ws.receive_json()

    assert subscribed["intervals"] == ["1h"]
    assert [call["interval"] for call in dm.ensure_stream_calls] == ["1h"]
    assert [call["interval"] for call in dm.subscribe_calls] == ["1h"]


def test_kline_multi_ws_dynamic_ack_tracks_canonical_active_intervals() -> None:
    dm = _MultiStreamDataManager(emit_backfill=False)
    client = _stream_client(dm)

    with client.websocket_connect("/api/v1/stream/klines_multi?symbol=BTCUSDT") as ws:
        assert ws.receive_json()["type"] == "connected"

        ws.send_json({
            "action": "subscribe",
            "intervals": ["1m"],
            "request_id": "subscribe-1",
        })
        assert ws.receive_json() == {
            "type": "subscribed",
            "exchange": "binance",
            "symbol": "BTCUSDT",
            "intervals": ["1m"],
            "requested_intervals": ["1m"],
            "failed": [],
            "active_intervals": ["1m"],
            "market_type": "spot",
            "request_id": "subscribe-1",
        }

        ws.send_json({
            "action": "subscribe",
            "intervals": ["60m", "1h", "5m"],
            "request_id": "subscribe-2",
        })
        assert ws.receive_json() == {
            "type": "subscribed",
            "exchange": "binance",
            "symbol": "BTCUSDT",
            "intervals": ["1h", "5m"],
            "requested_intervals": ["1h", "5m"],
            "failed": [],
            "active_intervals": ["1h", "1m", "5m"],
            "market_type": "spot",
            "request_id": "subscribe-2",
        }

        ws.send_json({
            "action": "unsubscribe",
            "intervals": ["60m", "1h"],
            "request_id": "unsubscribe-1",
        })
        assert ws.receive_json() == {
            "type": "unsubscribed",
            "exchange": "binance",
            "symbol": "BTCUSDT",
            "intervals": ["1h"],
            "active_intervals": ["1m", "5m"],
            "market_type": "spot",
            "request_id": "unsubscribe-1",
        }
        assert len(dm.unsubscribed) == 1

    assert [call["interval"] for call in dm.ensure_stream_calls] == ["1m", "1h", "5m"]
    assert [call["interval"] for call in dm.subscribe_calls] == ["1m", "1h", "5m"]
    released = [call["interval"] for call in dm.release_stream_calls]
    assert released[0] == "1h"
    assert set(released[1:]) == {"1m", "5m"}


def test_subscriptions_prices_returns_data_manager_price_snapshot() -> None:
    dm = _PriceDataManager()
    client = _subscription_client(dm)

    response = client.get("/api/v1/subscriptions/prices")

    assert response.status_code == 200
    assert response.json() == {
        "prices": [{
            "symbol": "BTCUSDT",
            "exchange": "binance",
            "market_type": "spot",
            "price": 100.0,
        }]
    }


def test_set_subscription_tier_accepts_intervals_and_consumer_id() -> None:
    service = _SubscriptionService()
    client = _subscription_client(_SubscriptionDataManager(service))

    response = client.put(
        "/api/v1/subscriptions/okx:spot:BTC-USDT",
        json={
            "tier": "full",
            "intervals": ["1h", "45m"],
            "consumer_id": "watchlist:client-a:okx:spot:BTC-USDT",
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "symbol": "okx:spot:BTC-USDT",
        "tier": "full",
        "changed": True,
    }
    assert service.set_tier_calls == [{
        "symbol": "okx:spot:BTC-USDT",
        "tier": SubscriptionTier.FULL,
        "intervals": ["1h", "45m"],
        "consumer_id": "watchlist:client-a:okx:spot:BTC-USDT",
        "storage_intent": True,
    }]


def test_sync_watchlist_does_not_forward_interval_details() -> None:
    service = _SubscriptionService()
    client = _subscription_client(_SubscriptionDataManager(service))

    response = client.post(
        "/api/v1/subscriptions/sync",
        json={"symbols": ["spot:BTCUSDT"], "intervals": ["1h"]},
    )

    assert response.status_code == 200
    assert response.json() == {"synced": 1, "auto_registered": 1}
    assert service.set_tier_calls == [{
        "symbol": "spot:BTCUSDT",
        "tier": SubscriptionTier.PRICE_ONLY,
        "intervals": None,
        "consumer_id": None,
        "storage_intent": True,
    }]


def test_price_ws_forwards_price_updated_event_from_data_manager() -> None:
    dm = _PriceDataManager()
    client = _subscription_client(dm)

    with client.websocket_connect("/api/v1/stream/prices") as ws:
        assert ws.receive_json() == {"type": "connected"}
        assert ws.receive_json() == {
            "type": "prices",
            "data": [{
                "symbol": "BTCUSDT",
                "exchange": "binance",
                "market_type": "spot",
                "price": 100.0,
            }],
        }
        message = ws.receive_json()

    assert message == {
        "type": "prices",
        "data": [{
            "symbol": "BTCUSDT",
            "exchange": "binance",
            "market_type": "spot",
            "price": 101.0,
        }],
    }
