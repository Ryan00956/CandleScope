from __future__ import annotations

import pytest
from decimal import Decimal

from app.market_dataset.snapshot import MarketDatasetError, MarketEvent
from app.simulation.kernel import SimulationKernel
from app.simulation.trade_kernel import TradeSimulationKernel
from app.backtest.strategy.pyne_adapter import PyneHostPlanner


def _bars(*rows: tuple[int, str, str, str, str]) -> tuple[MarketEvent, ...]:
    events = []
    for sequence, open_, high, low, close in rows:
        events.append(
            MarketEvent(
                sequence=sequence,
                event_time_ms=(sequence + 1) * 60_000,
                role="BARS",
                payload={
                    "open_time_ms": sequence * 60_000,
                    "close_time_ms": (sequence + 1) * 60_000,
                    "open": open_,
                    "high": high,
                    "low": low,
                    "close": close,
                    "volume": "10",
                },
            )
        )
    return tuple(events)


def _trade(sequence: int, price: str = "100", qty: str = "1") -> MarketEvent:
    return MarketEvent(
        sequence=sequence,
        event_time_ms=sequence * 100,
        role="TRADES",
        payload={
            "source_event_kind": "RAW_TRADE",
            "source_sequence": sequence,
            "tie_break": str(sequence),
            "price": price,
            "qty": qty,
        },
    )


def test_long_flat_limit_stop_and_same_bar_ambiguity() -> None:
    events = _bars(
        (1, "100", "110", "95", "105"),
        (2, "105", "108", "104", "107"),
        (3, "107", "120", "90", "115"),
    )

    def bracket(visible, event):
        if event.sequence != 2:
            return []
        return [
            {"side": "SELL", "type": "LIMIT", "qty": "1", "limit_price": "118"},
            {"side": "SELL", "type": "STOP", "qty": "1", "stop_price": "92"},
        ]

    result = SimulationKernel().run(events, bracket)
    assert result.ambiguity_count == 1
    assert result.fills[0]["reason"] == "WORST_CASE_STOP"


def test_invalid_intents_are_rejected_not_filled() -> None:
    events = _bars((1, "100", "101", "99", "100"), (2, "100", "101", "99", "100"))

    def bad(visible, event):
        if event.sequence != 1:
            return []
        return [
            {"side": "BUY", "type": "MARKET", "qty": "0"},
            {"side": "BUY", "type": "IOC", "qty": "1"},
            {"side": "HOLD", "type": "MARKET", "qty": "1"},
        ]

    kernel = SimulationKernel()
    result = kernel.run(events, bad)
    assert result.fills == []
    assert {item["reason"] for item in kernel.rejected} == {
        "NON_POSITIVE_QTY",
        "UNSUPPORTED_TYPE",
        "INVALID_SIDE",
    }


def test_rejected_target_position_retries_against_host_account() -> None:
    planner = PyneHostPlanner()
    output = {"kind": "TARGET_POSITION", "payload": {"targetExposure": "1"}}
    first = planner.plan(output, current_position=Decimal("0"))
    kernel = SimulationKernel(min_notional=Decimal("1000"))
    kernel.run(
        _bars((1, "100", "101", "99", "100")),
        lambda *_: first,
    )
    assert kernel.account.position_qty == 0
    assert planner.plan(output, current_position=kernel.account.position_qty)


def test_oco_worst_case_cancels_target_instead_of_reversing_position() -> None:
    events = _bars(
        (1, "100", "101", "99", "100"),
        (2, "100", "101", "99", "100"),
        (3, "100", "115", "85", "100"),
        (4, "100", "115", "100", "110"),
    )

    def strategy(_visible, event):
        if event.sequence == 1:
            return [{"side": "BUY", "type": "MARKET", "qty": "1"}]
        if event.sequence == 2:
            return [
                {"side": "SELL", "type": "LIMIT", "qty": "1", "limit_price": "110"},
                {"side": "SELL", "type": "STOP", "qty": "1", "stop_price": "90"},
            ]
        return []

    kernel = SimulationKernel()
    result = kernel.run(events, strategy, finalize=True)
    assert [fill["reason"] for fill in result.fills] == ["NEXT_BAR_OPEN", "WORST_CASE_STOP"]
    assert kernel.account.position_qty == 0
    assert next(order for order in result.orders if order["type"] == "LIMIT")["status"] == "CANCELLED_OCO"


def test_bar_gap_policy_reject_pause_and_skip() -> None:
    gapped = _bars((1, "100", "101", "99", "100"), (3, "100", "101", "99", "100"))
    with pytest.raises(MarketDatasetError, match="DATA_GAP_REJECTED"):
        SimulationKernel(gap_policy="REJECT").run(gapped, lambda *args: [])

    paused = SimulationKernel(gap_policy="PAUSE")
    paused.run(gapped, lambda *args: [])
    assert paused.paused is True
    assert paused.decisions[-1]["sequence"] == 1

    skipped = SimulationKernel(gap_policy="SKIP_WITH_WARNING")
    skipped.run(gapped, lambda *args: [])
    assert skipped.ambiguity_count == 1
    assert [item["sequence"] for item in skipped.decisions] == [1, 3]


def test_trade_reject_does_not_create_working_order() -> None:
    kernel = TradeSimulationKernel()
    kernel.run(
        (_trade(1), _trade(2)),
        lambda visible, event: (
            [{"side": "BUY", "type": "MARKET", "qty": "1", "tif": "FOK"}]
            if event.sequence == 1
            else []
        ),
    )
    assert kernel.orders == []
    assert kernel.rejected[0]["reason"] == "UNSUPPORTED_TIF"
