"""Independent per-symbol basket Study overlay. Not shared-capital multi-market."""

from __future__ import annotations

import hashlib
from decimal import Decimal, InvalidOperation
from typing import Any, Mapping, Sequence

from app.backtest.errors import BacktestError
from app.backtest.identity import sha256_hex
from app.backtest.study_v2 import (
    FoldSpecV2,
    build_selection_receipt,
    evaluate_train_candidate,
)

BASKET_PROTOCOL_V1 = "BACKTEST_INDEPENDENT_SYMBOL_BASKET_V1"
BASKET_OOS_SCHEMA = "candlescope.backtest-independent-symbol-oos/1"
BASKET_MATRIX_SCHEMA = "candlescope.backtest-decision-fill-matrix/1"
BASKET_ROBUSTNESS_SCHEMA = "candlescope.backtest-basket-robustness/1"
MISSING_POLICIES = frozenset({"FAIL", "SKIP"})
MEMBER_ROLES = frozenset({"TRAIN", "TEST", "HOLDOUT"})
REGIMES = frozenset({"TREND", "RANGE", "VOLATILE", "UNKNOWN"})
FORBIDDEN_PORTFOLIO_FIELDS = frozenset(
    {
        "portfolio_weights",
        "shared_capital",
        "correlation_margin",
        "cross_liquidation",
        "combined_account",
        "combined_equity",
        "portfolio_sum",
    }
)
OFFICIAL_FROZEN_SYMBOLS: tuple[tuple[str, str, str], ...] = (
    ("BTCUSDT", "TRAIN", "TREND"),
    ("ETHUSDT", "TRAIN", "TREND"),
    ("BNBUSDT", "TRAIN", "RANGE"),
    ("SOLUSDT", "TRAIN", "TREND"),
    ("XRPUSDT", "TRAIN", "RANGE"),
    ("ADAUSDT", "TEST", "TREND"),
    ("DOGEUSDT", "TEST", "RANGE"),
    ("AVAXUSDT", "TEST", "VOLATILE"),
    ("DOTUSDT", "HOLDOUT", "RANGE"),
    ("LINKUSDT", "HOLDOUT", "TREND"),
)


def basket_identities(
    symbols: list[str], base: Mapping[str, Any]
) -> list[dict[str, Any]]:
    if not symbols:
        raise ValueError("basket requires at least one symbol")
    return [
        {
            **dict(base),
            "symbol": symbol,
            "independentAccount": True,
            "portfolioSumForbidden": True,
        }
        for symbol in symbols
    ]


def refuse_portfolio_sum(reports: list[Mapping[str, Any]]) -> None:
    if len(reports) > 1:
        raise ValueError("independent symbol reports must not be summed as a portfolio")


def official_frozen_dataset_id(symbol: str) -> str:
    digest = hashlib.sha256(f"n9-frozen-{symbol}".encode("utf-8")).hexdigest()[:32]
    return f"local-{digest}"


def official_frozen_members() -> list[dict[str, Any]]:
    members: list[dict[str, Any]] = []
    for symbol, role, regime in OFFICIAL_FROZEN_SYMBOLS:
        dataset_id = official_frozen_dataset_id(symbol)
        members.append(
            {
                "dataset_id": dataset_id,
                "symbol": symbol,
                "data_epoch": "sha256:" + sha256_hex(f"n9-epoch-{symbol}"),
                "snapshot_hash": "sha256:" + sha256_hex(f"n9-snapshot-{symbol}"),
                "role": role,
                "regime": regime,
            }
        )
    return members


def official_frozen_basket() -> dict[str, Any]:
    return normalize_basket(
        {"members": official_frozen_members(), "missing_policy": "FAIL"}
    )


def normalize_basket(payload: Mapping[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, Mapping):
        raise BacktestError("SCHEMA_UNKNOWN_FIELD", "dataset_basket must be an object")
    leaked = sorted(FORBIDDEN_PORTFOLIO_FIELDS.intersection(payload))
    if leaked:
        raise BacktestError(
            "FIDELITY_UNSUPPORTED",
            "dataset basket cannot carry shared-capital fields: " + ",".join(leaked),
        )
    raw_members = payload.get("members")
    if not isinstance(raw_members, Sequence) or isinstance(raw_members, (str, bytes)):
        raise BacktestError(
            "SCHEMA_UNKNOWN_FIELD", "dataset_basket.members must be a non-empty array"
        )
    if not raw_members:
        raise BacktestError(
            "SCHEMA_UNKNOWN_FIELD", "dataset_basket.members must be a non-empty array"
        )
    missing_policy = str(payload.get("missing_policy") or "FAIL").upper()
    if missing_policy not in MISSING_POLICIES:
        raise BacktestError(
            "SCHEMA_UNKNOWN_FIELD", "missing_policy must be FAIL or SKIP"
        )

    seen_ids: set[str] = set()
    seen_symbols: set[str] = set()
    members: list[dict[str, Any]] = []
    for index, raw in enumerate(raw_members):
        if not isinstance(raw, Mapping):
            raise BacktestError(
                "SCHEMA_UNKNOWN_FIELD", f"basket member {index} must be an object"
            )
        leaked_member = sorted(FORBIDDEN_PORTFOLIO_FIELDS.intersection(raw))
        if leaked_member:
            raise BacktestError(
                "FIDELITY_UNSUPPORTED",
                "basket member cannot carry shared-capital fields",
            )
        dataset_id = str(raw.get("dataset_id") or "").strip()
        symbol = str(raw.get("symbol") or "").strip().upper()
        data_epoch = str(raw.get("data_epoch") or "").strip()
        snapshot_hash = str(
            raw.get("snapshot_hash") or raw.get("dataset_snapshot_hash") or ""
        ).strip()
        role = str(raw.get("role") or "TRAIN").strip().upper()
        regime = str(raw.get("regime") or "UNKNOWN").strip().upper()
        if not dataset_id or not symbol or not data_epoch or not snapshot_hash:
            raise BacktestError(
                "SCHEMA_UNKNOWN_FIELD",
                "basket member requires dataset_id, symbol, data_epoch, snapshot_hash",
            )
        if role not in MEMBER_ROLES:
            raise BacktestError(
                "SCHEMA_UNKNOWN_FIELD",
                "basket member role must be TRAIN, TEST, or HOLDOUT",
            )
        if regime not in REGIMES:
            raise BacktestError(
                "SCHEMA_UNKNOWN_FIELD",
                "basket member regime must be TREND, RANGE, VOLATILE, or UNKNOWN",
            )
        if dataset_id in seen_ids or symbol in seen_symbols:
            raise BacktestError(
                "IDENTITY_MUTATION",
                "basket members must have unique dataset_id and symbol",
            )
        seen_ids.add(dataset_id)
        seen_symbols.add(symbol)
        members.append(
            {
                "dataset_id": dataset_id,
                "symbol": symbol,
                "data_epoch": data_epoch,
                "snapshot_hash": snapshot_hash,
                "role": role,
                "regime": regime,
                "independent_account": True,
                "status": "PRESENT",
                "skip_reason": None,
            }
        )
    if not any(member["role"] == "TRAIN" for member in members):
        raise BacktestError(
            "STUDY_SPLIT_LEAK", "dataset basket requires at least one TRAIN member"
        )
    frozen = {
        "basket_protocol_revision": BASKET_PROTOCOL_V1,
        "missing_policy": missing_policy,
        "independent_account": True,
        "portfolio_sum_forbidden": True,
        "shared_capital": False,
        "members": members,
        "basket_hash": None,
    }
    frozen["basket_hash"] = "sha256:" + sha256_hex(
        {key: value for key, value in frozen.items() if key != "basket_hash"}
    )
    return frozen


def partition_basket(basket: Mapping[str, Any]) -> dict[str, list[dict[str, Any]]]:
    groups = {role: [] for role in MEMBER_ROLES}
    for member in basket.get("members") or []:
        role = str(member.get("role") or "")
        if role not in groups:
            raise BacktestError("SCHEMA_UNKNOWN_FIELD", f"unknown basket role {role}")
        groups[role].append(dict(member))
    return groups


def resolve_missing_members(
    basket: Mapping[str, Any],
    available_dataset_ids: Sequence[str],
) -> dict[str, Any]:
    available = {str(item) for item in available_dataset_ids}
    policy = str(basket.get("missing_policy") or "FAIL").upper()
    members: list[dict[str, Any]] = []
    missing: list[dict[str, Any]] = []
    for member in basket.get("members") or []:
        item = dict(member)
        if item["dataset_id"] in available:
            item["status"] = "PRESENT"
            item["skip_reason"] = None
            members.append(item)
            continue
        item["status"] = "MISSING"
        item["skip_reason"] = "MISSING_DATASET"
        missing.append(item)
        if policy == "FAIL":
            raise BacktestError(
                "DATA_QUALITY_FAILED",
                f"basket member {item['symbol']} is missing and missing_policy=FAIL",
                details={"dataset_id": item["dataset_id"], "symbol": item["symbol"]},
            )
        if policy != "SKIP":
            raise BacktestError(
                "SCHEMA_UNKNOWN_FIELD", "missing_policy must be FAIL or SKIP"
            )
        members.append(item)
    if not members:
        raise BacktestError("DATA_QUALITY_FAILED", "basket resolved to zero members")
    if (
        policy == "SKIP"
        and missing
        and not any(
            item["role"] == "TRAIN" and item["status"] == "PRESENT" for item in members
        )
    ):
        raise BacktestError(
            "DATA_QUALITY_FAILED",
            "SKIP cannot remove the last TRAIN basket member",
        )
    resolved = {
        **dict(basket),
        "members": members,
        "missing_members": [
            {
                "dataset_id": item["dataset_id"],
                "symbol": item["symbol"],
                "role": item["role"],
            }
            for item in missing
        ],
        "silent_shrink_forbidden": True,
    }
    return resolved


def assert_train_only_selection_inputs(
    basket: Mapping[str, Any],
    evaluations_by_dataset: Mapping[str, Sequence[Mapping[str, Any]]],
) -> None:
    partitions = partition_basket(basket)
    train_ids = {member["dataset_id"] for member in partitions["TRAIN"]}
    blocked = {
        member["dataset_id"] for member in partitions["TEST"] + partitions["HOLDOUT"]
    }
    leaked = sorted(set(evaluations_by_dataset) & blocked)
    if leaked:
        raise BacktestError(
            "STUDY_SPLIT_LEAK",
            "test/holdout symbols cannot participate in parameter selection",
            details={"dataset_ids": leaked},
        )
    unknown = sorted(set(evaluations_by_dataset) - train_ids)
    if unknown:
        raise BacktestError(
            "STUDY_SPLIT_LEAK",
            "selection inputs include datasets outside the TRAIN basket",
            details={"dataset_ids": unknown},
        )


def select_params_train_only(
    *,
    basket: Mapping[str, Any],
    identity: Mapping[str, Any],
    fold: FoldSpecV2 | Mapping[str, Any],
    evaluations_by_dataset: Mapping[str, Sequence[Mapping[str, Any]]],
    objective: str,
    constraints: Mapping[str, Any],
) -> dict[str, Any]:
    assert_train_only_selection_inputs(basket, evaluations_by_dataset)
    partitions = partition_basket(basket)
    present_train = [
        member
        for member in partitions["TRAIN"]
        if str(member.get("status") or "PRESENT") == "PRESENT"
    ]
    missing_present = [
        member["dataset_id"]
        for member in present_train
        if member["dataset_id"] not in evaluations_by_dataset
    ]
    if missing_present:
        if str(basket.get("missing_policy") or "FAIL") == "SKIP":
            present_train = [
                member
                for member in present_train
                if member["dataset_id"] in evaluations_by_dataset
            ]
        else:
            raise BacktestError(
                "DATA_QUALITY_FAILED",
                "TRAIN basket member has no selection evidence",
                details={"dataset_ids": missing_present},
            )
    if not present_train:
        raise BacktestError(
            "DATA_QUALITY_FAILED", "no PRESENT TRAIN members for selection"
        )

    per_member_receipts: list[dict[str, Any]] = []
    for member in present_train:
        receipt = build_selection_receipt(
            identity={
                **dict(identity),
                "dataset_id": member["dataset_id"],
                "dataset_snapshot_hash": member["snapshot_hash"],
            },
            fold=fold,
            candidates=evaluations_by_dataset[member["dataset_id"]],
            objective=objective,
            constraints=constraints,
        )
        per_member_receipts.append(
            {
                "dataset_id": member["dataset_id"],
                "symbol": member["symbol"],
                "params": receipt["selected"]["params"],
                "params_hash": receipt["selected"]["params_hash"],
                "receipt_hash": receipt["hashes"]["receipt"],
            }
        )

    aggregated = _aggregate_train_candidates(
        [evaluations_by_dataset[member["dataset_id"]] for member in present_train]
    )
    receipt = build_selection_receipt(
        identity=identity,
        fold=fold,
        candidates=aggregated,
        objective=objective,
        constraints=constraints,
    )
    return {
        "receipt": receipt,
        "per_member_winners": per_member_receipts,
        "stability": parameter_stability_region(
            selected_params_hash=str(receipt["selected"]["params_hash"]),
            per_member_winners=per_member_receipts,
            neighborhood=receipt.get("robustness") or {},
        ),
        "train_dataset_ids": [member["dataset_id"] for member in present_train],
    }


def parameter_stability_region(
    *,
    selected_params_hash: str,
    per_member_winners: Sequence[Mapping[str, Any]],
    neighborhood: Mapping[str, Any],
) -> dict[str, Any]:
    hashes = sorted({str(item.get("params_hash") or "") for item in per_member_winners})
    return {
        "selected_params_hash": selected_params_hash,
        "distinct_winner_count": len(hashes),
        "stable": len(hashes) <= 1,
        "member_winners": [dict(item) for item in per_member_winners],
        "neighborhood": dict(neighborhood),
    }


def plan_independent_runs(
    basket: Mapping[str, Any],
    *,
    folds: Sequence[Mapping[str, Any] | FoldSpecV2],
    holdout: bool,
) -> list[dict[str, Any]]:
    planned: list[dict[str, Any]] = []
    for member in basket.get("members") or []:
        for fold in folds:
            payload = (
                fold
                if isinstance(fold, Mapping)
                else {
                    "ordinal": fold.ordinal,
                    "train_start_ms": fold.train_start_ms,
                    "train_end_ms": fold.train_end_ms,
                    "test_start_ms": fold.test_start_ms,
                    "test_end_ms": fold.test_end_ms,
                }
            )
            if member["role"] == "TRAIN":
                planned.append(
                    _planned_identity(member, window_role="TRAIN", fold=payload)
                )
                planned.append(
                    _planned_identity(member, window_role="TEST", fold=payload)
                )
            elif member["role"] == "TEST":
                planned.append(
                    _planned_identity(member, window_role="TEST", fold=payload)
                )
        if member["role"] == "HOLDOUT" and holdout:
            planned.append(_planned_identity(member, window_role="HOLDOUT", fold=None))
    return planned


def independent_oos_summary(
    member_rows: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    members: list[dict[str, Any]] = []
    positive: list[str] = []
    for row in member_rows:
        if (
            row.get("portfolio_contribution") is not None
            or row.get("combined_equity") is not None
            or row.get("portfolio_sum") is not None
        ):
            raise BacktestError(
                "FIDELITY_UNSUPPORTED",
                "independent OOS cannot carry portfolio contributions",
            )
        objective = _optional_decimal(row.get("test_objective"))
        symbol = str(row["symbol"])
        item = {
            "symbol": symbol,
            "dataset_id": str(row["dataset_id"]),
            "role": str(row.get("role") or "TEST"),
            "regime": str(row.get("regime") or "UNKNOWN"),
            "run_id": str(row["run_id"]),
            "report_hash": str(row["report_hash"]),
            "test_objective": None if objective is None else str(objective),
            "cost_sensitivity": row.get("cost_sensitivity"),
            "latency_sensitivity": row.get("latency_sensitivity"),
            "independent_account": True,
        }
        members.append(item)
        if objective is not None and objective > 0 and symbol not in positive:
            positive.append(symbol)
    summary = {
        "schemaVersion": BASKET_OOS_SCHEMA,
        "portfolioSumForbidden": True,
        "sharedCapital": False,
        "members": members,
        "positive_oos_symbols": positive,
        "run_hashes": [item["report_hash"] for item in members],
        "run_ids": [item["run_id"] for item in members],
    }
    summary["summary_hash"] = "sha256:" + sha256_hex(summary)
    return summary


def decision_fill_matrix(rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    matrix_rows: list[dict[str, Any]] = []
    for row in rows:
        bar_decision = str(row.get("bar_decision_hash") or "")
        trade_decision = str(row.get("trade_decision_hash") or "")
        bar_fill = str(row.get("bar_fill_hash") or "")
        trade_fill = str(row.get("trade_fill_hash") or "")
        matrix_rows.append(
            {
                "symbol": str(row["symbol"]),
                "dataset_id": str(row["dataset_id"]),
                "bar_decision_hash": bar_decision,
                "trade_decision_hash": trade_decision,
                "bar_fill_hash": bar_fill,
                "trade_fill_hash": trade_fill,
                "decision_matches": bool(bar_decision)
                and bar_decision == trade_decision,
                "fill_matches": bool(bar_fill) and bar_fill == trade_fill,
            }
        )
    payload = {
        "schemaVersion": BASKET_MATRIX_SCHEMA,
        "rows": matrix_rows,
    }
    payload["matrix_hash"] = "sha256:" + sha256_hex(payload)
    return payload


def robustness_verdict(
    *,
    oos: Mapping[str, Any],
    stability: Mapping[str, Any],
    fold_count: int,
    cost_ok_base: bool,
    cost_ok_plus_25: bool,
) -> dict[str, Any]:
    flags: list[str] = []
    positive = list(oos.get("positive_oos_symbols") or [])
    if len(positive) <= 1:
        flags.append("SINGLE_SYMBOL_ONLY")
    if fold_count <= 1:
        flags.append("SINGLE_WINDOW_ONLY")
    if cost_ok_base and not cost_ok_plus_25:
        flags.append("LOW_COST_ONLY")
    if not bool(stability.get("stable", True)):
        flags.append("UNSTABLE_PARAMETERS")
    if "SINGLE_SYMBOL_ONLY" in flags:
        verdict = "SINGLE_MARKET"
    elif flags:
        verdict = "FRAGILE"
    elif len(positive) >= 2:
        verdict = "CROSS_SYMBOL_SUPPORT"
    else:
        verdict = "INCONCLUSIVE"
    return {
        "verdict": verdict,
        "flags": flags,
        "single_market_only": "SINGLE_SYMBOL_ONLY" in flags,
        "positive_oos_symbols": positive,
    }


def build_basket_robustness(
    *,
    basket: Mapping[str, Any],
    identity: Mapping[str, Any],
    member_reports: Sequence[Mapping[str, Any]],
    seed: int,
    fold_count: int,
    fold: FoldSpecV2 | Mapping[str, Any] | None = None,
    objective: str = "NET_RETURN",
    constraints: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    members = {
        str(item["dataset_id"]): dict(item) for item in basket.get("members") or []
    }
    train_evaluations: dict[str, list[dict[str, Any]]] = {}
    oos_rows: list[dict[str, Any]] = []
    matrix_source: dict[str, dict[str, Any]] = {}
    cost_base = False
    cost_plus = False
    for raw in member_reports:
        dataset_id = str(raw.get("dataset_id") or "")
        member = members.get(dataset_id)
        if member is None:
            raise BacktestError(
                "STUDY_SPLIT_LEAK",
                f"report dataset {dataset_id} is outside the frozen basket",
            )
        window_role = str(raw.get("window_role") or raw.get("role") or member["role"])
        if window_role == "TRAIN":
            if member["role"] != "TRAIN":
                raise BacktestError(
                    "STUDY_SPLIT_LEAK",
                    "test/holdout symbols cannot participate in parameter selection",
                )
            candidates = raw.get("candidates")
            if candidates is None and raw.get("report") is not None:
                candidates = [
                    _candidate_from_report(
                        raw,
                        report=raw["report"],
                        objective=objective,
                        constraints=constraints or {},
                    )
                ]
            if not isinstance(candidates, Sequence):
                raise BacktestError(
                    "SCHEMA_UNKNOWN_FIELD",
                    "TRAIN member requires candidates or a report",
                )
            train_evaluations.setdefault(dataset_id, []).extend(
                dict(item) for item in candidates
            )
            continue
        if window_role == "HOLDOUT" and member["role"] != "HOLDOUT":
            raise BacktestError(
                "STUDY_SPLIT_LEAK", "only HOLDOUT members may supply holdout evidence"
            )
        oos_rows.append(
            {
                "symbol": member["symbol"],
                "dataset_id": dataset_id,
                "role": window_role,
                "regime": member["regime"],
                "run_id": str(raw.get("run_id") or ""),
                "report_hash": str(raw.get("report_hash") or ""),
                "test_objective": raw.get("test_objective"),
                "cost_sensitivity": raw.get("cost_sensitivity"),
                "latency_sensitivity": raw.get("latency_sensitivity"),
            }
        )
        if raw.get("cost_ok_base"):
            cost_base = True
        if raw.get("cost_ok_plus_25"):
            cost_plus = True
        matrix_source.setdefault(
            dataset_id, {"symbol": member["symbol"], "dataset_id": dataset_id}
        )
        fidelity = str(raw.get("fidelity_mode") or "")
        if fidelity == "BAR_APPROX":
            matrix_source[dataset_id]["bar_decision_hash"] = raw.get("decision_hash")
            matrix_source[dataset_id]["bar_fill_hash"] = raw.get("fill_hash")
        elif fidelity == "AGG_TRADE_EXECUTION":
            matrix_source[dataset_id]["trade_decision_hash"] = raw.get("decision_hash")
            matrix_source[dataset_id]["trade_fill_hash"] = raw.get("fill_hash")

    selection = None
    if train_evaluations and fold is not None:
        selection = select_params_train_only(
            basket=basket,
            identity=identity,
            fold=fold,
            evaluations_by_dataset=train_evaluations,
            objective=objective,
            constraints=constraints or {},
        )
    oos = (
        independent_oos_summary(oos_rows)
        if oos_rows
        else {
            "schemaVersion": BASKET_OOS_SCHEMA,
            "portfolioSumForbidden": True,
            "sharedCapital": False,
            "members": [],
            "positive_oos_symbols": [],
            "run_hashes": [],
            "run_ids": [],
        }
    )
    stability = (selection or {}).get("stability") or {
        "selected_params_hash": None,
        "distinct_winner_count": 0,
        "stable": True,
        "member_winners": [],
        "neighborhood": {},
    }
    payload = {
        "schemaVersion": BASKET_ROBUSTNESS_SCHEMA,
        "basket_protocol_revision": BASKET_PROTOCOL_V1,
        "basket_hash": basket.get("basket_hash"),
        "seed": seed,
        "portfolio_sum_forbidden": True,
        "selection": None
        if selection is None
        else {
            "receipt_hash": selection["receipt"]["hashes"]["receipt"],
            "selected": selection["receipt"]["selected"],
            "train_dataset_ids": selection["train_dataset_ids"],
        },
        "stability": stability,
        "independent_oos": oos,
        "decision_fill_matrix": decision_fill_matrix(list(matrix_source.values())),
        "verdict": robustness_verdict(
            oos=oos,
            stability=stability,
            fold_count=fold_count,
            cost_ok_base=cost_base,
            cost_ok_plus_25=cost_plus,
        ),
    }
    payload["robustness_hash"] = "sha256:" + sha256_hex(payload)
    return payload


def _planned_identity(
    member: Mapping[str, Any],
    *,
    window_role: str,
    fold: Mapping[str, Any] | None,
) -> dict[str, Any]:
    return {
        "dataset_id": member["dataset_id"],
        "symbol": member["symbol"],
        "data_epoch": member["data_epoch"],
        "snapshot_hash": member["snapshot_hash"],
        "role": member["role"],
        "window_role": window_role,
        "regime": member["regime"],
        "fold_ordinal": None if fold is None else fold.get("ordinal"),
        "independentAccount": True,
        "portfolioSumForbidden": True,
    }


def _candidate_from_report(
    raw: Mapping[str, Any],
    *,
    report: Mapping[str, Any],
    objective: str,
    constraints: Mapping[str, Any],
) -> dict[str, Any]:
    params = dict(raw.get("params") or {})
    return {
        "candidate_ordinal": int(raw.get("candidate_ordinal") or 1),
        "params": params,
        "params_hash": str(raw.get("params_hash") or ("sha256:" + sha256_hex(params))),
        "evaluation": evaluate_train_candidate(
            report, objective=objective, constraints=constraints
        ),
    }


def _aggregate_train_candidates(
    groups: Sequence[Sequence[Mapping[str, Any]]],
) -> list[dict[str, Any]]:
    by_ordinal: dict[int, list[Mapping[str, Any]]] = {}
    for group in groups:
        for item in group:
            by_ordinal.setdefault(int(item["candidate_ordinal"]), []).append(item)
    aggregated: list[dict[str, Any]] = []
    for ordinal, items in sorted(by_ordinal.items()):
        first = items[0]
        params = dict(first["params"])
        params_hash = str(first["params_hash"])
        for item in items[1:]:
            if (
                dict(item["params"]) != params
                or str(item["params_hash"]) != params_hash
            ):
                raise BacktestError(
                    "IDENTITY_MUTATION",
                    f"candidate {ordinal} params disagree across TRAIN symbols",
                )
        evaluations = [dict(item["evaluation"]) for item in items]
        eligible = all(bool(item.get("eligible")) for item in evaluations)
        objectives = [
            _optional_decimal(item.get("objective_value")) for item in evaluations
        ]
        present = [value for value in objectives if value is not None]
        drawdowns = [
            _optional_decimal(item.get("max_drawdown")) for item in evaluations
        ]
        present_dd = [value for value in drawdowns if value is not None]
        violations: list[str] = []
        warnings: list[str] = []
        for item in evaluations:
            violations.extend(str(code) for code in item.get("violations") or [])
            warnings.extend(str(code) for code in item.get("warnings") or [])
        if not eligible and "TRAIN_SYMBOL_INELIGIBLE" not in violations:
            violations.append("TRAIN_SYMBOL_INELIGIBLE")
        aggregated.append(
            {
                "candidate_ordinal": ordinal,
                "params": params,
                "params_hash": params_hash,
                "evaluation": {
                    "eligible": eligible and bool(present),
                    "objective_value": None if not present else str(min(present)),
                    "max_drawdown": None if not present_dd else str(max(present_dd)),
                    "closed_trade_count": min(
                        int(item.get("closed_trade_count") or 0) for item in evaluations
                    ),
                    "data_coverage": min(
                        (str(item.get("data_coverage") or "0") for item in evaluations),
                        default="0",
                    ),
                    "ambiguity_ratio": max(
                        (
                            str(item.get("ambiguity_ratio") or "0")
                            for item in evaluations
                        ),
                        default="0",
                    ),
                    "rejected_ratio": max(
                        (
                            str(item.get("rejected_ratio") or "0")
                            for item in evaluations
                        ),
                        default="0",
                    ),
                    "violations": sorted(set(violations)),
                    "warnings": sorted(set(warnings)),
                },
            }
        )
    return aggregated


def _optional_decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        return None
    return result if result.is_finite() else None
