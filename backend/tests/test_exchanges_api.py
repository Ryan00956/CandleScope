from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.exchanges import router as exchanges_router
from app.data_engine.market_data.kline_metrics import KLINE_DERIVED_FIELDS


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(exchanges_router, prefix="/api/v1")
    return TestClient(app)


def test_exchange_capabilities_include_plugin_contract_metadata() -> None:
    response = _client().get("/api/v1/exchanges/binance/capabilities")

    assert response.status_code == 200
    payload = response.json()
    assert payload["exchange"] == "binance"
    assert payload["plugin_api_version"] == "1.0"
    support = payload["support"]
    assert support["provider"] == "ccxt_primary"
    assert support["routable"] is True
    assert support["verification_level"] == "shadow"
    assert len(support["qualifications"]) == 2
    assert {item["market_types"][0] for item in support["qualifications"]} == {
        "spot",
        "futures",
    }
    assert support["products"]["markets"]["futures"]["order_book"] == {
        "supported": True,
        "channel": "depth",
        "mode": "snapshot",
        "snapshot_mode": "live_snapshot",
        "strict_full_depth": True,
    }
    assert support["products"]["markets"]["futures"]["trade_flow"]["mode"] == (
        "strict_repairable"
    )
    assert "protocol_features" in payload
    assert "limits" in payload
    kline = next(
        channel
        for channel in payload["channels"]
        if channel["channel"] == "kline" and channel["market_types"] == ["spot"]
    )
    assert set(kline["derived_fields"]) == set(KLINE_DERIVED_FIELDS)

    okx = _client().get("/api/v1/exchanges/okx/capabilities").json()
    okx_kline = next(
        channel for channel in okx["channels"] if channel["channel"] == "kline"
    )
    assert okx_kline["derived_fields"] == []


def test_exchange_diagnostics_reports_loaded_plugins() -> None:
    response = _client().get("/api/v1/exchanges/diagnostics")

    assert response.status_code == 200
    payload = response.json()
    assert payload["supported_plugin_api_major"] == 1
    by_id = {item["plugin_id"]: item for item in payload["plugins"]}
    assert by_id["binance"]["status"] == "loaded"
    assert by_id["okx"]["policy_classes"]["pagination"].endswith(
        "OkxHistoricalPaginationPolicy"
    )
    binance_rules = {
        rule["name"]: rule
        for rule in by_id["binance"]["rate_limit_rules"]
    }
    okx_rules = {
        rule["name"]: rule
        for rule in by_id["okx"]["rate_limit_rules"]
    }
    assert binance_rules["binance_spot_klines"]["bucket_key"] == (
        "binance:spot:request_weight:ip"
    )
    assert binance_rules["binance_spot_klines"]["algorithm"] == "header_weight"
    assert binance_rules["binance_futures_klines"]["endpoint"] == "/fapi/v1/klines"
    assert okx_rules["okx_history_candles"]["bucket_key"] == "okx:history-candles:ip"


def test_exchange_list_exposes_pinned_ccxt_catalog() -> None:
    response = _client().get("/api/v1/exchanges/")

    assert response.status_code == 200
    payload = response.json()
    assert payload["count"] == 106
    assert payload["ccxt"] == {
        "version": "4.5.60",
        "rest_exchange_ids": 105,
        "pro_exchange_ids": 77,
        "watch_ohlcv": 59,
        "watch_trades": 75,
        "watch_order_book": 76,
        "watch_ticker": 67,
        "watch_mark_price": 9,
        "watch_funding_rate": 9,
        "watch_liquidations": 10,
        "fetch_funding_rate_history": 50,
        "fetch_open_interest": 32,
        "fetch_open_interest_history": 15,
    }
    by_id = {item["exchange"]: item for item in payload["exchanges"]}
    assert "provider.ccxt_unified" in by_id["bybit"]["protocol_features"]
    bybit_support = by_id["bybit"]["support"]
    assert bybit_support["provider"] == "ccxt_unified"
    assert bybit_support["routable"] is True
    assert bybit_support["verification_level"] == "soak"
    assert bybit_support["qualification"]["duration_seconds"] == 14_400
    assert bybit_support["qualification"]["evidence_id"] == (
        "ccxt-unified-bybit-linear-4h-00e670b3-20260807T232805"
    )
    assert bybit_support["qualifications"] == [bybit_support["qualification"]]
    assert bybit_support["products"]["markets"]["swap.linear"]["trade_flow"] == {
        "supported": True,
        "channel": "trade",
        "mode": "observational",
        "sequence_continuity": False,
        "history": False,
        "delivery_mode": "live_stream",
    }
    bybit_advanced = bybit_support["products"]["markets"]["swap.linear"][
        "advanced_market_data"
    ]
    assert bybit_advanced["channels"]["funding_rate"] == {
        "supported": True,
        "realtime": True,
        "history": True,
        "delivery_mode": "polling_snapshot",
    }
    assert bybit_advanced["channels"]["open_interest"] == {
        "supported": True,
        "realtime": True,
        "history": True,
        "delivery_mode": "polling_snapshot",
    }
    assert bybit_advanced["channels"]["liquidation"]["delivery_mode"] == (
        "live_observational"
    )
    assert by_id["aster"]["support"] == {
        "provider": "ccxt_unified",
        "routable": False,
        "verification_level": "catalog_only",
        "qualification": None,
        "qualifications": [],
        "products": {"markets": {}},
    }
    assert not any(
        "trade, and depth are not exposed" in limitation
        for limitation in by_id["okx"]["known_limitations"]
    )
