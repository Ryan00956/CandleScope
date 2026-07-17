"""HTTP surface for observed public-liquidation events and local rollups."""

from __future__ import annotations

from dataclasses import asdict, is_dataclass
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request

from app.data_engine.market_data.models import MarketChannel, MarketStreamKey


PROTOCOL = "liquidation.v1"
SOURCE_QUALITY = "sampled_best_effort"

router = APIRouter(prefix="/liquidations", tags=["liquidations"])


@router.get("/recent")
async def liquidation_recent(
    request: Request,
    symbol: str = Query("BTCUSDT"),
    exchange: str = Query("binance"),
    market_type: str = Query("futures"),
    limit: int = Query(default=500, ge=1, le=5000),
) -> dict[str, Any]:
    dm = _data_manager(request)
    key = _key(exchange, market_type, symbol)
    try:
        records = dm.liquidation_recent(key, limit=limit)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        raise _upstream_http_error("liquidation recent", exc) from exc
    data = [_serialize(item) for item in records]
    times = [int(item["trade_time_ms"]) for item in data]
    return {
        "type": "liquidation.recent",
        "protocol": PROTOCOL,
        "key": key.to_dict(),
        "count": len(data),
        "data": data,
        "coverage": {
            "earliest_ms": min(times, default=None),
            "latest_ms": max(times, default=None),
            "bounded": True,
            "observed_only": True,
        },
        **_quality_metadata(),
    }


@router.get("/history")
async def liquidation_history(
    request: Request,
    symbol: str = Query("BTCUSDT"),
    exchange: str = Query("binance"),
    market_type: str = Query("futures"),
    period: str = Query(default="1m"),
    position_side: str | None = Query(default=None),
    start_ms: int | None = Query(default=None, ge=0),
    end_ms: int | None = Query(default=None, ge=0),
    limit: int = Query(default=500, ge=1, le=5000),
) -> dict[str, Any]:
    if period != "1m":
        raise HTTPException(
            status_code=422,
            detail="liquidation history only supports period=1m",
        )
    side = _position_side(position_side)
    if start_ms is not None and end_ms is not None and start_ms > end_ms:
        raise HTTPException(status_code=422, detail="start_ms must be <= end_ms")
    dm = _data_manager(request)
    key = _key(exchange, market_type, symbol)
    try:
        rows = await dm.liquidation_history(
            key,
            position_side=side,
            start_ms=start_ms,
            end_ms=end_ms,
            limit=limit + 1,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        raise _upstream_http_error("liquidation history", exc) from exc
    has_more = len(rows) > limit
    if has_more:
        rows = rows[-limit:] if start_ms is None and end_ms is None else rows[:limit]
    data = [_serialize(item) for item in rows]
    times = [
        int(item.get("bucket_start_ms", item.get("bucket_open_ms")))
        for item in data
    ]
    params: dict[str, str] = {"period": "1m"}
    if side is not None:
        params["position_side"] = side
    return {
        "type": "liquidation.history",
        "protocol": PROTOCOL,
        "key": {**key.to_dict(), "params": params},
        "count": len(data),
        "data": data,
        "has_more": has_more,
        "coverage": {
            "earliest_ms": min(times, default=None),
            "latest_ms": max(times, default=None),
            "all_rows_final": bool(data)
            and all(bool(item.get("is_final", False)) for item in data),
            "observed_only": True,
        },
        **_quality_metadata(),
    }


def _quality_metadata() -> dict[str, Any]:
    return {
        "source_quality": SOURCE_QUALITY,
        "source_exhaustive": False,
        "sampling_mode": "latest_per_symbol_1000ms",
        "lossy_snapshot": True,
        "backfillable": False,
        "exchange_update_interval_ms": 1000,
    }


def _data_manager(request: Request) -> Any:
    dm = getattr(request.app.state, "data_manager", None)
    if dm is None:
        raise HTTPException(status_code=503, detail="DataManager not initialized")
    if not getattr(dm, "liquidation_ready", False):
        raise HTTPException(status_code=503, detail="Liquidation service is not initialized")
    return dm


def _key(exchange: str, market_type: str, symbol: str) -> MarketStreamKey:
    try:
        return MarketStreamKey.build(
            exchange,
            market_type,
            symbol,
            MarketChannel.LIQUIDATION,
        )
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _position_side(value: str | None) -> str | None:
    if value is None or not value.strip():
        return None
    normalized = value.strip().lower()
    if normalized not in {"long", "short"}:
        raise HTTPException(
            status_code=422,
            detail="position_side must be 'long' or 'short'",
        )
    return normalized


def _serialize(value: Any) -> dict[str, Any]:
    to_dict = getattr(value, "to_dict", None)
    if callable(to_dict):
        return dict(to_dict())
    if is_dataclass(value):
        return asdict(value)
    if isinstance(value, dict):
        return dict(value)
    raise TypeError(f"unsupported liquidation response value: {type(value).__name__}")


def _upstream_http_error(operation: str, exc: Exception) -> HTTPException:
    status_code = getattr(exc, "status_code", None)
    if status_code in {418, 429}:
        retry_after = getattr(exc, "retry_after", None)
        headers = {"Retry-After": str(retry_after)} if retry_after is not None else None
        return HTTPException(
            status_code=429,
            detail=f"{operation} is temporarily rate limited upstream",
            headers=headers,
        )
    return HTTPException(
        status_code=502,
        detail=f"{operation} is temporarily unavailable",
    )


__all__ = ["router"]
