"""Pyne/custom indicator WebSocket subscription orchestration."""
from __future__ import annotations

import asyncio
from typing import Any

from app.api.v1.stream_indicator_payloads import (
    _compute_incremental_pyne_bar_message_async,
    _compute_pyne_snapshot_message_async,
    _pyne_incremental_session_key,
    _pyne_incremental_sessions,
)
from app.core import config
from app.api.v1.stream_utils import validate_ws_interval as _validate_ws_interval
from app.data_engine.data_manager.models import DataEventType
from app.indicator.custom_store import CustomIndicatorStore
from app.indicator.pyne import PyneIncrementalSession, is_incremental_pyne_script
from app.indicator.script_identity import script_hash, short_script_hash
from app.indicator.serialization import build_ws_error_payload

_stream_custom_store = CustomIndicatorStore()


async def handle_pyne_indicator_subscribe(
    *,
    dm,
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
    stream_consumer_id: str,
    unsubscribe_client,
    queue_message,
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

    await unsubscribe_client(client_id)
    digest = script_hash(script)

    await dm.ensure_stream(
        symbol,
        interval,
        exchange=exchange,
        market_type=market_type,
        focus_scope="websocket",
        subscription_tier="indicator",
        consumer_id=stream_consumer_id,
    )
    meta = {
        "kind": "script",
        "exchange": exchange,
        "symbol": symbol,
        "interval": interval,
        "market_type": market_type,
        "name": name,
        "customId": custom_id or None,
        "indicatorId": f"pyne:{exchange}:{market_type}:{symbol}:{interval}:{short_script_hash(script)}:{client_id}",
        "scriptHash": digest,
        "script": script,
        "params": params,
        "securityMode": security_mode,
        "historyLimit": history_limit,
        "streamConsumerId": stream_consumer_id,
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

    seeded = False
    if incremental_script:
        initial = await _compute_pyne_snapshot_message_async(client_id, dm, meta)
        seeded = initial.get("ok") is not False
        if not seeded:
            await send_json(initial)

    await send_json({
        "type": "indicator.subscribed",
        "clientId": client_id,
        "indicatorId": meta["indicatorId"],
        "kind": "script",
        "exchange": exchange,
        "symbol": symbol,
        "interval": interval,
        "market_type": market_type,
        "name": name,
        "customId": custom_id or None,
        "seeded": seeded,
        "seedBars": min(max(int(history_limit), 1), max(int(config.PYNE_MAX_BARS), 1)) if incremental_script else 0,
    })

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
            queue_message(queue, msg)

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
