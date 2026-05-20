from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.exchanges import router as exchanges_router


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
    assert "protocol_features" in payload
    assert "limits" in payload


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
