"""
Exchange symbol (trading pair) information API.

This module now reads symbol metadata through the exchange registry.
Binance remains the default adapter, but the cache shape is already
prepared for future exchanges.
"""
from __future__ import annotations

import time

from fastapi import APIRouter, Query

from app.exchanges import bootstrap_default_adapters, get_exchange_registry

router = APIRouter(prefix="/symbols", tags=["symbols"])

# ── In-memory cache ──────────────────────────────────────────

_symbol_cache: dict[tuple[str, str], list[dict[str, str]]] = {}
_cache_loaded_at: float = 0.0


def _market_cache_key(exchange: str, market_type: str) -> tuple[str, str]:
    return exchange.strip().lower(), (market_type or "").strip().lower()


async def refresh_exchange_metadata(exchange: str = "") -> dict[str, int]:
    """Refresh symbol metadata from all or one registered exchange."""
    global _cache_loaded_at

    bootstrap_default_adapters()
    registry = get_exchange_registry()

    adapters = [registry.get(exchange)] if exchange else registry.list()
    counts: dict[str, int] = {}

    for adapter in adapters:
        seen_market_types: set[str] = set()
        for market in adapter.capabilities().markets:
            market_type = market.market_type.strip().lower()
            if market_type in seen_market_types:
                continue
            seen_market_types.add(market_type)
            symbols = await adapter.list_symbols(market_type)
            _symbol_cache[_market_cache_key(adapter.id, market_type)] = [
                item.to_dict() for item in symbols
            ]
            counts[f"{adapter.id}:{market_type}"] = len(symbols)

    _cache_loaded_at = time.time()
    return counts


async def load_exchange_info() -> None:
    """Backward-compatible loader for Binance spot metadata."""
    await refresh_exchange_metadata("binance")


async def load_futures_exchange_info() -> None:
    """Backward-compatible loader for Binance futures metadata."""
    await refresh_exchange_metadata("binance")


def _iter_cached_symbols(exchange: str = "", market_type: str = "") -> list[dict[str, str]]:
    normalized_exchange = exchange.strip().lower()
    normalized_market_type = market_type.strip().lower()

    results: list[dict[str, str]] = []
    for (cached_exchange, cached_market_type), symbols in _symbol_cache.items():
        if normalized_exchange and cached_exchange != normalized_exchange:
            continue
        if normalized_market_type and cached_market_type != normalized_market_type:
            continue
        results.extend(symbols)
    return results


# ── API Endpoints ────────────────────────────────────────────


@router.get("/exchange-info")
async def get_exchange_info(
    search: str = Query("", description="Filter by symbol or asset name (case-insensitive)"),
    quote_asset: str = Query("", description="Filter by quote asset, e.g. USDT, BTC"),
    market_type: str = Query("", description="Filter by market type: spot, futures, or empty for all"),
    exchange: str = Query("", description="Filter by exchange id, e.g. binance, okx"),
) -> dict:
    """Return cached trading pair list with optional filtering."""
    bootstrap_default_adapters()
    results = _iter_cached_symbols(exchange=exchange, market_type=market_type)

    if quote_asset:
        qa = quote_asset.upper().strip()
        results = [s for s in results if s["quoteAsset"] == qa]

    if search:
        q = search.upper().strip()
        results = [
            s for s in results
            if q in s["symbol"] or q in s["baseAsset"] or q in s["quoteAsset"]
        ]

    return {
        "count": len(results),
        "cached_at": _cache_loaded_at,
        "symbols": results,
    }


@router.post("/exchange-info/refresh")
async def refresh_exchange_info(exchange: str = Query("", description="Optional exchange id")) -> dict:
    """Manually re-fetch exchange metadata via the registry."""
    counts = await refresh_exchange_metadata(exchange)
    return {
        "counts": counts,
        "cached_at": _cache_loaded_at,
    }
