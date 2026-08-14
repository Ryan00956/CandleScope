from __future__ import annotations

from app.market_dataset.snapshot import MarketEvent
from app.simulation import SimulationKernel


def _events() -> tuple[MarketEvent, ...]:
    rows = (
        (1, "100", "110", "95", "105"),
        (2, "105", "108", "104", "107"),
        (3, "107", "120", "90", "115"),
        (4, "115", "116", "114", "115"),
    )
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


def _buy_first(visible, event):
    if event.sequence == 1:
        return [{"side": "BUY", "type": "MARKET", "qty": "1"}]
    return []


def test_new_market_order_fills_next_bar_open() -> None:
    result = SimulationKernel().run(_events(), _buy_first)
    assert result.fills[0]["sequence"] == 2
    assert result.fills[0]["reason"] == "NEXT_BAR_OPEN"
    assert str(result.fills[0]["price"]) == "105.0105"


def test_same_inputs_are_deterministic() -> None:
    first = SimulationKernel().run(_events(), _buy_first)
    second = SimulationKernel().run(_events(), _buy_first)
    assert first.decision_hash == second.decision_hash
    assert first.fill_hash == second.fill_hash
    assert first.ledger_hash == second.ledger_hash
    assert first.report_hash == second.report_hash


def test_limit_requires_bar_to_trade_through_price() -> None:
    def buy_above_next_bar(visible, event):
        if event.sequence == 1:
            return [{"side": "BUY", "type": "LIMIT", "qty": "1", "limit_price": "103"}]
        return []

    def sell_never_reached(visible, event):
        if event.sequence == 1:
            return [{"side": "SELL", "type": "LIMIT", "qty": "1", "limit_price": "200"}]
        return []

    def buy_after_last_touch(visible, event):
        if event.sequence == 3:
            return [{"side": "BUY", "type": "LIMIT", "qty": "1", "limit_price": "100"}]
        return []

    through = SimulationKernel().run(_events(), buy_above_next_bar)
    assert through.fills[0]["sequence"] == 3
    assert str(through.fills[0]["price"]) == "103"
    assert SimulationKernel().run(_events(), sell_never_reached).fills == []
    assert SimulationKernel().run(_events(), buy_after_last_touch).fills == []


def test_same_bar_stop_and_target_is_worst_case() -> None:
    def bracket(visible, event):
        if event.sequence != 2:
            return []
        return [
            {"side": "SELL", "type": "LIMIT", "qty": "1", "limit_price": "118"},
            {"side": "SELL", "type": "STOP", "qty": "1", "stop_price": "92"},
        ]

    result = SimulationKernel().run(_events(), bracket)
    assert result.ambiguity_count == 1
    assert result.fills[0]["reason"] == "WORST_CASE_STOP"
