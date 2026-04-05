"""
Kline API routes — powered by DataManager facade.

All endpoints delegate to the unified ``DataManager`` for data retrieval,
which provides:
  * Three-level query resolution: Cache → Storage → Backfill
  * Automatic stream management (auto-start ingestion on demand)
  * Consistent BarAggregator-based custom interval handling
  * Event-driven cache warming

The DataManager instance is stored on ``app.state.data_manager`` and
initialized during application startup (see ``app/main.py``).
"""
from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request

from app.exchanges import bootstrap_default_adapters, get_exchange_registry
from app.exchanges.symbols import normalize_symbol
from app.core.market import (
    INTERVAL_SECONDS,
    VALID_INTERVALS,
    find_best_base_interval,
    find_optimal_fetch_plan,
    is_custom_interval,
    parse_custom_interval,
)
from app.data_engine.mock_data import generate_mock_klines
from app.data_engine.storage import DEFAULT_EXCHANGE, DEFAULT_MARKET_TYPE

# Legacy imports — kept as fallback only
from app.data_engine.services import aggregate_klines, aggregate_multi_resolution

router = APIRouter(prefix="/klines", tags=["klines"])


# ═══════════════════════════════════════════════════════════════
#  Helpers
# ═══════════════════════════════════════════════════════════════


def _get_data_manager(request: Request) -> Any:
    """Retrieve the DataManager from app state.

    Returns None if not yet initialized (graceful fallback to legacy).
    """
    return getattr(request.app.state, "data_manager", None)


def _validate_interval(interval: str) -> None:
    """Accept both native exchange intervals and valid custom intervals."""
    if interval in VALID_INTERVALS:
        return
    parsed = parse_custom_interval(interval)
    if parsed is None or parsed <= 0:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unsupported interval: {interval}. "
                f"Supported native: {VALID_INTERVALS}. "
                f"Custom format: <number><s|m|h|d|w|M>, e.g. 7m, 45m, 3h"
            ),
        )


def _validate_market_type(market_type: str) -> str:
    return (market_type or DEFAULT_MARKET_TYPE).strip().lower()


def _validate_exchange(exchange: str) -> str:
    normalized = (exchange or DEFAULT_EXCHANGE).strip().lower()
    bootstrap_default_adapters()
    if not get_exchange_registry().has(normalized):
        raise HTTPException(status_code=400, detail=f"Unsupported exchange: {exchange}")
    return normalized


def _resolve_interval(interval: str) -> dict:
    """Return resolution info for the requested interval."""
    if not is_custom_interval(interval):
        secs = INTERVAL_SECONDS.get(interval, 60)
        return {
            "is_custom": False,
            "custom_seconds": secs,
            "base_interval": interval,
            "factor": 1,
        }

    custom_seconds = parse_custom_interval(interval)
    base_interval, factor = find_best_base_interval(custom_seconds, interval=interval)
    return {
        "is_custom": True,
        "custom_seconds": custom_seconds,
        "base_interval": base_interval,
        "factor": factor,
    }


def _bars_to_dicts(bars: list) -> list[dict]:
    """Convert BarData list to lightweight-charts dicts."""
    return [b.to_dict() if hasattr(b, "to_dict") else b for b in bars]


# ═══════════════════════════════════════════════════════════════
#  Endpoints — DataManager-powered
# ═══════════════════════════════════════════════════════════════


@router.get("/")
async def get_klines(
    request: Request,
    symbol: str = Query("BTCUSDT", description="Trading symbol, e.g. BTCUSDT"),
    interval: str = Query("1m", description="Kline interval"),
    limit: int = Query(500, ge=1, le=1000, description="Number of rows"),
    exchange: str = Query(DEFAULT_EXCHANGE, description="Exchange, e.g. binance"),
    market_type: str = Query(DEFAULT_MARKET_TYPE, description="Market type: spot, futures, swap"),
):
    """Get the latest K-line bars for a symbol/interval pair.

    Uses DataManager.query_latest() which resolves through
    Cache → Storage → Backfill automatically.
    """
    _validate_interval(interval)
    exchange = _validate_exchange(exchange)
    market_type = _validate_market_type(market_type)
    symbol = normalize_symbol(symbol, exchange=exchange, market_type=market_type)

    dm = _get_data_manager(request)
    if dm is not None:
        try:
            # Ensure stream is active (auto-starts ingestion if needed)
            await dm.ensure_stream(symbol, interval, exchange=exchange, market_type=market_type)

            # Query through DataManager's unified interface
            result = await asyncio.to_thread(
                dm.query_latest, symbol, interval, limit,
                exchange,
                market_type=market_type,
            )

            data = _bars_to_dicts(result.bars)
            return {
                "exchange": exchange,
                "market_type": market_type,
                "symbol": symbol.upper(),
                "interval": interval,
                "count": len(data),
                "source": result.source.value,
                "fetched": result.total,
                "cache": result.metadata,
                "data": data,
                "base_interval": None,
            }
        except Exception as exc:
            print(f"DataManager query failed, falling back to legacy: {exc}")

    # ── Legacy fallback (when DataManager is not available) ──
    return await _legacy_get_klines(symbol, interval, limit)


@router.get("/latest")
async def get_latest_klines(
    request: Request,
    symbol: str = Query("BTCUSDT", description="Trading symbol, e.g. BTCUSDT"),
    interval: str = Query("1m", description="Kline interval"),
    limit: int = Query(2, ge=1, le=1000, description="Number of latest rows"),
    exchange: str = Query(DEFAULT_EXCHANGE, description="Exchange, e.g. binance"),
    market_type: str = Query(DEFAULT_MARKET_TYPE, description="Market type: spot, futures, swap"),
):
    """Get the very latest K-line bars (typically 1-2 for live updates)."""
    _validate_interval(interval)
    exchange = _validate_exchange(exchange)
    market_type = _validate_market_type(market_type)
    symbol = normalize_symbol(symbol, exchange=exchange, market_type=market_type)

    dm = _get_data_manager(request)
    if dm is not None:
        try:
            await dm.ensure_stream(symbol, interval, exchange=exchange, market_type=market_type)
            result = await asyncio.to_thread(
                dm.query_latest, symbol, interval, limit,
                exchange,
                market_type=market_type,
            )
            data = _bars_to_dicts(result.bars)
            return {
                "exchange": exchange,
                "market_type": market_type,
                "symbol": symbol.upper(),
                "interval": interval,
                "count": len(data),
                "source": result.source.value,
                "fetched": result.total,
                "cache": result.metadata,
                "data": data,
                "base_interval": None,
            }
        except Exception as exc:
            print(f"DataManager latest query failed: {exc}")

    return await _legacy_get_latest(symbol, interval, limit)


@router.get("/history")
async def get_klines_history(
    request: Request,
    symbol: str = Query("BTCUSDT", description="Trading symbol"),
    interval: str = Query("1h", description="Kline interval"),
    days: float = Query(7, ge=0.001, le=3650, description="Historical days (supports fractional, e.g. 0.04)"),
    exchange: str = Query(DEFAULT_EXCHANGE, description="Exchange, e.g. binance"),
    market_type: str = Query(DEFAULT_MARKET_TYPE, description="Market type: spot, futures, swap"),
):
    """Get historical K-line bars for a time range."""
    _validate_interval(interval)
    exchange = _validate_exchange(exchange)
    market_type = _validate_market_type(market_type)
    symbol = normalize_symbol(symbol, exchange=exchange, market_type=market_type)

    dm = _get_data_manager(request)
    if dm is not None:
        try:
            import time
            end_ms = int(time.time() * 1000)
            start_ms = end_ms - int(days * 24 * 60 * 60 * 1000)
            
            # Calculate the required limit to fit the requested days
            from app.core.market import INTERVAL_SECONDS, parse_custom_interval
            interval_secs = parse_custom_interval(interval) or 60
            needed_limit = int((end_ms - start_ms) / 1000 / interval_secs) + 100

            result = await asyncio.to_thread(
                dm.query,
                symbol, interval,
                start_ms=start_ms,
                end_ms=end_ms,
                limit=needed_limit,
                exchange=exchange,
                market_type=market_type,
            )
            data = _bars_to_dicts(result.bars)
            return {
                "exchange": exchange,
                "market_type": market_type,
                "symbol": symbol.upper(),
                "interval": interval,
                "days": days,
                "count": len(data),
                "source": result.source.value,
                "fetched": result.total,
                "has_tail_gap": result.has_tail_gap,
                "backfill_triggered": result.backfill_triggered,
                "cache": result.metadata,
                "data": data,
                "base_interval": None,
            }
        except Exception as exc:
            print(f"DataManager history query failed: {exc}")

    return await _legacy_get_history(symbol, interval, days)


@router.get("/history/before")
async def get_klines_before(
    request: Request,
    symbol: str = Query("BTCUSDT", description="Trading symbol"),
    interval: str = Query("1h", description="Kline interval"),
    before: int = Query(..., description="Load data before this unix timestamp (seconds)"),
    bars: int = Query(500, ge=1, le=1000, description="How many bars to load"),
    exchange: str = Query(DEFAULT_EXCHANGE, description="Exchange, e.g. binance"),
    market_type: str = Query(DEFAULT_MARKET_TYPE, description="Market type: spot, futures, swap"),
):
    """Paginated historical data — load bars before a timestamp."""
    _validate_interval(interval)
    exchange = _validate_exchange(exchange)
    market_type = _validate_market_type(market_type)
    symbol = normalize_symbol(symbol, exchange=exchange, market_type=market_type)

    dm = _get_data_manager(request)
    if dm is not None:
        try:
            before_ms = before * 1000
            result = await asyncio.to_thread(
                dm.query_before,
                symbol, interval, before_ms, bars,
                exchange,
                market_type=market_type,
            )
            data = _bars_to_dicts(result.bars)
            return {
                "exchange": exchange,
                "market_type": market_type,
                "symbol": symbol.upper(),
                "interval": interval,
                "before": before,
                "bars": bars,
                "count": len(data),
                "has_more": result.has_more,
                "source": result.source.value,
                "fetched": result.total,
                "cache": result.metadata,
                "data": data,
                "base_interval": None,
            }
        except Exception as exc:
            print(f"DataManager before query failed: {exc}")

    return await _legacy_get_before(symbol, interval, before, bars)


@router.get("/resolve")
async def resolve_interval_info(
    interval: str = Query(..., description="Interval to resolve, e.g. '7m' or '45m'"),
):
    """Return resolution metadata for a given interval string."""
    _validate_interval(interval)
    res = _resolve_interval(interval)
    plan = find_optimal_fetch_plan(res["custom_seconds"]) if res["is_custom"] else None
    return {
        "interval": interval,
        "is_custom": res["is_custom"],
        "custom_seconds": res["custom_seconds"],
        "base_interval": res["base_interval"],
        "factor": res["factor"],
        "fetch_plan": plan,
    }


@router.get("/storage/meta")
async def get_storage_meta(
    request: Request,
    symbol: str = Query("BTCUSDT", description="Trading symbol"),
    interval: str = Query("1h", description="Kline interval"),
    exchange: str = Query(DEFAULT_EXCHANGE, description="Exchange, e.g. binance"),
    market_type: str = Query(DEFAULT_MARKET_TYPE, description="Market type: spot, futures, swap"),
):
    """Get storage metadata (bounds, count) for a series."""
    _validate_interval(interval)
    exchange = _validate_exchange(exchange)
    market_type = _validate_market_type(market_type)
    symbol = normalize_symbol(symbol, exchange=exchange, market_type=market_type)

    dm = _get_data_manager(request)
    if dm is not None:
        try:
            bounds = await asyncio.to_thread(
                dm.get_bounds, symbol, interval,
                exchange,
                market_type=market_type,
            )
            return {
                "exchange": exchange,
                "market_type": market_type,
                "symbol": symbol.upper(),
                "interval": interval,
                "meta": bounds,
            }
        except Exception as exc:
            print(f"DataManager bounds query failed: {exc}")

    # Legacy fallback
    from app.data_engine.services import get_cached_meta
    meta = get_cached_meta(symbol=symbol, interval=interval)
    return {
        "symbol": symbol.upper(),
        "interval": interval,
        "meta": meta,
    }


@router.delete("/storage")
async def delete_storage_data(
    symbol: str = Query(..., description="Trading symbol"),
    interval: str = Query(..., description="Kline interval"),
    start: int | None = Query(None, description="start unix timestamp (seconds)"),
    end: int | None = Query(None, description="end unix timestamp (seconds)"),
):
    """Delete stored K-line data for a symbol/interval range."""
    _validate_interval(interval)
    from app.data_engine.services import delete_cached_klines
    res = _resolve_interval(interval)
    deleted = delete_cached_klines(
        symbol=symbol,
        interval=res["base_interval"],
        start_seconds=start,
        end_seconds=end,
    )
    return {
        "symbol": symbol.upper(),
        "interval": interval,
        "deleted": deleted,
    }


@router.get("/indicators/sma")
async def get_sma(
    symbol: str = Query("BTCUSDT", description="Trading symbol"),
    interval: str = Query("1h", description="Kline interval"),
    period: int = Query(20, ge=2, le=500),
    start: int | None = Query(None, description="start unix timestamp (seconds)"),
    end: int | None = Query(None, description="end unix timestamp (seconds)"),
):
    """Calculate SMA indicator values."""
    _validate_interval(interval)
    from app.data_engine.services import calculate_sma
    res = _resolve_interval(interval)
    values = calculate_sma(
        symbol=symbol,
        interval=res["base_interval"],
        period=period,
        start_seconds=start,
        end_seconds=end,
    )
    return {
        "symbol": symbol.upper(),
        "interval": interval,
        "period": period,
        "count": len(values),
        "data": values,
    }


# ═══════════════════════════════════════════════════════════════
#  Legacy Fallback Functions (when DataManager is not initialized)
# ═══════════════════════════════════════════════════════════════


async def _legacy_get_klines(symbol: str, interval: str, limit: int) -> dict:
    """Legacy path using old kline_cache_service."""
    from app.data_engine.services import get_cached_latest

    res = _resolve_interval(interval)
    fetch_limit = min(limit * res["factor"], 5000) if res["is_custom"] else limit

    try:
        payload = await asyncio.to_thread(
            get_cached_latest, symbol=symbol,
            interval=res["base_interval"], limit=fetch_limit,
        )
        if payload["data"]:
            data = payload["data"]
            if res["is_custom"]:
                data = aggregate_klines(data, res["custom_seconds"], interval=interval)
                data = data[-limit:]
            return {
                "symbol": symbol.upper(),
                "interval": interval,
                "count": len(data),
                "source": payload["source"],
                "fetched": payload["fetched"],
                "cache": payload["bounds"],
                "data": data,
                "base_interval": res["base_interval"] if res["is_custom"] else None,
            }
    except Exception as exc:
        print(f"legacy kline fetch failed: {exc}")

    mock_data = generate_mock_klines(symbol=symbol, interval=res["base_interval"], count=fetch_limit)
    if res["is_custom"]:
        mock_data = aggregate_klines(mock_data, res["custom_seconds"], interval=interval)
        mock_data = mock_data[-limit:]
    return {
        "symbol": symbol.upper(),
        "interval": interval,
        "count": len(mock_data),
        "source": "mock",
        "fetched": 0,
        "cache": {"earliest_open_time": None, "latest_open_time": None, "total_count": 0},
        "data": mock_data,
        "base_interval": res["base_interval"] if res["is_custom"] else None,
    }


async def _legacy_get_latest(symbol: str, interval: str, limit: int) -> dict:
    """Legacy path for /latest endpoint."""
    from app.data_engine.services import get_cached_latest

    res = _resolve_interval(interval)
    fetch_limit = min(limit * res["factor"] + res["factor"], 5000) if res["is_custom"] else limit

    try:
        payload = await asyncio.to_thread(
            get_cached_latest, symbol=symbol,
            interval=res["base_interval"], limit=fetch_limit,
        )
        if payload["data"]:
            data = payload["data"]
            if res["is_custom"]:
                data = aggregate_klines(data, res["custom_seconds"], interval=interval)
                data = data[-limit:]
            return {
                "symbol": symbol.upper(),
                "interval": interval,
                "count": len(data),
                "source": payload["source"],
                "fetched": payload["fetched"],
                "cache": payload["bounds"],
                "data": data,
                "base_interval": res["base_interval"] if res["is_custom"] else None,
            }
    except Exception as exc:
        print(f"legacy latest fetch failed: {exc}")

    mock_data = generate_mock_klines(symbol=symbol, interval=res["base_interval"], count=fetch_limit)
    if res["is_custom"]:
        mock_data = aggregate_klines(mock_data, res["custom_seconds"], interval=interval)
        mock_data = mock_data[-limit:]
    return {
        "symbol": symbol.upper(),
        "interval": interval,
        "count": len(mock_data),
        "source": "mock",
        "fetched": 0,
        "cache": {"earliest_open_time": None, "latest_open_time": None, "total_count": 0},
        "data": mock_data,
        "base_interval": res["base_interval"] if res["is_custom"] else None,
    }


async def _legacy_get_history(symbol: str, interval: str, days: int) -> dict:
    """Legacy path for /history endpoint."""
    from app.data_engine.services import get_cached_history

    res = _resolve_interval(interval)
    try:
        payload = await asyncio.to_thread(
            get_cached_history, symbol=symbol,
            interval=res["base_interval"], days=days,
        )
        data = payload.get("data", [])
        if res["is_custom"] and data:
            data = aggregate_klines(data, res["custom_seconds"], interval=interval)
        if data:
            return {
                "symbol": symbol.upper(),
                "interval": interval,
                "days": days,
                "count": len(data),
                "source": payload["source"],
                "fetched": payload["fetched"],
                "cache": payload["bounds"],
                "data": data,
                "base_interval": res["base_interval"] if res["is_custom"] else None,
            }
    except Exception as exc:
        print(f"legacy history fetch failed: {exc}")

    sec = INTERVAL_SECONDS.get(res["base_interval"] if res["is_custom"] else interval, 3600)
    count = min(int(days * 86400 / sec), 3000)
    mock_data = generate_mock_klines(
        symbol=symbol,
        interval=res["base_interval"] if res["is_custom"] else interval,
        count=count,
    )
    if res["is_custom"]:
        mock_data = aggregate_klines(mock_data, res["custom_seconds"], interval=interval)
    return {
        "symbol": symbol.upper(),
        "interval": interval,
        "days": days,
        "count": len(mock_data),
        "source": "mock",
        "fetched": 0,
        "cache": {"earliest_open_time": None, "latest_open_time": None, "total_count": 0},
        "data": mock_data,
        "base_interval": res["base_interval"] if res["is_custom"] else None,
    }


async def _legacy_get_before(
    symbol: str, interval: str, before: int, bars: int,
) -> dict:
    """Legacy path for /history/before endpoint."""
    from app.data_engine.services import get_more_left

    res = _resolve_interval(interval)
    if res["is_custom"]:
        needed_base = min(bars * res["factor"], 5000)
        max_batches = max(12, (needed_base // 1000) + 2)
        payload = await asyncio.to_thread(
            get_more_left, symbol=symbol,
            interval=res["base_interval"],
            before_seconds=before, bars=needed_base,
            max_batches=max_batches,
        )
        data = aggregate_klines(payload["data"], res["custom_seconds"], interval=interval)
    else:
        payload = await asyncio.to_thread(
            get_more_left, symbol=symbol,
            interval=res["base_interval"],
            before_seconds=before, bars=bars,
        )
        data = payload["data"]

    return {
        "symbol": symbol.upper(),
        "interval": interval,
        "before": before,
        "bars": bars,
        "count": len(data),
        "has_more": payload["has_more"],
        "source": payload["source"],
        "fetched": payload["fetched"],
        "cache": payload["bounds"],
        "data": data,
        "base_interval": res["base_interval"] if res["is_custom"] else None,
    }
