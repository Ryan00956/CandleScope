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
import inspect
import logging
import time
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
from app.data_engine.interval_policy import (
    compute_bucket_end_ms,
    compute_bucket_start_ms,
    parse_interval_ms,
)
from app.data_engine.storage import DEFAULT_EXCHANGE, DEFAULT_MARKET_TYPE

router = APIRouter(prefix="/klines", tags=["klines"])
logger = logging.getLogger("api.klines")

RELATED_WARMUP_INTERVALS = ("1m", "5m", "15m", "1h", "4h", "1d")


# ═══════════════════════════════════════════════════════════════
#  Helpers
# ═══════════════════════════════════════════════════════════════


def _get_data_manager(request: Request) -> Any:
    """Retrieve the DataManager from app state."""
    return getattr(request.app.state, "data_manager", None)


def _require_data_manager(request: Request) -> Any:
    dm = _get_data_manager(request)
    if dm is None:
        raise HTTPException(status_code=503, detail="DataManager 尚未初始化")
    return dm


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


def _call_data_manager_method(method: Any, *args: Any, **kwargs: Any) -> Any:
    """Call a DataManager method while tolerating older test doubles."""
    try:
        signature = inspect.signature(method)
        supports_kwargs = any(
            param.kind is inspect.Parameter.VAR_KEYWORD
            for param in signature.parameters.values()
        )
        if not supports_kwargs:
            kwargs = {
                key: value
                for key, value in kwargs.items()
                if key in signature.parameters
            }
    except (TypeError, ValueError):
        pass
    return method(*args, **kwargs)


def _last_closed_open_ms(interval: str, now_ms: int | None = None) -> int:
    """Return the latest closed bar open_time for an interval."""
    now = int(now_ms if now_ms is not None else time.time() * 1000)
    interval_ms = parse_interval_ms(interval) or 60_000
    current_open = compute_bucket_start_ms(now, interval_ms, interval=interval)
    if current_open <= 0:
        return current_open
    return compute_bucket_start_ms(current_open - 1, interval_ms, interval=interval)


def _first_expected_open_ms(start_ms: int, interval: str) -> int:
    interval_ms = parse_interval_ms(interval) or 60_000
    bucket = compute_bucket_start_ms(start_ms, interval_ms, interval=interval)
    if bucket < start_ms:
        bucket = compute_bucket_end_ms(bucket, interval_ms, interval=interval)
    return bucket


def _next_expected_open_ms(open_ms: int, interval: str) -> int:
    interval_ms = parse_interval_ms(interval) or 60_000
    return compute_bucket_end_ms(open_ms, interval_ms, interval=interval)


def _verify_range_continuity(
    *,
    data: list[dict],
    symbol: str,
    interval: str,
    exchange: str,
    market_type: str,
    start_ms: int,
    end_ms: int,
) -> dict[str, Any]:
    """Verify exact closed-bar continuity for a range returned to the chart."""
    interval_ms = parse_interval_ms(interval)
    if interval_ms is None or interval_ms <= 0 or start_ms > end_ms:
        return {
            "verified_contiguous": True,
            "missing_ranges": [],
            "expected_bars": 0,
            "actual_bars": len(data),
        }

    actual = {int(item["time"]) * 1000 for item in data if item.get("time") is not None}
    current = _first_expected_open_ms(start_ms, interval)
    missing: list[dict[str, Any]] = []
    range_start: int | None = None
    range_end: int | None = None
    range_count = 0
    expected_count = 0

    while current <= end_ms:
        expected_count += 1
        if current not in actual:
            if range_start is None:
                range_start = current
                range_count = 0
            range_end = current
            range_count += 1
        elif range_start is not None and range_end is not None:
            missing.append({
                "symbol": symbol.upper(),
                "interval": interval,
                "exchange": exchange,
                "market_type": market_type,
                "start_ms": range_start,
                "end_ms": range_end,
                "missing_bars": range_count,
                "reason": "range_verification",
                "status": "detected",
            })
            range_start = None
            range_end = None
            range_count = 0
        current = _next_expected_open_ms(current, interval)

    if range_start is not None and range_end is not None:
        missing.append({
            "symbol": symbol.upper(),
            "interval": interval,
            "exchange": exchange,
            "market_type": market_type,
            "start_ms": range_start,
            "end_ms": range_end,
            "missing_bars": range_count,
            "reason": "range_verification",
            "status": "detected",
        })

    return {
        "verified_contiguous": not missing,
        "missing_ranges": missing,
        "expected_bars": expected_count,
        "actual_bars": len(actual),
    }


def _merge_missing_ranges(*groups: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: dict[tuple[int, int], dict[str, Any]] = {}
    for group in groups:
        for item in group:
            try:
                key = (int(item["start_ms"]), int(item["end_ms"]))
            except (KeyError, TypeError, ValueError):
                continue
            existing = merged.get(key)
            if existing is None:
                merged[key] = dict(item)
                continue
            if existing.get("missing_bars") is None and item.get("missing_bars") is not None:
                existing["missing_bars"] = item["missing_bars"]
            if existing.get("reason") == "range_verification" and item.get("reason"):
                existing["reason"] = item["reason"]
    return sorted(merged.values(), key=lambda item: (item["start_ms"], item["end_ms"]))


def _related_warmup_intervals(current_interval: str, *, limit: int = 3) -> list[str]:
    if current_interval not in RELATED_WARMUP_INTERVALS:
        return []

    current_index = RELATED_WARMUP_INTERVALS.index(current_interval)
    candidates: list[tuple[int, int, str]] = []
    for index, interval in enumerate(RELATED_WARMUP_INTERVALS):
        if interval == current_interval:
            continue
        distance = abs(index - current_index)
        direction_bias = 0 if index < current_index else 1
        candidates.append((distance, direction_bias, interval))
    return [interval for _, _, interval in sorted(candidates)[:limit]]


def _schedule_related_interval_warmup(
    dm: Any,
    *,
    symbol: str,
    current_interval: str,
    start_ms: int,
    end_ms: int,
    exchange: str,
    market_type: str,
) -> None:
    request_backfill = getattr(dm, "request_backfill", None)
    if request_backfill is None:
        return

    for interval in _related_warmup_intervals(current_interval):
        try:
            _call_data_manager_method(
                request_backfill,
                symbol,
                interval,
                start_ms,
                end_ms,
                exchange,
                market_type,
                reason="related_interval_warmup",
                requester="klines_history_related",
                metadata={
                    "focus_scope": "related",
                    "current_interval": current_interval,
                    "requested_interval": interval,
                    "visible_range": {
                        "start_ms": start_ms,
                        "end_ms": end_ms,
                    },
                },
            )
        except Exception as exc:
            logger.warning(
                "Failed to schedule related warmup for %s@%s: %s",
                symbol,
                interval,
                exc,
            )


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

    dm = _require_data_manager(request)
    try:
        await dm.ensure_stream(symbol, interval, exchange=exchange, market_type=market_type)
        result = await asyncio.to_thread(
            dm.query_latest, symbol, interval, limit,
            exchange,
            market_type=market_type,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"DataManager query failed: {exc}") from exc

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

    dm = _require_data_manager(request)
    try:
        await dm.ensure_stream(symbol, interval, exchange=exchange, market_type=market_type)
        result = await asyncio.to_thread(
            _call_data_manager_method,
            dm.query_latest, symbol, interval, limit,
            exchange,
            market_type=market_type,
            auto_backfill=False,
            backfill_reason="latest_refresh",
            backfill_requester="klines_latest",
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"DataManager latest query failed: {exc}") from exc

    data = _bars_to_dicts(result.bars)
    return {
        "exchange": exchange,
        "market_type": market_type,
        "symbol": symbol.upper(),
        "interval": interval,
        "count": len(data),
        "source": result.source.value,
        "fetched": result.total,
        "backfill_triggered": result.backfill_triggered,
        "cache": result.metadata,
        "data": data,
        "base_interval": None,
    }


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

    dm = _require_data_manager(request)
    try:
        end_ms = min(int(time.time() * 1000), _last_closed_open_ms(interval))
        start_ms = end_ms - int(days * 24 * 60 * 60 * 1000)
        interval_secs = parse_custom_interval(interval) or 60
        needed_limit = int((end_ms - start_ms) / 1000 / interval_secs) + 100

        result = await asyncio.to_thread(
            _call_data_manager_method,
            dm.query,
            symbol, interval,
            start_ms=start_ms,
            end_ms=end_ms,
            limit=needed_limit,
            exchange=exchange,
            market_type=market_type,
            backfill_reason="initial_history",
            backfill_requester="klines_history",
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"DataManager history query failed: {exc}") from exc

    _schedule_related_interval_warmup(
        dm,
        symbol=symbol,
        current_interval=interval,
        start_ms=start_ms,
        end_ms=end_ms,
        exchange=exchange,
        market_type=market_type,
    )

    data = _bars_to_dicts(result.bars)
    verification = _verify_range_continuity(
        data=data,
        symbol=symbol,
        interval=interval,
        exchange=exchange,
        market_type=market_type,
        start_ms=start_ms,
        end_ms=end_ms,
    )
    missing_ranges = _merge_missing_ranges(
        [r.to_dict() for r in result.missing_ranges],
        verification["missing_ranges"],
    )
    return {
        "exchange": exchange,
        "market_type": market_type,
        "symbol": symbol.upper(),
        "interval": interval,
        "days": days,
        "start_ms": start_ms,
        "end_ms": end_ms,
        "count": len(data),
        "source": result.source.value,
        "fetched": result.total,
        "has_tail_gap": result.has_tail_gap,
        "backfill_triggered": result.backfill_triggered,
        "verified_contiguous": verification["verified_contiguous"],
        "missing_ranges": missing_ranges,
        "cache": result.metadata,
        "data": data,
        "base_interval": None,
    }


@router.get("/range")
async def get_klines_range(
    request: Request,
    symbol: str = Query("BTCUSDT", description="Trading symbol"),
    interval: str = Query("1m", description="Kline interval"),
    start_ms: int = Query(..., ge=0, description="Inclusive range start in milliseconds"),
    end_ms: int = Query(..., ge=0, description="Inclusive range end in milliseconds"),
    repair: str = Query("async", description="Repair mode: none, async, or wait"),
    wait_ms: int = Query(0, ge=0, le=5000, description="Max wait time for repair=wait"),
    strict: bool = Query(True, description="Whether caller requires continuity metadata"),
    exchange: str = Query(DEFAULT_EXCHANGE, description="Exchange, e.g. binance"),
    market_type: str = Query(DEFAULT_MARKET_TYPE, description="Market type: spot, futures, swap"),
):
    """Get K-lines for an exact time range with continuity verification."""
    _validate_interval(interval)
    if end_ms < start_ms:
        raise HTTPException(status_code=400, detail="end_ms must be >= start_ms")
    repair_mode = (repair or "async").strip().lower()
    if repair_mode not in {"none", "async", "wait"}:
        raise HTTPException(status_code=400, detail="repair must be one of: none, async, wait")

    exchange = _validate_exchange(exchange)
    market_type = _validate_market_type(market_type)
    symbol = normalize_symbol(symbol, exchange=exchange, market_type=market_type)

    now_ms = int(time.time() * 1000)
    effective_end_ms = min(end_ms, _last_closed_open_ms(interval, now_ms))
    if effective_end_ms < start_ms:
        return {
            "exchange": exchange,
            "market_type": market_type,
            "symbol": symbol.upper(),
            "interval": interval,
            "start_ms": start_ms,
            "end_ms": end_ms,
            "effective_end_ms": effective_end_ms,
            "count": 0,
            "source": "empty",
            "fetched": 0,
            "has_tail_gap": False,
            "backfill_triggered": False,
            "verified_contiguous": True,
            "renderable": True,
            "missing_ranges": [],
            "cache": {"strict": strict, "repair": repair_mode},
            "data": [],
            "base_interval": None,
        }

    interval_secs = parse_custom_interval(interval) or 60
    needed_limit = int((effective_end_ms - start_ms) / 1000 / interval_secs) + 100

    dm = _require_data_manager(request)
    try:
        result = await asyncio.to_thread(
            _call_data_manager_method,
            dm.query,
            symbol,
            interval,
            start_ms=start_ms,
            end_ms=effective_end_ms,
            limit=needed_limit,
            exchange=exchange,
            market_type=market_type,
            auto_backfill=(repair_mode != "none"),
            backfill_reason="visible_range_gap",
            backfill_requester="klines_range",
        )
        data = _bars_to_dicts(result.bars)
        verification = _verify_range_continuity(
            data=data,
            symbol=symbol,
            interval=interval,
            exchange=exchange,
            market_type=market_type,
            start_ms=start_ms,
            end_ms=effective_end_ms,
        )

        if (
            repair_mode == "wait"
            and wait_ms > 0
            and not verification["verified_contiguous"]
            and result.backfill_triggered
        ):
            await asyncio.sleep(wait_ms / 1000)
            result = await asyncio.to_thread(
                _call_data_manager_method,
                dm.query,
                symbol,
                interval,
                start_ms=start_ms,
                end_ms=effective_end_ms,
                limit=needed_limit,
                exchange=exchange,
                market_type=market_type,
                auto_backfill=(repair_mode != "none"),
                backfill_reason="visible_range_gap",
                backfill_requester="klines_range",
            )
            data = _bars_to_dicts(result.bars)
            verification = _verify_range_continuity(
                data=data,
                symbol=symbol,
                interval=interval,
                exchange=exchange,
                market_type=market_type,
                start_ms=start_ms,
                end_ms=effective_end_ms,
            )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"DataManager range query failed: {exc}") from exc

    missing_ranges = _merge_missing_ranges(
        [r.to_dict() for r in result.missing_ranges],
        verification["missing_ranges"],
    )
    verified = verification["verified_contiguous"]
    return {
        "exchange": exchange,
        "market_type": market_type,
        "symbol": symbol.upper(),
        "interval": interval,
        "start_ms": start_ms,
        "end_ms": end_ms,
        "effective_end_ms": effective_end_ms,
        "count": len(data),
        "source": result.source.value,
        "fetched": result.total,
        "has_tail_gap": result.has_tail_gap,
        "backfill_triggered": result.backfill_triggered,
        "verified_contiguous": verified,
        "renderable": verified or not strict,
        "missing_ranges": missing_ranges,
        "expected_bars": verification["expected_bars"],
        "actual_bars": verification["actual_bars"],
        "cache": result.metadata,
        "data": data if (verified or not strict) else data,
        "base_interval": None,
    }


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

    dm = _require_data_manager(request)
    try:
        before_ms = before * 1000
        result = await asyncio.to_thread(
            _call_data_manager_method,
            dm.query_before,
            symbol, interval, before_ms, bars,
            exchange,
            market_type=market_type,
            backfill_reason="visible_load_more",
            backfill_requester="klines_history_before",
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"DataManager before query failed: {exc}") from exc

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
        "backfill_triggered": result.backfill_triggered,
        "missing_ranges": [r.to_dict() for r in result.missing_ranges],
        "cache": result.metadata,
        "data": data,
        "base_interval": None,
    }


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

    dm = _require_data_manager(request)
    try:
        meta = await asyncio.to_thread(
            dm.get_bounds, symbol, interval,
            exchange,
            market_type=market_type,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"DataManager bounds query failed: {exc}") from exc

    return {
        "exchange": exchange,
        "market_type": market_type,
        "symbol": symbol.upper(),
        "interval": interval,
        "meta": meta,
    }


@router.get("/continuity")
async def get_klines_continuity(
    request: Request,
    symbol: str = Query("BTCUSDT", description="Trading symbol"),
    interval: str = Query("1m", description="Kline interval"),
    start_ms: int | None = Query(None, ge=0, description="Inclusive scan start in milliseconds"),
    end_ms: int | None = Query(None, ge=0, description="Inclusive scan end in milliseconds"),
    limit: int = Query(50_000, ge=1, le=200_000, description="Maximum stored bars to scan"),
    exchange: str = Query(DEFAULT_EXCHANGE, description="Exchange, e.g. binance"),
    market_type: str = Query(DEFAULT_MARKET_TYPE, description="Market type: spot, futures, swap"),
):
    """Detect storage continuity gaps without triggering repair."""
    _validate_interval(interval)
    if start_ms is not None and end_ms is not None and end_ms < start_ms:
        raise HTTPException(status_code=400, detail="end_ms must be >= start_ms")
    exchange = _validate_exchange(exchange)
    market_type = _validate_market_type(market_type)
    symbol = normalize_symbol(symbol, exchange=exchange, market_type=market_type)

    dm = _require_data_manager(request)
    try:
        report = await asyncio.to_thread(
            dm.scan_storage_gaps,
            symbol,
            interval,
            start_ms=start_ms,
            end_ms=end_ms,
            exchange=exchange,
            market_type=market_type,
            limit=limit,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Continuity scan failed: {exc}") from exc

    return {
        **report,
        "verified_contiguous": report.get("gap_count", 0) == 0,
    }


@router.delete("/storage")
async def delete_storage_data(
    request: Request,
    symbol: str = Query(..., description="Trading symbol"),
    interval: str = Query(..., description="Kline interval"),
    start: int | None = Query(None, description="start unix timestamp (seconds)"),
    end: int | None = Query(None, description="end unix timestamp (seconds)"),
    exchange: str = Query(DEFAULT_EXCHANGE, description="Exchange, e.g. binance"),
    market_type: str = Query(DEFAULT_MARKET_TYPE, description="Market type: spot, futures, swap"),
):
    """Delete stored K-line data for a symbol/interval range."""
    _validate_interval(interval)
    exchange = _validate_exchange(exchange)
    market_type = _validate_market_type(market_type)
    symbol = normalize_symbol(symbol, exchange=exchange, market_type=market_type)
    dm = _require_data_manager(request)
    try:
        deleted = await dm.delete_storage_data(
            symbol=symbol,
            interval=interval,
            start_ms=start * 1000 if start is not None else None,
            end_ms=end * 1000 if end is not None else None,
            exchange=exchange,
            market_type=market_type,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Storage delete failed: {exc}") from exc

    return {
        "exchange": exchange,
        "market_type": market_type,
        "symbol": symbol.upper(),
        "interval": interval,
        "deleted": deleted,
    }


def _calculate_sma_values(rows: list[dict], period: int) -> list[dict]:
    values: list[dict] = []
    closes: list[float] = []
    for row in rows:
        closes.append(float(row["close"]))
        if len(closes) < period:
            continue
        window = closes[-period:]
        values.append({
            "time": int(row["time"]),
            "value": round(sum(window) / period, 8),
        })
    return values


@router.get("/indicators/sma")
async def get_sma(
    request: Request,
    symbol: str = Query("BTCUSDT", description="Trading symbol"),
    interval: str = Query("1h", description="Kline interval"),
    period: int = Query(20, ge=2, le=500),
    start: int | None = Query(None, description="start unix timestamp (seconds)"),
    end: int | None = Query(None, description="end unix timestamp (seconds)"),
    exchange: str = Query(DEFAULT_EXCHANGE, description="Exchange, e.g. binance"),
    market_type: str = Query(DEFAULT_MARKET_TYPE, description="Market type: spot, futures, swap"),
):
    """Calculate SMA indicator values from DataManager query results."""
    _validate_interval(interval)
    exchange = _validate_exchange(exchange)
    market_type = _validate_market_type(market_type)
    symbol = normalize_symbol(symbol, exchange=exchange, market_type=market_type)
    dm = _require_data_manager(request)

    try:
        if start is not None or end is not None:
            result = await asyncio.to_thread(
                dm.query,
                symbol,
                interval,
                start_ms=start * 1000 if start is not None else None,
                end_ms=end * 1000 if end is not None else None,
                limit=5000,
                exchange=exchange,
                market_type=market_type,
            )
        else:
            result = await asyncio.to_thread(
                dm.query_latest,
                symbol,
                interval,
                max(period * 5, 500),
                exchange,
                market_type=market_type,
            )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"SMA query failed: {exc}") from exc

    data = _calculate_sma_values(_bars_to_dicts(result.bars), period)
    return {
        "exchange": exchange,
        "market_type": market_type,
        "symbol": symbol.upper(),
        "interval": interval,
        "period": period,
        "count": len(data),
        "data": data,
    }
