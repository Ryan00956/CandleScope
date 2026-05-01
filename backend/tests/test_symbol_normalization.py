from __future__ import annotations

from app.data_engine.data_manager.subscriptions import SubscriptionService
from app.exchanges.symbols import normalize_symbol


def test_normalize_binance_symbol_from_okx_style_variants() -> None:
    assert normalize_symbol("BTC-USDT", exchange="binance", market_type="spot") == "BTCUSDT"
    assert normalize_symbol("BTC-USDT-SWAP", exchange="binance", market_type="futures") == "BTCUSDT"
    assert normalize_symbol("BTCUSDT", exchange="binance", market_type="futures") == "BTCUSDT"


def test_keep_okx_symbols_unchanged() -> None:
    assert normalize_symbol("BTC-USDT", exchange="okx", market_type="spot") == "BTC-USDT"
    assert normalize_symbol("BTC-USDT-SWAP", exchange="okx", market_type="futures") == "BTC-USDT-SWAP"


def test_subscription_manager_normalizes_explicit_binance_keys(tmp_path) -> None:
    mgr = SubscriptionService(tmp_path / "subs.db")
    assert mgr.normalize_symbol("binance:futures:BTC-USDT-SWAP") == "futures:BTCUSDT"
    assert mgr.normalize_symbol("binance:spot:BTC-USDT") == "spot:BTCUSDT"
