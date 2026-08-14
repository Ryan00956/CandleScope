from __future__ import annotations

from pathlib import Path

import pytest

from app.backtest.errors import BacktestError
from app.backtest.service import BacktestService
from app.backtest.study import (
    compare_runs,
    grid_sampler,
    plan_trials,
    random_sampler,
    rank_oos,
    walk_forward_splits,
)
from app.core.config import load_backtest_settings


def test_walk_forward_does_not_leak_test_into_train() -> None:
    splits = walk_forward_splits(
        start_ms=0,
        end_ms=1000,
        train_ms=400,
        test_ms=100,
        step_ms=100,
    )
    tests = [item for item in splits if item.role == "test"]
    trains = [item for item in splits if item.role == "train"]
    assert tests
    for test in tests:
        fold = "-".join(test.split_id.split("-")[:2])
        train = next(item for item in trains if item.split_id.startswith(fold))
        assert test.start_ms >= train.end_ms


def test_samplers_are_deterministic_and_budgeted() -> None:
    space = {"fast": [1, 2], "slow": [3, 4]}
    assert grid_sampler(space) == grid_sampler(space)
    assert len(grid_sampler(space)) == 4
    first = random_sampler(space, count=3, seed=7)
    second = random_sampler(space, count=3, seed=7)
    assert first == second
    splits = walk_forward_splits(start_ms=0, end_ms=800, train_ms=300, test_ms=100, step_ms=200)
    planned = plan_trials(splits, grid_sampler(space), max_trials=3)
    assert len(planned) == 3


def test_compare_rejects_incompatible_runs_and_ranks_oos_separately() -> None:
    left = {
        "fidelity_mode": "BAR_APPROX",
        "source_event_kind": "BAR",
        "dataset_id": "ds",
        "data_epoch": "e",
        "engine_version": "v",
        "strategy_revision_id": "r",
    }
    right = dict(left)
    assert compare_runs([left, right])["ok"] is True
    with pytest.raises(BacktestError, match="incompatible"):
        compare_runs([left, {**right, "fidelity_mode": "TRADE_TAPE"}])
    ranked = rank_oos(
        [
            {"ordinal": 1, "oos_score": 1, "in_sample_score": 9, "params": {"fast": 1}},
            {"ordinal": 2, "oos_score": 5, "in_sample_score": 2, "params": {"fast": 2}},
        ]
    )
    assert ranked[0]["ordinal"] == 2
    assert "not an OOS claim" in ranked[0]["selection_warning"]


def test_study_start_cancel_and_repeatable_plan(tmp_path: Path) -> None:
    settings = load_backtest_settings(
        {"BACKTEST_ENABLED": "1", "BACKTEST_STUDY_ENABLED": "1"},
        data_dir=tmp_path,
        klines_db_path=tmp_path / "candlescope.db",
        replay_db_path=tmp_path / "replay.db",
    )
    service = BacktestService.start(settings, now_ms=1)
    created = service.create_study(
        {
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
        now_ms=2,
    )
    first = service.start_study(created["study_id"])
    second = service.start_study(created["study_id"])
    assert first["trial_count"] == 4
    assert [item["params_hash"] for item in first["trials"]] == [
        item["params_hash"] for item in second["trials"]
    ]
    cancelled = service.cancel_study(created["study_id"])
    assert cancelled["state"] == "CANCELLED"
    with pytest.raises(BacktestError, match="cancelled"):
        service.start_study(created["study_id"])
    service.shutdown()


def test_cancelled_study_does_not_plan_new_trials(tmp_path: Path) -> None:
    settings = load_backtest_settings(
        {"BACKTEST_ENABLED": "1", "BACKTEST_STUDY_ENABLED": "1"},
        data_dir=tmp_path,
        klines_db_path=tmp_path / "candlescope.db",
        replay_db_path=tmp_path / "replay.db",
    )
    service = BacktestService.start(settings, now_ms=1)
    created = service.create_study(
        {
            "name": "wf",
            "hypothesis": "sma",
            "strategy_revision_id": "rev-1",
            "start_ms": 0,
            "end_ms": 1000,
            "train_ms": 400,
            "test_ms": 100,
            "parameter_space": {"fast": [3, 5]},
        },
        now_ms=2,
    )
    service.cancel_study(created["study_id"])
    with pytest.raises(BacktestError, match="cancelled"):
        service.start_study(created["study_id"])
    assert service.repository.list_trials(created["study_id"]) == []
    service.shutdown()


def test_concurrent_study_budget_and_cascade_cancel(tmp_path: Path) -> None:
    settings = load_backtest_settings(
        {
            "BACKTEST_ENABLED": "1",
            "BACKTEST_BAR_ENABLED": "1",
            "BACKTEST_STUDY_ENABLED": "1",
            "BACKTEST_MAX_CONCURRENT_STUDIES": "1",
        },
        data_dir=tmp_path,
        klines_db_path=tmp_path / "candlescope.db",
        replay_db_path=tmp_path / "replay.db",
    )
    service = BacktestService.start(settings, now_ms=1)
    base = {
        "name": "wf",
        "hypothesis": "sma",
        "strategy_revision_id": "rev-1",
        "dataset_id": "ds",
        "data_epoch": "sha256:" + "ab" * 32,
        "start_ms": 0,
        "end_ms": 1000,
        "train_ms": 400,
        "test_ms": 100,
        "step_ms": 100,
        "parameter_space": {"fast": [3, 5]},
        "max_trials": 2,
    }
    first = service.create_study(base, now_ms=2)
    second = service.create_study({**base, "name": "wf-2"}, now_ms=3)
    service.start_study(str(first["study_id"]))
    with pytest.raises(BacktestError, match="concurrent Study ceiling"):
        service.start_study(str(second["study_id"]))
    service.materialize_study_runs(
        str(first["study_id"]),
        preview_snapshot=lambda **_: {"snapshot_hash": "sha256:" + "cd" * 32},
    )
    cancelled = service.cancel_study(str(first["study_id"]))
    assert cancelled["state"] == "CANCELLED"
    assert {trial["state"] for trial in cancelled["trials"]} == {"CANCELLED"}
    assert {
        service.get_run(str(trial["run_id"]))["state"]
        for trial in cancelled["trials"]
    } == {"CANCELLED"}
    service.shutdown()


def test_cancel_race_during_materialization_cannot_leave_orphan_run(
    tmp_path: Path,
) -> None:
    settings = load_backtest_settings(
        {
            "BACKTEST_ENABLED": "1",
            "BACKTEST_BAR_ENABLED": "1",
            "BACKTEST_STUDY_ENABLED": "1",
        },
        data_dir=tmp_path,
        klines_db_path=tmp_path / "candlescope.db",
        replay_db_path=tmp_path / "replay.db",
    )
    service = BacktestService.start(settings, now_ms=1)
    study = service.create_study(
        {
            "name": "cancel-race",
            "hypothesis": "no orphan trial run",
            "strategy_revision_id": "rev-1",
            "dataset_id": "ds",
            "data_epoch": "sha256:" + "ab" * 32,
            "start_ms": 0,
            "end_ms": 1000,
            "train_ms": 400,
            "test_ms": 100,
            "step_ms": 100,
            "parameter_space": {"fast": [3]},
            "max_trials": 1,
        },
        now_ms=2,
    )
    study_id = str(study["study_id"])
    service.start_study(study_id)

    def cancel_then_preview(**_values: object) -> dict[str, str]:
        service.cancel_study(study_id)
        return {"snapshot_hash": "sha256:" + "cd" * 32}

    materialized = service.materialize_study_runs(
        study_id,
        preview_snapshot=cancel_then_preview,
    )
    assert materialized["state"] == "CANCELLED"
    assert {trial["state"] for trial in materialized["trials"]} == {"CANCELLED"}
    runs = service.list_runs()
    assert runs
    assert {run["state"] for run in runs} == {"CANCELLED"}
    service.shutdown()
