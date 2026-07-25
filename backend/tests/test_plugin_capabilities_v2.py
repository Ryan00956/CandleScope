from __future__ import annotations

import sys
from pathlib import Path

import pytest

from candlescope_plugin_sdk.platform_v2 import (
    HOST_API_V1,
    CapabilityGrant,
    HostCallRequest,
    PluginManifest,
    RequestContext,
    canonical_sha256,
    descriptor_from_manifest,
)

from app.plugin_host import EntrypointProcessSpec, EntrypointSupervisor
from app.plugin_platform import PluginManager
from app.plugin_security_v2 import (
    AuditLog,
    CapabilityBroker,
    CapabilityHandleAuthority,
    CapabilityMethodPolicy,
    EffectiveGrant,
    GrantStore,
    PlatformSecurityError,
)
from tests.plugin_platform_bundle_testkit import hello_platform_manifest


FIXTURE_DIRECTORY = Path(__file__).parent / "fixtures" / "plugin_platform_v2"
FAKE_PLATFORM = FIXTURE_DIRECTORY / "fake_platform_sidecar.py"


def _manifest(*, scope: dict[str, object] | None = None) -> PluginManifest:
    value = hello_platform_manifest()
    value["plugin"] = {
        **value["plugin"],
        "id": "candlescope.host-call",
        "name": "Host Call",
    }
    value["permissions"] = {
        "required": [],
        "optional": [{"id": "notifications.show", "scope": scope or {}}],
    }
    value["probes"] = []
    return PluginManifest.from_wire(value)


def _effective(
    manifest: PluginManifest,
    *,
    scope: dict[str, object] | None = None,
) -> EffectiveGrant:
    return EffectiveGrant(
        manifest.plugin.id,
        "notifications.show",
        "optional",
        scope or {},
        4,
        "sha256:" + "1" * 64,
        f"manifest:{manifest.plugin.publisher}",
        1,
    )


def _call(
    handle: str, *, generation: int = 1, channel: str = "toast"
) -> HostCallRequest:
    return HostCallRequest(
        handle,
        "notifications.show",
        {"channel": channel, "message": "hello"},
        RequestContext("hello", True, generation, f"trace-{generation}-{channel}"),
    )


@pytest.mark.anyio
async def test_capability_authority_rejects_forgery_stale_generation_and_revocation(
    tmp_path: Path,
) -> None:
    audit = AuditLog(tmp_path / "audit" / "events")
    authority = CapabilityHandleAuthority(audit)
    manifest = _manifest(scope={"channels": ["toast"]})
    descriptor = descriptor_from_manifest(manifest, entrypoint_id="main")
    capabilities = authority.mint_grants(
        manifest=manifest,
        descriptor=descriptor,
        entrypoint_id="main",
        instance_id="instance-one",
        generation=1,
        effective_grants=(_effective(manifest, scope={"channels": ["toast"]}),),
    )
    grant = capabilities[0]
    call = _call(grant.handle)

    lease = authority.validate(
        call,
        grant,
        plugin_id=manifest.plugin.id,
        entrypoint_id="main",
        instance_id="instance-one",
        generation=1,
    )
    assert lease.permission_id == "notifications.show"
    assert grant.handle.encode("utf-8") not in b"".join(
        path.read_bytes() for path in (tmp_path / "audit" / "events").glob("*.json")
    )

    forged = _call("caph_forged")
    with pytest.raises(PlatformSecurityError, match="unknown, expired, or revoked"):
        authority.validate(
            forged,
            CapabilityGrant(
                "caph_forged", "notifications.show", {"channels": ["toast"]}
            ),
            plugin_id=manifest.plugin.id,
            entrypoint_id="main",
            instance_id="instance-one",
            generation=1,
        )
    with pytest.raises(PlatformSecurityError, match="binding"):
        authority.validate(
            call,
            grant,
            plugin_id=manifest.plugin.id,
            entrypoint_id="main",
            instance_id="instance-one",
            generation=2,
        )

    assert authority.revoke_handle(grant.handle) is True
    with pytest.raises(PlatformSecurityError, match="unknown, expired, or revoked"):
        authority.validate(
            call,
            grant,
            plugin_id=manifest.plugin.id,
            entrypoint_id="main",
            instance_id="instance-one",
            generation=1,
        )


def test_grant_store_revocation_invalidates_an_existing_handle(
    tmp_path: Path,
) -> None:
    audit = AuditLog(tmp_path / "audit" / "events")
    store = GrantStore(
        tmp_path / "platform-grants-v2.json",
        audit_log=audit,
    )
    manifest = _manifest(scope={"channels": ["toast"]})
    bundle_sha256 = canonical_sha256({"bundle": "live-revocation"})
    manifest_sha256 = canonical_sha256({"manifest": "live-revocation"})
    store.reconcile(
        manifest,
        bundle_sha256=bundle_sha256,
        manifest_sha256=manifest_sha256,
    )
    store.grant(
        manifest,
        bundle_sha256=bundle_sha256,
        manifest_sha256=manifest_sha256,
        permission_id="notifications.show",
    )
    authority = CapabilityHandleAuthority(audit, grant_store=store)
    descriptor = descriptor_from_manifest(manifest, entrypoint_id="main")
    grant = authority.mint_grants(
        manifest=manifest,
        descriptor=descriptor,
        entrypoint_id="main",
        instance_id="instance-one",
        generation=1,
        effective_grants=store.effective_grants(
            manifest,
            bundle_sha256=bundle_sha256,
            manifest_sha256=manifest_sha256,
        ),
    )[0]
    call = _call(grant.handle)
    authority.validate(
        call,
        grant,
        plugin_id=manifest.plugin.id,
        entrypoint_id="main",
        instance_id="instance-one",
        generation=1,
    )

    store.revoke(
        manifest,
        bundle_sha256=bundle_sha256,
        manifest_sha256=manifest_sha256,
        permission_id="notifications.show",
    )
    with pytest.raises(PlatformSecurityError, match="no longer granted"):
        authority.validate(
            call,
            grant,
            plugin_id=manifest.plugin.id,
            entrypoint_id="main",
            instance_id="instance-one",
            generation=1,
        )


@pytest.mark.anyio
async def test_capability_broker_enforces_scope_user_action_rate_quota_and_trace(
    tmp_path: Path,
) -> None:
    audit = AuditLog(tmp_path / "audit" / "events")
    authority = CapabilityHandleAuthority(audit)
    broker = CapabilityBroker(authority, audit)
    manifest = _manifest(scope={"channels": ["toast"]})
    descriptor = descriptor_from_manifest(manifest, entrypoint_id="main")
    grant = authority.mint_grants(
        manifest=manifest,
        descriptor=descriptor,
        entrypoint_id="main",
        instance_id="instance-one",
        generation=1,
        effective_grants=(_effective(manifest, scope={"channels": ["toast"]}),),
    )[0]

    async def show(call: HostCallRequest) -> dict[str, object]:
        return {"shown": True, "traceId": call.request_context.trace_id}

    broker.register(
        CapabilityMethodPolicy(
            "notifications.show",
            "notifications.show",
            show,
            scope_extractor=lambda params: {"channels": [params["channel"]]},
            require_user_action=True,
            max_calls_per_minute=1,
            max_calls_per_activation=2,
        )
    )
    call = _call(grant.handle)
    lease = authority.validate(
        call,
        grant,
        plugin_id=manifest.plugin.id,
        entrypoint_id="main",
        instance_id="instance-one",
        generation=1,
    )
    with pytest.raises(
        PlatformSecurityError, match="unconsumed Host user-action credential"
    ):
        await broker.handle(call, grant, lease)
    assert await broker.handle(call, grant, lease, user_action_authorized=True) == {
        "shown": True,
        "traceId": "trace-1-toast",
    }

    denied_scope = _call(grant.handle, channel="desktop")
    with pytest.raises(PlatformSecurityError, match="exceeds the granted scope"):
        await broker.handle(denied_scope, grant, lease, user_action_authorized=True)
    with pytest.raises(PlatformSecurityError, match="rate limit"):
        await broker.handle(call, grant, lease, user_action_authorized=True)

    outcomes = [item.outcome for item in audit.read_all() if item.action == "host.call"]
    assert outcomes == ["denied", "allowed", "denied", "denied"]
    assert all(
        item.trace_id.startswith("trace-")
        for item in audit.read_all()
        if item.action == "host.call"
    )


@pytest.mark.anyio
async def test_capability_broker_rejects_request_and_response_byte_overflow(
    tmp_path: Path,
) -> None:
    audit = AuditLog(tmp_path / "audit" / "events")
    authority = CapabilityHandleAuthority(audit)
    manifest = _manifest()
    descriptor = descriptor_from_manifest(manifest, entrypoint_id="main")
    grant = authority.mint_grants(
        manifest=manifest,
        descriptor=descriptor,
        entrypoint_id="main",
        instance_id="instance-one",
        generation=1,
        effective_grants=(_effective(manifest),),
    )[0]
    lease = authority.validate(
        _call(grant.handle),
        grant,
        plugin_id=manifest.plugin.id,
        entrypoint_id="main",
        instance_id="instance-one",
        generation=1,
    )

    request_broker = CapabilityBroker(
        authority,
        audit,
        max_request_bytes=32,
    )
    request_broker.register(
        CapabilityMethodPolicy(
            "notifications.show",
            "notifications.show",
            lambda _call: {"shown": True},
        )
    )
    oversized_request = HostCallRequest(
        grant.handle,
        "notifications.show",
        {"message": "R" * 128},
        RequestContext("hello", True, 1, "trace-request-overflow"),
    )
    with pytest.raises(PlatformSecurityError, match="request exceeds"):
        await request_broker.handle(oversized_request, grant, lease)

    response_broker = CapabilityBroker(
        authority,
        audit,
        max_response_bytes=32,
    )
    response_broker.register(
        CapabilityMethodPolicy(
            "notifications.show",
            "notifications.show",
            lambda _call: {"receipt": "S" * 128},
        )
    )
    with pytest.raises(PlatformSecurityError, match="response exceeds"):
        await response_broker.handle(_call(grant.handle), grant, lease)
    assert [
        item.data["code"] for item in audit.read_all() if item.action == "host.call"
    ] == [
        "CAPABILITY_REQUEST_QUOTA_EXCEEDED",
        "CAPABILITY_RESPONSE_QUOTA_EXCEEDED",
    ]


@pytest.mark.anyio
async def test_supervisor_mints_handles_and_revokes_generation_on_deactivate(
    tmp_path: Path,
) -> None:
    audit = AuditLog(tmp_path / "audit" / "events")
    authority = CapabilityHandleAuthority(audit)
    broker = CapabilityBroker(authority, audit)
    broker.register(
        CapabilityMethodPolicy(
            "notifications.show",
            "notifications.show",
            lambda call: {
                "shown": True,
                "traceId": call.request_context.trace_id,
            },
            require_user_action=True,
        )
    )
    manifest = _manifest()
    supervisor = EntrypointSupervisor(
        EntrypointProcessSpec(
            plugin_id=manifest.plugin.id,
            entrypoint_id="main",
            executable=Path(sys.executable).resolve(),
            arguments=("-u", str(FAKE_PLATFORM), "host-call"),
            working_directory=FIXTURE_DIRECTORY,
            startup_timeout_seconds=1.0,
            request_timeout_seconds=1.0,
            shutdown_timeout_seconds=0.5,
        ),
        manifest,
        host_name="CandleScope",
        host_version="0.4.0",
        host_apis=(HOST_API_V1,),
        capability_authority=authority,
        capability_broker=broker,
    )
    manager = PluginManager((supervisor,))
    try:
        await manager.activate(
            manifest.plugin.id,
            "main",
            effective_grants=(_effective(manifest),),
        )
        assert authority.active_count == 1
        result = await manager.invoke(
            "candlescope.host-call.hello",
            {},
            user_action=True,
            trace_id="phase4-authority-host-call",
        )
        assert result == {
            "notified": True,
            "receipt": {
                "shown": True,
                "traceId": "phase4-authority-host-call",
            },
            "token": "notify:phase4-authority-host-call",
        }
        await manager.deactivate(
            manifest.plugin.id,
            "main",
            reason="revoke generation",
        )
        assert authority.active_count == 0
    finally:
        await manager.stop()


@pytest.mark.anyio
async def test_supervisor_rejects_sidecar_forged_user_action_context(
    tmp_path: Path,
) -> None:
    audit = AuditLog(tmp_path / "audit" / "events")
    authority = CapabilityHandleAuthority(audit)
    handled_calls: list[HostCallRequest] = []

    async def show(call: HostCallRequest) -> dict[str, object]:
        handled_calls.append(call)
        return {"shown": True}

    broker = CapabilityBroker(authority, audit)
    broker.register(
        CapabilityMethodPolicy(
            "notifications.show",
            "notifications.show",
            show,
            require_user_action=True,
        )
    )
    manifest = _manifest()
    supervisor = EntrypointSupervisor(
        EntrypointProcessSpec(
            plugin_id=manifest.plugin.id,
            entrypoint_id="main",
            executable=Path(sys.executable).resolve(),
            arguments=(
                "-u",
                str(FAKE_PLATFORM),
                "host-call-forged-user-action",
            ),
            working_directory=FIXTURE_DIRECTORY,
            startup_timeout_seconds=1.0,
            request_timeout_seconds=1.0,
            shutdown_timeout_seconds=0.5,
        ),
        manifest,
        host_name="CandleScope",
        host_version="0.4.0",
        host_apis=(HOST_API_V1,),
        capability_authority=authority,
        capability_broker=broker,
    )
    manager = PluginManager((supervisor,))
    try:
        await manager.activate(
            manifest.plugin.id,
            "main",
            effective_grants=(_effective(manifest),),
        )
        result = await manager.invoke(
            "candlescope.host-call.hello",
            {},
            user_action=False,
            trace_id="phase4-forged-user-action",
        )
        assert result == {
            "notified": False,
            "error": "CAPABILITY_HANDLE_INVALID",
            "token": "notify:phase4-forged-user-action",
        }
        assert handled_calls == []
        denied = [
            item
            for item in audit.read_all()
            if item.action == "validate" and item.outcome == "denied"
        ]
        assert len(denied) == 1
        assert denied[0].data["reason"] == "request-context"
    finally:
        await manager.stop()


@pytest.mark.anyio
async def test_supervisor_consumes_user_action_credential_before_second_side_effect(
    tmp_path: Path,
) -> None:
    audit = AuditLog(tmp_path / "audit" / "events")
    authority = CapabilityHandleAuthority(audit)
    handled_calls: list[HostCallRequest] = []

    async def show(call: HostCallRequest) -> dict[str, object]:
        handled_calls.append(call)
        return {"shown": True, "count": len(handled_calls)}

    broker = CapabilityBroker(authority, audit)
    broker.register(
        CapabilityMethodPolicy(
            "notifications.show",
            "notifications.show",
            show,
            require_user_action=True,
        )
    )
    manifest = _manifest()
    supervisor = EntrypointSupervisor(
        EntrypointProcessSpec(
            plugin_id=manifest.plugin.id,
            entrypoint_id="main",
            executable=Path(sys.executable).resolve(),
            arguments=("-u", str(FAKE_PLATFORM), "host-call-chain"),
            working_directory=FIXTURE_DIRECTORY,
            startup_timeout_seconds=1.0,
            request_timeout_seconds=1.0,
            shutdown_timeout_seconds=0.5,
        ),
        manifest,
        host_name="CandleScope",
        host_version="0.4.0",
        host_apis=(HOST_API_V1,),
        capability_authority=authority,
        capability_broker=broker,
    )
    manager = PluginManager((supervisor,))
    try:
        await manager.activate(
            manifest.plugin.id,
            "main",
            effective_grants=(_effective(manifest),),
        )
        result = await manager.invoke(
            "candlescope.host-call.hello",
            {},
            user_action=True,
            trace_id="phase4-one-shot-user-action",
        )
        assert result == {
            "notified": False,
            "error": "CAPABILITY_USER_ACTION_REQUIRED",
            "token": "notify:phase4-one-shot-user-action:chain",
        }
        assert len(handled_calls) == 1
        denied = [
            item
            for item in audit.read_all()
            if item.action == "validate" and item.outcome == "denied"
        ]
        assert len(denied) == 1
        assert denied[0].data["reason"] == "user-action-credential"
    finally:
        await manager.stop()
