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
import hashlib
import json
from typing import Any

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from app.core import config
from app.core.executors import run_indicator, run_pyne_wait
from app.core.runtime_metrics import ws_runtime_metrics
from app.exchanges import bootstrap_default_adapters, get_exchange_registry
from app.core.market import VALID_INTERVALS, parse_custom_interval
from app.data_engine.interval_policy import parse_interval_ms
from app.indicator import create_engine, registry as indicator_registry
from app.indicator.custom_store import CustomIndicatorStore
from app.indicator.errors import error_detail
from app.indicator.events import IndicatorEvent, IndicatorEventType
from app.indicator.pyne import (
    PyneIncrementalSession,
    PyneIncrementalSessionManager,
    PyneResult,
    SharedPyneIncrementalSession,
    is_incremental_pyne_script,
)
from app.indicator.pyne.executor import execute_pyne_script
from app.indicator.pyne.security import PyneSecurityError, PyneTimeoutError
from app.indicator.serialization import (
    build_indicator_snapshot_payload,
    build_pyne_snapshot_payload,
    build_ws_error_payload,
)

router = APIRouter(prefix="/stream", tags=["stream"])
_stream_custom_store = CustomIndicatorStore()
_pyne_incremental_sessions = PyneIncrementalSessionManager()
INDICATOR_DEFAULT_PAGE_BARS = 500
INDICATOR_MAX_RANGE_BARS = 5000


def _ws_send_timeout() -> float:
    return max(0.1, float(config.WS_SEND_TIMEOUT_SECONDS))


async def _send_json_with_timeout(websocket: WebSocket, data: dict) -> None:
    try:
        await asyncio.wait_for(websocket.send_json(data), timeout=_ws_send_timeout())
    except asyncio.TimeoutError:
        ws_runtime_metrics.record_send_timeout("json")
        raise
    except Exception:
        ws_runtime_metrics.record_send_error("json")
        raise


async def _send_text_with_timeout(websocket: WebSocket, data: str) -> None:
    try:
        await asyncio.wait_for(websocket.send_text(data), timeout=_ws_send_timeout())
    except asyncio.TimeoutError:
        ws_runtime_metrics.record_send_timeout("text")
        raise
    except Exception:
        ws_runtime_metrics.record_send_error("text")
        raise


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
        await _send_json_with_timeout(websocket, {
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

        await _send_json_with_timeout(websocket, {
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
            await _send_json_with_timeout(websocket, data)
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
            await _send_text_with_timeout(websocket, data)
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


def _clamp_indicator_bars(value: Any, default: int = INDICATOR_DEFAULT_PAGE_BARS) -> int:
    try:
        bars = int(value)
    except (TypeError, ValueError):
        bars = default
    return min(max(bars, 1), INDICATOR_MAX_RANGE_BARS)


def _indicator_warmup_bars(name: str, params: dict[str, Any]) -> int:
    normalized = str(name or "").upper().strip()

    def _param_int(key: str, fallback: int) -> int:
        try:
            return max(1, int(params.get(key, fallback)))
        except (TypeError, ValueError):
            return fallback

    if normalized == "VOL":
        return 0
    if normalized in {"MA", "SMA", "BOLL"}:
        return max(0, _param_int("period", 20) - 1)
    if normalized in {"RSI", "ATR"}:
        return _param_int("period", 14) * 3
    if normalized == "EMA":
        return _param_int("period", 20) * 5
    if normalized == "MACD":
        return _param_int("slow", 26) * 5 + _param_int("signal", 9) * 3
    return _param_int("warmup", 200)


def _range_from_indicator_command(
    *,
    action: str,
    msg: dict,
    interval: str,
) -> tuple[int, int, int]:
    interval_ms = parse_interval_ms(interval)
    if interval_ms is None or interval_ms <= 0:
        raise ValueError(f"Unsupported interval: {interval}")
    interval_s = interval_ms // 1000

    if action == "load_before":
        before = int(msg.get("before") or 0)
        if before <= 0:
            raise ValueError("before must be a positive unix timestamp")
        bars = _clamp_indicator_bars(msg.get("bars"))
        end_s = before - interval_s
        start_s = end_s - (bars - 1) * interval_s
        return start_s, end_s, bars

    start_s = int(msg.get("start") or 0)
    end_s = int(msg.get("end") or 0)
    if start_s <= 0 or end_s <= 0 or start_s > end_s:
        raise ValueError("start/end must be positive unix timestamps with start <= end")
    bars = ((end_s - start_s) // interval_s) + 1
    if bars > INDICATOR_MAX_RANGE_BARS:
        raise ValueError(f"range too large: {bars} bars > {INDICATOR_MAX_RANGE_BARS}")
    return start_s, end_s, int(bars)


def _missing_overlaps_target(missing_ranges: list[Any], start_ms: int, end_ms: int) -> bool:
    for missing in missing_ranges or []:
        m_start = getattr(missing, "start_ms", None)
        m_end = getattr(missing, "end_ms", None)
        if m_start is None or m_end is None:
            continue
        if int(m_start) <= end_ms and int(m_end) >= start_ms:
            return True
    return False


def _filter_points_to_range(points: list[dict[str, Any]], start_s: int, end_s: int) -> list[dict[str, Any]]:
    filtered: list[dict[str, Any]] = []
    for point in points or []:
        try:
            ts = int(point.get("time"))
        except (TypeError, ValueError):
            continue
        if start_s <= ts <= end_s:
            filtered.append(point)
    return filtered


def _filter_payload_to_range(payload: dict[str, Any], start_s: int, end_s: int) -> dict[str, Any]:
    """Trim a snapshot-like indicator payload down to a range patch."""
    next_payload = dict(payload)

    if isinstance(next_payload.get("lines"), list):
        next_payload["lines"] = [
            {
                **line,
                "data": _filter_points_to_range(line.get("data") or [], start_s, end_s),
                **(
                    {"colorData": _filter_points_to_range(line.get("colorData") or [], start_s, end_s)}
                    if line.get("colorData")
                    else {}
                ),
            }
            for line in next_payload["lines"]
        ]

    if isinstance(next_payload.get("series"), list):
        series = []
        for item in next_payload["series"]:
            style = dict(item.get("style") or {})
            if style.get("colorData"):
                style["colorData"] = _filter_points_to_range(style.get("colorData") or [], start_s, end_s)
            series.append({
                **item,
                "data": _filter_points_to_range(item.get("data") or [], start_s, end_s),
                "style": style,
            })
        next_payload["series"] = series

    if isinstance(next_payload.get("annotations"), list):
        annotations = []
        for item in next_payload["annotations"]:
            data = item.get("data") or []
            if data and isinstance(data[0], dict) and "time" in data[0]:
                data = _filter_points_to_range(data, start_s, end_s)
            annotations.append({**item, "data": data})
        next_payload["annotations"] = annotations

    for key in ("markers", "bgcolors", "barcolors", "signals"):
        if isinstance(next_payload.get(key), list):
            next_payload[key] = [
                {**group, "data": _filter_points_to_range(group.get("data") or [], start_s, end_s)}
                for group in next_payload[key]
            ]

    return next_payload


def _patch_from_snapshot(
    payload: dict[str, Any],
    *,
    reason: str,
    start_s: int,
    end_s: int,
) -> dict[str, Any]:
    patch = _filter_payload_to_range(payload, start_s, end_s)
    patch.update({
        "type": "indicator.patch",
        "reason": reason,
        "range": {"start": start_s, "end": end_s},
    })
    return patch


async def _handle_indicator_range_request(
    *,
    dm,
    client_meta: dict[str, dict],
    client_id: str,
    action: str,
    msg: dict,
    send_json,
) -> None:
    if not client_id:
        await send_json(build_ws_error_payload(
            "INDICATOR_CLIENT_ID_REQUIRED",
            "clientId is required.",
            hint="load_range/load_before 需要指定已有指标订阅的 clientId。",
        ))
        return

    meta = client_meta.get(client_id)
    if meta is None:
        await send_json(build_ws_error_payload(
            "INDICATOR_CLIENT_NOT_FOUND",
            f"Indicator client '{client_id}' is not subscribed.",
            client_id=client_id,
            hint="请先 subscribe，再请求指标历史 patch。",
        ))
        return

    try:
        start_s, end_s, target_bars = _range_from_indicator_command(
            action=action,
            msg=msg,
            interval=meta["interval"],
        )
    except ValueError as exc:
        await send_json(build_ws_error_payload(
            "INVALID_INDICATOR_RANGE",
            str(exc),
            client_id=client_id,
            hint="请检查 start/end 或 before/bars 参数。",
        ))
        return

    try:
        if meta.get("kind") == "script":
            payload = await _compute_pyne_range_patch_async(client_id, dm, meta, start_s, end_s, reason=action)
        else:
            payload = await run_indicator(
                _compute_builtin_range_patch,
                client_id,
                dm,
                meta,
                start_s,
                end_s,
                action,
                target_bars,
            )
    except RuntimeError as exc:
        await send_json(build_ws_error_payload(
            "INDICATOR_RANGE_NOT_READY",
            str(exc),
            client_id=client_id,
            detail={
                "range": {"start": start_s, "end": end_s},
                "retryAfterMs": 3000,
            },
            hint="K 线历史仍在补齐，稍后重试该指标区间。",
        ))
        return
    except Exception as exc:
        await send_json(build_ws_error_payload(
            "INDICATOR_RANGE_COMPUTE_FAILED",
            str(exc),
            client_id=client_id,
            detail={"range": {"start": start_s, "end": end_s}},
            hint="指标历史区间计算失败，请检查指标参数或脚本。",
        ))
        return

    await send_json(payload)


def _query_indicator_compute_bars(
    dm,
    meta: dict[str, Any],
    start_s: int,
    end_s: int,
    *,
    warmup_bars: int,
) -> list[Any]:
    interval_ms = parse_interval_ms(meta["interval"])
    if interval_ms is None or interval_ms <= 0:
        raise ValueError(f"Unsupported interval: {meta['interval']}")
    start_ms = start_s * 1000
    end_ms = end_s * 1000
    compute_start_ms = max(0, start_ms - warmup_bars * interval_ms)
    needed = int((end_ms - compute_start_ms) // interval_ms) + 1
    result = dm.query(
        meta["symbol"],
        meta["interval"],
        start_ms=compute_start_ms,
        end_ms=end_ms,
        limit=needed + 5,
        exchange=meta["exchange"],
        market_type=meta["market_type"],
        auto_backfill=True,
    )
    if _missing_overlaps_target(result.missing_ranges, start_ms, end_ms):
        raise RuntimeError("target K-line range is still backfilling")
    bars = [bar for bar in result.bars if bar.time <= end_s]
    if not any(start_s <= bar.time <= end_s for bar in bars):
        raise RuntimeError("target K-line range is not available yet")
    return bars


def _compute_builtin_range_patch(
    client_id: str,
    dm,
    meta: dict[str, Any],
    start_s: int,
    end_s: int,
    reason: str,
    target_bars: int,
) -> dict[str, Any]:
    name = str(meta.get("name") or "").upper()
    params = meta.get("params") if isinstance(meta.get("params"), dict) else {}
    warmup = _indicator_warmup_bars(name, params)
    bars = _query_indicator_compute_bars(dm, meta, start_s, end_s, warmup_bars=warmup)

    engine = create_engine()
    result = engine.compute(
        symbol=meta["symbol"],
        interval=meta["interval"],
        market_type=meta["market_type"],
        indicator_name=name,
        params=params,
        bars=bars,
        exchange=meta["exchange"],
    )
    payload = build_indicator_snapshot_payload(
        client_id=client_id,
        indicator_id=meta.get("indicatorId") or f"{meta['exchange']}:{meta['market_type']}:{meta['symbol']}:{meta['interval']}:{name}",
        exchange=meta["exchange"],
        symbol=meta["symbol"],
        interval=meta["interval"],
        market_type=meta["market_type"],
        name=name,
        params=params,
        result=result,
    )
    patch = _patch_from_snapshot(payload, reason=reason, start_s=start_s, end_s=end_s)
    patch["warmupBars"] = warmup
    patch["targetBars"] = target_bars
    return patch


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
        "indicatorId": f"pyne:{exchange}:{market_type}:{symbol}:{interval}:{client_id}",
        "script": script,
        "params": params,
        "securityMode": security_mode,
        "historyLimit": history_limit,
    }
    try:
        incremental_script = is_incremental_pyne_script(script)
    except SyntaxError:
        incremental_script = False
    if incremental_script:
        session_key = _pyne_incremental_session_key(
            exchange=exchange,
            market_type=market_type,
            symbol=symbol,
            interval=interval,
            script=script,
            params=params,
            security_mode=security_mode,
            history_limit=history_limit,
        )
        meta["scriptMode"] = "incremental"
        meta["pyneSessionKey"] = session_key
        meta["pyneSharedSession"] = _pyne_incremental_sessions.acquire(
            session_key,
            lambda: PyneIncrementalSession(
                script=script,
                params=params,
                security_mode=security_mode,
            ),
        )
    client_meta[client_id] = meta

    initial = await _compute_pyne_snapshot_message_async(client_id, dm, meta)
    await send_json(initial)

    from app.data_engine.data_manager.models import DataEventType

    async def _on_data_event(event) -> None:
        if event.event_type == DataEventType.BACKFILL_COMPLETED:
            return

        existing = custom_tasks.get(client_id)
        if existing is not None and not existing.done():
            existing.cancel()

        async def _run() -> None:
            if meta.get("scriptMode") == "incremental" and event.bar is not None:
                msg = await _compute_incremental_pyne_bar_message_async(
                    client_id,
                    meta,
                    event.bar.to_dict(),
                    preview=event.event_type == DataEventType.BAR_UPDATED,
                )
            else:
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

    meta = client_meta.pop(client_id, None)
    if meta is not None:
        _release_pyne_incremental_meta(meta)


def _compute_pyne_snapshot_message(
    client_id: str,
    dm,
    meta: dict,
    bar_time: int = 0,
) -> dict:
    if meta.get("scriptMode") == "incremental" and not bar_time:
        return _compute_incremental_pyne_snapshot_message(client_id, dm, meta)

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
    payload = build_pyne_snapshot_payload(
        client_id=client_id,
        indicator_id=meta.get("indicatorId") or f"pyne:{meta['exchange']}:{meta['market_type']}:{meta['symbol']}:{meta['interval']}:{client_id}",
        exchange=meta["exchange"],
        symbol=meta["symbol"],
        interval=meta["interval"],
        market_type=meta["market_type"],
        name=meta["name"],
        params=meta["params"],
        result=result,
        bar_time=bar_time,
    )
    if bar_time:
        return _patch_from_snapshot(
            payload,
            reason="bar_update",
            start_s=int(bar_time),
            end_s=int(bar_time),
        )
    return payload


def _pyne_incremental_session_key(
    *,
    exchange: str,
    market_type: str,
    symbol: str,
    interval: str,
    script: str,
    params: dict[str, Any],
    security_mode: str | None,
    history_limit: int,
) -> str:
    raw = json.dumps(
        {
            "exchange": exchange,
            "marketType": market_type,
            "symbol": symbol,
            "interval": interval,
            "script": script,
            "params": params,
            "securityMode": security_mode or "",
            "historyLimit": int(history_limit),
        },
        sort_keys=True,
        default=str,
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _release_pyne_incremental_meta(meta: dict[str, Any]) -> None:
    key = meta.get("pyneSessionKey")
    if isinstance(key, str) and key:
        _pyne_incremental_sessions.release(key)


def _pyne_result_from_incremental(result) -> PyneResult:
    return PyneResult(
        ok=result.ok,
        error=result.error,
        code=result.code,
        line=result.line,
        column=result.column,
        hint=result.hint,
        lines=result.lines,
        output=result.output,
        param_schema=result.param_schema,
        meta=result.meta,
    )


def _pyne_error_result_from_exception(exc: Exception) -> PyneResult:
    if isinstance(exc, PyneTimeoutError):
        return PyneResult(
            ok=False,
            code="PYNE_TIMEOUT",
            error=str(exc),
            hint="脚本执行超时。请减少循环、缩小窗口，或调整 PYNE_EXEC_TIMEOUT_SECONDS。",
        )
    if isinstance(exc, PyneSecurityError):
        return PyneResult(
            ok=False,
            code="PYNE_SECURITY_ERROR",
            error=str(exc),
            hint="当前 Pyne 安全策略拒绝执行该脚本。",
        )
    return PyneResult(
        ok=False,
        code="PYNE_RUNTIME_ERROR",
        error=f"Script error: {exc}",
        hint="脚本运行时失败。请检查 incremental state、window、helper 和 on_bar/on_preview 逻辑。",
    )


def _build_pyne_ws_payload_from_result(
    *,
    client_id: str,
    meta: dict,
    result: PyneResult,
    bar_time: int = 0,
) -> dict:
    return build_pyne_snapshot_payload(
        client_id=client_id,
        indicator_id=meta.get("indicatorId") or f"pyne:{meta['exchange']}:{meta['market_type']}:{meta['symbol']}:{meta['interval']}:{client_id}",
        exchange=meta["exchange"],
        symbol=meta["symbol"],
        interval=meta["interval"],
        market_type=meta["market_type"],
        name=meta["name"],
        params=meta.get("params") if isinstance(meta.get("params"), dict) else {},
        result=result,
        bar_time=bar_time,
    )


def _compute_incremental_pyne_snapshot_message(
    client_id: str,
    dm,
    meta: dict,
) -> dict:
    shared = meta.get("pyneSharedSession")
    if not isinstance(shared, SharedPyneIncrementalSession):
        session = meta.get("pyneSession")
    else:
        session = None
    if shared is None and not isinstance(session, PyneIncrementalSession):
        session = PyneIncrementalSession(
            script=meta["script"],
            params=meta.get("params") if isinstance(meta.get("params"), dict) else {},
            security_mode=meta.get("securityMode"),
        )
        meta["pyneSession"] = session

    query_result = dm.query_latest(
        meta["symbol"],
        meta["interval"],
        limit=meta["historyLimit"],
        exchange=meta["exchange"],
        market_type=meta["market_type"],
    )
    ohlcv = [bar.to_dict() for bar in query_result.bars]
    try:
        if isinstance(shared, SharedPyneIncrementalSession):
            incremental_result = _pyne_incremental_sessions.seed_or_snapshot(shared, ohlcv)
        else:
            incremental_result = session.seed(ohlcv)
        result = _pyne_result_from_incremental(incremental_result)
    except Exception as exc:
        result = _pyne_error_result_from_exception(exc)
    return _build_pyne_ws_payload_from_result(client_id=client_id, meta=meta, result=result)


def _compute_incremental_pyne_bar_message(
    client_id: str,
    meta: dict,
    bar: dict[str, Any],
    *,
    preview: bool,
) -> dict:
    shared = meta.get("pyneSharedSession")
    try:
        if isinstance(shared, SharedPyneIncrementalSession):
            incremental_result = _pyne_incremental_sessions.process_bar(shared, bar, preview=preview)
        else:
            session = meta.get("pyneSession")
            if not isinstance(session, PyneIncrementalSession):
                raise RuntimeError("incremental Pyne session is not initialized")
            incremental_result = session.on_bar_updated(bar) if preview else session.on_bar_closed(bar)
        result = _pyne_result_from_incremental(incremental_result)
    except Exception as exc:
        result = _pyne_error_result_from_exception(exc)
    bar_time = int(bar.get("time") or 0)
    payload = _build_pyne_ws_payload_from_result(
        client_id=client_id,
        meta=meta,
        result=result,
        bar_time=bar_time,
    )
    return _patch_from_snapshot(
        payload,
        reason="bar_update" if preview else "bar_closed",
        start_s=bar_time,
        end_s=bar_time,
    )


def _compute_pyne_range_patch(
    client_id: str,
    dm,
    meta: dict,
    start_s: int,
    end_s: int,
    reason: str = "load_range",
) -> dict:
    params = meta.get("params") if isinstance(meta.get("params"), dict) else {}
    warmup = _indicator_warmup_bars("PYNE", params)
    bars = _query_indicator_compute_bars(dm, meta, start_s, end_s, warmup_bars=warmup)
    if len(bars) > max(int(config.PYNE_MAX_BARS), 1):
        raise ValueError(f"Too many Pyne bars: {len(bars)} > {config.PYNE_MAX_BARS}")
    ohlcv = [bar.to_dict() for bar in bars]
    if meta.get("scriptMode") == "incremental":
        session = PyneIncrementalSession(
            script=meta["script"],
            params=params,
            security_mode=meta.get("securityMode"),
        )
        result = _pyne_result_from_incremental(session.seed(ohlcv, start_s=start_s, end_s=end_s))
    else:
        result = execute_pyne_script(
            script=meta["script"],
            ohlcv=ohlcv,
            params=params,
            security_mode=meta.get("securityMode"),
        )
    payload = build_pyne_snapshot_payload(
        client_id=client_id,
        indicator_id=meta.get("indicatorId") or f"pyne:{meta['exchange']}:{meta['market_type']}:{meta['symbol']}:{meta['interval']}:{client_id}",
        exchange=meta["exchange"],
        symbol=meta["symbol"],
        interval=meta["interval"],
        market_type=meta["market_type"],
        name=meta["name"],
        params=params,
        result=result,
    )
    patch = _patch_from_snapshot(payload, reason=reason, start_s=start_s, end_s=end_s)
    patch["warmupBars"] = warmup
    return patch


async def _compute_pyne_snapshot_message_async(
    client_id: str,
    dm,
    meta: dict,
    bar_time: int = 0,
) -> dict:
    """Compute a Pyne snapshot off the event loop."""
    return await run_pyne_wait(
        _compute_pyne_snapshot_message,
        client_id,
        dm,
        meta,
        bar_time,
    )


async def _compute_incremental_pyne_bar_message_async(
    client_id: str,
    meta: dict,
    bar: dict[str, Any],
    *,
    preview: bool,
) -> dict:
    return await run_pyne_wait(
        _compute_incremental_pyne_bar_message,
        client_id,
        meta,
        bar,
        preview=preview,
    )


async def _compute_pyne_range_patch_async(
    client_id: str,
    dm,
    meta: dict,
    start_s: int,
    end_s: int,
    reason: str = "load_range",
) -> dict:
    return await run_pyne_wait(
        _compute_pyne_range_patch,
        client_id,
        dm,
        meta,
        start_s,
        end_s,
        reason,
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
                await _send_json_with_timeout(websocket, bar_dict)
            except Exception:
                return


async def _read_client_messages(websocket: WebSocket) -> None:
    """Read and handle client messages (ping/pong, etc.)."""
    try:
        while True:
            message = await websocket.receive_text()
            if message.lower().strip() == "ping":
                await _send_text_with_timeout(websocket, "pong")
    except WebSocketDisconnect:
        pass
