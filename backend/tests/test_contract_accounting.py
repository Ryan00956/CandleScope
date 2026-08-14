from __future__ import annotations

from decimal import Decimal

import pytest

from app.backtest.reports import build_report
from app.market_dataset.adapters.contract_aux import ContractAuxSnapshotProvider
from app.market_dataset.models import DatasetRef
from app.market_dataset.snapshot import MarketDatasetError, MarketEvent
from app.simulation.contract_accounting import ContractAccount, merge_contract_timeline


def _event(role: str, time_ms: int, sequence: int, **payload: object) -> MarketEvent:
    return MarketEvent(sequence=sequence, event_time_ms=time_ms, role=role, payload=payload)


def _ref() -> DatasetRef:
    return DatasetRef(
        dataset_id="aux-1",
        data_epoch="sha256:" + "11" * 32,
        snapshot_hash="",
        venue="okx",
        market_type="linear",
        symbol="BTC-USDT-SWAP",
        start_time_ms=0,
        end_time_ms=10_000,
        roles=("MARK_INDEX", "FUNDING", "INSTRUMENT_RULES"),
        interval=None,
        calendar_id="UTC_FIXED",
        source="contract_aux",
        retention_policy="user_local",
    )


def test_same_ms_applies_rules_then_mark_then_funding() -> None:
    events = merge_contract_timeline(
        (
            _event("FUNDING", 1000, 3, rate="0.0001", period_id="p1"),
            _event("MARK_INDEX", 1000, 2, mark="100"),
            _event("INSTRUMENT_RULES", 1000, 1, multiplier="1", version="rules-v1", tick="0.1"),
        )
    )
    assert [event.role for event in events] == ["INSTRUMENT_RULES", "MARK_INDEX", "FUNDING"]
    account = ContractAccount()
    account.apply_fill(side="BUY", price=Decimal("100"), qty=Decimal("1"))
    for event in events:
        account.apply(event)
    assert account.rule_version == "rules-v1"
    assert account.funding_paid < 0
    assert account.ledger_hash()


def test_duplicate_funding_and_missing_mark_fail_closed() -> None:
    account = ContractAccount()
    account.apply_fill(side="BUY", price=Decimal("100"), qty=Decimal("1"))
    with pytest.raises(MarketDatasetError, match="DATA_QUALITY_FAILED"):
        account.apply(_event("FUNDING", 1, 1, rate="0.01", period_id="p1"))
    account.mark = Decimal("100")
    account.apply(_event("FUNDING", 1, 1, rate="0.01", period_id="p1"))
    with pytest.raises(MarketDatasetError, match="DATA_QUALITY_FAILED"):
        account.apply(_event("FUNDING", 1, 2, rate="0.01", period_id="p1"))


def test_liquidation_fails_closed_when_equity_exhausted() -> None:
    account = ContractAccount(quote_balance=Decimal("1"))
    account.apply_fill(side="BUY", price=Decimal("100"), qty=Decimal("1"))
    with pytest.raises(MarketDatasetError, match="ACCOUNT_INSOLVENT"):
        account.apply(_event("MARK_INDEX", 2, 1, mark="1"))
    assert account.liquidated is True


def test_restore_equivalence_via_snapshot_hash() -> None:
    def replay() -> ContractAccount:
        account = ContractAccount()
        account.apply(_event("INSTRUMENT_RULES", 1, 1, version="v1", multiplier="1"))
        account.apply(_event("MARK_INDEX", 2, 2, mark="100"))
        account.apply_fill(side="BUY", price=Decimal("100"), qty=Decimal("1"))
        account.apply(_event("FUNDING", 3, 3, rate="0.001", period_id="p-a"))
        return account

    assert replay().ledger_hash() == replay().ledger_hash()


def test_aux_adapter_and_report_include_coverage() -> None:
    snapshot = ContractAuxSnapshotProvider(
        (
            {"role": "MARK_INDEX", "event_time_ms": 1, "mark": "100"},
            {"role": "FUNDING", "event_time_ms": 2, "rate": "0.0001", "period_id": "p1"},
        )
    ).open(_ref())
    assert {event.role for event in snapshot.cursor()} == {"MARK_INDEX", "FUNDING"}
    report = build_report(
        {"run_id": "bt", "fidelity_mode": "TRADE_TAPE", "source_event_kind": "RAW_TRADE"},
        {
            "fills": [],
            "contract_coverage": {"rule_version": "v1", "funding_events": 1},
        },
    )
    assert report["contract_coverage"]["funding_events"] == 1
    assert report["report_label"] != "ORDER_LEVEL_REQUIRED"
