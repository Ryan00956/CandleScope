"""Public safe catalog and guarded local management API for Plugin Platform v2."""

from __future__ import annotations

import asyncio
from typing import Any

from candlescope_plugin_sdk.platform_v2 import PlatformContractError, loads_strict
from fastapi import APIRouter, HTTPException, Request

from app.plugin_installer_v2.errors import PlatformInstallerBaseError
from app.plugin_security_v2.errors import PlatformSecurityError
from app.plugin_security_v2.management import LocalManagementGuard

from .errors import CorePluginError
from .runtime import CorePluginPlatform, DisabledCorePluginPlatform


MAX_CORE_API_BODY_BYTES = 256 * 1024


def _platform(request: Request) -> CorePluginPlatform | DisabledCorePluginPlatform:
    platform = getattr(request.app.state, "plugin_platform_v2", None)
    if platform is None:
        return DisabledCorePluginPlatform()
    return platform


async def _guarded_platform(request: Request) -> CorePluginPlatform:
    platform = _platform(request)
    guard = getattr(request.app.state, "plugin_platform_v2_management_guard", None)
    if not isinstance(platform, CorePluginPlatform) or not isinstance(
        guard, LocalManagementGuard
    ):
        raise HTTPException(status_code=503, detail="plugin platform v2 is disabled")
    await guard(request)
    return platform


async def _body(request: Request, *, required: set[str]) -> dict[str, Any]:
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            if int(content_length) > MAX_CORE_API_BODY_BYTES:
                raise HTTPException(status_code=413, detail="request body is too large")
        except ValueError as exc:
            raise HTTPException(
                status_code=400, detail="invalid Content-Length"
            ) from exc
    raw = await request.body()
    if not 0 < len(raw) <= MAX_CORE_API_BODY_BYTES:
        raise HTTPException(status_code=400, detail="request body is required")
    try:
        value = loads_strict(raw)
    except PlatformContractError as exc:
        raise HTTPException(status_code=400, detail="body must be strict JSON") from exc
    if not isinstance(value, dict) or set(value) != required:
        raise HTTPException(status_code=400, detail="request body shape is invalid")
    return value


def _raise_api_error(exc: Exception) -> None:
    if isinstance(
        exc,
        (CorePluginError, PlatformInstallerBaseError, PlatformSecurityError),
    ):
        raise HTTPException(status_code=409, detail=exc.to_dict()) from exc
    raise HTTPException(
        status_code=500, detail="plugin platform operation failed"
    ) from exc


def create_core_plugin_router() -> APIRouter:
    router = APIRouter(prefix="/api/v2/plugins", tags=["plugin-platform-v2"])

    @router.get("/catalog")
    async def catalog(request: Request) -> dict[str, Any]:
        return _platform(request).catalog()

    @router.get("/manage/diagnostics")
    async def diagnostics(request: Request) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        return platform.diagnostics()

    @router.get("/manage/permissions")
    async def permissions(
        request: Request, plugin_id: str | None = None
    ) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        try:
            values = await asyncio.to_thread(
                platform.installer.permission_summary, plugin_id
            )
            return {"grants": list(values)}
        except Exception as exc:
            _raise_api_error(exc)

    @router.post("/manage/{plugin_id}/enable")
    async def enable(plugin_id: str, request: Request) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        try:
            result = await asyncio.to_thread(platform.installer.enable, plugin_id)
            await platform.reconcile_plugin(plugin_id)
            return {"stateChange": result.to_wire()}
        except Exception as exc:
            _raise_api_error(exc)

    @router.post("/manage/{plugin_id}/disable")
    async def disable(plugin_id: str, request: Request) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        try:
            result = await asyncio.to_thread(platform.installer.disable, plugin_id)
            await platform.reconcile_plugin(plugin_id)
            return {"stateChange": result.to_wire()}
        except Exception as exc:
            _raise_api_error(exc)

    @router.post("/manage/{plugin_id}/rollback")
    async def rollback(plugin_id: str, request: Request) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        try:
            result = await asyncio.to_thread(platform.installer.rollback, plugin_id)
            await platform.reconcile_plugin(plugin_id)
            return {"rollback": result.to_wire()}
        except Exception as exc:
            _raise_api_error(exc)

    @router.post("/manage/{plugin_id}/uninstall")
    async def uninstall(plugin_id: str, request: Request) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        try:
            result = await asyncio.to_thread(platform.installer.uninstall, plugin_id)
            await platform.reconcile_plugin(plugin_id)
            return {"stateChange": result.to_wire()}
        except Exception as exc:
            _raise_api_error(exc)

    @router.post("/manage/{plugin_id}/permissions/{permission_id}/{decision}")
    async def permission_change(
        plugin_id: str,
        permission_id: str,
        decision: str,
        request: Request,
    ) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        if decision not in {"grant", "deny", "revoke"}:
            raise HTTPException(
                status_code=404, detail="permission decision is unknown"
            )
        try:
            action = request.state.plugin_user_action
            if decision == "grant":
                value = await _body(request, required={"scope"})
                if value["scope"] is not None and not isinstance(value["scope"], dict):
                    raise HTTPException(
                        status_code=400, detail="scope must be an object or null"
                    )
                result = await asyncio.to_thread(
                    platform.installer.grant_permission,
                    plugin_id,
                    permission_id,
                    scope=value["scope"],
                    source="management-api",
                    trace_id=f"management-{action}",
                )
            else:
                if await request.body():
                    raise HTTPException(
                        status_code=400, detail="decision body must be empty"
                    )
                method = (
                    platform.installer.deny_permission
                    if decision == "deny"
                    else platform.installer.revoke_permission
                )
                result = await asyncio.to_thread(
                    method,
                    plugin_id,
                    permission_id,
                    source="management-api",
                    trace_id=f"management-{action}",
                )
            await platform.reconcile_plugin(plugin_id)
            return {"permissionChange": result.to_wire()}
        except HTTPException:
            raise
        except Exception as exc:
            _raise_api_error(exc)

    @router.post("/manage/commands/{contribution_id:path}/invoke")
    async def invoke_command(contribution_id: str, request: Request) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        try:
            value = await _body(request, required={"input"})
            if not isinstance(value["input"], dict):
                raise HTTPException(
                    status_code=400, detail="command input must be an object"
                )
            action = request.state.plugin_user_action
            result = await platform.invoke_command(
                contribution_id,
                value["input"],
                user_action=True,
                trace_id=f"management-{action}",
            )
            return {"result": result}
        except HTTPException:
            raise
        except Exception as exc:
            _raise_api_error(exc)

    @router.post("/manage/jobs/{contribution_id:path}/run")
    async def run_job(contribution_id: str, request: Request) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        try:
            if await request.body():
                raise HTTPException(
                    status_code=400, detail="job trigger body must be empty"
                )
            return {
                "jobRun": await platform.trigger_job(contribution_id, user_action=True)
            }
        except HTTPException:
            raise
        except Exception as exc:
            _raise_api_error(exc)

    @router.get("/manage/settings/{contribution_id:path}")
    async def read_settings(contribution_id: str, request: Request) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        try:
            return {"settings": await platform.read_settings(contribution_id)}
        except Exception as exc:
            _raise_api_error(exc)

    @router.put("/manage/settings/{contribution_id:path}")
    async def write_settings(contribution_id: str, request: Request) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        try:
            value = await _body(request, required={"value"})
            if not isinstance(value["value"], dict):
                raise HTTPException(
                    status_code=400, detail="settings value must be an object"
                )
            return {
                "settings": await platform.write_settings(
                    contribution_id, value["value"]
                )
            }
        except HTTPException:
            raise
        except Exception as exc:
            _raise_api_error(exc)

    @router.get("/manage/notifications")
    async def notifications(
        request: Request, plugin_id: str | None = None
    ) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        return {"notifications": platform.notifications.snapshot(plugin_id=plugin_id)}

    return router
