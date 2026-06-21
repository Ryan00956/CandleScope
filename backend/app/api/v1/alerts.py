"""Alert rule and history API."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request

from app.alerts.facade import AlertFacade
from app.alerts.models import (
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
) -> list[dict]:
    try:
        return _get_facade(request).list_history(limit=limit, rule_id=rule_id)
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


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
    """Internal/dev endpoint for recording a triggered alert event.

    The real-time engine will call the same facade method directly once it is
    wired to market-data and indicator events.
    """
    try:
        return await _get_facade(request).emit_triggered(dump_model(payload))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
