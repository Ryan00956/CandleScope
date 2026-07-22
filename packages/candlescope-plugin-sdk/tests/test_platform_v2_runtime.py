from __future__ import annotations

import json
from dataclasses import replace

from candlescope_plugin_sdk.platform_v2 import (
    HOST_API_V1,
    BasePlatformPlugin,
    CapabilityGrant,
    HostCallInvocation,
    HostCallRequest,
    InvokeRequest,
    PermissionRequest,
    PermissionSet,
    PlatformJsonLineServer,
    PluginManifest,
    RpcFailure,
    RpcSuccess,
    RuntimeDescriptor,
    descriptor_from_manifest,
)
from candlescope_plugin_sdk.platform_v2.examples.hello_command import (
    HelloCommandPlugin,
    hello_manifest,
)


def _request(
    request_id: str,
    method: str,
    *,
    generation: int,
    params: dict | None = None,
) -> dict:
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "method": method,
        "params": params or {},
        "generation": generation,
    }


def _handshake(*host_apis: str) -> dict:
    return _request(
        "handshake-1",
        "handshake",
        generation=0,
        params={
            "protocols": ["candlescope.plugin/2"],
            "host": {"name": "CandleScope", "version": "0.4.0"},
            "entrypointId": "main",
            "hostApis": list(host_apis),
            "transports": ["jsonl/1"],
        },
    )


def _activate(*capabilities: CapabilityGrant) -> dict:
    return _request(
        "activate-1",
        "activate",
        generation=1,
        params={
            "instanceId": "instance-hello-1",
            "generation": 1,
            "capabilities": [item.to_wire() for item in capabilities],
        },
    )


def _invoke(request_id: str, input_value: dict, *, trace_id: str) -> dict:
    return _request(
        request_id,
        "invoke",
        generation=1,
        params={
            "contributionId": "hello",
            "input": input_value,
            "requestContext": {
                "contributionId": "hello",
                "userAction": True,
                "generation": 1,
                "traceId": trace_id,
            },
        },
    )


def test_hello_command_lifecycle_deferred_cancel_and_shutdown() -> None:
    server = PlatformJsonLineServer(HelloCommandPlugin())

    handshake = server.handle_message(_handshake())
    describe = server.handle_message(_request("describe-1", "describe", generation=0))
    activate = server.handle_message(_activate())
    invoked = server.handle_message(
        _invoke("invoke-1", {"name": "CandleScope"}, trace_id="trace-1")
    )
    deferred = server.handle_message(
        _invoke("invoke-2", {"name": "later", "defer": True}, trace_id="trace-2")
    )
    health_pending = server.handle_message(_request("health-1", "healthCheck", generation=1))
    cancelled = server.handle_message(
        _request(
            "cancel-1",
            "cancel",
            generation=1,
            params={"requestId": "invoke-2"},
        )
    )
    health_clear = server.handle_message(_request("health-2", "healthCheck", generation=1))
    deactivated = server.handle_message(
        _request(
            "deactivate-1",
            "deactivate",
            generation=1,
            params={"reason": "test complete"},
        )
    )
    shutdown = server.handle_message(_request("shutdown-1", "shutdown", generation=0))

    assert handshake[0]["result"]["protocol"] == "candlescope.plugin/2"
    assert handshake[0]["result"]["negotiatedHostApis"] == []
    assert describe[0]["result"]["contributions"][0]["id"] == "hello"
    assert activate[0]["result"] == {
        "ok": True,
        "instanceId": "instance-hello-1",
        "generation": 1,
    }
    assert invoked[0]["result"] == {
        "message": "Hello, CandleScope!",
        "contributionId": "hello",
    }
    assert deferred == ()
    assert health_pending[0]["result"] == {"status": "ready", "pending": 1}
    assert [item["id"] for item in cancelled] == ["invoke-2", "cancel-1"]
    assert cancelled[0]["error"]["data"]["code"] == "REQUEST_CANCELLED"
    assert cancelled[1]["result"]["cancelled"] is True
    assert health_clear[0]["result"] == {"status": "ready", "pending": 0}
    assert deactivated[0]["result"] == {"ok": True}
    assert shutdown[0]["result"] == {"ok": True}
    assert server.dispatcher.shutdown_requested is True


def test_runtime_fails_closed_for_unknown_fields_methods_and_stale_generations() -> None:
    duplicate = PlatformJsonLineServer(HelloCommandPlugin()).handle_line(
        '{"jsonrpc":"2.0","id":"a","id":"b","method":"handshake","params":{},"generation":0}'
    )
    unknown_envelope = PlatformJsonLineServer(HelloCommandPlugin()).handle_message(
        {**_handshake(), "extra": True}
    )
    server = PlatformJsonLineServer(HelloCommandPlugin())
    server.handle_message(_handshake())
    server.handle_message(_activate())
    stale = server.handle_message(_request("health-stale", "healthCheck", generation=2))
    unknown_method = server.handle_message(_request("unknown-1", "private.escape", generation=1))
    unknown_input = server.handle_message(
        _invoke("invoke-bad", {"private": True}, trace_id="trace-bad")
    )

    assert duplicate[0]["error"]["data"]["code"] == "PARSE_ERROR"
    assert unknown_envelope[0]["error"]["data"]["code"] == "INVALID_CONTRACT"
    assert stale[0]["error"]["data"]["code"] == "GENERATION_MISMATCH"
    assert unknown_method[0]["error"]["data"]["code"] == "METHOD_NOT_FOUND"
    assert unknown_input[0]["error"]["code"] == -32602
    assert unknown_input[0]["error"]["data"]["path"] == "invoke.input"


def test_runtime_enforces_bounded_in_flight_and_monotonic_reactivation() -> None:
    server = PlatformJsonLineServer(HelloCommandPlugin(), max_in_flight=1)
    server.handle_message(_handshake())
    server.handle_message(_activate())
    first = server.handle_message(
        _invoke("deferred-first", {"defer": True}, trace_id="trace-first")
    )
    over_limit = server.handle_message(
        _invoke("deferred-second", {"defer": True}, trace_id="trace-second")
    )
    server.handle_message(
        _request(
            "cancel-first",
            "cancel",
            generation=1,
            params={"requestId": "deferred-first"},
        )
    )
    server.handle_message(
        _request(
            "deactivate-first",
            "deactivate",
            generation=1,
            params={"reason": "reactivation test"},
        )
    )
    stale_reactivation = server.handle_message(_activate())

    assert first == ()
    assert over_limit[0]["error"]["data"]["code"] == "IN_FLIGHT_LIMIT"
    assert stale_reactivation[0]["error"]["data"]["code"] == "STALE_GENERATION"


def test_unexpected_plugin_exception_is_private_and_becomes_stable_error(capsys) -> None:
    class ExplodingPlugin(HelloCommandPlugin):
        def invoke(self, request: InvokeRequest):
            raise RuntimeError("private plugin implementation detail")

    server = PlatformJsonLineServer(ExplodingPlugin())
    server.handle_message(_handshake())
    server.handle_message(_activate())
    response = server.handle_message(_invoke("invoke-explodes", {}, trace_id="trace-explodes"))

    captured = capsys.readouterr()
    assert response[0]["error"]["data"]["code"] == "INTERNAL_ERROR"
    assert "private plugin implementation detail" not in json.dumps(response)
    assert "private plugin implementation detail" in captured.err


class _HostCallingPlugin(BasePlatformPlugin):
    def __init__(self) -> None:
        base = hello_manifest()
        self._manifest = replace(
            base,
            permissions=PermissionSet(
                optional=(PermissionRequest("notifications.show"),),
            ),
        )

    def manifest(self) -> PluginManifest:
        return self._manifest

    def describe(self) -> RuntimeDescriptor:
        return descriptor_from_manifest(self._manifest, entrypoint_id="main")

    def invoke(self, request: InvokeRequest) -> HostCallInvocation:
        return HostCallInvocation(
            token="notify-1",
            call=HostCallRequest(
                capability_handle="cap-notify-1",
                method="notifications.show",
                params={"message": "Hello from plugin"},
                request_context=request.request_context,
            ),
        )

    def complete_host_call(
        self,
        token: str,
        response: RpcSuccess | RpcFailure,
    ) -> dict[str, object]:
        assert token == "notify-1"
        if isinstance(response, RpcFailure):
            return {"notified": False, "error": response.error.code}
        return {"notified": True, "receipt": response.result}


def test_bidirectional_host_call_correlates_and_resumes_original_invocation() -> None:
    server = PlatformJsonLineServer(_HostCallingPlugin())
    handshake = server.handle_message(_handshake(HOST_API_V1))
    server.handle_message(
        _activate(
            CapabilityGrant(
                handle="cap-notify-1",
                permission_id="notifications.show",
            )
        )
    )

    outgoing = server.handle_message(_invoke("invoke-host-1", {}, trace_id="trace-host-1"))
    host_call = outgoing[0]
    resumed = server.handle_message(
        {
            "jsonrpc": "2.0",
            "id": host_call["id"],
            "result": {"shown": True, "notificationId": "n-1"},
            "generation": 1,
        }
    )

    assert handshake[0]["result"]["negotiatedHostApis"] == [HOST_API_V1]
    assert host_call["method"] == "host.call"
    assert host_call["params"]["capabilityHandle"] == "cap-notify-1"
    assert host_call["params"]["requestContext"]["traceId"] == "trace-host-1"
    assert resumed == (
        {
            "jsonrpc": "2.0",
            "id": "invoke-host-1",
            "result": {
                "notified": True,
                "receipt": {"shown": True, "notificationId": "n-1"},
            },
            "generation": 1,
        },
    )


def test_host_call_completion_can_chain_another_bounded_host_call() -> None:
    class ChainedPlugin(_HostCallingPlugin):
        def complete_host_call(
            self,
            token: str,
            response: RpcSuccess | RpcFailure,
        ):
            if token == "notify-1":
                assert isinstance(response, RpcSuccess)
                return HostCallInvocation(
                    token="notify-2",
                    call=HostCallRequest(
                        capability_handle="cap-notify-1",
                        method="notifications.show",
                        params={"message": "second"},
                        request_context=HostCallRequest.from_wire(
                            {
                                "capabilityHandle": "cap-notify-1",
                                "method": "notifications.show",
                                "params": {},
                                "requestContext": {
                                    "contributionId": "hello",
                                    "userAction": True,
                                    "generation": 1,
                                    "traceId": "trace-chain",
                                },
                            }
                        ).request_context,
                    ),
                )
            assert token == "notify-2"
            assert isinstance(response, RpcSuccess)
            return {"completed": True, "second": response.result}

    server = PlatformJsonLineServer(ChainedPlugin())
    server.handle_message(_handshake(HOST_API_V1))
    server.handle_message(_activate(CapabilityGrant("cap-notify-1", "notifications.show")))
    first = server.handle_message(_invoke("invoke-chain", {}, trace_id="trace-chain"))[0]
    second = server.handle_message(
        {
            "jsonrpc": "2.0",
            "id": first["id"],
            "result": {"shown": 1},
            "generation": 1,
        }
    )[0]
    completed = server.handle_message(
        {
            "jsonrpc": "2.0",
            "id": second["id"],
            "result": {"shown": 2},
            "generation": 1,
        }
    )

    assert second["method"] == "host.call"
    assert second["id"] != first["id"]
    assert completed[0]["id"] == "invoke-chain"
    assert completed[0]["result"] == {
        "completed": True,
        "second": {"shown": 2},
    }


def test_chained_host_call_rejects_an_unknown_capability_handle() -> None:
    class InvalidChainPlugin(_HostCallingPlugin):
        def complete_host_call(
            self,
            token: str,
            response: RpcSuccess | RpcFailure,
        ):
            return HostCallInvocation(
                token="invalid-chain",
                call=HostCallRequest(
                    capability_handle="cap-not-granted",
                    method="notifications.show",
                    params={},
                    request_context=HostCallRequest.from_wire(
                        {
                            "capabilityHandle": "cap-not-granted",
                            "method": "notifications.show",
                            "params": {},
                            "requestContext": {
                                "contributionId": "hello",
                                "userAction": True,
                                "generation": 1,
                                "traceId": "trace-invalid-chain",
                            },
                        }
                    ).request_context,
                ),
            )

    server = PlatformJsonLineServer(InvalidChainPlugin())
    server.handle_message(_handshake(HOST_API_V1))
    server.handle_message(_activate(CapabilityGrant("cap-notify-1", "notifications.show")))
    first = server.handle_message(
        _invoke("invoke-invalid-chain", {}, trace_id="trace-invalid-chain")
    )[0]
    failed = server.handle_message(
        {
            "jsonrpc": "2.0",
            "id": first["id"],
            "result": {"shown": True},
            "generation": 1,
        }
    )

    assert failed[0]["id"] == "invoke-invalid-chain"
    assert failed[0]["error"]["data"]["code"] == "CAPABILITY_HANDLE_INVALID"


def test_host_call_requires_a_granted_handle_and_late_response_fails_closed() -> None:
    server = PlatformJsonLineServer(_HostCallingPlugin())
    server.handle_message(_handshake(HOST_API_V1))
    server.handle_message(_activate())
    missing_grant = server.handle_message(
        _invoke("invoke-host-missing", {}, trace_id="trace-host-missing")
    )

    assert missing_grant[0]["error"]["data"]["code"] == "CAPABILITY_HANDLE_INVALID"

    server = PlatformJsonLineServer(_HostCallingPlugin())
    server.handle_message(_handshake(HOST_API_V1))
    server.handle_message(
        _activate(
            CapabilityGrant(
                handle="cap-notify-1",
                permission_id="notifications.show",
            )
        )
    )
    host_call = server.handle_message(
        _invoke("invoke-host-cancel", {}, trace_id="trace-host-cancel")
    )[0]
    server.handle_message(
        _request(
            "cancel-host",
            "cancel",
            generation=1,
            params={"requestId": "invoke-host-cancel"},
        )
    )
    late = server.handle_message(
        {
            "jsonrpc": "2.0",
            "id": host_call["id"],
            "result": {"shown": True},
            "generation": 1,
        }
    )

    assert late[0]["error"]["data"]["code"] == "HOST_CALL_NOT_PENDING"


def test_stale_host_call_response_does_not_consume_the_pending_invocation() -> None:
    server = PlatformJsonLineServer(_HostCallingPlugin())
    server.handle_message(_handshake(HOST_API_V1))
    server.handle_message(
        _activate(
            CapabilityGrant(
                handle="cap-notify-1",
                permission_id="notifications.show",
            )
        )
    )
    host_call = server.handle_message(
        _invoke("invoke-host-stale", {}, trace_id="trace-host-stale")
    )[0]

    stale = server.handle_message(
        {
            "jsonrpc": "2.0",
            "id": host_call["id"],
            "result": {"shown": "stale"},
            "generation": 2,
        }
    )
    resumed = server.handle_message(
        {
            "jsonrpc": "2.0",
            "id": host_call["id"],
            "result": {"shown": True},
            "generation": 1,
        }
    )

    assert stale[0]["error"]["data"]["code"] == "STALE_HOST_CALL_RESPONSE"
    assert resumed[0]["id"] == "invoke-host-stale"
    assert resumed[0]["result"] == {
        "notified": True,
        "receipt": {"shown": True},
    }


def test_invalid_host_call_completion_fails_the_original_invocation() -> None:
    class InvalidCompletionPlugin(_HostCallingPlugin):
        def complete_host_call(
            self,
            token: str,
            response: RpcSuccess | RpcFailure,
        ):
            return ["not", "an", "object"]

    server = PlatformJsonLineServer(InvalidCompletionPlugin())
    server.handle_message(_handshake(HOST_API_V1))
    server.handle_message(
        _activate(
            CapabilityGrant(
                handle="cap-notify-1",
                permission_id="notifications.show",
            )
        )
    )
    host_call = server.handle_message(
        _invoke("invoke-host-invalid", {}, trace_id="trace-host-invalid")
    )[0]

    failed = server.handle_message(
        {
            "jsonrpc": "2.0",
            "id": host_call["id"],
            "result": {"shown": True},
            "generation": 1,
        }
    )

    assert failed[0]["id"] == "invoke-host-invalid"
    assert failed[0]["error"]["code"] == -32107
    assert failed[0]["error"]["data"]["code"] == "INVALID_CONTRACT"
