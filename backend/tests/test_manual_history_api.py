from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.manual_history import router as manual_history_router


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(manual_history_router, prefix="/api/v1")
    return TestClient(app)


NOW_MS = 1_780_000_000_000
START_MS = 1_700_000_000_000


def test_plan_endpoint_is_read_only_and_expands_targets(monkeypatch) -> None:
    from tests.test_manual_history_planner import FakeResolver, NOW_MS

    monkeypatch.setattr(
        "app.api.v1.manual_history.MANUAL_HISTORY_DOWNLOAD_ENABLED",
        True,
    )

    def fake_build_planner(*, feature_enabled: bool):
        from app.data_engine.manual_history.planner import ManualHistoryPlanner

        return ManualHistoryPlanner(
            resolver=FakeResolver(),
            clock_ms=lambda: NOW_MS,
            feature_enabled=feature_enabled,
            normalize_symbol_fn=lambda symbol, **kw: str(symbol).strip().upper(),
            disk_snapshot=lambda: {
                "physical_size_bytes": 1_000,
                "free_bytes": 50_000_000_000,
            },
            sqlite_budget_bytes=10_000_000_000,
        )

    monkeypatch.setattr(
        "app.api.v1.manual_history._build_planner",
        fake_build_planner,
    )
    client = _client()
    response = client.post(
        "/api/v1/settings/storage/manual-downloads/plan",
        json={
            "exchange": "binance",
            "market_type": "spot",
            "symbols": ["BTCUSDT", "ETHUSDT"],
            "intervals": ["1m", "1h", "89m"],
            "start_ms": START_MS,
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["selection"]["target_count"] == 6
    assert "plan_hash" in payload
    assert payload["storage"]["estimate_confidence"] in {"LOW", "MEDIUM", "HIGH"}
    assert "estimated_db_growth_bytes" in payload["storage"]


def test_plan_rejects_user_end_ms() -> None:
    response = _client().post(
        "/api/v1/settings/storage/manual-downloads/plan",
        json={
            "exchange": "binance",
            "market_type": "spot",
            "symbols": ["BTCUSDT"],
            "intervals": ["1m"],
            "start_ms": START_MS,
            "end_ms": NOW_MS,
        },
    )
    assert response.status_code == 422


def test_list_jobs_without_runtime_is_empty() -> None:
    response = _client().get("/api/v1/settings/storage/manual-downloads")
    assert response.status_code == 200
    assert response.json()["jobs"] == []


def test_create_remains_closed_after_plan_exists() -> None:
    response = _client().post(
        "/api/v1/settings/storage/manual-downloads",
        json={
            "exchange": "binance",
            "market_type": "spot",
            "symbols": ["BTCUSDT"],
            "intervals": ["1m"],
            "start_ms": START_MS,
        },
    )
    assert response.status_code == 403
    assert response.json()["detail"]["reason"] == "feature_flag_disabled"
