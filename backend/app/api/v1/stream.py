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
from app.api.v1.stream_liquidations import stream_liquidations
from app.api.v1.stream_market import stream_market
from app.api.v1.stream_full_order_book import stream_full_order_book
from app.api.v1.stream_order_book import stream_order_book
from app.api.v1.stream_replay import stream_replay_session
from app.api.v1.stream_trade_flow import stream_trade_flow
from app.api.v1.stream_utils import (
    normalize_exchange as _normalize_exchange,
    normalize_market_type as _normalize_market_type,
    send_json_with_timeout as _send_json_with_timeout,
    validate_ws_interval as _validate_ws_interval,
)
from app.replay.models import MAX_COUNTER

router = APIRouter(prefix="/stream", tags=["stream"])


def _get_data_manager(websocket: WebSocket):
    """Get DataManager from app state."""
    return getattr(websocket.app.state, "data_manager", None)


def _get_indicator_engine(websocket: WebSocket):
    """Get IndicatorEngine from app state."""
    return getattr(websocket.app.state, "indicator_engine", None)


@router.websocket("/replay/{session_id}")
async def replay_stream(
    websocket: WebSocket,
    session_id: str,
    after_sequence: int | None = Query(default=None, ge=0, le=MAX_COUNTER),
    data_epoch: str | None = Query(
        default=None,
        min_length=71,
        max_length=71,
        pattern=r"^sha256:[0-9a-f]{64}$",
    ),
) -> None:
    """Deliver an atomic replay snapshot/resume handoff and bounded live tail."""

    await stream_replay_session(
        websocket,
        session_id=session_id,
        after_sequence=after_sequence,
        data_epoch=data_epoch,
    )


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


@router.websocket("/market")
async def market_stream(websocket: WebSocket) -> None:
    """Multiplex Mark/Index/Funding/OI/Basis over one browser socket."""

    await websocket.accept()
    dm = _get_data_manager(websocket)
    if dm is None or not getattr(dm, "market_data_ready", False):
        await _send_json_with_timeout(websocket, {
            "type": "error",
            "code": "MARKET_STREAM_NOT_READY",
            "detail": "Advanced market data is not initialized.",
        })
        await websocket.close(code=1013)
        return
    await stream_market(websocket, dm)


@router.websocket("/trade-flow")
async def trade_flow_stream(websocket: WebSocket) -> None:
    """Deliver append-only aggregate trades over ``tradeflow.v1``."""

    await websocket.accept()
    dm = _get_data_manager(websocket)
    if dm is None or not getattr(dm, "trade_flow_ready", False):
        await _send_json_with_timeout(websocket, {
            "type": "error",
            "code": "TRADE_FLOW_STREAM_NOT_READY",
            "detail": "Trade-flow market data is not initialized.",
        })
        await websocket.close(code=1013)
        return
    await stream_trade_flow(websocket, dm)


@router.websocket("/liquidations")
async def liquidation_stream(websocket: WebSocket) -> None:
    """Deliver sampled public liquidation observations over ``liquidation.v1``."""

    await websocket.accept()
    dm = _get_data_manager(websocket)
    if dm is None or not getattr(dm, "liquidation_ready", False):
        await _send_json_with_timeout(websocket, {
            "type": "error",
            "code": "LIQUIDATION_STREAM_NOT_READY",
            "detail": "Liquidation market data is not initialized.",
        })
        await websocket.close(code=1013)
        return
    await stream_liquidations(websocket, dm)


@router.websocket("/order-book")
async def order_book_stream(websocket: WebSocket) -> None:
    """Deliver replaceable Partial Top-N snapshots over ``orderbook.v1``."""

    await websocket.accept()
    dm = _get_data_manager(websocket)
    if dm is None or not getattr(dm, "order_book_ready", False):
        await _send_json_with_timeout(websocket, {
            "type": "error",
            "code": "ORDER_BOOK_STREAM_NOT_READY",
            "detail": "Order-book market data is not initialized.",
        })
        await websocket.close(code=1013)
        return
    await stream_order_book(websocket, dm)


@router.websocket("/full-order-book")
async def full_order_book_stream(websocket: WebSocket) -> None:
    """Deliver atomic projections of a strictly reconstructed local L2 book."""

    await websocket.accept()
    dm = _get_data_manager(websocket)
    if dm is None or not getattr(dm, "full_order_book_ready", False):
        await _send_json_with_timeout(websocket, {
            "type": "error",
            "code": "FULL_ORDER_BOOK_STREAM_NOT_READY",
            "detail": "Full order-book market data is not initialized.",
        })
        await websocket.close(code=1013)
        return
    await stream_full_order_book(websocket, dm)
