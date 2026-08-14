from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.backtest.errors import BacktestError
from app.backtest.models import RunState, transition
from app.backtest.service import BacktestService
from app.backtest.strategy.protocol import CrashProvider
from app.core.config import load_backtest_settings
from app.main import app
from app.market_dataset.snapshot import MarketEvent


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
        trade_only.validate_run(
            _payload(fidelity_mode="TRADE_TAPE", source_event_kind="RAW_TRADE")
        )
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
    recovered = service.get_run(created["run_id"])
    assert recovered["state"] == RunState.QUEUED.value
    assert recovered["generation"] == 2
    service.shutdown()


def test_stale_worker_generation_cannot_checkpoint_or_complete(tmp_path: Path) -> None:
    service = BacktestService.start(_settings(tmp_path), now_ms=10)
    created = service.create_run(_payload(), idempotency_key="fence", now_ms=10)
    run_id = str(created["run_id"])
    service.repository.update_run_state(
        run_id,
        state=RunState.RUNNING.value,
        updated_at_ms=11,
    )
    checkpoint = {
        "run_id": run_id,
        "sequence": 2,
        "generation": 1,
        "payload_json": "{}",
        "state_hash": "sha256:old",
        "created_at_ms": 12,
    }
    assert service.repository.save_checkpoint(checkpoint) is True
    assert service.requeue_interrupted_run(
        run_id,
        expected_generation=1,
        now_ms=13,
    )
    assert service.repository.save_checkpoint({**checkpoint, "sequence": 4}) is False
    assert not service.repository.compare_and_set_run_state(
        run_id,
        expected_state=RunState.QUEUED.value,
        expected_generation=1,
        state=RunState.PREPARING.value,
        updated_at_ms=14,
    )
    recovered = service.get_run(run_id)
    assert recovered["state"] == RunState.QUEUED.value
    assert recovered["generation"] == 2
    service.shutdown()


def test_http_control_plane_when_enabled(tmp_path: Path) -> None:
    settings = _settings(tmp_path, BACKTEST_STUDY_ENABLED="1")
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
    study = client.post(
        "/api/v1/backtests/studies",
        json={
            "name": "wf",
            "hypothesis": "sma",
            "strategy_revision_id": "rev-1",
            "start_ms": 0,
            "end_ms": 1000,
            "train_ms": 400,
            "test_ms": 100,
            "step_ms": 100,
            "parameter_space": {"fast": [3, 5]},
            "max_trials": 4,
            "sampler": "grid",
        },
    )
    assert study.status_code == 200, study.text
    started = client.post(f"/api/v1/backtests/studies/{study.json()['study_id']}/start")
    assert started.status_code == 200, started.text
    assert started.json()["trial_count"] == 4
    service.shutdown()


def test_provider_crash_marks_run_failed(tmp_path: Path) -> None:
    service = BacktestService.start(_settings(tmp_path), now_ms=10)
    created = service.create_run(_payload(), idempotency_key="crash", now_ms=11)
    event = MarketEvent(
        sequence=1,
        event_time_ms=1000,
        role="BARS",
        payload={
            "open": "100",
            "high": "101",
            "low": "99",
            "close": "100",
            "volume": "1",
        },
    )
    with pytest.raises(Exception, match="PROVIDER_CRASH"):
        service.execute_bar_run(
            created["run_id"],
            events=(event,),
            provider=CrashProvider(),
            now_ms=12,
        )
    failed = service.get_run(created["run_id"])
    assert failed["state"] == "FAILED"
    assert failed["failure_code"] == "PROVIDER_CRASH_UNRECOVERABLE"
    service.shutdown()


def test_execute_bar_run_uses_recorded_warmup(tmp_path: Path) -> None:
    service = BacktestService.start(_settings(tmp_path), now_ms=10)
    created = service.create_run(
        _payload(warmup_bars=1),
        idempotency_key="warmup",
        now_ms=11,
    )
    events = (
        MarketEvent(
            sequence=10,
            event_time_ms=1000,
            role="BARS",
            payload={
                "open": "101",
                "high": "102",
                "low": "100",
                "close": "101",
                "volume": "1",
            },
        ),
        MarketEvent(
            sequence=11,
            event_time_ms=2000,
            role="BARS",
            payload={
                "open": "101",
                "high": "102",
                "low": "100",
                "close": "101",
                "volume": "1",
            },
        ),
    )
    frames: list[object] = []

    class _Recorder(CrashProvider):
        def step(self, frame):
            frames.append(frame)
            return None

        def warmup(self, frame):
            frames.append(frame)
            return None

    completed = service.execute_bar_run(
        created["run_id"],
        events=events,
        provider=_Recorder(),
        now_ms=12,
    )
    assert completed["state"] == "COMPLETED"
    assert [frame.phase for frame in frames] == ["WARMUP", "EVALUATION"]
    service.shutdown()


def test_running_cancel_stops_execution_without_writing_report(tmp_path: Path) -> None:
    service = BacktestService.start(_settings(tmp_path), now_ms=10)
    created = service.create_run(
        _payload(), idempotency_key="running-cancel", now_ms=11
    )
    events = tuple(
        MarketEvent(
            sequence=sequence,
            event_time_ms=sequence * 1000,
            role="BARS",
            payload={
                "open": "100",
                "high": "101",
                "low": "99",
                "close": "100",
                "volume": "1",
            },
        )
        for sequence in range(1, 301)
    )
    frames = 0

    class _Canceller(CrashProvider):
        def step(self, frame):
            nonlocal frames
            frames += 1
            if frames == 1:
                service.cancel_run(str(created["run_id"]), now_ms=12)
            return None

    with pytest.raises(BacktestError, match="cancelled"):
        service.execute_bar_run(
            str(created["run_id"]),
            events=events,
            provider=_Canceller(),
            now_ms=12,
        )
    assert frames == 256
    assert service.get_run(str(created["run_id"]))["state"] == "CANCELLED"
    assert service.repository.get_report(str(created["run_id"])) is None
    service.shutdown()


def test_audit_ordinals_survive_process_restart(tmp_path: Path) -> None:
    first = BacktestService.start(_settings(tmp_path), now_ms=10)
    created = first.create_run(_payload(), idempotency_key="audit", now_ms=11)
    run_id = created["run_id"]
    first.shutdown()
    second = BacktestService.start(_settings(tmp_path), now_ms=12)
    cancelled = second.cancel_run(run_id, now_ms=13)
    assert cancelled["state"] == "CANCELLED"
    rows = second.repository.connection.execute(
        "SELECT ordinal, action FROM backtest_audit WHERE run_id = ? ORDER BY ordinal",
        (run_id,),
    ).fetchall()
    assert [int(row["ordinal"]) for row in rows] == [1, 2]
    assert rows[1]["action"] == "cancel"
    second.shutdown()
