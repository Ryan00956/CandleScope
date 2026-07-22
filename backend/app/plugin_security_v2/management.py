"""Protected localhost management surface for Plugin Platform v2 permissions."""

from __future__ import annotations

import ipaddress
import re
import secrets
from collections.abc import Iterable
from typing import Any, Protocol
from urllib.parse import urlsplit

from candlescope_plugin_sdk.platform_v2 import PlatformContractError, loads_strict
from fastapi import APIRouter, Depends, HTTPException, Request

from app.plugin_installer_v2.errors import PlatformInstallerBaseError

from .errors import PlatformSecurityError


MAX_MANAGEMENT_BODY_BYTES = 64 * 1024
_USER_ACTION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$")
_FORWARDED_HEADERS = frozenset(
    {
        "forwarded",
        "x-forwarded-for",
        "x-forwarded-host",
        "x-forwarded-proto",
        "x-real-ip",
    }
)


class PermissionManager(Protocol):
    def permission_summary(
        self, plugin_id: str | None = None
    ) -> tuple[dict[str, Any], ...]: ...

    def permission_diff(self, plugin_id: str) -> Any: ...

    def grant_permission(
        self,
        plugin_id: str,
        permission_id: str,
        *,
        scope: dict[str, Any] | None = None,
        source: str = "cli",
        trace_id: str | None = None,
    ) -> Any: ...

    def deny_permission(
        self,
        plugin_id: str,
        permission_id: str,
        *,
        source: str = "cli",
        trace_id: str | None = None,
    ) -> Any: ...

    def revoke_permission(
        self,
        plugin_id: str,
        permission_id: str,
        *,
        source: str = "cli",
        trace_id: str | None = None,
    ) -> Any: ...


def _is_loopback_host(value: str | None) -> bool:
    if value is None:
        return False
    if value.casefold() == "localhost":
        return True
    try:
        return ipaddress.ip_address(value.split("%", 1)[0]).is_loopback
    except ValueError:
        return False


def _normalize_origin(value: str) -> str:
    parsed = urlsplit(value)
    if (
        parsed.scheme not in {"http", "https"}
        or parsed.username is not None
        or parsed.password is not None
        or not _is_loopback_host(parsed.hostname)
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("management origins must be exact loopback HTTP origins")
    return f"{parsed.scheme}://{parsed.netloc}"


class LocalManagementGuard:
    """Ephemeral credentials plus network and browser-origin checks."""

    def __init__(
        self,
        allowed_origins: Iterable[str],
        *,
        session_token: str | None = None,
        csrf_token: str | None = None,
    ) -> None:
        origins = frozenset(_normalize_origin(item) for item in allowed_origins)
        if not origins:
            raise ValueError("at least one loopback management origin is required")
        self.allowed_origins = origins
        self._session_token = session_token or secrets.token_urlsafe(32)
        self._csrf_token = csrf_token or secrets.token_urlsafe(32)
        if (
            not 32 <= len(self._session_token) <= 256
            or not 32 <= len(self._csrf_token) <= 256
            or secrets.compare_digest(self._session_token, self._csrf_token)
        ):
            raise ValueError(
                "management credentials must be distinct bounded high-entropy values"
            )

    def trusted_headers(self, *, user_action: str | None = None) -> dict[str, str]:
        """Return credentials only to the trusted desktop/bootstrap integration."""

        headers = {
            "Origin": sorted(self.allowed_origins)[0],
            "X-CandleScope-Plugin-Session": self._session_token,
            "X-CandleScope-CSRF": self._csrf_token,
        }
        if user_action is not None:
            headers["X-CandleScope-User-Action"] = user_action
        return headers

    async def __call__(self, request: Request) -> None:
        if any(name in request.headers for name in _FORWARDED_HEADERS):
            raise HTTPException(status_code=403, detail="forwarded requests are denied")
        if request.client is None or not _is_loopback_host(request.client.host):
            raise HTTPException(status_code=403, detail="loopback client required")
        if not _is_loopback_host(request.url.hostname):
            raise HTTPException(status_code=403, detail="loopback Host required")
        origin = request.headers.get("origin")
        if origin not in self.allowed_origins:
            raise HTTPException(status_code=403, detail="management Origin denied")
        session = request.headers.get("x-candlescope-plugin-session", "")
        if not secrets.compare_digest(session, self._session_token):
            raise HTTPException(status_code=403, detail="management session denied")
        if request.method not in {"GET", "HEAD"}:
            csrf = request.headers.get("x-candlescope-csrf", "")
            if not secrets.compare_digest(csrf, self._csrf_token):
                raise HTTPException(status_code=403, detail="management CSRF denied")
            user_action = request.headers.get("x-candlescope-user-action", "")
            if _USER_ACTION.fullmatch(user_action) is None:
                raise HTTPException(
                    status_code=403, detail="explicit user action identifier required"
                )
            request.state.plugin_user_action = user_action


def _management_error(exc: Exception) -> HTTPException:
    if isinstance(exc, (PlatformInstallerBaseError, PlatformSecurityError)):
        return HTTPException(status_code=409, detail=exc.to_dict())
    return HTTPException(status_code=500, detail="plugin management failed")


async def _grant_scope(request: Request) -> dict[str, Any] | None:
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            if int(content_length) > MAX_MANAGEMENT_BODY_BYTES:
                raise HTTPException(status_code=413, detail="request body is too large")
        except ValueError as exc:
            raise HTTPException(
                status_code=400, detail="invalid Content-Length"
            ) from exc
    body = await request.body()
    if len(body) > MAX_MANAGEMENT_BODY_BYTES:
        raise HTTPException(status_code=413, detail="request body is too large")
    if not body:
        return None
    try:
        value = loads_strict(body)
    except PlatformContractError as exc:
        raise HTTPException(status_code=400, detail="body must be strict JSON") from exc
    if not isinstance(value, dict) or set(value) != {"scope"}:
        raise HTTPException(
            status_code=400, detail="body must contain only the scope object"
        )
    scope = value["scope"]
    if scope is not None and not isinstance(scope, dict):
        raise HTTPException(status_code=400, detail="scope must be an object or null")
    return scope


def create_permission_management_router(
    manager: PermissionManager,
    guard: LocalManagementGuard,
    *,
    prefix: str = "/api/v2/plugins/security",
) -> APIRouter:
    async def enforce_guard(request: Request) -> None:
        await guard(request)

    router = APIRouter(
        prefix=prefix,
        tags=["plugin-platform-security"],
        dependencies=[Depends(enforce_guard)],
    )

    @router.get("/permissions")
    async def permissions(plugin_id: str | None = None) -> dict[str, Any]:
        try:
            return {"grants": list(manager.permission_summary(plugin_id))}
        except Exception as exc:
            raise _management_error(exc) from exc

    @router.get("/permissions/{plugin_id}/diff")
    async def permission_diff(plugin_id: str) -> dict[str, Any]:
        try:
            return {"permissionDiff": manager.permission_diff(plugin_id).to_wire()}
        except Exception as exc:
            raise _management_error(exc) from exc

    @router.post("/permissions/{plugin_id}/{permission_id}/grant")
    async def grant(
        plugin_id: str,
        permission_id: str,
        request: Request,
    ) -> dict[str, Any]:
        scope = await _grant_scope(request)
        try:
            result = manager.grant_permission(
                plugin_id,
                permission_id,
                scope=scope,
                source="management-api",
                trace_id=f"management-{request.state.plugin_user_action}",
            )
            return {"permissionChange": result.to_wire()}
        except Exception as exc:
            raise _management_error(exc) from exc

    def _decision_result(
        decision: str,
        plugin_id: str,
        permission_id: str,
        request: Request,
    ) -> dict[str, Any]:
        try:
            method = (
                manager.deny_permission
                if decision == "deny"
                else manager.revoke_permission
            )
            result = method(
                plugin_id,
                permission_id,
                source="management-api",
                trace_id=f"management-{request.state.plugin_user_action}",
            )
            return {"permissionChange": result.to_wire()}
        except Exception as exc:
            raise _management_error(exc) from exc

    @router.post("/permissions/{plugin_id}/{permission_id}/deny")
    async def deny(
        plugin_id: str,
        permission_id: str,
        request: Request,
    ) -> dict[str, Any]:
        return _decision_result("deny", plugin_id, permission_id, request)

    @router.post("/permissions/{plugin_id}/{permission_id}/revoke")
    async def revoke(
        plugin_id: str,
        permission_id: str,
        request: Request,
    ) -> dict[str, Any]:
        return _decision_result("revoke", plugin_id, permission_id, request)

    return router
