"""HTTP surface for append-only aggregate trades and TradeFlow rollups."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request

from app.data_engine.market_data.models import MarketChannel, MarketStreamKey
from app.data_engine.public_market_projection import (
    project_trade_history_payload,
    project_trade_recent_payload,
    serialize_public_value,
)


router = APIRouter(prefix="/trade-flow", tags=["trade-flow"])


@router.get("/recent")
async def trade_flow_recent(
    request: Request,
    symbol: str = Query("BTCUSDT"),
    exchange: str = Query("binance"),
    market_type: str = Query("futures"),
    limit: int = Query(default=500, ge=1, le=5000),
) -> dict[str, Any]:
    dm = _data_manager(request)
    key = _key(exchange, market_type, symbol)
    try:
        records = dm.trade_flow_recent(key, limit=limit)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        raise _upstream_http_error("trade-flow recent", exc) from exc
    return project_trade_recent_payload(key, list(records))


@router.get("/history")
async def trade_flow_history(
    request: Request,
    symbol: str = Query("BTCUSDT"),
    exchange: str = Query("binance"),
    market_type: str = Query("futures"),
    period: str = Query(default="1m"),
    start_ms: int | None = Query(default=None, ge=0),
    end_ms: int | None = Query(default=None, ge=0),
    limit: int = Query(default=500, ge=1, le=5000),
) -> dict[str, Any]:
    if period != "1m":
        raise HTTPException(
            status_code=422,
            detail="TradeFlow history only supports period=1m",
        )
    if start_ms is not None and end_ms is not None and start_ms > end_ms:
        raise HTTPException(status_code=422, detail="start_ms must be <= end_ms")
    dm = _data_manager(request)
    key = _key(exchange, market_type, symbol)
    try:
        rows = await dm.trade_flow_history(
            key,
            start_ms=start_ms,
            end_ms=end_ms,
            limit=limit,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        raise _upstream_http_error("trade-flow history", exc) from exc
    return project_trade_history_payload(key, list(rows), limit=limit)


@router.get("/archive/coverage")
async def trade_flow_archive_coverage(
    request: Request,
    symbol: str = Query("BTCUSDT"),
    exchange: str = Query("binance"),
    market_type: str = Query("futures"),
    start_time_ms: int | None = Query(default=None, ge=0),
    end_time_ms: int | None = Query(default=None, ge=0),
    expected_start_agg_trade_id: int | None = Query(default=None, ge=0),
    expected_end_agg_trade_id: int | None = Query(default=None, ge=0),
) -> dict[str, Any]:
    if (
        start_time_ms is not None
        and end_time_ms is not None
        and start_time_ms > end_time_ms
    ):
        raise HTTPException(status_code=422, detail="start_time_ms must be <= end_time_ms")
    dm = _data_manager(request)
    key = _key(exchange, market_type, symbol)
    try:
        coverage = await dm.trade_flow_archive_coverage(
            key,
            start_time_ms=start_time_ms,
            end_time_ms=end_time_ms,
            expected_start_agg_trade_id=expected_start_agg_trade_id,
            expected_end_agg_trade_id=expected_end_agg_trade_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        raise _upstream_http_error("trade-flow archive coverage", exc) from exc
    return {
        "type": "trade_flow.archive_coverage",
        "protocol": "tradeflow.v1",
        "key": key.to_dict(),
        "data": serialize_public_value(coverage),
    }


def _data_manager(request: Request) -> Any:
    dm = getattr(request.app.state, "data_manager", None)
    if dm is None:
        raise HTTPException(status_code=503, detail="DataManager not initialized")
    if not getattr(dm, "trade_flow_ready", False):
        raise HTTPException(status_code=503, detail="TradeFlow is not initialized")
    return dm


def _key(exchange: str, market_type: str, symbol: str) -> MarketStreamKey:
    try:
        return MarketStreamKey.build(
            exchange,
            market_type,
            symbol,
            MarketChannel.AGG_TRADE,
        )
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


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
