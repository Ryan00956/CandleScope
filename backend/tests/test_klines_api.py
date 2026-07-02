from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.klines import _schedule_related_interval_warmup, router as klines_router
from app.data_engine.data_manager import DataManager
from app.data_engine.data_manager.models import BarData, QueryResult, QuerySource


class _FakeDataManager:
    def __init__(self) -> None:
        self.ensure_stream_calls: list[dict] = []
        self.release_stream_calls: list[dict] = []
        self.query_latest_calls: list[dict] = []

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
            "focus_scope": "rest",
            "consumer_id": dm.ensure_stream_calls[0]["consumer_id"],
        }
    ]
    assert dm.ensure_stream_calls[0]["consumer_id"].startswith(
        "rest:klines:binance:spot:BTCUSDT:1m:"
    )
    assert dm.release_stream_calls == [
        {
            "symbol": "BTCUSDT",
            "interval": "1m",
            "exchange": "binance",
            "market_type": "spot",
            "focus_scope": "rest",
            "consumer_id": dm.ensure_stream_calls[0]["consumer_id"],
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
    assert len(calls) == 4
    symbol, interval, start_ms, end_ms, exchange, market_type = calls[0]
    assert (symbol, interval, exchange, market_type) == ("BTCUSDT", "1h", "binance", "spot")
    assert start_ms < end_ms
    assert [call[1] for call in calls[1:]] == ["15m", "4h", "5m"]


def test_history_count_back_overrides_days_window() -> None:
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
            "days": 30,
            "count_back": 10,
            "max_wait_ms": 0,
            "exchange": "binance",
            "market_type": "spot",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["count_back"] == 10
    _symbol, _interval, start_ms, end_ms, _exchange, _market_type = calls[0]
    assert end_ms - start_ms == 9 * 60 * 60 * 1000


def test_latest_endpoint_does_not_trigger_backfill_when_storage_is_empty() -> None:
    calls: list[tuple] = []
    dm = DataManager()
    dm.set_backfill_trigger(lambda *args, **kwargs: calls.append((args, kwargs)))
    client = _client(dm)

    response = client.get(
        "/api/v1/klines/latest",
        params={
            "symbol": "BTCUSDT",
            "interval": "1m",
            "limit": 5,
            "exchange": "binance",
            "market_type": "spot",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["count"] == 0
    assert payload["backfill_triggered"] is False
    assert calls == []


def test_history_endpoint_submits_initial_history_demand_metadata() -> None:
    calls: list[tuple[tuple, dict]] = []
    dm = DataManager()
    dm.set_backfill_trigger(lambda *args, **kwargs: calls.append((args, kwargs)))
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
    assert len(calls) == 4
    args, kwargs = calls[0]
    assert args[0:2] == ("BTCUSDT", "1h")
    assert kwargs["reason"] == "initial_history"
    assert kwargs["priority"] == 10
    assert kwargs["requester"] == "klines_history"
    assert kwargs["metadata"]["query_reason"] == "query_empty"

    related = calls[1:]
    assert [item[0][1] for item in related] == ["15m", "4h", "5m"]
    assert all(item[1]["reason"] == "related_interval_warmup" for item in related)
    assert all(item[1]["priority"] == 40 for item in related)
    assert all(item[1]["requester"] == "klines_history_related" for item in related)
    assert related[0][1]["metadata"]["focus_scope"] == "related"
    assert related[0][1]["metadata"]["current_interval"] == "1h"


def test_range_query_reports_exact_visible_gap() -> None:
    class _RangeDataManager:
        def query(
            self,
            symbol: str,
            interval: str,
            *,
            start_ms: int,
            end_ms: int,
            limit: int,
            exchange: str,
            market_type: str,
            auto_backfill: bool | None = None,
        ) -> QueryResult:
            assert (start_ms, end_ms, limit) == (60_000, 180_000, 102)
            assert auto_backfill is False
            return QueryResult(
                bars=[
                    BarData(time=60, open=1, high=2, low=1, close=2, volume=10),
                    BarData(time=180, open=3, high=4, low=3, close=4, volume=30),
                ],
                symbol=symbol,
                interval=interval,
                exchange=exchange,
                market_type=market_type,
                source=QuerySource.STORAGE,
                total=2,
            )

    client = _client(_RangeDataManager())

    response = client.get(
        "/api/v1/klines/range",
        params={
            "symbol": "BTCUSDT",
            "interval": "1m",
            "start_ms": 60_000,
            "end_ms": 180_000,
            "exchange": "binance",
            "market_type": "spot",
            "repair": "none",
            "strict": "true",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["verified_contiguous"] is False
    assert payload["renderable"] is False
    assert payload["missing_ranges"] == [
        {
            "symbol": "BTCUSDT",
            "interval": "1m",
            "exchange": "binance",
            "market_type": "spot",
            "start_ms": 120_000,
            "end_ms": 120_000,
            "missing_bars": 1,
            "reason": "range_verification",
            "status": "detected",
        }
    ]


def test_range_query_caps_huge_range_from_newest_end() -> None:
    class _CappedRangeDataManager:
        def __init__(self) -> None:
            self.calls: list[dict] = []

        def query(
            self,
            symbol: str,
            interval: str,
            *,
            start_ms: int,
            end_ms: int,
            limit: int,
            exchange: str,
            market_type: str,
            auto_backfill: bool | None = None,
        ) -> QueryResult:
            self.calls.append({
                "start_ms": start_ms,
                "end_ms": end_ms,
                "limit": limit,
                "auto_backfill": auto_backfill,
            })
            bars = [
                BarData(
                    time=(start_ms // 1000) + (index * 60),
                    open=1,
                    high=2,
                    low=1,
                    close=2,
                    volume=10,
                )
                for index in range(5_000)
            ]
            return QueryResult(
                bars=bars,
                symbol=symbol,
                interval=interval,
                exchange=exchange,
                market_type=market_type,
                source=QuerySource.STORAGE,
                total=len(bars),
            )

    dm = _CappedRangeDataManager()
    client = _client(dm)

    response = client.get(
        "/api/v1/klines/range",
        params={
            "symbol": "BTCUSDT",
            "interval": "1m",
            "start_ms": 60_000,
            "end_ms": 360_060_000,
            "exchange": "binance",
            "market_type": "spot",
            "repair": "none",
            "strict": "true",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    expected_query_start = 360_060_000 - (4_999 * 60_000)
    assert dm.calls == [{
        "start_ms": expected_query_start,
        "end_ms": 360_060_000,
        "limit": 5_000,
        "auto_backfill": False,
    }]
    assert payload["truncated"] is True
    assert payload["query_start_ms"] == expected_query_start
    assert payload["query_end_ms"] == 360_060_000
    assert payload["next_end_ms"] == expected_query_start - 60_000
    assert payload["expected_bars"] == 5_000
    assert payload["actual_bars"] == 5_000
    assert payload["verified_contiguous"] is True


def test_related_interval_warmup_caps_each_interval_to_target_bars() -> None:
    class _WarmupDataManager:
        def __init__(self) -> None:
            self.calls: list[tuple[tuple, dict]] = []

        def request_backfill(self, *args, **kwargs) -> None:
            self.calls.append((args, kwargs))

    dm = _WarmupDataManager()

    _schedule_related_interval_warmup(
        dm,
        symbol="BTCUSDT",
        current_interval="1d",
        start_ms=0,
        end_ms=10_000_000_000,
        exchange="binance",
        market_type="spot",
    )

    by_interval = {args[1]: (args, kwargs) for args, kwargs in dm.calls}
    assert list(by_interval) == ["4h", "1h", "15m"]
    args, kwargs = by_interval["15m"]
    assert args[2] == 10_000_000_000 - (1_000 * 15 * 60 * 1_000)
    assert args[3] == 10_000_000_000
    assert kwargs["metadata"]["visible_range"] == {"start_ms": 0, "end_ms": 10_000_000_000}
    assert kwargs["metadata"]["warmup_range"] == {
        "start_ms": args[2],
        "end_ms": 10_000_000_000,
        "target_bars": 1_000,
    }


def test_continuity_endpoint_returns_storage_gap_report() -> None:
    class _ContinuityDataManager:
        def __init__(self) -> None:
            self.calls: list[dict] = []

        def scan_storage_gaps(
            self,
            symbol: str,
            interval: str,
            *,
            start_ms: int | None,
            end_ms: int | None,
            exchange: str,
            market_type: str,
            limit: int,
        ) -> dict:
            self.calls.append({
                "symbol": symbol,
                "interval": interval,
                "start_ms": start_ms,
                "end_ms": end_ms,
                "exchange": exchange,
                "market_type": market_type,
                "limit": limit,
            })
            return {
                "exchange": exchange,
                "market_type": market_type,
                "symbol": symbol,
                "interval": interval,
                "gaps": [{
                    "start_ms": 120_000,
                    "end_ms": 120_000,
                    "missing_bars": 1,
                    "reason": "interior_gap",
                    "status": "detected",
                }],
                "gap_count": 1,
                "missing_bars": 1,
                "scanned_bars": 2,
                "truncated": False,
            }

    dm = _ContinuityDataManager()
    client = _client(dm)

    response = client.get(
        "/api/v1/klines/continuity",
        params={
            "symbol": "BTCUSDT",
            "interval": "1m",
            "start_ms": 60_000,
            "end_ms": 180_000,
            "exchange": "binance",
            "market_type": "spot",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["verified_contiguous"] is False
    assert payload["gap_count"] == 1
    assert dm.calls == [{
        "symbol": "BTCUSDT",
        "interval": "1m",
        "start_ms": 60_000,
        "end_ms": 180_000,
        "exchange": "binance",
        "market_type": "spot",
        "limit": 50_000,
    }]
