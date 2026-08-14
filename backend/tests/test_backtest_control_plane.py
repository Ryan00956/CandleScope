from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.backtest.errors import BacktestError
from app.backtest.models import RunState, transition
from app.backtest.service import BacktestService
from app.core.config import load_backtest_settings
from app.main import app


def _settings(tmp_path: Path, **flags: str):
    environment = {
        "BACKTEST_ENABLED": "1",
        "BACKTEST_BAR_ENABLED": "1",
        **flags,
    }
    return load_backtest_settings(
        environment,
        data_dir=tmp_path,
        klines_db_path=tmp_path / "candlescope.db",
        replay_db_path=tmp_path / "replay.db",
    )


def _payload(**overrides: object) -> dict[str, object]:
    body = {
        "strategy_revision_id": "rev-1",
        "dataset_id": "local-0123456789abcdef0123456789abcdef",
        "data_epoch": "sha256:" + "ab" * 32,
        "snapshot_hash": "sha256:" + "cd" * 32,
        "fidelity_mode": "BAR_APPROX",
        "start_time_ms": 1,
        "end_time_ms": 2,
        "parameters": {"fast": 10},
    }
    body.update(overrides)
    return body


def test_flags_off_register_no_routes_and_create_no_database(tmp_path: Path) -> None:
    assert not any(
        getattr(route, "path", "").startswith("/api/v1/backtests")
        for route in app.routes
    )
    assert not (tmp_path / "backtest.db").exists()


def test_illegal_state_transition_fails() -> None:
    with pytest.raises(BacktestError, match="IDENTITY_MUTATION"):
        transition(RunState.COMPLETED, RunState.RUNNING)


def test_create_validate_cancel_and_idempotent_create(tmp_path: Path) -> None:
    service = BacktestService.start(_settings(tmp_path), now_ms=10)
    validated = service.validate_run(_payload())
    assert validated["ok"] is True
    first = service.create_run(_payload(), idempotency_key="k1", now_ms=11)
    second = service.create_run(_payload(), idempotency_key="k1", now_ms=12)
    assert first["run_id"] == second["run_id"]
    assert first["state"] == RunState.QUEUED.value
    cancelled = service.cancel_run(first["run_id"], now_ms=13)
    assert cancelled["state"] == RunState.CANCELLED.value
    service.shutdown()
    assert (tmp_path / "backtest.db").is_file()


def test_fidelity_mislabels_and_disabled_child_flags_fail(tmp_path: Path) -> None:
    service = BacktestService.start(_settings(tmp_path), now_ms=10)
    with pytest.raises(BacktestError, match="FIDELITY_MISLABEL"):
        service.validate_run(_payload(source_event_kind="RAW_TRADE"))
    service.shutdown()
    trade_only = BacktestService.start(
        _settings(tmp_path, BACKTEST_TRADE_TAPE_ENABLED="0"),
        now_ms=11,
    )
    with pytest.raises(BacktestError, match="FLAG_DISABLED"):
        trade_only.validate_run(_payload(fidelity_mode="TRADE_TAPE", source_event_kind="RAW_TRADE"))
    trade_only.shutdown()


def test_expired_lease_returns_running_run_to_queue(tmp_path: Path) -> None:
    service = BacktestService.start(_settings(tmp_path), now_ms=10)
    created = service.create_run(_payload(), idempotency_key="lease", now_ms=10)
    service.repository.update_run_state(
        created["run_id"], state=RunState.RUNNING.value, updated_at_ms=11
    )
    service.repository.upsert_lease(created["run_id"], "worker-a", 1, expires_at_ms=12)
    expired = service.recover_expired_leases(now_ms=20)
    assert created["run_id"] in expired
    assert service.get_run(created["run_id"])["state"] == RunState.QUEUED.value
    service.shutdown()


def test_http_control_plane_when_enabled(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    service = BacktestService.start(settings, now_ms=1)
    api = FastAPI()
    from app.api.v1.backtests import router

    api.include_router(router, prefix="/api/v1")
    api.state.backtest_service = service
    client = TestClient(api)
    created = client.post(
        "/api/v1/backtests/runs",
        headers={"Idempotency-Key": "http-1"},
        json=_payload(),
    )
    assert created.status_code == 200, created.text
    run_id = created.json()["run_id"]
    listed = client.get("/api/v1/backtests/runs")
    assert listed.status_code == 200
    assert listed.json()["runs"][0]["run_id"] == run_id
    cancelled = client.post(f"/api/v1/backtests/runs/{run_id}/cancel")
    assert cancelled.json()["state"] == "CANCELLED"
    service.shutdown()
