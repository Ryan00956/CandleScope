"""
Exchange symbol (trading pair) information API.

This module now reads symbol metadata through the exchange registry.
Binance remains the default adapter, but the cache shape is already
prepared for future exchanges.
"""
from __future__ import annotations

import copy
import time
from typing import Any

from fastapi import APIRouter, Query

from app.exchanges import bootstrap_default_adapters, get_exchange_registry

router = APIRouter(prefix="/symbols", tags=["symbols"])

# ── In-memory cache ──────────────────────────────────────────

_symbol_cache: dict[tuple[str, str], list[dict[str, Any]]] = {}
_cache_loaded_at: float = 0.0


def _market_cache_key(exchange: str, market_type: str) -> tuple[str, str]:
    return exchange.strip().lower(), (market_type or "").strip().lower()


def _merge_symbol_snapshot(
    previous: list[dict[str, Any]],
    current: list[dict[str, Any]],
    *,
    observed_at_ms: int,
    previous_observed_at_ms: int | None,
) -> list[dict[str, Any]]:
    """Retain disappeared instruments as process-local inactive metadata.

    A missing instrument is observational evidence only, so this does not
    invent a delisting timestamp. The planner may still use its last known
    listing/expiry metadata without the public symbol list showing it as live.
    """

    previous_by_symbol = {
        str(item.get("symbol", "")).upper(): item
        for item in previous
        if str(item.get("symbol", "")).strip()
    }
    merged: list[dict[str, Any]] = []
    current_symbols: set[str] = set()
    for item in current:
        snapshot = dict(item)
        symbol = str(snapshot.get("symbol", "")).upper()
        if not symbol:
            continue
        current_symbols.add(symbol)
        old = previous_by_symbol.get(symbol, {})
        snapshot["active"] = True
        snapshot["firstSeenAtMs"] = old.get("firstSeenAtMs", observed_at_ms)
        snapshot["lastSeenAtMs"] = observed_at_ms
        snapshot.pop("inactiveSinceMs", None)
        merged.append(snapshot)

    for symbol, old in previous_by_symbol.items():
        if symbol in current_symbols:
            continue
        snapshot = dict(old)
        snapshot["active"] = False
        snapshot.setdefault(
            "lastSeenAtMs",
            previous_observed_at_ms or observed_at_ms,
        )
        snapshot.setdefault("inactiveSinceMs", observed_at_ms)
        merged.append(snapshot)
    return merged


def get_cached_symbol_metadata(
    exchange: str,
    market_type: str,
    symbol: str,
) -> dict[str, Any] | None:
    """Return a detached synchronous snapshot for history planning."""

    key = _market_cache_key(exchange, market_type)
    normalized_symbol = str(symbol or "").strip().upper()
    for item in _symbol_cache.get(key, ()):
        if str(item.get("symbol", "")).upper() == normalized_symbol:
            return copy.deepcopy(item)
    return None


async def refresh_exchange_metadata(exchange: str = "") -> dict[str, int]:
    """Refresh symbol metadata from all or one registered exchange."""
    global _cache_loaded_at

    bootstrap_default_adapters()
    registry = get_exchange_registry()

    adapters = [registry.get(exchange)] if exchange else registry.list()
    counts: dict[str, int] = {}

    observed_at_ms = int(time.time() * 1000)
    previous_observed_at_ms = (
        int(_cache_loaded_at * 1000)
        if _cache_loaded_at > 0
        else None
    )
    for adapter in adapters:
        seen_market_types: set[str] = set()
        for market in adapter.capabilities().markets:
            market_type = market.market_type.strip().lower()
            if market_type in seen_market_types:
                continue
            seen_market_types.add(market_type)
            symbols = await adapter.list_symbols(market_type)
            key = _market_cache_key(adapter.id, market_type)
            current = [
                item.to_dict() for item in symbols
            ]
            _symbol_cache[key] = _merge_symbol_snapshot(
                _symbol_cache.get(key, []),
                current,
                observed_at_ms=observed_at_ms,
                previous_observed_at_ms=previous_observed_at_ms,
            )
            counts[f"{adapter.id}:{market_type}"] = len(symbols)

    _cache_loaded_at = observed_at_ms / 1000
    return counts


async def load_exchange_info() -> None:
    """Backward-compatible loader for Binance spot metadata."""
    await refresh_exchange_metadata("binance")


async def load_futures_exchange_info() -> None:
    """Backward-compatible loader for Binance futures metadata."""
    await refresh_exchange_metadata("binance")


def _iter_cached_symbols(
    exchange: str = "",
    market_type: str = "",
    *,
    include_inactive: bool = False,
) -> list[dict[str, Any]]:
    normalized_exchange = exchange.strip().lower()
    normalized_market_type = market_type.strip().lower()

    results: list[dict[str, Any]] = []
    for (cached_exchange, cached_market_type), symbols in _symbol_cache.items():
        if normalized_exchange and cached_exchange != normalized_exchange:
            continue
        if normalized_market_type and cached_market_type != normalized_market_type:
            continue
        results.extend(
            item
            for item in symbols
            if include_inactive or item.get("active", True) is True
        )
    return results


def list_cached_symbols(
    exchange: str = "",
    market_type: str = "",
    *,
    include_inactive: bool = False,
) -> tuple[list[dict[str, Any]], float]:
    """Return a detached public symbol snapshot for non-HTTP consumers."""

    return (
        copy.deepcopy(
            _iter_cached_symbols(
                exchange=exchange,
                market_type=market_type,
                include_inactive=include_inactive,
            )
        ),
        _cache_loaded_at,
    )


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
    results, cached_at = list_cached_symbols(exchange=exchange, market_type=market_type)

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
        "cached_at": cached_at,
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
