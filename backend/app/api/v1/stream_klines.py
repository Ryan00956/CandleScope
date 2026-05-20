"""K-line WebSocket handlers backed by DataManager events."""
from __future__ import annotations

import asyncio
import json

from fastapi import WebSocket, WebSocketDisconnect

from app.api.v1.stream_utils import (
    send_json_with_timeout,
    send_text_with_timeout,
    validate_ws_interval,
)
from app.data_engine.data_manager.models import DataEventType


async def stream_single_kline(
    websocket: WebSocket,
    dm,
    symbol: str,
    interval: str,
    exchange: str = "binance",
    market_type: str = "spot",
) -> None:
    """Stream bars for a single interval using DataManager's EventBus."""
    try:
        await dm.ensure_stream(symbol, interval, exchange=exchange, market_type=market_type)

        await send_json_with_timeout(websocket, {
            "type": "subscribed",
            "exchange": exchange,
            "symbol": symbol,
            "interval": interval,
            "market_type": market_type,
        })

        client_task = asyncio.create_task(
            read_client_messages(websocket),
            name="ws_client_reader",
        )
        stream_task = asyncio.create_task(
            forward_events_to_ws(
                websocket,
                dm,
                symbol,
                [interval],
                exchange=exchange,
                market_type=market_type,
            ),
            name="ws_event_forwarder",
        )

        _done, pending = await asyncio.wait(
            {client_task, stream_task},
            return_when=asyncio.FIRST_COMPLETED,
        )

        for task in pending:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass

    except WebSocketDisconnect:
        pass
    except Exception:
        try:
            await websocket.close()
        except Exception:
            pass


async def stream_multi_kline(
    websocket: WebSocket,
    dm,
    symbol: str,
    exchange: str = "binance",
    market_type: str = "spot",
) -> None:
    """Multi-interval stream using DataManager's EventBus."""
    active_intervals: set[str] = set()
    event_queue: asyncio.Queue = asyncio.Queue(maxsize=1000)
    subscriptions = {}
    ws_closed = False

    async def safe_send_json(data: dict) -> bool:
        nonlocal ws_closed
        if ws_closed:
            return False
        try:
            await send_json_with_timeout(websocket, data)
            return True
        except (RuntimeError, Exception):
            ws_closed = True
            return False

    async def safe_send_text(data: str) -> bool:
        nonlocal ws_closed
        if ws_closed:
            return False
        try:
            await send_text_with_timeout(websocket, data)
            return True
        except (RuntimeError, Exception):
            ws_closed = True
            return False

    async def event_callback(event):
        if ws_closed:
            return
        try:
            if event.event_type == DataEventType.BACKFILL_COMPLETED:
                await asyncio.wait_for(
                    event_queue.put({
                        "type": "backfill_completed",
                        "exchange": event.key.exchange,
                        "symbol": event.key.symbol,
                        "interval": event.key.interval,
                        "market_type": event.key.market_type,
                        "detail": event.detail or {},
                    }),
                    timeout=1.0,
                )
                return

            bar_dict = {
                "type": "kline",
                "exchange": event.key.exchange,
                "symbol": event.key.symbol,
                "interval": event.key.interval,
                "market_type": event.key.market_type,
                "data": event.bar.to_dict() if event.bar else {},
            }
            bar_dict["data"]["is_closed"] = event.event_type == DataEventType.BAR_CLOSED
            await asyncio.wait_for(event_queue.put(bar_dict), timeout=1.0)
        except (asyncio.TimeoutError, Exception):
            pass

    try:
        async def forwarder() -> None:
            nonlocal ws_closed
            while not ws_closed:
                msg = await event_queue.get()
                if not await safe_send_json(msg):
                    return

        forwarder_task = asyncio.create_task(forwarder(), name="ws_forwarder")

        try:
            while not ws_closed:
                raw = await websocket.receive_text()
                stripped = raw.strip().lower()

                if stripped == "ping":
                    if not await safe_send_text("pong"):
                        break
                    continue

                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    if not await safe_send_json({"type": "error", "detail": "Invalid JSON"}):
                        break
                    continue

                action = msg.get("action", "").lower()
                intervals = msg.get("intervals", [])

                if not isinstance(intervals, list) or not intervals:
                    if not await safe_send_json({
                        "type": "error",
                        "detail": "intervals must be a non-empty list",
                    }):
                        break
                    continue

                valid = [i for i in intervals if validate_ws_interval(i)]
                invalid = [i for i in intervals if not validate_ws_interval(i)]

                if invalid:
                    await safe_send_json({
                        "type": "warning",
                        "detail": f"Skipped invalid intervals: {invalid}",
                    })

                if not valid:
                    if not await safe_send_json({
                        "type": "error",
                        "detail": "No valid intervals provided",
                    }):
                        break
                    continue

                if action == "subscribe":
                    for iv in valid:
                        if iv not in active_intervals:
                            await dm.ensure_stream(symbol, iv, exchange=exchange, market_type=market_type)
                            handle = dm.subscribe(
                                callback=event_callback,
                                symbol=symbol,
                                interval=iv,
                                exchange=exchange,
                                market_type=market_type,
                                event_types={
                                    DataEventType.BAR_CREATED,
                                    DataEventType.BAR_UPDATED,
                                    DataEventType.BAR_CLOSED,
                                    DataEventType.BACKFILL_COMPLETED,
                                },
                            )
                            subscriptions[iv] = handle
                            active_intervals.add(iv)

                    await safe_send_json({
                        "type": "subscribed",
                        "exchange": exchange,
                        "symbol": symbol,
                        "intervals": valid,
                        "market_type": market_type,
                    })

                elif action == "unsubscribe":
                    for iv in valid:
                        active_intervals.discard(iv)
                        handle = subscriptions.pop(iv, None)
                        if handle is not None:
                            try:
                                dm.unsubscribe(handle)
                            except Exception:
                                pass
                    await safe_send_json({
                        "type": "unsubscribed",
                        "exchange": exchange,
                        "symbol": symbol,
                        "intervals": valid,
                        "market_type": market_type,
                    })

                else:
                    await safe_send_json({
                        "type": "error",
                        "detail": f"Unknown action: {action}",
                    })

        except WebSocketDisconnect:
            ws_closed = True

        forwarder_task.cancel()
        try:
            await forwarder_task
        except (asyncio.CancelledError, Exception):
            pass

    finally:
        ws_closed = True
        for handle in list(subscriptions.values()):
            try:
                dm.unsubscribe(handle)
            except Exception:
                pass
        subscriptions.clear()


async def forward_events_to_ws(
    websocket: WebSocket,
    dm,
    symbol: str,
    intervals: list[str],
    exchange: str = "binance",
    market_type: str = "spot",
) -> None:
    """Forward DataManager K-line events to a WebSocket client."""
    for interval in intervals:
        async for event in dm.subscribe_iter(
            symbol=symbol,
            interval=interval,
            exchange=exchange,
            market_type=market_type,
            event_types={
                DataEventType.BAR_CREATED,
                DataEventType.BAR_UPDATED,
                DataEventType.BAR_CLOSED,
            },
        ):
            bar_dict = {
                "type": "kline",
                "exchange": event.key.exchange,
                "symbol": event.key.symbol,
                "interval": event.key.interval,
                "market_type": event.key.market_type,
                "data": event.bar.to_dict() if event.bar else {},
            }
            bar_dict["data"]["is_closed"] = event.event_type == DataEventType.BAR_CLOSED

            try:
                await send_json_with_timeout(websocket, bar_dict)
            except Exception:
                return


async def read_client_messages(websocket: WebSocket) -> None:
    """Read and handle client messages for simple K-line streams."""
    try:
        while True:
            message = await websocket.receive_text()
            if message.lower().strip() == "ping":
                await send_text_with_timeout(websocket, "pong")
    except WebSocketDisconnect:
        pass
