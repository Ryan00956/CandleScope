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
from typing import Any

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from app.core import config
from app.exchanges import bootstrap_default_adapters, get_exchange_registry
from app.core.market import VALID_INTERVALS, parse_custom_interval
from app.indicator import registry as indicator_registry
from app.indicator.custom_store import CustomIndicatorStore
from app.indicator.errors import error_detail
from app.indicator.events import IndicatorEvent, IndicatorEventType
from app.indicator.pyne.executor import execute_pyne_script
from app.indicator.serialization import (
    build_indicator_snapshot_payload,
    build_pyne_snapshot_payload,
    build_ws_error_payload,
)

router = APIRouter(prefix="/stream", tags=["stream"])
_stream_custom_store = CustomIndicatorStore()


def _validate_ws_interval(interval: str) -> bool:
    """Check if interval is valid (native or custom)."""
    if interval in VALID_INTERVALS:
        return True
    parsed = parse_custom_interval(interval)
    return parsed is not None and parsed > 0


def _get_data_manager(websocket: WebSocket):
    """Get DataManager from app state."""
    return getattr(websocket.app.state, "data_manager", None)


def _get_indicator_engine(websocket: WebSocket):
    """Get IndicatorEngine from app state."""
    return getattr(websocket.app.state, "indicator_engine", None)


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
        await websocket.send_json({
            "type": "error",
            "code": "INDICATOR_STREAM_NOT_READY",
            "detail": "DataManager or IndicatorEngine not initialized.",
        })
        await websocket.close(code=1013)
        return

    await _indicator_stream_loop(websocket, dm, indicator_engine)


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
    subscriptions = {}  # interval -> SubscriptionHandle
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
                            subscriptions[iv] = handle
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
                        handle = subscriptions.pop(iv, None)
                        if handle is not None:
                            try:
                                dm.unsubscribe(handle)
                            except Exception:
                                pass
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
        for handle in list(subscriptions.values()):
            try:
                dm.unsubscribe(handle)
            except Exception:
                pass
        subscriptions.clear()


async def _indicator_stream_loop(websocket: WebSocket, dm, indicator_engine) -> None:
    """Handle a multi-indicator WS connection."""
    queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=max(int(config.INDICATOR_WS_QUEUE_SIZE), 1))
    subscribed: dict[str, Any] = {}
    custom_handles: dict[str, Any] = {}
    custom_tasks: dict[str, asyncio.Task] = {}
    client_meta: dict[str, dict] = {}
    ws_closed = False
    seq = 0

    loop = asyncio.get_running_loop()

    def _listener(event: IndicatorEvent) -> None:
        if ws_closed:
            return
        for client_id, key in list(subscribed.items()):
            if key != event.key:
                continue
            meta = client_meta.get(client_id, {})
            msg = _indicator_event_to_ws_message(client_id, event, meta)
            if msg is not None:
                loop.call_soon_threadsafe(_queue_indicator_message, queue, msg)

    indicator_engine.add_listener(_listener)

    def _with_seq(data: dict) -> dict:
        nonlocal seq
        seq += 1
        return {"seq": seq, **data}

    async def _safe_send_json(data: dict) -> bool:
        nonlocal ws_closed
        if ws_closed:
            return False
        try:
            await websocket.send_json(_with_seq(data))
            return True
        except Exception:
            ws_closed = True
            return False

    async def _safe_send_text(data: str) -> bool:
        nonlocal ws_closed
        if ws_closed:
            return False
        try:
            await websocket.send_text(data)
            return True
        except Exception:
            ws_closed = True
            return False

    async def _forwarder() -> None:
        while not ws_closed:
            msg = await queue.get()
            if not await _safe_send_json(msg):
                return

    async def _heartbeat() -> None:
        interval = float(config.INDICATOR_WS_HEARTBEAT_SECONDS)
        if interval <= 0:
            return
        while not ws_closed:
            await asyncio.sleep(interval)
            if not await _safe_send_json({
                "type": "heartbeat",
                "stream": "indicators",
                "queueSize": queue.qsize(),
                "subscriptions": len(subscribed) + len(custom_handles),
            }):
                return

    forwarder_task = asyncio.create_task(_forwarder(), name="indicator_ws_forwarder")
    heartbeat_task = asyncio.create_task(_heartbeat(), name="indicator_ws_heartbeat")

    try:
        await _safe_send_json({"type": "connected", "stream": "indicators"})

        while not ws_closed:
            raw = await websocket.receive_text()
            if raw.strip().lower() == "ping":
                if not await _safe_send_text("pong"):
                    break
                continue

            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await _safe_send_json(build_ws_error_payload(
                    "INVALID_JSON",
                    "Invalid JSON command.",
                    hint="WebSocket 命令必须是合法 JSON 对象。",
                ))
                continue

            action = str(msg.get("action", "")).strip().lower()
            if action == "subscribe":
                await _handle_indicator_subscribe(
                    websocket=websocket,
                    dm=dm,
                    indicator_engine=indicator_engine,
                    subscribed=subscribed,
                    custom_handles=custom_handles,
                    custom_tasks=custom_tasks,
                    queue=queue,
                    client_meta=client_meta,
                    send_json=_safe_send_json,
                    msg=msg,
                )
            elif action == "unsubscribe":
                client_id = str(msg.get("clientId") or "").strip()
                _unsubscribe_indicator_client(
                    client_id,
                    dm=dm,
                    indicator_engine=indicator_engine,
                    subscribed=subscribed,
                    custom_handles=custom_handles,
                    custom_tasks=custom_tasks,
                    client_meta=client_meta,
                )
                await _safe_send_json({
                    "type": "indicator.unsubscribed",
                    "clientId": client_id,
                })
            else:
                await _safe_send_json(build_ws_error_payload(
                    "UNKNOWN_ACTION",
                    f"Unknown action: {action}",
                    hint="指标 WS 当前支持 subscribe、unsubscribe。",
                ))

    except WebSocketDisconnect:
        ws_closed = True
    finally:
        ws_closed = True
        forwarder_task.cancel()
        heartbeat_task.cancel()
        try:
            await forwarder_task
        except (asyncio.CancelledError, Exception):
            pass
        try:
            await heartbeat_task
        except (asyncio.CancelledError, Exception):
            pass
        indicator_engine.remove_listener(_listener)
        for key in list(subscribed.values()):
            try:
                indicator_engine.unsubscribe(key)
            except Exception:
                pass
        subscribed.clear()
        for handle in list(custom_handles.values()):
            try:
                dm.unsubscribe(handle)
            except Exception:
                pass
        for task in list(custom_tasks.values()):
            task.cancel()
        custom_handles.clear()
        custom_tasks.clear()
        client_meta.clear()


async def _handle_indicator_subscribe(
    websocket: WebSocket,
    dm,
    indicator_engine,
    subscribed: dict[str, Any],
    custom_handles: dict[str, Any],
    custom_tasks: dict[str, asyncio.Task],
    queue: asyncio.Queue,
    client_meta: dict[str, dict],
    send_json,
    msg: dict,
) -> None:
    client_id = str(msg.get("clientId") or "").strip()
    symbol = str(msg.get("symbol") or "BTCUSDT").upper().strip()
    interval = str(msg.get("interval") or "1m").strip()
    exchange = _normalize_exchange(str(msg.get("exchange") or "binance"))
    market_type = _normalize_market_type(str(msg.get("market_type") or msg.get("marketType") or "spot"))
    indicator_name = str(msg.get("name") or msg.get("indicator") or "").upper().strip()
    params = msg.get("params") if isinstance(msg.get("params"), dict) else {}
    history_limit = int(msg.get("historyLimit") or 500)
    history_limit = min(max(history_limit, 1), 5000)
    kind = str(msg.get("kind") or "").strip().lower()
    script = msg.get("script") if isinstance(msg.get("script"), str) else ""
    custom_id = str(
        msg.get("customId")
        or msg.get("customIndicatorId")
        or ""
    ).strip()
    is_script = kind in {"script", "custom", "pyne"} or bool(custom_id) or (script and not indicator_name)

    if not client_id:
        await send_json(build_ws_error_payload(
            "INDICATOR_CLIENT_ID_REQUIRED",
            "clientId is required.",
            hint="每个指标订阅都需要稳定 clientId，用于后续更新和取消订阅。",
        ))
        return
    is_existing_client = (
        client_id in subscribed
        or client_id in custom_handles
        or client_id in client_meta
    )
    if not is_existing_client and len(client_meta) >= int(config.INDICATOR_WS_MAX_SUBSCRIPTIONS):
        await send_json(build_ws_error_payload(
            "INDICATOR_SUBSCRIPTION_LIMIT",
            f"Too many indicator subscriptions (max {config.INDICATOR_WS_MAX_SUBSCRIPTIONS}).",
            client_id=client_id,
            hint="请减少同一 WS 连接上的指标数量，或调大 INDICATOR_WS_MAX_SUBSCRIPTIONS。",
        ))
        return
    if is_script:
        await _handle_pyne_indicator_subscribe(
            websocket=websocket,
            dm=dm,
            indicator_engine=indicator_engine,
            subscribed=subscribed,
            custom_handles=custom_handles,
            custom_tasks=custom_tasks,
            queue=queue,
            client_meta=client_meta,
            client_id=client_id,
            symbol=symbol,
            interval=interval,
            exchange=exchange,
            market_type=market_type,
            name=str(msg.get("displayName") or msg.get("name") or client_id),
            custom_id=custom_id,
            script=script,
            params=params,
            security_mode=msg.get("securityMode"),
            history_limit=history_limit,
            send_json=send_json,
        )
        return
    if not indicator_name:
        await send_json(build_ws_error_payload(
            "INDICATOR_NAME_REQUIRED",
            "Builtin indicator name is required.",
            client_id=client_id,
            hint="builtin 订阅需要传 name，例如 MA、MACD、RSI。",
        ))
        return
    if not _validate_ws_interval(interval):
        await send_json(build_ws_error_payload(
            "INVALID_INTERVAL",
            f"Unsupported interval: {interval}.",
            client_id=client_id,
            hint="请使用后端支持的原生或自定义周期。",
        ))
        return
    if indicator_registry.get(indicator_name) is None:
        await send_json(build_ws_error_payload(
            "INDICATOR_NOT_FOUND",
            f"Unknown builtin indicator: {indicator_name}.",
            client_id=client_id,
            hint="请检查指标名称是否存在于 /api/v1/indicators/registry。",
        ))
        return

    _unsubscribe_indicator_client(
        client_id,
        dm=dm,
        indicator_engine=indicator_engine,
        subscribed=subscribed,
        custom_handles=custom_handles,
        custom_tasks=custom_tasks,
        client_meta=client_meta,
    )

    await dm.ensure_stream(symbol, interval, exchange=exchange, market_type=market_type)
    query_result = dm.query_latest(
        symbol,
        interval,
        limit=history_limit,
        exchange=exchange,
        market_type=market_type,
    )

    key, result = indicator_engine.subscribe(
        symbol=symbol,
        interval=interval,
        market_type=market_type,
        indicator_name=indicator_name,
        params=params,
        bars=query_result.bars,
        exchange=exchange,
    )
    subscribed[client_id] = key
    client_meta[client_id] = {
        "exchange": exchange,
        "symbol": symbol,
        "interval": interval,
        "market_type": market_type,
    }

    await send_json(build_indicator_snapshot_payload(
        client_id=client_id,
        indicator_id=key.uid,
        exchange=key.exchange,
        symbol=symbol,
        interval=interval,
        market_type=market_type,
        name=indicator_name,
        params=params,
        result=result,
    ))


async def _handle_pyne_indicator_subscribe(
    websocket: WebSocket,
    dm,
    indicator_engine,
    subscribed: dict[str, Any],
    custom_handles: dict[str, Any],
    custom_tasks: dict[str, asyncio.Task],
    queue: asyncio.Queue,
    client_meta: dict[str, dict],
    client_id: str,
    symbol: str,
    interval: str,
    exchange: str,
    market_type: str,
    name: str,
    custom_id: str,
    script: str,
    params: dict[str, Any],
    security_mode: str | None,
    history_limit: int,
    send_json,
) -> None:
    if custom_id and not script.strip():
        try:
            record = _stream_custom_store.get(custom_id)
        except ValueError as exc:
            await send_json(build_ws_error_payload(
                "CUSTOM_INDICATOR_STORE_ERROR",
                str(exc),
                client_id=client_id,
                hint="自定义指标存储文件无法读取，请检查本地 custom_indicators.json。",
            ))
            return
        if record is None:
            await send_json(build_ws_error_payload(
                "CUSTOM_INDICATOR_NOT_FOUND",
                f"Custom indicator '{custom_id}' not found.",
                client_id=client_id,
                hint="请确认该自定义指标已经保存到后端。",
            ))
            return
        script = str(record.get("script") or "")
        name = name or str(record.get("name") or custom_id)
        if not params:
            params = record.get("params") if isinstance(record.get("params"), dict) else {}
        if security_mode is None:
            security_mode = record.get("securityMode")

    if not script.strip():
        await send_json(build_ws_error_payload(
            "PYNE_SCRIPT_REQUIRED",
            "Pyne script is required.",
            client_id=client_id,
            hint="script/custom/pyne 订阅需要传入脚本文本。",
        ))
        return
    if not _validate_ws_interval(interval):
        await send_json(build_ws_error_payload(
            "INVALID_INTERVAL",
            f"Unsupported interval: {interval}.",
            client_id=client_id,
            hint="请使用后端支持的原生或自定义周期。",
        ))
        return

    _unsubscribe_indicator_client(
        client_id,
        dm=dm,
        indicator_engine=indicator_engine,
        subscribed=subscribed,
        custom_handles=custom_handles,
        custom_tasks=custom_tasks,
        client_meta=client_meta,
    )

    await dm.ensure_stream(symbol, interval, exchange=exchange, market_type=market_type)
    meta = {
        "kind": "script",
        "exchange": exchange,
        "symbol": symbol,
        "interval": interval,
        "market_type": market_type,
        "name": name,
        "customId": custom_id or None,
        "script": script,
        "params": params,
        "securityMode": security_mode,
        "historyLimit": history_limit,
    }
    client_meta[client_id] = meta

    initial = await _compute_pyne_snapshot_message_async(client_id, dm, meta)
    await send_json(initial)

    from app.data_engine.data_manager.models import DataEventType

    async def _on_data_event(event) -> None:
        existing = custom_tasks.get(client_id)
        if existing is not None and not existing.done():
            existing.cancel()

        async def _run() -> None:
            msg = await _compute_pyne_snapshot_message_async(
                client_id,
                dm,
                meta,
                bar_time=event.bar.time if event.bar else 0,
            )
            _queue_indicator_message(queue, msg)

        custom_tasks[client_id] = asyncio.create_task(_run(), name=f"pyne_indicator_{client_id}")

    handle = dm.subscribe(
        callback=_on_data_event,
        symbol=symbol,
        interval=interval,
        exchange=exchange,
        market_type=market_type,
        event_types={
            DataEventType.BAR_UPDATED,
            DataEventType.BAR_CLOSED,
            DataEventType.BACKFILL_COMPLETED,
        },
    )
    custom_handles[client_id] = handle


def _unsubscribe_indicator_client(
    client_id: str,
    dm,
    indicator_engine,
    subscribed: dict[str, Any],
    custom_handles: dict[str, Any],
    custom_tasks: dict[str, asyncio.Task],
    client_meta: dict[str, dict],
) -> None:
    key = subscribed.pop(client_id, None)
    if key is not None and indicator_engine is not None:
        indicator_engine.unsubscribe(key)

    handle = custom_handles.pop(client_id, None)
    if handle is not None:
        try:
            dm.unsubscribe(handle)
        except Exception:
            pass

    task = custom_tasks.pop(client_id, None)
    if task is not None:
        task.cancel()

    client_meta.pop(client_id, None)


def _compute_pyne_snapshot_message(
    client_id: str,
    dm,
    meta: dict,
    bar_time: int = 0,
) -> dict:
    query_result = dm.query_latest(
        meta["symbol"],
        meta["interval"],
        limit=meta["historyLimit"],
        exchange=meta["exchange"],
        market_type=meta["market_type"],
    )
    ohlcv = [bar.to_dict() for bar in query_result.bars]
    result = execute_pyne_script(
        script=meta["script"],
        ohlcv=ohlcv,
        params=meta["params"],
        security_mode=meta.get("securityMode"),
    )
    return build_pyne_snapshot_payload(
        client_id=client_id,
        indicator_id=f"pyne:{meta['exchange']}:{meta['market_type']}:{meta['symbol']}:{meta['interval']}:{client_id}",
        exchange=meta["exchange"],
        symbol=meta["symbol"],
        interval=meta["interval"],
        market_type=meta["market_type"],
        name=meta["name"],
        params=meta["params"],
        result=result,
        bar_time=bar_time,
    )


async def _compute_pyne_snapshot_message_async(
    client_id: str,
    dm,
    meta: dict,
    bar_time: int = 0,
) -> dict:
    """Compute a Pyne snapshot off the event loop."""
    return await asyncio.to_thread(
        _compute_pyne_snapshot_message,
        client_id,
        dm,
        meta,
        bar_time,
    )


def _queue_indicator_message(queue: asyncio.Queue, msg: dict) -> None:
    try:
        queue.put_nowait(msg)
    except asyncio.QueueFull:
        if msg.get("type") != "indicator.preview":
            return
        _coalesce_indicator_preview(queue, msg)


def _coalesce_indicator_preview(queue: asyncio.Queue, msg: dict) -> None:
    """Replace an older preview for the same client when the WS queue is full."""
    client_id = msg.get("clientId")
    if not client_id:
        return

    kept: list[dict] = []
    removed = False
    while True:
        try:
            item = queue.get_nowait()
        except asyncio.QueueEmpty:
            break
        if (
            not removed
            and item.get("type") == "indicator.preview"
            and item.get("clientId") == client_id
        ):
            removed = True
            continue
        kept.append(item)

    for item in kept:
        try:
            queue.put_nowait(item)
        except asyncio.QueueFull:
            break

    if removed:
        try:
            queue.put_nowait(msg)
        except asyncio.QueueFull:
            pass


def _indicator_event_to_ws_message(
    client_id: str,
    event: IndicatorEvent,
    meta: dict,
) -> dict | None:
    base = {
        "clientId": client_id,
        "indicatorId": event.key.uid,
        "exchange": event.key.exchange,
        "symbol": event.key.symbol,
        "interval": event.key.interval,
        "market_type": event.key.market_type,
        "barTime": event.bar_timestamp,
        "timestampMs": event.timestamp_ms,
    }

    if event.event_type == IndicatorEventType.INDICATOR_PREVIEW:
        return {**base, "type": "indicator.preview", "values": event.values}
    if event.event_type == IndicatorEventType.INDICATOR_UPDATED:
        return {**base, "type": "indicator.update", "values": event.values}
    if event.event_type == IndicatorEventType.INDICATOR_RECOMPUTED:
        result = event.full_result
        return build_indicator_snapshot_payload(
            client_id=client_id,
            indicator_id=event.key.uid,
            exchange=event.key.exchange,
            symbol=event.key.symbol,
            interval=event.key.interval,
            market_type=event.key.market_type,
            name=event.key.indicator_name,
            params=dict(event.key.params),
            result=result,
            bar_time=event.bar_timestamp,
        )
    if event.event_type == IndicatorEventType.INDICATOR_ERROR:
        message = str(event.detail or "Indicator compute error")
        return {
            **base,
            "type": "indicator.error",
            "code": "INDICATOR_COMPUTE_ERROR",
            "error": message,
            "detail": event.detail,
            "errorDetail": error_detail(
                "INDICATOR_COMPUTE_ERROR",
                message,
                hint="指标增量计算失败。请检查参数和最近 K 线数据。",
            ),
        }
    return None


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
