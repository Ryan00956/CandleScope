"""Indicator and Pyne WebSocket handlers backed by DataManager events."""
from __future__ import annotations

import asyncio
import json
import time
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from app.api.v1.stream_indicator_payloads import (
    _indicator_event_to_ws_message,
    _patch_from_snapshot,
    _release_pyne_incremental_meta,
    confirmed_indicator_seed_bars,
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
from app.data_engine.interval_policy import parse_interval_ms, parse_interval_spec
from app.data_engine.interval_resolution import IntervalResolutionError
from app.indicator import registry as indicator_registry
from app.indicator.events import IndicatorEvent
from app.indicator.resume import plan_indicator_resume
from app.indicator.serialization import (
    build_indicator_snapshot_payload,
    build_ws_error_payload,
)


def _indicator_subscription_failure(
    *,
    client_id: str,
    requested_interval: str,
    interval: str,
    code: str,
    message: str,
    hint: str,
) -> dict[str, Any]:
    """Build a terminal per-indicator acknowledgement for a rejected subscription."""
    payload = build_ws_error_payload(
        code,
        message,
        client_id=client_id,
        hint=hint,
    )
    payload.update({
        "type": "indicator.subscribed",
        "ok": False,
        "subscriptionStatus": "failed",
        "realtimeStatus": "unavailable",
        "requestedInterval": requested_interval,
        "canonicalInterval": interval,
        "interval": interval,
        "failure": {
            "interval": interval,
            "code": code,
            "message": message,
        },
    })
    return payload


def _indicator_stream_failure(
    *,
    client_id: str,
    requested_interval: str,
    interval: str,
    exc: Exception,
) -> dict[str, Any]:
    if isinstance(exc, IntervalResolutionError):
        detail = exc.to_dict()
        code = str(detail.get("code") or "INDICATOR_STREAM_SUBSCRIPTION_FAILED")
        message = str(detail.get("message") or exc)
    else:
        code = "INDICATOR_STREAM_SUBSCRIPTION_FAILED"
        message = f"Realtime indicator stream is unavailable for interval {interval}."
    return _indicator_subscription_failure(
        client_id=client_id,
        requested_interval=requested_interval,
        interval=interval,
        code=code,
        message=message,
        hint="实时指标订阅不可用；前端应停止该订阅，并通过 HTTP 历史接口补齐已收盘指标值。",
    )


async def stream_indicators(websocket: WebSocket, dm, indicator_engine) -> None:
    """Handle a multi-indicator WS connection."""
    queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=max(int(config.INDICATOR_WS_QUEUE_SIZE), 1))
    subscribed: dict[str, Any] = {}
    custom_handles: dict[str, Any] = {}
    custom_tasks: dict[str, asyncio.Task] = {}
    client_meta: dict[str, dict] = {}
    seed_query_cache: dict[tuple[str, str, str, str, int], dict[str, Any]] = {}
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
                range_service = getattr(indicator_engine, "indicator_range_service", None)
                if range_service is not None:
                    msg["dataRevision"] = range_service.data_revision_for_meta(meta)
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
                    seed_query_cache=seed_query_cache,
                    send_json=_safe_send_json,
                    msg=msg,
                )
            elif action == "unsubscribe":
                client_id = str(msg.get("clientId") or "").strip()
                await _unsubscribe_indicator_client(
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
                    hint="指标 WS 当前只支持 subscribe、unsubscribe 和 ping；历史区间请使用 HTTP /indicators/range。",
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
        client_ids = set(subscribed) | set(custom_handles) | set(custom_tasks) | set(client_meta)
        for client_id in list(client_ids):
            await _unsubscribe_indicator_client(
                client_id,
                dm=dm,
                indicator_engine=indicator_engine,
                subscribed=subscribed,
                custom_handles=custom_handles,
                custom_tasks=custom_tasks,
                client_meta=client_meta,
            )
        subscribed.clear()
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
    seed_query_cache: dict[tuple[str, str, str, str, int], dict[str, Any]],
    send_json,
    msg: dict,
) -> None:
    client_id = str(msg.get("clientId") or "").strip()
    symbol = str(msg.get("symbol") or "BTCUSDT").upper().strip()
    requested_interval = str(msg.get("interval") or "1m").strip()
    interval = requested_interval
    exchange = _normalize_exchange(str(msg.get("exchange") or "binance"))
    market_type = _normalize_market_type(str(msg.get("market_type") or msg.get("marketType") or "spot"))
    indicator_name = str(msg.get("name") or msg.get("indicator") or "").upper().strip()
    params = msg.get("params") if isinstance(msg.get("params"), dict) else {}
    history_limit = int(msg.get("historyLimit") or 500)
    history_limit = min(max(history_limit, 1), max(int(config.PYNE_MAX_BARS), 1))
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
        await send_json(_indicator_subscription_failure(
            client_id=client_id,
            requested_interval=requested_interval,
            interval=interval,
            code="INDICATOR_SUBSCRIPTION_LIMIT",
            message=f"Too many indicator subscriptions (max {config.INDICATOR_WS_MAX_SUBSCRIPTIONS}).",
            hint="请减少同一 WS 连接上的指标数量，或调大 INDICATOR_WS_MAX_SUBSCRIPTIONS。",
        ))
        return
    interval_spec = parse_interval_spec(requested_interval)
    if interval_spec is None or not _validate_ws_interval(requested_interval):
        await send_json(_indicator_subscription_failure(
            client_id=client_id,
            requested_interval=requested_interval,
            interval=requested_interval,
            code="INVALID_INTERVAL",
            message=f"Unsupported interval: {requested_interval}.",
            hint="请使用后端支持的原生或自定义周期。",
        ))
        return
    interval = interval_spec.canonical
    if is_script:
        range_service = getattr(indicator_engine, "indicator_range_service", None)
        script_revision = (
            _indicator_subscription_revision(
                range_service,
                {
                    "exchange": exchange,
                    "market_type": market_type,
                    "symbol": symbol,
                    "interval": interval,
                },
                client_server_epoch=msg.get("serverEpoch") or msg.get("server_epoch"),
                client_correction_revision=(
                    msg.get("correctionRevision")
                    if msg.get("correctionRevision") is not None
                    else msg.get("correction_revision")
                ),
            )
            if range_service is not None
            else None
        )
        stream_consumer_id = (
            f"ws:indicator:{exchange}:{market_type}:{symbol}:{interval}:"
            f"{client_id}:{id(websocket)}"
        )
        try:
            await handle_pyne_indicator_subscribe(
                dm=dm,
                custom_handles=custom_handles,
                custom_tasks=custom_tasks,
                queue=queue,
                client_meta=client_meta,
                client_id=client_id,
                symbol=symbol,
                interval=interval,
                requested_interval=requested_interval,
                exchange=exchange,
                market_type=market_type,
                name=str(msg.get("displayName") or msg.get("name") or client_id),
                custom_id=custom_id,
                script=script,
                params=params,
                security_mode=msg.get("securityMode"),
                history_limit=history_limit,
                send_json=send_json,
                stream_consumer_id=stream_consumer_id,
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
                range_service=range_service,
                data_revision=script_revision,
                resume_from=msg.get("resumeFrom") or msg.get("resume_from"),
                client_server_epoch=msg.get("serverEpoch") or msg.get("server_epoch"),
                client_correction_revision=(
                    msg.get("correctionRevision")
                    if msg.get("correctionRevision") is not None
                    else msg.get("correction_revision")
                ),
            )
        except Exception as exc:
            had_meta = client_id in client_meta
            await _unsubscribe_indicator_client(
                client_id,
                dm=dm,
                indicator_engine=indicator_engine,
                subscribed=subscribed,
                custom_handles=custom_handles,
                custom_tasks=custom_tasks,
                client_meta=client_meta,
            )
            if not had_meta:
                await _release_indicator_stream(dm, {
                    "exchange": exchange,
                    "market_type": market_type,
                    "symbol": symbol,
                    "interval": interval,
                    "streamConsumerId": stream_consumer_id,
                })
            await send_json(_indicator_stream_failure(
                client_id=client_id,
                requested_interval=requested_interval,
                interval=interval,
                exc=exc,
            ))
        return
    if not indicator_name:
        await send_json(_indicator_subscription_failure(
            client_id=client_id,
            requested_interval=requested_interval,
            interval=interval,
            code="INDICATOR_NAME_REQUIRED",
            message="Builtin indicator name is required.",
            hint="builtin 订阅需要传 name，例如 MA、MACD、RSI。",
        ))
        return
    if indicator_registry.get(indicator_name) is None:
        await send_json(_indicator_subscription_failure(
            client_id=client_id,
            requested_interval=requested_interval,
            interval=interval,
            code="INDICATOR_NOT_FOUND",
            message=f"Unknown builtin indicator: {indicator_name}.",
            hint="请检查指标名称是否存在于 /api/v1/indicators/registry。",
        ))
        return

    await _unsubscribe_indicator_client(
        client_id,
        dm=dm,
        indicator_engine=indicator_engine,
        subscribed=subscribed,
        custom_handles=custom_handles,
        custom_tasks=custom_tasks,
        client_meta=client_meta,
    )

    consumer_id = (
        f"ws:indicator:{exchange}:{market_type}:{symbol}:{interval}:"
        f"{client_id}:{id(websocket)}"
    )
    stream_ensured = False
    try:
        await dm.ensure_stream(
            symbol,
            interval,
            exchange=exchange,
            market_type=market_type,
            focus_scope="websocket",
            subscription_tier="indicator",
            consumer_id=consumer_id,
        )
        stream_ensured = True
        range_service = getattr(indicator_engine, "indicator_range_service", None)
        series_meta = {
            "exchange": exchange,
            "market_type": market_type,
            "symbol": symbol,
            "interval": interval,
        }
        seed_cache_key = (exchange, market_type, symbol, interval, history_limit)
        cached_seed = seed_query_cache.get(seed_cache_key)
        current_revision = (
            range_service.data_revision_for_meta(series_meta)
            if range_service is not None
            else None
        )
        cache_age = (
            time.monotonic() - float(cached_seed.get("at", 0))
            if cached_seed is not None
            else float("inf")
        )
        current_correction = (
            str(current_revision.get("correctionRevision", "0"))
            if isinstance(current_revision, dict)
            else "0"
        )
        cached_until = int(cached_seed.get("closedThrough", 0)) if cached_seed else 0
        current_closed = int((current_revision or {}).get("closedThrough") or 0)
        if (
            cached_seed is not None
            and cache_age <= max(0.0, float(config.INDICATOR_WS_SEED_CACHE_SECONDS))
            and str(cached_seed.get("correctionRevision", "0")) == current_correction
            and current_closed <= cached_until
        ):
            query_result = cached_seed["result"]
        else:
            query_result = dm.query_latest(
                symbol,
                interval,
                limit=history_limit,
                exchange=exchange,
                market_type=market_type,
            )
            query_bars = list(query_result.bars or [])
            seed_query_cache[seed_cache_key] = {
                "at": time.monotonic(),
                "result": query_result,
                "correctionRevision": current_correction,
                "closedThrough": max((int(bar.time) for bar in query_bars), default=0),
            }

        query_bars = list(query_result.bars or [])
        seed_bars = confirmed_indicator_seed_bars(query_bars)
        key, result = indicator_engine.subscribe(
            symbol=symbol,
            interval=interval,
            market_type=market_type,
            indicator_name=indicator_name,
            params=params,
            bars=seed_bars,
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
            "streamConsumerId": consumer_id,
        }
    except Exception as exc:
        if client_id in subscribed:
            indicator_engine.unsubscribe(subscribed.pop(client_id))
        client_meta.pop(client_id, None)
        if stream_ensured:
            await _release_indicator_stream(dm, {
                "exchange": exchange,
                "market_type": market_type,
                "symbol": symbol,
                "interval": interval,
                "streamConsumerId": consumer_id,
            })
        await send_json(_indicator_stream_failure(
            client_id=client_id,
            requested_interval=requested_interval,
            interval=interval,
            exc=exc,
        ))
        return

    subscribed_payload = {
        "type": "indicator.subscribed",
        "ok": True,
        "clientId": client_id,
        "indicatorId": key.uid,
        "kind": "builtin",
        "exchange": key.exchange,
        "symbol": symbol,
        "interval": interval,
        "requestedInterval": requested_interval,
        "canonicalInterval": interval,
        "subscriptionStatus": "accepted",
        "realtimeStatus": "live",
        "market_type": market_type,
        "name": indicator_name,
        "seeded": result is not None,
        "seedBars": len(seed_bars),
    }
    range_service = getattr(indicator_engine, "indicator_range_service", None)
    resume_patch = None
    initial_preview = None
    if range_service is not None:
        data_revision = _indicator_subscription_revision(
            range_service,
            client_meta[client_id],
            client_server_epoch=msg.get("serverEpoch") or msg.get("server_epoch"),
            client_correction_revision=(
                msg.get("correctionRevision")
                if msg.get("correctionRevision") is not None
                else msg.get("correction_revision")
            ),
        )
        interval_ms = parse_interval_ms(interval)
        resume_plan = plan_indicator_resume(
            resume_from=msg.get("resumeFrom") or msg.get("resume_from"),
            client_server_epoch=msg.get("serverEpoch") or msg.get("server_epoch"),
            client_correction_revision=(
                msg.get("correctionRevision")
                if msg.get("correctionRevision") is not None
                else msg.get("correction_revision")
            ),
            data_revision=data_revision,
            closed_bar_times=(int(bar.time) for bar in seed_bars),
            max_patch_bars=max(0, int(config.INDICATOR_WS_RESUME_MAX_BARS)),
            interval_seconds=(max(interval_ms // 1000, 1) if interval_ms else None),
        )
        subscribed_payload["dataRevision"] = data_revision
        subscribed_payload["resumeStatus"] = resume_plan.status
        subscribed_payload["resumeReason"] = resume_plan.reason
        if resume_plan.start is not None and resume_plan.end is not None:
            subscribed_payload["resumeRange"] = {
                "start": resume_plan.start,
                "end": resume_plan.end,
            }
        if resume_plan.status == "patch" and result is not None:
            snapshot = build_indicator_snapshot_payload(
                client_id=client_id,
                indicator_id=key.uid,
                exchange=key.exchange,
                symbol=symbol,
                interval=interval,
                market_type=market_type,
                name=indicator_name,
                params=params,
                result=result,
            )
            resume_patch = _patch_from_snapshot(
                snapshot,
                reason="ws-resume",
                start_s=int(resume_plan.start),
                end_s=int(resume_plan.end),
            )
            resume_patch["dataRevision"] = data_revision

    # The seed intentionally excludes the forming bar so its values never
    # become durable history.  Still, a newly opened/reconnected chart should
    # not have to wait for another market tick before its realtime VOL (or
    # other hosted indicator) gets the current point.  Compute this one
    # non-committing preview directly and send it *after* the acknowledgement
    # (and any resume patch) to keep the client-side subscription state ordered.
    forming_bar = next(
        (
            bar
            for bar in reversed(query_bars)
            if not getattr(bar, "is_closed", True)
            and (not seed_bars or int(bar.time) > int(seed_bars[-1].time))
        ),
        None,
    )
    preview_for_key = getattr(indicator_engine, "preview_for_key", None)
    if forming_bar is not None and callable(preview_for_key):
        preview_values = preview_for_key(key, forming_bar)
        if preview_values:
            initial_preview = {
                "type": "indicator.preview",
                "clientId": client_id,
                "indicatorId": key.uid,
                "exchange": key.exchange,
                "symbol": symbol,
                "interval": interval,
                "market_type": market_type,
                "barTime": int(forming_bar.time),
                "timestampMs": int(time.time() * 1000),
                "values": preview_values,
                "bar": forming_bar.to_dict(),
            }
    await send_json(subscribed_payload)
    if resume_patch is not None:
        await send_json(resume_patch)
    if initial_preview is not None:
        await send_json(initial_preview)


def _indicator_subscription_revision(
    range_service: Any,
    meta: dict[str, Any],
    *,
    client_server_epoch: Any = None,
    client_correction_revision: Any = None,
) -> dict[str, Any]:
    """Return current revision plus changes since the reconnecting client."""
    current = range_service.data_revision_for_meta(meta)
    current_epoch = str(current.get("serverEpoch") or "")
    if client_server_epoch is None or str(client_server_epoch) != current_epoch:
        if client_server_epoch is not None:
            current["historyInvalid"] = True
        return current
    if client_correction_revision is None:
        current["historyInvalid"] = True
        return current
    try:
        since = int(client_correction_revision)
    except (TypeError, ValueError):
        current["historyInvalid"] = True
        return current
    revisions = range_service.revisions.snapshot(
        str(meta.get("symbol") or ""),
        str(meta.get("interval") or ""),
        exchange=str(meta.get("exchange") or "binance"),
        market_type=str(meta.get("market_type") or meta.get("marketType") or "spot"),
        since_correction_revision=since,
    )
    revisions["revisionToken"] = (
        f"{revisions['serverEpoch']}:{revisions['correctionRevision']}"
    )
    return revisions


async def _unsubscribe_indicator_client(
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
        await _release_indicator_stream(dm, meta)
        _release_pyne_incremental_meta(meta)


async def _release_indicator_stream(dm, meta: dict) -> None:
    release_stream = getattr(dm, "release_stream", None)
    consumer_id = meta.get("streamConsumerId")
    if not callable(release_stream) or not consumer_id:
        return
    try:
        await release_stream(
            meta["symbol"],
            meta["interval"],
            exchange=meta.get("exchange", "binance"),
            market_type=meta.get("market_type", "spot"),
            focus_scope="websocket",
            subscription_tier="indicator",
            consumer_id=consumer_id,
        )
    except Exception:
        pass


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
