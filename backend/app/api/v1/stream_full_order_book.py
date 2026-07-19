"""WebSocket delivery for backend-reconstructed full order books."""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from fastapi import HTTPException, WebSocket, WebSocketDisconnect

from app.api.v1.full_order_book import (
    ALLOWED_UPDATE_INTERVALS_BY_MARKET,
    ALLOWED_UPDATE_INTERVALS_MS,
    DEFAULT_UPDATE_INTERVAL_MS_BY_MARKET,
    MAX_OUTPUT_LEVELS,
    PROTOCOL,
    UPSTREAM_SNAPSHOT_LIMIT,
    contract_metadata,
    full_order_book_key,
    serialize_record,
)
from app.api.v1.order_book_projection import (
    FULL_PRICE_GROUPINGS,
    PriceGrouping,
    cached_price_tick_size,
    normalize_price_grouping,
)
from app.api.v1.stream_utils import send_json_with_timeout, send_text_with_timeout
from app.data_engine.market_data.models import MarketChannel, MarketStreamKey


MAX_SUBSCRIPTIONS = 16
MAX_COMMAND_BYTES = 65_536

logger = logging.getLogger("api.stream_full_order_book")


@dataclass(frozen=True, slots=True)
class _RequestedStream:
    key: MarketStreamKey
    output_limit: int
    price_grouping: PriceGrouping
    price_tick_size: Decimal | None


async def stream_full_order_book(websocket: WebSocket, dm: Any) -> None:
    """Run one immutable multiplexed full-book subscription."""

    consumer_id = f"ws:full-order-book:{id(websocket)}"
    active: list[_RequestedStream] = []
    attachment: Any = None
    tasks: list[asyncio.Task[None]] = []
    send_lock = asyncio.Lock()

    async def _send_json(payload: dict[str, Any]) -> None:
        async with send_lock:
            await send_json_with_timeout(websocket, payload)

    async def _release(streams: list[_RequestedStream]) -> None:
        for requested in reversed(streams):
            try:
                released = await dm.release_full_order_book_stream(
                    requested.key,
                    consumer_id=consumer_id,
                )
                if not released:
                    logger.warning(
                        "Full order-book stream release remained incomplete: %s",
                        requested.key,
                    )
            except Exception as exc:
                logger.warning(
                    "Full order-book stream release failed for %s: %s",
                    requested.key,
                    exc,
                )

    async def _receive_command() -> dict[str, Any] | None:
        raw = await websocket.receive_text()
        if len(raw.encode("utf-8")) > MAX_COMMAND_BYTES:
            await _send_json({"type": "error", "code": "COMMAND_TOO_LARGE"})
            return None
        if raw.strip().lower() == "ping":
            async with send_lock:
                await send_text_with_timeout(websocket, "pong")
            return None
        try:
            message = json.loads(raw)
        except json.JSONDecodeError:
            await _send_json({"type": "error", "code": "INVALID_JSON"})
            return None
        if not isinstance(message, dict):
            await _send_json({"type": "error", "code": "INVALID_MESSAGE"})
            return None
        return message

    async def _subscribe() -> bool:
        nonlocal attachment
        while True:
            message = await _receive_command()
            if message is None:
                continue
            request_id = message.get("request_id")
            if str(message.get("action", "")).strip().lower() != "subscribe":
                await _send_json({
                    "type": "error",
                    "request_id": request_id,
                    "code": "SUBSCRIBE_REQUIRED",
                    "detail": "The first command must subscribe to full order-book streams",
                })
                continue
            try:
                streams = _parse_streams(message.get("streams"))
            except (TypeError, ValueError) as exc:
                await _send_json({
                    "type": "error",
                    "request_id": request_id,
                    "code": "INVALID_SUBSCRIPTION",
                    "detail": str(exc),
                })
                continue

            acquired: list[_RequestedStream] = []
            try:
                for requested in streams:
                    if await dm.ensure_full_order_book_stream(
                        requested.key,
                        consumer_id=consumer_id,
                    ):
                        acquired.append(requested)
                attachment = dm.attach_full_order_books(
                    [requested.key for requested in streams],
                    max_pending=MAX_SUBSCRIPTIONS,
                )
            except asyncio.CancelledError:
                await _release(acquired)
                raise
            except Exception as exc:
                await _release(acquired)
                detail = (
                    str(exc)
                    if isinstance(exc, ValueError)
                    else "full order-book subscription is temporarily unavailable"
                )
                if not isinstance(exc, ValueError):
                    logger.warning("Full order-book subscribe failed: %s", exc)
                await _send_json({
                    "type": "error",
                    "request_id": request_id,
                    "code": "SUBSCRIBE_FAILED",
                    "detail": detail,
                })
                continue

            active.extend(streams)
            requested_by_key = {requested.key: requested for requested in streams}
            await _send_json({
                "type": "subscribed",
                "protocol": PROTOCOL,
                "request_id": request_id,
                "streams": [
                    {
                        **requested.key.to_dict(),
                        "output_limit": requested.output_limit,
                        "price_grouping": requested.price_grouping,
                        "price_tick_size": (
                            float(requested.price_tick_size)
                            if requested.price_tick_size is not None
                            else None
                        ),
                    }
                    for requested in streams
                ],
                **contract_metadata(
                    output_limit=max(item.output_limit for item in streams),
                ),
            })
            await _send_json({
                "type": "snapshot",
                "protocol": PROTOCOL,
                "request_id": request_id,
                "data": [
                    serialize_record(
                        record,
                        limit=requested_by_key[record.event.key].output_limit,
                        price_grouping=requested_by_key[record.event.key].price_grouping,
                        price_tick_size=requested_by_key[record.event.key].price_tick_size,
                    )
                    for record in attachment.current.values()
                ],
                **contract_metadata(
                    output_limit=max(item.output_limit for item in streams),
                ),
            })
            return True

    async def _forward() -> None:
        assert attachment is not None
        requested_by_key = {requested.key: requested for requested in active}
        while True:
            record = await attachment.subscription.receive()
            if record is None:
                return
            requested = requested_by_key[record.event.key]
            output_limit = requested.output_limit
            live = bool(record.event.data.get("live"))
            metadata = contract_metadata(output_limit=output_limit)
            metadata["backend_sequence_continuity"] = live
            await _send_json({
                "type": (
                    "full_order_book.snapshot"
                    if live
                    else "full_order_book.status"
                ),
                "protocol": PROTOCOL,
                "state": record.event.data.get("state", "live" if live else "stale"),
                "data": serialize_record(
                    record,
                    limit=output_limit,
                    price_grouping=requested.price_grouping,
                    price_tick_size=requested.price_tick_size,
                ),
                **metadata,
            })

    async def _read_after_subscribe() -> None:
        while True:
            message = await _receive_command()
            if message is None:
                continue
            request_id = message.get("request_id")
            action = str(message.get("action", "")).strip().lower()
            if action == "unsubscribe":
                await _send_json({
                    "type": "unsubscribed",
                    "protocol": PROTOCOL,
                    "request_id": request_id,
                    "streams": [requested.key.to_dict() for requested in active],
                })
                return
            await _send_json({
                "type": "error",
                "request_id": request_id,
                "code": "IMMUTABLE_SUBSCRIPTION",
                "detail": "Reconnect to change full order-book streams",
            })

    try:
        await _send_json({
            "type": "connected",
            "protocol": PROTOCOL,
            "max_subscriptions": MAX_SUBSCRIPTIONS,
            "max_output_levels": MAX_OUTPUT_LEVELS,
            "allowed_update_intervals_ms": sorted(ALLOWED_UPDATE_INTERVALS_MS),
            "allowed_update_intervals_ms_by_market": {
                market: sorted(intervals)
                for market, intervals in ALLOWED_UPDATE_INTERVALS_BY_MARKET.items()
            },
            "allowed_price_groupings": list(FULL_PRICE_GROUPINGS),
            **contract_metadata(output_limit=MAX_OUTPUT_LEVELS),
        })
        if not await _subscribe():
            return
        tasks = [
            asyncio.create_task(
                _read_after_subscribe(),
                name=f"full-order-book-ws-read-{id(websocket)}",
            ),
            asyncio.create_task(
                _forward(),
                name=f"full-order-book-ws-forward-{id(websocket)}",
            ),
        ]
        done, _pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    except WebSocketDisconnect:
        pass
    finally:
        if attachment is not None:
            try:
                await attachment.subscription.close()
            except BaseException:
                pass
        for task in tasks:
            if not task.done():
                task.cancel()
        await _release(active)
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


def _parse_streams(raw_streams: object) -> list[_RequestedStream]:
    if not isinstance(raw_streams, list) or not raw_streams:
        raise TypeError("streams must be a non-empty list")
    if len(raw_streams) > MAX_SUBSCRIPTIONS:
        raise ValueError(f"streams may contain at most {MAX_SUBSCRIPTIONS} items")

    streams: list[_RequestedStream] = []
    seen: set[MarketStreamKey] = set()
    for raw in raw_streams:
        if not isinstance(raw, dict):
            raise TypeError("each stream must be an object")
        channel = str(raw.get("channel", MarketChannel.FULL_DEPTH.value)).strip().lower()
        if channel != MarketChannel.FULL_DEPTH.value:
            raise ValueError("full order-book streams only support channel 'full_depth'")
        params = raw.get("params", {})
        if not isinstance(params, dict):
            raise TypeError("full order-book stream params must be an object")
        unknown = set(params) - {
            "mode",
            "output_limit",
            "price_grouping",
            "snapshot_limit",
            "update_interval_ms",
        }
        if unknown:
            raise ValueError(f"unsupported full order-book params: {sorted(unknown)!r}")
        if params.get("mode", "full") != "full":
            raise ValueError("full order-book mode must be 'full'")
        snapshot_limit = _integer_param(
            params.get("snapshot_limit", UPSTREAM_SNAPSHOT_LIMIT),
            "snapshot_limit",
        )
        if snapshot_limit != UPSTREAM_SNAPSHOT_LIMIT:
            raise ValueError(f"snapshot_limit must be {UPSTREAM_SNAPSHOT_LIMIT}")
        market_type = str(
            raw.get("market_type", raw.get("marketType", "futures")),
        ).strip().lower()
        default_interval_ms = DEFAULT_UPDATE_INTERVAL_MS_BY_MARKET.get(market_type, 250)
        update_interval_ms = _integer_param(
            params.get("update_interval_ms", default_interval_ms),
            "update_interval_ms",
        )
        output_limit = _integer_param(
            params.get("output_limit", raw.get("limit", 100)),
            "output_limit",
        )
        if not 1 <= output_limit <= MAX_OUTPUT_LEVELS:
            raise ValueError(f"output_limit must be between 1 and {MAX_OUTPUT_LEVELS}")
        price_grouping = normalize_price_grouping(params.get("price_grouping", "raw"))
        try:
            key = full_order_book_key(
                exchange=str(raw.get("exchange", "binance")),
                market_type=market_type,
                symbol=raw.get("symbol"),
                update_interval_ms=update_interval_ms,
            )
        except HTTPException as exc:
            raise ValueError(str(exc.detail)) from exc
        if key in seen:
            raise ValueError("duplicate full order-book physical stream")
        seen.add(key)
        streams.append(_RequestedStream(
            key=key,
            output_limit=output_limit,
            price_grouping=price_grouping,
            price_tick_size=cached_price_tick_size(key),
        ))
    return streams


def _integer_param(value: object, label: str) -> int:
    if isinstance(value, bool):
        raise TypeError(f"{label} must be an integer")
    try:
        number = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError, OverflowError) as exc:
        raise TypeError(f"{label} must be an integer") from exc
    if str(number) != str(value).strip():
        raise TypeError(f"{label} must be an integer")
    return number


__all__ = ["stream_full_order_book"]
