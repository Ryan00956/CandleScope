"""HTTP snapshot surface for sequence-consistent reconstructed order books."""

from __future__ import annotations

import asyncio
import logging
from contextlib import suppress
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request

from app.api.v1.order_book_projection import (
    PriceGrouping,
    cached_price_tick_size,
    normalize_price_grouping,
    project_order_book_levels,
)
from app.data_engine.market_data.models import MarketChannel, MarketStreamKey


PROTOCOL = "orderbook.full.v1"
UPSTREAM_SNAPSHOT_LIMIT = 1_000
ALLOWED_UPDATE_INTERVALS_MS = frozenset({100, 250, 500})
MAX_OUTPUT_LEVELS = 1_000

router = APIRouter(prefix="/full-order-book", tags=["full-order-book"])
logger = logging.getLogger("api.full_order_book")


@router.get("/snapshot")
async def full_order_book_snapshot(
    request: Request,
    symbol: str = Query("BTCUSDT"),
    exchange: str = Query("binance"),
    market_type: str = Query("futures"),
    update_interval_ms: int = Query(default=250),
    limit: int = Query(default=100, ge=1, le=MAX_OUTPUT_LEVELS),
    price_grouping: str = Query(default="raw"),
    wait_ms: int = Query(default=5_000, ge=100, le=15_000),
) -> dict[str, Any]:
    """Return one live atomic projection of the locally reconstructed book."""

    dm = _data_manager(request)
    key = full_order_book_key(
        exchange=exchange,
        market_type=market_type,
        symbol=symbol,
        update_interval_ms=update_interval_ms,
    )
    try:
        grouping = normalize_price_grouping(price_grouping)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    price_tick_size = cached_price_tick_size(key)
    consumer_id = f"http:full-order-book:{id(request)}"
    leased = False
    try:
        await dm.ensure_full_order_book_stream(key, consumer_id=consumer_id)
        leased = True
        record = await dm.wait_for_full_order_book_snapshot(
            key,
            timeout_seconds=wait_ms / 1000,
        )
    except asyncio.TimeoutError as exc:
        raise HTTPException(
            status_code=504,
            detail="full order-book synchronization did not finish before the bounded wait expired",
        ) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        logger.warning("Full order-book snapshot is unavailable: %s", exc)
        raise HTTPException(
            status_code=503,
            detail="full order-book snapshot is temporarily unavailable",
        ) from exc
    except Exception as exc:
        logger.warning("Full order-book snapshot failed: %s", exc)
        raise HTTPException(
            status_code=502,
            detail="full order-book upstream is temporarily unavailable",
        ) from exc
    finally:
        if leased:
            with suppress(Exception):
                released = await dm.release_full_order_book_stream(
                    key,
                    consumer_id=consumer_id,
                )
                if not released:
                    logger.warning("Full order-book HTTP lease could not be fully released")

    return {
        "type": "full_order_book.snapshot",
        "protocol": PROTOCOL,
        **contract_metadata(output_limit=limit),
        "price_grouping": grouping,
        "data": serialize_record(
            record,
            limit=limit,
            price_grouping=grouping,
            price_tick_size=price_tick_size,
        ),
    }


def _data_manager(request: Request) -> Any:
    dm = getattr(request.app.state, "data_manager", None)
    if dm is None:
        raise HTTPException(status_code=503, detail="DataManager not initialized")
    if not getattr(dm, "full_order_book_ready", False):
        raise HTTPException(
            status_code=503,
            detail="Full order-book service is not initialized",
        )
    return dm


def full_order_book_key(
    *,
    exchange: str,
    market_type: str,
    symbol: str,
    update_interval_ms: int,
) -> MarketStreamKey:
    exchange_name = str(exchange).strip().lower()
    market = str(market_type).strip().lower()
    if exchange_name != "binance" or market != "futures":
        raise HTTPException(
            status_code=422,
            detail="full order books currently support binance futures only",
        )
    if update_interval_ms not in ALLOWED_UPDATE_INTERVALS_MS:
        raise HTTPException(
            status_code=422,
            detail="update_interval_ms must be one of 100, 250, or 500",
        )
    try:
        return MarketStreamKey.build(
            exchange_name,
            market,
            symbol,
            MarketChannel.FULL_DEPTH,
            params={
                "mode": "full",
                "snapshot_limit": UPSTREAM_SNAPSHOT_LIMIT,
                "update_interval_ms": update_interval_ms,
            },
        )
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def serialize_record(
    record: Any,
    *,
    limit: int,
    price_grouping: PriceGrouping = "raw",
    price_tick_size: Decimal | None = None,
) -> dict[str, Any]:
    """Serialize a hub record, group its full projection, then clip visible rows."""

    to_dict = getattr(record, "to_dict", None)
    if not callable(to_dict):
        raise TypeError("full order-book service returned an unsupported snapshot value")
    payload = dict(to_dict())
    data = payload.get("data")
    if isinstance(data, dict):
        projected = dict(data)
        projection = project_order_book_levels(
            projected,
            price_grouping=price_grouping,
            price_tick_size=price_tick_size,
            limit=limit,
            omit_incomplete_outer_bucket=(
                projected.get("exchange_full_depth_exhaustive") is False
            ),
        )
        projected["bids"] = projection.bids
        projected["asks"] = projection.asks
        projected["price_tick_size"] = projection.price_tick_size
        projected["price_step"] = projection.price_step
        projected["price_grouping"] = projection.price_grouping
        projected["aggregation_applied"] = projection.aggregation_applied
        projected["aggregation_source_bid_levels"] = projection.source_bid_levels
        projected["aggregation_source_ask_levels"] = projection.source_ask_levels
        projected["bucket_bid_levels"] = projection.bucket_bid_levels
        projected["bucket_ask_levels"] = projection.bucket_ask_levels
        projected["price_window_bid_truncated"] = projection.price_window_bid_truncated
        projected["price_window_ask_truncated"] = projection.price_window_ask_truncated
        projected["incomplete_outer_bid_bucket_omitted"] = (
            projection.incomplete_outer_bid_bucket_omitted
        )
        projected["incomplete_outer_ask_bucket_omitted"] = (
            projection.incomplete_outer_ask_bucket_omitted
        )
        if projected.get("live") is True:
            bid_count = projected.get("book_bid_levels")
            ask_count = projected.get("book_ask_levels")
            source_complete = (
                isinstance(bid_count, int)
                and not isinstance(bid_count, bool)
                and isinstance(ask_count, int)
                and not isinstance(ask_count, bool)
                and projection.source_bid_levels >= bid_count
                and projection.source_ask_levels >= ask_count
            )
            full_projection = (
                source_complete
                and not projection.price_window_bid_truncated
                and not projection.price_window_ask_truncated
                and not projection.incomplete_outer_bid_bucket_omitted
                and not projection.incomplete_outer_ask_bucket_omitted
                and len(projection.bids) >= projection.bucket_bid_levels
                and len(projection.asks) >= projection.bucket_ask_levels
            )
            projected["aggregation_source_complete"] = source_complete
            projected["projection_depth"] = None if full_projection else limit
            projected["full_projection"] = full_projection
        projected["output_limit"] = limit
        payload["data"] = projected
    return payload


def contract_metadata(*, output_limit: int) -> dict[str, Any]:
    return {
        "delivery": "atomic_snapshot",
        "source_delivery": "ordered_delta",
        "snapshot_replaceable": True,
        "backend_sequence_continuity": True,
        "fail_closed_on_gap": True,
        "upstream_snapshot_limit": UPSTREAM_SNAPSHOT_LIMIT,
        "output_limit": output_limit,
        "backfillable": False,
        "persisted": False,
    }


__all__ = [
    "ALLOWED_UPDATE_INTERVALS_MS",
    "MAX_OUTPUT_LEVELS",
    "PROTOCOL",
    "UPSTREAM_SNAPSHOT_LIMIT",
    "contract_metadata",
    "full_order_book_key",
    "router",
    "serialize_record",
]
