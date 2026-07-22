"""Credential-free reference plugin for the Phase 9 integration gateways."""

from __future__ import annotations

import hashlib
import json
import uuid
from importlib.resources import files
from typing import Any

from ..errors import PlatformContractError
from ..integration import (
    HOST_HTTP_REQUEST_METHOD,
    USER_FILE_READ_METHOD,
    USER_FILE_WRITE_METHOD,
    HostHttpRequest,
    HostHttpResponse,
    HttpEndpointRequest,
    HttpEndpointResponse,
    UserFileReadRequest,
    UserFileReadResponse,
    UserFileWriteReceipt,
    UserFileWriteRequest,
)
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


def integration_gateway_manifest() -> PluginManifest:
    resource = files(__package__).joinpath("integration-gateway.manifest.json")
    return PluginManifest.from_wire(loads_strict(resource.read_bytes()))


class IntegrationGatewayPlugin(BasePlatformPlugin):
    def __init__(self) -> None:
        self._manifest = integration_gateway_manifest()
        self._capabilities: dict[str, str] = {}
        self._pending: dict[str, str] = {}

    def manifest(self) -> PluginManifest:
        return self._manifest

    def describe(self) -> RuntimeDescriptor:
        return descriptor_from_manifest(self._manifest, entrypoint_id="main")

    def activate(self, request: ActivationRequest) -> None:
        self._capabilities = {item.permission_id: item.handle for item in request.capabilities}
        self._pending.clear()

    def deactivate(self, reason: str) -> None:
        self._capabilities.clear()
        self._pending.clear()

    def cancel(self, token: str) -> None:
        self._pending.pop(token, None)

    def health_check(self) -> dict[str, Any]:
        return {"status": "ready", "pendingIntegrations": len(self._pending)}

    def _call(
        self,
        request: InvokeRequest,
        *,
        permission_id: str,
        method: str,
        params: dict[str, Any],
        phase: str,
    ) -> HostCallInvocation:
        handle = self._capabilities.get(permission_id)
        if handle is None:
            raise PlatformContractError(
                "INVALID_CONTRACT", f"{permission_id} capability is unavailable"
            )
        token = f"integration-{uuid.uuid4().hex}"
        self._pending[token] = phase
        return HostCallInvocation(
            token=token,
            call=HostCallRequest(handle, method, params, request.request_context),
        )

    def invoke(self, request: InvokeRequest) -> InvocationOutcome:
        if request.contribution_id == "fetch-public":
            if set(request.input) != {"url"} or not isinstance(request.input["url"], str):
                raise PlatformContractError("INVALID_CONTRACT", "network input is invalid")
            return self._call(
                request,
                permission_id="network.connect",
                method=HOST_HTTP_REQUEST_METHOD,
                params=HostHttpRequest(
                    "GET", request.input["url"], {"accept": "text/plain"}
                ).to_host_params(),
                phase="network",
            )
        if request.contribution_id == "import-file":
            if set(request.input) != {"fileHandle"}:
                raise PlatformContractError("INVALID_CONTRACT", "file import input is invalid")
            return self._call(
                request,
                permission_id="filesystem.open-user-selected",
                method=USER_FILE_READ_METHOD,
                params=UserFileReadRequest(request.input["fileHandle"]).to_host_params(),
                phase="read",
            )
        if request.contribution_id == "export-file":
            if set(request.input) != {"fileHandle", "message"} or not isinstance(
                request.input["message"], str
            ):
                raise PlatformContractError("INVALID_CONTRACT", "file export input is invalid")
            body = json.dumps(
                {
                    "schemaVersion": "candlescope.integration-report/1",
                    "message": request.input["message"],
                },
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
            return self._call(
                request,
                permission_id="filesystem.save-user-selected",
                method=USER_FILE_WRITE_METHOD,
                params=UserFileWriteRequest(request.input["fileHandle"], body).to_host_params(),
                phase="write",
            )
        if request.contribution_id == "echo":
            endpoint = HttpEndpointRequest.from_invoke(request.input)
            response = {
                "method": endpoint.method,
                "headerKeys": sorted(endpoint.headers),
                "bodySha256": "sha256:" + hashlib.sha256(endpoint.body).hexdigest(),
                "bodyBytes": len(endpoint.body),
                "queryKeys": sorted(endpoint.query),
            }
            return HttpEndpointResponse(
                200,
                {"content-type": "application/json"},
                json.dumps(response, sort_keys=True, separators=(",", ":")).encode("utf-8"),
            ).to_wire()
        raise PlatformContractError(
            "INVALID_CONTRACT", "integration contribution is unknown", "invoke.contributionId"
        )

    def complete_host_call(self, token: str, response: RpcSuccess | RpcFailure) -> dict[str, Any]:
        phase = self._pending.pop(token, None)
        if phase is None:
            raise PlatformContractError("INVALID_CONTRACT", "integration token is stale")
        if isinstance(response, RpcFailure):
            return {"completed": False, "phase": phase, "error": response.error.code}
        if phase == "network":
            value = HostHttpResponse.from_wire(response.result)
            return {
                "completed": True,
                "status": value.status,
                "bodyBytes": len(value.body),
                "bodySha256": "sha256:" + hashlib.sha256(value.body).hexdigest(),
                "redirects": value.redirects,
            }
        if phase == "read":
            value = UserFileReadResponse.from_wire(response.result)
            return {
                "completed": True,
                "name": value.name,
                "mediaType": value.media_type,
                "size": value.size,
                "sha256": value.sha256,
            }
        if phase == "write":
            value = UserFileWriteReceipt.from_wire(response.result)
            return {
                "completed": True,
                "fileDownload": {
                    "downloadId": value.download_id,
                    "name": value.name,
                    "mediaType": value.media_type,
                    "size": value.size,
                    "sha256": value.sha256,
                },
            }
        raise PlatformContractError("INVALID_CONTRACT", "integration phase is invalid")


def main() -> int:
    return serve_platform_plugin(IntegrationGatewayPlugin())


if __name__ == "__main__":
    raise SystemExit(main())
