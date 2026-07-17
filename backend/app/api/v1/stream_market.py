"""Logical multiplex WebSocket for advanced market-data streams."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from app.api.v1.stream_utils import send_json_with_timeout, send_text_with_timeout
from app.data_engine.market_data.models import MarketChannel, MarketStreamKey


MAX_MARKET_SUBSCRIPTIONS = 64
MAX_UPDATE_BATCH = 64
UPDATE_BATCH_SECONDS = 0.1
MAX_COMMAND_BYTES = 65_536

logger = logging.getLogger("api.stream_market")


async def stream_market(websocket: WebSocket, dm: Any) -> None:
    """Run one browser socket carrying many symbols/channels."""

    consumer_id = f"ws:market:{id(websocket)}"
    active: set[MarketStreamKey] = set()
    subscription = None
    send_lock = asyncio.Lock()

    async def _send_json(payload: dict) -> None:
        async with send_lock:
            await send_json_with_timeout(websocket, payload)

    async def _forward() -> None:
        assert subscription is not None
        while True:
            first = await subscription.receive()
            if first is None:
                return
            batch = [first]
            deadline = asyncio.get_running_loop().time() + UPDATE_BATCH_SECONDS
            while len(batch) < MAX_UPDATE_BATCH:
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    break
                try:
                    record = await asyncio.wait_for(subscription.receive(), timeout=remaining)
                except asyncio.TimeoutError:
                    break
                if record is None:
                    break
                batch.append(record)
            await _send_json({
                "type": "update",
                "protocol": "market.v1",
                "data": [record.to_dict() for record in batch],
            })

    async def _release(keys: list[MarketStreamKey]) -> list[str]:
        errors: list[str] = []
        for key in reversed(keys):
            try:
                await dm.release_market_stream(key, consumer_id=consumer_id)
            except Exception as exc:
                errors.append(f"{key.topic}: {type(exc).__name__}")
        return errors

    async def _read_commands() -> None:
        assert subscription is not None
        await _send_json({
            "type": "connected",
            "protocol": "market.v1",
            "max_subscriptions": MAX_MARKET_SUBSCRIPTIONS,
        })
        while True:
            raw = await websocket.receive_text()
            if len(raw.encode("utf-8")) > MAX_COMMAND_BYTES:
                await _send_json({"type": "error", "code": "COMMAND_TOO_LARGE"})
                continue
            if raw.strip().lower() == "ping":
                async with send_lock:
                    await send_text_with_timeout(websocket, "pong")
                continue
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                await _send_json({"type": "error", "code": "INVALID_JSON"})
                continue
            if not isinstance(message, dict):
                await _send_json({"type": "error", "code": "INVALID_MESSAGE"})
                continue

            request_id = message.get("request_id")
            action = str(message.get("action", "")).strip().lower()
            try:
                keys = _parse_streams(message.get("streams"))
            except (TypeError, ValueError) as exc:
                await _send_json({
                    "type": "error",
                    "request_id": request_id,
                    "code": "INVALID_STREAMS",
                    "detail": str(exc),
                })
                continue

            if action == "subscribe":
                new_keys = [key for key in keys if key not in active]
                if len(active) + len(new_keys) > MAX_MARKET_SUBSCRIPTIONS:
                    await _send_json({
                        "type": "error",
                        "request_id": request_id,
                        "code": "SUBSCRIPTION_LIMIT",
                        "detail": f"At most {MAX_MARKET_SUBSCRIPTIONS} streams are allowed",
                    })
                    continue

                acquired: list[MarketStreamKey] = []
                try:
                    for key in new_keys:
                        if await dm.ensure_market_stream(key, consumer_id=consumer_id):
                            acquired.append(key)
                    records = await dm.market_snapshot(keys, refresh_missing=True)
                    available = {record.event.key for record in records}
                    unavailable = [key for key in new_keys if key not in available]
                    if unavailable:
                        topics = ", ".join(key.topic for key in unavailable)
                        raise ValueError(f"initial market snapshot unavailable: {topics}")
                except asyncio.CancelledError:
                    await _release(acquired)
                    raise
                except Exception as exc:
                    await _release(acquired)
                    if isinstance(exc, ValueError):
                        detail = str(exc)
                    else:
                        logger.warning("Advanced market subscribe failed: %s", exc)
                        detail = "advanced market subscription is temporarily unavailable"
                    await _send_json({
                        "type": "error",
                        "request_id": request_id,
                        "code": "SUBSCRIBE_FAILED",
                        "detail": detail,
                    })
                    continue

                active.update(new_keys)
                async with send_lock:
                    subscription.add_keys(new_keys, replay=True)
                    await send_json_with_timeout(websocket, {
                        "type": "subscribed",
                        "request_id": request_id,
                        "streams": [key.to_dict() for key in keys],
                    })
                    by_key = {record.event.key: record for record in records}
                    await send_json_with_timeout(websocket, {
                        "type": "snapshot",
                        "request_id": request_id,
                        "data": [by_key[key].to_dict() for key in keys if key in by_key],
                        "missing": [key.to_dict() for key in keys if key not in by_key],
                    })
                continue

            if action == "unsubscribe":
                removed = [key for key in keys if key in active]
                release_errors = await _release(removed)
                subscription.remove_keys(removed)
                active.difference_update(removed)
                response = {
                    "type": "unsubscribed",
                    "request_id": request_id,
                    "streams": [key.to_dict() for key in removed],
                }
                if release_errors:
                    response["release_errors"] = release_errors
                await _send_json(response)
                continue

            await _send_json({
                "type": "error",
                "request_id": request_id,
                "code": "UNKNOWN_ACTION",
                "detail": f"Unknown action: {action}",
            })

    tasks: list[asyncio.Task] = []
    try:
        subscription = dm.subscribe_market(
            [],
            max_pending=MAX_MARKET_SUBSCRIPTIONS,
            replay=False,
        )
        tasks = [
            asyncio.create_task(_read_commands(), name=f"market-ws-read-{id(websocket)}"),
            asyncio.create_task(_forward(), name=f"market-ws-forward-{id(websocket)}"),
        ]
        done, _pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    except WebSocketDisconnect:
        pass
    finally:
        if subscription is not None:
            try:
                await subscription.close()
            except BaseException:
                pass
        for task in tasks:
            if not task.done():
                task.cancel()
        await _release(list(active))
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


def _parse_streams(raw_streams: object) -> list[MarketStreamKey]:
    if not isinstance(raw_streams, list) or not raw_streams:
        raise TypeError("streams must be a non-empty list")
    if len(raw_streams) > MAX_MARKET_SUBSCRIPTIONS:
        raise ValueError(f"streams may contain at most {MAX_MARKET_SUBSCRIPTIONS} items")
    keys: list[MarketStreamKey] = []
    seen: set[MarketStreamKey] = set()
    for raw in raw_streams:
        if not isinstance(raw, dict):
            raise TypeError("each stream must be an object")
        params = raw.get("params")
        if params not in (None, {}):
            raise ValueError("P1 market streams do not accept params")
        channel = MarketChannel(str(raw.get("channel", "")).strip().lower())
        key = MarketStreamKey.build(
            str(raw.get("exchange", "binance")),
            str(raw.get("market_type", raw.get("marketType", "futures"))),
            str(raw.get("symbol", "")),
            channel,
        )
        if key not in seen:
            seen.add(key)
            keys.append(key)
    return keys
