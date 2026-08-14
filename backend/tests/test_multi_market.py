from __future__ import annotations

import pytest

from app.market_dataset.snapshot import MarketDatasetError, MarketEvent
from app.simulation.portfolio import (
    PortfolioBook,
    assert_track_coverage,
    global_sort_key,
    merge_market_tracks,
)


def _event(time_ms: int, symbol: str, sequence: int, venue: str = "okx") -> MarketEvent:
    return MarketEvent(
        sequence=sequence,
        event_time_ms=time_ms,
        role="TRADES",
        payload={"symbol": symbol, "venue": venue, "source_event_kind": "RAW_TRADE", "price": "1", "qty": "1"},
    )


def test_global_clock_orders_by_time_then_symbol() -> None:
    merged = merge_market_tracks(
        (_event(2000, "ETH", 2),),
        (_event(1000, "BTC", 1), _event(1000, "ETH", 3)),
    )
    assert [event.payload["symbol"] for event in merged] == ["BTC", "ETH", "ETH"]
    assert global_sort_key(merged[0]) < global_sort_key(merged[1])


def test_missing_track_coverage_fails_the_whole_portfolio() -> None:
    events = (_event(1000, "BTC", 1), _event(2000, "BTC", 2))
    with pytest.raises(MarketDatasetError, match="DATA_GAP_REJECTED"):
        assert_track_coverage({"BTC": (1000, 2000), "ETH": (1000, 2000)}, events)


def test_portfolio_cash_and_positions_are_shared() -> None:
    book = PortfolioBook()
    from decimal import Decimal

    book.apply_fill("BTC", "BUY", Decimal("1"), Decimal("100"))
    book.apply_fill("ETH", "BUY", Decimal("2"), Decimal("10"))
    assert book.positions["BTC"] == Decimal("1")
    assert book.cash == Decimal("9880")
