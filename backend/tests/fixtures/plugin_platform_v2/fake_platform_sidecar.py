"""Fault-injectable Plugin Platform v2 sidecar for Host control-plane tests."""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any


REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
SDK_SOURCE = REPOSITORY_ROOT / "packages" / "candlescope-plugin-sdk" / "src"
sys.path.insert(0, str(SDK_SOURCE))

from candlescope_plugin_sdk.platform_v2 import (  # noqa: E402
    CONTROL_TRANSPORT_V1,
    PLUGIN_PROTOCOL_V2,
    ActivationRequest,
    BasePlatformPlugin,
    HostCallInvocation,
    HostCallRequest,
    InvokeRequest,
    PlatformJsonLineServer,
    PluginManifest,
    RequestContext,
    RpcError,
    RpcFailure,
    RpcSuccess,
    RuntimeDescriptor,
    canonical_dumps,
    descriptor_from_manifest,
)
from candlescope_plugin_sdk.platform_v2.examples.hello_command import (  # noqa: E402
    HelloCommandPlugin,
    hello_manifest,
)


MODE = sys.argv[1] if len(sys.argv) > 1 else "good"


def host_call_manifest() -> PluginManifest:
    value = hello_manifest().to_wire()
    value["plugin"] = {
        **value["plugin"],
        "id": "candlescope.host-call",
        "name": "Host Call",
    }
    value["permissions"]["optional"] = [{"id": "notifications.show", "scope": {}}]
    value["probes"] = []
    return PluginManifest.from_wire(value)


class HostCallingPlugin(BasePlatformPlugin):
    def __init__(self) -> None:
        self._manifest = host_call_manifest()
        self._capability_handle = "cap-notify"
        self._request_context: RequestContext | None = None

    def manifest(self) -> PluginManifest:
        return self._manifest

    def describe(self) -> RuntimeDescriptor:
        return descriptor_from_manifest(self._manifest, entrypoint_id="main")

    def activate(self, request: ActivationRequest) -> None:
        for capability in request.capabilities:
            if capability.permission_id == "notifications.show":
                self._capability_handle = capability.handle

    def invoke(self, request: InvokeRequest) -> HostCallInvocation:
        self._request_context = request.request_context
        return HostCallInvocation(
            token=f"notify:{request.request_context.trace_id}",
            call=HostCallRequest(
                capability_handle=self._capability_handle,
                method="notifications.show",
                params={"message": "Hello from the sidecar"},
                request_context=request.request_context,
            ),
        )

    def event_batch(
        self,
        events: tuple[dict[str, Any], ...],
        delivery: dict[str, Any],
    ) -> dict[str, Any] | HostCallInvocation:
        if MODE != "event-host-call":
            return {"accepted": len(events)}
        context = RequestContext.from_wire(delivery["requestContext"])
        self._request_context = context
        return HostCallInvocation(
            token=f"event:{context.trace_id}",
            call=HostCallRequest(
                capability_handle=self._capability_handle,
                method="notifications.show",
                params={"message": "Event batch from the sidecar"},
                request_context=context,
            ),
        )

    def complete_host_call(
        self,
        token: str,
        response: RpcSuccess | RpcFailure,
    ) -> dict[str, Any] | HostCallInvocation:
        if isinstance(response, RpcFailure):
            return {"notified": False, "error": response.error.code, "token": token}
        if MODE == "host-call-chain" and not token.endswith(":chain"):
            assert self._request_context is not None
            return HostCallInvocation(
                token=f"{token}:chain",
                call=HostCallRequest(
                    capability_handle=self._capability_handle,
                    method="notifications.show",
                    params={"message": "Second chained notification"},
                    request_context=self._request_context,
                ),
            )
        return {"notified": True, "receipt": response.result, "token": token}


def _method(line: str) -> str | None:
    try:
        value = json.loads(line)
    except json.JSONDecodeError:
        return None
    return value.get("method") if isinstance(value, dict) else None


def _request_id(line: str) -> Any:
    try:
        value = json.loads(line)
    except json.JSONDecodeError:
        return None
    return value.get("id") if isinstance(value, dict) else None


def main() -> int:
    if MODE == "environment-probe" and "CANDLESCOPE_TEST_SECRET" in os.environ:
        return 97
    plugin: BasePlatformPlugin = (
        HostCallingPlugin()
        if MODE
        in {
            "host-call",
            "host-call-chain",
            "host-call-forged-user-action",
            "event-host-call",
            "accept-missing-host-api",
        }
        else HelloCommandPlugin()
    )
    server = PlatformJsonLineServer(plugin)
    first = True
    if MODE == "stdout-pollution":
        print("plugin wrote a log to stdout", flush=True)
    if MODE == "invalid-utf8":
        sys.stdout.buffer.write(b"\xff\n")
        sys.stdout.buffer.flush()
        return 0
    if MODE in {"stderr-flood", "stderr-crash-start"}:
        sys.stderr.write("S" * 200_000)
        sys.stderr.flush()

    delayed_invoke_response: dict[str, Any] | None = None
    for line in sys.stdin:
        method = _method(line)
        request_id = _request_id(line)
        if first and MODE in {"crash-start", "stderr-crash-start"}:
            return 17
        if first and MODE == "oversize":
            print(json.dumps({"padding": "x" * 20_000}), flush=True)
            return 0
        if first and MODE == "duplicate-key":
            print(
                '{"jsonrpc":"2.0","id":"a","id":"b","result":{},"generation":0}',
                flush=True,
            )
            return 0
        if method == "invoke" and MODE == "hang-invoke":
            time.sleep(30)
        if method == "activate" and MODE == "hang-activate":
            time.sleep(30)
        if method == "shutdown" and MODE == "hang-shutdown":
            time.sleep(30)
        if method == "invoke" and MODE == "crash-invoke":
            return 23

        responses = [dict(item) for item in server.handle_line(line)]
        if method == "invoke" and MODE == "host-call-forged-user-action":
            for response in responses:
                if response.get("method") == "host.call":
                    response["params"]["requestContext"]["userAction"] = True
        if first and MODE == "accept-missing-host-api" and method == "handshake":
            responses = [
                RpcSuccess(
                    request_id,
                    {
                        "protocol": PLUGIN_PROTOCOL_V2,
                        "transport": CONTROL_TRANSPORT_V1,
                        "descriptor": plugin.describe().to_wire(),
                        "negotiatedHostApis": [],
                    },
                    0,
                ).to_wire()
            ]
        if first and MODE == "wrong-id" and responses:
            responses[0]["id"] = f"wrong:{request_id}"
        if method == "invoke" and MODE == "stale-invoke" and responses:
            responses[0]["generation"] = 0
        if method == "activate" and MODE == "bad-activate" and responses:
            responses[0]["result"] = {"ok": False}
        if method == "deactivate" and MODE == "bad-deactivate" and responses:
            responses[0]["result"] = {"ok": False}
        if method == "prepareUpgrade" and MODE == "bad-upgrade" and responses:
            responses[0]["result"] = {"ok": False}
        remote_error_methods = {
            "remote-error-activate": "activate",
            "remote-error-deactivate": "deactivate",
            "remote-error-upgrade": "prepareUpgrade",
        }
        if MODE in remote_error_methods and method == remote_error_methods[MODE]:
            responses[-1] = RpcFailure(
                request_id,
                RpcError(
                    rpc_code=-32000,
                    code="INJECTED_LIFECYCLE_ERROR",
                    message="fault-injected lifecycle error",
                ),
                1,
            ).to_wire()
        if method == "invoke" and MODE == "late-success-after-deactivate" and responses:
            delayed_invoke_response = responses.pop(0)
        for response in responses:
            print(canonical_dumps(response), flush=True)
        if (
            method == "deactivate"
            and MODE == "late-success-after-deactivate"
            and delayed_invoke_response is not None
        ):
            time.sleep(0.05)
            print(canonical_dumps(delayed_invoke_response), flush=True)
            delayed_invoke_response = None
        if method == "activate" and MODE == "exit-after-activate":
            return 29
        first = False
        if server.dispatcher.shutdown_requested:
            return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
