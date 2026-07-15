from __future__ import annotations

from dataclasses import dataclass

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.trade_flow import router as trade_flow_router
from app.data_engine.ingestion.models import DataSource
from app.data_engine.market_data.models import MarketChannel, MarketStreamKey
from app.data_engine.market_data.trade_flow import NormalizedAggTrade
from app.data_engine.storage.raw_trade_archive import (
    RawAggTradeCoverage,
    RawAggTradeGap,
)


@dataclass
class _Failure:
    status_code: int = 429
    retry_after: int = 3


class _TradeFlowDataManager:
    trade_flow_ready = True

    def __init__(self) -> None:
        self.recent_calls: list[dict] = []
        self.history_calls: list[dict] = []
        self.coverage_calls: list[dict] = []

    def trade_flow_recent(
        self,
        key: MarketStreamKey,
        **kwargs,
    ) -> list[NormalizedAggTrade]:
        self.recent_calls.append({"key": key, **kwargs})
        return [
            NormalizedAggTrade(
                exchange=key.exchange,
                market_type=key.market_type,
                symbol=key.symbol,
                agg_trade_id=101,
                price=60_000,
                quantity=0.1,
                trade_time_ms=1_700_000_000_000,
                event_time_ms=1_700_000_000_001,
                received_at_ms=1_700_000_000_002,
                is_buyer_maker=False,
                source=DataSource.WEBSOCKET,
                first_trade_id=1001,
                last_trade_id=1002,
            )
        ]

    async def trade_flow_history(self, key: MarketStreamKey, **kwargs) -> list[dict]:
        self.history_calls.append({"key": key, **kwargs})
        return [
            {
                "exchange": key.exchange,
                "market_type": key.market_type,
                "symbol": key.symbol,
                "period": "1m",
                "bucket_start_ms": 1_700_000_000_000,
                "bucket_end_ms": 1_700_000_059_999,
                "volume_delta_base": 0.1,
                "is_complete": False,
                "is_final": True,
                "revision": 2,
            }
        ]

    async def trade_flow_archive_coverage(
        self,
        key: MarketStreamKey,
        **kwargs,
    ) -> RawAggTradeCoverage:
        self.coverage_calls.append({"key": key, **kwargs})
        return RawAggTradeCoverage(
            enabled=True,
            backend="parquet-pyarrow",
            exchange=key.exchange,
            market_type=key.market_type,
            symbol=key.symbol,
            start_time_ms=kwargs.get("start_time_ms"),
            end_time_ms=kwargs.get("end_time_ms"),
            row_count=2,
            file_count=1,
            earliest_agg_trade_id=101,
            latest_agg_trade_id=103,
            earliest_trade_time_ms=1_700_000_000_000,
            latest_trade_time_ms=1_700_000_000_200,
            gaps=(RawAggTradeGap(102, 102, 1),),
            complete=False,
        )


def _client(data_manager: object | None = None) -> TestClient:
    app = FastAPI()
    app.include_router(trade_flow_router, prefix="/api/v1")
    if data_manager is not None:
        app.state.data_manager = data_manager
    return TestClient(app)


def test_trade_flow_recent_returns_raw_agg_trade_cursor() -> None:
    dm = _TradeFlowDataManager()

    response = _client(dm).get(
        "/api/v1/trade-flow/recent",
        params={"symbol": "btcusdt", "limit": 10},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["protocol"] == "tradeflow.v1"
    assert payload["cursor"] == {
        "earliest_agg_trade_id": 101,
        "latest_agg_trade_id": 101,
    }
    assert payload["continuity"] is True
    assert payload["resync_required"] is False
    assert payload["missing_agg_trade_id_ranges"] == []
    assert payload["data"][0]["aggressor_side"] == "buy"
    assert dm.recent_calls == [
        {
            "key": MarketStreamKey.build(
                "binance",
                "futures",
                "BTCUSDT",
                MarketChannel.AGG_TRADE,
            ),
            "limit": 10,
        }
    ]


def test_trade_flow_history_is_rollup_only_and_fail_closed() -> None:
    dm = _TradeFlowDataManager()
    client = _client(dm)

    response = client.get(
        "/api/v1/trade-flow/history",
        params={"symbol": "ETHUSDT", "start_ms": 100, "limit": 2},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["key"]["params"] == {"period": "1m"}
    assert payload["coverage"]["all_rows_complete"] is False
    assert payload["data"][0]["volume_delta_base"] == 0.1

    invalid_period = client.get("/api/v1/trade-flow/history?period=5m")
    assert invalid_period.status_code == 422
    invalid_range = client.get(
        "/api/v1/trade-flow/history?start_ms=200&end_ms=100"
    )
    assert invalid_range.status_code == 422


def test_empty_history_does_not_claim_complete() -> None:
    class _EmptyManager(_TradeFlowDataManager):
        async def trade_flow_history(self, key, **kwargs):
            return []

    response = _client(_EmptyManager()).get("/api/v1/trade-flow/history")

    assert response.status_code == 200
    assert response.json()["coverage"]["all_rows_complete"] is False


def test_recent_snapshot_exposes_internal_id_gaps_fail_closed() -> None:
    class _GappedManager(_TradeFlowDataManager):
        def trade_flow_recent(self, key, **kwargs):
            rows = super().trade_flow_recent(key, **kwargs)
            rows.append(
                NormalizedAggTrade(
                    exchange=key.exchange,
                    market_type=key.market_type,
                    symbol=key.symbol,
                    agg_trade_id=104,
                    price=60_001,
                    quantity=0.1,
                    trade_time_ms=1_700_000_000_100,
                    event_time_ms=1_700_000_000_101,
                    received_at_ms=1_700_000_000_102,
                    is_buyer_maker=True,
                    source=DataSource.WEBSOCKET,
                    first_trade_id=1004,
                    last_trade_id=1005,
                )
            )
            return rows

    payload = _client(_GappedManager()).get(
        "/api/v1/trade-flow/recent"
    ).json()

    assert payload["continuity"] is False
    assert payload["resync_required"] is True
    assert payload["missing_agg_trade_id_ranges"] == [
        {"start_agg_trade_id": 102, "end_agg_trade_id": 103}
    ]


def test_trade_flow_archive_coverage_exposes_gaps_and_bounds() -> None:
    dm = _TradeFlowDataManager()

    response = _client(dm).get(
        "/api/v1/trade-flow/archive/coverage",
        params={
            "start_time_ms": 1_700_000_000_000,
            "end_time_ms": 1_700_000_001_000,
            "expected_start_agg_trade_id": 101,
            "expected_end_agg_trade_id": 103,
        },
    )

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["enabled"] is True
    assert data["backend"] == "parquet-pyarrow"
    assert data["complete"] is False
    assert data["gaps"] == [
        {
            "start_agg_trade_id": 102,
            "end_agg_trade_id": 102,
            "missing_count": 1,
        }
    ]


def test_trade_flow_http_rejects_unready_and_hides_internal_errors() -> None:
    assert _client().get("/api/v1/trade-flow/recent").status_code == 503

    class _Unready:
        trade_flow_ready = False

    unready = _client(_Unready()).get("/api/v1/trade-flow/recent")
    assert unready.status_code == 503

    class _Failing(_TradeFlowDataManager):
        def trade_flow_recent(self, key, **kwargs):
            raise RuntimeError("secret upstream response")

    failed = _client(_Failing()).get("/api/v1/trade-flow/recent")
    assert failed.status_code == 502
    assert failed.json()["detail"] == (
        "trade-flow recent is temporarily unavailable"
    )
