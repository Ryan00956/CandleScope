from __future__ import annotations

import pytest

from app.backtest.reports import build_report
from app.market_dataset.snapshot import MarketDatasetError, MarketEvent
from app.simulation.book_kernel import BOOK_FILL_POLICY, BookAssistedKernel
from app.simulation.trade_kernel import TRADE_FILL_POLICY


def _book(seq: int, time_ms: int, *, snapshot: bool = False, reset: bool = False) -> MarketEvent:
    return MarketEvent(
        sequence=seq,
        event_time_ms=time_ms,
        role="ORDER_BOOK",
        payload={"book_sequence": seq, "snapshot": snapshot, "reset": reset, "bid": "99", "ask": "101"},
    )


def _trade(seq: int, time_ms: int, price: str = "100") -> MarketEvent:
    return MarketEvent(
        sequence=seq,
        event_time_ms=time_ms,
        role="TRADES",
        payload={
            "source_event_kind": "RAW_TRADE",
            "source_sequence": seq,
            "tie_break": str(seq),
            "price": price,
            "qty": "1",
            "bid": "99",
            "ask": "101",
        },
    )


def test_book_gap_and_reset_fail_closed() -> None:
    with pytest.raises(MarketDatasetError, match="book sequence gap"):
        BookAssistedKernel().run(
            (_book(1, 1, snapshot=True), _book(3, 2), _trade(4, 3)),
            lambda *args: [],
        )
    with pytest.raises(MarketDatasetError, match="book reset requires snapshot"):
        BookAssistedKernel().run(
            (_book(1, 1, snapshot=True), _book(2, 2, reset=True), _trade(3, 3)),
            lambda *args: [],
        )


def test_book_assisted_market_uses_visible_touch_not_queue() -> None:
    events = (
        _book(1, 1000, snapshot=True),
        _trade(2, 1100),
        _trade(3, 1200),
    )

    def buy_first(visible, event):
        if event.sequence == 2:
            return [{"side": "BUY", "type": "MARKET", "qty": "1"}]
        return []

    result = BookAssistedKernel().run(events, buy_first)
    assert result.fills[0]["reason"] == "BOOK_ASSISTED_PRINT"
    assert str(result.fills[0]["price"]) == "101"
    assert BOOK_FILL_POLICY != TRADE_FILL_POLICY
    report = build_report(
        {"run_id": "bt", "fidelity_mode": "BOOK_ASSISTED", "source_event_kind": "TRADE_AND_L2"},
        {"fills": result.fills, "report_hash": result.report_hash},
    )
    assert report["report_label"] == "BOOK_ASSISTED"
    assert "queue-exact" in " ".join(report["not_suitable_for"])


def test_book_assisted_limit_uses_opposite_touch() -> None:
    events = (
        _book(1, 1000, snapshot=True),
        _trade(2, 1100),
        _trade(3, 1200, price="99"),
    )

    def buy_limit(visible, event):
        if event.sequence == 2:
            return [{"side": "BUY", "type": "LIMIT", "qty": "1", "limit_price": "100"}]
        return []

    missed = BookAssistedKernel().run(events[:2] + (_trade(3, 1200, price="100"),), buy_limit)
    assert missed.fills == []

    events_through = (
        _book(1, 1000, snapshot=True),
        _trade(2, 1100),
        MarketEvent(
            sequence=3,
            event_time_ms=1150,
            role="ORDER_BOOK",
            payload={"book_sequence": 2, "snapshot": False, "reset": False, "bid": "98", "ask": "99"},
        ),
        _trade(4, 1200, price="99"),
    )

    def buy_after_first(visible, event):
        if event.sequence == 2:
            return [{"side": "BUY", "type": "LIMIT", "qty": "1", "limit_price": "100"}]
        return []

    filled = BookAssistedKernel().run(events_through, buy_after_first)
    assert filled.fills[0]["reason"] == "BOOK_CONSERVATIVE_LIMIT"
    assert str(filled.fills[0]["price"]) == "100"
    assert str(filled.fills[0]["qty"]) == "1"


def test_book_report_ledger_uses_fill_notional() -> None:
    events = (
        _book(1, 1000, snapshot=True),
        _trade(2, 1100),
        _trade(3, 1200),
    )

    def buy_first(visible, event):
        if event.sequence == 2:
            return [{"side": "BUY", "type": "MARKET", "qty": "1"}]
        return []

    result = BookAssistedKernel().run(events, buy_first)
    assert result.ledger_hash
    assert result.report_hash
    assert result.fills[0]["price"] * result.fills[0]["qty"] != result.ledger_hash
