import json

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from app.core.market import VALID_INTERVALS
from app.realtime import kline_stream_hub

router = APIRouter(prefix="/stream", tags=["stream"])


@router.websocket("/klines")
async def kline_stream(
    websocket: WebSocket,
    symbol: str = Query("BTCUSDT"),
    interval: str = Query("1m"),
) -> None:
    symbol = symbol.upper().strip()
    interval = interval.strip()

    await websocket.accept()
    if interval not in VALID_INTERVALS:
        await websocket.send_json(
            {
                "type": "error",
                "detail": f"Unsupported interval: {interval}. Supported: {VALID_INTERVALS}",
            }
        )
        await websocket.close(code=1008)
        return

    await kline_stream_hub.subscribe(websocket=websocket, symbol=symbol, interval=interval)
    await websocket.send_json(
        {
            "type": "subscribed",
            "symbol": symbol,
            "interval": interval,
        }
    )

    try:
        while True:
            message = await websocket.receive_text()
            if message.lower().strip() == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        await kline_stream_hub.remove_websocket(websocket)
    except Exception:  # noqa: BLE001
        await kline_stream_hub.remove_websocket(websocket)
        try:
            await websocket.close()
        except Exception:  # noqa: BLE001
            pass


@router.websocket("/klines_multi")
async def kline_stream_multi(
    websocket: WebSocket,
    symbol: str = Query("BTCUSDT"),
) -> None:
    """Multi-interval WebSocket endpoint.

    The client connects once and sends JSON commands to subscribe/unsubscribe
    to multiple intervals.  All kline data for all subscribed intervals flows
    through this single connection, tagged with `interval` so the client can
    route each message to the correct cache.

    Commands:
        {"action": "subscribe", "intervals": ["1m", "5m", "15m", "1h", "4h", "1d"]}
        {"action": "unsubscribe", "intervals": ["1m"]}
        "ping"  -> responds "pong"
    """
    symbol = symbol.upper().strip()
    await websocket.accept()
    await websocket.send_json({"type": "connected", "symbol": symbol})

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
                await websocket.send_json({"type": "error", "detail": "intervals must be a non-empty list"})
                continue

            # Filter to valid native intervals only
            valid = [i for i in intervals if i in VALID_INTERVALS]
            invalid = [i for i in intervals if i not in VALID_INTERVALS]

            if invalid:
                await websocket.send_json({
                    "type": "warning",
                    "detail": f"Skipped non-native intervals: {invalid}",
                })

            if not valid:
                await websocket.send_json({"type": "error", "detail": "No valid intervals provided"})
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
                await websocket.send_json({"type": "error", "detail": f"Unknown action: {action}"})

    except WebSocketDisconnect:
        await kline_stream_hub.remove_websocket(websocket)
    except Exception:  # noqa: BLE001
        await kline_stream_hub.remove_websocket(websocket)
        try:
            await websocket.close()
        except Exception:  # noqa: BLE001
            pass
