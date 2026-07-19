"""HTTP snapshot surface for Partial Top-N order books."""

from __future__ import annotations

import asyncio
import logging
from contextlib import suppress
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request

from app.api.v1.order_book_projection import (
    cached_price_tick_size,
    project_order_book_levels,
)
from app.data_engine.market_data.models import MarketChannel, MarketStreamKey


PROTOCOL = "orderbook.v1"
ALLOWED_DEPTH_LEVELS = frozenset({5, 10, 20})
ALLOWED_UPDATE_INTERVALS_BY_MARKET = {
    "spot": frozenset({100, 1000}),
    "futures": frozenset({100, 250, 500}),
}
DEFAULT_UPDATE_INTERVAL_MS_BY_MARKET = {"spot": 1000, "futures": 250}
ALLOWED_UPDATE_INTERVALS_MS = frozenset().union(
    *ALLOWED_UPDATE_INTERVALS_BY_MARKET.values(),
)

router = APIRouter(prefix="/order-book", tags=["order-book"])
logger = logging.getLogger("api.order_book")


@router.get("/snapshot")
async def order_book_snapshot(
    request: Request,
    symbol: str = Query("BTCUSDT"),
    exchange: str = Query("binance"),
    market_type: str = Query("futures"),
    depth_levels: int = Query(default=20),
    update_interval_ms: int | None = Query(default=None),
    wait_ms: int = Query(default=2_000, ge=100, le=5_000),
) -> dict[str, Any]:
    """Return a fresh replaceable partial-book snapshot.

    A short-lived logical lease is used so the endpoint also works when no
    browser currently owns the physical stream.  It is always released after
    the first snapshot arrives (or the bounded wait expires).
    """

    dm = _data_manager(request)
    key = _key(
        exchange=exchange,
        market_type=market_type,
        symbol=symbol,
        depth_levels=depth_levels,
        update_interval_ms=update_interval_ms,
    )
    consumer_id = f"http:order-book:{id(request)}"
    leased = False
    try:
        await dm.ensure_order_book_stream(key, consumer_id=consumer_id)
        leased = True
        record = await dm.wait_for_order_book_snapshot(
            key,
            timeout_seconds=wait_ms / 1000,
        )
    except asyncio.TimeoutError as exc:
        raise HTTPException(
            status_code=504,
            detail="order-book snapshot did not arrive before the bounded wait expired",
        ) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        logger.warning("Order-book snapshot is unavailable: %s", exc)
        raise HTTPException(
            status_code=503,
            detail="order-book snapshot is temporarily unavailable",
        ) from exc
    except Exception as exc:
        logger.warning("Order-book snapshot failed: %s", exc)
        raise HTTPException(
            status_code=502,
            detail="order-book upstream is temporarily unavailable",
        ) from exc
    finally:
        if leased:
            with suppress(Exception):
                released = await dm.release_order_book_stream(
                    key,
                    consumer_id=consumer_id,
                )
                if not released:
                    logger.warning("Order-book HTTP lease could not be fully released")

    return {
        "type": "order_book.snapshot",
        "protocol": PROTOCOL,
        "delivery": "latest_snapshot",
        "full_depth": False,
        "backfillable": False,
        "persisted": False,
        "data": serialize_record(record, price_tick_size=cached_price_tick_size(key)),
    }


def _data_manager(request: Request) -> Any:
    dm = getattr(request.app.state, "data_manager", None)
    if dm is None:
        raise HTTPException(status_code=503, detail="DataManager not initialized")
    if not getattr(dm, "order_book_ready", False):
        raise HTTPException(status_code=503, detail="Order-book service is not initialized")
    return dm


def _key(
    *,
    exchange: str,
    market_type: str,
    symbol: str,
    depth_levels: int,
    update_interval_ms: int | None,
) -> MarketStreamKey:
    exchange_name = str(exchange).strip().lower()
    market = str(market_type).strip().lower()
    if exchange_name != "binance" or market not in ALLOWED_UPDATE_INTERVALS_BY_MARKET:
        raise HTTPException(
            status_code=422,
            detail="partial order books currently support binance spot and futures only",
        )
    if depth_levels not in ALLOWED_DEPTH_LEVELS:
        raise HTTPException(
            status_code=422,
            detail="depth_levels must be one of 5, 10, or 20",
        )
    resolved_interval_ms = (
        DEFAULT_UPDATE_INTERVAL_MS_BY_MARKET[market]
        if update_interval_ms is None
        else update_interval_ms
    )
    allowed_intervals = ALLOWED_UPDATE_INTERVALS_BY_MARKET[market]
    if resolved_interval_ms not in allowed_intervals:
        supported = ", ".join(str(value) for value in sorted(allowed_intervals))
        raise HTTPException(
            status_code=422,
            detail=f"binance {market} update_interval_ms must be one of {supported}",
        )
    try:
        return MarketStreamKey.build(
            exchange_name,
            market,
            symbol,
            MarketChannel.DEPTH,
            params={
                "mode": "partial",
                "depth_levels": depth_levels,
                "update_interval_ms": resolved_interval_ms,
            },
        )
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def serialize_record(
    record: Any,
    *,
    price_tick_size: Decimal | None = None,
) -> dict[str, Any]:
    to_dict = getattr(record, "to_dict", None)
    if not callable(to_dict):
        raise TypeError("order-book service returned an unsupported snapshot value")
    payload = dict(to_dict())
    data = payload.get("data")
    if isinstance(data, dict):
        projected = dict(data)
        projection = project_order_book_levels(
            projected,
            price_grouping="raw",
            price_tick_size=price_tick_size,
        )
        projected["bids"] = projection.bids
        projected["asks"] = projection.asks
        projected["price_tick_size"] = projection.price_tick_size
        projected["price_step"] = projection.price_step
        projected["price_grouping"] = "raw"
        projected["aggregation_applied"] = False
        payload["data"] = projected
    return payload


__all__ = ["router", "serialize_record"]
