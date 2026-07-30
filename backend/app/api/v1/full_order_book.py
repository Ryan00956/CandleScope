"""HTTP snapshot surface for sequence-consistent reconstructed order books."""

from __future__ import annotations

import asyncio
import logging
import time
from collections import OrderedDict
from contextlib import suppress
from decimal import Decimal
from threading import RLock
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from starlette.background import BackgroundTask

from app.api.v1.order_book_projection import (
    PriceGrouping,
    cached_price_tick_size,
    normalize_price_grouping,
    project_order_book_levels,
)
from app.data_engine.market_data.models import MarketChannel, MarketStreamKey
from app.data_engine.market_data.full_order_book_service import FullOrderBookRateLimited


PROTOCOL = "orderbook.full.v1"
UPSTREAM_SNAPSHOT_LIMIT = 1_000
ALLOWED_UPDATE_INTERVALS_BY_MARKET = {
    "spot": frozenset({100, 1000}),
    "futures": frozenset({100, 250, 500}),
}
DEFAULT_UPDATE_INTERVAL_MS_BY_MARKET = {"spot": 1000, "futures": 250}
ALLOWED_UPDATE_INTERVALS_MS = frozenset().union(
    *ALLOWED_UPDATE_INTERVALS_BY_MARKET.values(),
)
MAX_OUTPUT_LEVELS = 1_000

router = APIRouter(prefix="/full-order-book", tags=["full-order-book"])
logger = logging.getLogger("api.full_order_book")

_SERIALIZATION_CACHE_MAX_ENTRIES = 128
_serialization_cache: OrderedDict[
    tuple[Any, ...],
    tuple[Any, dict[str, Any]],
] = OrderedDict()
_serialization_cache_lock = RLock()
_serialization_build_lock = RLock()
_serialization_cache_hits = 0
_serialization_cache_misses = 0
_serialization_cache_evictions = 0


@router.get("/snapshot")
async def full_order_book_snapshot(
    request: Request,
    symbol: str = Query("BTCUSDT"),
    exchange: str = Query("binance"),
    market_type: str = Query("futures"),
    update_interval_ms: int | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=MAX_OUTPUT_LEVELS),
    price_grouping: str = Query(default="raw"),
    wait_ms: int = Query(default=5_000, ge=100, le=15_000),
) -> Any:
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
    except FullOrderBookRateLimited as exc:
        retry_after_seconds = max(
            1,
            (exc.retry_at_ms - int(time.time() * 1000) + 999) // 1000,
        )
        background = None
        if leased:
            leased = False
            # Send the bounded 429 before waiting for the last HTTP lease to
            # stop a physical WebSocket. Starlette runs this managed cleanup
            # after the response body has been emitted.
            background = BackgroundTask(
                _release_http_lease,
                dm,
                key,
                consumer_id,
            )
        return JSONResponse(
            status_code=429,
            content={
                "detail": {
                    "code": "upstream_rate_limited",
                    "message": "full order-book upstream is temporarily rate limited",
                    "retry_at_ms": exc.retry_at_ms,
                    "bucket_key": exc.bucket_key,
                },
            },
            headers={"Retry-After": str(retry_after_seconds)},
            background=background,
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
        "data": await serialize_record_async(
            record,
            limit=limit,
            price_grouping=grouping,
            price_tick_size=price_tick_size,
        ),
    }


async def _release_http_lease(
    dm: Any,
    key: MarketStreamKey,
    consumer_id: str,
) -> None:
    try:
        released = await dm.release_full_order_book_stream(
            key,
            consumer_id=consumer_id,
        )
        if not released:
            logger.warning("Full order-book HTTP lease could not be fully released")
    except Exception:
        logger.exception("Full order-book HTTP lease background release failed")


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
    update_interval_ms: int | None,
) -> MarketStreamKey:
    exchange_name = str(exchange).strip().lower()
    market = str(market_type).strip().lower()
    if exchange_name != "binance" or market not in ALLOWED_UPDATE_INTERVALS_BY_MARKET:
        raise HTTPException(
            status_code=422,
            detail="full order books currently support binance spot and futures only",
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
            MarketChannel.FULL_DEPTH,
            params={
                "mode": "full",
                "snapshot_limit": UPSTREAM_SNAPSHOT_LIMIT,
                "update_interval_ms": resolved_interval_ms,
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
    """Serialize and share one projection per immutable hub revision/options."""

    # Decimal aggregation is CPU-bound and may materialize a complete lazy
    # source.  A build lock provides cross-client single-flight semantics for
    # the same immutable records; async transports call this function in a
    # worker thread so the event loop never pays that cost.
    with _serialization_build_lock:
        return _serialize_record_locked(
            record,
            limit=limit,
            price_grouping=price_grouping,
            price_tick_size=price_tick_size,
        )


async def serialize_record_async(
    record: Any,
    *,
    limit: int,
    price_grouping: PriceGrouping = "raw",
    price_tick_size: Decimal | None = None,
) -> dict[str, Any]:
    return await asyncio.to_thread(
        serialize_record,
        record,
        limit=limit,
        price_grouping=price_grouping,
        price_tick_size=price_tick_size,
    )


def _serialize_record_locked(
    record: Any,
    *,
    limit: int,
    price_grouping: PriceGrouping,
    price_tick_size: Decimal | None,
) -> dict[str, Any]:

    cache_key = _serialization_cache_key(
        record,
        limit=limit,
        price_grouping=price_grouping,
        price_tick_size=price_tick_size,
    )
    cached = _serialization_cache_get(cache_key, record)
    if cached is not None:
        return _copy_serialized_envelope(cached)

    to_dict = getattr(record, "to_dict", None)
    if not callable(to_dict):
        raise TypeError("full order-book service returned an unsupported snapshot value")
    payload = dict(to_dict())
    data = payload.get("data")
    if isinstance(data, dict):
        projected = dict(data)
        source_levels_canonical = (
            projected.pop("_canonical_level_order", False) is True
        )
        projection = project_order_book_levels(
            projected,
            price_grouping=price_grouping,
            price_tick_size=price_tick_size,
            limit=limit,
            omit_incomplete_outer_bucket=(
                projected.get("exchange_full_depth_exhaustive") is False
            ),
            source_levels_canonical=source_levels_canonical,
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
    _serialization_cache_put(cache_key, record, payload)
    return _copy_serialized_envelope(payload)


def full_order_book_projection_cache_info() -> dict[str, int]:
    """Expose bounded-cache counters for diagnostics and regression tests."""

    with _serialization_cache_lock:
        return {
            "entries": len(_serialization_cache),
            "max_entries": _SERIALIZATION_CACHE_MAX_ENTRIES,
            "hits": _serialization_cache_hits,
            "misses": _serialization_cache_misses,
            "evictions": _serialization_cache_evictions,
        }


def clear_full_order_book_projection_cache() -> None:
    global _serialization_cache_hits
    global _serialization_cache_misses
    global _serialization_cache_evictions

    with _serialization_cache_lock:
        _serialization_cache.clear()
        _serialization_cache_hits = 0
        _serialization_cache_misses = 0
        _serialization_cache_evictions = 0


def _serialization_cache_key(
    record: Any,
    *,
    limit: int,
    price_grouping: PriceGrouping,
    price_tick_size: Decimal | None,
) -> tuple[Any, ...] | None:
    event = getattr(record, "event", None)
    key = getattr(event, "key", None)
    if event is None or key is None or getattr(record, "revision", None) is None:
        return None
    try:
        hash(key)
    except TypeError:
        return None
    return (
        key,
        int(limit),
        price_grouping,
        str(price_tick_size) if price_tick_size is not None else None,
    )


def _serialization_cache_get(
    cache_key: tuple[Any, ...] | None,
    record: Any,
) -> dict[str, Any] | None:
    global _serialization_cache_hits
    global _serialization_cache_misses

    if cache_key is None:
        return None
    with _serialization_cache_lock:
        entry = _serialization_cache.get(cache_key)
        if entry is None or entry[0] is not record:
            _serialization_cache_misses += 1
            return None
        _serialization_cache.move_to_end(cache_key)
        _serialization_cache_hits += 1
        return entry[1]


def _serialization_cache_put(
    cache_key: tuple[Any, ...] | None,
    record: Any,
    payload: dict[str, Any],
) -> None:
    global _serialization_cache_evictions

    if cache_key is None:
        return
    with _serialization_cache_lock:
        # Projection payloads retain the HubRecord and its potentially large
        # lazy book revision.  Keep all option variants for the current record,
        # but do not let variants from older revisions of the same stream build
        # up until the global LRU limit is reached.
        stream_key = cache_key[0]
        stale_keys = [
            existing_key
            for existing_key, (
                existing_record,
                _existing_payload,
            ) in _serialization_cache.items()
            if existing_key[0] == stream_key and existing_record is not record
        ]
        for stale_key in stale_keys:
            del _serialization_cache[stale_key]
            _serialization_cache_evictions += 1
        _serialization_cache[cache_key] = (record, payload)
        _serialization_cache.move_to_end(cache_key)
        while len(_serialization_cache) > _SERIALIZATION_CACHE_MAX_ENTRIES:
            _serialization_cache.popitem(last=False)
            _serialization_cache_evictions += 1


def _copy_serialized_envelope(payload: dict[str, Any]) -> dict[str, Any]:
    # Callers add transport envelopes but never mutate level rows.  Copy the
    # two mapping layers while sharing the expensive immutable-by-convention
    # projection arrays between clients of the same hub revision.
    copied = dict(payload)
    data = copied.get("data")
    if isinstance(data, dict):
        copied["data"] = dict(data)
    return copied


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
    "clear_full_order_book_projection_cache",
    "full_order_book_projection_cache_info",
    "full_order_book_key",
    "router",
    "serialize_record",
    "serialize_record_async",
]
