from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.klines import router as klines_router
from app.data_engine.data_manager import DataManager
from app.data_engine.data_manager.models import BarData, QueryResult, QuerySource


class _FakeDataManager:
    def __init__(self) -> None:
        self.ensure_stream_calls: list[dict] = []
        self.query_latest_calls: list[dict] = []

    async def ensure_stream(
        self,
        symbol: str,
        interval: str,
        *,
        exchange: str,
        market_type: str,
    ) -> None:
        self.ensure_stream_calls.append({
            "symbol": symbol,
            "interval": interval,
            "exchange": exchange,
            "market_type": market_type,
        })

    def query_latest(
        self,
        symbol: str,
        interval: str,
        limit: int,
        exchange: str = "binance",
        *,
        market_type: str = "spot",
    ) -> QueryResult:
        self.query_latest_calls.append({
            "symbol": symbol,
            "interval": interval,
            "limit": limit,
            "exchange": exchange,
            "market_type": market_type,
        })
        bars = [
            BarData(
                time=1_700_000_000,
                open=1,
                high=2,
                low=0.5,
                close=1.5,
                volume=10,
            )
        ]
        return QueryResult(
            bars=bars,
            symbol=symbol,
            interval=interval,
            exchange=exchange,
            market_type=market_type,
            source=QuerySource.CACHE,
            total=len(bars),
            metadata={"cache_hit": True},
        )


def _client(data_manager=None) -> TestClient:
    app = FastAPI()
    app.include_router(klines_router, prefix="/api/v1")
    if data_manager is not None:
        app.state.data_manager = data_manager
    return TestClient(app)


def test_get_klines_returns_503_without_data_manager() -> None:
    client = _client()

    response = client.get("/api/v1/klines/", params={"symbol": "BTCUSDT", "interval": "1m"})

    assert response.status_code == 503
    assert response.json()["detail"] == "DataManager 尚未初始化"


def test_get_klines_uses_data_manager_when_available() -> None:
    dm = _FakeDataManager()
    client = _client(dm)

    response = client.get(
        "/api/v1/klines/",
        params={
            "symbol": "btcusdt",
            "interval": "1m",
            "limit": 1,
            "exchange": "binance",
            "market_type": "spot",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["exchange"] == "binance"
    assert payload["market_type"] == "spot"
    assert payload["symbol"] == "BTCUSDT"
    assert payload["interval"] == "1m"
    assert payload["count"] == 1
    assert payload["source"] == "cache"
    assert payload["fetched"] == 1
    assert payload["cache"] == {"cache_hit": True}
    assert payload["data"] == [
        {
            "time": 1_700_000_000,
            "open": 1,
            "high": 2,
            "low": 0.5,
            "close": 1.5,
            "volume": 10,
        }
    ]
    assert dm.ensure_stream_calls == [
        {
            "symbol": "BTCUSDT",
            "interval": "1m",
            "exchange": "binance",
            "market_type": "spot",
        }
    ]
    assert dm.query_latest_calls == [
        {
            "symbol": "BTCUSDT",
            "interval": "1m",
            "limit": 1,
            "exchange": "binance",
            "market_type": "spot",
        }
    ]


def test_history_query_triggers_data_manager_backfill_request_when_empty() -> None:
    calls: list[tuple[str, str, int, int, str, str]] = []
    dm = DataManager()
    dm.set_backfill_trigger(
        lambda symbol, interval, start_ms, end_ms, exchange, market_type: calls.append(
            (symbol, interval, start_ms, end_ms, exchange, market_type)
        )
    )
    client = _client(dm)

    response = client.get(
        "/api/v1/klines/history",
        params={
            "symbol": "BTCUSDT",
            "interval": "1h",
            "days": 0.001,
            "exchange": "binance",
            "market_type": "spot",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["symbol"] == "BTCUSDT"
    assert payload["interval"] == "1h"
    assert payload["count"] == 0
    assert payload["source"] == "empty"
    assert payload["backfill_triggered"] is True
    assert len(calls) == 1
    symbol, interval, start_ms, end_ms, exchange, market_type = calls[0]
    assert (symbol, interval, exchange, market_type) == ("BTCUSDT", "1h", "binance", "spot")
    assert start_ms < end_ms
