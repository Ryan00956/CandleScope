from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

import pytest

from app.backtest.errors import BacktestError
from app.backtest.repository import BacktestRepository
from app.backtest.schema import SCHEMA_VERSION
from app.backtest.runtime import BacktestRuntime
from app.backtest.service import BacktestService
from app.backtest.study_v2 import (
    STUDY_PROTOCOL_V2,
    build_oos_report,
    build_selection_receipt,
    evaluate_train_candidate,
    sample_candidates_v2,
    study_v2_identity,
    verify_oos_report,
    verify_selection_receipt,
    walk_forward_folds_v2,
)
from app.core.config import load_backtest_settings
from app.local_data.service import LocalDatasetService, LocalImportOptions


DAY = 86_400_000


def _report(
    *,
    total_return: str,
    trade_count: int = 2,
    start_ms: int = 0,
    report_hash: str = "sha256:report",
) -> dict[str, object]:
    return {
        "schemaVersion": "candlescope.backtest-report/2",
        "hashes": {"report": report_hash},
        "metrics": {"trade_count": trade_count},
        "account": {"initial_balance": "10000"},
        "trades": [
            {"net_pnl": "10", "side": "LONG"},
            {"net_pnl": "-3", "side": "SHORT"},
        ][:trade_count],
        "performance": {
            "metrics_version": "BACKTEST_METRICS_V2",
            "returns": {
                "total_return": {"value": total_return, "reason": None},
                "benchmark_return": {"value": "0.01", "reason": None},
            },
            "risk": {
                "sharpe": {"value": total_return, "reason": None},
                "calmar": {"value": total_return, "reason": None},
                "max_drawdown": {"value": "0.1", "reason": None},
            },
            "trading": {
                "trade_count": trade_count,
                "expectancy": {"value": total_return, "reason": None},
                "long": {"trade_count": int(trade_count > 0)},
                "short": {"trade_count": int(trade_count > 1)},
            },
            "quality": {
                "gap_count": 0,
                "duplicate_count": 0,
                "ambiguity_count": 0,
            },
            "execution": {
                "order_count": max(trade_count, 1),
                "rejected_order_count": 0,
            },
            "equity_daily": [
                {"event_time_ms": start_ms, "date": "2024-01-01", "equity": "10000"},
                {
                    "event_time_ms": start_ms + DAY,
                    "date": "2024-01-02",
                    "equity": "10100",
                },
            ],
        },
        "cost_sensitivity": {
            "scenarios": [
                {
                    "name": "COSTS_PLUS_25_PERCENT",
                    "metrics": {"final_equity": "10001"},
                }
            ]
        },
    }


def _identity() -> dict[str, object]:
    return {
        "study_protocol_revision": STUDY_PROTOCOL_V2,
        "selection_protocol_revision": "TRAIN_CONSTRAINT_OBJECTIVE_SELECT_ONCE_V2",
        "hypothesis": "RSI24 persists OOS",
        "dataset_snapshot_hash": "sha256:snapshot",
        "seed": 7,
        "candidate_budget": 2,
    }


def _candidate(
    ordinal: int, length: int, report: dict[str, object]
) -> dict[str, object]:
    params = {"length": length, "oversold": "30", "overbought": "70"}
    return {
        "candidate_ordinal": ordinal,
        "params": params,
        "params_hash": f"sha256:p{length}",
        "evaluation": evaluate_train_candidate(
            report,
            objective="NET_RETURN",
            constraints={
                "min_closed_trades": 1,
                "max_drawdown": "0.5",
                "min_data_coverage": "1",
                "max_ambiguity_ratio": "0",
                "max_rejected_ratio": "0",
                "cost_plus_25_must_be_positive": True,
            },
        ),
    }


def test_fold_windows_freeze_purge_embargo_and_holdout() -> None:
    folds = walk_forward_folds_v2(
        start_ms=0,
        end_ms=1000,
        train_ms=400,
        test_ms=100,
        step_ms=100,
        purge_ms=20,
        embargo_ms=30,
        holdout_ms=100,
    )
    assert len(folds) == 4
    assert folds[0].train_end_ms == 380
    assert folds[0].test_start_ms == 430
    assert folds[-1].test_end_ms <= 900
    assert all(fold.train_end_ms < fold.test_start_ms for fold in folds)

    with pytest.raises(BacktestError, match="non-overlapping OOS"):
        walk_forward_folds_v2(
            start_ms=0,
            end_ms=1000,
            train_ms=400,
            test_ms=100,
            step_ms=99,
        )


def test_sampler_and_selection_receipt_are_deterministic_without_test_input() -> None:
    space = {"length": [20, 24, 28], "oversold": [25, 30]}
    assert sample_candidates_v2(
        space, sampler="random", seed=7, candidate_budget=4
    ) == (sample_candidates_v2(space, sampler="random", seed=7, candidate_budget=4))
    fold = walk_forward_folds_v2(
        start_ms=0, end_ms=900, train_ms=400, test_ms=100, step_ms=200
    )[0]
    candidates = [
        _candidate(1, 20, _report(total_return="0.1")),
        _candidate(2, 24, _report(total_return="0.2")),
    ]
    first = build_selection_receipt(
        identity=_identity(),
        fold=fold,
        candidates=candidates,
        objective="NET_RETURN",
        constraints={"min_closed_trades": 1},
    )
    # A radically different test result is intentionally not an input to the
    # selection API and therefore cannot alter the receipt.
    _unused_test_report = _report(total_return="999")
    second = build_selection_receipt(
        identity=_identity(),
        fold=fold,
        candidates=candidates,
        objective="NET_RETURN",
        constraints={"min_closed_trades": 1},
    )
    assert first["selected"]["params"]["length"] == 24
    assert first["hashes"]["receipt"] == second["hashes"]["receipt"]
    assert verify_selection_receipt(first)
    serialized = json.dumps(first).lower()
    assert "test_run_id" not in serialized
    assert "test_report" not in serialized
    assert "report_hash" not in serialized


def test_no_trade_or_constraint_violating_candidate_cannot_win() -> None:
    fold = walk_forward_folds_v2(
        start_ms=0, end_ms=600, train_ms=400, test_ms=100, step_ms=100
    )[0]
    high_but_empty = _candidate(1, 20, _report(total_return="100", trade_count=0))
    eligible = _candidate(2, 24, _report(total_return="0.01", trade_count=2))
    receipt = build_selection_receipt(
        identity=_identity(),
        fold=fold,
        candidates=[high_but_empty, eligible],
        objective="NET_RETURN",
        constraints={"min_closed_trades": 1},
    )
    assert high_but_empty["evaluation"]["eligible"] is False
    assert receipt["selected"]["params"]["length"] == 24


def test_oos_aggregation_accepts_test_runs_only() -> None:
    fold = walk_forward_folds_v2(
        start_ms=0, end_ms=900, train_ms=400, test_ms=100, step_ms=200
    )[0]
    receipt = build_selection_receipt(
        identity=_identity(),
        fold=fold,
        candidates=[_candidate(1, 24, _report(total_return="0.1"))],
        objective="NET_RETURN",
        constraints={"min_closed_trades": 1},
    )
    row = {
        "ordinal": 1,
        "run_role": "TEST",
        "test_run_id": "test-1",
        "report": _report(total_return="0.01", start_ms=500),
        "receipt": receipt,
    }
    report = build_oos_report(identity=_identity(), folds=[row], seed=7)
    assert report["sourcePolicy"] == "TEST_RUNS_ONLY_V1"
    assert {item["run_role"] for item in report["equity"]} == {"TEST"}
    assert verify_oos_report(report)
    with pytest.raises(BacktestError, match="TEST runs only"):
        build_oos_report(
            identity=_identity(), folds=[{**row, "run_role": "TRAIN"}], seed=7
        )


def _study_payload() -> dict[str, object]:
    return {
        "name": "RSI24 V2",
        "hypothesis": "RSI24 thresholds survive OOS",
        "study_protocol_revision": STUDY_PROTOCOL_V2,
        "strategy_revision_id": "builtin-rsi-wilder-long-short-v1",
        "dataset_id": "local-m8",
        "data_epoch": "sha256:" + "11" * 32,
        "dataset_snapshot_hash": "sha256:" + "22" * 32,
        "interval": "1d",
        "start_ms": 0,
        "end_ms": 100 * DAY,
        "train_ms": 45 * DAY,
        "test_ms": 15 * DAY,
        "step_ms": 20 * DAY,
        "purge_ms": DAY,
        "embargo_ms": DAY,
        "parameter_space": {"length": [20, 24], "oversold": [30], "overbought": [70]},
        "parameters": {"trigger_mode": "LEVEL_TARGET_V1"},
        "sampler": "grid",
        "seed": 9,
        "candidate_budget": 2,
        "objective": "NET_RETURN",
        "constraints": {"cost_plus_25_must_be_positive": False},
        "warmup_bars": 25,
    }


def test_schema_v3_additive_migration_and_v2_plan_are_idempotent(
    tmp_path: Path,
) -> None:
    path = tmp_path / "backtest.db"
    connection = sqlite3.connect(path)
    connection.execute(
        "CREATE TABLE backtest_schema_meta(schema_version INTEGER, migrated_at_ms INTEGER)"
    )
    connection.execute("INSERT INTO backtest_schema_meta VALUES (2, 1)")
    connection.commit()
    connection.close()
    repository = BacktestRepository(path)
    repository.open(now_ms=2)
    assert (
        repository.connection.execute(
            "SELECT schema_version FROM backtest_schema_meta"
        ).fetchone()[0]
        == SCHEMA_VERSION
    )
    assert (
        repository.connection.execute(
            "SELECT COUNT(*) FROM backtest_study_folds"
        ).fetchone()[0]
        == 0
    )
    repository.close()

    from app.backtest.python_bundle_rollback import rollback_python_bundles

    assert rollback_python_bundles(path)["schemaVersion"] == 5

    subprocess.run(
        [
            sys.executable,
            str(
                Path(__file__).parents[1]
                / "scripts"
                / "rollback_backtest_m10_schema.py"
            ),
            "--database",
            str(path),
            "--backup",
            str(tmp_path / "backtest-v5.backup.db"),
            "--receipt",
            str(tmp_path / "backtest-m10-rollback.json"),
            "--confirm",
            "ROLLBACK_M10_SCHEMA_TO_V4",
        ],
        check=True,
        capture_output=True,
        text=True,
    )

    subprocess.run(
        [
            sys.executable,
            str(
                Path(__file__).parents[1] / "scripts" / "rollback_backtest_m9_schema.py"
            ),
            "--database",
            str(path),
            "--backup",
            str(tmp_path / "backtest-v4.backup.db"),
            "--confirm",
            "ROLLBACK_M9_SCHEMA_TO_V3",
        ],
        check=True,
        capture_output=True,
        text=True,
    )

    backup = tmp_path / "backtest-v3.backup.db"
    subprocess.run(
        [
            sys.executable,
            str(
                Path(__file__).parents[1] / "scripts" / "rollback_backtest_m8_schema.py"
            ),
            "--database",
            str(path),
            "--backup",
            str(backup),
            "--confirm",
            "ROLLBACK_M8_SCHEMA_TO_V2",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    rolled_back = sqlite3.connect(path)
    assert (
        rolled_back.execute(
            "SELECT schema_version FROM backtest_schema_meta"
        ).fetchone()[0]
        == 2
    )
    assert (
        rolled_back.execute(
            """
            SELECT COUNT(*) FROM sqlite_master
            WHERE type = 'table' AND name = 'backtest_study_folds'
            """
        ).fetchone()[0]
        == 0
    )
    rolled_back.close()
    assert backup.exists()

    service = BacktestService.start(
        load_backtest_settings(
            {
                "BACKTEST_ENABLED": "1",
                "BACKTEST_BAR_ENABLED": "1",
                "BACKTEST_STUDY_ENABLED": "1",
            },
            data_dir=tmp_path,
            klines_db_path=tmp_path / "candlescope.db",
            replay_db_path=tmp_path / "replay.db",
        ),
        now_ms=3,
    )
    study = service.create_study(_study_payload(), now_ms=4)
    first = service.start_study(str(study["study_id"]))
    second = service.start_study(str(study["study_id"]))
    assert len(first["folds"]) == len(second["folds"]) == 2
    assert sum(len(item["train_trials"]) for item in first["folds"]) == 4
    listed = service.list_studies()[0]
    assert listed["study_protocol_revision"] == STUDY_PROTOCOL_V2
    assert len(listed["folds"]) == len(first["folds"])
    assert first["identity"] == study_v2_identity(json.loads(str(first["config_json"])))
    service.shutdown()

    refused_backup = tmp_path / "must-not-exist.backup.db"
    with pytest.raises(subprocess.CalledProcessError):
        subprocess.run(
            [
                sys.executable,
                str(
                    Path(__file__).parents[1]
                    / "scripts"
                    / "rollback_backtest_m8_schema.py"
                ),
                "--database",
                str(path),
                "--backup",
                str(refused_backup),
                "--confirm",
                "ROLLBACK_M8_SCHEMA_TO_V2",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
    assert not refused_backup.exists()
    still_current = sqlite3.connect(path)
    assert (
        still_current.execute(
            "SELECT schema_version FROM backtest_schema_meta"
        ).fetchone()[0]
        == SCHEMA_VERSION
    )
    still_current.close()


def test_v2_state_machine_recovers_without_duplicate_test_run(tmp_path: Path) -> None:
    service = BacktestService.start(
        load_backtest_settings(
            {
                "BACKTEST_ENABLED": "1",
                "BACKTEST_BAR_ENABLED": "1",
                "BACKTEST_STUDY_ENABLED": "1",
            },
            data_dir=tmp_path,
            klines_db_path=tmp_path / "candlescope.db",
            replay_db_path=tmp_path / "replay.db",
        ),
        now_ms=1,
    )
    payload = _study_payload()
    payload.update({"end_ms": 70 * DAY, "step_ms": 20 * DAY})
    study = service.create_study(payload, now_ms=2)
    study_id = str(study["study_id"])
    service.start_study(study_id)

    def preview(**_: object) -> dict[str, str]:
        return {"snapshot_hash": "sha256:" + "33" * 32}

    service.materialize_study_runs(study_id, preview_snapshot=preview)
    train_trials = service.repository.list_train_trials(study_id)
    assert len(train_trials) == 2
    for index, trial in enumerate(train_trials, 1):
        run_id = str(trial["run_id"])
        service.repository.update_run_state(
            run_id, state="COMPLETED", updated_at_ms=10 + index
        )
        report = _report(total_return=f"0.{index}", report_hash=f"sha256:train-{index}")
        service.repository.save_report(
            run_id,
            "candlescope.backtest-report/2",
            json.dumps(report),
            str(report["hashes"]["report"]),
            20 + index,
        )
    service.materialize_study_runs(study_id, preview_snapshot=preview)
    fold = service.repository.list_study_folds(study_id)[0]
    assert fold["selected_receipt_hash"]
    test_run_id = str(fold["test_run_id"])
    service.materialize_study_runs(study_id, preview_snapshot=preview)
    assert (
        service.repository.list_study_folds(study_id)[0]["test_run_id"] == test_run_id
    )
    assert len(service.list_runs()) == 3
    service.repository.update_run_state(
        test_run_id, state="COMPLETED", updated_at_ms=30
    )
    test_report = _report(
        total_return="0.03", start_ms=50 * DAY, report_hash="sha256:test"
    )
    service.repository.save_report(
        test_run_id,
        "candlescope.backtest-report/2",
        json.dumps(test_report),
        "sha256:test",
        31,
    )
    completed = service.materialize_study_runs(study_id, preview_snapshot=preview)
    assert completed["state"] == "COMPLETED"
    assert completed["oos_report"]["sourcePolicy"] == "TEST_RUNS_ONLY_V1"
    service.shutdown()

    restarted = BacktestService.start(
        load_backtest_settings(
            {
                "BACKTEST_ENABLED": "1",
                "BACKTEST_BAR_ENABLED": "1",
                "BACKTEST_STUDY_ENABLED": "1",
            },
            data_dir=tmp_path,
            klines_db_path=tmp_path / "candlescope.db",
            replay_db_path=tmp_path / "replay.db",
        ),
        now_ms=40,
    )
    recovered = restarted.get_study(study_id)
    assert recovered["state"] == "COMPLETED"
    assert len(restarted.list_runs()) == 3
    restarted.shutdown()


def test_selection_receipt_content_address_is_reused_across_identical_studies(
    tmp_path: Path,
) -> None:
    service = BacktestService.start(
        load_backtest_settings(
            {
                "BACKTEST_ENABLED": "1",
                "BACKTEST_BAR_ENABLED": "1",
                "BACKTEST_STUDY_ENABLED": "1",
            },
            data_dir=tmp_path,
            klines_db_path=tmp_path / "candlescope.db",
            replay_db_path=tmp_path / "replay.db",
        ),
        now_ms=1,
    )
    first = service.start_study(
        str(service.create_study(_study_payload(), now_ms=2)["study_id"])
    )
    first_fold = first["folds"][0]
    common = {
        "receipt_hash": "sha256:" + "12" * 32,
        "payload_json": '{"hashes":{"receipt":"sha256:shared"}}',
        "selected_params_json": '{"length":24}',
        "selected_params_hash": "sha256:" + "34" * 32,
        "created_at_ms": 4,
    }
    first_row = service.repository.insert_selection_receipt(
        {
            **common,
            "study_id": first["study_id"],
            "fold_id": first_fold["fold_id"],
            "selected_train_trial_id": first_fold["train_trials"][0]["train_trial_id"],
        }
    )
    service.repository.update_study_state(str(first["study_id"]), "COMPLETED")
    second = service.start_study(
        str(service.create_study(_study_payload(), now_ms=5)["study_id"])
    )
    second_fold = second["folds"][0]
    second_row = service.repository.insert_selection_receipt(
        {
            **common,
            "study_id": second["study_id"],
            "fold_id": second_fold["fold_id"],
            "selected_train_trial_id": second_fold["train_trials"][0]["train_trial_id"],
        }
    )
    assert first_row["receipt_hash"] == second_row["receipt_hash"]
    linked = service.repository.get_selection_receipt(str(second_fold["fold_id"]))
    assert linked is not None and linked["payload_json"] == common["payload_json"]
    assert (
        service.repository.list_study_folds(str(second["study_id"]))[0]["state"]
        == "SELECTED"
    )
    service.shutdown()


def test_holdout_reveal_is_once_and_reuses_one_run(tmp_path: Path) -> None:
    service = BacktestService.start(
        load_backtest_settings(
            {
                "BACKTEST_ENABLED": "1",
                "BACKTEST_BAR_ENABLED": "1",
                "BACKTEST_STUDY_ENABLED": "1",
            },
            data_dir=tmp_path,
            klines_db_path=tmp_path / "candlescope.db",
            replay_db_path=tmp_path / "replay.db",
        ),
        now_ms=1,
    )
    payload = _study_payload()
    payload.update({"end_ms": 80 * DAY - 1, "holdout_ms": 10 * DAY})
    study = service.create_study(payload, now_ms=2)
    frozen_config = json.loads(str(study["config_json"]))
    assert frozen_config["end_ms"] == 80 * DAY
    assert frozen_config["window_semantics"] == "START_INCLUSIVE_END_EXCLUSIVE_V2"
    study_id = str(study["study_id"])
    service.start_study(study_id)

    def preview(**_: object) -> dict[str, str]:
        return {"snapshot_hash": "sha256:" + "44" * 32}

    service.materialize_study_runs(study_id, preview_snapshot=preview)
    for index, trial in enumerate(service.repository.list_train_trials(study_id), 1):
        run_id = str(trial["run_id"])
        service.repository.update_run_state(
            run_id, state="COMPLETED", updated_at_ms=10 + index
        )
        report = _report(
            total_return=f"0.{index}", report_hash=f"sha256:htrain-{index}"
        )
        service.repository.save_report(
            run_id,
            "candlescope.backtest-report/2",
            json.dumps(report),
            str(report["hashes"]["report"]),
            20 + index,
        )
    service.materialize_study_runs(study_id, preview_snapshot=preview)
    fold = service.repository.list_study_folds(study_id)[0]
    test_run_id = str(fold["test_run_id"])
    service.repository.update_run_state(
        test_run_id, state="COMPLETED", updated_at_ms=30
    )
    test_report = _report(
        total_return="0.03", start_ms=50 * DAY, report_hash="sha256:htest"
    )
    service.repository.save_report(
        test_run_id,
        "candlescope.backtest-report/2",
        json.dumps(test_report),
        "sha256:htest",
        31,
    )
    awaiting = service.materialize_study_runs(study_id, preview_snapshot=preview)
    assert awaiting["state"] == "AWAITING_HOLDOUT"
    first = service.reveal_study_holdout(study_id)
    second = service.reveal_study_holdout(study_id)
    assert (
        first["holdout"]["reveal_receipt_hash"]
        == second["holdout"]["reveal_receipt_hash"]
    )
    service.materialize_study_runs(study_id, preview_snapshot=preview)
    holdout = service.repository.get_holdout(study_id)
    assert holdout is not None and holdout["run_id"]
    holdout_run_id = str(holdout["run_id"])
    holdout_run = service.get_run(holdout_run_id)
    holdout_config = json.loads(str(holdout_run["config_json"]))
    assert holdout_config["start_time_ms"] == 70 * DAY
    assert holdout_config["end_time_ms"] == 80 * DAY - 1
    assert holdout_config["parameters"]["trigger_mode"] == "LEVEL_TARGET_V1"
    service.materialize_study_runs(study_id, preview_snapshot=preview)
    assert service.repository.get_holdout(study_id)["run_id"] == holdout_run_id
    assert len(service.list_runs()) == 4
    service.repository.update_run_state(
        holdout_run_id, state="COMPLETED", updated_at_ms=40
    )
    completed = service.materialize_study_runs(study_id, preview_snapshot=preview)
    assert completed["state"] == "COMPLETED"
    assert completed["holdout"]["state"] == "COMPLETED"
    service.shutdown()


def test_v2_total_run_budget_cannot_exceed_frozen_ceiling(tmp_path: Path) -> None:
    service = BacktestService.start(
        load_backtest_settings(
            {"BACKTEST_ENABLED": "1", "BACKTEST_STUDY_ENABLED": "1"},
            data_dir=tmp_path,
            klines_db_path=tmp_path / "candlescope.db",
            replay_db_path=tmp_path / "replay.db",
        ),
        now_ms=1,
    )
    payload = _study_payload()
    payload["parameter_space"] = {
        "length": list(range(2, 42)),
        "oversold": [30],
        "overbought": [70],
    }
    payload["candidate_budget"] = 40
    with pytest.raises(BacktestError, match="frozen ceiling"):
        service.create_study(payload, now_ms=2)
    service.shutdown()


def test_v2_cancel_preserves_receipt_and_plans_no_new_run(tmp_path: Path) -> None:
    service = BacktestService.start(
        load_backtest_settings(
            {
                "BACKTEST_ENABLED": "1",
                "BACKTEST_BAR_ENABLED": "1",
                "BACKTEST_STUDY_ENABLED": "1",
            },
            data_dir=tmp_path,
            klines_db_path=tmp_path / "candlescope.db",
            replay_db_path=tmp_path / "replay.db",
        ),
        now_ms=1,
    )
    payload = _study_payload()
    payload.update(
        {
            "end_ms": 70 * DAY,
            "parameter_space": {"length": [24], "oversold": [30], "overbought": [70]},
            "candidate_budget": 1,
        }
    )
    study = service.create_study(payload, now_ms=2)
    study_id = str(study["study_id"])
    service.start_study(study_id)

    def preview(**_: object) -> dict[str, str]:
        return {"snapshot_hash": "sha256:" + "55" * 32}

    service.materialize_study_runs(study_id, preview_snapshot=preview)
    trial = service.repository.list_train_trials(study_id)[0]
    train_run_id = str(trial["run_id"])
    service.repository.update_run_state(
        train_run_id, state="COMPLETED", updated_at_ms=10
    )
    report = _report(total_return="0.1", report_hash="sha256:cancel-train")
    service.repository.save_report(
        train_run_id,
        "candlescope.backtest-report/2",
        json.dumps(report),
        "sha256:cancel-train",
        11,
    )
    service.materialize_study_runs(study_id, preview_snapshot=preview)
    fold = service.repository.list_study_folds(study_id)[0]
    receipt_hash = str(fold["selected_receipt_hash"])
    test_run_id = str(fold["test_run_id"])
    before_count = len(service.list_runs())
    cancelled = service.cancel_study(study_id)
    assert cancelled["state"] == "CANCELLED"
    assert service.get_run(test_run_id)["state"] == "CANCELLED"
    assert (
        service.repository.get_selection_receipt(str(fold["fold_id"]))["receipt_hash"]
        == receipt_hash
    )
    service.materialize_study_runs(study_id, preview_snapshot=preview)
    assert len(service.list_runs()) == before_count
    service.shutdown()


def test_rsi24_study_v2_completes_real_runtime_folds_and_oos(tmp_path: Path) -> None:
    start = 1_704_067_200_000
    rows = 200

    def price(index: int) -> int:
        phase = index % 40
        return 130 - 3 * phase if phase < 20 else 70 + 3 * (phase - 20)

    csv_path = tmp_path / "rsi24.csv"
    previous = price(0)
    wires = []
    for index in range(rows):
        close = price(index)
        wires.append(
            f"{start + index * DAY},{previous},{max(previous, close) + 2},"
            f"{min(previous, close) - 2},{close},100"
        )
        previous = close
    csv_path.write_text(
        "time,open,high,low,close,volume\n" + "\n".join(wires), encoding="utf-8"
    )
    local_root = tmp_path / "local"
    local = LocalDatasetService(local_root)
    original = local.import_csv(
        csv_path,
        LocalImportOptions(
            name="M8 RSI24 runtime",
            symbol="BTCUSDT",
            interval="1d",
            timestamp_unit="ms",
        ),
    )
    provenance = {
        "provider": "M8_PINNED_FIXTURE",
        "source_url": "https://example.invalid/m8",
        "capture_receipt": "m8-runtime-fixture",
    }
    tier = {
        "notional_floor": "0",
        "notional_cap": "1000000",
        "maintenance_rate": "0.005",
        "maintenance_deduction": "0",
    }
    contract = {
        "schema_version": "candlescope.contract-history.v1",
        "identity": {"venue": "binance", "market_type": "usdm", "symbol": "BTCUSDT"},
        "roles": {
            "MARK_INDEX": {
                "cadence_ms": DAY,
                "retention_policy": "test_local_immutable",
                "provenance": provenance,
                "records": [
                    {
                        "event_time_ms": start + index * DAY,
                        "mark_price": str(price(index)),
                        "index_price": str(price(index)),
                    }
                    for index in range(rows)
                ],
            },
            "FUNDING": {
                "period_ms": DAY,
                "retention_policy": "test_local_immutable",
                "provenance": provenance,
                "records": [
                    {
                        "settlement_time_ms": start + index * DAY,
                        "period_id": f"m8-{index}",
                        "funding_rate": "0",
                        "mark_price": str(price(min(index, rows - 1))),
                    }
                    for index in range(1, rows + 1)
                ],
            },
            "INSTRUMENT_RULES": {
                "retention_policy": "test_local_immutable",
                "provenance": provenance,
                "records": [
                    {
                        "effective_from_ms": start,
                        "effective_to_ms": start + rows * DAY - 1,
                        "rule_version": "m8-rule-v1",
                        "contract_multiplier": "1",
                        "price_tick": "0.1",
                        "quantity_step": "0.001",
                        "min_quantity": "0.001",
                        "max_quantity": "1000",
                        "min_notional": "5",
                        "maintenance_tiers": [tier],
                    }
                ],
            },
        },
    }
    contract_path = tmp_path / "contract.json"
    contract_path.write_text(json.dumps(contract), encoding="utf-8")
    attached = local.import_contract_history(
        contract_path,
        dataset_id=str(original["dataset_id"]),
        data_epoch=str(original["data_epoch"]),
    )
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
    runtime = BacktestRuntime.start(settings, local_data_dir=local_root)
    try:
        end = start + rows * DAY - 1
        preview = runtime.preview_snapshot(
            dataset_id=str(attached["dataset_id"]),
            data_epoch=str(attached["data_epoch"]),
            start_time_ms=start,
            end_time_ms=end,
            interval="1d",
            contract_data_mode="HISTORICAL_CONTRACT_V1",
            account_model="LINEAR_PERP_ONE_WAY_V2",
            funding_mode="OFF",
        )
        payload = _study_payload()
        payload.update(
            {
                "dataset_id": attached["dataset_id"],
                "data_epoch": attached["data_epoch"],
                "dataset_snapshot_hash": preview["snapshot_hash"],
                "start_ms": start,
                "end_ms": end,
                "train_ms": 110 * DAY,
                "test_ms": 20 * DAY,
                "step_ms": 30 * DAY,
                "purge_ms": 0,
                "embargo_ms": 0,
                "constraints": {
                    "min_closed_trades": 1,
                    "max_drawdown": "1",
                    "cost_plus_25_must_be_positive": False,
                },
            }
        )
        created = runtime.service.create_study(payload)
        study_id = str(created["study_id"])
        runtime.service.start_study(study_id)
        deadline = time.monotonic() + 30
        study = runtime.service.get_study(study_id)
        while time.monotonic() < deadline and study["state"] not in {
            "COMPLETED",
            "FAILED",
        }:
            time.sleep(0.05)
            study = runtime.service.get_study(study_id)
        assert study["state"] == "COMPLETED", study
        assert len(study["folds"]) == 3
        assert all(fold["selection_receipt"] for fold in study["folds"])
        assert all(fold["test_run_id"] for fold in study["folds"])
        assert study["oos_report"]["sourcePolicy"] == "TEST_RUNS_ONLY_V1"
        test_ids = {fold["test_run_id"] for fold in study["folds"]}
        assert {row["test_run_id"] for row in study["oos_report"]["folds"]} == test_ids
        assert verify_oos_report(study["oos_report"])
    finally:
        runtime.shutdown()
