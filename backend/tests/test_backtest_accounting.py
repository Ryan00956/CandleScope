from __future__ import annotations

from decimal import Decimal

from app.market_dataset.snapshot import MarketEvent
from app.simulation.contract_accounting import ContractAccount
from app.simulation.kernel import SimulationKernel


def _bar_events() -> tuple[MarketEvent, ...]:
    rows = ((1, "100", "110", "95", "105"), (2, "105", "108", "104", "107"))
    events = []
    for sequence, open_, high, low, close in rows:
        events.append(
            MarketEvent(
                sequence=sequence,
                event_time_ms=(sequence + 1) * 60_000,
                role="BARS",
                payload={
                    "open": open_,
                    "high": high,
                    "low": low,
                    "close": close,
                    "volume": "10",
                },
            )
        )
    return tuple(events)


def test_taker_fee_is_booked_on_notional() -> None:
    account = ContractAccount(taker_fee_bps=Decimal("10"))
    account.apply_fill(side="BUY", price=Decimal("100"), qty=Decimal("2"))
    assert account.fees_paid == Decimal("0.2")
    assert account.quote_balance == Decimal("9999.8")
    assert account.journal[-1]["kind"] == "FEE"


def test_kernel_fee_enters_ledger_identity() -> None:
    def buy_first(visible, event):
        if event.sequence == 1:
            return [{"side": "BUY", "type": "MARKET", "qty": "1"}]
        return []

    charged = SimulationKernel(taker_fee_bps=Decimal("10")).run(_bar_events(), buy_first)
    free = SimulationKernel().run(_bar_events(), buy_first)
    assert charged.ledger_hash != free.ledger_hash
    assert Decimal(charged.fills[0]["price"]) > 0


def test_fills_funding_and_fees_recompute_cash_and_position() -> None:
    account = ContractAccount(taker_fee_bps=Decimal("10"))
    account.mark = Decimal("110")
    account.apply_fill(side="BUY", price=Decimal("100"), qty=Decimal("1"))
    account.apply(
        MarketEvent(
            sequence=2,
            event_time_ms=2,
            role="FUNDING",
            payload={"rate": "0.001", "period_id": "p1"},
        )
    )
    account.apply_fill(side="SELL", price=Decimal("110"), qty=Decimal("1"))
    realized = sum(
        (Decimal(item["amount"]) for item in account.journal if item["kind"] == "REALIZED"),
        Decimal("0"),
    )
    fees = sum(
        (Decimal(item["amount"]) for item in account.journal if item["kind"] == "FEE"),
        Decimal("0"),
    )
    funding = sum(
        (Decimal(item["amount"]) for item in account.journal if item["kind"] == "FUNDING"),
        Decimal("0"),
    )
    assert account.position_qty == 0
    assert account.quote_balance == Decimal("10000") + realized + funding - fees
    assert account.fees_paid == fees
    assert account.equity() == account.quote_balance


def test_kernel_applies_maker_taker_fees_fixed_funding_and_reduce_only() -> None:
    def round_trip(_visible, event):
        if event.sequence == 1:
            return [{"side": "BUY", "type": "LIMIT", "qty": "1", "limit_price": "104"}]
        if event.sequence == 2:
            return [{"side": "SELL", "type": "MARKET", "qty": "2", "reduce_only": True}]
        return []

    kernel = SimulationKernel(
        slippage_bps=Decimal("0"),
        maker_fee_bps=Decimal("2"),
        taker_fee_bps=Decimal("4"),
        funding_rate=Decimal("0.001"),
        funding_interval_ms=60_000,
    )
    result = kernel.run(_bar_events() + (
        MarketEvent(
            sequence=3,
            event_time_ms=240_000,
            role="BARS",
            payload={"open": "107", "high": "109", "low": "106", "close": "108", "volume": "10"},
        ),
    ), round_trip)
    account = result.ledger["account"]
    assert result.fills[0]["fee"] == Decimal("0.0208")
    assert result.fills[1]["qty"] == Decimal("1")
    assert result.fills[1]["fee"] == Decimal("0.0428")
    assert account["position_qty"] == "0"
    assert account["funding_event_count"] == 1
    assert Decimal(account["funding_paid"]) < 0


def test_reduce_only_order_cannot_open_a_reverse_position() -> None:
    def invalid_close(_visible, event):
        if event.sequence == 1:
            return [{"side": "SELL", "type": "MARKET", "qty": "1", "reduce_only": True}]
        return []

    result = SimulationKernel(slippage_bps=Decimal("0")).run(_bar_events(), invalid_close)
    assert result.fills == []
    assert result.ledger["account"]["position_qty"] == "0"
    assert result.orders[0]["status"] == "CANCELLED_REDUCE_ONLY"
