"""
WebSocket stream endpoints — powered by DataManager's event bus.

Data flow:
    Ingestion → BarAggregator (L1–L5) → DataManager EventBus
    → subscribe_iter() → WebSocket client

The DataManager instance is stored on ``app.state.data_manager``
and initialized during application startup (see ``app/main.py``).
"""
from __future__ import annotations

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from app.api.v1.stream_indicators import stream_indicators
from app.api.v1.stream_klines import stream_multi_kline, stream_single_kline
from app.api.v1.stream_utils import (
    normalize_exchange as _normalize_exchange,
    normalize_market_type as _normalize_market_type,
    send_json_with_timeout as _send_json_with_timeout,
    validate_ws_interval as _validate_ws_interval,
)

router = APIRouter(prefix="/stream", tags=["stream"])


def _get_data_manager(websocket: WebSocket):
    """Get DataManager from app state."""
    return getattr(websocket.app.state, "data_manager", None)


def _get_indicator_engine(websocket: WebSocket):
    """Get IndicatorEngine from app state."""
    return getattr(websocket.app.state, "indicator_engine", None)


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
        await _send_json_with_timeout(websocket, {
            "type": "error",
            "detail": f"Unsupported interval: {interval}.",
        })
        await websocket.close(code=1008)
        return

    dm = _get_data_manager(websocket)

    if dm is None:
        await _send_json_with_timeout(websocket, {
            "type": "error",
            "detail": "DataManager not initialized. Server is not ready.",
        })
        await websocket.close(code=1013)
        return

    await stream_single_kline(websocket, dm, symbol, interval, exchange=exchange, market_type=market_type)


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
        await _send_json_with_timeout(websocket, {
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
        await _send_json_with_timeout(websocket, {
            "type": "error",
            "detail": "DataManager not initialized. Server is not ready.",
        })
        await websocket.close(code=1013)
        return

    await stream_multi_kline(websocket, dm, symbol, exchange=exchange, market_type=market_type)


@router.websocket("/indicators")
async def indicator_stream(websocket: WebSocket) -> None:
    """Builtin indicator WebSocket stream.

    Client commands:
        {"action":"subscribe","clientId":"ma1","symbol":"BTCUSDT","interval":"1m",
         "name":"MA","params":{"period":20},"historyLimit":500}
        {"action":"subscribe","clientId":"custom1","kind":"script","script":"plot(close)",
         "securityMode":"safe","historyLimit":500}
        {"action":"unsubscribe","clientId":"ma1"}
        "ping" -> "pong"

    Builtin indicators are maintained incrementally by IndicatorEngine. Pyne
    scripts are backend-hosted by recomputing the latest bounded history window
    when K-line updates arrive.
    """
    await websocket.accept()

    dm = _get_data_manager(websocket)
    indicator_engine = _get_indicator_engine(websocket)
    if dm is None or indicator_engine is None:
        await _send_json_with_timeout(websocket, {
            "type": "error",
            "code": "INDICATOR_STREAM_NOT_READY",
            "detail": "DataManager or IndicatorEngine not initialized.",
        })
        await websocket.close(code=1013)
        return

    await stream_indicators(websocket, dm, indicator_engine)
