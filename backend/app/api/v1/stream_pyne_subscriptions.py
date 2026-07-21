"""Pyne/custom indicator WebSocket subscription orchestration."""

from __future__ import annotations

import asyncio
from typing import Any

from app.api.v1.stream_indicator_payloads import (
    _compute_pyne_snapshot_message_async,
    _patch_from_snapshot,
    _unbound_indicator_runtime_service,
)
from app.core import config
from app.api.v1.stream_utils import validate_ws_interval as _validate_ws_interval
from app.data_engine.data_manager.models import DataEventType
from app.data_engine.interval_policy import parse_interval_ms
from app.indicator.custom_store import CustomIndicatorStore
from app.indicator.resume import plan_indicator_resume
from app.indicator.script_identity import script_hash, short_script_hash
from app.indicator.serialization import build_ws_error_payload
from app.indicator.runtime_service import IndicatorRuntimeService

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
    requested_interval: str | None = None,
    exchange: str,
    market_type: str,
    name: str,
    language: str | None = None,
    custom_id: str,
    script: str,
    params: dict[str, Any],
    security_mode: str | None,
    history_limit: int,
    send_json,
    stream_consumer_id: str,
    unsubscribe_client,
    queue_message,
    range_service=None,
    data_revision: dict[str, Any] | None = None,
    resume_from: int | None = None,
    client_server_epoch: str | None = None,
    client_correction_revision: int | str | None = None,
    runtime_service: IndicatorRuntimeService | None = None,
) -> None:
    script_runtime_service = runtime_service or _unbound_indicator_runtime_service
    if custom_id and not script.strip():
        try:
            record = _stream_custom_store.get(custom_id)
        except ValueError as exc:
            await send_json(
                build_ws_error_payload(
                    "CUSTOM_INDICATOR_STORE_ERROR",
                    str(exc),
                    client_id=client_id,
                    hint="自定义指标存储文件无法读取，请检查本地 custom_indicators.json。",
                )
            )
            return
        if record is None:
            await send_json(
                build_ws_error_payload(
                    "CUSTOM_INDICATOR_NOT_FOUND",
                    f"Custom indicator '{custom_id}' not found.",
                    client_id=client_id,
                    hint="请确认该自定义指标已经保存到后端。",
                )
            )
            return
        script = str(record.get("script") or "")
        name = name or str(record.get("name") or custom_id)
        if not params:
            params = (
                record.get("params") if isinstance(record.get("params"), dict) else {}
            )
        if security_mode is None:
            security_mode = record.get("securityMode")
        if language is None:
            language = str(record.get("language") or "pyne")

    if not script.strip():
        await send_json(
            build_ws_error_payload(
                "PYNE_SCRIPT_REQUIRED",
                "Pyne script is required.",
                client_id=client_id,
                hint="script/custom/pyne 订阅需要传入脚本文本。",
            )
        )
        return
    if language is None:
        language = "pyne"
    language = str(language).strip().lower()
    if not language:
        await send_json(
            build_ws_error_payload(
                "INDICATOR_LANGUAGE_REQUIRED",
                "Script language must not be empty.",
                client_id=client_id,
            )
        )
        return
    if not _validate_ws_interval(interval):
        await send_json(
            build_ws_error_payload(
                "INVALID_INTERVAL",
                f"Unsupported interval: {interval}.",
                client_id=client_id,
                hint="请使用后端支持的原生或自定义周期。",
            )
        )
        return
    await script_runtime_service.start()
    script_runtime_service.route_for(language)

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
        "language": language,
        "exchange": exchange,
        "symbol": symbol,
        "interval": interval,
        "market_type": market_type,
        "name": name,
        "customId": custom_id or None,
        "indicatorId": f"{language}:{exchange}:{market_type}:{symbol}:{interval}:{short_script_hash(script)}:{client_id}",
        "scriptHash": digest,
        "script": script,
        "params": params,
        "securityMode": security_mode,
        "historyLimit": history_limit,
        "streamConsumerId": stream_consumer_id,
    }
    client_meta[client_id] = meta

    seeded = False
    initial = None

    if seeded and range_service is not None and isinstance(initial, dict):
        coverage = initial.get("range")
        if isinstance(coverage, dict):
            range_service.put_payload(
                meta,
                initial,
                start=int(coverage["start"]),
                end=int(coverage["end"]),
            )
        current_revision = range_service.data_revision_for_meta(meta)
        if isinstance(data_revision, dict):
            for field in ("dirtyRange", "historyInvalid"):
                if field in data_revision:
                    current_revision[field] = data_revision[field]
        data_revision = current_revision

    subscribed_payload = {
        "type": "indicator.subscribed",
        "ok": True,
        "clientId": client_id,
        "indicatorId": meta["indicatorId"],
        "kind": "script",
        "exchange": exchange,
        "symbol": symbol,
        "interval": interval,
        "requestedInterval": requested_interval or interval,
        "canonicalInterval": interval,
        "subscriptionStatus": "accepted",
        "realtimeStatus": "live",
        "market_type": market_type,
        "name": name,
        "customId": custom_id or None,
        **({"language": language} if language != "pyne" else {}),
        "seeded": seeded,
        "seedBars": 0,
    }
    resume_patch = None
    if range_service is not None and isinstance(data_revision, dict):
        closed_times = _payload_times(initial) if isinstance(initial, dict) else []
        interval_ms = parse_interval_ms(interval)
        resume_plan = plan_indicator_resume(
            resume_from=resume_from,
            client_server_epoch=client_server_epoch,
            client_correction_revision=client_correction_revision,
            data_revision=data_revision,
            closed_bar_times=closed_times,
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
        if resume_plan.status == "patch" and isinstance(initial, dict):
            resume_patch = _patch_from_snapshot(
                initial,
                reason="ws-resume",
                start_s=int(resume_plan.start),
                end_s=int(resume_plan.end),
            )
            resume_patch["dataRevision"] = data_revision

    async def _on_data_event(event) -> None:
        existing = custom_tasks.get(client_id)
        if existing is not None and not existing.done():
            existing.cancel()

        async def _run() -> None:
            if event.event_type in {
                DataEventType.BACKFILL_COMPLETED,
                DataEventType.BAR_AMENDED,
            }:
                dirty_range = _correction_range(event)
                event_detail = event.detail if isinstance(event.detail, dict) else {}
                request_id = str(event_detail.get("request_id") or "").strip()
                correction_event_id = (
                    f"backfill:{request_id}"
                    if request_id
                    else f"{event.event_type.value}:{symbol}:{interval}:"
                    f"{dirty_range['start']}:{dirty_range['end']}:"
                    f"{getattr(event, 'timestamp_ms', 0)}"
                )
                correction_revision = None
                if range_service is not None:
                    correction_revision = range_service.note_correction(
                        series_key=f"{exchange}:{market_type}:{symbol}:{interval}",
                        start=dirty_range["start"],
                        end=dirty_range["end"],
                        event_id=correction_event_id,
                    )
                queue_message(
                    queue,
                    {
                        "type": "indicator.recomputed",
                        "clientId": client_id,
                        "indicatorId": meta["indicatorId"],
                        "exchange": exchange,
                        "symbol": symbol,
                        "interval": interval,
                        "market_type": market_type,
                        "reason": "backfill-recomputed",
                        "range": dirty_range,
                        "dirtyRange": dirty_range,
                        **(
                            {"dataRevision": correction_revision}
                            if isinstance(correction_revision, dict)
                            else {}
                        ),
                    },
                )
                return
            msg = await _compute_pyne_snapshot_message_async(
                client_id,
                dm,
                meta,
                bar_time=event.bar.time if event.bar else 0,
                runtime_service=script_runtime_service,
            )
            if range_service is not None:
                msg["dataRevision"] = range_service.data_revision_for_meta(meta)
            queue_message(queue, msg)

        custom_tasks[client_id] = asyncio.create_task(
            _run(), name=f"pyne_indicator_{client_id}"
        )

    handle = dm.subscribe(
        callback=_on_data_event,
        symbol=symbol,
        interval=interval,
        exchange=exchange,
        market_type=market_type,
        event_types={
            DataEventType.BAR_UPDATED,
            DataEventType.BAR_CLOSED,
            DataEventType.BAR_AMENDED,
            DataEventType.BACKFILL_COMPLETED,
        },
    )
    custom_handles[client_id] = handle
    await send_json(subscribed_payload)
    if resume_patch is not None:
        await send_json(resume_patch)


def _payload_times(payload: dict[str, Any] | None) -> list[int]:
    times: set[int] = set()
    if not isinstance(payload, dict):
        return []
    for line in payload.get("lines") or []:
        for point in line.get("data") or []:
            try:
                times.add(int(point["time"]))
            except (KeyError, TypeError, ValueError):
                continue
    if not times:
        coverage = payload.get("range")
        if isinstance(coverage, dict):
            try:
                times.update((int(coverage["start"]), int(coverage["end"])))
            except (KeyError, TypeError, ValueError):
                pass
    return sorted(times)


def _correction_range(event: Any) -> dict[str, int]:
    if event.event_type == DataEventType.BAR_AMENDED and event.bar is not None:
        timestamp = int(event.bar.time)
        return {"start": timestamp, "end": timestamp}
    detail = event.detail if isinstance(event.detail, dict) else {}
    start = detail.get("earliest")
    end = detail.get("latest")
    if start is None:
        start_ms = detail.get("request_start_ms") or detail.get("range_start_ms")
        start = int(start_ms) // 1000 if start_ms is not None else 0
    if end is None:
        end_ms = detail.get("request_end_ms") or detail.get("range_end_ms")
        end = int(end_ms) // 1000 if end_ms is not None else start
    start_s = int(start or 0)
    return {"start": start_s, "end": max(start_s, int(end or start_s))}
