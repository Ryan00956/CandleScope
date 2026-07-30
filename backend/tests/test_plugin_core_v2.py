from __future__ import annotations

import asyncio
import base64
import json
import time
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from candlescope_plugin_sdk.platform_v2 import (
    CapabilityGrant,
    HostCallRequest,
    PluginManifest,
    RequestContext,
)
from candlescope_plugin_sdk.platform_v2.examples.hello_command import hello_manifest

from app.plugin_core_v2.api import create_core_plugin_router
from app.plugin_core_v2.adapters import CoreCapabilityAdapters
from app.plugin_core_v2.bootstrap import build_core_plugin_platform_from_environment
from app.plugin_core_v2.contracts import core_contributions
from app.plugin_core_v2.errors import CorePluginError
from app.plugin_core_v2.events import PublicEventHub
from app.plugin_core_v2.jobs import PluginJobScheduler
from app.plugin_core_v2.private_storage import PluginPrivateStorage, StorageNamespace
from app.plugin_core_v2.runtime import CorePluginPlatform, DisabledCorePluginPlatform
from app.plugin_core_v2.services import NotificationCenter, PluginSettingsStore
from app.plugin_installer_v2 import PlatformPluginInstaller
from app.plugin_security_v2.audit import AuditLog
from app.plugin_security_v2.capabilities import (
    CapabilityBroker,
    CapabilityHandleAuthority,
    CapabilityLease,
)
from app.plugin_security_v2.errors import PlatformSecurityError
from app.plugin_security_v2.management import LocalManagementGuard
from tests.plugin_platform_bundle_testkit import (
    build_hello_platform_bundle,
    build_scheduled_notification_bundle,
)


def _core_manifest() -> PluginManifest:
    value = hello_manifest().to_wire()
    value["probes"] = []
    value["backend"]["entrypoints"][0]["activationEvents"] = [
        "onCommand",
        "onSchedule",
    ]
    value["contributions"] = [
        {
            "id": "command",
            "kind": "command/1",
            "title": "Command",
            "entrypoint": "main",
            "configuration": {
                "requiresUserAction": True,
                "inputSchema": {
                    "type": "object",
                    "properties": {"name": {"type": "string", "maxLength": 32}},
                    "required": ["name"],
                    "additionalProperties": False,
                },
            },
        },
        {
            "id": "settings",
            "kind": "settings/1",
            "title": "Settings",
            "entrypoint": "main",
            "configuration": {
                "schema": {
                    "type": "object",
                    "properties": {"enabled": {"type": "boolean"}},
                    "required": ["enabled"],
                    "additionalProperties": False,
                },
                "defaults": {"enabled": True},
            },
        },
        {
            "id": "notifications",
            "kind": "notification/1",
            "title": "Notifications",
            "entrypoint": "main",
            "configuration": {"channels": ["toast"], "severities": ["info"]},
        },
        {
            "id": "events",
            "kind": "event-subscriber/1",
            "title": "Events",
            "entrypoint": "main",
            "configuration": {
                "events": ["candlescope.app.ready/1"],
                "queueCapacity": 1,
                "maxBatch": 1,
                "maxLatencyMs": 1,
            },
        },
        {
            "id": "job",
            "kind": "job/1",
            "title": "Job",
            "entrypoint": "main",
            "configuration": {
                "schedule": {"intervalSeconds": 1},
                "timeoutSeconds": 2,
                "maxAttempts": 3,
                "backoffSeconds": 0.1,
                "runOnStartup": True,
            },
        },
    ]
    value["permissions"] = {"required": [], "optional": []}
    return PluginManifest.from_wire(value)


def test_core_contribution_contracts_are_strict_and_catalog_safe() -> None:
    manifest = _core_manifest()
    contributions = core_contributions(manifest)
    assert [item.kind for item in contributions] == [
        "command/1",
        "settings/1",
        "notification/1",
        "event-subscriber/1",
        "job/1",
    ]
    assert contributions[1].configuration["defaults"] == {"enabled": True}
    assert "executable" not in json.dumps([item.to_catalog() for item in contributions])

    invalid = manifest.to_wire()
    invalid["contributions"][1]["configuration"]["schema"]["pattern"] = ".*"
    with pytest.raises(CorePluginError, match="invalid shape"):
        core_contributions(PluginManifest.from_wire(invalid))

    invalid_bounds = manifest.to_wire()
    invalid_bounds["contributions"][1]["configuration"]["schema"]["properties"][
        "enabled"
    ]["minimum"] = 1
    with pytest.raises(CorePluginError, match="invalid shape"):
        core_contributions(PluginManifest.from_wire(invalid_bounds))


def test_settings_bind_merges_new_defaults_without_overwriting_saved_values(
    tmp_path: Path,
) -> None:
    store = PluginSettingsStore(tmp_path / "settings.json")
    original = next(
        item for item in core_contributions(_core_manifest()) if item.kind == "settings/1"
    )
    publisher = "manifest:acme"
    store.bind(original, publisher_identity=publisher)
    store.write(
        original.plugin_id,
        publisher,
        original.id,
        {"enabled": False},
    )

    upgraded_wire = _core_manifest().to_wire()
    configuration = upgraded_wire["contributions"][1]["configuration"]
    configuration["schema"]["properties"]["showTargets"] = {"type": "boolean"}
    configuration["defaults"]["showTargets"] = True
    upgraded = next(
        item
        for item in core_contributions(PluginManifest.from_wire(upgraded_wire))
        if item.kind == "settings/1"
    )

    result = store.bind(upgraded, publisher_identity=publisher)
    assert result["changed"] is True
    assert store.read(upgraded.plugin_id, publisher, upgraded.id)["value"] == {
        "enabled": False,
        "showTargets": True,
    }
    assert store.bind(upgraded, publisher_identity=publisher)["changed"] is False


def test_declarative_view_contract_rejects_unknown_slots_and_command_references() -> (
    None
):
    value = _core_manifest().to_wire()
    value["contributions"].append(
        {
            "id": "results",
            "kind": "view/1",
            "title": "Results",
            "entrypoint": "main",
            "configuration": {
                "slot": "sidePanel",
                "renderer": "table",
                "source": {
                    "kind": "storage.document",
                    "name": "latest",
                    "path": ["rows"],
                },
                "fields": [{"field": "symbol", "label": "Symbol", "format": "text"}],
                "primaryCommand": "command",
            },
        }
    )
    contributions = core_contributions(PluginManifest.from_wire(value))
    view = next(item for item in contributions if item.kind == "view/1")
    assert view.configuration["slot"] == "sidePanel"
    assert view.configuration["maxItems"] == 50
    assert contributions[0].configuration["placements"] == ["commandPalette"]

    unknown_slot = json.loads(json.dumps(value))
    unknown_slot["contributions"][-1]["configuration"]["slot"] = "floatingWindow"
    with pytest.raises(CorePluginError, match="unsupported"):
        core_contributions(PluginManifest.from_wire(unknown_slot))

    unknown_command = json.loads(json.dumps(value))
    unknown_command["contributions"][-1]["configuration"]["primaryCommand"] = "missing"
    with pytest.raises(CorePluginError, match="same plugin"):
        core_contributions(PluginManifest.from_wire(unknown_command))


def test_environment_bootstrap_is_enabled_by_default_and_can_be_disabled(
    tmp_path: Path,
) -> None:
    enabled_by_default = build_core_plugin_platform_from_environment(
        host_name="CandleScope",
        host_version="0.4.0",
        environ={"LOCALAPPDATA": str(tmp_path / "local")},
    )
    assert isinstance(enabled_by_default, CorePluginPlatform)
    assert (
        enabled_by_default.root
        == (tmp_path / "local" / "CandleScope" / "plugin-platform-v2").resolve()
    )

    disabled = build_core_plugin_platform_from_environment(
        host_name="CandleScope",
        host_version="0.4.0",
        environ={"CANDLESCOPE_PLUGIN_PLATFORM_V2_ENABLED": "0"},
    )
    assert isinstance(disabled, DisabledCorePluginPlatform)
    assert disabled.health_summary() == {
        "status": "disabled",
        "enabled": False,
        "started": False,
        "installed": 0,
        "activeRecords": 0,
        "runningEntrypoints": 0,
        "subscriptions": 0,
        "jobs": 0,
        "failedPlugins": 0,
    }

    enabled = build_core_plugin_platform_from_environment(
        host_name="CandleScope",
        host_version="0.4.0",
        environ={
            "CANDLESCOPE_PLUGIN_PLATFORM_V2_ENABLED": "1",
            "CANDLESCOPE_PLUGIN_PLATFORM_V2_ROOT": str(tmp_path / "platform"),
        },
    )
    assert isinstance(enabled, CorePluginPlatform)
    assert enabled.root == (tmp_path / "platform").resolve()

    with pytest.raises(CorePluginError, match="SandboxPolicy"):
        build_core_plugin_platform_from_environment(
            host_name="CandleScope",
            host_version="0.4.0",
            environ={
                "CANDLESCOPE_PLUGIN_PLATFORM_V2_ENABLED": "1",
                "CANDLESCOPE_PLUGIN_PLATFORM_V2_TRUST": "untrusted",
            },
        )


def test_private_storage_isolates_namespaces_and_recovers_migration_snapshot(
    tmp_path: Path,
) -> None:
    storage = PluginPrivateStorage(tmp_path / "private")
    first = StorageNamespace("acme.plugin", "manifest:acme")
    other_plugin = StorageNamespace("acme.other", "manifest:acme")
    other_publisher = StorageNamespace("acme.plugin", "manifest:other")

    assert storage.document_get_if_exists(first, "doc") == {"found": False}
    assert storage.summary_if_exists(first)["exists"] is False
    assert list((tmp_path / "private").rglob("*.sqlite")) == []

    storage.kv_put(first, "key", {"value": 1}, quota_bytes=4096)
    storage.document_put(first, "doc", {"version": 1}, quota_bytes=4096)
    storage.blob_put(
        first,
        "blob",
        base64.b64encode(b"safe").decode("ascii"),
        "application/octet-stream",
        quota_bytes=4096,
    )
    assert storage.kv_get(first, "key")["value"] == {"value": 1}
    assert storage.kv_get(other_plugin, "key") == {"found": False}
    assert storage.kv_get(other_publisher, "key") == {"found": False}

    with pytest.raises(CorePluginError, match="quota"):
        storage.kv_put(first, "too-large", "x" * 100, quota_bytes=8)
    assert storage.kv_get(first, "too-large") == {"found": False}

    before = storage.create_snapshot(first, label="before")
    with pytest.raises(CorePluginError, match="operation"):
        storage.migrate(
            first,
            expected_version=0,
            target_version=1,
            operations=[
                {"op": "putKv", "key": "key", "value": {"value": 2}},
                {"op": "escapeNamespace", "pluginId": "acme.other"},
            ],
            quota_bytes=4096,
        )
    assert storage.kv_get(first, "key")["value"] == {"value": 1}
    assert storage.summary(first)["dataVersion"] == 0

    migrated = storage.migrate(
        first,
        expected_version=0,
        target_version=1,
        operations=[{"op": "putKv", "key": "key", "value": {"value": 3}}],
        quota_bytes=4096,
    )
    assert migrated["toVersion"] == 1
    assert storage.kv_get(first, "key")["value"] == {"value": 3}
    storage.restore_snapshot(first, before["snapshotId"], quota_bytes=4096)
    assert storage.kv_get(first, "key")["value"] == {"value": 1}
    assert storage.summary(first)["dataVersion"] == 0


@pytest.mark.anyio
async def test_storage_capability_namespace_comes_from_lease_not_plugin_params(
    tmp_path: Path,
) -> None:
    audit = AuditLog(tmp_path / "audit" / "events")
    authority = CapabilityHandleAuthority(audit)
    broker = CapabilityBroker(authority, audit)
    storage = PluginPrivateStorage(tmp_path / "private")

    def no_contribution(*_args: Any):
        raise AssertionError("storage methods must not resolve caller-selected plugins")

    CoreCapabilityAdapters(
        storage=storage,
        settings=PluginSettingsStore(tmp_path / "settings.json"),
        notifications=NotificationCenter(),
        resolve_contribution=no_contribution,
    ).register(broker)
    scope = {"maxBytes": 4096}
    grant = CapabilityGrant("cap-storage", "storage.private", scope)

    def lease(plugin_id: str, publisher: str) -> CapabilityLease:
        return CapabilityLease(
            f"fingerprint-{plugin_id}-{publisher}",
            plugin_id,
            "main",
            f"instance-{plugin_id}",
            1,
            "storage.private",
            scope,
            ("command",),
            1,
            "sha256:" + "1" * 64,
            publisher,
            1,
            0.0,
            10_000.0,
        )

    context = RequestContext("command", True, 1, "storage-lease-test")
    put = HostCallRequest(
        grant.handle,
        "storage.kv.put",
        {"key": "secret", "value": {"owner": "a"}},
        context,
    )
    assert (await broker.handle(put, grant, lease("acme.a", "manifest:acme")))["stored"]
    get = HostCallRequest(grant.handle, "storage.kv.get", {"key": "secret"}, context)
    assert await broker.handle(get, grant, lease("acme.b", "manifest:acme")) == {
        "found": False
    }
    assert await broker.handle(get, grant, lease("acme.a", "manifest:other")) == {
        "found": False
    }
    forged = HostCallRequest(
        grant.handle,
        "storage.kv.get",
        {"key": "secret", "pluginId": "acme.a"},
        context,
    )
    with pytest.raises(PlatformSecurityError, match="invalid shape"):
        await broker.handle(forged, grant, lease("acme.b", "manifest:acme"))


@pytest.mark.anyio
async def test_event_queue_is_bounded_and_unregister_cancels_delivery() -> None:
    contribution = next(
        item
        for item in core_contributions(_core_manifest())
        if item.kind == "event-subscriber/1"
    )
    hub = PublicEventHub()
    entered = asyncio.Event()
    release = asyncio.Event()
    cancelled = asyncio.Event()

    async def deliver(*_args: Any) -> None:
        entered.set()
        try:
            await release.wait()
        except asyncio.CancelledError:
            cancelled.set()
            raise

    hub.register(contribution, deliver)
    hub.publish("candlescope.app.ready/1", {"hostVersion": "0.4.0"})
    await asyncio.wait_for(entered.wait(), timeout=1)
    started = time.perf_counter()
    for _ in range(100):
        hub.publish("candlescope.app.ready/1", {"hostVersion": "0.4.0"})
    assert time.perf_counter() - started < 0.1
    assert hub.snapshot()["subscriptions"][0]["queued"] == 1
    assert hub.snapshot()["subscriptions"][0]["dropped"] >= 99
    assert await hub.unregister_plugin(contribution.plugin_id) == 1
    await asyncio.wait_for(cancelled.wait(), timeout=1)
    assert hub.snapshot()["subscriptions"] == []


@pytest.mark.anyio
async def test_job_scheduler_retries_with_backoff_and_removes_disabled_jobs() -> None:
    contribution = next(
        item for item in core_contributions(_core_manifest()) if item.kind == "job/1"
    )
    scheduler = PluginJobScheduler()
    completed = asyncio.Event()
    attempts = 0

    async def invoke(*_args: Any) -> dict[str, Any]:
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            raise RuntimeError("retry")
        completed.set()
        return {"ok": True}

    scheduler.register(contribution, invoke)
    await asyncio.wait_for(completed.wait(), timeout=2)
    snapshot = scheduler.snapshot()[0]
    assert snapshot["failureCount"] == 2
    assert snapshot["runCount"] == 1
    assert await scheduler.unregister_plugin(contribution.plugin_id) == 1
    assert scheduler.snapshot() == []


@pytest.mark.anyio
async def test_product_root_keeps_command_plugin_stopped_until_invoked_and_disables_cleanly(
    tmp_path: Path,
) -> None:
    fixture = build_hello_platform_bundle(tmp_path / "bundle")
    root = tmp_path / "managed"
    installer = PlatformPluginInstaller(root=root, host_version="0.4.0")
    installed = installer.install(
        fixture.bundle.path,
        expected_sha256=fixture.bundle.sha256,
        enabled=True,
    )
    assert installed.state == "active"
    platform = CorePluginPlatform(
        root=root,
        host_name="CandleScope",
        host_version="0.4.0",
    )
    await platform.start()
    try:
        supervisor = platform.manager.supervisor(installed.plugin_id, "main")
        assert supervisor.state == "stopped"
        assert platform.health_summary()["runningEntrypoints"] == 0
        catalog_text = json.dumps(platform.catalog())
        assert "installationPath" not in catalog_text
        assert "executable" not in catalog_text
        platform._load_failures[installed.plugin_id] = {
            "code": "PLUGIN_PLATFORM_INSTALLER_FAILED",
            "message": f"unsafe diagnostic path: {tmp_path}",
            "details": {"path": str(tmp_path)},
        }
        diagnostics_text = json.dumps(platform.diagnostics())
        assert str(tmp_path) not in diagnostics_text
        assert platform.diagnostics()["loadFailures"] == [
            {
                "pluginId": installed.plugin_id,
                "code": "PLUGIN_PLATFORM_INSTALLER_FAILED",
            }
        ]
        platform._load_failures.pop(installed.plugin_id)

        result = await platform.invoke_command(
            "candlescope.hello-command.hello",
            {"name": "Phase 5"},
            user_action=True,
            trace_id="phase5-command",
        )
        assert result["message"] == "Hello, Phase 5!"
        assert supervisor.state == "active"

        await platform.stop()
        assert platform.manager.owner_keys() == ()
        await platform.start()
        supervisor = platform.manager.supervisor(installed.plugin_id, "main")
        assert supervisor.state == "stopped"

        installer.disable(installed.plugin_id)
        await platform.reconcile_plugin(installed.plugin_id)
        assert platform.manager.owner_keys() == ()
        assert platform.health_summary()["runningEntrypoints"] == 0
        assert platform.health_summary()["subscriptions"] == 0
        assert platform.health_summary()["jobs"] == 0
        disabled_catalog = platform.catalog()["plugins"][0]
        assert disabled_catalog["available"] is False
        assert disabled_catalog["unavailableReason"] == "PLUGIN_NOT_ACTIVE"
        assert all(
            contribution["available"] is False
            for contribution in disabled_catalog["contributions"]
        )
        with pytest.raises(CorePluginError, match="not active"):
            await platform.invoke_command(
                "candlescope.hello-command.hello",
                {"name": "stale"},
                user_action=True,
                trace_id="phase5-disabled",
            )
    finally:
        await platform.stop()


@pytest.mark.anyio
async def test_scheduled_notification_reference_uses_real_grants_job_and_host_call(
    tmp_path: Path,
) -> None:
    fixture = build_scheduled_notification_bundle(tmp_path / "bundle")
    root = tmp_path / "managed"
    installer = PlatformPluginInstaller(root=root, host_version="0.4.0")
    installed = installer.install(
        fixture.bundle.path,
        expected_sha256=fixture.bundle.sha256,
        enabled=True,
    )
    assert installed.state == "staged"
    for permission in fixture.bundle.manifest.permissions.required:
        installer.grant_permission(
            installed.plugin_id,
            permission.id,
            scope=permission.scope,
        )
    assert installer.enable(installed.plugin_id).state == "active"

    platform = CorePluginPlatform(
        root=root,
        host_name="CandleScope",
        host_version="0.4.0",
    )
    await platform.start()
    try:
        supervisor = platform.manager.supervisor(installed.plugin_id, "main")
        assert supervisor.state == "stopped"
        assert len(platform.jobs.snapshot()) == 1
        outcome = await platform.trigger_job(
            "candlescope.scheduled-notification.reminder-job",
            user_action=True,
        )
        assert outcome["result"]["notified"] is True
        notifications = platform.notifications.snapshot(plugin_id=installed.plugin_id)
        assert len(notifications) == 1
        assert notifications[0]["sourceId"].endswith(".reminder-source")
        assert supervisor.state == "active"

        revoked = installer.revoke_permission(installed.plugin_id, "jobs.schedule")
        assert revoked.activation_state == "staged"
        await platform.reconcile_plugin(installed.plugin_id)
        assert platform.jobs.snapshot() == []
        assert platform.manager.owner_keys() == ()
    finally:
        await platform.stop()


@pytest.mark.anyio
async def test_catalog_is_public_but_mutations_require_local_management_guard(
    tmp_path: Path,
) -> None:
    fixture = build_hello_platform_bundle(tmp_path / "bundle")
    root = tmp_path / "managed"
    installer = PlatformPluginInstaller(root=root, host_version="0.4.0")
    installer.install(
        fixture.bundle.path,
        expected_sha256=fixture.bundle.sha256,
        enabled=True,
    )
    platform = CorePluginPlatform(
        root=root, host_name="CandleScope", host_version="0.4.0"
    )
    await platform.start()
    guard = LocalManagementGuard(
        ("http://127.0.0.1:5173",),
        session_token="phase5-session-token-0123456789abcdef",
        csrf_token="phase5-csrf-token-0123456789abcdefghi",
    )
    app = FastAPI()
    app.state.plugin_platform_v2 = platform
    app.state.plugin_platform_v2_management_guard = guard
    app.include_router(create_core_plugin_router())
    transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 43200))
    try:
        async with httpx.AsyncClient(
            transport=transport, base_url="http://127.0.0.1"
        ) as client:
            catalog = await client.get("/api/v2/plugins/catalog")
            assert catalog.status_code == 200
            assert catalog.json()["plugins"][0]["id"] == "candlescope.hello-command"
            ui_snapshot = await client.get("/api/v2/plugins/ui/snapshot")
            assert ui_snapshot.status_code == 200
            assert ui_snapshot.json() == {
                "schemaVersion": "candlescope.plugin-ui/1",
                "registryRevision": 1,
                "views": [],
                "chartLayers": [],
            }
            background_without_csrf = {
                key: value
                for key, value in guard.trusted_headers().items()
                if key != "X-CandleScope-CSRF"
            }
            assert (
                await client.put(
                    "/api/v2/plugins/manage/chart-context",
                    headers=background_without_csrf,
                    json={
                        "chartId": "main-chart",
                        "active": False,
                        "context": None,
                        "series": None,
                    },
                )
            ).status_code == 403
            chart_context = await client.put(
                "/api/v2/plugins/manage/chart-context",
                headers=guard.trusted_headers(),
                json={
                    "chartId": "main-chart",
                    "active": True,
                    "context": {
                        "mode": "live",
                        "exchange": "binance",
                        "marketType": "spot",
                    },
                    "series": {"symbol": "BTCUSDT", "interval": "1m"},
                },
            )
            assert chart_context.status_code == 200
            assert chart_context.json() == {
                "schemaVersion": "candlescope.chart-context/1",
                "chartId": "main-chart",
                "revision": 1,
                "active": True,
                "context": {
                    "mode": "live",
                    "exchange": "binance",
                    "marketType": "spot",
                },
                "series": {"symbol": "BTCUSDT", "interval": "1m"},
                "updatedAtMs": chart_context.json()["updatedAtMs"],
            }
            heartbeat = await client.put(
                "/api/v2/plugins/manage/chart-context",
                headers=guard.trusted_headers(),
                json={
                    "chartId": "main-chart",
                    "active": True,
                    "context": {
                        "mode": "live",
                        "exchange": "binance",
                        "marketType": "spot",
                    },
                    "series": {"symbol": "BTCUSDT", "interval": "1m"},
                },
            )
            assert heartbeat.status_code == 200
            assert heartbeat.json()["revision"] == 1
            assert (
                await client.get(
                    "/api/v2/plugins/manage/candlescope.hello-command/detail"
                )
            ).status_code == 403
            detail = await client.get(
                "/api/v2/plugins/manage/candlescope.hello-command/detail",
                headers=guard.trusted_headers(),
            )
            assert detail.status_code == 200
            assert detail.json()["update"] == {
                "policy": "signed-marketplace-or-local-artifact",
                "automatic": False,
                "available": False,
                "ownership": "local-or-first-party",
                "reason": "NO_SIGNED_UPDATE",
                "candidate": None,
                "latest": None,
            }
            assert detail.json()["dataRetention"]["retainedOnUninstall"] is True
            permission_detail = detail.json()["permissions"][0]
            assert set(permission_detail) == {
                "pluginId",
                "activationReady",
                "requiredSatisfied",
                "permissions",
            }
            assert all(
                set(item)
                == {
                    "permissionId",
                    "kind",
                    "decision",
                    "requestedScope",
                    "grantedScope",
                }
                for item in permission_detail["permissions"]
            )
            upload_headers = {
                **guard.trusted_headers(user_action="install-bundle"),
                "Content-Type": "application/vnd.candlescope.plugin+zip",
                "X-CandleScope-Bundle-SHA256": "sha256:" + "0" * 64,
            }
            mismatch = await client.post(
                "/api/v2/plugins/manage/install",
                headers=upload_headers,
                content=fixture.bundle.path.read_bytes(),
            )
            assert mismatch.status_code == 400
            upload_headers["X-CandleScope-Bundle-SHA256"] = fixture.bundle.sha256
            uploaded = await client.post(
                "/api/v2/plugins/manage/install",
                headers=upload_headers,
                content=fixture.bundle.path.read_bytes(),
            )
            assert uploaded.status_code == 200
            assert uploaded.json()["installation"]["pluginId"] == (
                "candlescope.hello-command"
            )
            assert list((root / "incoming-v2").glob("*.cspkg")) == []
            assert (
                await client.post(
                    "/api/v2/plugins/manage/commands/candlescope.hello-command.hello/invoke",
                    json={"input": {"name": "denied"}},
                )
            ).status_code == 403
            invoked = await client.post(
                "/api/v2/plugins/manage/commands/candlescope.hello-command.hello/invoke",
                headers=guard.trusted_headers(user_action="invoke-hello"),
                json={"input": {"name": "API"}},
            )
            assert invoked.status_code == 200
            assert invoked.json()["result"]["message"] == "Hello, API!"
    finally:
        await platform.stop()
