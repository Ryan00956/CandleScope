from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.settings import router as settings_router


class _DataManager:
    def prewarm_targets(self):
        return [("binance", "spot", "BTCUSDT")]

    def prewarm_intervals(self):
        return ("1m", "5m")

    def gap_audit_series(self):
        return [
            ("binance", "spot", "BTCUSDT", "1m"),
            ("okx", "spot", "BTC-USDT", "1m"),
        ]


class _BackfillCoordinator:
    def snapshot(self) -> dict:
        return {
            "submitted": 3,
            "deduped": 1,
            "merged": 0,
            "active": [],
            "pending": [],
            "gap_ledger_open": [{"symbol": "BTCUSDT", "interval": "1m"}],
            "recent_outcomes": {},
        }


class _BackfillEngine:
    def snapshot(self) -> dict:
        return {
            "component": "BackfillEngine",
            "fetcher": {
                "exchange_rate_limits": {
                    "binance:spot:request_weight:ip": {
                        "rule": "binance_spot_klines",
                        "algorithm": "token_bucket",
                    }
                }
            },
        }


class _Runtime:
    def __init__(self) -> None:
        self.coordinator = _BackfillCoordinator()
        self.engine = _BackfillEngine()

    def get_backfill_coordinator(self):
        return self.coordinator

    def get_backfill_engine(self):
        return self.engine


def _client(*, with_runtime: bool = True) -> TestClient:
    app = FastAPI()
    app.include_router(settings_router, prefix="/api/v1")
    if with_runtime:
        app.state.data_manager = _DataManager()
        app.state.data_engine_runtime = _Runtime()
    return TestClient(app)


def test_storage_health_returns_backfill_snapshot() -> None:
    response = _client().get("/api/v1/settings/storage/health")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["targets"] == [["binance", "spot", "BTCUSDT"]]
    assert payload["intervals"] == ["1m", "5m"]
    assert payload["audit_series"] == [
        ["binance", "spot", "BTCUSDT", "1m"],
        ["okx", "spot", "BTC-USDT", "1m"],
    ]
    assert payload["open_gap_count"] == 1
    assert payload["backfill"]["submitted"] == 3
    assert (
        payload["backfill_engine"]["fetcher"]["exchange_rate_limits"]
        ["binance:spot:request_weight:ip"]["rule"]
        == "binance_spot_klines"
    )


def test_storage_health_requires_data_engine() -> None:
    response = _client(with_runtime=False).get("/api/v1/settings/storage/health")

    assert response.status_code == 503
