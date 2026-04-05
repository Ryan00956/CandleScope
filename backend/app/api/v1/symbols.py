"""
Exchange symbol (trading pair) information API.

Fetches and caches the full list of trading pairs from Binance on startup.
Provides a lightweight GET endpoint for the frontend to query available symbols.
"""
from __future__ import annotations

import logging
import time
from typing import Any

import aiohttp
from fastapi import APIRouter, Query

from app.core.config import (
    BINANCE_BASE_URL, BINANCE_BASE_URLS,
    BINANCE_FUTURES_BASE_URL, BINANCE_FUTURES_BASE_URLS,
    REQUEST_TIMEOUT, get_effective_proxy,
)

logger = logging.getLogger("candlescope.symbols")
router = APIRouter(prefix="/symbols", tags=["symbols"])

# ── In-memory cache ──────────────────────────────────────────

_spot_symbols: list[dict[str, str]] = []
_futures_symbols: list[dict[str, str]] = []
_cache_loaded_at: float = 0.0


async def load_exchange_info() -> None:
    """Fetch exchangeInfo from Binance and populate the in-memory cache.

    Tries all configured base URLs in order.  Only keeps TRADING pairs.
    Called once at startup; can also be triggered manually via the
    refresh endpoint.
    """
    global _spot_symbols, _cache_loaded_at

    urls_to_try = [BINANCE_BASE_URL] + [
        u for u in BINANCE_BASE_URLS if u != BINANCE_BASE_URL
    ]

    proxy = get_effective_proxy()
    if proxy:
        logger.info("load_exchange_info using proxy: %s", proxy)

    last_err: Exception | None = None
    for base in urls_to_try:
        url = f"{base}/api/v3/exchangeInfo"
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    url,
                    timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT),
                    proxy=proxy,
                ) as resp:
                    if resp.status != 200:
                        logger.warning("exchangeInfo %s returned HTTP %s", base, resp.status)
                        continue
                    data: dict[str, Any] = await resp.json()
        except Exception as exc:
            last_err = exc
            logger.warning("exchangeInfo fetch failed from %s: %s", base, exc)
            continue

        symbols: list[dict[str, str]] = []
        for item in data.get("symbols", []):
            if item.get("status") != "TRADING":
                continue
            symbols.append({
                "symbol": item["symbol"],
                "baseAsset": item["baseAsset"],
                "quoteAsset": item["quoteAsset"],
                "status": item["status"],
                "exchange": "binance",
                "marketType": "spot",
            })

        _spot_symbols = symbols
        _cache_loaded_at = time.time()
        logger.info(
            "Loaded %d trading spot symbols from %s",
            len(symbols), base,
        )
        return

    logger.error("Failed to load exchangeInfo from all endpoints: %s", last_err)


async def load_futures_exchange_info() -> None:
    """Fetch exchangeInfo from Binance Futures (USDT-M) and cache it."""
    global _futures_symbols, _cache_loaded_at

    urls_to_try = [BINANCE_FUTURES_BASE_URL] + [
        u for u in BINANCE_FUTURES_BASE_URLS if u != BINANCE_FUTURES_BASE_URL
    ]

    proxy = get_effective_proxy()
    last_err: Exception | None = None
    for base in urls_to_try:
        url = f"{base}/fapi/v1/exchangeInfo"
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    url,
                    timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT),
                    proxy=proxy,
                ) as resp:
                    if resp.status != 200:
                        logger.warning("Futures exchangeInfo %s returned HTTP %s", base, resp.status)
                        continue
                    data: dict[str, Any] = await resp.json()
        except Exception as exc:
            last_err = exc
            logger.warning("Futures exchangeInfo fetch failed from %s: %s", base, exc)
            continue

        symbols: list[dict[str, str]] = []
        for item in data.get("symbols", []):
            if item.get("status") != "TRADING":
                continue
            # Only include PERPETUAL contracts (not delivery)
            if item.get("contractType") != "PERPETUAL":
                continue
            symbols.append({
                "symbol": item["symbol"],
                "baseAsset": item["baseAsset"],
                "quoteAsset": item["quoteAsset"],
                "status": item["status"],
                "exchange": "binance",
                "marketType": "futures",
                "contractType": item.get("contractType", ""),
            })

        _futures_symbols = symbols
        _cache_loaded_at = time.time()
        logger.info(
            "Loaded %d trading futures symbols from %s",
            len(symbols), base,
        )
        return

    logger.error("Failed to load Futures exchangeInfo from all endpoints: %s", last_err)


# ── API Endpoints ────────────────────────────────────────────


@router.get("/exchange-info")
async def get_exchange_info(
    search: str = Query("", description="Filter by symbol or asset name (case-insensitive)"),
    quote_asset: str = Query("", description="Filter by quote asset, e.g. USDT, BTC"),
    market_type: str = Query("", description="Filter by market type: spot, futures, or empty for all"),
) -> dict:
    """Return cached trading pair list with optional filtering."""
    # Combine spot + futures, or filter by market_type
    if market_type == "spot":
        results = list(_spot_symbols)
    elif market_type == "futures":
        results = list(_futures_symbols)
    else:
        results = list(_spot_symbols) + list(_futures_symbols)

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
async def refresh_exchange_info() -> dict:
    """Manually re-fetch exchangeInfo from Binance."""
    await load_exchange_info()
    await load_futures_exchange_info()
    return {
        "spot_count": len(_spot_symbols),
        "futures_count": len(_futures_symbols),
        "cached_at": _cache_loaded_at,
    }
