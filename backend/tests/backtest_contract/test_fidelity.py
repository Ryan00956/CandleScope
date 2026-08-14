from __future__ import annotations

import pytest

from tests.backtest_contract.spec import (
    BoundedBarView,
    ContractError,
    ReferenceBarKernel,
    assert_fidelity_claim,
    sample_bars,
)


def test_bar_approx_is_labeled_approximate() -> None:
    assert_fidelity_claim(
        fidelity_mode="BAR_APPROX",
        source_event_kind="BAR",
        report_label="APPROXIMATE",
        available_roles=["BARS", "INSTRUMENT_RULES"],
    )


def test_agg_trade_cannot_claim_raw_or_queue_exact() -> None:
    with pytest.raises(ContractError, match="FIDELITY_MISLABEL"):
        assert_fidelity_claim(
            fidelity_mode="AGG_TRADE_TAPE",
            source_event_kind="RAW_TRADE",
            report_label="TRADE_SEQUENCE",
            available_roles=["TRADES", "INSTRUMENT_RULES"],
        )
    with pytest.raises(ContractError, match="FIDELITY_MISLABEL"):
        assert_fidelity_claim(
            fidelity_mode="TRADE_TAPE",
            source_event_kind="AGG_TRADE",
            report_label="TRADE_SEQUENCE",
            available_roles=["TRADES", "INSTRUMENT_RULES"],
        )


def test_queue_exact_requires_order_level_data() -> None:
    with pytest.raises(ContractError, match="FIDELITY_UNSUPPORTED"):
        assert_fidelity_claim(
            fidelity_mode="QUEUE_EXACT",
            source_event_kind="ORDER_LEVEL",
            report_label="ORDER_LEVEL_REQUIRED",
            available_roles=["TRADES", "ORDER_BOOK", "INSTRUMENT_RULES"],
        )
    assert_fidelity_claim(
        fidelity_mode="QUEUE_EXACT",
        source_event_kind="ORDER_LEVEL",
        report_label="ORDER_LEVEL_REQUIRED",
        available_roles=["ORDER_EVENTS", "TRADES", "INSTRUMENT_RULES"],
    )


def test_same_bar_stop_and_target_counts_as_worst_case_ambiguity() -> None:
    bars = sample_bars()

    def place_bracket(view: BoundedBarView) -> list[dict]:
        if view[-1].sequence != 2:
            return []
        return [
            {
                "side": "SELL",
                "type": "LIMIT",
                "qty": "1",
                "limit_price": "118",
            },
            {
                "side": "SELL",
                "type": "STOP",
                "qty": "1",
                "stop_price": "92",
            },
        ]

    result = ReferenceBarKernel().run(bars, place_bracket)
    assert result["ambiguity_count"] == 1
    assert result["fills"][0]["reason"] == "WORST_CASE_STOP"
    assert result["fills"][0]["sequence"] == 3


def test_identity_cannot_silently_degrade_fidelity() -> None:
    with pytest.raises(ContractError, match="FIDELITY_MISLABEL"):
        assert_fidelity_claim(
            fidelity_mode="TRADE_TAPE",
            source_event_kind="BAR",
            report_label="APPROXIMATE",
            available_roles=["BARS", "INSTRUMENT_RULES"],
        )
