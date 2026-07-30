from __future__ import annotations

import base64
import hashlib
import json

import pytest
from candlescope_plugin_sdk.platform_v2 import (
    HOST_API_V1,
    HostHttpRequest,
    HttpEndpointRequest,
    PlatformContractError,
    PlatformJsonLineServer,
    UserFileReadResponse,
    UserFileWriteReceipt,
)
from candlescope_plugin_sdk.platform_v2.examples.integration_gateway import (
    IntegrationGatewayPlugin,
    integration_gateway_manifest,
)


def _request(request_id, method, *, generation, params):
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "method": method,
        "params": params,
        "generation": generation,
    }


def _server() -> PlatformJsonLineServer:
    manifest = integration_gateway_manifest()
    server = PlatformJsonLineServer(IntegrationGatewayPlugin())
    server.handle_message(
        _request(
            "handshake",
            "handshake",
            generation=0,
            params={
                "protocols": ["candlescope.plugin/2"],
                "host": {"name": "CandleScope", "version": "0.4.0"},
                "entrypointId": "main",
                "hostApis": [HOST_API_V1],
                "transports": ["jsonl/1"],
            },
        )
    )
    server.handle_message(
        _request(
            "activate",
            "activate",
            generation=1,
            params={
                "instanceId": "integration-instance",
                "generation": 1,
                "capabilities": [
                    {
                        "handle": f"cap-{item.id}",
                        "permissionId": item.id,
                        "scope": item.scope,
                    }
                    for item in manifest.permissions.required
                ],
            },
        )
    )
    return server


def _invoke(server: PlatformJsonLineServer, contribution_id: str, input_value: dict):
    return server.handle_message(
        _request(
            f"invoke-{contribution_id}",
            "invoke",
            generation=1,
            params={
                "contributionId": contribution_id,
                "input": input_value,
                "requestContext": {
                    "contributionId": contribution_id,
                    "userAction": True,
                    "generation": 1,
                    "traceId": f"integration-{contribution_id}",
                },
            },
        )
    )


def test_integration_manifest_is_credential_free_and_declares_bounded_l3_scopes() -> None:
    manifest = integration_gateway_manifest()
    wire = manifest.to_wire()
    encoded = json.dumps(wire, sort_keys=True).lower()
    assert "apikey" not in encoded
    assert "authorization" not in encoded
    assert {item.id for item in manifest.permissions.required} == {
        "network.connect",
        "filesystem.open-user-selected",
        "filesystem.save-user-selected",
        "http.endpoint.serve",
    }
    network = next(item for item in manifest.permissions.required if item.id == "network.connect")
    assert network.scope["schemes"] == ["https"]
    assert network.scope["domains"] == ["example.com"]


def test_reference_network_and_file_commands_use_only_typed_host_calls() -> None:
    server = _server()
    network = _invoke(server, "fetch-public", {"url": "https://example.com/candlescope-phase9"})[0]
    assert network["method"] == "host.call"
    assert network["params"]["method"] == "network.http.request"
    assert network["params"]["params"]["bodyBase64"] == ""
    network_result = server.handle_message(
        {
            "jsonrpc": "2.0",
            "id": network["id"],
            "result": {
                "status": 200,
                "headers": {"content-type": "text/plain"},
                "bodyBase64": base64.b64encode(b"phase9").decode("ascii"),
                "redirects": 0,
            },
            "generation": 1,
        }
    )[0]["result"]
    assert network_result["bodySha256"] == "sha256:" + hashlib.sha256(b"phase9").hexdigest()

    read = _invoke(server, "import-file", {"fileHandle": "ufh_" + "a" * 43})[0]
    assert read["params"]["method"] == "filesystem.user-selected.read"
    read_result = server.handle_message(
        {
            "jsonrpc": "2.0",
            "id": read["id"],
            "result": {
                "name": "input.json",
                "mediaType": "application/json",
                "size": 2,
                "sha256": "sha256:" + hashlib.sha256(b"{}").hexdigest(),
                "bodyBase64": base64.b64encode(b"{}").decode("ascii"),
            },
            "generation": 1,
        }
    )[0]["result"]
    assert read_result["size"] == 2

    write = _invoke(
        server,
        "export-file",
        {"fileHandle": "ufh_" + "b" * 43, "message": "bounded"},
    )[0]
    assert write["params"]["method"] == "filesystem.user-selected.write"
    write_result = server.handle_message(
        {
            "jsonrpc": "2.0",
            "id": write["id"],
            "result": {
                "downloadId": "ufd_" + "c" * 43,
                "name": "candlescope-integration-report.json",
                "mediaType": "application/json",
                "size": 7,
                "sha256": "sha256:" + "0" * 64,
            },
            "generation": 1,
        }
    )[0]["result"]
    assert write_result["fileDownload"]["downloadId"].startswith("ufd_")


def test_reference_endpoint_returns_a_bounded_host_response_envelope() -> None:
    server = _server()
    frames = _invoke(
        server,
        "echo",
        {
            "schemaVersion": "candlescope.http-endpoint-request/1",
            "method": "POST",
            "headers": {"content-type": "application/json"},
            "query": {"mode": ["probe"]},
            "bodyBase64": base64.b64encode(b'{"ok":true}').decode("ascii"),
        },
    )
    result = frames[0]["result"]
    assert result["schemaVersion"] == "candlescope.http-endpoint-response/1"
    assert result["mode"] == "buffered"
    payload = json.loads(base64.b64decode(result["bodyBase64"]))
    assert payload["method"] == "POST"
    assert payload["headerKeys"] == ["content-type"]
    assert payload["bodyBytes"] == 11
    assert payload["queryKeys"] == ["mode"]


def test_typed_integration_contracts_reject_authority_and_integrity_drift() -> None:
    with pytest.raises(PlatformContractError):
        HostHttpRequest(
            "GET",
            "https://example.com/",
            {"authorization": "Bearer must-not-cross-the-gateway"},
        )
    with pytest.raises(PlatformContractError):
        UserFileReadResponse.from_wire(
            {
                "name": "input.json",
                "mediaType": "application/json",
                "size": 2,
                "sha256": "sha256:" + "0" * 64,
                "bodyBase64": base64.b64encode(b"{}").decode("ascii"),
            }
        )
    with pytest.raises(PlatformContractError):
        UserFileWriteReceipt.from_wire(
            {
                "downloadId": "not-a-host-download-handle",
                "name": "report.json",
                "mediaType": "application/json",
                "size": 0,
                "sha256": "sha256:" + hashlib.sha256(b"").hexdigest(),
            }
        )
    with pytest.raises(PlatformContractError):
        HttpEndpointRequest.from_invoke(
            {
                "schemaVersion": "candlescope.http-endpoint-request/1",
                "method": "DELETE",
                "headers": {},
                "query": {},
                "bodyBase64": "",
            }
        )
