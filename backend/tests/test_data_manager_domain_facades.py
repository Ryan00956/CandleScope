from __future__ import annotations

from app.data_engine.data_manager import (
    BarDataFacade,
    DataManager,
    FullOrderBookFacade,
    LiquidationDataFacade,
    MarketStateFacade,
    PartialOrderBookFacade,
    TradeDataFacade,
)


def test_data_manager_exposes_typed_domain_namespaces() -> None:
    manager = DataManager()

    assert isinstance(manager.bars, BarDataFacade)
    assert isinstance(manager.market_state, MarketStateFacade)
    assert isinstance(manager.trades, TradeDataFacade)
    assert isinstance(manager.liquidations, LiquidationDataFacade)
    assert isinstance(manager.books.partial, PartialOrderBookFacade)
    assert isinstance(manager.books.full, FullOrderBookFacade)


def test_market_data_control_snapshot_is_explicit_about_boundaries() -> None:
    snapshot = DataManager().market_data_control_snapshot()

    assert snapshot["schema"] == "candlescope.market-data-control/1"
    assert snapshot["physical_unification"] is False
    assert snapshot["cross_backend_atomicity"] is False
    assert snapshot["access_namespaces"] == {
        "bars": "bars",
        "market_state": "market_state",
        "public_trades": "trades",
        "liquidations": "liquidations",
        "partial_order_book": "books.partial",
        "full_order_book": "books.full",
    }
    assert snapshot["readiness"] == {
        "bars": False,
        "market_state": False,
        "public_trades": False,
        "liquidations": False,
        "partial_order_book": False,
        "full_order_book": False,
    }
    assert snapshot["coverage_contracts"]["liquidations"]["completeness"] == (
        "sampled_public_observations_not_guaranteed"
    )
    assert snapshot["coverage_contracts"]["full_order_book"]["history"] == (
        "unsupported"
    )
    assert snapshot["catalog"]["provider_count"] == 1
