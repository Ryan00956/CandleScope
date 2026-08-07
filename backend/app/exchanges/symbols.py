from __future__ import annotations

from .registry import bootstrap_default_adapters, get_exchange_registry

_BINANCE_PERP_SUFFIXES = {"SWAP", "PERP", "PERPETUAL"}


def normalize_symbol(symbol: str, exchange: str = "binance", market_type: str = "spot") -> str:
    """Normalize a user-facing symbol into the target exchange format.

    Today we only need a defensive normalization for Binance, because old
    watchlists / repair scopes may still contain OKX-style symbols such as
    ``BTC-USDT`` or ``BTC-USDT-SWAP`` while the active exchange is Binance.
    """
    raw_symbol = str(symbol or "").strip()
    normalized_exchange = str(exchange or "binance").strip().lower()
    normalized_market_type = str(market_type or "spot").strip().lower()

    if not raw_symbol:
        return ""

    bootstrap_default_adapters()
    try:
        normalizer = get_exchange_registry().get_plugin(normalized_exchange).symbol_normalizer()
    except KeyError:
        normalized = raw_symbol.upper()
        if normalized_exchange == "binance":
            return _normalize_binance_symbol(normalized, normalized_market_type)
        return normalized

    return normalizer.normalize(raw_symbol, normalized_market_type)


def _normalize_binance_symbol(symbol: str, market_type: str) -> str:
    if "-" not in symbol:
        return symbol

    parts = [part for part in symbol.split("-") if part]
    if not parts:
        return symbol

    if market_type == "futures" and parts[-1] in _BINANCE_PERP_SUFFIXES:
        parts = parts[:-1]

    return "".join(parts)
