"""
Kline API routes.
"""
import asyncio

from fastapi import APIRouter, HTTPException, Query

from app.core.market import (
    INTERVAL_SECONDS,
    VALID_INTERVALS,
    find_best_base_interval,
    find_optimal_fetch_plan,
    is_custom_interval,
    parse_custom_interval,
)
from app.data_engine.mock_data import generate_mock_klines
from app.data_engine.services import (
    aggregate_klines,
    aggregate_multi_resolution,
    calculate_sma,
    delete_cached_klines,
    get_cached_history,
    get_cached_latest,
    get_cached_meta,
    get_more_left,
)

router = APIRouter(prefix="/klines", tags=["klines"])


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


def _resolve_interval(interval: str) -> dict:
    """Return resolution info for the requested interval.

    Returns dict with keys:
      - is_custom: bool
      - custom_seconds: int (total seconds of target interval)
      - base_interval: str (exchange-native interval to fetch)
      - factor: int (how many base candles per custom candle)
    """
    if not is_custom_interval(interval):
        secs = INTERVAL_SECONDS.get(interval, 60)
        return {
            "is_custom": False,
            "custom_seconds": secs,
            "base_interval": interval,
            "factor": 1,
        }

    custom_seconds = parse_custom_interval(interval)
    base_interval, factor = find_best_base_interval(custom_seconds)
    return {
        "is_custom": True,
        "custom_seconds": custom_seconds,
        "base_interval": base_interval,
        "factor": factor,
    }


async def _aggregate_custom_history(
    symbol: str,
    custom_seconds: int,
    fetcher,
    *fetcher_args,
    **fetcher_kwargs,
) -> list[dict]:
    """Fetch base data and aggregate into custom candles.

    Automatically chooses single-base or multi-resolution strategy based on
    the fetch plan.
    """
    plan = find_optimal_fetch_plan(custom_seconds)

    if plan["use_multi_res"]:
        # Parallel fetch of coarse + fine data
        coarse_coro = asyncio.to_thread(
            fetcher, symbol=symbol, interval=plan["coarse_interval"],
            *fetcher_args, **fetcher_kwargs,
        )
        fine_coro = asyncio.to_thread(
            fetcher, symbol=symbol, interval=plan["base_interval"],
            *fetcher_args, **fetcher_kwargs,
        )
        coarse_payload, fine_payload = await asyncio.gather(coarse_coro, fine_coro)

        coarse_data = coarse_payload.get("data", [])
        fine_data = fine_payload.get("data", [])

        data = aggregate_multi_resolution(
            custom_interval_seconds=custom_seconds,
            coarse_rows=coarse_data,
            coarse_seconds=plan["coarse_seconds"],
            fine_rows=fine_data,
            fine_seconds=plan["base_seconds"],
        )
        # Return metadata from the fine payload (it's more detailed)
        return data, fine_payload
    else:
        payload = await asyncio.to_thread(
            fetcher, symbol=symbol, interval=plan["base_interval"],
            *fetcher_args, **fetcher_kwargs,
        )
        data = aggregate_klines(payload.get("data", []), custom_seconds)
        return data, payload


@router.get("/")
async def get_klines(
    symbol: str = Query("BTCUSDT", description="Trading symbol, e.g. BTCUSDT"),
    interval: str = Query("1m", description="Kline interval"),
    limit: int = Query(500, ge=1, le=1000, description="Number of rows"),
):
    _validate_interval(interval)
    res = _resolve_interval(interval)

    # For custom intervals, we need more base rows to produce `limit` aggregated candles
    fetch_limit = min(limit * res["factor"], 5000) if res["is_custom"] else limit

    try:
        payload = await asyncio.to_thread(
            get_cached_latest,
            symbol=symbol,
            interval=res["base_interval"],
            limit=fetch_limit,
        )
        if payload["data"]:
            data = payload["data"]
            if res["is_custom"]:
                data = aggregate_klines(data, res["custom_seconds"])
                data = data[-limit:]  # trim to requested limit

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
    except Exception as exc:  # noqa: BLE001
        print(f"real kline fetch failed: {exc}")

    mock_data = generate_mock_klines(symbol=symbol, interval=res["base_interval"], count=fetch_limit)
    if res["is_custom"]:
        mock_data = aggregate_klines(mock_data, res["custom_seconds"])
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


@router.get("/latest")
async def get_latest_klines(
    symbol: str = Query("BTCUSDT", description="Trading symbol, e.g. BTCUSDT"),
    interval: str = Query("1m", description="Kline interval"),
    limit: int = Query(2, ge=1, le=1000, description="Number of latest rows"),
):
    _validate_interval(interval)
    res = _resolve_interval(interval)
    fetch_limit = min(limit * res["factor"] + res["factor"], 5000) if res["is_custom"] else limit

    try:
        payload = await asyncio.to_thread(
            get_cached_latest,
            symbol=symbol,
            interval=res["base_interval"],
            limit=fetch_limit,
        )
        if payload["data"]:
            data = payload["data"]
            if res["is_custom"]:
                data = aggregate_klines(data, res["custom_seconds"])
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
    except Exception as exc:  # noqa: BLE001
        print(f"latest kline fetch failed: {exc}")

    mock_data = generate_mock_klines(symbol=symbol, interval=res["base_interval"], count=fetch_limit)
    if res["is_custom"]:
        mock_data = aggregate_klines(mock_data, res["custom_seconds"])
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


@router.get("/history")
async def get_klines_history(
    symbol: str = Query("BTCUSDT", description="Trading symbol"),
    interval: str = Query("1h", description="Kline interval"),
    days: int = Query(7, ge=1, le=3650, description="Historical days"),
):
    _validate_interval(interval)
    res = _resolve_interval(interval)
    plan = find_optimal_fetch_plan(res["custom_seconds"]) if res["is_custom"] else None

    try:
        if res["is_custom"] and plan and plan["use_multi_res"]:
            # Multi-resolution: fetch coarse + fine in parallel
            coarse_coro = asyncio.to_thread(
                get_cached_history, symbol=symbol,
                interval=plan["coarse_interval"], days=days,
            )
            fine_coro = asyncio.to_thread(
                get_cached_history, symbol=symbol,
                interval=plan["base_interval"], days=days,
            )
            coarse_payload, fine_payload = await asyncio.gather(coarse_coro, fine_coro)
            data = aggregate_multi_resolution(
                custom_interval_seconds=res["custom_seconds"],
                coarse_rows=coarse_payload.get("data", []),
                coarse_seconds=plan["coarse_seconds"],
                fine_rows=fine_payload.get("data", []),
                fine_seconds=plan["base_seconds"],
            )
            payload = fine_payload  # use fine payload for metadata
        else:
            payload = await asyncio.to_thread(
                get_cached_history, symbol=symbol,
                interval=res["base_interval"], days=days,
            )
            data = payload.get("data", [])
            if res["is_custom"] and data:
                data = aggregate_klines(data, res["custom_seconds"])

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
    except Exception as exc:  # noqa: BLE001
        print(f"history fetch failed: {exc}")

    sec = INTERVAL_SECONDS.get(res["base_interval"] if res["is_custom"] else interval, 3600)
    count = min(int(days * 86400 / sec), 3000)
    mock_data = generate_mock_klines(symbol=symbol, interval=res["base_interval"] if res["is_custom"] else interval, count=count)
    if res["is_custom"]:
        mock_data = aggregate_klines(mock_data, res["custom_seconds"])
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


@router.get("/history/before")
async def get_klines_before(
    symbol: str = Query("BTCUSDT", description="Trading symbol"),
    interval: str = Query("1h", description="Kline interval"),
    before: int = Query(..., description="Load data before this unix timestamp (seconds)"),
    bars: int = Query(500, ge=50, le=1000, description="How many bars to load"),
):
    _validate_interval(interval)
    res = _resolve_interval(interval)
    plan = find_optimal_fetch_plan(res["custom_seconds"]) if res["is_custom"] else None

    if res["is_custom"] and plan and plan["use_multi_res"]:
        # Multi-resolution: fetch coarse + fine data in parallel
        needed_fine = min(bars * plan["factor"], 5000)
        # Coarse bars: each custom bar has at most custom/coarse coarse candles
        needed_coarse = min(bars * (res["custom_seconds"] // plan["coarse_seconds"] + 1), 3000)
        max_batches_fine = max(12, (needed_fine // 1000) + 2)

        coarse_coro = asyncio.to_thread(
            get_more_left, symbol=symbol,
            interval=plan["coarse_interval"],
            before_seconds=before, bars=needed_coarse,
        )
        fine_coro = asyncio.to_thread(
            get_more_left, symbol=symbol,
            interval=plan["base_interval"],
            before_seconds=before, bars=needed_fine,
            max_batches=max_batches_fine,
        )
        coarse_payload, fine_payload = await asyncio.gather(coarse_coro, fine_coro)
        data = aggregate_multi_resolution(
            custom_interval_seconds=res["custom_seconds"],
            coarse_rows=coarse_payload["data"],
            coarse_seconds=plan["coarse_seconds"],
            fine_rows=fine_payload["data"],
            fine_seconds=plan["base_seconds"],
        )
        payload = fine_payload
    elif res["is_custom"]:
        needed_base = min(bars * res["factor"], 5000)
        max_batches = max(12, (needed_base // 1000) + 2)
        payload = await asyncio.to_thread(
            get_more_left, symbol=symbol,
            interval=res["base_interval"],
            before_seconds=before, bars=needed_base,
            max_batches=max_batches,
        )
        data = aggregate_klines(payload["data"], res["custom_seconds"])
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


@router.get("/resolve")
async def resolve_interval_info(
    interval: str = Query(..., description="Interval to resolve, e.g. '7m' or '45m'"),
):
    """Return resolution metadata for a given interval string.

    Useful for the frontend to know the base interval for WebSocket
    streaming when using custom intervals.
    """
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
    symbol: str = Query("BTCUSDT", description="Trading symbol"),
    interval: str = Query("1h", description="Kline interval"),
):
    _validate_interval(interval)
    res = _resolve_interval(interval)
    meta = get_cached_meta(symbol=symbol, interval=res["base_interval"])
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
    _validate_interval(interval)
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
