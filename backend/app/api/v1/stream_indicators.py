"""Indicator and Pyne WebSocket handlers backed by DataManager events."""
from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from app.api.v1.stream_indicator_payloads import (
    _handle_indicator_range_request,
    _indicator_event_to_ws_message,
    _release_pyne_incremental_meta,
)
from app.api.v1.stream_pyne_subscriptions import handle_pyne_indicator_subscribe
from app.api.v1.stream_utils import (
    normalize_exchange as _normalize_exchange,
    normalize_market_type as _normalize_market_type,
    send_json_with_timeout as _send_json_with_timeout,
    send_text_with_timeout as _send_text_with_timeout,
    validate_ws_interval as _validate_ws_interval,
)
from app.core import config
from app.core.runtime_metrics import ws_runtime_metrics
from app.indicator import registry as indicator_registry
from app.indicator.events import IndicatorEvent
from app.indicator.serialization import (
    build_indicator_snapshot_payload,
    build_ws_error_payload,
)


async def stream_indicators(websocket: WebSocket, dm, indicator_engine) -> None:
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
            await _send_json_with_timeout(websocket, _with_seq(data))
            return True
        except Exception:
            ws_closed = True
            return False

    async def _safe_send_text(data: str) -> bool:
        nonlocal ws_closed
        if ws_closed:
            return False
        try:
            await _send_text_with_timeout(websocket, data)
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
        loop = asyncio.get_running_loop()
        next_due = loop.time() + interval
        while not ws_closed:
            await asyncio.sleep(max(0.0, next_due - loop.time()))
            now = loop.time()
            ws_runtime_metrics.record_heartbeat_delay(
                "indicators",
                max(0.0, (now - next_due) * 1000),
            )
            next_due = now + interval
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
            elif action in {"load_range", "load_before"}:
                await _handle_indicator_range_request(
                    dm=dm,
                    client_meta=client_meta,
                    client_id=str(msg.get("clientId") or "").strip(),
                    action=action,
                    msg=msg,
                    send_json=_safe_send_json,
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
                    hint="指标 WS 当前支持 subscribe、unsubscribe、load_range、load_before。",
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
        await handle_pyne_indicator_subscribe(
            dm=dm,
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
            unsubscribe_client=lambda cid: _unsubscribe_indicator_client(
                cid,
                dm=dm,
                indicator_engine=indicator_engine,
                subscribed=subscribed,
                custom_handles=custom_handles,
                custom_tasks=custom_tasks,
                client_meta=client_meta,
            ),
            queue_message=_queue_indicator_message,
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
        "kind": "builtin",
        "exchange": exchange,
        "symbol": symbol,
        "interval": interval,
        "market_type": market_type,
        "name": indicator_name,
        "params": params,
        "indicatorId": key.uid,
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

    meta = client_meta.pop(client_id, None)
    if meta is not None:
        _release_pyne_incremental_meta(meta)


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
