from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.api.v1.backtests import _error
from app.backtest.errors import BacktestError
from app.backtest.models import RunState
from app.backtest.service import BacktestService
from app.core.config import load_backtest_settings


def _settings(tmp_path: Path):
    return load_backtest_settings(
        {
            "BACKTEST_ENABLED": "1",
            "BACKTEST_BAR_ENABLED": "1",
            "BACKTEST_MAX_ACTIVE_RUNS": "1",
        },
        data_dir=tmp_path,
        klines_db_path=tmp_path / "candlescope.db",
        replay_db_path=tmp_path / "replay.db",
    )


def _payload() -> dict[str, object]:
    return {
        "strategy_revision_id": "rev-1",
        "dataset_id": "local-0123456789abcdef0123456789abcdef",
        "data_epoch": "sha256:" + "ab" * 32,
        "snapshot_hash": "sha256:" + "cd" * 32,
        "fidelity_mode": "BAR_APPROX",
        "start_time_ms": 1,
        "end_time_ms": 2,
        "parameters": {"fast": 10},
    }


def test_completed_idempotent_run_is_reused_without_a_second_record(
    tmp_path: Path,
) -> None:
    service = BacktestService.start(_settings(tmp_path), now_ms=1)
    first = service.create_run(_payload(), idempotency_key="same-identity", now_ms=2)
    service.repository.update_run_state(
        str(first["run_id"]), state=RunState.COMPLETED.value, updated_at_ms=3
    )
    reused = service.create_run(_payload(), idempotency_key="same-identity", now_ms=4)
    assert reused["run_id"] == first["run_id"]
    assert reused["state"] == RunState.COMPLETED.value
    assert len(service.list_runs()) == 1
    service.shutdown()


def test_run_capacity_is_explicit_retryable_and_maps_to_http_429(
    tmp_path: Path,
) -> None:
    service = BacktestService.start(_settings(tmp_path), now_ms=1)
    first = service.create_run(_payload(), idempotency_key="first-run", now_ms=2)
    service.repository.update_run_state(
        str(first["run_id"]), state=RunState.RUNNING.value, updated_at_ms=3
    )
    with pytest.raises(BacktestError) as caught:
        service.validate_run({**_payload(), "parameters": {"fast": 11}})
    assert caught.value.code == "RUN_CAPACITY_EXCEEDED"
    assert caught.value.details == {
        "retryable": True,
        "retry_after_ms": 1000,
        "capacity": "active",
    }
    response = _error(caught.value)
    assert response.status_code == 429
    assert response.headers["retry-after"] == "1"
    assert json.loads(response.body)["error"]["details"]["retryable"] is True
    service.shutdown()


def test_registered_revision_reuses_matching_smoke_after_other_chart_contexts(
    tmp_path: Path,
) -> None:
    service = BacktestService.start(
        _settings(tmp_path), now_ms=1, enforce_registered_revisions=True
    )
    revision = service.create_strategy_revision(
        {
            "name": "SMA cross",
            "language": "PYNE_CHART_V1",
            "source_text": (
                'strategy("SMA Cross")\n'
                "fast = sma(close, 3)\n"
                "slow = sma(close, 5)\n\n"
                "if crossover(fast, slow)\n"
                "  target_position(1)\n"
                "else if crossunder(fast, slow)\n"
                "  target_position(0)"
            ),
        },
        now_ms=2,
    )
    revision_id = str(revision["revision_id"])
    first = {**_payload(), "strategy_revision_id": revision_id}
    second = {
        **first,
        "dataset_id": "local-fedcba9876543210fedcba9876543210",
        "snapshot_hash": "sha256:" + "ef" * 32,
    }
    service.smoke_strategy_revision(revision_id, first, now_ms=3)
    service.smoke_strategy_revision(revision_id, second, now_ms=4)

    validated = service.validate_run(first)

    assert validated["ok"] is True
    service.shutdown()
