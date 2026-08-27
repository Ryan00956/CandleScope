"""Latest-wins WebSocket delivery for Partial Top-N order books."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from app.api.v1.order_book import (
    ALLOWED_DEPTH_LEVELS,
    ALLOWED_UPDATE_INTERVALS_BY_MARKET,
    ALLOWED_UPDATE_INTERVALS_MS,
    PROTOCOL,
    order_book_contract,
    serialize_record,
)
from app.api.v1.order_book_projection import cached_price_tick_size
from app.api.v1.stream_utils import send_json_with_timeout, send_text_with_timeout
from app.data_engine.market_data.models import MarketChannel, MarketStreamKey


MAX_SUBSCRIPTIONS = 32
MAX_COMMAND_BYTES = 65_536

logger = logging.getLogger("api.stream_order_book")


async def stream_order_book(websocket: WebSocket, dm: Any) -> None:
    """Run one immutable multiplexed partial-book subscription."""

    consumer_id = f"ws:order-book:{id(websocket)}"
    active: list[MarketStreamKey] = []
    attachment: Any = None
    tasks: list[asyncio.Task[None]] = []
    send_lock = asyncio.Lock()

    async def _send_json(payload: dict[str, Any]) -> None:
        async with send_lock:
            await send_json_with_timeout(websocket, payload)

    async def _release(keys: list[MarketStreamKey]) -> None:
        for key in reversed(keys):
            try:
                released = await dm.release_order_book_stream(
                    key,
                    consumer_id=consumer_id,
                )
                if not released:
                    logger.warning("Order-book stream release remained incomplete: %s", key)
            except Exception as exc:
                logger.warning("Order-book stream release failed for %s: %s", key, exc)

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
                    "detail": "The first command must subscribe to order-book streams",
                })
                continue
            try:
                keys = _parse_streams(message.get("streams"))
            except (TypeError, ValueError) as exc:
                await _send_json({
                    "type": "error",
                    "request_id": request_id,
                    "code": "INVALID_SUBSCRIPTION",
                    "detail": str(exc),
                })
                continue

            acquired: list[MarketStreamKey] = []
            try:
                for key in keys:
                    if await dm.ensure_order_book_stream(key, consumer_id=consumer_id):
                        acquired.append(key)
                attachment = dm.attach_order_books(
                    keys,
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
                    else "order-book subscription is temporarily unavailable"
                )
                if not isinstance(exc, ValueError):
                    logger.warning("Order-book subscribe failed: %s", exc)
                await _send_json({
                    "type": "error",
                    "request_id": request_id,
                    "code": "SUBSCRIBE_FAILED",
                    "detail": detail,
                })
                continue

            active.extend(keys)
            tick_sizes = {key: cached_price_tick_size(key) for key in keys}
            await _send_json({
                "type": "subscribed",
                "protocol": PROTOCOL,
                "request_id": request_id,
                "streams": [key.to_dict() for key in keys],
                **_contract_metadata(),
            })
            await _send_json({
                "type": "snapshot",
                "protocol": PROTOCOL,
                "request_id": request_id,
                "data": [
                    serialize_record(
                        record,
                        price_tick_size=tick_sizes[record.event.key],
                    )
                    for record in attachment.current.values()
                ],
                **_contract_metadata(),
            })
            return True

    async def _forward() -> None:
        assert attachment is not None
        tick_sizes = {key: cached_price_tick_size(key) for key in active}
        while True:
            record = await attachment.subscription.receive()
            if record is None:
                return
            await _send_json({
                "type": "order_book.snapshot",
                "protocol": PROTOCOL,
                "data": serialize_record(
                    record,
                    price_tick_size=tick_sizes[record.event.key],
                ),
                **_contract_metadata(),
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
                    "streams": [key.to_dict() for key in active],
                })
                return
            await _send_json({
                "type": "error",
                "request_id": request_id,
                "code": "IMMUTABLE_SUBSCRIPTION",
                "detail": "Reconnect to change order-book streams",
            })

    try:
        await _send_json({
            "type": "connected",
            "protocol": PROTOCOL,
            "max_subscriptions": MAX_SUBSCRIPTIONS,
            "allowed_depth_levels": sorted(ALLOWED_DEPTH_LEVELS),
            "allowed_update_intervals_ms": sorted(ALLOWED_UPDATE_INTERVALS_MS),
            "allowed_update_intervals_ms_by_market": {
                market: sorted(intervals)
                for market, intervals in ALLOWED_UPDATE_INTERVALS_BY_MARKET.items()
            },
            **_contract_metadata(),
        })
        if not await _subscribe():
            return
        tasks = [
            asyncio.create_task(
                _read_after_subscribe(),
                name=f"order-book-ws-read-{id(websocket)}",
            ),
            asyncio.create_task(
                _forward(),
                name=f"order-book-ws-forward-{id(websocket)}",
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


def _contract_metadata() -> dict[str, Any]:
    return {
        "delivery": "latest_snapshot",
        "snapshot_replaceable": True,
        "full_depth": False,
        "sequence_continuity": False,
        "backfillable": False,
        "persisted": False,
    }


def _parse_streams(raw_streams: object) -> list[MarketStreamKey]:
    if not isinstance(raw_streams, list) or not raw_streams:
        raise TypeError("streams must be a non-empty list")
    if len(raw_streams) > MAX_SUBSCRIPTIONS:
        raise ValueError(f"streams may contain at most {MAX_SUBSCRIPTIONS} items")

    keys: list[MarketStreamKey] = []
    seen: set[MarketStreamKey] = set()
    for raw in raw_streams:
        if not isinstance(raw, dict):
            raise TypeError("each stream must be an object")
        channel = str(raw.get("channel", MarketChannel.DEPTH.value)).strip().lower()
        if channel != MarketChannel.DEPTH.value:
            raise ValueError("order-book streams only support channel 'depth'")
        exchange = str(raw.get("exchange", "binance")).strip().lower()
        market_type = str(
            raw.get("market_type", raw.get("marketType", "futures")),
        ).strip().lower()
        try:
            contract = order_book_contract(exchange, market_type)
        except Exception as exc:
            detail = getattr(exc, "detail", None)
            raise ValueError(str(detail if detail is not None else exc)) from exc
        params = raw["params"] if "params" in raw else {}
        if not isinstance(params, dict):
            raise TypeError("order-book stream params must be an object")
        unknown = set(params) - {"mode", "depth_levels", "update_interval_ms"}
        if unknown:
            raise ValueError(f"unsupported order-book params: {sorted(unknown)!r}")
        mode = params.get("mode", "partial")
        if not isinstance(mode, str) or mode != "partial":
            raise ValueError("P3A order-book mode must be 'partial'")
        depth_levels = _integer_param(params.get("depth_levels", 20), "depth_levels")
        update_interval_ms = _integer_param(
            params.get(
                "update_interval_ms",
                contract["default_update_interval_ms"],
            ),
            "update_interval_ms",
        )
        allowed_depth_levels = contract["depth_levels"]
        if depth_levels not in allowed_depth_levels:
            supported_depth = ", ".join(
                str(value) for value in sorted(allowed_depth_levels)
            )
            raise ValueError(f"depth_levels must be one of {supported_depth}")
        allowed_intervals = contract["update_intervals_ms"]
        if update_interval_ms not in allowed_intervals:
            supported = ", ".join(str(value) for value in sorted(allowed_intervals))
            raise ValueError(
                f"{exchange} {market_type} update_interval_ms must be one of {supported}",
            )
        symbol = raw.get("symbol")
        if not isinstance(symbol, str):
            raise TypeError("order-book stream symbol must be a string")
        key = MarketStreamKey.build(
            exchange,
            market_type,
            symbol,
            MarketChannel.DEPTH,
            params={
                "mode": "partial",
                "depth_levels": depth_levels,
                "update_interval_ms": update_interval_ms,
            },
        )
        if key not in seen:
            seen.add(key)
            keys.append(key)
    return keys


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


__all__ = ["stream_order_book"]
