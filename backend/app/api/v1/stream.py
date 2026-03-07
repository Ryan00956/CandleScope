"""
WebSocket stream endpoints — powered by DataManager's event bus.

Data flow (new architecture):
    Ingestion → BarAggregator (L1–L5) → DataManager EventBus
    → subscribe_iter() → WebSocket client

Legacy fallback:
    When DataManager is not initialized, falls back to the old
    KlineStreamHub which connects directly to Binance WS.

The DataManager instance is stored on ``app.state.data_manager``
and initialized during application startup (see ``app/main.py``).
"""
from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

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


@router.websocket("/klines")
async def kline_stream(
    websocket: WebSocket,
    symbol: str = Query("BTCUSDT"),
    interval: str = Query("1m"),
) -> None:
    """Single-interval WebSocket stream.

    When DataManager is available, subscribes through its EventBus
    which receives data from the full Ingestion → BarAggregator pipeline.
    """
    symbol = symbol.upper().strip()
    interval = interval.strip()

    await websocket.accept()

    if not _validate_ws_interval(interval):
        await websocket.send_json({
            "type": "error",
            "detail": f"Unsupported interval: {interval}.",
        })
        await websocket.close(code=1008)
        return

    dm = _get_data_manager(websocket)

    if dm is not None:
        # ── New architecture: DataManager-powered stream ─────
        await _dm_single_stream(websocket, dm, symbol, interval)
    else:
        # ── Legacy fallback: direct Binance WS ──────────────
        await _legacy_single_stream(websocket, symbol, interval)


@router.websocket("/klines_multi")
async def kline_stream_multi(
    websocket: WebSocket,
    symbol: str = Query("BTCUSDT"),
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
    await websocket.accept()
    await websocket.send_json({"type": "connected", "symbol": symbol})

    dm = _get_data_manager(websocket)

    if dm is not None:
        await _dm_multi_stream(websocket, dm, symbol)
    else:
        await _legacy_multi_stream(websocket, symbol)


# ═══════════════════════════════════════════════════════════════
#  DataManager-powered WebSocket handlers
# ═══════════════════════════════════════════════════════════════


async def _dm_single_stream(
    websocket: WebSocket, dm, symbol: str, interval: str,
) -> None:
    """Stream bars for a single interval using DataManager's EventBus."""
    from app.data_engine.data_manager.models import DataEventType

    try:
        # Ensure the ingestion pipeline is running
        await dm.ensure_stream(symbol, interval)

        await websocket.send_json({
            "type": "subscribed",
            "symbol": symbol,
            "interval": interval,
        })

        # Create a task for reading client messages (ping/pong)
        client_task = asyncio.create_task(
            _read_client_messages(websocket),
            name="ws_client_reader",
        )

        # Subscribe to DataManager events via async iterator
        stream_task = asyncio.create_task(
            _forward_events_to_ws(
                websocket, dm, symbol, [interval],
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
) -> None:
    """Multi-interval stream using DataManager's EventBus."""
    from app.data_engine.data_manager.models import DataEventType

    active_intervals: set[str] = set()
    # Queue for forwarding events
    event_queue: asyncio.Queue = asyncio.Queue(maxsize=1000)
    subscriptions = []  # list of SubscriptionHandle

    async def _event_callback(event):
        """Push events into the queue for the forwarder."""
        try:
            # Handle backfill completion events specially
            if event.event_type == DataEventType.BACKFILL_COMPLETED:
                backfill_msg = {
                    "type": "backfill_completed",
                    "symbol": event.key.symbol,
                    "interval": event.key.interval,
                    "detail": event.detail or {},
                }
                await asyncio.wait_for(
                    event_queue.put(backfill_msg), timeout=1.0,
                )
                return

            bar_dict = {
                "type": "kline",
                "symbol": event.key.symbol,
                "interval": event.key.interval,
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
            while True:
                msg = await event_queue.get()
                try:
                    await websocket.send_json(msg)
                except Exception:
                    return

        forwarder_task = asyncio.create_task(_forwarder(), name="ws_forwarder")

        # Main loop: read client commands
        try:
            while True:
                raw = await websocket.receive_text()
                stripped = raw.strip().lower()

                if stripped == "ping":
                    await websocket.send_text("pong")
                    continue

                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    await websocket.send_json({"type": "error", "detail": "Invalid JSON"})
                    continue

                action = msg.get("action", "").lower()
                intervals = msg.get("intervals", [])

                if not isinstance(intervals, list) or not intervals:
                    await websocket.send_json({
                        "type": "error",
                        "detail": "intervals must be a non-empty list",
                    })
                    continue

                # Validate intervals (support both native and custom)
                valid = [i for i in intervals if _validate_ws_interval(i)]
                invalid = [i for i in intervals if not _validate_ws_interval(i)]

                if invalid:
                    await websocket.send_json({
                        "type": "warning",
                        "detail": f"Skipped invalid intervals: {invalid}",
                    })

                if not valid:
                    await websocket.send_json({
                        "type": "error",
                        "detail": "No valid intervals provided",
                    })
                    continue

                if action == "subscribe":
                    for iv in valid:
                        if iv not in active_intervals:
                            await dm.ensure_stream(symbol, iv)
                            handle = dm.subscribe(
                                callback=_event_callback,
                                symbol=symbol,
                                interval=iv,
                                event_types={
                                    DataEventType.BAR_CREATED,
                                    DataEventType.BAR_UPDATED,
                                    DataEventType.BAR_CLOSED,
                                    DataEventType.BACKFILL_COMPLETED,
                                },
                            )
                            subscriptions.append(handle)
                            active_intervals.add(iv)

                    await websocket.send_json({
                        "type": "subscribed",
                        "symbol": symbol,
                        "intervals": valid,
                    })

                elif action == "unsubscribe":
                    for iv in valid:
                        active_intervals.discard(iv)
                    await websocket.send_json({
                        "type": "unsubscribed",
                        "symbol": symbol,
                        "intervals": valid,
                    })

                else:
                    await websocket.send_json({
                        "type": "error",
                        "detail": f"Unknown action: {action}",
                    })

        except WebSocketDisconnect:
            pass

        forwarder_task.cancel()
        try:
            await forwarder_task
        except (asyncio.CancelledError, Exception):
            pass

    finally:
        # Clean up all subscriptions
        for handle in subscriptions:
            try:
                dm.unsubscribe(handle)
            except Exception:
                pass


async def _forward_events_to_ws(
    websocket: WebSocket, dm, symbol: str, intervals: list[str],
) -> None:
    """Forward DataManager events to a WebSocket client."""
    from app.data_engine.data_manager.models import DataEventType

    for interval in intervals:
        # Use subscribe_iter for clean async iteration
        async for event in dm.subscribe_iter(
            symbol=symbol,
            interval=interval,
            event_types={
                DataEventType.BAR_CREATED,
                DataEventType.BAR_UPDATED,
                DataEventType.BAR_CLOSED,
            },
        ):
            bar_dict = {
                "type": "kline",
                "symbol": event.key.symbol,
                "interval": event.key.interval,
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


# ═══════════════════════════════════════════════════════════════
#  Legacy Fallback (direct Binance WS — when DataManager not set)
# ═══════════════════════════════════════════════════════════════


async def _legacy_single_stream(
    websocket: WebSocket, symbol: str, interval: str,
) -> None:
    """Legacy single-interval stream using KlineStreamHub."""
    from app.realtime import kline_stream_hub

    if interval not in VALID_INTERVALS:
        await websocket.send_json({
            "type": "error",
            "detail": f"Legacy mode only supports native intervals: {VALID_INTERVALS}",
        })
        await websocket.close(code=1008)
        return

    await kline_stream_hub.subscribe(
        websocket=websocket, symbol=symbol, interval=interval,
    )
    await websocket.send_json({
        "type": "subscribed",
        "symbol": symbol,
        "interval": interval,
    })

    try:
        while True:
            message = await websocket.receive_text()
            if message.lower().strip() == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        await kline_stream_hub.remove_websocket(websocket)
    except Exception:
        await kline_stream_hub.remove_websocket(websocket)
        try:
            await websocket.close()
        except Exception:
            pass


async def _legacy_multi_stream(
    websocket: WebSocket, symbol: str,
) -> None:
    """Legacy multi-interval stream using KlineStreamHub."""
    from app.realtime import kline_stream_hub

    try:
        while True:
            raw = await websocket.receive_text()
            stripped = raw.strip().lower()

            if stripped == "ping":
                await websocket.send_text("pong")
                continue

            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_json({"type": "error", "detail": "Invalid JSON"})
                continue

            action = msg.get("action", "").lower()
            intervals = msg.get("intervals", [])

            if not isinstance(intervals, list) or not intervals:
                await websocket.send_json({
                    "type": "error",
                    "detail": "intervals must be a non-empty list",
                })
                continue

            valid = [i for i in intervals if i in VALID_INTERVALS]
            invalid = [i for i in intervals if i not in VALID_INTERVALS]

            if invalid:
                await websocket.send_json({
                    "type": "warning",
                    "detail": f"Skipped non-native intervals: {invalid}",
                })

            if not valid:
                await websocket.send_json({
                    "type": "error",
                    "detail": "No valid intervals provided",
                })
                continue

            if action == "subscribe":
                await kline_stream_hub.subscribe_multi(
                    websocket=websocket, symbol=symbol, intervals=valid,
                )
                await websocket.send_json({
                    "type": "subscribed",
                    "symbol": symbol,
                    "intervals": valid,
                })
            elif action == "unsubscribe":
                await kline_stream_hub.unsubscribe_multi(
                    websocket=websocket, symbol=symbol, intervals=valid,
                )
                await websocket.send_json({
                    "type": "unsubscribed",
                    "symbol": symbol,
                    "intervals": valid,
                })
            else:
                await websocket.send_json({
                    "type": "error",
                    "detail": f"Unknown action: {action}",
                })

    except WebSocketDisconnect:
        await kline_stream_hub.remove_websocket(websocket)
    except Exception:
        await kline_stream_hub.remove_websocket(websocket)
        try:
            await websocket.close()
        except Exception:
            pass
