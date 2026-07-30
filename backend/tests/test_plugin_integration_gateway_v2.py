from __future__ import annotations

import asyncio
import base64
import copy
import hashlib
import json
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any

import httpx
import pytest
from candlescope_plugin_sdk.platform_v2 import (
    HostCallRequest,
    PluginManifest,
    RequestContext,
)
from fastapi import FastAPI

from app.plugin_core_v2.api import create_core_plugin_router
from app.plugin_core_v2.contracts import CoreContribution, core_contributions
from app.plugin_core_v2.errors import CorePluginError
from app.plugin_core_v2.runtime import CorePluginPlatform
from app.plugin_gateway_v2.endpoints import PluginHttpEndpointGateway
from app.plugin_gateway_v2.files import UserSelectedFileBroker
from app.plugin_gateway_v2.network import (
    ConnectionControl,
    HostHttpGateway,
    PinnedHttpRequest,
    PinnedHttpResponse,
)
from app.plugin_installer_v2 import PlatformPluginInstaller
from app.plugin_security_v2.audit import AuditLog
from app.plugin_security_v2.capabilities import CapabilityLease
from app.plugin_security_v2.errors import PlatformSecurityError
from app.plugin_security_v2.grants import EffectiveGrant
from app.plugin_security_v2.management import LocalManagementGuard
from tests.plugin_platform_bundle_testkit import build_integration_gateway_bundle


PLUGIN_ID = "candlescope.integration-gateway"
PUBLIC_IP = "93.184.216.34"


def _lease(
    permission_id: str,
    scope: dict[str, Any],
    *,
    plugin_id: str = PLUGIN_ID,
    fingerprint: str | None = None,
) -> CapabilityLease:
    return CapabilityLease(
        fingerprint or f"lease-{permission_id}-{plugin_id}",
        plugin_id,
        "main",
        f"instance-{plugin_id}",
        1,
        permission_id,
        scope,
        (),
        1,
        "sha256:" + "1" * 64,
        "manifest:candlescope",
        1,
        1.0,
        10_000.0,
    )


def _call(
    method: str,
    params: dict[str, Any],
    *,
    contribution_id: str,
    trace_id: str,
) -> HostCallRequest:
    return HostCallRequest(
        "capability-handle",
        method,
        params,
        RequestContext(contribution_id, True, 1, trace_id),
    )


def _network_scope(**overrides: Any) -> dict[str, Any]:
    return {
        "schemes": ["https"],
        "domains": ["example.com"],
        "ports": [443],
        "methods": ["GET"],
        "maxRequestBytes": 0,
        "maxResponseBytes": 1024,
        "maxRedirects": 1,
        "maxConcurrent": 2,
        "ratePerMinute": 30,
        **overrides,
    }


def _network_call(
    url: str,
    *,
    headers: dict[str, str] | None = None,
    trace_id: str = "network-trace",
) -> HostCallRequest:
    return _call(
        "network.http.request",
        {
            "method": "GET",
            "url": url,
            "headers": headers or {"accept": "text/plain"},
            "bodyBase64": "",
        },
        contribution_id="fetch-public",
        trace_id=trace_id,
    )


class _RecordingTransport:
    def __init__(self, responses: list[PinnedHttpResponse]) -> None:
        self.responses = deque(responses)
        self.requests: list[tuple[PinnedHttpRequest, str]] = []

    def request(
        self,
        request: PinnedHttpRequest,
        *,
        resolved_ip: str,
        timeout_seconds: float,
        max_response_bytes: int,
        control: ConnectionControl,
    ) -> PinnedHttpResponse:
        del timeout_seconds, control
        self.requests.append((request, resolved_ip))
        response = self.responses.popleft()
        if len(response.body) > max_response_bytes:
            raise AssertionError("test transport response exceeds the Host limit")
        return response


def _audit_bytes(audit: AuditLog) -> bytes:
    return b"".join(path.read_bytes() for path in audit.directory.glob("*.json"))


def test_phase9_manifest_contracts_are_exact_and_permission_bounded(
    tmp_path: Path,
) -> None:
    fixture = build_integration_gateway_bundle(tmp_path / "bundle")
    manifest = PluginManifest.from_wire(fixture.manifest)
    contributions = core_contributions(manifest)
    assert {item.kind for item in contributions} == {"command/1", "http-endpoint/1"}

    mutations: list[tuple[str, Any]] = [
        (
            "exact DNS",
            lambda wire: next(
                item
                for item in wire["permissions"]["required"]
                if item["id"] == "network.connect"
            )["scope"].__setitem__("domains", ["127.0.0.1"]),
        ),
        (
            "file scope",
            lambda wire: next(
                item
                for item in wire["permissions"]["required"]
                if item["id"] == "filesystem.open-user-selected"
            )["scope"].__setitem__("maxBytes", 1024),
        ),
        (
            "endpoint scope",
            lambda wire: next(
                item
                for item in wire["permissions"]["required"]
                if item["id"] == "http.endpoint.serve"
            )["scope"].__setitem__("endpoints", ["other"]),
        ),
        (
            "invalid shape",
            lambda wire: next(
                item for item in wire["contributions"] if item["id"] == "echo"
            )["configuration"].__setitem__("listenAddress", "0.0.0.0"),
        ),
    ]
    for label, mutate in mutations:
        wire = copy.deepcopy(fixture.manifest)
        mutate(wire)
        with pytest.raises(CorePluginError, match="scope|shape|DNS") as captured:
            core_contributions(PluginManifest.from_wire(wire))
        assert captured.value.code == "PLUGIN_CORE_CONTRIBUTION_INVALID", label

    two_saves = copy.deepcopy(fixture.manifest)
    export_config = next(
        item for item in two_saves["contributions"] if item["id"] == "export-file"
    )["configuration"]
    export_config["inputSchema"]["properties"]["secondHandle"] = {
        "type": "string",
        "minLength": 1,
        "maxLength": 256,
    }
    export_config["inputSchema"]["required"].append("secondHandle")
    export_config["fileInputs"].append(
        {
            "field": "secondHandle",
            "mode": "save",
            "accept": ["application/json"],
            "maxBytes": 131_072,
            "suggestedName": "second-report.json",
        }
    )
    with pytest.raises(CorePluginError, match="at most one save") as captured:
        core_contributions(PluginManifest.from_wire(two_saves))
    assert captured.value.code == "PLUGIN_CORE_CONTRIBUTION_INVALID"


@pytest.mark.anyio
async def test_network_gateway_pins_public_dns_filters_output_and_redacts_audit(
    tmp_path: Path,
) -> None:
    secret_query = "do-not-log-query"
    secret_body = b"do-not-log-response"
    audit = AuditLog(tmp_path / "audit" / "events")
    transport = _RecordingTransport(
        [
            PinnedHttpResponse(
                200,
                (
                    ("content-type", "text/plain"),
                    ("set-cookie", "do-not-return-cookie"),
                ),
                secret_body,
            )
        ]
    )
    gateway = HostHttpGateway(
        audit,
        resolver=lambda host, port: (PUBLIC_IP,),
        transport=transport,
    )
    result = await gateway.request(
        _network_call(f"https://example.com/private?token={secret_query}"),
        _lease("network.connect", _network_scope()),
    )

    assert result == {
        "status": 200,
        "headers": {"content-type": "text/plain"},
        "bodyBase64": base64.b64encode(secret_body).decode("ascii"),
        "redirects": 0,
    }
    request, resolved_ip = transport.requests[0]
    assert resolved_ip == PUBLIC_IP
    assert request.host == "example.com"
    assert request.target.endswith(secret_query)
    audit_bytes = _audit_bytes(audit)
    assert secret_query.encode() not in audit_bytes
    assert secret_body not in audit_bytes
    assert b"set-cookie" not in audit_bytes
    event = audit.read_all()[-1]
    assert event.data == {
        "durationMicros": event.data["durationMicros"],
        "method": "GET",
        "origin": "https://example.com:443",
        "redirects": 0,
        "requestBytes": 0,
        "responseBytes": len(secret_body),
        "status": 200,
    }


@pytest.mark.anyio
async def test_network_gateway_denies_bare_private_mixed_and_redirected_targets(
    tmp_path: Path,
) -> None:
    audit = AuditLog(tmp_path / "audit" / "events")
    transport = _RecordingTransport([])
    lease = _lease("network.connect", _network_scope())

    gateway = HostHttpGateway(
        audit,
        resolver=lambda host, port: ("127.0.0.1",),
        transport=transport,
    )
    with pytest.raises(PlatformSecurityError) as private:
        await gateway.request(_network_call("https://example.com/private"), lease)
    assert private.value.code == "PLUGIN_NETWORK_PRIVATE_ADDRESS_DENIED"

    mixed = HostHttpGateway(
        audit,
        resolver=lambda host, port: (PUBLIC_IP, "169.254.169.254"),
        transport=transport,
    )
    with pytest.raises(PlatformSecurityError) as rebinding:
        await mixed.request(_network_call("https://example.com/rebinding"), lease)
    assert rebinding.value.code == "PLUGIN_NETWORK_PRIVATE_ADDRESS_DENIED"

    with pytest.raises(PlatformSecurityError) as bare:
        await gateway.request(_network_call("https://127.0.0.1/metadata"), lease)
    assert bare.value.code == "PLUGIN_NETWORK_BARE_IP_DENIED"

    redirect_transport = _RecordingTransport(
        [
            PinnedHttpResponse(
                302,
                (("location", "https://other.example/secret"),),
                b"",
            )
        ]
    )
    redirect = HostHttpGateway(
        audit,
        resolver=lambda host, port: (PUBLIC_IP,),
        transport=redirect_transport,
    )
    with pytest.raises(PlatformSecurityError) as escaped:
        await redirect.request(_network_call("https://example.com/start"), lease)
    assert escaped.value.code == "PLUGIN_NETWORK_SCOPE_DENIED"
    assert len(redirect_transport.requests) == 1


class _BlockingTransport:
    def __init__(self) -> None:
        self.started = threading.Event()

    def request(
        self,
        request: PinnedHttpRequest,
        *,
        resolved_ip: str,
        timeout_seconds: float,
        max_response_bytes: int,
        control: ConnectionControl,
    ) -> PinnedHttpResponse:
        del request, resolved_ip, timeout_seconds, max_response_bytes
        self.started.set()
        while not control.cancelled:
            time.sleep(0.005)
        raise OSError("cancelled by test revocation")


class _BlockingResolver:
    def __init__(self) -> None:
        self.started = threading.Event()
        self.release = threading.Event()

    def __call__(self, host: str, port: int) -> tuple[str, ...]:
        del host, port
        self.started.set()
        self.release.wait(2.0)
        return (PUBLIC_IP,)


@pytest.mark.anyio
async def test_network_revocation_closes_an_inflight_transport(tmp_path: Path) -> None:
    audit = AuditLog(tmp_path / "audit" / "events")
    transport = _BlockingTransport()
    gateway = HostHttpGateway(
        audit,
        resolver=lambda host, port: (PUBLIC_IP,),
        transport=transport,
    )
    lease = _lease("network.connect", _network_scope())
    task = asyncio.create_task(
        gateway.request(_network_call("https://example.com/slow"), lease)
    )
    assert await asyncio.to_thread(transport.started.wait, 2.0)
    gateway.revoke_leases((lease,), "permission-revoked")
    with pytest.raises(PlatformSecurityError) as revoked:
        await asyncio.wait_for(task, timeout=2.0)
    assert revoked.value.code == "PLUGIN_NETWORK_REVOKED"
    assert audit.read_all()[-1].outcome == "denied"

    resolver = _BlockingResolver()
    dns_gateway = HostHttpGateway(
        audit,
        resolver=resolver,
        transport=_RecordingTransport(
            [PinnedHttpResponse(200, (("content-type", "text/plain"),), b"late")]
        ),
    )
    dns_lease = _lease(
        "network.connect",
        _network_scope(),
        fingerprint="lease-network-blocked-dns",
    )
    dns_task = asyncio.create_task(
        dns_gateway.request(_network_call("https://example.com/dns"), dns_lease)
    )
    assert await asyncio.to_thread(resolver.started.wait, 2.0)
    dns_gateway.revoke_leases((dns_lease,), "permission-revoked")
    try:
        with pytest.raises(PlatformSecurityError) as dns_revoked:
            await asyncio.wait_for(dns_task, timeout=2.0)
        assert dns_revoked.value.code == "PLUGIN_NETWORK_REVOKED"
    finally:
        resolver.release.set()


def _file_scope(*media_types: str, ttl: int = 60) -> dict[str, Any]:
    return {
        "mediaTypes": list(media_types),
        "maxBytes": 1024,
        "ttlSeconds": ttl,
    }


def test_user_file_store_reclaims_crash_residue_and_rejects_unknown_entries(
    tmp_path: Path,
) -> None:
    root = tmp_path / "crash-residue"
    root.mkdir()
    orphan = root / ("open-" + "a" * 48 + ".bin")
    orphan.write_bytes(b"partial user bytes")
    broker = UserSelectedFileBroker(root, AuditLog(tmp_path / "audit" / "events"))
    assert not orphan.exists()
    broker.close()

    unsafe_root = tmp_path / "unsafe-store"
    unsafe_root.mkdir()
    (unsafe_root / "unexpected.txt").write_text("do not delete", encoding="utf-8")
    with pytest.raises(PlatformSecurityError) as unsafe:
        UserSelectedFileBroker(
            unsafe_root,
            AuditLog(tmp_path / "unsafe-audit" / "events"),
        )
    assert unsafe.value.code == "PLUGIN_FILE_STORE_UNSAFE"
    assert (unsafe_root / "unexpected.txt").read_text(
        encoding="utf-8"
    ) == "do not delete"


def test_user_file_resources_are_quota_bounded_and_reclaimed(tmp_path: Path) -> None:
    broker = UserSelectedFileBroker(
        tmp_path / "file-store",
        AuditLog(tmp_path / "audit" / "events"),
    )
    scope = _file_scope("application/json")
    for index in range(8):
        broker.prepare_save(
            plugin_id=PLUGIN_ID,
            contribution_id="export-file",
            field=f"fileHandle{index}",
            name=f"report-{index}.json",
            media_type="application/json",
            requested_max_bytes=1024,
            scope=scope,
            trace_id=f"select-save-{index}",
        )
    assert broker.snapshot() == {
        "openHandles": 8,
        "pendingDownloads": 0,
        "reservedBytes": 8 * 1024,
    }
    with pytest.raises(PlatformSecurityError) as exhausted:
        broker.prepare_save(
            plugin_id=PLUGIN_ID,
            contribution_id="export-file",
            field="overflowHandle",
            name="overflow.json",
            media_type="application/json",
            requested_max_bytes=1024,
            scope=scope,
            trace_id="select-save-overflow",
        )
    assert exhausted.value.code == "PLUGIN_FILE_QUOTA_EXCEEDED"
    broker.revoke_plugin(PLUGIN_ID)
    assert broker.snapshot() == {
        "openHandles": 0,
        "pendingDownloads": 0,
        "reservedBytes": 0,
    }


def test_user_file_handle_fails_closed_when_staged_file_is_replaced(
    tmp_path: Path,
) -> None:
    root = tmp_path / "file-store"
    broker = UserSelectedFileBroker(root, AuditLog(tmp_path / "audit" / "events"))
    scope = _file_scope("application/json")
    lease = _lease("filesystem.open-user-selected", scope)
    selection = broker.stage_open(
        plugin_id=PLUGIN_ID,
        contribution_id="import-file",
        field="fileHandle",
        name="selected.json",
        media_type="application/json",
        body=b"{}",
        requested_max_bytes=1024,
        scope=scope,
        trace_id="select-replaced",
    )
    staged_path = next(root.glob("open-*.bin"))
    staged_path.unlink()
    staged_path.mkdir()
    call = _call(
        "filesystem.user-selected.read",
        {"handle": selection.handle},
        contribution_id="import-file",
        trace_id="read-replaced",
    )

    with pytest.raises(PlatformSecurityError) as replaced:
        broker.read(call, lease)
    assert replaced.value.code == "PLUGIN_FILE_STORE_UNSAFE"
    with pytest.raises(PlatformSecurityError) as reused:
        broker.read(call, lease)
    assert reused.value.code == "PLUGIN_FILE_HANDLE_INVALID"
    broker.close()


def test_user_file_handles_are_direction_bound_one_shot_and_redacted(
    tmp_path: Path,
) -> None:
    now = [10.0]
    audit = AuditLog(tmp_path / "audit" / "events")
    broker = UserSelectedFileBroker(
        tmp_path / "file-store", audit, clock=lambda: now[0]
    )
    read_scope = _file_scope("application/json", "text/plain")
    read_lease = _lease("filesystem.open-user-selected", read_scope)
    secret_body = b'{"secret":"not-in-audit"}'
    selection = broker.stage_open(
        plugin_id=PLUGIN_ID,
        contribution_id="import-file",
        field="fileHandle",
        name="private-input.json",
        media_type="application/json",
        body=secret_body,
        requested_max_bytes=1024,
        scope=read_scope,
        trace_id="select-open",
    )
    call = _call(
        "filesystem.user-selected.read",
        {"handle": selection.handle},
        contribution_id="import-file",
        trace_id="read-open",
    )
    result = broker.read(call, read_lease)
    assert base64.b64decode(result["bodyBase64"]) == secret_body
    with pytest.raises(PlatformSecurityError) as reused:
        broker.read(call, read_lease)
    assert reused.value.code == "PLUGIN_FILE_HANDLE_INVALID"

    cross_selection = broker.stage_open(
        plugin_id=PLUGIN_ID,
        contribution_id="import-file",
        field="fileHandle",
        name="cross.json",
        media_type="application/json",
        body=b"{}",
        requested_max_bytes=1024,
        scope=read_scope,
        trace_id="select-cross",
    )
    cross_call = _call(
        "filesystem.user-selected.read",
        {"handle": cross_selection.handle},
        contribution_id="import-file",
        trace_id="read-cross",
    )
    with pytest.raises(PlatformSecurityError):
        broker.read(
            cross_call,
            _lease(
                "filesystem.open-user-selected",
                read_scope,
                plugin_id="candlescope.other-plugin",
            ),
        )
    assert broker.read(cross_call, read_lease)["size"] == 2

    expired = broker.stage_open(
        plugin_id=PLUGIN_ID,
        contribution_id="import-file",
        field="fileHandle",
        name="expired.txt",
        media_type="text/plain",
        body=b"expired",
        requested_max_bytes=1024,
        scope=read_scope,
        trace_id="select-expired",
    )
    now[0] += 61.0
    with pytest.raises(PlatformSecurityError):
        broker.read(
            _call(
                "filesystem.user-selected.read",
                {"handle": expired.handle},
                contribution_id="import-file",
                trace_id="read-expired",
            ),
            read_lease,
        )

    write_scope = _file_scope("application/json")
    write_lease = _lease("filesystem.save-user-selected", write_scope)
    destination = broker.prepare_save(
        plugin_id=PLUGIN_ID,
        contribution_id="export-file",
        field="fileHandle",
        name="private-report.json",
        media_type="application/json",
        requested_max_bytes=1024,
        scope=write_scope,
        trace_id="select-save",
    )
    output = b'{"safe":true}'
    write_call = _call(
        "filesystem.user-selected.write",
        {
            "handle": destination.handle,
            "bodyBase64": base64.b64encode(output).decode("ascii"),
        },
        contribution_id="export-file",
        trace_id="write-save",
    )
    receipt = broker.write(write_call, write_lease)
    with pytest.raises(PlatformSecurityError):
        broker.write(write_call, write_lease)
    with pytest.raises(PlatformSecurityError):
        broker.download(
            "candlescope.other-plugin",
            receipt["downloadId"],
            trace_id="wrong-plugin",
        )
    download = broker.download(
        PLUGIN_ID, receipt["downloadId"], trace_id="download-save"
    )
    assert download.body == output
    assert download.sha256 == "sha256:" + hashlib.sha256(output).hexdigest()
    with pytest.raises(PlatformSecurityError):
        broker.download(PLUGIN_ID, receipt["downloadId"], trace_id="download-reuse")

    revoked_destination = broker.prepare_save(
        plugin_id=PLUGIN_ID,
        contribution_id="export-file",
        field="fileHandle",
        name="revoked-report.json",
        media_type="application/json",
        requested_max_bytes=1024,
        scope=write_scope,
        trace_id="select-revoked-save",
    )
    revoked_receipt = broker.write(
        _call(
            "filesystem.user-selected.write",
            {
                "handle": revoked_destination.handle,
                "bodyBase64": base64.b64encode(b"revoked").decode("ascii"),
            },
            contribution_id="export-file",
            trace_id="write-revoked-save",
        ),
        write_lease,
    )
    broker.revoke_leases((write_lease,), "permission-revoked")
    with pytest.raises(PlatformSecurityError):
        broker.download(
            PLUGIN_ID,
            revoked_receipt["downloadId"],
            trace_id="download-revoked-save",
        )

    audit_bytes = _audit_bytes(audit)
    for forbidden in (
        b"private-input.json",
        b"private-report.json",
        secret_body,
        output,
        str(tmp_path).encode(),
    ):
        assert forbidden not in audit_bytes


def _endpoint_contribution(*, response_mode: str = "server-events") -> CoreContribution:
    return CoreContribution(
        PLUGIN_ID,
        "events",
        f"{PLUGIN_ID}.events",
        "http-endpoint/1",
        "Events",
        "main",
        {
            "methods": ["POST"],
            "responseMode": response_mode,
            "maxRequestBytes": 1024,
            "maxResponseBytes": 1024,
            "maxConcurrent": 2,
            "ratePerMinute": 30,
        },
    )


def _endpoint_grant() -> EffectiveGrant:
    return EffectiveGrant(
        PLUGIN_ID,
        "http.endpoint.serve",
        "required",
        {
            "endpoints": ["events"],
            "methods": ["POST"],
            "maxRequestBytes": 1024,
            "maxResponseBytes": 1024,
            "maxConcurrent": 2,
            "ratePerMinute": 30,
        },
        1,
        "sha256:" + "2" * 64,
        "manifest:candlescope",
        1,
    )


@pytest.mark.anyio
async def test_endpoint_gateway_is_loopback_namespaced_stream_bounded_and_redacted(
    tmp_path: Path,
) -> None:
    seen: list[dict[str, Any]] = []

    async def invoke(
        contribution: CoreContribution,
        payload: dict[str, Any],
        user_action: bool,
        trace_id: str,
    ) -> dict[str, Any]:
        del contribution, user_action, trace_id
        seen.append(payload)
        return {
            "schemaVersion": "candlescope.http-endpoint-response/1",
            "mode": "server-events",
            "status": 200,
            "headers": {},
            "events": [{"event": "ready", "id": "1", "data": "line-one\nline-two"}],
        }

    audit = AuditLog(tmp_path / "audit" / "events")
    gateway = PluginHttpEndpointGateway(audit, invoke)
    gateway.register(_endpoint_contribution(), _endpoint_grant())
    secret_body = b"endpoint-body-secret"
    response = await gateway.handle(
        plugin_id=PLUGIN_ID,
        endpoint_id="events",
        remote_host="127.0.0.1",
        method="POST",
        headers={
            "content-type": "application/json",
            "x-candlescope-event-id": "header-secret",
        },
        query=(("token", "query-secret"),),
        body=secret_body,
        trace_id="endpoint-stream",
    )
    assert response.status == 200
    assert response.headers == {"content-type": "text/event-stream; charset=utf-8"}
    assert b"".join(response.event_chunks) == (
        b"event: ready\nid: 1\ndata: line-one\ndata: line-two\n\n"
    )
    assert base64.b64decode(seen[0]["bodyBase64"]) == secret_body
    assert seen[0]["query"] == {"token": ["query-secret"]}

    with pytest.raises(PlatformSecurityError) as remote:
        await gateway.handle(
            plugin_id=PLUGIN_ID,
            endpoint_id="events",
            remote_host="198.51.100.10",
            method="POST",
            headers={},
            query=(),
            body=b"",
            trace_id="endpoint-remote",
        )
    assert remote.value.code == "PLUGIN_ENDPOINT_NOT_FOUND"
    with pytest.raises(PlatformSecurityError) as namespace:
        await gateway.handle(
            plugin_id="candlescope.other-plugin",
            endpoint_id="events",
            remote_host="127.0.0.1",
            method="POST",
            headers={},
            query=(),
            body=b"",
            trace_id="endpoint-namespace",
        )
    assert namespace.value.code == "PLUGIN_ENDPOINT_NOT_FOUND"
    with pytest.raises(PlatformSecurityError) as oversized_query:
        await gateway.handle(
            plugin_id=PLUGIN_ID,
            endpoint_id="events",
            remote_host="127.0.0.1",
            method="POST",
            headers={},
            query=tuple((f"key-{index}", "value") for index in range(33)),
            body=b"",
            trace_id="endpoint-query-limit",
        )
    assert oversized_query.value.code == "PLUGIN_ENDPOINT_QUERY_INVALID"

    audit_bytes = _audit_bytes(audit)
    for forbidden in (
        secret_body,
        b"header-secret",
        b"query-secret",
        b"content-type",
    ):
        assert forbidden not in audit_bytes


@pytest.mark.anyio
async def test_endpoint_gateway_rejects_executable_buffered_content(
    tmp_path: Path,
) -> None:
    async def invoke(
        contribution: CoreContribution,
        payload: dict[str, Any],
        user_action: bool,
        trace_id: str,
    ) -> dict[str, Any]:
        del contribution, payload, user_action, trace_id
        return {
            "schemaVersion": "candlescope.http-endpoint-response/1",
            "mode": "buffered",
            "status": 200,
            "headers": {"content-type": "text/html"},
            "bodyBase64": base64.b64encode(b"<script>alert(1)</script>").decode(
                "ascii"
            ),
        }

    gateway = PluginHttpEndpointGateway(AuditLog(tmp_path / "audit" / "events"), invoke)
    gateway.register(
        _endpoint_contribution(response_mode="buffered"), _endpoint_grant()
    )
    with pytest.raises(PlatformSecurityError) as denied:
        await gateway.handle(
            plugin_id=PLUGIN_ID,
            endpoint_id="events",
            remote_host="127.0.0.1",
            method="POST",
            headers={},
            query=(),
            body=b"",
            trace_id="endpoint-html",
        )
    assert denied.value.code == "PLUGIN_ENDPOINT_CONTENT_TYPE_DENIED"


@pytest.mark.anyio
async def test_endpoint_disable_cancels_inflight_work(tmp_path: Path) -> None:
    started = asyncio.Event()

    async def invoke(
        contribution: CoreContribution,
        payload: dict[str, Any],
        user_action: bool,
        trace_id: str,
    ) -> dict[str, Any]:
        del contribution, payload, user_action, trace_id
        started.set()
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    gateway = PluginHttpEndpointGateway(AuditLog(tmp_path / "audit" / "events"), invoke)
    gateway.register(_endpoint_contribution(), _endpoint_grant())
    task = asyncio.create_task(
        gateway.handle(
            plugin_id=PLUGIN_ID,
            endpoint_id="events",
            remote_host="::1",
            method="POST",
            headers={},
            query=(),
            body=b"",
            trace_id="endpoint-cancel",
        )
    )
    await asyncio.wait_for(started.wait(), timeout=2.0)
    await gateway.clear_plugin(PLUGIN_ID)
    with pytest.raises(PlatformSecurityError) as revoked:
        await task
    assert revoked.value.code == "PLUGIN_ENDPOINT_REVOKED"


@pytest.mark.anyio
async def test_reference_bundle_uses_host_gateways_end_to_end(tmp_path: Path) -> None:
    fixture = build_integration_gateway_bundle(tmp_path / "bundle")
    root = tmp_path / "managed"
    installer = PlatformPluginInstaller(root=root, host_version="0.4.0")
    installed = installer.install(
        fixture.bundle.path,
        expected_sha256=fixture.bundle.sha256,
        enabled=True,
    )
    assert installed.state == "staged"
    for permission in fixture.manifest["permissions"]["required"]:
        installer.grant_permission(installed.plugin_id, permission["id"])
    assert installer.enable(installed.plugin_id).state == "active"

    network_body = b"host-mediated-network"
    transport = _RecordingTransport(
        [PinnedHttpResponse(200, (("content-type", "text/plain"),), network_body)]
    )
    platform = CorePluginPlatform(
        root=root,
        host_name="CandleScope",
        host_version="0.4.0",
        network_resolver=lambda host, port: (PUBLIC_IP,),
        network_transport=transport,
    )
    await platform.start()
    guard = LocalManagementGuard(
        ("http://127.0.0.1:5173",),
        session_token="phase9-session-token-0123456789abcdef",
        csrf_token="phase9-csrf-token-0123456789abcdefghi",
    )
    app = FastAPI()
    app.state.plugin_platform_v2 = platform
    app.state.plugin_platform_v2_management_guard = guard
    app.include_router(create_core_plugin_router())
    local_transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 43209))
    remote_transport = httpx.ASGITransport(app=app, client=("198.51.100.10", 43210))
    try:
        async with httpx.AsyncClient(
            transport=local_transport, base_url="http://127.0.0.1"
        ) as client:
            endpoint = await client.post(
                f"/api/v2/plugins/endpoints/{PLUGIN_ID}/echo?probe=one",
                headers={
                    "Content-Type": "text/plain",
                    "Authorization": "Bearer must-not-reach-plugin",
                    "Cookie": "session=must-not-reach-plugin",
                },
                content=b"echo-body",
            )
            assert endpoint.status_code == 200
            assert endpoint.headers["cache-control"] == "no-store"
            assert endpoint.headers["content-security-policy"] == (
                "default-src 'none'; sandbox"
            )
            assert endpoint.headers["cross-origin-resource-policy"] == "same-origin"
            assert endpoint.headers["x-frame-options"] == "DENY"
            endpoint_payload = endpoint.json()
            assert endpoint_payload == {
                "bodyBytes": 9,
                "bodySha256": "sha256:" + hashlib.sha256(b"echo-body").hexdigest(),
                "headerKeys": ["accept", "content-type"],
                "method": "POST",
                "queryKeys": ["probe"],
            }
            assert (
                await client.post("/api/v2/plugins/endpoints/candlescope.other/echo")
            ).status_code == 404
            assert (
                await client.post(
                    f"/api/v2/plugins/endpoints/{PLUGIN_ID}/echo",
                    content=b"x" * (128 * 1024 + 1),
                )
            ).status_code == 413
            assert (
                await client.post(
                    f"/api/v2/plugins/endpoints/{PLUGIN_ID}/echo",
                    headers={"Origin": "https://evil.example"},
                )
            ).status_code == 404

            headers = guard.trusted_headers(user_action="select-file")
            headers.update(
                {
                    "Content-Type": "application/json",
                    "X-CandleScope-File-Name": "selected-input.json",
                }
            )
            opened = await client.post(
                "/api/v2/plugins/manage/files/open",
                params={
                    "contributionId": f"{PLUGIN_ID}.import-file",
                    "field": "fileHandle",
                },
                headers=headers,
                content=b'{"selected":true}',
            )
            assert opened.status_code == 200
            file_handle = opened.json()["fileSelection"]["handle"]
            imported = await client.post(
                f"/api/v2/plugins/manage/commands/{PLUGIN_ID}.import-file/invoke",
                headers=guard.trusted_headers(user_action="invoke-import"),
                json={"input": {"fileHandle": file_handle}},
            )
            assert imported.status_code == 200
            assert imported.json()["result"]["size"] == 17

            fetched = await client.post(
                f"/api/v2/plugins/manage/commands/{PLUGIN_ID}.fetch-public/invoke",
                headers=guard.trusted_headers(user_action="invoke-network"),
                json={"input": {"url": "https://example.com/phase9"}},
            )
            assert fetched.status_code == 200
            assert fetched.json()["result"]["bodySha256"] == (
                "sha256:" + hashlib.sha256(network_body).hexdigest()
            )
            assert transport.requests[0][1] == PUBLIC_IP

            async def export(message: str) -> dict[str, Any]:
                selected = await client.post(
                    "/api/v2/plugins/manage/files/save",
                    headers=guard.trusted_headers(user_action="select-save"),
                    json={
                        "contributionId": f"{PLUGIN_ID}.export-file",
                        "field": "fileHandle",
                    },
                )
                assert selected.status_code == 200
                handle = selected.json()["fileSelection"]["handle"]
                invoked = await client.post(
                    f"/api/v2/plugins/manage/commands/{PLUGIN_ID}.export-file/invoke",
                    headers=guard.trusted_headers(user_action="invoke-export"),
                    json={"input": {"fileHandle": handle, "message": message}},
                )
                assert invoked.status_code == 200
                return invoked.json()["result"]["fileDownload"]

            receipt = await export("download once")
            downloaded = await client.post(
                "/api/v2/plugins/manage/files/download",
                headers=guard.trusted_headers(user_action="download-export"),
                json={"pluginId": PLUGIN_ID, "downloadId": receipt["downloadId"]},
            )
            assert downloaded.status_code == 200
            assert (
                downloaded.headers["x-candlescope-content-sha256"] == receipt["sha256"]
            )
            assert downloaded.headers["content-disposition"] == (
                'attachment; filename="candlescope-integration-report.json"'
            )
            assert json.loads(downloaded.content)["message"] == "download once"
            assert (
                await client.post(
                    "/api/v2/plugins/manage/files/download",
                    headers=guard.trusted_headers(user_action="download-reuse"),
                    json={
                        "pluginId": PLUGIN_ID,
                        "downloadId": receipt["downloadId"],
                    },
                )
            ).status_code == 409

            revoked_receipt = await export("revoked before download")
            disabled = await client.post(
                f"/api/v2/plugins/manage/{PLUGIN_ID}/disable",
                headers=guard.trusted_headers(user_action="disable-integration"),
            )
            assert disabled.status_code == 200
            assert (
                await client.get(f"/api/v2/plugins/endpoints/{PLUGIN_ID}/echo")
            ).status_code == 404
            assert platform.diagnostics()["integration"] == {
                "network": {
                    "activeConnections": 0,
                    "activeLeases": 0,
                    "rateBuckets": 0,
                },
                "files": {
                    "openHandles": 0,
                    "pendingDownloads": 0,
                    "reservedBytes": 0,
                },
                "endpoints": {
                    "registrations": 0,
                    "activeRequests": 0,
                    "rateBuckets": 0,
                },
            }
            assert (
                await client.post(
                    "/api/v2/plugins/manage/files/download",
                    headers=guard.trusted_headers(user_action="download-revoked"),
                    json={
                        "pluginId": PLUGIN_ID,
                        "downloadId": revoked_receipt["downloadId"],
                    },
                )
            ).status_code == 409

        rebound_transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 43211))
        async with httpx.AsyncClient(
            transport=rebound_transport, base_url="http://rebind.example"
        ) as rebound:
            assert (
                await rebound.post(f"/api/v2/plugins/endpoints/{PLUGIN_ID}/echo")
            ).status_code == 404

        async with httpx.AsyncClient(
            transport=remote_transport, base_url="http://127.0.0.1"
        ) as remote:
            assert (
                await remote.post(f"/api/v2/plugins/endpoints/{PLUGIN_ID}/echo")
            ).status_code == 404
    finally:
        await platform.stop()
