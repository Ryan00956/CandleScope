from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.settings import router as settings_router


class _DataManager:
    def __init__(self) -> None:
        self.memory_gc_calls: list[tuple[str, dict]] = []

    def prewarm_targets(self):
        return [("binance", "spot", "BTCUSDT")]

    def prewarm_intervals(self):
        return ("1m", "5m")

    def gap_audit_series(self):
        return [
            ("binance", "spot", "BTCUSDT", "1m"),
            ("okx", "spot", "BTC-USDT", "1m"),
        ]

    def plan_memory_gc(self, policy: dict) -> dict:
        self.memory_gc_calls.append(("dry-run", policy))
        return {
            "mode": "dry-run",
            "victims": [],
            "policy": policy,
        }

    def run_memory_gc(self, policy: dict) -> dict:
        self.memory_gc_calls.append(("run", policy))
        return {
            "mode": "execute",
            "removed_bars": 0,
            "policy": policy,
        }

    def plan_storage_gc(
        self,
        *,
        db_limits=None,
        sqlite_budget_bytes=None,
        storage_row_limits_enabled=None,
        file_snapshot=None,
    ) -> dict:
        self.memory_gc_calls.append(("storage-dry-run", {
            "db_limits": db_limits,
            "sqlite_budget_bytes": sqlite_budget_bytes,
            "storage_row_limits_enabled": storage_row_limits_enabled,
            "file_snapshot": file_snapshot,
        }))
        return {
            "mode": "dry-run",
            "owner": "sqlite-storage",
            "would_delete_rows": 0,
            "policy": {
                "db_limits": db_limits or {},
                "sqlite_budget_bytes": sqlite_budget_bytes,
                "storage_row_limits_enabled": storage_row_limits_enabled,
            },
        }

    async def run_storage_gc(
        self,
        *,
        db_limits=None,
        sqlite_budget_bytes=None,
        storage_row_limits_enabled=None,
        file_snapshot=None,
        batch_size=10_000,
    ) -> dict:
        self.memory_gc_calls.append(("storage-run", {
            "db_limits": db_limits,
            "sqlite_budget_bytes": sqlite_budget_bytes,
            "storage_row_limits_enabled": storage_row_limits_enabled,
            "file_snapshot": file_snapshot,
            "batch_size": batch_size,
        }))
        return {
            "mode": "execute",
            "owner": "sqlite-storage",
            "deleted_rows": 0,
            "policy": {
                "db_limits": db_limits or {},
                "sqlite_budget_bytes": sqlite_budget_bytes,
                "storage_row_limits_enabled": storage_row_limits_enabled,
            },
        }

    async def vacuum_storage(self) -> dict:
        self.memory_gc_calls.append(("storage-vacuum", {}))
        return {
            "mode": "vacuum",
            "owner": "sqlite-storage",
            "status": "ok",
        }

    async def run_auto_gc(self, policy=None) -> dict:
        self.memory_gc_calls.append(("auto-gc", policy or {}))
        return {
            "mode": "auto-gc",
            "status": "ok",
            "policy": policy or {},
        }

    def record_cache_access(self, symbol, interval, **kwargs) -> dict:
        self.memory_gc_calls.append(("cache-access", {
            "symbol": symbol,
            "interval": interval,
            **kwargs,
        }))
        return {"symbol": symbol, "interval": interval, "heat_score": 1}

    def update_retention_limits(
        self,
        db_limits=None,
        ephemeral_bars=None,
        sqlite_budget_bytes=None,
        storage_row_limits_enabled=None,
    ) -> None:
        self.memory_gc_calls.append(("cache-limits", {
            "db_limits": db_limits,
            "ephemeral_bars": ephemeral_bars,
            "sqlite_budget_bytes": sqlite_budget_bytes,
            "storage_row_limits_enabled": storage_row_limits_enabled,
        }))

    def retention_snapshot(self) -> dict:
        return {
            "db_limits": {"minutes": 123},
            "ephemeral_bars": 3600,
            "sqlite_budget_bytes": 2048,
            "storage_row_limits_enabled": True,
        }


class _BackfillCoordinator:
    def snapshot(self) -> dict:
        return {
            "submitted": 3,
            "deduped": 1,
            "merged": 0,
            "active": [],
            "pending": [],
            "gap_ledger_open": [{"symbol": "BTCUSDT", "interval": "1m"}],
            "gap_ledger_health": {
                "open_total": 173,
                "by_status": {"queued": 170, "partial": 3},
                "age_buckets": {"lt_5m": 3, "gte_1d": 170},
                "oldest_open_at": 123,
            },
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


def _client_with_dm(dm: _DataManager) -> TestClient:
    app = FastAPI()
    app.include_router(settings_router, prefix="/api/v1")
    app.state.data_manager = dm
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
    assert payload["open_gap_count"] == 173
    assert payload["open_gap_by_status"] == {"queued": 170, "partial": 3}
    assert payload["open_gap_age_buckets"] == {"lt_5m": 3, "gte_1d": 170}
    assert payload["oldest_open_gap_at"] == 123
    assert payload["backfill"]["submitted"] == 3
    assert (
        payload["backfill_engine"]["fetcher"]["exchange_rate_limits"]
        ["binance:spot:request_weight:ip"]["rule"]
        == "binance_spot_klines"
    )


def test_storage_health_requires_data_engine() -> None:
    response = _client(with_runtime=False).get("/api/v1/settings/storage/health")

    assert response.status_code == 503


def test_backend_memory_gc_dry_run_endpoint_calls_data_manager_plan() -> None:
    dm = _DataManager()
    response = _client_with_dm(dm).post(
        "/api/v1/settings/cache-gc/backend-memory/dry-run",
        json={"cold_idle_seconds": 0, "max_victims": 3},
    )

    assert response.status_code == 200
    assert response.json()["mode"] == "dry-run"
    assert dm.memory_gc_calls == [(
        "dry-run",
        {
            "cold_idle_seconds": 0,
            "max_victims": 3,
            "preserve_active": True,
            "preserve_subscribed": True,
        },
    )]


def test_backend_memory_gc_run_endpoint_calls_data_manager_run() -> None:
    dm = _DataManager()
    response = _client_with_dm(dm).post(
        "/api/v1/settings/cache-gc/backend-memory/run",
        json={"ephemeral_keep_bars": 100},
    )

    assert response.status_code == 200
    assert response.json()["mode"] == "execute"
    assert dm.memory_gc_calls == [(
        "run",
        {
            "preserve_active": True,
            "preserve_subscribed": True,
            "ephemeral_keep_bars": 100,
        },
    )]


def test_auto_gc_run_endpoint_calls_data_manager_without_confirm() -> None:
    dm = _DataManager()
    response = _client_with_dm(dm).post(
        "/api/v1/settings/cache-gc/auto/run",
        json={"max_entries_per_run": 3, "min_final_evict_score": 80},
    )

    assert response.status_code == 200
    assert response.json()["mode"] == "auto-gc"
    assert dm.memory_gc_calls == [(
        "auto-gc",
        {
            "max_entries_per_run": 3,
            "min_final_evict_score": 80.0,
        },
    )]


def test_storage_gc_dry_run_endpoint_calls_data_manager_plan() -> None:
    dm = _DataManager()
    response = _client_with_dm(dm).post(
        "/api/v1/settings/cache-gc/storage/dry-run",
        json={
            "db_limits": {"minutes": 123},
            "sqlite_budget_bytes": 1024,
            "storage_row_limits_enabled": True,
        },
    )

    assert response.status_code == 200
    assert response.json()["owner"] == "sqlite-storage"
    assert dm.memory_gc_calls[0][0] == "storage-dry-run"
    assert dm.memory_gc_calls[0][1]["db_limits"] == {"minutes": 123}
    assert dm.memory_gc_calls[0][1]["sqlite_budget_bytes"] == 1024
    assert dm.memory_gc_calls[0][1]["storage_row_limits_enabled"] is True
    assert "db_size_bytes" in dm.memory_gc_calls[0][1]["file_snapshot"]


def test_cache_access_endpoint_records_behavior_signal() -> None:
    dm = _DataManager()
    response = _client_with_dm(dm).post(
        "/api/v1/settings/cache-access",
        json={
            "symbol": "BTCUSDT",
            "interval": "1m",
            "action": "frontend-full-cache-hit",
            "source": "frontend",
        },
    )

    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert dm.memory_gc_calls[-1][0] == "cache-access"
    assert dm.memory_gc_calls[-1][1]["action"] == "frontend-full-cache-hit"


def test_cache_access_endpoint_rejects_untrusted_future_timestamp() -> None:
    dm = _DataManager()
    response = _client_with_dm(dm).post(
        "/api/v1/settings/cache-access",
        json={
            "symbol": "BTCUSDT",
            "interval": "1m",
            "occurred_at_ms": 9_999_999_999_999,
        },
    )

    assert response.status_code == 422
    assert dm.memory_gc_calls == []


def test_storage_gc_run_requires_confirm() -> None:
    dm = _DataManager()
    response = _client_with_dm(dm).post(
        "/api/v1/settings/cache-gc/storage/run",
        json={"db_limits": {"minutes": 123}},
    )

    assert response.status_code == 400
    assert dm.memory_gc_calls == []


def test_storage_gc_run_endpoint_calls_data_manager_run() -> None:
    dm = _DataManager()
    response = _client_with_dm(dm).post(
        "/api/v1/settings/cache-gc/storage/run",
        json={
            "confirm": True,
            "db_limits": {"minutes": 123},
            "sqlite_budget_bytes": 2048,
            "storage_row_limits_enabled": True,
            "batch_size": 50,
        },
    )

    assert response.status_code == 200
    assert response.json()["mode"] == "execute"
    assert "storage_files_after" in response.json()
    assert dm.memory_gc_calls[0][0] == "storage-run"
    assert dm.memory_gc_calls[0][1]["db_limits"] == {"minutes": 123}
    assert dm.memory_gc_calls[0][1]["sqlite_budget_bytes"] == 2048
    assert dm.memory_gc_calls[0][1]["storage_row_limits_enabled"] is True
    assert dm.memory_gc_calls[0][1]["batch_size"] == 50


def test_storage_vacuum_requires_confirm() -> None:
    dm = _DataManager()
    response = _client_with_dm(dm).post("/api/v1/settings/cache-gc/storage/vacuum", json={})

    assert response.status_code == 400
    assert dm.memory_gc_calls == []


def test_storage_vacuum_endpoint_calls_data_manager() -> None:
    dm = _DataManager()
    response = _client_with_dm(dm).post(
        "/api/v1/settings/cache-gc/storage/vacuum",
        json={"confirm": True},
    )

    assert response.status_code == 200
    assert response.json()["mode"] == "vacuum"
    assert "storage_files_before" in response.json()
    assert "storage_files_after" in response.json()
    assert dm.memory_gc_calls == [("storage-vacuum", {})]


def test_cache_limits_endpoint_accepts_budget_fields() -> None:
    dm = _DataManager()
    response = _client_with_dm(dm).post(
        "/api/v1/settings/cache-limits",
        json={
            "db_limits": {"minutes": 123},
            "ephemeral_bars": 3600,
            "sqlite_budget_bytes": 2048,
            "storage_row_limits_enabled": True,
        },
    )

    assert response.status_code == 200
    assert response.json()["sqlite_budget_bytes"] == 2048
    assert response.json()["storage_row_limits_enabled"] is True
    assert dm.memory_gc_calls == [(
        "cache-limits",
        {
            "db_limits": {"minutes": 123},
            "ephemeral_bars": 3600,
            "sqlite_budget_bytes": 2048,
            "storage_row_limits_enabled": True,
        },
    )]


def test_cache_limits_endpoint_can_clear_sqlite_budget() -> None:
    dm = _DataManager()
    response = _client_with_dm(dm).post(
        "/api/v1/settings/cache-limits",
        json={
            "sqlite_budget_bytes": None,
            "storage_row_limits_enabled": False,
        },
    )

    assert response.status_code == 200
    assert dm.memory_gc_calls == [(
        "cache-limits",
        {
            "db_limits": None,
            "ephemeral_bars": None,
            "sqlite_budget_bytes": 0,
            "storage_row_limits_enabled": False,
        },
    )]
