"""HTTP snapshot surface for sequence-consistent reconstructed order books."""

from __future__ import annotations

import asyncio
import logging
from contextlib import suppress
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request

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
        "data": serialize_record(record, limit=limit),
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


def serialize_record(record: Any, *, limit: int) -> dict[str, Any]:
    """Serialize a hub record and trim only its presentation projection."""

    to_dict = getattr(record, "to_dict", None)
    if not callable(to_dict):
        raise TypeError("full order-book service returned an unsupported snapshot value")
    payload = dict(to_dict())
    data = payload.get("data")
    if isinstance(data, dict):
        projected = dict(data)
        for side in ("bids", "asks"):
            levels = projected.get(side)
            if isinstance(levels, (list, tuple)):
                projected[side] = list(levels[:limit])
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
