from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.backtest.errors import BacktestError
from app.backtest.service import BacktestService
from app.backtest.strategy.python_basket import (
    BASKET_PROTOCOL_V1,
    OFFICIAL_FROZEN_SYMBOLS,
    basket_identities,
    build_basket_robustness,
    independent_oos_summary,
    official_frozen_basket,
    official_frozen_members,
    plan_independent_runs,
    refuse_portfolio_sum,
    resolve_missing_members,
    select_params_train_only,
)
from app.backtest.study_v2 import (
    STUDY_PROTOCOL_V2,
    evaluate_train_candidate,
    study_v2_identity,
    walk_forward_folds_v2,
    verify_selection_receipt,
)
from app.core.config import load_backtest_settings

DAY = 86_400_000


def _report(*, total_return: str, trade_count: int = 2) -> dict[str, object]:
    return {
        "schemaVersion": "candlescope.backtest-report/2",
        "hashes": {"report": f"sha256:report-{total_return}"},
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
            "quality": {"gap_count": 0, "duplicate_count": 0, "ambiguity_count": 0},
            "execution": {
                "order_count": max(trade_count, 1),
                "rejected_order_count": 0,
            },
            "equity_daily": [
                {"event_time_ms": 0, "date": "2024-01-01", "equity": "10000"},
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


def _candidate(
    ordinal: int, length: int, report: dict[str, object]
) -> dict[str, object]:
    params = {"length": length}
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
                "max_ambiguity_ratio": "1",
                "max_rejected_ratio": "1",
                "cost_plus_25_must_be_positive": False,
            },
        ),
    }


def _identity(basket: dict[str, object]) -> dict[str, object]:
    return {
        "study_protocol_revision": STUDY_PROTOCOL_V2,
        "selection_protocol_revision": "TRAIN_CONSTRAINT_OBJECTIVE_SELECT_ONCE_V2",
        "hypothesis": "cross-symbol robustness",
        "dataset_id": basket["members"][0]["dataset_id"],
        "dataset_snapshot_hash": basket["members"][0]["snapshot_hash"],
        "dataset_basket_hash": basket["basket_hash"],
        "basket_protocol_revision": BASKET_PROTOCOL_V1,
        "seed": 7,
        "candidate_budget": 2,
    }


def _train_evaluations(
    basket: dict[str, object],
    *,
    winner: int = 24,
) -> dict[str, list[dict[str, object]]]:
    evaluations: dict[str, list[dict[str, object]]] = {}
    for member in basket["members"]:
        if member["role"] != "TRAIN":
            continue
        evaluations[member["dataset_id"]] = [
            _candidate(1, 20, _report(total_return="0.05")),
            _candidate(2, winner, _report(total_return="0.20")),
        ]
    return evaluations


def _constraints() -> dict[str, object]:
    return {
        "min_closed_trades": 1,
        "max_drawdown": "0.5",
        "min_data_coverage": "1",
        "max_ambiguity_ratio": "1",
        "max_rejected_ratio": "1",
        "cost_plus_25_must_be_positive": False,
    }


def _service(
    tmp_path: Path, extra_env: dict[str, str] | None = None
) -> BacktestService:
    env = {
        "BACKTEST_ENABLED": "1",
        "BACKTEST_BAR_ENABLED": "1",
        "BACKTEST_STUDY_ENABLED": "1",
        **(extra_env or {}),
    }
    return BacktestService.start(
        load_backtest_settings(
            env,
            data_dir=tmp_path,
            klines_db_path=tmp_path / "k.db",
            replay_db_path=tmp_path / "r.db",
        ),
        now_ms=1,
    )


def _study_payload(basket: dict[str, object]) -> dict[str, object]:
    anchor = next(item for item in basket["members"] if item["role"] == "TRAIN")
    return {
        "name": "N9 basket",
        "hypothesis": "Python edge is not a single-market artifact",
        "study_protocol_revision": STUDY_PROTOCOL_V2,
        "strategy_revision_id": "builtin-rsi-wilder-long-short-v1",
        "dataset_id": anchor["dataset_id"],
        "data_epoch": anchor["data_epoch"],
        "dataset_snapshot_hash": anchor["snapshot_hash"],
        "interval": "1d",
        "start_ms": 0,
        "end_ms": 100 * DAY,
        "train_ms": 45 * DAY,
        "test_ms": 15 * DAY,
        "step_ms": 20 * DAY,
        "purge_ms": DAY,
        "embargo_ms": DAY,
        "parameter_space": {"length": [20, 24]},
        "sampler": "grid",
        "seed": 7,
        "candidate_budget": 2,
        "objective": "NET_RETURN",
        "constraints": {"cost_plus_25_must_be_positive": False},
        "dataset_basket": {
            "members": official_frozen_members(),
            "missing_policy": "FAIL",
        },
    }


def test_basket_keeps_independent_accounts_and_refuses_sum(tmp_path: Path) -> None:
    items = basket_identities(["BTCUSDT", "ETHUSDT"], {"revision": "rev"})
    assert items[0]["independentAccount"] is True
    assert items[0]["symbol"] != items[1]["symbol"]
    with pytest.raises(ValueError, match="must not be summed"):
        refuse_portfolio_sum([{"hash": "a"}, {"hash": "b"}])
    settings = load_backtest_settings(
        {},
        data_dir=tmp_path,
        klines_db_path=tmp_path / "k.db",
        replay_db_path=tmp_path / "r.db",
    )
    assert settings.multi_market_enabled is False


def test_official_frozen_basket_has_ten_independent_datasets() -> None:
    basket = official_frozen_basket()
    assert len(OFFICIAL_FROZEN_SYMBOLS) == 10
    assert len(basket["members"]) == 10
    assert basket["basket_protocol_revision"] == BASKET_PROTOCOL_V1
    assert basket["portfolio_sum_forbidden"] is True
    assert basket["shared_capital"] is False
    assert {item["symbol"] for item in basket["members"]} == {
        symbol for symbol, _role, _regime in OFFICIAL_FROZEN_SYMBOLS
    }
    assert sum(item["role"] == "TRAIN" for item in basket["members"]) >= 1
    assert sum(item["role"] == "TEST" for item in basket["members"]) >= 1
    assert sum(item["role"] == "HOLDOUT" for item in basket["members"]) >= 1
    second = official_frozen_basket()
    assert basket["basket_hash"] == second["basket_hash"]


def test_same_seed_basket_budget_selection_receipt_is_stable() -> None:
    basket = official_frozen_basket()
    fold = walk_forward_folds_v2(
        start_ms=0, end_ms=900, train_ms=400, test_ms=100, step_ms=200
    )[0]
    evaluations = _train_evaluations(basket)
    first = select_params_train_only(
        basket=basket,
        identity=_identity(basket),
        fold=fold,
        evaluations_by_dataset=evaluations,
        objective="NET_RETURN",
        constraints=_constraints(),
    )
    second = select_params_train_only(
        basket=basket,
        identity=_identity(basket),
        fold=fold,
        evaluations_by_dataset=evaluations,
        objective="NET_RETURN",
        constraints=_constraints(),
    )
    assert first["receipt"]["selected"]["params"]["length"] == 24
    assert (
        first["receipt"]["hashes"]["receipt"] == second["receipt"]["hashes"]["receipt"]
    )
    assert verify_selection_receipt(first["receipt"])
    assert first["stability"]["stable"] is True
    serialized = json.dumps(first["receipt"]).lower()
    assert "holdout" not in serialized
    assert "adausdt" not in serialized
    assert "dotusdt" not in serialized


def test_test_and_holdout_symbols_cannot_select_params() -> None:
    basket = official_frozen_basket()
    fold = walk_forward_folds_v2(
        start_ms=0, end_ms=600, train_ms=400, test_ms=100, step_ms=100
    )[0]
    holdout = next(item for item in basket["members"] if item["role"] == "HOLDOUT")
    test_member = next(item for item in basket["members"] if item["role"] == "TEST")
    with pytest.raises(BacktestError, match="test/holdout"):
        select_params_train_only(
            basket=basket,
            identity=_identity(basket),
            fold=fold,
            evaluations_by_dataset={
                holdout["dataset_id"]: [_candidate(1, 24, _report(total_return="9"))]
            },
            objective="NET_RETURN",
            constraints=_constraints(),
        )
    with pytest.raises(BacktestError, match="test/holdout"):
        select_params_train_only(
            basket=basket,
            identity=_identity(basket),
            fold=fold,
            evaluations_by_dataset={
                test_member["dataset_id"]: [
                    _candidate(1, 24, _report(total_return="9"))
                ]
            },
            objective="NET_RETURN",
            constraints=_constraints(),
        )


def test_missing_symbol_fails_or_skips_without_silent_shrink() -> None:
    basket = official_frozen_basket()
    available = [
        item["dataset_id"] for item in basket["members"] if item["symbol"] != "ETHUSDT"
    ]
    with pytest.raises(BacktestError, match="missing_policy=FAIL"):
        resolve_missing_members(basket, available)
    skipped = resolve_missing_members(
        {**basket, "missing_policy": "SKIP"},
        available,
    )
    assert len(skipped["members"]) == 10
    missing = next(item for item in skipped["members"] if item["symbol"] == "ETHUSDT")
    assert missing["status"] == "MISSING"
    assert missing["skip_reason"] == "MISSING_DATASET"
    assert skipped["missing_members"][0]["symbol"] == "ETHUSDT"
    assert skipped["silent_shrink_forbidden"] is True


def test_independent_oos_traces_run_hashes_and_refuses_portfolio_fields() -> None:
    basket = official_frozen_basket()
    rows = []
    for index, member in enumerate(basket["members"]):
        if member["role"] == "TRAIN":
            continue
        rows.append(
            {
                "symbol": member["symbol"],
                "dataset_id": member["dataset_id"],
                "role": member["role"],
                "regime": member["regime"],
                "run_id": f"run-{index}",
                "report_hash": f"sha256:r{index}",
                "test_objective": "0.02" if member["role"] == "TEST" else "-0.01",
            }
        )
    summary = independent_oos_summary(rows)
    assert summary["portfolioSumForbidden"] is True
    assert len(summary["run_hashes"]) == len(rows)
    assert set(summary["run_ids"]) == {row["run_id"] for row in rows}
    with pytest.raises(BacktestError, match="portfolio"):
        independent_oos_summary([{**rows[0], "portfolio_contribution": "0.1"}])


def test_decision_fill_matrix_and_single_market_verdict() -> None:
    basket = official_frozen_basket()
    fold = walk_forward_folds_v2(
        start_ms=0, end_ms=600, train_ms=400, test_ms=100, step_ms=100
    )[0]
    reports: list[dict[str, object]] = []
    for member in basket["members"]:
        if member["role"] == "TRAIN":
            reports.append(
                {
                    "dataset_id": member["dataset_id"],
                    "window_role": "TRAIN",
                    "candidates": _train_evaluations(basket)[member["dataset_id"]],
                }
            )
            continue
        positive = member["symbol"] == "ADAUSDT"
        reports.append(
            {
                "dataset_id": member["dataset_id"],
                "window_role": "TEST" if member["role"] == "TEST" else "HOLDOUT",
                "run_id": f"run-{member['symbol']}",
                "report_hash": f"sha256:{member['symbol']}",
                "test_objective": "0.08" if positive else "-0.04",
                "fidelity_mode": "BAR_APPROX",
                "decision_hash": "sha256:decision",
                "fill_hash": f"sha256:bar-fill-{member['symbol']}",
                "cost_ok_base": True,
                "cost_ok_plus_25": False,
            }
        )
        reports.append(
            {
                "dataset_id": member["dataset_id"],
                "window_role": "TEST" if member["role"] == "TEST" else "HOLDOUT",
                "run_id": f"run-{member['symbol']}-agg",
                "report_hash": f"sha256:{member['symbol']}-agg",
                "test_objective": "0.07" if positive else "-0.05",
                "fidelity_mode": "AGG_TRADE_EXECUTION",
                "decision_hash": "sha256:decision",
                "fill_hash": f"sha256:trade-fill-{member['symbol']}",
            }
        )
    robustness = build_basket_robustness(
        basket=basket,
        identity=_identity(basket),
        member_reports=reports,
        seed=7,
        fold_count=1,
        fold=fold,
        objective="NET_RETURN",
        constraints=_constraints(),
    )
    assert robustness["verdict"]["single_market_only"] is True
    assert "SINGLE_SYMBOL_ONLY" in robustness["verdict"]["flags"]
    assert "SINGLE_WINDOW_ONLY" in robustness["verdict"]["flags"]
    assert "LOW_COST_ONLY" in robustness["verdict"]["flags"]
    matrix = robustness["decision_fill_matrix"]
    assert matrix["rows"]
    assert all(row["decision_matches"] for row in matrix["rows"])
    assert not any(row["fill_matches"] for row in matrix["rows"])
    again = build_basket_robustness(
        basket=basket,
        identity=_identity(basket),
        member_reports=reports,
        seed=7,
        fold_count=1,
        fold=fold,
        objective="NET_RETURN",
        constraints=_constraints(),
    )
    assert robustness["robustness_hash"] == again["robustness_hash"]
    assert robustness["selection"]["receipt_hash"] == again["selection"]["receipt_hash"]


def test_shared_capital_fields_are_rejected() -> None:
    with pytest.raises(BacktestError, match="shared-capital"):
        official_frozen_basket()
        from app.backtest.strategy.python_basket import normalize_basket

        normalize_basket(
            {
                "members": official_frozen_members(),
                "shared_capital": True,
            }
        )


def test_host_freezes_basket_and_compare_never_sums(tmp_path: Path) -> None:
    basket = official_frozen_basket()
    service = _service(tmp_path)
    created = service.create_study(_study_payload(basket), now_ms=2)
    config = json.loads(str(created["config_json"]))
    assert config["dataset_basket"]["basket_hash"] == basket["basket_hash"]
    assert config["basket_protocol_revision"] == BASKET_PROTOCOL_V1
    identity = study_v2_identity(config)
    assert identity["dataset_basket_hash"] == basket["basket_hash"]
    started = service.start_study(str(created["study_id"]))
    comparison = service.compare_study(str(created["study_id"]))
    assert comparison["portfolio_sum_forbidden"] is True
    assert comparison["multi_market_enabled"] is False
    assert comparison["dataset_basket"]["members"][0]["independent_account"] is True
    robustness = comparison["independent_symbol_robustness"]
    assert robustness["portfolio_sum_forbidden"] is True
    planned = plan_independent_runs(
        config["dataset_basket"],
        folds=started["folds"],
        holdout=False,
    )
    assert planned
    assert all(item["independentAccount"] is True for item in planned)
    assert all(item["portfolioSumForbidden"] is True for item in planned)
    injected = service.evaluate_basket_reports(
        str(created["study_id"]),
        [
            {
                "dataset_id": member["dataset_id"],
                "window_role": "TEST",
                "run_id": f"run-{member['symbol']}",
                "report_hash": f"sha256:{member['symbol']}",
                "test_objective": "0.03",
            }
            for member in basket["members"]
            if member["role"] == "TEST"
        ],
    )
    assert set(injected["independent_oos"]["run_hashes"]) == {
        f"sha256:{member['symbol']}"
        for member in basket["members"]
        if member["role"] == "TEST"
    }
    assert injected["verdict"]["single_market_only"] is False
    assert injected["verdict"]["verdict"] == "CROSS_SYMBOL_SUPPORT"
    service.shutdown()


def test_host_rejects_anchor_outside_train_and_multi_market(tmp_path: Path) -> None:
    basket = official_frozen_basket()
    payload = _study_payload(basket)
    holdout = next(item for item in basket["members"] if item["role"] == "HOLDOUT")
    payload["dataset_id"] = holdout["dataset_id"]
    payload["data_epoch"] = holdout["data_epoch"]
    payload["dataset_snapshot_hash"] = holdout["snapshot_hash"]
    service = _service(tmp_path)
    with pytest.raises(BacktestError, match="TRAIN basket member"):
        service.create_study(payload, now_ms=2)
    service.shutdown()

    blocked = _service(tmp_path / "mm", {"BACKTEST_MULTI_MARKET_ENABLED": "1"})
    assert blocked.settings.multi_market_enabled is True
    with pytest.raises(BacktestError, match="not shared-capital"):
        blocked.create_study(_study_payload(basket), now_ms=3)
    blocked.shutdown()


def test_existing_study_identity_omits_absent_basket() -> None:
    identity = study_v2_identity(
        {
            "study_protocol_revision": STUDY_PROTOCOL_V2,
            "dataset_id": "local-m8",
            "seed": 1,
        }
    )
    assert "dataset_basket_hash" not in identity
    assert "basket_protocol_revision" not in identity
