from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from app.plugin_security_v2.management import (
    LocalManagementGuard,
    create_permission_management_router,
)


@dataclass
class _WireResult:
    value: dict[str, Any]

    def to_wire(self) -> dict[str, Any]:
        return dict(self.value)


class _PermissionManager:
    def __init__(self) -> None:
        self.calls: list[tuple[Any, ...]] = []

    def permission_summary(
        self, plugin_id: str | None = None
    ) -> tuple[dict[str, Any], ...]:
        return (
            {
                "pluginId": plugin_id or "candlescope.example",
                "permissions": [
                    {
                        "permissionId": "notifications.show",
                        "requestedScope": {"channels": ["toast"]},
                        "grantedScope": None,
                        "decision": "pending",
                    }
                ],
            },
        )

    def permission_diff(self, plugin_id: str) -> _WireResult:
        return _WireResult({"pluginId": plugin_id, "requiresConfirmation": True})

    def grant_permission(self, *args: Any, **kwargs: Any) -> _WireResult:
        self.calls.append(("grant", *args, kwargs))
        return _WireResult({"decision": "granted"})

    def deny_permission(self, *args: Any, **kwargs: Any) -> _WireResult:
        self.calls.append(("deny", *args, kwargs))
        return _WireResult({"decision": "denied"})

    def revoke_permission(self, *args: Any, **kwargs: Any) -> _WireResult:
        self.calls.append(("revoke", *args, kwargs))
        return _WireResult({"decision": "revoked"})


def _app(manager: _PermissionManager, guard: LocalManagementGuard) -> FastAPI:
    app = FastAPI()
    app.include_router(create_permission_management_router(manager, guard))
    return app


def test_management_guard_rejects_weak_or_reused_credentials() -> None:
    with pytest.raises(ValueError, match="high-entropy"):
        LocalManagementGuard(
            ("http://127.0.0.1:5173",),
            session_token="short",
            csrf_token="also-short",
        )
    repeated = "same-management-token-0123456789abcdef"
    with pytest.raises(ValueError, match="distinct"):
        LocalManagementGuard(
            ("http://127.0.0.1:5173",),
            session_token=repeated,
            csrf_token=repeated,
        )


@pytest.mark.anyio
async def test_management_api_requires_loopback_origin_session_csrf_and_user_action() -> (
    None
):
    manager = _PermissionManager()
    guard = LocalManagementGuard(
        ("http://127.0.0.1:5173",),
        session_token="session-test-token-0123456789abcdef",
        csrf_token="csrf-test-token-0123456789abcdefghi",
    )
    app = _app(manager, guard)
    transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 43100))
    path = "/api/v2/plugins/security/permissions"
    trusted = guard.trusted_headers()
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://127.0.0.1",
    ) as client:
        assert (await client.get(path)).status_code == 403
        forged = {**trusted, "X-CandleScope-Plugin-Session": "forged"}
        assert (await client.get(path, headers=forged)).status_code == 403
        wrong_origin = {**trusted, "Origin": "http://localhost:5173"}
        assert (await client.get(path, headers=wrong_origin)).status_code == 403
        forwarded = {**trusted, "X-Forwarded-For": "127.0.0.1"}
        assert (await client.get(path, headers=forwarded)).status_code == 403

        allowed = await client.get(path, headers=trusted)
        assert allowed.status_code == 200
        response_text = allowed.text
        assert "session-test-token-0123456789abcdef" not in response_text
        assert "csrf-test-token-0123456789abcdefghi" not in response_text

        mutation_path = path + "/candlescope.example/notifications.show/grant"
        assert (
            await client.post(
                mutation_path,
                headers={
                    key: value
                    for key, value in trusted.items()
                    if key != "X-CandleScope-CSRF"
                },
                json={"scope": {"channels": ["toast"]}},
            )
        ).status_code == 403
        assert (
            await client.post(
                mutation_path,
                headers=trusted,
                json={"scope": {"channels": ["toast"]}},
            )
        ).status_code == 403
        action_headers = guard.trusted_headers(user_action="click-grant-1")
        changed = await client.post(
            mutation_path,
            headers=action_headers,
            json={"scope": {"channels": ["toast"]}},
        )
        assert changed.status_code == 200
        assert changed.json()["permissionChange"]["decision"] == "granted"
    assert manager.calls == [
        (
            "grant",
            "candlescope.example",
            "notifications.show",
            {
                "scope": {"channels": ["toast"]},
                "source": "management-api",
                "trace_id": "management-click-grant-1",
            },
        )
    ]


@pytest.mark.anyio
async def test_management_api_rejects_non_loopback_client_and_host() -> None:
    manager = _PermissionManager()
    guard = LocalManagementGuard(
        ("http://127.0.0.1:5173",),
        session_token="session-test-token-0123456789abcdef",
        csrf_token="csrf-test-token-0123456789abcdefghi",
    )
    app = _app(manager, guard)
    external_transport = httpx.ASGITransport(app=app, client=("192.0.2.10", 43100))
    async with httpx.AsyncClient(
        transport=external_transport,
        base_url="http://127.0.0.1",
    ) as client:
        response = await client.get(
            "/api/v2/plugins/security/permissions",
            headers=guard.trusted_headers(),
        )
        assert response.status_code == 403

    loopback_transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 43100))
    async with httpx.AsyncClient(
        transport=loopback_transport,
        base_url="http://example.invalid",
    ) as client:
        response = await client.get(
            "/api/v2/plugins/security/permissions",
            headers=guard.trusted_headers(),
        )
        assert response.status_code == 403
