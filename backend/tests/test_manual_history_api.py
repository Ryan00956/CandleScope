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

    def fake_build_planner(*, feature_enabled: bool, request=None):
        del request
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


def test_create_is_closed_when_feature_flag_is_disabled(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.api.v1.manual_history.MANUAL_HISTORY_DOWNLOAD_ENABLED",
        False,
    )
    response = _client().post(
        "/api/v1/settings/storage/manual-downloads",
        json={
            "exchange": "binance",
            "market_type": "spot",
            "symbols": ["BTCUSDT"],
            "intervals": ["1m"],
            "start_ms": START_MS,
            "plan_hash": "sha256:" + ("0" * 64),
            "idempotency_key": "disabled-create",
        },
    )
    assert response.status_code == 403
    assert response.json()["detail"]["reason"] == "feature_flag_disabled"


def test_disabled_create_rejects_before_request_schema_validation(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.api.v1.manual_history.MANUAL_HISTORY_DOWNLOAD_ENABLED",
        False,
    )
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


def test_create_uses_factory_runtime_service_not_hand_built(monkeypatch, tmp_path) -> None:
    import inspect

    from app.core import config as core_config
    from app.data_engine.data_manager import DataManager
    from app.data_engine.runtime import attach_manual_history_service, start_data_engine
    from app.data_engine.storage import klines_repo
    from app.data_engine.storage.klines_repo import KlinesRepoAdapter
    from tests.test_manual_history_planner import FakeResolver, NOW_MS as PLAN_NOW

    source = inspect.getsource(start_data_engine)
    assert "attach_manual_history_service" in source
    assert "manual_history_service=manual_history_service" in source

    db_path = tmp_path / "klines.db"
    monkeypatch.setattr(klines_repo, "KLINES_DB_PATH", db_path)
    monkeypatch.setattr(core_config, "KLINES_DB_PATH", db_path)
    monkeypatch.setattr(
        "app.data_engine.runtime.KLINES_DB_PATH",
        db_path,
    )
    monkeypatch.setattr(
        "app.api.v1.manual_history.MANUAL_HISTORY_DOWNLOAD_ENABLED",
        True,
    )
    monkeypatch.setattr(
        "app.data_engine.runtime.MANUAL_HISTORY_DOWNLOAD_ENABLED",
        True,
    )
    klines_repo.init_klines_storage()
    dm = DataManager()
    dm.set_storage(KlinesRepoAdapter())

    class _Coordinator:
        async def request_and_wait(self, request):
            del request

    service = attach_manual_history_service(
        data_manager=dm,
        coordinator=_Coordinator(),  # type: ignore[arg-type]
        enabled=True,
    )
    assert service.coordinator is not None

    def fake_build_planner(*, feature_enabled: bool, request=None):
        del request
        from app.data_engine.manual_history.planner import ManualHistoryPlanner

        return ManualHistoryPlanner(
            resolver=FakeResolver(),
            clock_ms=lambda: PLAN_NOW,
            feature_enabled=feature_enabled,
            normalize_symbol_fn=lambda symbol, **kw: str(symbol).strip().upper(),
            disk_snapshot=lambda: {
                "physical_size_bytes": 1_000,
                "free_bytes": 50_000_000_000,
            },
            sqlite_budget_bytes=10_000_000_000,
        )

    monkeypatch.setattr("app.api.v1.manual_history._build_planner", fake_build_planner)
    app = FastAPI()
    app.include_router(manual_history_router, prefix="/api/v1")
    runtime = type("Runtime", (), {})()
    runtime.manual_history_service = service
    runtime.data_manager = dm
    app.state.data_engine_runtime = runtime
    app.state.data_manager = dm
    client = TestClient(app)
    plan = client.post(
        "/api/v1/settings/storage/manual-downloads/plan",
        json={
            "exchange": "binance",
            "market_type": "spot",
            "symbols": ["BTCUSDT"],
            "intervals": ["1m"],
            "start_ms": START_MS,
        },
    )
    assert plan.status_code == 200
    created = client.post(
        "/api/v1/settings/storage/manual-downloads",
        json={
            "exchange": "binance",
            "market_type": "spot",
            "symbols": ["BTCUSDT"],
            "intervals": ["1m"],
            "start_ms": START_MS,
            "plan_hash": plan.json()["plan_hash"],
            "idempotency_key": "factory-runtime-create-1",
        },
    )
    assert created.status_code == 202, created.text
    assert created.json()["status"] == "accepted"
    assert created.json()["job"]["state"] in {"QUEUED", "RUNNING", "SUCCEEDED"}
    repeated = client.post(
        "/api/v1/settings/storage/manual-downloads",
        json={
            "exchange": "binance",
            "market_type": "spot",
            "symbols": ["BTCUSDT"],
            "intervals": ["1m"],
            "start_ms": START_MS,
            "plan_hash": plan.json()["plan_hash"],
            "idempotency_key": "factory-runtime-create-1",
        },
    )
    assert repeated.status_code == 202
    assert repeated.json()["reused_existing"] is True
    assert repeated.json()["job"]["job_id"] == created.json()["job"]["job_id"]
