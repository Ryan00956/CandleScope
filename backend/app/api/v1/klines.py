"""
Kline API routes.
"""
import asyncio

from fastapi import APIRouter, HTTPException, Query

from app.core.market import INTERVAL_SECONDS, VALID_INTERVALS
from app.data_engine.mock_data import generate_mock_klines
from app.data_engine.services import (
    calculate_sma,
    delete_cached_klines,
    get_cached_history,
    get_cached_latest,
    get_cached_meta,
    get_more_left,
)

router = APIRouter(prefix="/klines", tags=["klines"])


def _validate_interval(interval: str) -> None:
    if interval not in VALID_INTERVALS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported interval: {interval}. Supported: {VALID_INTERVALS}",
        )


@router.get("/")
async def get_klines(
    symbol: str = Query("BTCUSDT", description="Trading symbol, e.g. BTCUSDT"),
    interval: str = Query("1m", description="Kline interval"),
    limit: int = Query(500, ge=1, le=1000, description="Number of rows"),
):
    _validate_interval(interval)
    try:
        payload = await asyncio.to_thread(
            get_cached_latest, symbol=symbol, interval=interval, limit=limit
        )
        if payload["data"]:
            return {
                "symbol": symbol.upper(),
                "interval": interval,
                "count": len(payload["data"]),
                "source": payload["source"],
                "fetched": payload["fetched"],
                "cache": payload["bounds"],
                "data": payload["data"],
            }
    except Exception as exc:  # noqa: BLE001
        print(f"real kline fetch failed: {exc}")

    mock_data = generate_mock_klines(symbol=symbol, interval=interval, count=limit)
    return {
        "symbol": symbol.upper(),
        "interval": interval,
        "count": len(mock_data),
        "source": "mock",
        "fetched": 0,
        "cache": {"earliest_open_time": None, "latest_open_time": None, "total_count": 0},
        "data": mock_data,
    }


@router.get("/latest")
async def get_latest_klines(
    symbol: str = Query("BTCUSDT", description="Trading symbol, e.g. BTCUSDT"),
    interval: str = Query("1m", description="Kline interval"),
    limit: int = Query(2, ge=1, le=1000, description="Number of latest rows"),
):
    _validate_interval(interval)
    try:
        payload = await asyncio.to_thread(
            get_cached_latest, symbol=symbol, interval=interval, limit=limit
        )
        if payload["data"]:
            return {
                "symbol": symbol.upper(),
                "interval": interval,
                "count": len(payload["data"]),
                "source": payload["source"],
                "fetched": payload["fetched"],
                "cache": payload["bounds"],
                "data": payload["data"],
            }
    except Exception as exc:  # noqa: BLE001
        print(f"latest kline fetch failed: {exc}")

    mock_data = generate_mock_klines(symbol=symbol, interval=interval, count=limit)
    return {
        "symbol": symbol.upper(),
        "interval": interval,
        "count": len(mock_data),
        "source": "mock",
        "fetched": 0,
        "cache": {"earliest_open_time": None, "latest_open_time": None, "total_count": 0},
        "data": mock_data,
    }


@router.get("/history")
async def get_klines_history(
    symbol: str = Query("BTCUSDT", description="Trading symbol"),
    interval: str = Query("1h", description="Kline interval"),
    days: int = Query(7, ge=1, le=3650, description="Historical days"),
):
    _validate_interval(interval)

    try:
        payload = await asyncio.to_thread(
            get_cached_history, symbol=symbol, interval=interval, days=days
        )
        if payload["data"]:
            return {
                "symbol": symbol.upper(),
                "interval": interval,
                "days": days,
                "count": len(payload["data"]),
                "source": payload["source"],
                "fetched": payload["fetched"],
                "cache": payload["bounds"],
                "data": payload["data"],
            }
    except Exception as exc:  # noqa: BLE001
        print(f"history fetch failed: {exc}")

    sec = INTERVAL_SECONDS.get(interval, 3600)
    count = min(int(days * 86400 / sec), 3000)
    mock_data = generate_mock_klines(symbol=symbol, interval=interval, count=count)
    return {
        "symbol": symbol.upper(),
        "interval": interval,
        "days": days,
        "count": len(mock_data),
        "source": "mock",
        "fetched": 0,
        "cache": {"earliest_open_time": None, "latest_open_time": None, "total_count": 0},
        "data": mock_data,
    }



@router.get("/history/before")
async def get_klines_before(
    symbol: str = Query("BTCUSDT", description="Trading symbol"),
    interval: str = Query("1h", description="Kline interval"),
    before: int = Query(..., description="Load data before this unix timestamp (seconds)"),
    bars: int = Query(500, ge=50, le=1000, description="How many bars to load"),
):
    _validate_interval(interval)

    payload = await asyncio.to_thread(
        get_more_left, symbol=symbol, interval=interval, before_seconds=before, bars=bars
    )
    return {
        "symbol": symbol.upper(),
        "interval": interval,
        "before": before,
        "bars": bars,
        "count": len(payload["data"]),
        "has_more": payload["has_more"],
        "source": payload["source"],
        "fetched": payload["fetched"],
        "cache": payload["bounds"],
        "data": payload["data"],
    }


@router.get("/storage/meta")
async def get_storage_meta(
    symbol: str = Query("BTCUSDT", description="Trading symbol"),
    interval: str = Query("1h", description="Kline interval"),
):
    _validate_interval(interval)
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
    _validate_interval(interval)
    deleted = delete_cached_klines(
        symbol=symbol,
        interval=interval,
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
    _validate_interval(interval)
    values = calculate_sma(
        symbol=symbol,
        interval=interval,
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
