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
