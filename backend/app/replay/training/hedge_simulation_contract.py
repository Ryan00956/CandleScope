"""Frozen Phase 0 contract for the HEDGE deterministic simulation cutover.

This module is deliberately independent from the current replay schema.  Phase 1
will bind the protocol and storage model to this contract; later phases implement
the account and liquidation engines.  Keeping the contract executable here makes
formula and ordering drift detectable before those implementations exist.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from decimal import Decimal, localcontext

from app.replay.broker.models import canonical_decimal, decimal_to_string
from app.replay.canonical import canonical_sha256


CONTRACT_SCHEMA_VERSION = "replay.hedge-simulation-contract.v1"
SIMULATION_MANIFEST_SCHEMA_VERSION = "replay.hedge-simulation-manifest.v1"
MODEL_VERSION = "BINANCE_USDM_LINEAR_HEDGE_DETERMINISTIC_SIMULATION_V1"
ACCOUNT_FORMULA_VERSION = "CANDLESCOPE_HEDGE_ACCOUNT_V1"
LIQUIDATION_FORMULA_VERSION = "CANDLESCOPE_HEDGE_LIQUIDATION_V1"
INSURANCE_FUND_MODEL_VERSION = "CANDLESCOPE_INSURANCE_FUND_SIMULATION_V1"
ADL_MODEL_VERSION = "CANDLESCOPE_ADL_COHORT_SIMULATION_V1"
PUBLIC_INPUT_FIDELITY = "PINNED_HISTORICAL_PUBLIC_INPUT"
PRIVATE_STATE_FIDELITY = "VERSIONED_DETERMINISTIC_SIMULATION"
BOOK_EXECUTION_FIDELITY = "BOOK_ASSISTED_CONTINUITY_GATED_NO_QUEUE"

EVENT_PHASES: tuple[tuple[str, int], ...] = (
    ("RULE_AND_RISK_LIMIT_EFFECTIVE", 10),
    ("MARKET_AND_EXISTING_ORDER_EXECUTION", 20),
    ("MARK_AND_INDEX_UPDATE", 30),
    ("FUNDING_SETTLEMENT", 40),
    ("CONDITIONAL_ORDER_AND_ORDER_STATE", 50),
    ("RISK_SNAPSHOT_AND_BREACH_DETECTION", 60),
    ("LIQUIDATION_INSURANCE_AND_ADL", 70),
    ("LEDGER_PROJECTION_CHECKPOINT_HASH_COMMIT", 80),
)

REQUIRED_PUBLIC_INPUTS: tuple[str, ...] = (
    "INSTRUMENT_AND_RISK_RULE_TIMELINE",
    "MARK_INDEX_TIMELINE",
    "FUNDING_TIMELINE",
    "HISTORICAL_L2",
    "FEE_POLICY_TIMELINE",
)
REQUIRED_SIMULATED_INPUTS: tuple[str, ...] = (
    "INSURANCE_FUND_TIMELINE",
    "ADL_COHORT_SNAPSHOT_TIMELINE",
)

ADL_SORT_KEYS: tuple[str, ...] = (
    "score_desc",
    "profit_ratio_desc",
    "effective_leverage_desc",
    "candidate_id_asc",
)

PERFORMANCE_BUDGETS: Mapping[str, int] = {
    "eight_full_positioned_tracks_normal_wave_p95_ms": 500,
    "eight_full_positioned_tracks_liquidation_wave_p95_ms": 2_000,
    "eight_full_positioned_tracks_liquidation_wave_max_ms": 5_000,
    "rss_growth_limit_bytes": 64 * 1024**2,
}
_ROOT_HASH = "sha256:" + "0" * 64


def _decimal(value: object, *, field_name: str, positive: bool = False) -> Decimal:
    canonical = canonical_decimal(
        value,
        field_name=field_name,
        positive=positive,
        nonnegative=not positive,
    )
    return Decimal(canonical)


def initial_margin(*, notional: object, leverage: object) -> Decimal:
    """Return unrounded position initial margin for the frozen v1 formula."""

    value = _decimal(notional, field_name="notional")
    divisor = _decimal(leverage, field_name="leverage", positive=True)
    with localcontext() as context:
        context.prec = 60
        return value / divisor


def maintenance_margin(
    *,
    notional: object,
    maintenance_rate: object,
    maintenance_deduction: object,
) -> Decimal:
    """Return Binance-style tier maintenance margin, floored at zero."""

    value = _decimal(notional, field_name="notional")
    rate = _decimal(maintenance_rate, field_name="maintenance_rate")
    deduction = _decimal(
        maintenance_deduction,
        field_name="maintenance_deduction",
    )
    if rate >= 1:
        raise ValueError("maintenance_rate must be less than one")
    with localcontext() as context:
        context.prec = 60
        return max(Decimal(0), value * rate - deduction)


def settle_insurance_fund(
    *,
    balance: object,
    deficit: object,
    liquidation_fee_inflow: object = "0",
) -> dict[str, str]:
    """Apply fee inflow then cover as much bankruptcy deficit as possible."""

    current = _decimal(balance, field_name="balance")
    shortfall = _decimal(deficit, field_name="deficit")
    inflow = _decimal(
        liquidation_fee_inflow,
        field_name="liquidation_fee_inflow",
    )
    available = current + inflow
    coverage = min(available, shortfall)
    result = available - coverage
    uncovered = shortfall - coverage
    return {
        "opening_balance": decimal_to_string(current, field_name="opening_balance"),
        "liquidation_fee_inflow": decimal_to_string(
            inflow,
            field_name="liquidation_fee_inflow",
        ),
        "deficit": decimal_to_string(shortfall, field_name="deficit"),
        "coverage": decimal_to_string(coverage, field_name="coverage"),
        "closing_balance": decimal_to_string(result, field_name="closing_balance"),
        "uncovered_deficit": decimal_to_string(
            uncovered,
            field_name="uncovered_deficit",
        ),
    }


def _candidate_metrics(
    candidate: Mapping[str, object],
    *,
    bankrupt_position_side: str,
    quote_step: Decimal,
) -> dict[str, object] | None:
    expected = {
        "candidate_id",
        "symbol",
        "position_side",
        "quantity",
        "entry_price",
        "mark_price",
        "initial_margin",
        "margin_balance",
    }
    if set(candidate) != expected:
        raise ValueError("ADL candidate fields do not match the v1 contract")
    candidate_id = candidate["candidate_id"]
    symbol = candidate["symbol"]
    side = candidate["position_side"]
    if not isinstance(candidate_id, str) or not candidate_id:
        raise ValueError("candidate_id must be a non-empty string")
    if not isinstance(symbol, str) or not symbol:
        raise ValueError("symbol must be a non-empty string")
    if side not in {"LONG", "SHORT"}:
        raise ValueError("position_side must be LONG or SHORT")
    if bankrupt_position_side not in {"LONG", "SHORT"}:
        raise ValueError("bankrupt_position_side must be LONG or SHORT")
    if side == bankrupt_position_side:
        return None

    quantity = _decimal(candidate["quantity"], field_name="quantity", positive=True)
    entry = _decimal(candidate["entry_price"], field_name="entry_price", positive=True)
    mark = _decimal(candidate["mark_price"], field_name="mark_price", positive=True)
    margin = _decimal(
        candidate["initial_margin"],
        field_name="initial_margin",
        positive=True,
    )
    margin_balance = _decimal(
        candidate["margin_balance"],
        field_name="margin_balance",
    )
    with localcontext() as context:
        context.prec = 60
        pnl = (mark - entry) * quantity if side == "LONG" else (entry - mark) * quantity
        if pnl <= 0:
            return None
        notional = quantity * mark
        profit_ratio = pnl / max(margin, quote_step)
        effective_leverage = notional / max(margin_balance, quote_step)
        score = profit_ratio * effective_leverage
    return {
        **dict(candidate),
        "unrealized_pnl": decimal_to_string(pnl, field_name="unrealized_pnl"),
        "profit_ratio": decimal_to_string(profit_ratio, field_name="profit_ratio"),
        "effective_leverage": decimal_to_string(
            effective_leverage,
            field_name="effective_leverage",
        ),
        "score": decimal_to_string(score, field_name="score"),
    }


def rank_adl_candidates(
    candidates: Sequence[Mapping[str, object]],
    *,
    bankrupt_position_side: str,
    quote_step: object,
) -> tuple[dict[str, object], ...]:
    """Rank the materialized synthetic cohort with the frozen v1 tie-breakers."""

    step = _decimal(quote_step, field_name="quote_step", positive=True)
    ranked = [
        metrics
        for candidate in candidates
        if (
            metrics := _candidate_metrics(
                candidate,
                bankrupt_position_side=bankrupt_position_side,
                quote_step=step,
            )
        )
        is not None
    ]
    ranked.sort(
        key=lambda item: (
            -Decimal(str(item["score"])),
            -Decimal(str(item["profit_ratio"])),
            -Decimal(str(item["effective_leverage"])),
            str(item["candidate_id"]),
        )
    )
    return tuple(ranked)


def select_adl_candidates(
    candidates: Sequence[Mapping[str, object]],
    *,
    bankrupt_position_side: str,
    takeover_quantity: object,
    quote_step: object,
) -> dict[str, object]:
    """Consume ranked cohort quantity; any residual is an explicit fail-closed result."""

    remaining = _decimal(
        takeover_quantity,
        field_name="takeover_quantity",
        positive=True,
    )
    selected: list[dict[str, str]] = []
    for candidate in rank_adl_candidates(
        candidates,
        bankrupt_position_side=bankrupt_position_side,
        quote_step=quote_step,
    ):
        if remaining == 0:
            break
        available = _decimal(
            candidate["quantity"],
            field_name="candidate.quantity",
            positive=True,
        )
        quantity = min(remaining, available)
        selected.append(
            {
                "candidate_id": str(candidate["candidate_id"]),
                "quantity": decimal_to_string(quantity, field_name="selected_quantity"),
                "score": str(candidate["score"]),
            }
        )
        remaining -= quantity
    return {
        "selected": selected,
        "remaining_quantity": decimal_to_string(
            remaining,
            field_name="remaining_quantity",
        ),
        "status": "COMPLETED" if remaining == 0 else "FAILED_CLOSED_COHORT_EXHAUSTED",
    }


def _event_hash(
    *,
    manifest_id: str,
    event: Mapping[str, object],
) -> str:
    return canonical_sha256(
        {
            "schema_version": SIMULATION_MANIFEST_SCHEMA_VERSION,
            "manifest_id": manifest_id,
            "sequence": event["sequence"],
            "effective_time_ms": event["effective_time_ms"],
            "kind": event["kind"],
            "amount": event["amount"],
            "balance_after": event["balance_after"],
            "previous_hash": event["previous_hash"],
        }
    )


def _snapshot_hash(
    *,
    manifest_id: str,
    snapshot: Mapping[str, object],
) -> str:
    return canonical_sha256(
        {
            "schema_version": SIMULATION_MANIFEST_SCHEMA_VERSION,
            "manifest_id": manifest_id,
            "sequence": snapshot["sequence"],
            "symbol": snapshot["symbol"],
            "effective_time_ms": snapshot["effective_time_ms"],
            "valid_until_ms": snapshot["valid_until_ms"],
            "candidates": snapshot["candidates"],
        }
    )


def validate_simulation_manifest(manifest: Mapping[str, object]) -> str:
    """Validate one materialized insurance/ADL input and return its pin hash."""

    expected = {
        "schema_version",
        "model_version",
        "manifest_id",
        "dataset_epoch",
        "range_start_ms",
        "range_end_ms",
        "settlement_asset",
        "required_symbols",
        "insurance_events",
        "adl_snapshots",
    }
    if set(manifest) != expected:
        raise ValueError("simulation manifest fields do not match the v1 contract")
    if manifest["schema_version"] != SIMULATION_MANIFEST_SCHEMA_VERSION:
        raise ValueError("simulation manifest schema_version is unsupported")
    if manifest["model_version"] != MODEL_VERSION:
        raise ValueError("simulation manifest model_version is unsupported")
    manifest_id = manifest["manifest_id"]
    if not isinstance(manifest_id, str) or not manifest_id:
        raise ValueError("simulation manifest_id must be a non-empty string")
    dataset_epoch = manifest["dataset_epoch"]
    if (
        not isinstance(dataset_epoch, str)
        or len(dataset_epoch) != 71
        or not dataset_epoch.startswith("sha256:")
    ):
        raise ValueError("simulation dataset_epoch must be a sha256 digest")
    try:
        int(dataset_epoch[7:], 16)
    except ValueError as error:
        raise ValueError("simulation dataset_epoch must be a sha256 digest") from error
    range_start = manifest["range_start_ms"]
    range_end = manifest["range_end_ms"]
    if (
        isinstance(range_start, bool)
        or not isinstance(range_start, int)
        or isinstance(range_end, bool)
        or not isinstance(range_end, int)
        or range_start < 0
        or range_end < range_start
    ):
        raise ValueError("simulation manifest time range is invalid")
    if manifest["settlement_asset"] != "USDT":
        raise ValueError("simulation manifest settlement_asset must be USDT")
    required_symbols = manifest["required_symbols"]
    if (
        not isinstance(required_symbols, list)
        or not required_symbols
        or any(not isinstance(symbol, str) or not symbol for symbol in required_symbols)
        or len(set(required_symbols)) != len(required_symbols)
    ):
        raise ValueError("required_symbols must be a unique non-empty string array")

    insurance_events = manifest["insurance_events"]
    if not isinstance(insurance_events, list) or not insurance_events:
        raise ValueError("insurance_events must be a non-empty array")
    previous_hash = _ROOT_HASH
    balance = Decimal(0)
    previous_time = -1
    for expected_sequence, event in enumerate(insurance_events, start=1):
        if not isinstance(event, Mapping) or set(event) != {
            "sequence",
            "effective_time_ms",
            "kind",
            "amount",
            "balance_after",
            "previous_hash",
            "event_hash",
        }:
            raise ValueError("insurance event fields do not match the v1 contract")
        if event["sequence"] != expected_sequence:
            raise ValueError("insurance event sequence must be contiguous from one")
        event_time = event["effective_time_ms"]
        if (
            isinstance(event_time, bool)
            or not isinstance(event_time, int)
            or event_time < 0
            or event_time < previous_time
            or event_time > range_end
        ):
            raise ValueError("insurance event time is outside the manifest order")
        if event["previous_hash"] != previous_hash:
            raise ValueError("insurance event hash chain is broken")
        kind = event["kind"]
        if kind not in {"OPENING_BALANCE", "CREDIT", "DEBIT"}:
            raise ValueError("insurance event kind is unsupported")
        amount = _decimal(event["amount"], field_name="insurance.amount")
        if expected_sequence == 1:
            if kind != "OPENING_BALANCE" or event_time > range_start:
                raise ValueError("first insurance event must open before the range")
            balance = amount
        elif kind == "OPENING_BALANCE":
            raise ValueError("OPENING_BALANCE is valid only for the first event")
        elif kind == "CREDIT":
            balance += amount
        else:
            balance -= amount
            if balance < 0:
                raise ValueError("insurance fund cannot overdraft")
        declared_balance = _decimal(
            event["balance_after"],
            field_name="insurance.balance_after",
        )
        if declared_balance != balance:
            raise ValueError("insurance balance_after does not match the event chain")
        actual_hash = _event_hash(manifest_id=manifest_id, event=event)
        if event["event_hash"] != actual_hash:
            raise ValueError("insurance event_hash is invalid")
        previous_hash = actual_hash
        previous_time = event_time

    snapshots = manifest["adl_snapshots"]
    if not isinstance(snapshots, list) or not snapshots:
        raise ValueError("adl_snapshots must be a non-empty array")
    coverage: dict[str, list[tuple[int, int]]] = {
        str(symbol): [] for symbol in required_symbols
    }
    for expected_sequence, snapshot in enumerate(snapshots, start=1):
        if not isinstance(snapshot, Mapping) or set(snapshot) != {
            "sequence",
            "symbol",
            "effective_time_ms",
            "valid_until_ms",
            "candidates",
            "snapshot_hash",
        }:
            raise ValueError("ADL snapshot fields do not match the v1 contract")
        if snapshot["sequence"] != expected_sequence:
            raise ValueError("ADL snapshot sequence must be contiguous from one")
        symbol = snapshot["symbol"]
        if symbol not in coverage:
            raise ValueError("ADL snapshot symbol is not required by the manifest")
        effective = snapshot["effective_time_ms"]
        valid_until = snapshot["valid_until_ms"]
        if (
            isinstance(effective, bool)
            or not isinstance(effective, int)
            or isinstance(valid_until, bool)
            or not isinstance(valid_until, int)
            or effective > valid_until
        ):
            raise ValueError("ADL snapshot range is invalid")
        candidates = snapshot["candidates"]
        if not isinstance(candidates, list) or not candidates:
            raise ValueError("ADL snapshot candidates must be non-empty")
        candidate_ids: set[str] = set()
        for candidate in candidates:
            if not isinstance(candidate, Mapping):
                raise TypeError("ADL candidate must be an object")
            candidate_id = candidate.get("candidate_id")
            if not isinstance(candidate_id, str) or candidate_id in candidate_ids:
                raise ValueError("ADL candidate_id must be unique in a snapshot")
            candidate_ids.add(candidate_id)
            if candidate.get("symbol") != symbol:
                raise ValueError("ADL candidate symbol must match its snapshot")
            # Validate all fields and Decimal values by evaluating both possible failures.
            _candidate_metrics(
                candidate,
                bankrupt_position_side=(
                    "SHORT" if candidate.get("position_side") == "LONG" else "LONG"
                ),
                quote_step=Decimal("0.00000001"),
            )
        if snapshot["snapshot_hash"] != _snapshot_hash(
            manifest_id=manifest_id,
            snapshot=snapshot,
        ):
            raise ValueError("ADL snapshot_hash is invalid")
        coverage[str(symbol)].append((effective, valid_until))

    for symbol, ranges in coverage.items():
        ranges.sort()
        cursor = range_start
        for start, end in ranges:
            if start > cursor:
                raise ValueError(f"ADL snapshot coverage gap for {symbol}")
            cursor = max(cursor, end + 1)
            if cursor > range_end:
                break
        if cursor <= range_end:
            raise ValueError(f"ADL snapshot coverage gap for {symbol}")
    return canonical_sha256(dict(manifest))


def contract_payload() -> dict[str, object]:
    """Return the complete, canonicalizable Phase 0 contract payload."""

    return {
        "schema_version": CONTRACT_SCHEMA_VERSION,
        "model_version": MODEL_VERSION,
        "identity": {
            "exchange_rule_family": "BINANCE_USDM",
            "market_type": "LINEAR_PERPETUAL",
            "settlement_asset": "USDT",
            "margin_asset_mode": "SINGLE_SETTLEMENT_ASSET",
            "position_modes": ["ONE_WAY", "HEDGE"],
            "margin_modes": ["CROSS", "ISOLATED_PER_LEG"],
        },
        "fidelity": {
            "public_inputs": PUBLIC_INPUT_FIDELITY,
            "private_exchange_state": PRIVATE_STATE_FIDELITY,
            "l2_execution": BOOK_EXECUTION_FIDELITY,
            "queue_exact": False,
            "exchange_historical_insurance_exact": False,
            "exchange_historical_adl_exact": False,
            "product_label": "交易所规则级确定性模拟",
        },
        "versions": {
            "simulation_manifest_schema": SIMULATION_MANIFEST_SCHEMA_VERSION,
            "account_formula": ACCOUNT_FORMULA_VERSION,
            "liquidation_formula": LIQUIDATION_FORMULA_VERSION,
            "insurance_fund": INSURANCE_FUND_MODEL_VERSION,
            "adl": ADL_MODEL_VERSION,
        },
        "required_inputs": {
            "pinned_public": list(REQUIRED_PUBLIC_INPUTS),
            "materialized_simulation": list(REQUIRED_SIMULATED_INPUTS),
            "missing_behavior": "PAUSE_RUN_FAILED_CLOSED",
            "runtime_generation_or_fallback": False,
        },
        "rounding": {
            "numeric_type": "DECIMAL_CANONICAL_STRING",
            "position_initial_margin": "QUOTE_STEP_CEILING",
            "maintenance_margin": "QUOTE_STEP_CEILING",
            "fees": "QUOTE_STEP_CEILING",
            "close_quantity": "QUANTITY_STEP_CEILING_CAPPED_TO_POSITION",
            "adl_quantity": "MATERIALIZED_QUANTITY_STEP_EXACT",
            "prices": "ADVERSE_PRICE_TICK",
        },
        "account_formulas": {
            "notional": "abs(quantity) * mark_price * contract_size",
            "initial_margin": "notional / active_leverage",
            "maintenance_margin": "max(0, notional * tier_maintenance_rate - tier_maintenance_deduction)",
            "long_unrealized_pnl": "(mark_price - entry_price) * quantity * contract_size",
            "short_unrealized_pnl": "(entry_price - mark_price) * quantity * contract_size",
            "cross_breach": "cross_wallet_balance + sum(unrealized_pnl) <= sum(maintenance_margin)",
            "isolated_breach": "isolated_wallet + leg_unrealized_pnl <= leg_maintenance_margin",
            "hedge_margin_offset": "NONE_SUM_PER_LEG",
        },
        "liquidation": {
            "state_order": [
                "ACTIVE",
                "RISK_BREACH_DETECTED",
                "CANCELING_ORDERS",
                "RISK_RECHECK",
                "PARTIAL_LIQUIDATION",
                "FULL_LIQUIDATION",
                "BANKRUPTCY_TRANSFER",
                "INSURANCE_FUND_SETTLEMENT",
                "ADL",
                "ACTIVE_OR_BANKRUPT_OR_FAILED_CLOSED",
            ],
            "cancel_scope": "ALL_NON_REDUCE_ONLY_ORDERS_IN_BREACHED_MARGIN_SCOPE",
            "leg_order": [
                "maintenance_margin_desc",
                "absolute_notional_desc",
                "track_id_asc",
                "position_side_long_before_short",
            ],
            "partial_target": "ONE_RISK_TIER_STEP_DOWN_PER_ORDER; FIRST_TIER_TARGET_ZERO; RECHECK_AFTER_EVERY_FILL",
            "execution": "VISIBLE_HISTORICAL_L2_DEPTH; PARTIAL_FILLS; NO_TOUCH_OR_TAPE_FALLBACK",
            "bankruptcy_price": "ADVERSE_TICK_GRID_ROOT_WHERE_SCOPE_EQUITY_REACHES_ZERO; OTHER_MARKS_HELD_FIXED_FOR_CROSS_LEG_PROOF",
            "liquidation_price": "FIRST_ADVERSE_TICK_GRID_PRICE_WHERE_SCOPE_EQUITY_LE_MAINTENANCE_MARGIN",
            "book_exhausted": "PAUSE_RUN_FAILED_CLOSED",
        },
        "insurance_fund": {
            "opening_balance": "REQUIRED_NON_NEGATIVE_MANIFEST_VALUE",
            "posting_order": ["LIQUIDATION_FEE_INFLOW", "BANKRUPTCY_DEFICIT_DEBIT"],
            "coverage": "min(opening_balance + liquidation_fee_inflow, bankruptcy_deficit)",
            "overdraft": "FORBIDDEN",
            "uncovered_deficit": "ENTER_ADL",
        },
        "adl": {
            "cohort": "MATERIALIZED_VERSIONED_SIMULATION_SNAPSHOT",
            "eligibility": "OPPOSITE_POSITION_SIDE_AND_POSITIVE_UNREALIZED_PNL_AND_POSITIVE_QUANTITY",
            "profit_ratio": "positive_unrealized_pnl / max(initial_margin, quote_step)",
            "effective_leverage": "notional / max(margin_balance, quote_step)",
            "score": "profit_ratio * effective_leverage",
            "sort_keys": list(ADL_SORT_KEYS),
            "price": "BANKRUPTCY_TAKEOVER_PRICE",
            "selection": "CONSUME_RANKED_CANDIDATE_QUANTITY_UNTIL_TAKEOVER_QUANTITY_ZERO",
            "cohort_exhausted": "PAUSE_RUN_FAILED_CLOSED",
        },
        "same_virtual_time_order": [
            {"name": name, "phase": phase} for name, phase in EVENT_PHASES
        ],
        "performance_budgets": dict(PERFORMANCE_BUDGETS),
        "runtime_policy": {
            "default_enabled_required": True,
            "gray_rollout": False,
            "legacy_hedge_fallback": False,
            "missing_mark_funding_book_fallback": False,
            "rollback_unit": "COMPLETE_BUILD_AND_MATCHING_DATA_VERSION",
        },
    }


def validate_contract(payload: Mapping[str, object] | None = None) -> None:
    """Fail if the frozen contract is incomplete or contains unstable values."""

    candidate = contract_payload() if payload is None else dict(payload)
    if candidate != contract_payload():
        raise ValueError("hedge simulation contract differs from the frozen v1 payload")

    def walk(value: object) -> None:
        if isinstance(value, float):
            raise TypeError("float is forbidden in the hedge simulation contract")
        if isinstance(value, str) and any(
            marker in value.upper() for marker in ("TODO", "TBD", "LATER_DECIDE")
        ):
            raise ValueError("hedge simulation contract contains an unresolved marker")
        if isinstance(value, Mapping):
            for nested in value.values():
                walk(nested)
        elif isinstance(value, (list, tuple)):
            for nested in value:
                walk(nested)

    walk(candidate)
    phases = candidate["same_virtual_time_order"]
    if not isinstance(phases, list):
        raise TypeError("same_virtual_time_order must be an array")
    actual = tuple((row["name"], row["phase"]) for row in phases)  # type: ignore[index]
    if actual != EVENT_PHASES:
        raise ValueError("same-virtual-time event order differs from v1")
    if tuple(sorted(PERFORMANCE_BUDGETS)) != tuple(
        sorted(candidate["performance_budgets"])
    ):  # type: ignore[arg-type]
        raise ValueError("performance budgets are incomplete")


def contract_hash() -> str:
    validate_contract()
    return canonical_sha256(contract_payload())


__all__ = [
    "ACCOUNT_FORMULA_VERSION",
    "ADL_MODEL_VERSION",
    "ADL_SORT_KEYS",
    "BOOK_EXECUTION_FIDELITY",
    "CONTRACT_SCHEMA_VERSION",
    "EVENT_PHASES",
    "INSURANCE_FUND_MODEL_VERSION",
    "LIQUIDATION_FORMULA_VERSION",
    "MODEL_VERSION",
    "PERFORMANCE_BUDGETS",
    "PRIVATE_STATE_FIDELITY",
    "PUBLIC_INPUT_FIDELITY",
    "REQUIRED_PUBLIC_INPUTS",
    "REQUIRED_SIMULATED_INPUTS",
    "SIMULATION_MANIFEST_SCHEMA_VERSION",
    "contract_hash",
    "contract_payload",
    "initial_margin",
    "maintenance_margin",
    "rank_adl_candidates",
    "select_adl_candidates",
    "settle_insurance_fund",
    "validate_contract",
    "validate_simulation_manifest",
]
