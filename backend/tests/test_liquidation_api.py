from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.liquidations import router as liquidation_router
from app.data_engine.ingestion.models import DataSource
from app.data_engine.market_data.liquidation import NormalizedLiquidation
from app.data_engine.market_data.models import MarketChannel, MarketStreamKey


class _LiquidationDataManager:
    liquidation_ready = True

    def __init__(self) -> None:
        self.recent_calls: list[dict] = []
        self.history_calls: list[dict] = []
        self.history_bucket_starts = [
            1_700_000_000_000,
            1_700_000_060_000,
        ]

    def liquidation_recent(
        self,
        key: MarketStreamKey,
        **kwargs,
    ) -> list[NormalizedLiquidation]:
        self.recent_calls.append({"key": key, **kwargs})
        return [_liquidation(key, sequence=1)]

    async def liquidation_history(
        self,
        key: MarketStreamKey,
        **kwargs,
    ) -> list[dict]:
        self.history_calls.append({"key": key, **kwargs})
        side = kwargs.get("position_side") or "long"
        return [
            _rollup(key, bucket_start_ms=bucket, position_side=side)
            for bucket in self.history_bucket_starts
        ]


def _client(data_manager: object | None = None) -> TestClient:
    app = FastAPI()
    app.include_router(liquidation_router, prefix="/api/v1")
    if data_manager is not None:
        app.state.data_manager = data_manager
    return TestClient(app)


def _key(symbol: str = "BTCUSDT") -> MarketStreamKey:
    return MarketStreamKey.build(
        "binance",
        "futures",
        symbol,
        MarketChannel.LIQUIDATION,
    )


def _liquidation(
    key: MarketStreamKey,
    *,
    sequence: int,
) -> NormalizedLiquidation:
    return NormalizedLiquidation(
        exchange=key.exchange,
        market_type=key.market_type,
        symbol=key.symbol,
        pair_symbol=key.symbol,
        symbol_type="UM",
        order_side="SELL",
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


def _rollup(
    key: MarketStreamKey,
    *,
    bucket_start_ms: int,
    position_side: str,
    is_final: bool = True,
) -> dict:
    return {
        "exchange": key.exchange,
        "market_type": key.market_type,
        "symbol": key.symbol,
        "period": "1m",
        "position_side": position_side,
        "bucket_start_ms": bucket_start_ms,
        "bucket_end_ms": bucket_start_ms + 59_999,
        "filled_quantity": 0.2,
        "filled_notional": 12_000,
        "event_count": 1,
        "max_event_notional": 12_000,
        "first_event_time_ms": bucket_start_ms + 1,
        "last_event_time_ms": bucket_start_ms + 1,
        "is_final": is_final,
        "revision": 1,
        "updated_at_ms": bucket_start_ms + 2,
        "source_quality": "sampled_best_effort",
    }


def _assert_quality_metadata(payload: dict) -> None:
    assert payload["source_quality"] == "sampled_best_effort"
    assert payload["source_exhaustive"] is False
    assert payload["sampling_mode"] == "latest_per_symbol_1000ms"
    assert payload["lossy_snapshot"] is True
    assert payload["backfillable"] is False
    assert payload["exchange_update_interval_ms"] == 1000


def test_liquidation_recent_returns_observed_quality_and_coverage() -> None:
    dm = _LiquidationDataManager()

    response = _client(dm).get(
        "/api/v1/liquidations/recent",
        params={"symbol": "btcusdt", "limit": 25},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["type"] == "liquidation.recent"
    assert payload["protocol"] == "liquidation.v1"
    assert payload["key"] == _key().to_dict()
    assert payload["count"] == 1
    assert payload["data"][0]["position_side"] == "long"
    assert payload["data"][0]["executed_notional"] == 12_000.2
    assert payload["coverage"] == {
        "earliest_ms": 1_700_000_000_001,
        "latest_ms": 1_700_000_000_001,
        "bounded": True,
        "observed_only": True,
    }
    _assert_quality_metadata(payload)
    assert dm.recent_calls == [{"key": _key(), "limit": 25}]


def test_liquidation_history_metadata_and_side_filter_are_explicit() -> None:
    dm = _LiquidationDataManager()

    response = _client(dm).get(
        "/api/v1/liquidations/history",
        params={
            "symbol": "ethusdt",
            "position_side": " SHORT ",
            "start_ms": 1_700_000_000_000,
            "end_ms": 1_700_000_120_000,
            "limit": 10,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    key = _key("ETHUSDT")
    assert payload["type"] == "liquidation.history"
    assert payload["protocol"] == "liquidation.v1"
    assert payload["key"] == {
        **key.to_dict(),
        "params": {"period": "1m", "position_side": "short"},
    }
    assert payload["count"] == 2
    assert payload["has_more"] is False
    assert {item["position_side"] for item in payload["data"]} == {"short"}
    assert all("updated_at_ms" in item for item in payload["data"])
    assert all("received_at_ms" not in item for item in payload["data"])
    assert payload["coverage"] == {
        "earliest_ms": 1_700_000_000_000,
        "latest_ms": 1_700_000_060_000,
        "all_rows_final": True,
        "observed_only": True,
    }
    _assert_quality_metadata(payload)
    assert dm.history_calls == [{
        "key": key,
        "position_side": "short",
        "start_ms": 1_700_000_000_000,
        "end_ms": 1_700_000_120_000,
        "limit": 11,
    }]


def test_liquidation_history_uses_exact_one_row_lookahead_and_slice_direction() -> None:
    dm = _LiquidationDataManager()
    dm.history_bucket_starts = [
        1_700_000_000_000,
        1_700_000_060_000,
        1_700_000_120_000,
    ]
    client = _client(dm)

    latest = client.get(
        "/api/v1/liquidations/history",
        params={"limit": 2},
    )
    bounded = client.get(
        "/api/v1/liquidations/history",
        params={"start_ms": 1_700_000_000_000, "limit": 2},
    )

    assert latest.status_code == bounded.status_code == 200
    assert latest.json()["has_more"] is True
    assert bounded.json()["has_more"] is True
    assert [item["bucket_start_ms"] for item in latest.json()["data"]] == [
        1_700_000_060_000,
        1_700_000_120_000,
    ]
    assert [item["bucket_start_ms"] for item in bounded.json()["data"]] == [
        1_700_000_000_000,
        1_700_000_060_000,
    ]
    assert [call["limit"] for call in dm.history_calls] == [3, 3]

    dm.history_bucket_starts = [
        1_700_000_000_000,
        1_700_000_060_000,
    ]
    exact = client.get(
        "/api/v1/liquidations/history",
        params={"limit": 2},
    )
    assert exact.status_code == 200
    assert exact.json()["has_more"] is False
    assert exact.json()["count"] == 2


def test_liquidation_history_validates_period_side_and_range() -> None:
    client = _client(_LiquidationDataManager())

    invalid_period = client.get("/api/v1/liquidations/history?period=5m")
    invalid_side = client.get(
        "/api/v1/liquidations/history?position_side=both",
    )
    invalid_range = client.get(
        "/api/v1/liquidations/history?start_ms=200&end_ms=100",
    )

    assert invalid_period.status_code == 422
    assert invalid_period.json()["detail"] == (
        "liquidation history only supports period=1m"
    )
    assert invalid_side.status_code == 422
    assert invalid_side.json()["detail"] == (
        "position_side must be 'long' or 'short'"
    )
    assert invalid_range.status_code == 422
    assert invalid_range.json()["detail"] == "start_ms must be <= end_ms"


def test_empty_liquidation_history_never_claims_final_coverage() -> None:
    dm = _LiquidationDataManager()
    dm.history_bucket_starts = []

    response = _client(dm).get("/api/v1/liquidations/history")

    assert response.status_code == 200
    assert response.json()["coverage"] == {
        "earliest_ms": None,
        "latest_ms": None,
        "all_rows_final": False,
        "observed_only": True,
    }


def test_liquidation_http_rejects_unready_and_redacts_internal_errors() -> None:
    missing = _client().get("/api/v1/liquidations/recent")
    assert missing.status_code == 503
    assert missing.json()["detail"] == "DataManager not initialized"

    class _Unready:
        liquidation_ready = False

    unready = _client(_Unready()).get("/api/v1/liquidations/history")
    assert unready.status_code == 503
    assert unready.json()["detail"] == "Liquidation service is not initialized"

    class _FailingManager(_LiquidationDataManager):
        def liquidation_recent(self, key, **kwargs):
            raise RuntimeError("https://internal.example/?token=secret")

        async def liquidation_history(self, key, **kwargs):
            raise RuntimeError("database password=secret")

    client = _client(_FailingManager())
    failed_recent = client.get("/api/v1/liquidations/recent")
    failed_history = client.get("/api/v1/liquidations/history")

    assert failed_recent.status_code == failed_history.status_code == 502
    assert failed_recent.json()["detail"] == (
        "liquidation recent is temporarily unavailable"
    )
    assert failed_history.json()["detail"] == (
        "liquidation history is temporarily unavailable"
    )
    assert "secret" not in failed_recent.text
    assert "secret" not in failed_history.text
