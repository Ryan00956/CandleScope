"""
WebSocket stream endpoints — powered by DataManager's event bus.

Data flow:
    Ingestion → BarAggregator (L1–L5) → DataManager EventBus
    → subscribe_iter() → WebSocket client

The DataManager instance is stored on ``app.state.data_manager``
and initialized during application startup (see ``app/main.py``).
"""
from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from app.exchanges import bootstrap_default_adapters, get_exchange_registry
from app.core.market import VALID_INTERVALS, parse_custom_interval

router = APIRouter(prefix="/stream", tags=["stream"])


def _validate_ws_interval(interval: str) -> bool:
    """Check if interval is valid (native or custom)."""
    if interval in VALID_INTERVALS:
        return True
    parsed = parse_custom_interval(interval)
    return parsed is not None and parsed > 0


def _get_data_manager(websocket: WebSocket):
    """Get DataManager from app state."""
    return getattr(websocket.app.state, "data_manager", None)


def _normalize_market_type(market_type: str) -> str:
    return (market_type or "spot").strip().lower()


def _normalize_exchange(exchange: str) -> str:
    normalized = (exchange or "binance").strip().lower()
    bootstrap_default_adapters()
    if not get_exchange_registry().has(normalized):
        return "binance"
    return normalized


@router.websocket("/klines")
async def kline_stream(
    websocket: WebSocket,
    symbol: str = Query("BTCUSDT"),
    interval: str = Query("1m"),
    exchange: str = Query("binance"),
    market_type: str = Query("spot"),
) -> None:
    """Single-interval WebSocket stream.

    When DataManager is available, subscribes through its EventBus
    which receives data from the full Ingestion → BarAggregator pipeline.
    """
    symbol = symbol.upper().strip()
    interval = interval.strip()
    exchange = _normalize_exchange(exchange)
    market_type = _normalize_market_type(market_type)

    await websocket.accept()

    if not _validate_ws_interval(interval):
        await websocket.send_json({
            "type": "error",
            "detail": f"Unsupported interval: {interval}.",
        })
        await websocket.close(code=1008)
        return

    dm = _get_data_manager(websocket)

    if dm is None:
        await websocket.send_json({
            "type": "error",
            "detail": "DataManager not initialized. Server is not ready.",
        })
        await websocket.close(code=1013)
        return

    await _dm_single_stream(websocket, dm, symbol, interval, exchange=exchange, market_type=market_type)


@router.websocket("/klines_multi")
async def kline_stream_multi(
    websocket: WebSocket,
    symbol: str = Query("BTCUSDT"),
    exchange: str = Query("binance"),
    market_type: str = Query("spot"),
) -> None:
    """Multi-interval WebSocket endpoint.

    The client connects once and sends JSON commands to subscribe/unsubscribe
    to multiple intervals.  All kline data for all subscribed intervals flows
    through this single connection.

    Commands:
        {"action": "subscribe", "intervals": ["1m", "5m", "15m", "1h"]}
        {"action": "unsubscribe", "intervals": ["1m"]}
        "ping"  -> responds "pong"
    """
    symbol = symbol.upper().strip()
    exchange = _normalize_exchange(exchange)
    market_type = _normalize_market_type(market_type)
    await websocket.accept()

    try:
        await websocket.send_json({
            "type": "connected",
            "exchange": exchange,
            "symbol": symbol,
            "market_type": market_type,
        })
    except (WebSocketDisconnect, RuntimeError, Exception):
        # Client disconnected between accept() and first send — nothing to do
        return

    dm = _get_data_manager(websocket)

    if dm is None:
        await websocket.send_json({
            "type": "error",
            "detail": "DataManager not initialized. Server is not ready.",
        })
        await websocket.close(code=1013)
        return

    await _dm_multi_stream(websocket, dm, symbol, exchange=exchange, market_type=market_type)


# ═══════════════════════════════════════════════════════════════
#  DataManager-powered WebSocket handlers
# ═══════════════════════════════════════════════════════════════


async def _dm_single_stream(
    websocket: WebSocket, dm, symbol: str, interval: str,
    exchange: str = "binance",
    market_type: str = "spot",
) -> None:
    """Stream bars for a single interval using DataManager's EventBus."""
    from app.data_engine.data_manager.models import DataEventType

    try:
        # Ensure the ingestion pipeline is running
        await dm.ensure_stream(symbol, interval, exchange=exchange, market_type=market_type)

        await websocket.send_json({
            "type": "subscribed",
            "exchange": exchange,
            "symbol": symbol,
            "interval": interval,
            "market_type": market_type,
        })

        # Create a task for reading client messages (ping/pong)
        client_task = asyncio.create_task(
            _read_client_messages(websocket),
            name="ws_client_reader",
        )

        # Subscribe to DataManager events via async iterator
        stream_task = asyncio.create_task(
            _forward_events_to_ws(
                websocket, dm, symbol, [interval], exchange=exchange, market_type=market_type,
            ),
            name="ws_event_forwarder",
        )

        # Wait for either to finish (client disconnect or error)
        done, pending = await asyncio.wait(
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


async def _dm_multi_stream(
    websocket: WebSocket, dm, symbol: str,
    exchange: str = "binance",
    market_type: str = "spot",
) -> None:
    """Multi-interval stream using DataManager's EventBus."""
    from app.data_engine.data_manager.models import DataEventType

    active_intervals: set[str] = set()
    # Queue for forwarding events
    event_queue: asyncio.Queue = asyncio.Queue(maxsize=1000)
    subscriptions = []  # list of SubscriptionHandle
    _ws_closed = False  # flag to avoid sending after close

    async def _safe_send_json(data: dict) -> bool:
        """Send JSON to the WebSocket, returning False if the connection is closed."""
        nonlocal _ws_closed
        if _ws_closed:
            return False
        try:
            await websocket.send_json(data)
            return True
        except (RuntimeError, Exception):
            _ws_closed = True
            return False

    async def _safe_send_text(data: str) -> bool:
        """Send text to the WebSocket, returning False if the connection is closed."""
        nonlocal _ws_closed
        if _ws_closed:
            return False
        try:
            await websocket.send_text(data)
            return True
        except (RuntimeError, Exception):
            _ws_closed = True
            return False

    async def _event_callback(event):
        """Push events into the queue for the forwarder."""
        if _ws_closed:
            return
        try:
            # Handle backfill completion events specially
            if event.event_type == DataEventType.BACKFILL_COMPLETED:
                backfill_msg = {
                    "type": "backfill_completed",
                    "exchange": event.key.exchange,
                    "symbol": event.key.symbol,
                    "interval": event.key.interval,
                    "market_type": event.key.market_type,
                    "detail": event.detail or {},
                }
                await asyncio.wait_for(
                    event_queue.put(backfill_msg), timeout=1.0,
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
            # Add is_closed flag
            if event.event_type == DataEventType.BAR_CLOSED:
                bar_dict["data"]["is_closed"] = True
            else:
                bar_dict["data"]["is_closed"] = False
            await asyncio.wait_for(
                event_queue.put(bar_dict), timeout=1.0,
            )
        except (asyncio.TimeoutError, Exception):
            pass

    try:
        # Task: forward queued events to WebSocket
        async def _forwarder():
            nonlocal _ws_closed
            while not _ws_closed:
                msg = await event_queue.get()
                if not await _safe_send_json(msg):
                    return

        forwarder_task = asyncio.create_task(_forwarder(), name="ws_forwarder")

        # Main loop: read client commands
        try:
            while not _ws_closed:
                raw = await websocket.receive_text()
                stripped = raw.strip().lower()

                if stripped == "ping":
                    if not await _safe_send_text("pong"):
                        break
                    continue

                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    if not await _safe_send_json({"type": "error", "detail": "Invalid JSON"}):
                        break
                    continue

                action = msg.get("action", "").lower()
                intervals = msg.get("intervals", [])

                if not isinstance(intervals, list) or not intervals:
                    if not await _safe_send_json({
                        "type": "error",
                        "detail": "intervals must be a non-empty list",
                    }):
                        break
                    continue

                # Validate intervals (support both native and custom)
                valid = [i for i in intervals if _validate_ws_interval(i)]
                invalid = [i for i in intervals if not _validate_ws_interval(i)]

                if invalid:
                    await _safe_send_json({
                        "type": "warning",
                        "detail": f"Skipped invalid intervals: {invalid}",
                    })

                if not valid:
                    if not await _safe_send_json({
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
                                callback=_event_callback,
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
                            subscriptions.append(handle)
                            active_intervals.add(iv)

                    await _safe_send_json({
                        "type": "subscribed",
                        "exchange": exchange,
                        "symbol": symbol,
                        "intervals": valid,
                        "market_type": market_type,
                    })

                elif action == "unsubscribe":
                    for iv in valid:
                        active_intervals.discard(iv)
                    await _safe_send_json({
                        "type": "unsubscribed",
                        "exchange": exchange,
                        "symbol": symbol,
                        "intervals": valid,
                        "market_type": market_type,
                    })

                else:
                    await _safe_send_json({
                        "type": "error",
                        "detail": f"Unknown action: {action}",
                    })

        except WebSocketDisconnect:
            _ws_closed = True

        forwarder_task.cancel()
        try:
            await forwarder_task
        except (asyncio.CancelledError, Exception):
            pass

    finally:
        _ws_closed = True
        # Clean up all subscriptions
        for handle in subscriptions:
            try:
                dm.unsubscribe(handle)
            except Exception:
                pass


async def _forward_events_to_ws(
    websocket: WebSocket,
    dm,
    symbol: str,
    intervals: list[str],
    exchange: str = "binance",
    market_type: str = "spot",
) -> None:
    """Forward DataManager events to a WebSocket client."""
    from app.data_engine.data_manager.models import DataEventType

    for interval in intervals:
        # Use subscribe_iter for clean async iteration
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
            if event.event_type == DataEventType.BAR_CLOSED:
                bar_dict["data"]["is_closed"] = True
            else:
                bar_dict["data"]["is_closed"] = False

            try:
                await websocket.send_json(bar_dict)
            except Exception:
                return


async def _read_client_messages(websocket: WebSocket) -> None:
    """Read and handle client messages (ping/pong, etc.)."""
    try:
        while True:
            message = await websocket.receive_text()
            if message.lower().strip() == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        pass


