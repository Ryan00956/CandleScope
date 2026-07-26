"""Pyne/custom indicator WebSocket subscription orchestration."""

from __future__ import annotations

import asyncio
import logging
from collections import OrderedDict
from typing import Any

from app.api.v1.stream_indicator_payloads import (
    _compute_pyne_snapshot_message_async,
    _patch_from_snapshot,
    _unbound_indicator_runtime_service,
    confirmed_indicator_seed_bars,
)
from app.core import config
from app.core.executors import run_storage
from app.api.v1.stream_utils import validate_ws_interval as _validate_ws_interval
from app.data_engine.data_manager.models import DataEventType
from app.data_engine.interval_policy import parse_interval_ms
from app.indicator.data_manager_bridge import (
    indicator_correction_event_id,
    indicator_dirty_range_for_interval,
    is_zero_bar_backfill_completion,
)
from app.indicator.custom_store import CustomIndicatorStore
from app.indicator.resume import plan_indicator_resume
from app.indicator.script_identity import script_hash, short_script_hash
from app.indicator.serialization import build_ws_error_payload
from app.indicator.runtime_service import IndicatorRuntimeService

_stream_custom_store = CustomIndicatorStore()
_PYNE_SEED_REVISION_ATTEMPTS = 2
logger = logging.getLogger("candlescope.indicator.pyne_stream")


def _revision_token(revision: dict[str, Any] | None) -> str:
    if not isinstance(revision, dict):
        return ""
    explicit = str(revision.get("revisionToken") or "").strip()
    if explicit:
        return explicit
    return (
        f"{revision.get('serverEpoch', '')}:"
        f"{revision.get('correctionRevision', 0)}"
    )


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
    queue_critical_message=None,
    range_service=None,
    backfill_coordinator=None,
    data_revision: dict[str, Any] | None = None,
    resume_from: int | None = None,
    client_server_epoch: str | None = None,
    client_correction_revision: int | str | None = None,
    runtime_service: IndicatorRuntimeService | None = None,
    pyne_correction_state: dict[str, Any] | None = None,
    seed_query_cache: dict[tuple[str, str, str, str, int], dict[str, Any]] | None = None,
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
    if isinstance(seed_query_cache, dict):
        meta["_seedQueryCache"] = seed_query_cache
    client_meta[client_id] = meta
    client_revision_context = (
        dict(data_revision) if isinstance(data_revision, dict) else None
    )
    seed_revision = (
        range_service.data_revision_for_meta(meta)
        if range_service is not None
        else client_revision_context
    )

    seeded = False
    initial = None
    if seeded and range_service is not None and isinstance(initial, dict):
        coverage = initial.get("range")
        seed_revision_token = (
            str(seed_revision.get("revisionToken") or "").strip()
            if isinstance(seed_revision, dict)
            else ""
        )
        if isinstance(coverage, dict) and seed_revision_token:
            range_service.put_payload(
                meta,
                initial,
                start=int(coverage["start"]),
                end=int(coverage["end"]),
                revision_token=seed_revision_token,
            )
        if isinstance(coverage, dict):
            meta["seedRange"] = {
                "start": int(coverage["start"]),
                "end": int(coverage["end"]),
            }
        current_revision = range_service.data_revision_for_meta(meta)
        if _revision_token(current_revision) != _revision_token(seed_revision):
            raise RuntimeError("Pyne seed revision changed before subscribe.")
        if isinstance(client_revision_context, dict):
            for field in ("dirtyRange", "historyInvalid"):
                if field in client_revision_context:
                    current_revision[field] = client_revision_context[field]
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

    completed_corrections: OrderedDict[str, None] = OrderedDict()
    pending_correction: dict[str, Any] | None = None
    correction_task: asyncio.Task | None = None
    active_correction_keys: set[str] = set()
    pending_frontier_closed = 0
    closed_frontier_generation = 0
    pending_realtime_event: Any | None = None

    def _remember_completed_correction(correction_key: str) -> None:
        completed_corrections.pop(correction_key, None)
        completed_corrections[correction_key] = None
        while len(completed_corrections) > 512:
            completed_corrections.popitem(last=False)

    def _correction_range_for_subscription(
        event: Any,
    ) -> dict[str, int] | None:
        if (
            str(event.key.exchange).lower().strip() != exchange
            or str(event.key.market_type).lower().strip() != market_type
            or str(event.key.symbol).upper().strip() != symbol
        ):
            return None
        return indicator_dirty_range_for_interval(
            event,
            interval,
            data_manager=dm,
        )

    def _merge_pending_correction(
        *,
        correction_key: str,
        correction_event_id: str,
        dirty_range: dict[str, int],
        correction_revision: dict[str, Any] | None,
        barrier_request_id: str | None,
        has_amendment: bool,
    ) -> None:
        nonlocal pending_correction
        if pending_correction is None:
            pending_correction = {
                "keys": OrderedDict([(correction_key, None)]),
                "reset_key": correction_event_id,
                "dirty_range": dict(dirty_range),
                "data_revision": correction_revision,
                "barrier_request_id": barrier_request_id,
                "has_amendment": has_amendment,
            }
            return

        keys = pending_correction["keys"]
        keys.pop(correction_key, None)
        keys[correction_key] = None
        while len(keys) > 512:
            # The work itself is not dropped: its invalidation range and latest
            # revision remain folded into this single-series batch.  The LRU is
            # only for suppressing duplicate completion notifications.
            keys.popitem(last=False)
        pending_dirty = pending_correction["dirty_range"]
        pending_correction["dirty_range"] = {
            "start": min(int(pending_dirty["start"]), int(dirty_range["start"])),
            "end": max(int(pending_dirty["end"]), int(dirty_range["end"])),
        }
        pending_correction["reset_key"] = correction_event_id
        pending_correction["data_revision"] = correction_revision
        pending_correction["has_amendment"] = (
            bool(pending_correction["has_amendment"])
            or has_amendment
        )
        if barrier_request_id:
            # BACKFILL_COMPLETED is emitted while the coordinator owns the
            # series through parent finalization.  A later same-series parent
            # completion cannot be emitted before previously observed parents
            # have settled, so the latest such request is the batch barrier.
            # BAR_AMENDED never replaces this barrier.
            pending_correction["barrier_request_id"] = barrier_request_id

    async def _shared_correction_seed_bars(
        *,
        correction_event_id: str,
        snapshot_revision: dict[str, Any] | None,
        frontier_generation: int,
    ) -> list[Any] | None:
        query_latest = getattr(dm, "query_latest", None)
        if not callable(query_latest):
            return None
        state = correction_state
        tasks = state.setdefault("snapshot_tasks", OrderedDict())
        task_key = (
            exchange,
            market_type,
            symbol,
            interval,
            int(history_limit),
            correction_event_id,
            _revision_token(snapshot_revision),
            int((snapshot_revision or {}).get("closedThrough") or 0),
            int(frontier_generation),
        )
        task = tasks.get(task_key)
        if task is None or task.cancelled():
            async def _query_closed_bars() -> list[Any]:
                result = await run_storage(
                    query_latest,
                    symbol,
                    interval,
                    limit=int(history_limit) + 1,
                    exchange=exchange,
                    market_type=market_type,
                    auto_backfill=False,
                )
                if (
                    bool(getattr(result, "missing_ranges", None))
                    or bool(getattr(result, "retryable", False))
                    or getattr(result, "complete", True) is False
                ):
                    raise RuntimeError(
                        "Pyne correction seed history is not ready."
                    )
                return confirmed_indicator_seed_bars(
                    list(result.bars or [])
                )[-int(history_limit):]

            task = asyncio.create_task(
                _query_closed_bars(),
                name=(
                    f"pyne_correction_seed:{symbol}:{interval}:"
                    f"{history_limit}"
                ),
            )
            tasks[task_key] = task
            while len(tasks) > 32:
                removable = next(
                    (
                        key for key, candidate in tasks.items()
                        if candidate.done() and key != task_key
                    ),
                    None,
                )
                if removable is None:
                    break
                tasks.pop(removable, None)
        try:
            return list(await asyncio.shield(task))
        except BaseException:
            if tasks.get(task_key) is task:
                tasks.pop(task_key, None)
            raise

    async def _process_correction(batch: dict[str, Any]) -> bool:
        nonlocal pending_frontier_closed
        if meta.get("_disposed"):
            return False
        dirty_range = batch["dirty_range"]
        request_id = batch.get("barrier_request_id")
        if backfill_coordinator is not None and request_id:
            outcome = await backfill_coordinator.wait_for_request(request_id)
            if outcome is None:
                return False
            if (
                getattr(outcome, "verified_contiguous", None) is not True
                or bool(getattr(outcome, "retryable", False))
            ):
                return False
            if (
                int(getattr(outcome, "bars_loaded", 0) or 0) <= 0
                and not bool(batch.get("has_amendment"))
            ):
                return True

        correction_event_id = str(batch["reset_key"])
        correction_revision = batch.get("data_revision")
        if meta.get("kind") == "script":
            seed_range = meta.get("seedRange")
            correction_precedes_seed = (
                isinstance(seed_range, dict)
                and int(dirty_range["end"]) < int(seed_range["start"])
            )
            if not correction_precedes_seed:
                snapshot_attempts = (
                    _PYNE_SEED_REVISION_ATTEMPTS
                    if range_service is not None
                    else 1
                )
                refreshed: dict[str, Any] | None = None
                coverage: dict[str, Any] | None = None
                stable_revision = correction_revision
                for snapshot_attempt in range(snapshot_attempts):
                    snapshot_frontier_generation = closed_frontier_generation
                    snapshot_revision = (
                        range_service.data_revision_for_meta(meta)
                        if range_service is not None
                        else correction_revision
                    )
                    shared_seed_bars = await _shared_correction_seed_bars(
                        correction_event_id=correction_event_id,
                        snapshot_revision=snapshot_revision,
                        frontier_generation=snapshot_frontier_generation,
                    )
                    if shared_seed_bars is None:
                        candidate = await _compute_pyne_snapshot_message_async(
                            client_id,
                            dm,
                            meta,
                            runtime_service=script_runtime_service,
                        )
                    else:
                        candidate = await _compute_pyne_snapshot_message_async(
                            client_id,
                            dm,
                            meta,
                            runtime_service=script_runtime_service,
                            seed_bars=shared_seed_bars,
                        )
                    if candidate.get("ok") is False:
                        return False
                    candidate_coverage = (
                        candidate.get("range")
                        if isinstance(candidate, dict)
                        else None
                    )
                    observed_revision = (
                        range_service.data_revision_for_meta(meta)
                        if range_service is not None
                        else snapshot_revision
                    )
                    coverage_end = (
                        int(candidate_coverage.get("end", 0))
                        if isinstance(candidate_coverage, dict)
                        else 0
                    )
                    observed_closed = int(
                        (observed_revision or {}).get("closedThrough") or 0
                    )
                    local_frontier_changed = (
                        closed_frontier_generation
                        != snapshot_frontier_generation
                    )
                    if observed_closed > coverage_end:
                        pending_frontier_closed = max(
                            pending_frontier_closed,
                            observed_closed,
                        )
                    if (
                        _revision_token(observed_revision)
                        != _revision_token(snapshot_revision)
                        or observed_closed > coverage_end
                        or local_frontier_changed
                    ):
                        if snapshot_attempt + 1 >= snapshot_attempts:
                            return False
                        continue
                    refreshed = candidate
                    coverage = candidate_coverage
                    stable_revision = observed_revision
                    break
                if refreshed is None or not isinstance(coverage, dict):
                    return False
                meta["seedRange"] = {
                    "start": int(coverage["start"]),
                    "end": int(coverage["end"]),
                }
                correction_revision = stable_revision
                if (
                    range_service is not None
                    and refreshed.get("ok") is not False
                ):
                    correction_revision_token = (
                        str(
                            correction_revision.get("revisionToken") or ""
                        ).strip()
                        if isinstance(correction_revision, dict)
                        else ""
                    )
                    if correction_revision_token:
                        range_service.put_payload(
                            meta,
                            refreshed,
                            start=int(coverage["start"]),
                            end=int(coverage["end"]),
                            revision_token=correction_revision_token,
                        )
        notification_range = dict(dirty_range)
        if pending_frontier_closed:
            notification_range = {
                "start": min(
                    int(notification_range["start"]),
                    pending_frontier_closed,
                ),
                "end": max(
                    int(notification_range["end"]),
                    pending_frontier_closed,
                ),
            }
        recomputed_message = {
            "type": "indicator.recomputed",
            "clientId": client_id,
            "indicatorId": meta["indicatorId"],
            "exchange": exchange,
            "symbol": symbol,
            "interval": interval,
            "market_type": market_type,
            "reason": "backfill-recomputed",
            "range": notification_range,
            "dirtyRange": notification_range,
            **(
                {"dataRevision": correction_revision}
                if isinstance(correction_revision, dict)
                else {}
            ),
        }
        if callable(queue_critical_message):
            if meta.get("_disposed"):
                return False
            await queue_critical_message(queue, recomputed_message)
        else:
            if meta.get("_disposed"):
                return False
            queue_message(queue, recomputed_message)
        return True

    async def _run_correction_queue() -> None:
        nonlocal active_correction_keys, correction_task, pending_correction
        nonlocal pending_frontier_closed, pending_realtime_event
        try:
            while pending_correction is not None:
                if meta.get("_disposed"):
                    pending_correction = None
                    break
                batch = pending_correction
                pending_correction = None
                active_correction_keys = set(batch["keys"])
                try:
                    completed = await _process_correction(batch)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    logger.exception(
                        "Pyne correction refresh failed for %s@%s",
                        symbol,
                        interval,
                    )
                    completed = False
                if completed:
                    for correction_key in batch["keys"]:
                        _remember_completed_correction(correction_key)
                if meta.get("kind") == "script":
                    seed_range = meta.get("seedRange")
                    seed_end = (
                        int(seed_range.get("end", 0))
                        if isinstance(seed_range, dict)
                        else 0
                    )
                    frontier = pending_frontier_closed
                    pending_frontier_closed = 0
                    if frontier > seed_end:
                        frontier_key = f"live-frontier:{frontier}"
                        frontier_revision = (
                            range_service.data_revision_for_meta(meta)
                            if range_service is not None
                            else batch.get("data_revision")
                        )
                        _merge_pending_correction(
                            correction_key=frontier_key,
                            correction_event_id=frontier_key,
                            dirty_range={"start": frontier, "end": frontier},
                            correction_revision=frontier_revision,
                            barrier_request_id=None,
                            has_amendment=False,
                        )
                if (
                    not completed
                    and pending_correction is None
                    and not meta.get("_disposed")
                ):
                    failed_revision = (
                        range_service.data_revision_for_meta(meta)
                        if range_service is not None
                        else batch.get("data_revision")
                    )
                    invalidated_message = {
                        "type": "indicator.recomputed",
                        "ok": False,
                        "recomputed": False,
                        "invalidated": True,
                        "retryMode": "event",
                        "clientId": client_id,
                        "indicatorId": meta["indicatorId"],
                        "exchange": exchange,
                        "symbol": symbol,
                        "interval": interval,
                        "market_type": market_type,
                        "reason": "backfill-invalidated",
                        "range": dict(batch["dirty_range"]),
                        "dirtyRange": dict(batch["dirty_range"]),
                        **(
                            {"dataRevision": failed_revision}
                            if isinstance(failed_revision, dict)
                            else {}
                        ),
                    }
                    if callable(queue_critical_message):
                        await queue_critical_message(
                            queue,
                            invalidated_message,
                        )
                    else:
                        queue_message(queue, invalidated_message)
                active_correction_keys.clear()
        finally:
            active_correction_keys.clear()
            if correction_task is asyncio.current_task():
                correction_task = None
            deferred_realtime = pending_realtime_event
            pending_realtime_event = None
            if deferred_realtime is not None and not meta.get("_disposed"):
                deferred_time = int(
                    getattr(deferred_realtime.bar, "time", 0) or 0
                )
                seed_range = meta.get("seedRange")
                seed_end = (
                    int(seed_range.get("end", 0))
                    if isinstance(seed_range, dict)
                    else 0
                )
                if deferred_time > seed_end:
                    task = asyncio.create_task(
                        _run_realtime_event(deferred_realtime),
                        name=f"pyne_indicator_deferred_{client_id}",
                    )
                    custom_tasks[client_id] = task

    async def _run_realtime_event(event: Any) -> None:
        if meta.get("_disposed"):
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
        if meta.get("_disposed"):
            return
        is_preview = bool(
            event.event_type != DataEventType.BAR_CLOSED
            and (
                msg.get("type") == "indicator.preview"
                or (
                    msg.get("type") == "indicator.patch"
                    and msg.get("reason") == "bar_update"
                )
            )
        )
        if not is_preview and callable(queue_critical_message):
            await queue_critical_message(queue, msg)
        else:
            queue_message(queue, msg)

    async def _on_data_event(event) -> None:
        nonlocal correction_task, pending_frontier_closed, pending_realtime_event
        nonlocal closed_frontier_generation
        if meta.get("_disposed"):
            return
        if event.event_type in {
            DataEventType.BACKFILL_COMPLETED,
            DataEventType.BAR_AMENDED,
        }:
            if is_zero_bar_backfill_completion(event):
                return
            dirty_range = _correction_range_for_subscription(event)
            if dirty_range is None:
                return
            event_detail = event.detail if isinstance(event.detail, dict) else {}
            request_id = str(event_detail.get("request_id") or "").strip()
            correction_event_id = indicator_correction_event_id(
                event,
                interval=interval,
                dirty_range=dirty_range,
            )
            correction_key = correction_event_id
            pending_keys = (
                pending_correction["keys"]
                if pending_correction is not None
                else {}
            )
            if (
                correction_key in completed_corrections
                or correction_key in active_correction_keys
                or correction_key in pending_keys
            ):
                return

            correction_revision = None
            if range_service is not None:
                correction_revision = range_service.note_correction(
                    series_key=f"{exchange}:{market_type}:{symbol}:{interval}",
                    start=dirty_range["start"],
                    end=dirty_range["end"],
                    event_id=correction_event_id,
                )
            _merge_pending_correction(
                correction_key=correction_key,
                correction_event_id=correction_event_id,
                dirty_range=dirty_range,
                correction_revision=correction_revision,
                barrier_request_id=(
                    request_id
                    if event.event_type == DataEventType.BACKFILL_COMPLETED
                    else None
                ),
                has_amendment=event.event_type == DataEventType.BAR_AMENDED,
            )
            if correction_task is not None and not correction_task.done():
                return

            existing = custom_tasks.get(client_id)

            async def _run_after_existing() -> None:
                if existing is not None and not existing.done():
                    try:
                        await asyncio.shield(existing)
                    except asyncio.CancelledError:
                        raise
                    except Exception:
                        pass
                if meta.get("_disposed"):
                    return
                await _run_correction_queue()

            correction_task = asyncio.create_task(
                _run_after_existing(),
                name=f"pyne_indicator_correction_{client_id}",
            )
            custom_tasks[client_id] = correction_task
            return

        # A completed parent correction rebuilds from the authoritative latest
        # closed history.  Do not cancel that work for an interim live tick.
        if correction_task is not None and not correction_task.done():
            if event.event_type == DataEventType.BAR_CLOSED and event.bar is not None:
                pending_realtime_event = event
                closed_frontier_generation += 1
                pending_frontier_closed = max(
                    pending_frontier_closed,
                    int(event.bar.time),
                )
            return
        existing = custom_tasks.get(client_id)
        if (
            event.event_type == DataEventType.BAR_UPDATED
            and existing is not None
            and not existing.done()
        ):
            return

        async def _run_realtime_serialized() -> None:
            if existing is not None and not existing.done():
                try:
                    await asyncio.shield(existing)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    pass
            if meta.get("_disposed"):
                return
            await _run_realtime_event(event)

        custom_tasks[client_id] = asyncio.create_task(
            _run_realtime_serialized(),
            name=f"pyne_indicator_{client_id}",
        )

    realtime_handle = dm.subscribe(
        callback=_on_data_event,
        symbol=symbol,
        interval=interval,
        exchange=exchange,
        market_type=market_type,
        event_types={
            DataEventType.BAR_UPDATED,
            DataEventType.BAR_CLOSED,
        },
    )
    custom_handles[client_id] = realtime_handle

    # One wildcard correction subscriber per WebSocket connection prevents
    # every global amendment/backfill event from being copied into N separate
    # DataManager subscriber queues.  The connection-local fanout is bounded
    # by its indicator subscription limit and filters market identity before
    # invoking the per-client correction router above.
    correction_state = (
        pyne_correction_state
        if isinstance(pyne_correction_state, dict)
        else {"handle": None, "callbacks": {}, "snapshot_tasks": OrderedDict()}
    )
    callbacks = correction_state.setdefault("callbacks", {})
    callbacks[client_id] = {
        "exchange": exchange,
        "market_type": market_type,
        "symbol": symbol,
        "callback": _on_data_event,
    }
    meta["_pyneCorrectionState"] = correction_state
    if correction_state.get("handle") is None:
        async def _fanout_correction(event: Any) -> None:
            event_exchange = str(event.key.exchange).lower().strip()
            event_market = str(event.key.market_type).lower().strip()
            event_symbol = str(event.key.symbol).upper().strip()
            for entry in list(callbacks.values()):
                if (
                    entry.get("exchange") != event_exchange
                    or entry.get("market_type") != event_market
                    or entry.get("symbol") != event_symbol
                ):
                    continue
                callback = entry.get("callback")
                if not callable(callback):
                    continue
                try:
                    await callback(event)
                except Exception:
                    logger.exception(
                        "Pyne correction fanout callback failed for %s",
                        event_symbol,
                    )

        correction_state["handle"] = dm.subscribe(
            callback=_fanout_correction,
            event_types={
                DataEventType.BAR_AMENDED,
                DataEventType.BACKFILL_COMPLETED,
            },
        )
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
