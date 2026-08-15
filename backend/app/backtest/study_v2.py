"""Deterministic train-select-test Study V2 contracts.

Selection consumes only completed train reports.  Test and holdout evidence are
deliberately accepted only by the OOS aggregation functions after a receipt is
sealed, so they cannot influence parameter selection.
"""

from __future__ import annotations

import itertools
import random
from dataclasses import asdict, dataclass
from decimal import Decimal, InvalidOperation
from typing import Any, Mapping, Sequence

from app.backtest.errors import BacktestError
from app.backtest.identity import sha256_hex


STUDY_PROTOCOL_V2 = "BACKTEST_WALK_FORWARD_V2"
SELECTION_PROTOCOL_V2 = "TRAIN_CONSTRAINT_OBJECTIVE_SELECT_ONCE_V2"
STUDY_SCHEMA_V2 = "candlescope.backtest-study/2"
SELECTION_RECEIPT_SCHEMA = "candlescope.backtest-selection-receipt/1"
OOS_REPORT_SCHEMA = "candlescope.backtest-oos-report/1"
HOLDOUT_RECEIPT_SCHEMA = "candlescope.backtest-holdout-reveal/1"
TIE_BREAK_V1 = "OBJECTIVE_DESC_DRAWDOWN_ASC_PARAMS_HASH_ASC_V1"
OBJECTIVES = frozenset({"NET_RETURN", "SHARPE", "CALMAR", "EXPECTANCY"})


@dataclass(frozen=True, slots=True)
class FoldSpecV2:
    ordinal: int
    train_start_ms: int
    train_end_ms: int
    test_start_ms: int
    test_end_ms: int
    purge_ms: int
    embargo_ms: int

    @property
    def fold_key(self) -> str:
        return f"fold-{self.ordinal}"


def walk_forward_folds_v2(
    *,
    start_ms: int,
    end_ms: int,
    train_ms: int,
    test_ms: int,
    step_ms: int,
    purge_ms: int = 0,
    embargo_ms: int = 0,
    holdout_ms: int = 0,
) -> tuple[FoldSpecV2, ...]:
    values = (train_ms, test_ms, step_ms)
    if any(value <= 0 for value in values):
        raise BacktestError("STUDY_SPLIT_LEAK", "train/test/step must be positive")
    if step_ms < test_ms:
        raise BacktestError(
            "STUDY_SPLIT_LEAK",
            "step must be at least test length for non-overlapping OOS",
        )
    if min(purge_ms, embargo_ms, holdout_ms) < 0:
        raise BacktestError(
            "STUDY_SPLIT_LEAK", "purge/embargo/holdout cannot be negative"
        )
    if purge_ms >= train_ms:
        raise BacktestError("STUDY_SPLIT_LEAK", "purge removes the entire train window")
    research_end = end_ms - holdout_ms
    if research_end <= start_ms:
        raise BacktestError("STUDY_SPLIT_LEAK", "holdout removes the research window")
    folds: list[FoldSpecV2] = []
    cursor = start_ms
    ordinal = 1
    while True:
        boundary = cursor + train_ms
        train_end = boundary - purge_ms
        test_start = boundary + embargo_ms
        test_end = test_start + test_ms
        if test_end > research_end:
            break
        folds.append(
            FoldSpecV2(
                ordinal=ordinal,
                train_start_ms=cursor,
                train_end_ms=train_end,
                test_start_ms=test_start,
                test_end_ms=test_end,
                purge_ms=purge_ms,
                embargo_ms=embargo_ms,
            )
        )
        cursor += step_ms
        ordinal += 1
    if not folds:
        raise BacktestError("STUDY_SPLIT_LEAK", "walk-forward produced no folds")
    for fold in folds:
        if fold.train_end_ms <= fold.train_start_ms:
            raise BacktestError("STUDY_SPLIT_LEAK", "empty train window")
        if fold.test_end_ms <= fold.test_start_ms:
            raise BacktestError("STUDY_SPLIT_LEAK", "empty test window")
        if fold.test_start_ms < fold.train_end_ms:
            raise BacktestError("STUDY_SPLIT_LEAK", "test overlaps train")
    return tuple(folds)


def sample_candidates_v2(
    space: Mapping[str, Sequence[Any]],
    *,
    sampler: str,
    seed: int,
    candidate_budget: int,
) -> tuple[dict[str, Any], ...]:
    if candidate_budget < 1:
        raise BacktestError("BUDGET_EXCEEDED", "candidate_budget must be positive")
    keys = tuple(sorted(space))
    if not keys or any(
        not isinstance(space[key], Sequence) or not space[key] for key in keys
    ):
        raise BacktestError(
            "SCHEMA_UNKNOWN_FIELD", "parameter_space values must be non-empty arrays"
        )
    universe = [
        {key: value for key, value in zip(keys, values, strict=True)}
        for values in itertools.product(*(tuple(space[key]) for key in keys))
    ]
    if sampler == "grid":
        selected = universe[:candidate_budget]
    elif sampler == "random":
        rng = random.Random(seed)
        order = list(range(len(universe)))
        rng.shuffle(order)
        selected = [universe[index] for index in order[:candidate_budget]]
    else:
        raise BacktestError("SCHEMA_UNKNOWN_FIELD", "sampler must be grid or random")
    if not selected:
        raise BacktestError(
            "SCHEMA_UNKNOWN_FIELD", "parameter_space produced no candidates"
        )
    return tuple(selected)


def study_v2_identity(config: Mapping[str, Any]) -> dict[str, Any]:
    """Return only immutable research identity fields used by receipt hashes."""

    keys = (
        "study_protocol_revision",
        "selection_protocol_revision",
        "hypothesis",
        "strategy_revision_id",
        "dataset_id",
        "data_epoch",
        "dataset_snapshot_hash",
        "interval",
        "window_semantics",
        "start_ms",
        "end_ms",
        "train_ms",
        "test_ms",
        "step_ms",
        "purge_ms",
        "embargo_ms",
        "holdout_ms",
        "parameter_space",
        "sampler",
        "seed",
        "candidate_budget",
        "total_run_budget",
        "objective",
        "constraints",
        "tie_break",
        "account_model",
        "contract_data_mode",
        "funding_mode",
        "execution_model_revision",
        "fill_policy",
        "slippage_bps",
        "taker_fee_bps",
        "maker_fee_bps",
        "benchmark_model",
        "metrics_version",
        "equity_sampling",
        "annualization_days",
        "risk_free_rate_annual",
    )
    return {key: config.get(key) for key in keys}


def evaluate_train_candidate(
    report: Mapping[str, Any],
    *,
    objective: str,
    constraints: Mapping[str, Any],
) -> dict[str, Any]:
    performance = report.get("performance")
    if not isinstance(performance, Mapping):
        return _ineligible("REPORT_V2_REQUIRED")
    if str(performance.get("metrics_version")) != "BACKTEST_METRICS_V2":
        return _ineligible("METRICS_V2_REQUIRED")
    objective_value = _objective_value(performance, objective)
    violations: list[str] = []
    warnings: list[str] = []
    if objective_value is None:
        violations.append("OBJECTIVE_NULL")

    metrics = report.get("metrics") or {}
    trading = performance.get("trading") or {}
    risk = performance.get("risk") or {}
    quality = performance.get("quality") or {}
    execution = performance.get("execution") or {}
    closed_trades = int(metrics.get("trade_count") or trading.get("trade_count") or 0)
    minimum_trades = int(constraints.get("min_closed_trades", 1))
    if closed_trades < minimum_trades:
        violations.append("MIN_CLOSED_TRADES")

    max_drawdown = _metric_decimal(risk.get("max_drawdown"))
    if constraints.get("max_drawdown") is not None:
        limit = _decimal(constraints["max_drawdown"])
        if max_drawdown is None or max_drawdown > limit:
            violations.append("MAX_DRAWDOWN")

    coverage = _coverage_ratio(quality)
    if coverage < _decimal(constraints.get("min_data_coverage", "1")):
        violations.append("MIN_DATA_COVERAGE")

    order_count = max(int(execution.get("order_count") or 0), 1)
    ambiguity_ratio = Decimal(int(quality.get("ambiguity_count") or 0)) / Decimal(
        order_count
    )
    rejected_ratio = Decimal(int(execution.get("rejected_order_count") or 0)) / Decimal(
        order_count
    )
    if ambiguity_ratio > _decimal(constraints.get("max_ambiguity_ratio", "0")):
        violations.append("MAX_AMBIGUITY_RATIO")
    if rejected_ratio > _decimal(constraints.get("max_rejected_ratio", "0")):
        violations.append("MAX_REJECTED_RATIO")

    if bool(constraints.get("cost_plus_25_must_be_positive", True)):
        if not _cost_plus_25_positive(report):
            violations.append("COST_PLUS_25_NOT_POSITIVE")

    long_count = int((trading.get("long") or {}).get("trade_count") or 0)
    short_count = int((trading.get("short") or {}).get("trade_count") or 0)
    if long_count < int(constraints.get("warn_min_long_trades", 1)):
        warnings.append("LONG_SAMPLE_SMALL")
    if short_count < int(constraints.get("warn_min_short_trades", 1)):
        warnings.append("SHORT_SAMPLE_SMALL")
    return {
        "eligible": not violations,
        "objective_value": None if objective_value is None else str(objective_value),
        "max_drawdown": None if max_drawdown is None else str(max_drawdown),
        "closed_trade_count": closed_trades,
        "data_coverage": str(coverage),
        "ambiguity_ratio": str(ambiguity_ratio),
        "rejected_ratio": str(rejected_ratio),
        "violations": violations,
        "warnings": warnings,
    }


def build_selection_receipt(
    *,
    identity: Mapping[str, Any],
    fold: FoldSpecV2 | Mapping[str, Any],
    candidates: Sequence[Mapping[str, Any]],
    objective: str,
    constraints: Mapping[str, Any],
) -> dict[str, Any]:
    if objective not in OBJECTIVES:
        raise BacktestError(
            "SCHEMA_UNKNOWN_FIELD", f"unsupported objective {objective}"
        )
    fold_payload = asdict(fold) if isinstance(fold, FoldSpecV2) else dict(fold)
    frozen_candidates = sorted(
        (
            {
                "candidate_ordinal": int(item["candidate_ordinal"]),
                "params": dict(item["params"]),
                "params_hash": str(item["params_hash"]),
                "evaluation": dict(item["evaluation"]),
            }
            for item in candidates
        ),
        key=lambda item: item["candidate_ordinal"],
    )
    eligible = [
        item for item in frozen_candidates if item["evaluation"].get("eligible")
    ]
    if not eligible:
        raise BacktestError(
            "STUDY_NO_ELIGIBLE_CANDIDATE", "no train candidate satisfies constraints"
        )

    def selection_key(item: Mapping[str, Any]) -> tuple[Decimal, Decimal, str]:
        evaluation = item["evaluation"]
        objective_value = _decimal(evaluation["objective_value"])
        drawdown = _decimal(evaluation.get("max_drawdown") or "Infinity")
        return (-objective_value, drawdown, str(item["params_hash"]))

    selected = min(eligible, key=selection_key)
    receipt = {
        "schemaVersion": SELECTION_RECEIPT_SCHEMA,
        "selectionProtocolRevision": SELECTION_PROTOCOL_V2,
        "studyIdentity": dict(identity),
        "studyIdentityHash": "sha256:" + sha256_hex(identity),
        "fold": fold_payload,
        "objective": objective,
        "constraints": dict(constraints),
        "tieBreak": TIE_BREAK_V1,
        "candidates": frozen_candidates,
        "selected": {
            "candidate_ordinal": selected["candidate_ordinal"],
            "params": selected["params"],
            "params_hash": selected["params_hash"],
            "objective_value": selected["evaluation"]["objective_value"],
        },
        "robustness": {
            "parameter_neighborhood": _parameter_neighborhood(
                selected, frozen_candidates
            ),
            "multiple_trial_warning": (
                "SELECTION_BIAS_REVIEW_REQUIRED" if len(frozen_candidates) > 1 else None
            ),
        },
        "hashes": {"receipt": None},
    }
    receipt["hashes"]["receipt"] = "sha256:" + sha256_hex(receipt)
    return receipt


def verify_selection_receipt(receipt: Mapping[str, Any]) -> bool:
    expected = str((receipt.get("hashes") or {}).get("receipt") or "")
    payload = _without_hash(receipt, "receipt")
    return bool(expected) and expected == "sha256:" + sha256_hex(payload)


def build_oos_report(
    *,
    identity: Mapping[str, Any],
    folds: Sequence[Mapping[str, Any]],
    seed: int,
) -> dict[str, Any]:
    if not folds:
        raise BacktestError("IDENTITY_MUTATION", "OOS report requires test folds")
    curve: list[dict[str, Any]] = []
    fold_rows: list[dict[str, Any]] = []
    previous_equity = Decimal("1")
    all_trade_pnl: list[Decimal] = []
    for item in sorted(folds, key=lambda row: int(row["ordinal"])):
        if str(item.get("run_role")) != "TEST":
            raise BacktestError(
                "STUDY_SPLIT_LEAK", "OOS aggregation accepts TEST runs only"
            )
        report = item.get("report")
        receipt = item.get("receipt")
        if not isinstance(report, Mapping) or not isinstance(receipt, Mapping):
            raise BacktestError(
                "IDENTITY_MUTATION", "test report and selection receipt are required"
            )
        if not verify_selection_receipt(receipt):
            raise BacktestError("HASH_MISMATCH", "selection receipt hash mismatch")
        daily = (report.get("performance") or {}).get("equity_daily") or []
        if not daily:
            raise BacktestError(
                "DATA_QUALITY_FAILED", "test report has no daily equity"
            )
        first = _decimal(daily[0]["equity"])
        if first <= 0:
            raise BacktestError(
                "DATA_QUALITY_FAILED", "test equity starts non-positive"
            )
        segment_start = previous_equity
        for point in daily:
            normalized = segment_start * _decimal(point["equity"]) / first
            wire = {
                "event_time_ms": int(point["event_time_ms"]),
                "date": str(point["date"]),
                "equity": str(normalized),
                "fold_ordinal": int(item["ordinal"]),
                "run_role": "TEST",
            }
            if curve and wire["event_time_ms"] <= int(curve[-1]["event_time_ms"]):
                raise BacktestError(
                    "STUDY_SPLIT_LEAK", "test OOS windows overlap or regress"
                )
            curve.append(wire)
        previous_equity = _decimal(curve[-1]["equity"])
        performance = report.get("performance") or {}
        objective = str(receipt.get("objective"))
        test_objective = _objective_value(performance, objective)
        train_objective = _decimal(receipt["selected"]["objective_value"])
        benchmark = _metric_decimal(
            (performance.get("returns") or {}).get("benchmark_return")
        )
        regime = (
            "UNKNOWN"
            if benchmark is None
            else ("UP" if benchmark > 0 else "DOWN" if benchmark < 0 else "FLAT")
        )
        for trade in report.get("trades") or []:
            if trade.get("net_pnl") is not None:
                all_trade_pnl.append(_decimal(trade["net_pnl"]))
        fold_rows.append(
            {
                "ordinal": int(item["ordinal"]),
                "receipt_hash": receipt["hashes"]["receipt"],
                "selected_params": receipt["selected"]["params"],
                "test_run_id": str(item["test_run_id"]),
                "test_report_hash": str((report.get("hashes") or {}).get("report")),
                "train_objective": str(train_objective),
                "test_objective": None
                if test_objective is None
                else str(test_objective),
                "train_test_gap": None
                if test_objective is None
                else str(test_objective - train_objective),
                "benchmark_return": None if benchmark is None else str(benchmark),
                "always_flat_return": "0",
                "market_regime": regime,
                "cost_sensitivity": report.get("cost_sensitivity"),
            }
        )
    report = {
        "schemaVersion": OOS_REPORT_SCHEMA,
        "studyIdentity": dict(identity),
        "studyIdentityHash": "sha256:" + sha256_hex(identity),
        "sourcePolicy": "TEST_RUNS_ONLY_V1",
        "folds": fold_rows,
        "equity": curve,
        "summary": {
            "fold_count": len(fold_rows),
            "initial_equity": "1",
            "final_equity": str(previous_equity),
            "total_return": str(previous_equity - 1),
        },
        "robustness": {
            "trade_order_bootstrap": _bootstrap(all_trade_pnl, seed=seed),
            "selection_bias_warning": "MULTIPLE_TRIALS_REQUIRE_HUMAN_REVIEW",
            "benchmarks": ["BUY_HOLD_SAME_WINDOW_COSTS_V1", "ALWAYS_FLAT_V1"],
        },
        "hashes": {"report": None},
    }
    report["hashes"]["report"] = "sha256:" + sha256_hex(report)
    return report


def verify_oos_report(report: Mapping[str, Any]) -> bool:
    expected = str((report.get("hashes") or {}).get("report") or "")
    return bool(expected) and expected == "sha256:" + sha256_hex(
        _without_hash(report, "report")
    )


def build_holdout_receipt(
    *,
    identity: Mapping[str, Any],
    params: Mapping[str, Any],
    start_ms: int,
    end_ms: int,
) -> dict[str, Any]:
    receipt = {
        "schemaVersion": HOLDOUT_RECEIPT_SCHEMA,
        "studyIdentityHash": "sha256:" + sha256_hex(identity),
        "window": {"start_ms": start_ms, "end_ms": end_ms},
        "params": dict(params),
        "params_hash": "sha256:" + sha256_hex(params),
        "policy": "REVEAL_ONCE_AFTER_OOS_V1",
        "hashes": {"receipt": None},
    }
    receipt["hashes"]["receipt"] = "sha256:" + sha256_hex(receipt)
    return receipt


def verify_holdout_receipt(receipt: Mapping[str, Any]) -> bool:
    expected = str((receipt.get("hashes") or {}).get("receipt") or "")
    return bool(expected) and expected == "sha256:" + sha256_hex(
        _without_hash(receipt, "receipt")
    )


def _objective_value(performance: Mapping[str, Any], objective: str) -> Decimal | None:
    paths = {
        "NET_RETURN": ("returns", "total_return"),
        "SHARPE": ("risk", "sharpe"),
        "CALMAR": ("risk", "calmar"),
        "EXPECTANCY": ("trading", "expectancy"),
    }
    if objective not in paths:
        raise BacktestError(
            "SCHEMA_UNKNOWN_FIELD", f"unsupported objective {objective}"
        )
    group, name = paths[objective]
    return _metric_decimal((performance.get(group) or {}).get(name))


def _metric_decimal(value: Any) -> Decimal | None:
    if isinstance(value, Mapping):
        value = value.get("value")
    if value is None:
        return None
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        return None
    return result if result.is_finite() else None


def _coverage_ratio(quality: Mapping[str, Any]) -> Decimal:
    coverage = quality.get("data_coverage")
    if isinstance(coverage, Mapping) and coverage.get("coverage_ratio") is not None:
        value = _metric_decimal(coverage.get("coverage_ratio"))
        if value is not None:
            return value
    gaps = int(quality.get("gap_count") or 0)
    duplicates = int(quality.get("duplicate_count") or 0)
    return Decimal("1") if gaps == 0 and duplicates == 0 else Decimal("0")


def _cost_plus_25_positive(report: Mapping[str, Any]) -> bool:
    initial = _decimal(((report.get("account") or {}).get("initial_balance") or "0"))
    scenarios = (report.get("cost_sensitivity") or {}).get("scenarios") or []
    for scenario in scenarios:
        if str(scenario.get("name")) != "COSTS_PLUS_25_PERCENT":
            continue
        metrics = scenario.get("metrics") or {}
        value = _metric_decimal(metrics.get("final_equity"))
        return value is not None and value > initial
    return False


def _parameter_neighborhood(
    selected: Mapping[str, Any], candidates: Sequence[Mapping[str, Any]]
) -> dict[str, Any]:
    params = selected["params"]
    neighbors = []
    for item in candidates:
        if item["params_hash"] == selected["params_hash"]:
            continue
        differences = sum(
            params.get(key) != item["params"].get(key)
            for key in set(params) | set(item["params"])
        )
        if differences == 1:
            neighbors.append(item)
    eligible_values = [
        _decimal(item["evaluation"]["objective_value"])
        for item in neighbors
        if item["evaluation"].get("eligible")
        and item["evaluation"].get("objective_value") is not None
    ]
    return {
        "neighbor_count": len(neighbors),
        "eligible_neighbor_count": len(eligible_values),
        "objective_min": None if not eligible_values else str(min(eligible_values)),
        "objective_max": None if not eligible_values else str(max(eligible_values)),
    }


def _bootstrap(
    values: Sequence[Decimal], *, seed: int, samples: int = 200
) -> dict[str, Any]:
    if not values:
        return {
            "samples": 0,
            "p05": None,
            "median": None,
            "p95": None,
            "reason": "NO_CLOSED_TRADES",
        }
    rng = random.Random(seed)
    totals = sorted(
        sum((values[rng.randrange(len(values))] for _ in values), Decimal("0"))
        for _ in range(samples)
    )
    return {
        "samples": samples,
        "p05": str(totals[int((samples - 1) * 0.05)]),
        "median": str(totals[int((samples - 1) * 0.5)]),
        "p95": str(totals[int((samples - 1) * 0.95)]),
        "reason": None,
    }


def _ineligible(reason: str) -> dict[str, Any]:
    return {
        "eligible": False,
        "objective_value": None,
        "max_drawdown": None,
        "closed_trade_count": 0,
        "data_coverage": "0",
        "ambiguity_ratio": "0",
        "rejected_ratio": "0",
        "violations": [reason],
        "warnings": [],
    }


def _without_hash(payload: Mapping[str, Any], key: str) -> dict[str, Any]:
    result = dict(payload)
    hashes = dict(result.get("hashes") or {})
    hashes[key] = None
    result["hashes"] = hashes
    return result


def _decimal(value: Any) -> Decimal:
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise BacktestError(
            "SCHEMA_UNKNOWN_FIELD", f"invalid Decimal {value!r}"
        ) from exc
    if not result.is_finite():
        raise BacktestError("SCHEMA_UNKNOWN_FIELD", "Decimal must be finite")
    return result
