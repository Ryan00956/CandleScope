from __future__ import annotations

import asyncio

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1 import symbols as symbols_api
from app.api.v1.order_book import router as order_book_router
from app.data_engine.ingestion.models import DataSource
from app.data_engine.market_data.events import HubRecord, MarketStateEvent
from app.data_engine.market_data.models import MarketChannel, MarketStreamKey


class _OrderBookDataManager:
    order_book_ready = True

    def __init__(self) -> None:
        self.ensure_calls: list[tuple[MarketStreamKey, str]] = []
        self.wait_calls: list[tuple[MarketStreamKey, float]] = []
        self.release_calls: list[tuple[MarketStreamKey, str]] = []

    async def ensure_order_book_stream(
        self,
        key: MarketStreamKey,
        *,
        consumer_id: str,
    ) -> bool:
        self.ensure_calls.append((key, consumer_id))
        return True

    async def wait_for_order_book_snapshot(
        self,
        key: MarketStreamKey,
        *,
        timeout_seconds: float,
    ) -> HubRecord:
        self.wait_calls.append((key, timeout_seconds))
        return _record(key, update_id=42)

    async def release_order_book_stream(
        self,
        key: MarketStreamKey,
        *,
        consumer_id: str,
    ) -> bool:
        self.release_calls.append((key, consumer_id))
        return True


def _client(data_manager: object | None = None) -> TestClient:
    app = FastAPI()
    app.include_router(order_book_router, prefix="/api/v1")
    if data_manager is not None:
        app.state.data_manager = data_manager
    return TestClient(app)


def _key(
    symbol: str = "BTCUSDT",
    *,
    market_type: str = "futures",
    depth_levels: int = 20,
    update_interval_ms: int = 250,
) -> MarketStreamKey:
    return MarketStreamKey.build(
        "binance",
        market_type,
        symbol,
        MarketChannel.DEPTH,
        params={
            "mode": "partial",
            "depth_levels": depth_levels,
            "update_interval_ms": update_interval_ms,
        },
    )


def _record(key: MarketStreamKey, *, update_id: int) -> HubRecord:
    params = dict(key.params)
    return HubRecord(
        event=MarketStateEvent(
            key=key,
            event_time_ms=1_700_000_000_000 + update_id,
            received_at_ms=1_700_000_000_010 + update_id,
            source=DataSource.WEBSOCKET,
            sequence=update_id,
            data={
                "last_update_id": update_id,
                "depth_levels": int(params.get("depth_levels", 20)),
                "update_interval_ms": int(
                    params.get("update_interval_ms", 250),
                ),
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
        ),
        revision=1,
    )


def test_order_book_http_transient_lease_returns_explicit_snapshot_contract() -> None:
    dm = _OrderBookDataManager()

    response = _client(dm).get(
        "/api/v1/order-book/snapshot",
        params={
            "symbol": "ethusdt",
            "depth_levels": 10,
            "update_interval_ms": 100,
            "wait_ms": 1500,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["type"] == "order_book.snapshot"
    assert payload["protocol"] == "orderbook.v1"
    assert payload["delivery"] == "latest_snapshot"
    assert payload["full_depth"] is False
    assert payload["backfillable"] is False
    assert payload["persisted"] is False
    assert payload["data"]["key"] == _key(
        "ETHUSDT",
        depth_levels=10,
        update_interval_ms=100,
    ).to_dict()
    assert payload["data"]["data"]["last_update_id"] == 42
    assert dm.wait_calls == [(dm.ensure_calls[0][0], 1.5)]
    assert dm.release_calls == dm.ensure_calls


def test_order_book_http_exposes_cached_price_tick_for_client_side_small_grouping(
    monkeypatch,
) -> None:
    monkeypatch.setitem(
        symbols_api._symbol_cache,
        ("binance", "futures"),
        [{"symbol": "BTCUSDT", "priceTickSize": "0.1"}],
    )

    response = _client(_OrderBookDataManager()).get(
        "/api/v1/order-book/snapshot?symbol=BTCUSDT",
    )

    assert response.status_code == 200
    data = response.json()["data"]["data"]
    assert data["price_tick_size"] == 0.1
    assert data["price_step"] == 0.1
    assert data["price_grouping"] == "raw"
    assert data["aggregation_applied"] is False


def test_order_book_http_supports_spot_with_market_default_cadence() -> None:
    dm = _OrderBookDataManager()
    response = _client(dm).get(
        "/api/v1/order-book/snapshot?market_type=spot&symbol=ethusdt",
    )

    assert response.status_code == 200
    assert response.json()["data"]["key"] == _key(
        "ETHUSDT",
        market_type="spot",
        update_interval_ms=1000,
    ).to_dict()
    assert dm.release_calls == dm.ensure_calls


def test_order_book_http_supports_capability_routed_ccxt_snapshot_market() -> None:
    dm = _OrderBookDataManager()
    response = _client(dm).get(
        "/api/v1/order-book/snapshot",
        params={
            "exchange": "bybit",
            "market_type": "swap.linear",
            "symbol": "BTC/USDT:USDT",
        },
    )

    assert response.status_code == 200
    key = response.json()["data"]["key"]
    assert key["exchange"] == "bybit"
    assert key["market_type"] == "swap.linear"
    assert key["symbol"] == "BTC/USDT:USDT"
    assert key["params"]["update_interval_ms"] == "1000"
    assert dm.release_calls == dm.ensure_calls


def test_order_book_http_supports_rest_only_ccxt_snapshot_market() -> None:
    dm = _OrderBookDataManager()
    response = _client(dm).get(
        "/api/v1/order-book/snapshot",
        params={
            "exchange": "bigone",
            "market_type": "spot",
            "symbol": "BTC/USDT",
        },
    )

    assert response.status_code == 200
    key = response.json()["data"]["key"]
    assert key["exchange"] == "bigone"
    assert key["market_type"] == "spot"
    assert key["params"]["update_interval_ms"] == "1000"
    assert dm.release_calls == dm.ensure_calls


def test_rest_only_snapshot_cadence_respects_slower_ccxt_rate_limit() -> None:
    dm = _OrderBookDataManager()
    response = _client(dm).get(
        "/api/v1/order-book/snapshot",
        params={
            "exchange": "bit2c",
            "market_type": "spot",
            "symbol": "BTC/NIS",
        },
    )

    assert response.status_code == 200
    assert response.json()["data"]["key"]["params"]["update_interval_ms"] == "3000"


def test_order_book_http_rejects_unsupported_contract_before_leasing() -> None:
    dm = _OrderBookDataManager()
    client = _client(dm)

    bad_levels = client.get(
        "/api/v1/order-book/snapshot?depth_levels=50",
    )
    bad_speed = client.get(
        "/api/v1/order-book/snapshot?update_interval_ms=1000",
    )
    bad_market = client.get(
        "/api/v1/order-book/snapshot?market_type=margin",
    )
    bad_spot_speed = client.get(
        "/api/v1/order-book/snapshot?market_type=spot&update_interval_ms=250",
    )

    assert bad_levels.status_code == 422
    assert bad_speed.status_code == 422
    assert bad_market.status_code == 422
    assert bad_spot_speed.status_code == 422
    assert dm.ensure_calls == []


def test_order_book_http_timeout_and_internal_errors_release_and_redact() -> None:
    class _TimeoutManager(_OrderBookDataManager):
        async def wait_for_order_book_snapshot(self, key, *, timeout_seconds):
            raise asyncio.TimeoutError

    timeout_dm = _TimeoutManager()
    timeout = _client(timeout_dm).get("/api/v1/order-book/snapshot")
    assert timeout.status_code == 504
    assert timeout_dm.release_calls == timeout_dm.ensure_calls

    class _FailingManager(_OrderBookDataManager):
        async def wait_for_order_book_snapshot(self, key, *, timeout_seconds):
            raise OSError("wss://internal.example/?token=secret")

    failing_dm = _FailingManager()
    failed = _client(failing_dm).get("/api/v1/order-book/snapshot")
    assert failed.status_code == 502
    assert failed.json()["detail"] == "order-book upstream is temporarily unavailable"
    assert "secret" not in failed.text
    assert failing_dm.release_calls == failing_dm.ensure_calls


def test_order_book_http_reports_missing_and_unready_manager() -> None:
    missing = _client().get("/api/v1/order-book/snapshot")
    assert missing.status_code == 503
    assert missing.json()["detail"] == "DataManager not initialized"

    class _Unready:
        order_book_ready = False

    unready = _client(_Unready()).get("/api/v1/order-book/snapshot")
    assert unready.status_code == 503
    assert unready.json()["detail"] == "Order-book service is not initialized"
