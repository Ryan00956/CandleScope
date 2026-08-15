from __future__ import annotations

import os
from pathlib import Path

import pytest

from app.backtest.errors import BacktestError
from app.backtest.service import BacktestService
from app.backtest.strategy.registry import build_default_strategy_registry
from app.core.config import load_backtest_settings

FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "packages"
    / "candlescope-backtest-sdk"
    / "fixtures"
    / "sma_cross"
)


def _settings(tmp_path: Path):
    return load_backtest_settings(
        {
            "BACKTEST_ENABLED": "1",
            "BACKTEST_BAR_ENABLED": "1",
            "BACKTEST_STUDY_ENABLED": "1",
        },
        data_dir=tmp_path,
        klines_db_path=tmp_path / "candlescope.db",
        replay_db_path=tmp_path / "replay.db",
    )


def test_python_smoke_run_and_study_use_persisted_revision(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("BACKTEST_PYTHON_TRUSTED_LOCAL_ENABLED", "1")
    service = BacktestService.start(
        _settings(tmp_path),
        strategy_registry=build_default_strategy_registry(),
        enforce_registered_revisions=True,
        now_ms=1,
    )
    bundle = service.create_python_strategy_bundle(directory=str(FIXTURE), now_ms=2)
    revision = service.create_python_strategy_revision(bundle["bundle_id"], now_ms=3)
    assert revision["provider_kind"] == "PYTHON_SOURCE"
    assert "TARGET_POSITION" in revision["output_modes"]
    smoke = service.smoke_strategy_revision(
        revision["revision_id"],
        {
            "dataset_id": "local-0123456789abcdef0123456789abcdef",
            "snapshot_hash": "sha256:" + "cd" * 32,
            "start_time_ms": 1,
            "end_time_ms": 2,
            "parameters": {"fast": 2, "slow": 3},
            "python_runtime_mode": "TRUSTED_LOCAL",
            "python_trusted_confirmed": True,
        },
        now_ms=4,
    )
    assert smoke["status"] == "PASSED"
    assert smoke["runtimeMode"] == "TRUSTED_LOCAL"
    receipt = service.get_python_runtime_receipt(revision["revision_id"])
    assert receipt["bundleId"] == bundle["bundle_id"]
    assert receipt["mode"] == "TRUSTED_LOCAL"
    created = service.create_run(
        {
            "strategy_revision_id": revision["revision_id"],
            "dataset_id": "local-0123456789abcdef0123456789abcdef",
            "data_epoch": "sha256:" + "ab" * 32,
            "snapshot_hash": "sha256:" + "cd" * 32,
            "fidelity_mode": "BAR_APPROX",
            "start_time_ms": 1,
            "end_time_ms": 2,
            "parameters": {"fast": 2, "slow": 3},
            "python_runtime_mode": "TRUSTED_LOCAL",
            "python_trusted_confirmed": True,
        },
        idempotency_key="studio-run",
        now_ms=5,
    )
    assert created["state"] == "QUEUED"
    study = service.create_study(
        {
            "name": "python studio study",
            "hypothesis": "frozen python revision can enter Host Study",
            "strategy_revision_id": revision["revision_id"],
            "start_ms": 1,
            "end_ms": 86_400_000,
            "train_ms": 43_200_000,
            "test_ms": 43_200_000,
        },
        now_ms=6,
    )
    assert study["strategy_revision_id"] == revision["revision_id"]
    service.shutdown()


def test_python_trusted_smoke_requires_confirmation(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("BACKTEST_PYTHON_TRUSTED_LOCAL_ENABLED", raising=False)
    service = BacktestService.start(_settings(tmp_path), now_ms=1)
    bundle = service.create_python_strategy_bundle(directory=str(FIXTURE), now_ms=2)
    revision = service.create_python_strategy_revision(bundle["bundle_id"], now_ms=3)
    with pytest.raises(BacktestError, match="SANDBOX_UNAVAILABLE|TRUSTED_LOCAL"):
        service.smoke_strategy_revision(
            revision["revision_id"],
            {
                "dataset_id": "local-0123456789abcdef0123456789abcdef",
                "snapshot_hash": "sha256:" + "cd" * 32,
                "start_time_ms": 1,
                "end_time_ms": 2,
                "parameters": {"fast": 2, "slow": 3},
                "python_runtime_mode": "TRUSTED_LOCAL",
                "python_trusted_confirmed": False,
            },
            now_ms=4,
        )
    service.shutdown()


def test_python_bundle_apis_remain_default_off() -> None:
    from app.api.v1.backtests import _python_strategy_enabled, _require_python_strategy

    assert os.environ.get("BACKTEST_PYTHON_STRATEGY_ENABLED", "0") != "1"
    assert _python_strategy_enabled() is False
    with pytest.raises(BacktestError, match="default-off"):
        _require_python_strategy()
