from __future__ import annotations

import asyncio
from decimal import Decimal

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.full_order_book import (
    router as full_order_book_router,
    serialize_record,
)
from app.data_engine.ingestion.models import DataSource
from app.data_engine.market_data.events import HubRecord, MarketStateEvent
from app.data_engine.market_data.models import MarketChannel, MarketStreamKey


class _FullOrderBookDataManager:
    full_order_book_ready = True

    def __init__(self) -> None:
        self.ensure_calls: list[tuple[MarketStreamKey, str]] = []
        self.wait_calls: list[tuple[MarketStreamKey, float]] = []
        self.release_calls: list[tuple[MarketStreamKey, str]] = []

    async def ensure_full_order_book_stream(
        self,
        key: MarketStreamKey,
        *,
        consumer_id: str,
    ) -> bool:
        self.ensure_calls.append((key, consumer_id))
        return True

    async def wait_for_full_order_book_snapshot(
        self,
        key: MarketStreamKey,
        *,
        timeout_seconds: float,
    ) -> HubRecord:
        self.wait_calls.append((key, timeout_seconds))
        return _record(key, update_id=42)

    async def release_full_order_book_stream(
        self,
        key: MarketStreamKey,
        *,
        consumer_id: str,
    ) -> bool:
        self.release_calls.append((key, consumer_id))
        return True


def _client(data_manager: object | None = None) -> TestClient:
    app = FastAPI()
    app.include_router(full_order_book_router, prefix="/api/v1")
    if data_manager is not None:
        app.state.data_manager = data_manager
    return TestClient(app)


def _key(
    symbol: str = "BTCUSDT",
    *,
    market_type: str = "futures",
    update_interval_ms: int = 250,
) -> MarketStreamKey:
    return MarketStreamKey.build(
        "binance",
        market_type,
        symbol,
        MarketChannel.FULL_DEPTH,
        params={
            "mode": "full",
            "snapshot_limit": 1000,
            "update_interval_ms": update_interval_ms,
        },
    )


def _record(
    key: MarketStreamKey,
    *,
    update_id: int,
    bids: list[list[float]] | None = None,
    asks: list[list[float]] | None = None,
    exchange_full_depth_exhaustive: bool | None = None,
) -> HubRecord:
    bid_levels = bids or [[100.0, 1.0], [99.0, 2.0], [98.0, 3.0]]
    ask_levels = asks or [[101.0, 1.0], [102.0, 2.0], [103.0, 3.0]]
    return HubRecord(
        event=MarketStateEvent(
            key=key,
            event_time_ms=1_700_000_000_000 + update_id,
            received_at_ms=1_700_000_000_010 + update_id,
            source=DataSource.WEBSOCKET,
            sequence=update_id,
            data={
                "state": "live",
                "live": True,
                "last_update_id": update_id,
                "snapshot_limit": 1000,
                "update_interval_ms": int(dict(key.params)["update_interval_ms"]),
                "book_bid_levels": len(bid_levels),
                "book_ask_levels": len(ask_levels),
                "best_bid_price": bid_levels[0][0],
                "best_ask_price": ask_levels[0][0],
                "mid_price": (bid_levels[0][0] + ask_levels[0][0]) / 2,
                "bids": bid_levels,
                "asks": ask_levels,
                **(
                    {"exchange_full_depth_exhaustive": exchange_full_depth_exhaustive}
                    if exchange_full_depth_exhaustive is not None
                    else {}
                ),
            },
        ),
        revision=1,
    )


def test_full_order_book_http_returns_live_trimmed_projection_contract() -> None:
    dm = _FullOrderBookDataManager()
    response = _client(dm).get(
        "/api/v1/full-order-book/snapshot",
        params={
            "symbol": "ethusdt",
            "update_interval_ms": 100,
            "limit": 2,
            "wait_ms": 2500,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["type"] == "full_order_book.snapshot"
    assert payload["protocol"] == "orderbook.full.v1"
    assert payload["delivery"] == "atomic_snapshot"
    assert payload["source_delivery"] == "ordered_delta"
    assert payload["backend_sequence_continuity"] is True
    assert payload["fail_closed_on_gap"] is True
    assert payload["upstream_snapshot_limit"] == 1000
    assert payload["output_limit"] == 2
    assert payload["persisted"] is False
    assert payload["backfillable"] is False
    assert payload["data"]["key"] == _key(
        "ETHUSDT",
        update_interval_ms=100,
    ).to_dict()
    assert payload["data"]["data"]["bids"] == [[100.0, 1.0], [99.0, 2.0]]
    assert payload["data"]["data"]["asks"] == [[101.0, 1.0], [102.0, 2.0]]
    assert payload["data"]["data"]["book_bid_levels"] == 3
    assert payload["data"]["data"]["projection_depth"] == 2
    assert payload["data"]["data"]["full_projection"] is False
    assert dm.wait_calls == [(dm.ensure_calls[0][0], 2.5)]
    assert dm.release_calls == dm.ensure_calls


def test_full_order_book_http_marks_projection_full_when_limit_covers_local_book() -> None:
    dm = _FullOrderBookDataManager()
    response = _client(dm).get(
        "/api/v1/full-order-book/snapshot",
        params={"symbol": "BTCUSDT", "limit": 100},
    )

    assert response.status_code == 200
    data = response.json()["data"]["data"]
    assert len(data["bids"]) == 3
    assert len(data["asks"]) == 3
    assert data["projection_depth"] is None
    assert data["full_projection"] is True


def test_full_order_book_projection_groups_before_clipping_with_safe_side_rounding() -> None:
    record = _record(
        _key(),
        update_id=43,
        bids=[[100.9, 1.0], [100.2, 2.0], [99.8, 3.0]],
        asks=[[101.1, 4.0], [101.9, 5.0], [102.2, 6.0]],
    )

    data = serialize_record(
        record,
        limit=2,
        price_grouping="10",
        price_tick_size=Decimal("0.1"),
    )["data"]

    assert data["bids"] == [[100.0, 3.0], [99.0, 3.0]]
    assert data["asks"] == [[102.0, 9.0], [103.0, 6.0]]
    assert data["best_bid_price"] == 100.9
    assert data["best_ask_price"] == 101.1
    assert data["price_tick_size"] == 0.1
    assert data["price_step"] == 1.0
    assert data["price_grouping"] == "10"
    assert data["aggregation_applied"] is True
    assert data["aggregation_source_bid_levels"] == 3
    assert data["bucket_bid_levels"] == 2
    assert data["full_projection"] is True


def test_full_order_book_auto_grouping_uses_symbol_scale_and_degrades_without_tick() -> None:
    record = _record(
        _key(),
        update_id=44,
        bids=[[60_000.9, 1.0], [60_000.2, 2.0]],
        asks=[[60_001.1, 3.0], [60_001.9, 4.0]],
    )

    automatic = serialize_record(
        record,
        limit=20,
        price_grouping="auto",
        price_tick_size=Decimal("0.1"),
    )["data"]
    unavailable = serialize_record(
        record,
        limit=20,
        price_grouping="1000",
        price_tick_size=None,
    )["data"]

    assert automatic["price_step"] == 1.0
    assert automatic["aggregation_applied"] is True
    assert unavailable["price_step"] is None
    assert unavailable["aggregation_applied"] is False
    assert unavailable["bids"] == [[60_000.9, 1.0], [60_000.2, 2.0]]


def test_full_order_book_omits_incomplete_outer_bucket_from_bounded_source() -> None:
    record = _record(
        _key(),
        update_id=45,
        bids=[[100.9, 1.0], [100.2, 2.0], [99.8, 3.0]],
        asks=[[101.1, 4.0], [101.9, 5.0], [102.2, 6.0]],
        exchange_full_depth_exhaustive=False,
    )

    data = serialize_record(
        record,
        limit=20,
        price_grouping="10",
        price_tick_size=Decimal("0.1"),
    )["data"]

    assert data["bids"] == [[100.0, 3.0]]
    assert data["asks"] == [[102.0, 9.0]]
    assert data["incomplete_outer_bid_bucket_omitted"] is True
    assert data["incomplete_outer_ask_bucket_omitted"] is True
    assert data["bucket_bid_levels"] == 2
    assert data["bucket_ask_levels"] == 2
    assert data["price_window_bid_truncated"] is False
    assert data["price_window_ask_truncated"] is False
    assert data["projection_depth"] == 20
    assert data["full_projection"] is False


def test_full_order_book_limits_sparse_levels_to_near_price_window() -> None:
    record = _record(
        _key(),
        update_id=46,
        bids=[[100.9, 1.0], [99.8, 2.0], [50.0, 3.0]],
        asks=[[101.1, 4.0], [102.2, 5.0], [150.0, 6.0]],
        exchange_full_depth_exhaustive=False,
    )

    data = serialize_record(
        record,
        limit=3,
        price_grouping="10",
        price_tick_size=Decimal("0.1"),
    )["data"]

    assert data["bids"] == [[100.0, 1.0], [99.0, 2.0]]
    assert data["asks"] == [[102.0, 4.0], [103.0, 5.0]]
    assert data["bucket_bid_levels"] == 3
    assert data["bucket_ask_levels"] == 3
    assert data["price_window_bid_truncated"] is True
    assert data["price_window_ask_truncated"] is True
    assert data["incomplete_outer_bid_bucket_omitted"] is False
    assert data["incomplete_outer_ask_bucket_omitted"] is False
    assert data["full_projection"] is False


def test_full_order_book_http_supports_spot_with_market_default_cadence() -> None:
    dm = _FullOrderBookDataManager()
    response = _client(dm).get(
        "/api/v1/full-order-book/snapshot?market_type=spot&symbol=ethusdt",
    )

    assert response.status_code == 200
    assert response.json()["data"]["key"] == _key(
        "ETHUSDT",
        market_type="spot",
        update_interval_ms=1000,
    ).to_dict()
    assert dm.release_calls == dm.ensure_calls


def test_full_order_book_http_rejects_unsupported_contract_before_leasing() -> None:
    dm = _FullOrderBookDataManager()
    client = _client(dm)

    assert client.get(
        "/api/v1/full-order-book/snapshot?update_interval_ms=1000",
    ).status_code == 422
    assert client.get(
        "/api/v1/full-order-book/snapshot?market_type=margin",
    ).status_code == 422
    assert client.get(
        "/api/v1/full-order-book/snapshot?market_type=spot&update_interval_ms=250",
    ).status_code == 422
    assert client.get(
        "/api/v1/full-order-book/snapshot?limit=1001",
    ).status_code == 422
    assert client.get(
        "/api/v1/full-order-book/snapshot?price_grouping=7",
    ).status_code == 422
    assert dm.ensure_calls == []


def test_full_order_book_http_timeout_and_internal_errors_release_and_redact() -> None:
    class _TimeoutManager(_FullOrderBookDataManager):
        async def wait_for_full_order_book_snapshot(self, key, *, timeout_seconds):
            raise asyncio.TimeoutError

    timeout_dm = _TimeoutManager()
    timeout = _client(timeout_dm).get("/api/v1/full-order-book/snapshot")
    assert timeout.status_code == 504
    assert timeout_dm.release_calls == timeout_dm.ensure_calls

    class _FailingManager(_FullOrderBookDataManager):
        async def wait_for_full_order_book_snapshot(self, key, *, timeout_seconds):
            raise OSError("wss://internal.example/?token=secret")

    failing_dm = _FailingManager()
    failed = _client(failing_dm).get("/api/v1/full-order-book/snapshot")
    assert failed.status_code == 502
    assert failed.json()["detail"] == (
        "full order-book upstream is temporarily unavailable"
    )
    assert "secret" not in failed.text
    assert failing_dm.release_calls == failing_dm.ensure_calls


def test_full_order_book_http_reports_missing_and_unready_manager() -> None:
    missing = _client().get("/api/v1/full-order-book/snapshot")
    assert missing.status_code == 503
    assert missing.json()["detail"] == "DataManager not initialized"

    class _Unready:
        full_order_book_ready = False

    unready = _client(_Unready()).get("/api/v1/full-order-book/snapshot")
    assert unready.status_code == 503
    assert unready.json()["detail"] == "Full order-book service is not initialized"
