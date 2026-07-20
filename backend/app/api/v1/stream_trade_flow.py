"""Fail-closed WebSocket delivery for append-only aggregate trades."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any
from uuid import uuid4

from fastapi import WebSocket, WebSocketDisconnect

from app.api.v1.stream_utils import send_json_with_timeout, send_text_with_timeout
from app.data_engine.market_data.models import MarketChannel, MarketStreamKey


PROTOCOL = "tradeflow.v1"
MAX_TRADE_FLOW_SUBSCRIPTIONS = 32
MAX_RECENT_PER_STREAM = 2_000
MAX_RECENT_RECORDS = 5_000
MAX_PENDING_RECORDS = 4_096
MAX_COMMAND_BYTES = 65_536

logger = logging.getLogger("api.stream_trade_flow")


async def stream_trade_flow(websocket: WebSocket, dm: Any) -> None:
    """Run one immutable, multiplexed aggregate-trade subscription.

    The first successful ``subscribe`` command fixes the stream set for the
    lifetime of the socket.  This keeps the recent-to-live handoff atomic: the
    service attaches the live subscriber before taking each recent snapshot,
    and this handler sends that snapshot before forwarding queued batches.
    """

    connection_id = uuid4().hex
    consumer_id = f"ws:trade-flow:{connection_id}"
    active: list[MarketStreamKey] = []
    attachment: Any = None
    tasks: list[asyncio.Task[None]] = []
    send_lock = asyncio.Lock()

    async def _send_json(payload: dict[str, Any]) -> None:
        async with send_lock:
            await send_json_with_timeout(websocket, payload)

    async def _release(keys: list[MarketStreamKey]) -> list[str]:
        errors: list[str] = []
        for key in reversed(keys):
            try:
                await dm.release_trade_flow_stream(key, consumer_id=consumer_id)
            except Exception as exc:
                errors.append(f"{key.topic}: {type(exc).__name__}")
        return errors

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
            action = str(message.get("action", "")).strip().lower()
            if action != "subscribe":
                await _send_json({
                    "type": "error",
                    "request_id": request_id,
                    "code": "SUBSCRIBE_REQUIRED",
                    "detail": "The first command must subscribe to trade-flow streams",
                })
                continue
            try:
                keys = _parse_streams(message.get("streams"))
                recent_limit = _parse_recent_limit(message.get("recent_limit", 500))
                if len(keys) * recent_limit > MAX_RECENT_RECORDS:
                    raise ValueError(
                        f"recent snapshot may contain at most {MAX_RECENT_RECORDS} records",
                    )
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
                    if await dm.ensure_trade_flow_stream(key, consumer_id=consumer_id):
                        acquired.append(key)
                # This is intentionally synchronous.  TradeFlowService.attach()
                # subscribes first and snapshots second without an await point.
                attachment = dm.attach_trade_flow(
                    keys,
                    recent_limit=recent_limit,
                    max_pending_records=MAX_PENDING_RECORDS,
                )
            except asyncio.CancelledError:
                await _release(acquired)
                raise
            except Exception as exc:
                await _release(acquired)
                if isinstance(exc, ValueError):
                    detail = str(exc)
                else:
                    logger.warning("Trade-flow subscribe failed: %s", exc)
                    detail = "trade-flow subscription is temporarily unavailable"
                await _send_json({
                    "type": "error",
                    "request_id": request_id,
                    "code": "SUBSCRIBE_FAILED",
                    "detail": detail,
                })
                continue

            active.extend(keys)
            recent = [
                trade.to_dict()
                for key in keys
                for trade in attachment.recent.get(_identity(key), ())
            ]
            await _send_json({
                "type": "subscribed",
                "protocol": PROTOCOL,
                "request_id": request_id,
                "streams": [key.to_dict() for key in keys],
            })
            await _send_json({
                "type": "recent",
                "protocol": PROTOCOL,
                "request_id": request_id,
                "data": recent,
            })
            return True

    async def _forward() -> None:
        assert attachment is not None
        while True:
            batch = await attachment.subscription.receive()
            if batch is None:
                return
            if not batch.continuity or batch.resync_required:
                await _send_json({
                    "type": "resync_required",
                    "protocol": PROTOCOL,
                    "code": "TRADE_FLOW_DISCONTINUITY",
                    "sequence": batch.sequence,
                    "continuity": False,
                    "resync_required": True,
                    "dropped_before": max(1, batch.dropped_before),
                })
                await websocket.close(code=1013)
                return
            await _send_json({
                "type": "trade.batch",
                "protocol": PROTOCOL,
                "sequence": batch.sequence,
                "continuity": True,
                "resync_required": False,
                "dropped_before": 0,
                "data": [trade.to_dict() for trade in batch.records],
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
                "detail": "Reconnect to change trade-flow streams",
            })

    try:
        await _send_json({
            "type": "connected",
            "protocol": PROTOCOL,
            "max_subscriptions": MAX_TRADE_FLOW_SUBSCRIPTIONS,
            "max_recent_per_stream": MAX_RECENT_PER_STREAM,
            "max_recent_records": MAX_RECENT_RECORDS,
        })
        if not await _subscribe():
            return
        tasks = [
            asyncio.create_task(
                _read_after_subscribe(),
                name=f"trade-flow-ws-read-{connection_id}",
            ),
            asyncio.create_task(
                _forward(),
                name=f"trade-flow-ws-forward-{connection_id}",
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


def _parse_streams(raw_streams: object) -> list[MarketStreamKey]:
    if not isinstance(raw_streams, list) or not raw_streams:
        raise TypeError("streams must be a non-empty list")
    if len(raw_streams) > MAX_TRADE_FLOW_SUBSCRIPTIONS:
        raise ValueError(
            f"streams may contain at most {MAX_TRADE_FLOW_SUBSCRIPTIONS} items",
        )
    keys: list[MarketStreamKey] = []
    seen: set[MarketStreamKey] = set()
    for raw in raw_streams:
        if not isinstance(raw, dict):
            raise TypeError("each stream must be an object")
        params = raw.get("params")
        if params not in (None, {}):
            raise ValueError("trade-flow streams do not accept params")
        channel = str(raw.get("channel", MarketChannel.AGG_TRADE.value)).strip().lower()
        if channel != MarketChannel.AGG_TRADE.value:
            raise ValueError("trade-flow streams only support channel 'agg_trade'")
        key = MarketStreamKey.build(
            str(raw.get("exchange", "binance")),
            str(raw.get("market_type", raw.get("marketType", "futures"))),
            str(raw.get("symbol", "")),
            MarketChannel.AGG_TRADE,
        )
        if key not in seen:
            seen.add(key)
            keys.append(key)
    return keys


def _parse_recent_limit(raw: object) -> int:
    if isinstance(raw, bool) or not isinstance(raw, int):
        raise TypeError("recent_limit must be an integer")
    value = raw
    if value < 0 or value > MAX_RECENT_PER_STREAM:
        raise ValueError(
            f"recent_limit must be between 0 and {MAX_RECENT_PER_STREAM}",
        )
    return value


def _identity(key: MarketStreamKey) -> tuple[str, str, str]:
    return key.exchange, key.market_type, key.symbol
