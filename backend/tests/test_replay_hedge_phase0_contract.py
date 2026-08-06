from __future__ import annotations

from copy import deepcopy
from decimal import Decimal
import json
from pathlib import Path

import pytest

from app.replay.training.hedge_simulation_contract import (
    ADL_SORT_KEYS,
    CONTRACT_SCHEMA_VERSION,
    EVENT_PHASES,
    MODEL_VERSION,
    PERFORMANCE_BUDGETS,
    PRIVATE_STATE_FIDELITY,
    PUBLIC_INPUT_FIDELITY,
    contract_hash,
    contract_payload,
    initial_margin,
    maintenance_margin,
    rank_adl_candidates,
    select_adl_candidates,
    settle_insurance_fund,
    validate_contract,
    validate_simulation_manifest,
)


EXPECTED_CONTRACT_HASH = (
    "sha256:eb93972d289057909f7c8fd8ef66376876f7e0c60b2e46dbe6c5ca4c609f9c4b"
)
EXPECTED_MANIFEST_HASH = (
    "sha256:a5fe1beb59b87a6a000faa6f46d9871394288c48acd84f2a7295b710d92a1236"
)
REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
MANIFEST_FIXTURE = (
    Path(__file__).parent / "fixtures" / "replay" / "hedge_simulation_manifest_v1.json"
)


def _candidates() -> list[dict[str, object]]:
    return [
        {
            "candidate_id": "short-a",
            "symbol": "BTCUSDT",
            "position_side": "SHORT",
            "quantity": "0.4",
            "entry_price": "110",
            "mark_price": "100",
            "initial_margin": "10",
            "margin_balance": "15",
        },
        {
            "candidate_id": "short-b",
            "symbol": "BTCUSDT",
            "position_side": "SHORT",
            "quantity": "0.8",
            "entry_price": "105",
            "mark_price": "100",
            "initial_margin": "5",
            "margin_balance": "10",
        },
        {
            "candidate_id": "short-loss",
            "symbol": "BTCUSDT",
            "position_side": "SHORT",
            "quantity": "1",
            "entry_price": "90",
            "mark_price": "100",
            "initial_margin": "10",
            "margin_balance": "10",
        },
        {
            "candidate_id": "long-a",
            "symbol": "BTCUSDT",
            "position_side": "LONG",
            "quantity": "1",
            "entry_price": "90",
            "mark_price": "100",
            "initial_margin": "10",
            "margin_balance": "10",
        },
    ]


def _manifest() -> dict[str, object]:
    return json.loads(MANIFEST_FIXTURE.read_text(encoding="utf-8"))


def test_phase0_contract_is_complete_and_hash_locked() -> None:
    payload = contract_payload()

    validate_contract(payload)

    assert payload["schema_version"] == CONTRACT_SCHEMA_VERSION
    assert payload["model_version"] == MODEL_VERSION
    assert contract_hash() == EXPECTED_CONTRACT_HASH
    assert payload["fidelity"] == {
        "public_inputs": PUBLIC_INPUT_FIDELITY,
        "private_exchange_state": PRIVATE_STATE_FIDELITY,
        "l2_execution": "BOOK_ASSISTED_CONTINUITY_GATED_NO_QUEUE",
        "queue_exact": False,
        "exchange_historical_insurance_exact": False,
        "exchange_historical_adl_exact": False,
        "product_label": "交易所规则级确定性模拟",
    }
    assert payload["adl"]["sort_keys"] == list(ADL_SORT_KEYS)  # type: ignore[index]
    assert payload["same_virtual_time_order"] == [
        {"name": name, "phase": phase} for name, phase in EVENT_PHASES
    ]
    assert PERFORMANCE_BUDGETS == {
        "eight_full_positioned_tracks_normal_wave_p95_ms": 500,
        "eight_full_positioned_tracks_liquidation_wave_p95_ms": 2_000,
        "eight_full_positioned_tracks_liquidation_wave_max_ms": 5_000,
        "rss_growth_limit_bytes": 64 * 1024**2,
    }


def test_phase0_contract_rejects_any_drift() -> None:
    changed = deepcopy(contract_payload())
    changed["fidelity"]["exchange_historical_adl_exact"] = True  # type: ignore[index]

    with pytest.raises(ValueError, match="differs from the frozen v1"):
        validate_contract(changed)


def test_phase0_materialized_simulation_manifest_is_hash_locked() -> None:
    assert validate_simulation_manifest(_manifest()) == EXPECTED_MANIFEST_HASH


def test_phase0_manifest_rejects_insurance_chain_break() -> None:
    manifest = _manifest()
    manifest["insurance_events"][1]["previous_hash"] = "sha256:" + "f" * 64  # type: ignore[index]

    with pytest.raises(ValueError, match="hash chain is broken"):
        validate_simulation_manifest(manifest)


def test_phase0_manifest_rejects_adl_coverage_gap() -> None:
    manifest = _manifest()
    manifest["range_end_ms"] = 2500

    with pytest.raises(ValueError, match="coverage gap for BTCUSDT"):
        validate_simulation_manifest(manifest)


def test_phase0_manifest_rejects_duplicate_adl_candidate() -> None:
    manifest = _manifest()
    candidates = manifest["adl_snapshots"][0]["candidates"]  # type: ignore[index]
    candidates[1]["candidate_id"] = candidates[0]["candidate_id"]

    with pytest.raises(ValueError, match="candidate_id must be unique"):
        validate_simulation_manifest(manifest)


def test_phase0_margin_formulas_are_decimal_and_frozen() -> None:
    assert initial_margin(notional="25000", leverage="20") == Decimal("1250")
    assert maintenance_margin(
        notional="25000",
        maintenance_rate="0.005",
        maintenance_deduction="0",
    ) == Decimal("125")
    assert maintenance_margin(
        notional="75000",
        maintenance_rate="0.01",
        maintenance_deduction="250",
    ) == Decimal("500")


def test_phase0_insurance_fund_never_overdrafts() -> None:
    result = settle_insurance_fund(
        balance="50",
        deficit="80",
        liquidation_fee_inflow="5",
    )

    assert result == {
        "opening_balance": "50",
        "liquidation_fee_inflow": "5",
        "deficit": "80",
        "coverage": "55",
        "closing_balance": "0",
        "uncovered_deficit": "25",
    }


def test_phase0_adl_filters_ranks_and_selects_deterministically() -> None:
    ranked = rank_adl_candidates(
        _candidates(),
        bankrupt_position_side="LONG",
        quote_step="0.01",
    )
    selected = select_adl_candidates(
        _candidates(),
        bankrupt_position_side="LONG",
        takeover_quantity="1",
        quote_step="0.01",
    )

    assert [candidate["candidate_id"] for candidate in ranked] == [
        "short-b",
        "short-a",
    ]
    assert selected == {
        "selected": [
            {"candidate_id": "short-b", "quantity": "0.8", "score": "6.4"},
            {
                "candidate_id": "short-a",
                "quantity": "0.2",
                "score": (
                    "1.06666666666666666666666666666666666666666666666666666666667"
                ),
            },
        ],
        "remaining_quantity": "0",
        "status": "COMPLETED",
    }


def test_phase0_adl_cohort_exhaustion_is_fail_closed() -> None:
    selected = select_adl_candidates(
        _candidates(),
        bankrupt_position_side="LONG",
        takeover_quantity="2",
        quote_step="0.01",
    )

    assert selected["remaining_quantity"] == "0.8"
    assert selected["status"] == "FAILED_CLOSED_COHORT_EXHAUSTED"


def test_phase0_documents_disclose_simulation_and_are_not_blocked() -> None:
    execution = (
        REPOSITORY_ROOT / "docs" / "KLINE_REPLAY_HEDGE_EXCHANGE_PARITY_EXECUTION_zh.md"
    ).read_text(encoding="utf-8")
    product = (
        REPOSITORY_ROOT / "docs" / "KLINE_REPLAY_TRAINING_PRODUCT_CONTRACT_zh.md"
    ).read_text(encoding="utf-8")

    for document in (execution, product):
        assert "交易所规则级确定性模拟" in document
    assert "状态：`PHASE_0_COMPLETE" in execution
    assert "HEDGE 首版仅允许 `APPROX_PROXY" not in product
