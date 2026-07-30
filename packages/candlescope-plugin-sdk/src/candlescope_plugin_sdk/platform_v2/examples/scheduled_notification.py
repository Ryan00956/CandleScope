"""No-UI scheduled notification reference plugin for the Phase 5 Host."""

from __future__ import annotations

from importlib.resources import files
from typing import Any

from ..errors import PlatformContractError
from ..json_codec import loads_strict
from ..models import (
    ActivationRequest,
    HostCallRequest,
    InvokeRequest,
    PluginManifest,
    RuntimeDescriptor,
    descriptor_from_manifest,
)
from ..rpc import RpcFailure, RpcSuccess
from ..runtime import BasePlatformPlugin, HostCallInvocation, InvocationOutcome
from ..server import serve_platform_plugin


def scheduled_notification_manifest() -> PluginManifest:
    resource = files(__package__).joinpath("scheduled-notification.manifest.json")
    return PluginManifest.from_wire(loads_strict(resource.read_bytes()))


class ScheduledNotificationPlugin(BasePlatformPlugin):
    def __init__(self) -> None:
        self._manifest = scheduled_notification_manifest()
        self._capabilities: dict[str, str] = {}

    def manifest(self) -> PluginManifest:
        return self._manifest

    def describe(self) -> RuntimeDescriptor:
        return descriptor_from_manifest(self._manifest, entrypoint_id="main")

    def activate(self, request: ActivationRequest) -> None:
        self._capabilities = {item.permission_id: item.handle for item in request.capabilities}

    def deactivate(self, reason: str) -> None:
        self._capabilities.clear()

    def invoke(self, request: InvokeRequest) -> InvocationOutcome:
        if request.contribution_id != "reminder-job":
            raise PlatformContractError(
                "INVALID_CONTRACT",
                "only the reminder job is invokable",
                "invoke.contributionId",
            )
        required = {"runId", "reason", "attempt", "scheduledAt"}
        if set(request.input) != required:
            raise PlatformContractError(
                "INVALID_CONTRACT",
                "scheduled reminder input shape is invalid",
                "invoke.input",
            )
        handle = self._capabilities.get("notifications.show")
        if handle is None:
            raise PlatformContractError(
                "INVALID_CONTRACT", "notifications.show capability is unavailable"
            )
        return HostCallInvocation(
            call=HostCallRequest(
                capability_handle=handle,
                method="notifications.show",
                params={
                    "sourceId": "reminder-source",
                    "channel": "toast",
                    "severity": "info",
                    "title": "CandleScope reminder",
                    "message": "This notification was delivered by a scheduled plugin job.",
                },
                request_context=request.request_context,
            ),
            token=f"reminder:{request.input['runId']}",
        )

    def complete_host_call(
        self,
        token: str,
        response: RpcSuccess | RpcFailure,
    ) -> dict[str, Any]:
        if isinstance(response, RpcFailure):
            return {
                "notified": False,
                "error": response.error.code,
                "token": token,
            }
        return {"notified": True, "receipt": response.result, "token": token}


def main() -> int:
    return serve_platform_plugin(ScheduledNotificationPlugin())


if __name__ == "__main__":
    raise SystemExit(main())
