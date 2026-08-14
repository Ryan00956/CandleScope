from __future__ import annotations

from decimal import Decimal
import json
from pathlib import Path

import pytest

from app.market_dataset.snapshot import MarketDatasetError, MarketEvent
from app.simulation.contract_accounting import ContractAccount
from app.simulation.linear_perp_account_v2 import (
    LIQUIDATION_MODEL,
    LinearPerpetualAccountV2,
)
from app.simulation import DualClockSimulationKernel
from app.simulation.kernel import SimulationKernel
from app.backtest.reports import build_report
from app.backtest.service import BacktestService
from app.core.config import load_backtest_settings
from app.backtest.errors import BacktestError
from app.backtest.runtime import _required_contract_roles


def event(role: str, stamp: int, **payload: object) -> MarketEvent:
    return MarketEvent(sequence=stamp, event_time_ms=stamp, role=role, payload=payload)


def rules(
    stamp: int = 1, *, version: str = "r1", tiers: list[dict[str, str]] | None = None
) -> MarketEvent:
    return event(
        "INSTRUMENT_RULES",
        stamp,
        rule_version=version,
        contract_multiplier="1",
        price_tick="0.1",
        quantity_step="0.001",
        min_notional="5",
        maintenance_tiers=tiers
        or [
            {
                "notional_floor": "0",
                "notional_cap": "1000",
                "maintenance_rate": "0.005",
                "maintenance_deduction": "0",
            },
            {
                "notional_floor": "1000",
                "notional_cap": "1000000",
                "maintenance_rate": "0.01",
                "maintenance_deduction": "5",
            },
        ],
    )


def ready(
    *, balance: str = "10000", leverage: str = "10", funding_mode: str = "OFF"
) -> LinearPerpetualAccountV2:
    account = LinearPerpetualAccountV2(
        initial_balance=Decimal(balance),
        leverage=Decimal(leverage),
        funding_mode=funding_mode,
    )
    account.apply(rules())
    account.apply(event("MARK_INDEX", 2, mark_price="100", index_price="100"))
    return account


def assert_equations(account: LinearPerpetualAccountV2) -> None:
    assert account.wallet_balance() == (
        account.initial_balance
        + account.cumulative_realized_pnl
        - account.cumulative_fees
        + account.cumulative_funding
        + account.compensating_entries
    )
    assert account.equity() == account.wallet_balance() + account.unrealized()
    assert account.available_balance() == (
        account.equity() - account.initial_margin() - account.frozen_order_margin
    )
    account.assert_invariants(
        allow_negative_available=account.liquidation_state != "ACTIVE"
    )


def test_dual_clock_v2_keeps_contract_events_out_of_signal_clock() -> None:
    def trade(
        sequence: int, stamp: int, source_sequence: int, price: str
    ) -> MarketEvent:
        return MarketEvent(
            sequence=sequence,
            event_time_ms=stamp,
            role="TRADES",
            payload={
                "source_event_kind": "AGG_TRADE",
                "source_sequence": source_sequence,
                "tie_break": f"AGG_TRADE:{source_sequence}",
                "price": price,
                "qty": "1",
            },
        )

    events = (
        rules(1),
        event("MARK_INDEX", 2, mark_price="100", index_price="100"),
        trade(3, 1_000, 1, "100"),
        event("FUNDING", 4, period_id="p0", funding_rate="0.001"),
        event("MARK_INDEX", 5, mark_price="101", index_price="101"),
        trade(6, 60_000, 2, "101"),
        event("MARK_INDEX", 7, mark_price="102", index_price="102"),
        trade(8, 61_000, 3, "102"),
        event("FUNDING", 9, period_id="p1", funding_rate="0.001"),
    )
    kernel = DualClockSimulationKernel(
        "1m",
        account_model="LINEAR_PERP_ONE_WAY_V2",
        funding_mode="HISTORICAL_REQUIRED",
        leverage=Decimal("10"),
    )
    result = kernel.run(
        events,
        lambda _visible, bar: (
            [{"side": "BUY", "type": "MARKET", "qty": "1"}] if bar.sequence == 1 else []
        ),
        finalize=True,
    )

    # The completed bar exists immediately before the boundary trade, so the
    # boundary print itself is the first eligible authoritative execution.
    assert result.fills[0]["sequence"] == 6
    assert result.ledger["signal_event_count"] == 1
    assert result.ledger["execution_event_count"] == 3
    assert len(kernel.account.seen_funding_periods) == 2
    assert (
        sum(
            entry["kind"] == "FUNDING" and Decimal(str(entry["details"]["amount"])) == 0
            for entry in kernel.account.ledger_entries
        )
        == 1
    )
    assert kernel.account.cumulative_funding == Decimal("-0.102")
    assert_equations(kernel.account)


def test_long_short_add_reduce_close_flip_fifo_and_average_entry() -> None:
    account = ready()
    account.apply_fill(
        side="BUY", price=Decimal("100"), qty=Decimal("1"), event_time_ms=3
    )
    account.apply_fill(
        side="BUY", price=Decimal("110"), qty=Decimal("1"), event_time_ms=4
    )
    assert account.position_qty == 2
    assert account.entry_price == 105
    account.apply_fill(
        side="SELL", price=Decimal("120"), qty=Decimal("1.5"), event_time_ms=5
    )
    assert account.cumulative_realized_pnl == Decimal("25")  # FIFO: 20 + 5
    assert account.position_qty == Decimal("0.5")
    assert account.entry_price == 110
    account.apply_fill(
        side="SELL", price=Decimal("90"), qty=Decimal("1"), event_time_ms=6
    )
    assert account.position_qty == Decimal("-0.5")
    assert account.entry_price == 90
    account.apply_fill(
        side="BUY", price=Decimal("80"), qty=Decimal("0.5"), event_time_ms=7
    )
    assert account.position_qty == 0
    assert account.entry_price is None
    assert account.cumulative_realized_pnl == Decimal("20")
    assert_equations(account)


def test_funding_signs_zero_position_audit_and_mode_identity() -> None:
    long = ready(funding_mode="HISTORICAL_REQUIRED")
    long.apply(event("FUNDING", 3, rate="0.01", period_id="flat"))
    assert long.cumulative_funding == 0
    assert "flat" in long.seen_funding_periods
    long.apply_fill(side="BUY", price=Decimal("100"), qty=Decimal("2"), event_time_ms=4)
    long.apply(event("FUNDING", 5, rate="0.01", period_id="positive"))
    long.apply(event("FUNDING", 6, rate="-0.01", period_id="negative"))
    assert long.cumulative_funding == 0
    assert [
        e["details"]["source"] for e in long.ledger_entries if e["kind"] == "FUNDING"
    ] == ["HISTORICAL", "HISTORICAL", "HISTORICAL"]

    short = ready(funding_mode="FIXED_SCENARIO")
    short.apply_fill(
        side="SELL", price=Decimal("100"), qty=Decimal("1"), event_time_ms=3
    )
    short.apply_fixed_funding(
        event_time_ms=4, rate=Decimal("0.01"), period_id="fixed:4"
    )
    assert short.cumulative_funding == 1
    assert short.snapshot()["funding_mode"] == "FIXED_SCENARIO"
    assert_equations(short)


def test_rules_tier_boundary_and_risk_limit_are_frozen() -> None:
    account = ready(leverage="100")
    account.apply_fill(
        side="BUY", price=Decimal("100"), qty=Decimal("9.99"), event_time_ms=3
    )
    assert account.selected_tier().rate == Decimal("0.005")  # type: ignore[union-attr]
    account.apply_fill(
        side="BUY", price=Decimal("100"), qty=Decimal("0.01"), event_time_ms=4
    )
    assert account.selected_tier().rate == Decimal(
        "0.01"
    )  # exact cap selects next [floor, cap)
    with pytest.raises(MarketDatasetError, match="ACCOUNT_RISK_LIMIT_EXCEEDED"):
        account.apply(
            rules(
                5,
                version="small",
                tiers=[
                    {
                        "notional_floor": "0",
                        "notional_cap": "500",
                        "maintenance_rate": "0.01",
                        "maintenance_deduction": "0",
                    }
                ],
            )
        )


def test_mark_authority_liquidation_and_insolvency_are_distinct() -> None:
    account = ready(balance="100", leverage="10")
    account.apply_fill(
        side="BUY", price=Decimal("100"), qty=Decimal("5"), event_time_ms=3
    )
    account.apply(event("MARK_INDEX", 4, mark_price="80", index_price="80"))
    assert account.liquidation_state == "LIQUIDATED"
    assert account.insolvency_state == "SOLVENT"
    assert account.position_qty == 0
    assert account.liquidation_event["price_model"] == LIQUIDATION_MODEL  # type: ignore[index]
    assert account.wallet_balance() == 0
    with pytest.raises(MarketDatasetError, match="ACCOUNT_LIQUIDATED"):
        account.apply_fill(side="BUY", price=Decimal("80"), qty=Decimal("1"))

    insolvent = ready(balance="50", leverage="10")
    insolvent.apply_fill(
        side="BUY", price=Decimal("100"), qty=Decimal("5"), event_time_ms=3
    )
    insolvent.apply(event("MARK_INDEX", 4, mark_price="80", index_price="80"))
    assert insolvent.insolvency_state == "INSOLVENT"


def test_fee_induced_insufficiency_order_margin_and_compensation_are_append_only() -> (
    None
):
    account = ready(balance="10", leverage="10")
    account.reserve_order_margin(order_id="o1", qty=Decimal("0.9"))
    with pytest.raises(MarketDatasetError, match="ACCOUNT_BALANCE_INSUFFICIENT"):
        account.reserve_order_margin(order_id="o2", qty=Decimal("0.2"))
    account.release_order_margin("o1")
    with pytest.raises(MarketDatasetError, match="ACCOUNT_BALANCE_INSUFFICIENT"):
        account.reserve_order_margin(
            order_id="fee-heavy", qty=Decimal("0.9"), estimated_fee=Decimal("2")
        )
    assert account.liquidation_state == "ACTIVE"
    prior_count = len(account.ledger_entries)
    account.compensate(
        amount=Decimal("1"), reason="audited correction", event_time_ms=5
    )
    assert len(account.ledger_entries) == prior_count + 1
    assert account.ledger_entries[-1]["kind"] == "COMPENSATING_ENTRY"
    assert_equations(account)


def test_closing_quantity_does_not_freeze_new_exposure_margin() -> None:
    account = ready(balance="10000", leverage="10")
    account.apply_fill(side="BUY", price=Decimal("100"), qty=Decimal("2"))
    assert account.opening_quantity(side="SELL", qty=Decimal("1")) == 0
    assert account.opening_quantity(side="SELL", qty=Decimal("3")) == 1
    account.reserve_order_margin(
        order_id="close", qty=account.opening_quantity(side="SELL", qty=Decimal("2"))
    )
    assert account.frozen_order_margin == 0


def test_checkpoint_restore_preserves_account_and_ledger_hash() -> None:
    account = ready(funding_mode="HISTORICAL_REQUIRED")
    account.apply_fill(
        side="SELL",
        price=Decimal("101"),
        qty=Decimal("2"),
        fee=Decimal("0.1"),
        event_time_ms=3,
    )
    account.apply(event("MARK_INDEX", 4, mark_price="99", index_price="99"))
    account.apply(event("FUNDING", 5, rate="0.001", period_id="p1"))
    snapshot = account.snapshot()
    restored = LinearPerpetualAccountV2()
    restored.restore(snapshot)
    assert restored.snapshot() == snapshot
    assert restored.ledger_hash() == account.ledger_hash()
    assert_equations(restored)


def test_missing_mark_rules_and_duplicate_funding_fail_closed() -> None:
    account = LinearPerpetualAccountV2(funding_mode="HISTORICAL_REQUIRED")
    with pytest.raises(MarketDatasetError, match="DATA_ROLE_COVERAGE_MISSING"):
        account.validate_ready()
    account.apply(rules())
    with pytest.raises(MarketDatasetError, match="DATA_ROLE_COVERAGE_MISSING"):
        account.apply_fill(side="BUY", price=Decimal("100"), qty=Decimal("1"))
    account.apply(event("MARK_INDEX", 2, mark_price="100", index_price="100"))
    account.apply(event("FUNDING", 3, rate="0", period_id="p"))
    with pytest.raises(MarketDatasetError, match="DATA_QUALITY_FAILED"):
        account.apply(event("FUNDING", 4, rate="0", period_id="p"))


def test_v1_fixture_behavior_remains_unchanged() -> None:
    account = ContractAccount()
    account.apply_fill(side="BUY", price=Decimal("100"), qty=Decimal("1"))
    account.apply_fill(side="SELL", price=Decimal("110"), qty=Decimal("1"))
    assert account.snapshot()["quote_balance"] == "10010"
    assert "schemaVersion" not in account.snapshot()


def test_bar_kernel_uses_auxiliary_event_clock_and_restores_hash() -> None:
    rows = (
        rules(1),
        event("MARK_INDEX", 2, mark_price="100", index_price="100"),
        event("BARS", 3, open="100", high="101", low="99", close="100", volume="10"),
        event("MARK_INDEX", 4, mark_price="101", index_price="101"),
        event("BARS", 5, open="100", high="102", low="99", close="101", volume="10"),
        event("MARK_INDEX", 6, mark_price="102", index_price="102"),
        event("BARS", 7, open="101", high="103", low="100", close="102", volume="10"),
    )

    def strategy(_visible: tuple[MarketEvent, ...], current: MarketEvent) -> list[dict]:
        if current.sequence == 1:
            return [{"side": "BUY", "type": "MARKET", "qty": "1"}]
        if current.sequence == 2:
            return [{"side": "SELL", "type": "MARKET", "qty": "1"}]
        return []

    kernel = SimulationKernel(
        account_model="LINEAR_PERP_ONE_WAY_V2",
        funding_mode="OFF",
        leverage=Decimal("10"),
        slippage_bps=Decimal("0"),
    )
    first = kernel.run(rows[:5], strategy)
    checkpoint = kernel.snapshot()
    restored = SimulationKernel(
        account_model="LINEAR_PERP_ONE_WAY_V2",
        funding_mode="OFF",
        leverage=Decimal("10"),
        slippage_bps=Decimal("0"),
    )
    restored.restore(checkpoint)
    resumed = restored.run(rows[5:], strategy, finalize=True)
    reference = SimulationKernel(
        account_model="LINEAR_PERP_ONE_WAY_V2",
        funding_mode="OFF",
        leverage=Decimal("10"),
        slippage_bps=Decimal("0"),
    ).run(rows, strategy, finalize=True)
    assert first.fills
    assert resumed.ledger_hash == reference.ledger_hash
    assert resumed.ledger["account"]["mark_price"] == "102"
    assert len(resumed.fills) == 2
    assert resumed.ledger["account"]["entry_price"] is None


def test_v2_report_discloses_account_funding_and_unmodeled_boundaries() -> None:
    account = ready(funding_mode="FIXED_SCENARIO")
    report = build_report(
        {
            "run_id": "bt-v2",
            "state": "COMPLETED",
            "fidelity_mode": "BAR_APPROX",
            "source_event_kind": "BAR",
            "account_model": "LINEAR_PERP_ONE_WAY_V2",
            "config_json": '{"funding_mode":"FIXED_SCENARIO","account_model":"LINEAR_PERP_ONE_WAY_V2"}',
        },
        {"fills": [], "ledger": {"account": account.snapshot()}},
    )
    assert report["identity"]["account_model"] == "LINEAR_PERP_ONE_WAY_V2"
    assert report["funding_mode"] == "FIXED_SCENARIO"
    assert "funding" not in report["unmodeled"]
    assert "insurance fund" in report["unmodeled"]


def test_v2_run_identity_freezes_funding_mode_and_rejects_missing_roles(
    tmp_path,
) -> None:
    service = BacktestService.start(
        load_backtest_settings(
            {"BACKTEST_ENABLED": "1", "BACKTEST_BAR_ENABLED": "1"},
            data_dir=tmp_path,
            klines_db_path=tmp_path / "candlescope.db",
            replay_db_path=tmp_path / "replay.db",
        ),
        now_ms=1,
    )
    base = {
        "strategy_revision_id": "builtin-sma-cross-v1",
        "dataset_id": "local-v2",
        "data_epoch": "sha256:" + "11" * 32,
        "snapshot_hash": "sha256:" + "22" * 32,
        "fidelity_mode": "BAR_APPROX",
        "source_event_kind": "BAR",
        "start_time_ms": 1,
        "end_time_ms": 100,
        "parameters": {"fast": 2, "slow": 3},
        "account_model": "LINEAR_PERP_ONE_WAY_V2",
        "contract_data_mode": "HISTORICAL_CONTRACT_V1",
        "funding_mode": "HISTORICAL_REQUIRED",
        "funding_rate": "0",
        "leverage": "10",
    }
    first = service.create_run(base, idempotency_key="v2-historical", now_ms=2)
    fixed = service.create_run(
        {**base, "funding_mode": "FIXED_SCENARIO", "funding_rate": "0.001"},
        idempotency_key="v2-fixed",
        now_ms=3,
    )
    assert first["config_hash"] != fixed["config_hash"]
    with pytest.raises(BacktestError, match="DATA_ROLE_COVERAGE_MISSING"):
        service.validate_run({**base, "contract_data_mode": "LEGACY_FIXED_V1"})
    with pytest.raises(BacktestError, match="SCHEMA_UNKNOWN_FIELD"):
        service.validate_run({**base, "funding_mode": "OFF", "funding_rate": "0.001"})
    service.shutdown()


def test_v2_contract_golden_is_additive_and_exact() -> None:
    golden = json.loads(
        (
            Path(__file__).parent
            / "fixtures"
            / "backtest"
            / "account_v2_contract_golden.json"
        ).read_text(encoding="utf-8")
    )
    assert golden["account_model"] == "LINEAR_PERP_ONE_WAY_V2"
    assert golden["funding_modes"] == ["OFF", "FIXED_SCENARIO", "HISTORICAL_REQUIRED"]
    assert golden["required_roles"]["HISTORICAL_REQUIRED"][-1] == "FUNDING"
    assert golden["liquidation_model"] == LIQUIDATION_MODEL


def test_v2_required_roles_depend_only_on_frozen_funding_mode() -> None:
    assert _required_contract_roles("LINEAR_PERP_ONE_WAY_V2", "OFF") == (
        "MARK_INDEX",
        "INSTRUMENT_RULES",
    )
    assert _required_contract_roles("LINEAR_PERP_ONE_WAY_V2", "FIXED_SCENARIO") == (
        "MARK_INDEX",
        "INSTRUMENT_RULES",
    )
    assert _required_contract_roles(
        "LINEAR_PERP_ONE_WAY_V2", "HISTORICAL_REQUIRED"
    ) == ("MARK_INDEX", "INSTRUMENT_RULES", "FUNDING")
