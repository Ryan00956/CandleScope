"""Alert rule and history API."""
from __future__ import annotations

from app.core.config import getenv as app_getenv

import asyncio
import json
import time

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from app.alerts.facade import AlertFacade
from app.alerts.models import (
    AlertAcknowledgedPatch,
    AlertDispatchReceiptPayload,
    AlertEnabledPatch,
    AlertEvaluatePayload,
    AlertRulePayload,
    AlertTriggerPayload,
    dump_model,
)

router = APIRouter(prefix="/alerts", tags=["alerts"])
_facade = AlertFacade()


def _get_facade(request: Request) -> AlertFacade:
    facade = getattr(request.app.state, "alert_facade", None)
    return facade if isinstance(facade, AlertFacade) else _facade


def _get_runtime(request: Request):
    return getattr(request.app.state, "alert_runtime", None)


def _manual_trigger_enabled(request: Request) -> bool:
    override = getattr(request.app.state, "alert_manual_trigger_enabled", None)
    if isinstance(override, bool):
        return override
    return app_getenv("ALERT_MANUAL_TRIGGER_ENABLED", "0").strip() == "1"


async def _sync_runtime_rule(request: Request, rule: dict) -> None:
    runtime = _get_runtime(request)
    sync_rule = getattr(runtime, "sync_rule", None)
    if callable(sync_rule):
        await sync_rule(rule)


async def _remove_runtime_rule(request: Request, rule_id: str) -> None:
    runtime = _get_runtime(request)
    remove_rule = getattr(runtime, "remove_rule", None)
    if callable(remove_rule):
        await remove_rule(rule_id)


@router.get("/rules")
async def list_alert_rules(request: Request) -> list[dict]:
    try:
        return _get_facade(request).list_rules()
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/rules")
async def create_alert_rule(request: Request, payload: AlertRulePayload) -> dict:
    try:
        data = dump_model(payload)
        data.pop("id", None)
        rule = _get_facade(request).save_rule(data)
        await _sync_runtime_rule(request, rule)
        return rule
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/rules/{rule_id}")
async def get_alert_rule(request: Request, rule_id: str) -> dict:
    try:
        rule = _get_facade(request).get_rule(rule_id)
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    if rule is None:
        raise HTTPException(status_code=404, detail=f"Alert rule '{rule_id}' not found")
    return rule


@router.put("/rules/{rule_id}")
async def update_alert_rule(request: Request, rule_id: str, payload: AlertRulePayload) -> dict:
    try:
        if _get_facade(request).get_rule(rule_id) is None:
            raise HTTPException(status_code=404, detail=f"Alert rule '{rule_id}' not found")
        data = dump_model(payload)
        data["id"] = rule_id
        rule = _get_facade(request).save_rule(data)
        await _sync_runtime_rule(request, rule)
        return rule
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.patch("/rules/{rule_id}/enabled")
async def set_alert_rule_enabled(request: Request, rule_id: str, payload: AlertEnabledPatch) -> dict:
    try:
        rule = _get_facade(request).set_enabled(rule_id, payload.enabled)
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    if rule is None:
        raise HTTPException(status_code=404, detail=f"Alert rule '{rule_id}' not found")
    await _sync_runtime_rule(request, rule)
    return rule


@router.delete("/rules/{rule_id}")
async def delete_alert_rule(request: Request, rule_id: str) -> dict:
    try:
        deleted = _get_facade(request).delete_rule(rule_id)
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Alert rule '{rule_id}' not found")
    await _remove_runtime_rule(request, rule_id)
    return {"ok": True, "id": rule_id}


@router.get("/history")
async def list_alert_history(
    request: Request,
    limit: int = Query(100, ge=1, le=1000),
    rule_id: str | None = Query(None),
    since_ms: int | None = Query(None, ge=0),
    acknowledged: bool | None = Query(None),
) -> list[dict]:
    try:
        return _get_facade(request).list_history(
            limit=limit,
            rule_id=rule_id,
            since_ms=since_ms,
            acknowledged=acknowledged,
        )
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.patch("/history/{event_id}/acknowledged")
async def set_alert_history_acknowledged(
    request: Request,
    event_id: str,
    payload: AlertAcknowledgedPatch,
) -> dict:
    try:
        event = _get_facade(request).acknowledge_history(event_id, payload.acknowledged)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if event is None:
        raise HTTPException(status_code=404, detail=f"Alert event '{event_id}' not found")
    return event


@router.post("/events/{event_id}/dispatch/{dispatch_id}/receipt")
async def record_alert_dispatch_receipt(
    request: Request,
    event_id: str,
    dispatch_id: str,
    payload: AlertDispatchReceiptPayload,
) -> dict:
    if payload.status not in {"delivered", "denied", "unsupported", "error"}:
        raise HTTPException(status_code=400, detail="Unsupported alert dispatch receipt status")
    try:
        event = _get_facade(request).record_dispatch_receipt(
            event_id,
            dispatch_id,
            status=payload.status,
            detail=payload.detail,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if event is None:
        raise HTTPException(status_code=404, detail="Alert dispatch was not found")
    return event


@router.get("/events/stream")
async def stream_alert_notifications(request: Request) -> StreamingResponse:
    facade = _get_facade(request)
    broker = facade.notification_broker

    async def events():
        subscription = broker.subscribe()
        try:
            yield "retry: 2000\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    item = await asyncio.wait_for(subscription.queue.get(), timeout=15.0)
                except TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                data = json.dumps(item, ensure_ascii=False, separators=(",", ":"))
                yield (
                    f"id: {item.get('dispatchId', '')}\n"
                    "event: alert.notification\n"
                    f"data: {data}\n\n"
                )
        finally:
            broker.unsubscribe(subscription)

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            # GZipMiddleware buffers small streaming frames until its threshold.
            # An explicit identity encoding keeps SSE notifications immediate.
            "Content-Encoding": "identity",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/status")
async def get_alert_status(request: Request) -> dict:
    facade = _get_facade(request)
    runtime = _get_runtime(request)
    return {
        **facade.status(),
        "runtime": runtime.snapshot() if runtime is not None else {
            "started": False,
            "dataManager": False,
            "status": "unavailable",
            "subscriptions": [],
        },
    }


@router.post("/evaluate")
async def evaluate_alert_expression(request: Request, payload: AlertEvaluatePayload) -> dict:
    """Dry-run an alert expression against supplied current/previous values."""
    try:
        data = dump_model(payload)
        return _get_facade(request).evaluate(data.get("expression") or {}, data.get("context") or {})
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/events/triggered")
async def emit_alert_triggered(request: Request, payload: AlertTriggerPayload) -> dict:
    """Internal/dev trigger probe; disabled by default in normal deployments."""
    if not _manual_trigger_enabled(request):
        raise HTTPException(status_code=404, detail="Not found")
    try:
        facade = _get_facade(request)
        data = dump_model(payload)
        rule_id = str(data.get("ruleId") or "").strip()
        rule = facade.get_rule(rule_id)
        if rule is None:
            raise HTTPException(status_code=404, detail=f"Alert rule '{rule_id}' not found")
        data.update({
            "eventType": "alert.triggered",
            "target": rule.get("target") if isinstance(rule.get("target"), dict) else {},
            "actions": rule.get("actions") if isinstance(rule.get("actions"), list) else [],
            "createdAt": int(time.time() * 1000),
        })
        event = await facade.emit_triggered(
            data,
            enforce_limits=True,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if event is None:
        raise HTTPException(
            status_code=409,
            detail="Alert rule is disabled, expired, cooling down, or at its trigger limit",
        )
    return event
