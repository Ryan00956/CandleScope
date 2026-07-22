"""Product composition root for the Phase 5 minimum Plugin Platform."""

from __future__ import annotations

import asyncio
import contextlib
import time
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any

from candlescope_plugin_sdk.platform_v2 import HOST_API_V1, normalize_json

from app.plugin_host import EntrypointProcessSpec, EntrypointSupervisor
from app.plugin_installer_v2 import PlatformPluginInstaller
from app.plugin_installer_v2.bundle import VerifiedPlatformBundle
from app.plugin_installer_v2.registry import (
    ActivationRecord,
    ActivationRegistry,
    load_activation_registry,
)
from app.plugin_platform import PluginManager
from app.plugin_market_v2.runtime import PluginMarketRuntime
from app.plugin_security_v2 import (
    AuditLog,
    CapabilityBroker,
    CapabilityHandleAuthority,
    GrantStore,
)
from app.plugin_security_v2.grants import (
    EffectiveGrant,
    manifest_publisher_identity,
)
from app.plugin_security_v2.sandbox import SandboxPolicy

from .adapters import CoreCapabilityAdapters
from .contracts import (
    CORE_CONTRIBUTION_KINDS,
    CoreContribution,
    core_contributions,
    validate_settings_value,
)
from .errors import core_error
from .events import PublicEventHub
from .jobs import PluginJobScheduler
from .private_storage import PluginPrivateStorage
from .services import NotificationCenter, PluginSettingsStore


CATALOG_SCHEMA_VERSION = "candlescope.plugin-catalog/1"
TRUST_LEVELS = frozenset({"first-party-pinned", "local-trusted", "untrusted"})
SandboxFactory = Callable[
    [ActivationRecord, VerifiedPlatformBundle, str], SandboxPolicy
]


_RESOURCE_LIMITS: dict[str, dict[str, Any]] = {
    "minimal": {
        "max_message_bytes": 256 * 1024,
        "max_stderr_bytes": 32 * 1024,
        "max_in_flight": 16,
        "max_host_calls": 4,
    },
    "standard": {
        "max_message_bytes": 1024 * 1024,
        "max_stderr_bytes": 64 * 1024,
        "max_in_flight": 32,
        "max_host_calls": 8,
    },
    "service": {
        "max_message_bytes": 2 * 1024 * 1024,
        "max_stderr_bytes": 128 * 1024,
        "max_in_flight": 64,
        "max_host_calls": 16,
    },
}


class CorePluginPlatform:
    """Own active v2 records while keeping all ordinary plugins lazy."""

    def __init__(
        self,
        *,
        root: Path | str,
        host_name: str,
        host_version: str,
        trust_level: str = "local-trusted",
        sandbox_factory: SandboxFactory | None = None,
        approved_startup_plugins: Iterable[str] = (),
    ) -> None:
        if trust_level not in TRUST_LEVELS:
            raise ValueError("plugin platform trust level is invalid")
        if trust_level == "untrusted" and sandbox_factory is None:
            raise core_error(
                "PLUGIN_CORE_SANDBOX_REQUIRED",
                "untrusted product activation requires an explicit SandboxPolicy factory",
            )
        self.root = Path(root).expanduser().resolve(strict=False)
        self.host_name = host_name
        self.host_version = host_version
        self.trust_level = trust_level
        self.sandbox_factory = sandbox_factory
        self.approved_startup_plugins = frozenset(approved_startup_plugins)

        self.audit_log = AuditLog(self.root / "audit-v2" / "events")
        self.grant_store = GrantStore(
            self.root / "platform-grants-v2.json", audit_log=self.audit_log
        )
        self.installer = PlatformPluginInstaller(
            root=self.root,
            host_version=self.host_version,
            audit_log=self.audit_log,
            grant_store=self.grant_store,
        )
        self.authority = CapabilityHandleAuthority(
            self.audit_log,
            default_ttl_seconds=86_400.0,
            grant_store=self.grant_store,
        )
        self.broker = CapabilityBroker(self.authority, self.audit_log)
        self.private_storage = PluginPrivateStorage(self.root / "private")
        self.settings = PluginSettingsStore(self.root / "plugin-settings-v1.json")
        self.notifications = NotificationCenter()
        self.events = PublicEventHub()
        self.jobs = PluginJobScheduler()
        self.manager = PluginManager(())
        self.adapters = CoreCapabilityAdapters(
            storage=self.private_storage,
            settings=self.settings,
            notifications=self.notifications,
            resolve_contribution=self.resolve_contribution,
        )
        self.adapters.register(self.broker)
        self.market = PluginMarketRuntime(
            broker=self.broker,
            authority=self.authority,
            resolve_contribution=self.resolve_contribution,
            deliver=self._deliver_market_batch,
        )

        self._registry = ActivationRegistry()
        self._records: dict[str, ActivationRecord] = {}
        self._bundles: dict[str, VerifiedPlatformBundle] = {}
        self._installations: dict[str, Path] = {}
        self._contributions: dict[str, CoreContribution] = {}
        self._plugin_contributions: dict[str, tuple[CoreContribution, ...]] = {}
        self._effective_grants: dict[str, tuple[EffectiveGrant, ...]] = {}
        self._permission_summaries: dict[str, dict[str, Any]] = {}
        self._load_failures: dict[str, dict[str, Any]] = {}
        self._activation_locks: dict[tuple[str, str], asyncio.Lock] = {}
        self._activated_at: dict[tuple[str, str], float] = {}
        self._reconcile_lock = asyncio.Lock()
        self._maintenance_task: asyncio.Task[None] | None = None
        self._started = False

    async def start(self) -> None:
        async with self._reconcile_lock:
            if self._started:
                return
            self.market.start()
            await self._refresh_static_state()
            for record in self._registry.plugins:
                if record.state == "active":
                    await self._add_live_plugin(record.plugin_id)
            await self.manager.start()
            self._started = True
            for record in self._registry.plugins:
                if record.state == "active" and record.plugin_id in self._bundles:
                    self._register_work(record.plugin_id)
            for record in self._registry.plugins:
                if (
                    record.state == "active"
                    and record.plugin_id in self.approved_startup_plugins
                ):
                    manifest = self._bundles[record.plugin_id].manifest
                    for entrypoint in manifest.backend_entrypoints:
                        if "onStartup" in entrypoint.activation_events:
                            await self._ensure_active(record.plugin_id, entrypoint.id)
            self._maintenance_task = asyncio.create_task(
                self._maintenance_loop(), name="plugin-core-capability-rotation"
            )

    async def stop(self) -> None:
        async with self._reconcile_lock:
            maintenance = self._maintenance_task
            self._maintenance_task = None
            if maintenance is not None:
                maintenance.cancel()
                await asyncio.gather(maintenance, return_exceptions=True)
            await self.jobs.stop()
            await self.events.stop()
            await self.market.stop()
            plugin_ids = set(self._records)
            plugin_ids.update(owner[0] for owner in self.manager.owner_keys())
            for plugin_id in sorted(plugin_ids):
                self.authority.revoke_plugin(plugin_id)
                self.settings.unbind_plugin(plugin_id)
                await self.manager.remove_plugin(plugin_id)
            await self.manager.stop()
            self._activated_at.clear()
            self._activation_locks.clear()
            self._started = False

    async def _maintenance_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(3600.0)
                now = time.monotonic()
                for owner, activated_at in tuple(self._activated_at.items()):
                    if now - activated_at < 43_200.0:
                        continue
                    supervisor = self.manager.supervisor(*owner)
                    if supervisor.state == "active":
                        with contextlib.suppress(Exception):
                            await self.manager.deactivate(
                                *owner, reason="Capability lease rotation"
                            )
                    self._activated_at.pop(owner, None)
        except asyncio.CancelledError:
            raise

    async def _refresh_static_state(self) -> None:
        registry = await asyncio.to_thread(
            load_activation_registry, self.installer.registry_path
        )
        records = registry.by_id()
        bundles: dict[str, VerifiedPlatformBundle] = {}
        installations: dict[str, Path] = {}
        plugin_contributions: dict[str, tuple[CoreContribution, ...]] = {}
        contributions: dict[str, CoreContribution] = {}
        effective: dict[str, tuple[EffectiveGrant, ...]] = {}
        permission_summaries: dict[str, dict[str, Any]] = {}
        failures: dict[str, dict[str, Any]] = {}

        raw_summaries = await asyncio.to_thread(self.grant_store.summary)
        summaries_by_id = {item["pluginId"]: item for item in raw_summaries}
        for plugin_id, record in records.items():
            try:
                bundle, installation = await asyncio.to_thread(
                    self.installer.verify_activation_static, record
                )
                values = core_contributions(bundle.manifest)
                if not values:
                    raise core_error(
                        "PLUGIN_CORE_NO_SUPPORTED_CONTRIBUTIONS",
                        "plugin has no Phase 5 core contributions",
                        plugin_id=plugin_id,
                    )
                conflicts = sorted(
                    item.full_id for item in values if item.full_id in contributions
                )
                if conflicts:
                    raise core_error(
                        "PLUGIN_CORE_CONTRIBUTION_CONFLICT",
                        "core contribution ID is already registered",
                        plugin_id=plugin_id,
                        details={"conflicts": conflicts},
                    )
                bundles[plugin_id] = bundle
                installations[plugin_id] = installation
                plugin_contributions[plugin_id] = values
                contributions.update((item.full_id, item) for item in values)
                effective[plugin_id] = await asyncio.to_thread(
                    self.grant_store.effective_grants,
                    bundle.manifest,
                    bundle_sha256=bundle.sha256,
                    manifest_sha256=bundle.manifest_sha256,
                )
            except Exception as exc:
                failures[plugin_id] = self._failure_wire(exc)
            summary = summaries_by_id.get(plugin_id)
            permission_summaries[plugin_id] = self._safe_permission_summary(
                record, summary
            )

        self._registry = registry
        self._records = records
        self._bundles = bundles
        self._installations = installations
        self._plugin_contributions = plugin_contributions
        self._contributions = contributions
        self._effective_grants = effective
        self._permission_summaries = permission_summaries
        self._load_failures = failures

    @staticmethod
    def _failure_wire(exc: Exception) -> dict[str, Any]:
        if hasattr(exc, "to_dict"):
            value = exc.to_dict()
            if isinstance(value, dict):
                return value
        return {
            "code": "PLUGIN_CORE_LOAD_FAILED",
            "message": "plugin could not be loaded",
            "details": {"errorType": type(exc).__name__},
        }

    @staticmethod
    def _safe_permission_summary(
        record: ActivationRecord, summary: dict[str, Any] | None
    ) -> dict[str, Any]:
        permissions = []
        if summary is not None:
            permissions = [
                {
                    "permissionId": item["permissionId"],
                    "kind": item["kind"],
                    "decision": item["decision"],
                    "hasGrantedScope": item["grantedScope"] is not None,
                }
                for item in summary["permissions"]
            ]
        return {
            "activationReady": bool(summary is not None and summary["activationReady"]),
            "requiredSatisfied": bool(
                summary is not None and summary["requiredSatisfied"]
            ),
            "permissions": permissions,
            "requiredPermissionIds": list(record.required_permissions),
        }

    async def _add_live_plugin(self, plugin_id: str) -> None:
        record = self._records.get(plugin_id)
        bundle = self._bundles.get(plugin_id)
        if record is None or bundle is None or record.state != "active":
            return
        if not await asyncio.to_thread(
            self.grant_store.activation_ready,
            bundle.manifest,
            bundle_sha256=bundle.sha256,
            manifest_sha256=bundle.manifest_sha256,
        ):
            self._load_failures[plugin_id] = {
                "code": "PLUGIN_CORE_GRANTS_NOT_READY",
                "message": "active registry record no longer has complete grants",
                "pluginId": plugin_id,
            }
            return
        try:
            publisher_identity = manifest_publisher_identity(bundle.manifest)
            for contribution in self._plugin_contributions[plugin_id]:
                if contribution.kind == "settings/1":
                    await asyncio.to_thread(
                        self.settings.bind,
                        contribution,
                        publisher_identity=publisher_identity,
                    )
            supervisors = tuple(
                self._build_supervisor(record, bundle, entrypoint.id)
                for entrypoint in bundle.manifest.backend_entrypoints
            )
            await self.manager.add_supervisors(supervisors)
            self._load_failures.pop(plugin_id, None)
        except Exception as exc:
            self.settings.unbind_plugin(plugin_id)
            await self.manager.remove_plugin(plugin_id)
            self._load_failures[plugin_id] = self._failure_wire(exc)

    def _build_supervisor(
        self,
        record: ActivationRecord,
        bundle: VerifiedPlatformBundle,
        entrypoint_id: str,
    ) -> EntrypointSupervisor:
        activation = next(
            item for item in record.entrypoints if item.id == entrypoint_id
        )
        declared = next(
            item
            for item in bundle.manifest.backend_entrypoints
            if item.id == entrypoint_id
        )
        limits = _RESOURCE_LIMITS[declared.resource_profile]
        sandbox = (
            self.sandbox_factory(record, bundle, entrypoint_id)
            if self.sandbox_factory is not None
            else None
        )
        spec = EntrypointProcessSpec(
            plugin_id=record.plugin_id,
            entrypoint_id=entrypoint_id,
            executable=activation.executable,
            arguments=("-I", "-u", "-m", activation.module),
            working_directory=activation.working_directory,
            enabled=True,
            auto_start=False,
            required=False,
            sandbox_policy=sandbox,
            trust_level=self.trust_level,
            **limits,
        )
        return EntrypointSupervisor(
            spec,
            bundle.manifest,
            host_name=self.host_name,
            host_version=self.host_version,
            host_apis=(HOST_API_V1,),
            capability_authority=self.authority,
            capability_broker=self.broker,
        )

    def _register_work(self, plugin_id: str) -> None:
        record = self._records.get(plugin_id)
        if (
            record is None
            or record.state != "active"
            or not any(owner[0] == plugin_id for owner in self.manager.owner_keys())
        ):
            return
        grants = {
            item.permission_id: item for item in self._effective_grants[plugin_id]
        }
        for contribution in self._plugin_contributions[plugin_id]:
            if contribution.kind == "event-subscriber/1":
                grant = grants.get("events.public.subscribe")
                if grant is not None and self._event_scope_allows(grant, contribution):
                    self.events.register(contribution, self._deliver_events)
            elif contribution.kind == "job/1":
                grant = grants.get("jobs.schedule")
                if grant is not None and self._job_scope_allows(grant, contribution):
                    self.jobs.register(contribution, self._invoke_job_callback)

    @staticmethod
    def _event_scope_allows(
        grant: EffectiveGrant, contribution: CoreContribution
    ) -> bool:
        allowed = grant.scope.get("events")
        return allowed is None or (
            isinstance(allowed, list)
            and set(contribution.configuration["events"]) <= set(allowed)
        )

    @staticmethod
    def _job_scope_allows(
        grant: EffectiveGrant, contribution: CoreContribution
    ) -> bool:
        allowed = grant.scope.get("jobs")
        if allowed is not None and (
            not isinstance(allowed, list) or contribution.id not in allowed
        ):
            return False
        max_runs = grant.scope.get("maxRunsPerHour")
        schedule = contribution.configuration.get("schedule")
        if max_runs is not None and schedule is not None:
            if (
                isinstance(max_runs, bool)
                or not isinstance(max_runs, (int, float))
                or max_runs <= 0
            ):
                return False
            return schedule["intervalSeconds"] >= 3600.0 / float(max_runs)
        return True

    async def _ensure_active(
        self, plugin_id: str, entrypoint_id: str
    ) -> EntrypointSupervisor:
        if not self._started:
            raise core_error(
                "PLUGIN_CORE_NOT_STARTED", "plugin platform is not started"
            )
        record = self._records.get(plugin_id)
        if record is None or record.state != "active":
            raise core_error(
                "PLUGIN_CORE_NOT_ACTIVE",
                "plugin is not active",
                plugin_id=plugin_id,
            )
        owner = (plugin_id, entrypoint_id)
        lock = self._activation_locks.setdefault(owner, asyncio.Lock())
        async with lock:
            supervisor = self.manager.supervisor(plugin_id, entrypoint_id)
            if supervisor.state == "active":
                return supervisor
            try:
                await self.manager.activate(
                    plugin_id,
                    entrypoint_id,
                    effective_grants=self._effective_grants[plugin_id],
                )
            except Exception as exc:
                self._load_failures[plugin_id] = self._failure_wire(exc)
                raise
            self._activated_at[owner] = time.monotonic()
            return supervisor

    async def _invoke(
        self,
        contribution: CoreContribution,
        input_value: dict[str, Any],
        *,
        user_action: bool,
        trace_id: str,
    ) -> dict[str, Any]:
        await self._ensure_active(contribution.plugin_id, contribution.entrypoint_id)
        return await self.manager.invoke(
            contribution.full_id,
            input_value,
            user_action=user_action,
            trace_id=trace_id,
        )

    async def invoke_command(
        self,
        contribution_id: str,
        input_value: dict[str, Any],
        *,
        user_action: bool,
        trace_id: str,
    ) -> dict[str, Any]:
        contribution = self._resolve_full(contribution_id, kind="command/1")
        if (
            contribution.configuration.get("requiresUserAction", True)
            and not user_action
        ):
            raise core_error(
                "PLUGIN_COMMAND_USER_ACTION_REQUIRED",
                "command requires a current user action",
                plugin_id=contribution.plugin_id,
            )
        normalized = normalize_json(input_value, path="command.input")
        if not isinstance(normalized, dict):
            raise core_error(
                "PLUGIN_COMMAND_INPUT_INVALID", "command input must be an object"
            )
        schema = contribution.configuration.get("inputSchema")
        if schema is not None:
            normalized = validate_settings_value(
                schema,
                normalized,
                plugin_id=contribution.plugin_id,
                contribution_id=contribution.id,
                path="command.input",
            )
            if not isinstance(normalized, dict):
                raise core_error(
                    "PLUGIN_COMMAND_INPUT_INVALID",
                    "command input schema root must be object",
                )
        return await self._invoke(
            contribution,
            normalized,
            user_action=user_action,
            trace_id=trace_id,
        )

    async def _invoke_job_callback(
        self,
        contribution: CoreContribution,
        payload: dict[str, Any],
        user_action: bool,
        trace_id: str,
    ) -> dict[str, Any]:
        return await self._invoke(
            contribution,
            payload,
            user_action=user_action,
            trace_id=trace_id,
        )

    async def trigger_job(
        self, contribution_id: str, *, user_action: bool
    ) -> dict[str, Any]:
        if not user_action:
            raise core_error(
                "PLUGIN_JOB_USER_ACTION_REQUIRED",
                "manual job trigger requires a current user action",
            )
        contribution = self._resolve_full(contribution_id, kind="job/1")
        return await self.jobs.trigger(
            contribution.full_id, user_action=True, reason="user"
        )

    async def _deliver_events(
        self,
        contribution: CoreContribution,
        events: tuple[dict[str, Any], ...],
        delivery: dict[str, Any],
    ) -> None:
        supervisor = await self._ensure_active(
            contribution.plugin_id, contribution.entrypoint_id
        )
        await supervisor.event_batch(events, delivery)

    async def _deliver_market_batch(
        self,
        plugin_id: str,
        entrypoint_id: str,
        generation: int,
        events: tuple[dict[str, Any], ...],
        delivery: dict[str, Any],
    ) -> None:
        supervisor = self.manager.supervisor(plugin_id, entrypoint_id)
        if supervisor.state != "active" or supervisor.generation != generation:
            raise core_error(
                "PLUGIN_MARKET_STALE_GENERATION",
                "market batch belongs to an inactive generation",
                plugin_id=plugin_id,
            )
        await supervisor.event_batch(events, delivery)

    def bind_market_data(self, port: Any) -> None:
        """Bind the Host-owned DataManager adapter without exposing it to plugins."""

        self.market.bind(port)

    def publish_event(self, event_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        if not self._started:
            return {
                "eventId": event_id,
                "sequence": 0,
                "matchedSubscriptions": 0,
                "dropped": 0,
                "platformStarted": False,
            }
        return self.events.publish(event_id, payload)

    def resolve_contribution(
        self, plugin_id: str, kind: str, contribution_id: str
    ) -> CoreContribution:
        if not isinstance(contribution_id, str):
            raise core_error(
                "PLUGIN_CORE_CONTRIBUTION_NOT_FOUND", "contribution ID is invalid"
            )
        full_id = (
            contribution_id
            if contribution_id.startswith(plugin_id + ".")
            else f"{plugin_id}.{contribution_id}"
        )
        contribution = self._contributions.get(full_id)
        if (
            contribution is None
            or contribution.plugin_id != plugin_id
            or contribution.kind != kind
        ):
            raise core_error(
                "PLUGIN_CORE_CONTRIBUTION_NOT_FOUND",
                "contribution is not available for this plugin and kind",
                plugin_id=plugin_id,
            )
        return contribution

    def _resolve_full(self, full_id: str, *, kind: str) -> CoreContribution:
        contribution = self._contributions.get(full_id)
        if contribution is None or contribution.kind != kind:
            raise core_error(
                "PLUGIN_CORE_CONTRIBUTION_NOT_FOUND",
                "core contribution is not available",
            )
        return contribution

    async def read_settings(self, full_id: str) -> dict[str, Any]:
        contribution = self._resolve_full(full_id, kind="settings/1")
        return await asyncio.to_thread(
            self.settings.read,
            contribution.plugin_id,
            manifest_publisher_identity(self._bundles[contribution.plugin_id].manifest),
            contribution.id,
        )

    async def write_settings(
        self, full_id: str, value: dict[str, Any]
    ) -> dict[str, Any]:
        contribution = self._resolve_full(full_id, kind="settings/1")
        return await asyncio.to_thread(
            self.settings.write,
            contribution.plugin_id,
            manifest_publisher_identity(self._bundles[contribution.plugin_id].manifest),
            contribution.id,
            value,
        )

    async def reconcile_plugin(self, plugin_id: str) -> None:
        async with self._reconcile_lock:
            await self.jobs.unregister_plugin(plugin_id)
            await self.events.unregister_plugin(plugin_id)
            await self.market.clear_plugin(plugin_id, reason="plugin-reconcile")
            self.authority.revoke_plugin(plugin_id)
            self.settings.unbind_plugin(plugin_id)
            await self.manager.remove_plugin(plugin_id)
            self._activated_at = {
                owner: value
                for owner, value in self._activated_at.items()
                if owner[0] != plugin_id
            }
            self._activation_locks = {
                owner: value
                for owner, value in self._activation_locks.items()
                if owner[0] != plugin_id
            }
            await self._refresh_static_state()
            record = self._records.get(plugin_id)
            if self._started and record is not None and record.state == "active":
                await self._add_live_plugin(plugin_id)
                self._register_work(plugin_id)
            if self._started:
                event_id = (
                    "candlescope.plugin.enabled/1"
                    if record is not None and record.state == "active"
                    else "candlescope.plugin.disabled/1"
                )
                self.events.publish(event_id, {"pluginId": plugin_id})

    def catalog(self) -> dict[str, Any]:
        plugins: list[dict[str, Any]] = []
        live_plugin_ids = {owner[0] for owner in self.manager.owner_keys()}
        for plugin_id in sorted(self._records):
            record = self._records[plugin_id]
            bundle = self._bundles.get(plugin_id)
            contributions = self._plugin_contributions.get(plugin_id, ())
            failure = self._load_failures.get(plugin_id)
            available = (
                self._started
                and record.state == "active"
                and failure is None
                and plugin_id in live_plugin_ids
            )
            unavailable_reason = None
            if failure is not None:
                unavailable_reason = failure["code"]
            elif not self._started:
                unavailable_reason = "PLUGIN_PLATFORM_NOT_STARTED"
            elif record.state != "active":
                unavailable_reason = "PLUGIN_NOT_ACTIVE"
            elif plugin_id not in live_plugin_ids:
                unavailable_reason = "PLUGIN_RUNTIME_UNAVAILABLE"
            runtime_entrypoints: list[dict[str, Any]] = []
            for owner in self.manager.owner_keys():
                if owner[0] != plugin_id:
                    continue
                supervisor = self.manager.supervisor(*owner)
                runtime_entrypoints.append(
                    {
                        "entrypointId": owner[1],
                        "state": supervisor.state,
                        "generation": supervisor.generation,
                    }
                )
            unsupported = []
            if bundle is not None:
                unsupported = [
                    {
                        "id": f"{plugin_id}.{item.id}",
                        "kind": item.kind,
                        "title": item.title,
                        "available": False,
                        "reason": "CONTRIBUTION_KIND_NOT_IN_PHASE5",
                    }
                    for item in bundle.manifest.contributions
                    if item.kind not in CORE_CONTRIBUTION_KINDS
                ]
            plugins.append(
                {
                    "id": plugin_id,
                    "name": record.name,
                    "version": record.version,
                    "publisher": record.publisher,
                    "state": record.state,
                    "enabled": record.enabled,
                    "trustLevel": self.trust_level,
                    "available": available,
                    **(
                        {"unavailableReason": unavailable_reason}
                        if unavailable_reason is not None
                        else {}
                    ),
                    "permissions": self._permission_summaries[plugin_id],
                    "contributions": [
                        {
                            **item.to_catalog(),
                            "available": available,
                            **(
                                {"unavailableReason": unavailable_reason}
                                if unavailable_reason is not None
                                else {}
                            ),
                        }
                        for item in contributions
                    ]
                    + unsupported,
                    "runtime": {"entrypoints": runtime_entrypoints},
                }
            )
        return {
            "schemaVersion": CATALOG_SCHEMA_VERSION,
            "platform": {
                "enabled": True,
                "started": self._started,
                "status": "degraded" if self._load_failures else "ok",
                "registryRevision": self._registry.revision,
            },
            "plugins": plugins,
        }

    def health_summary(self) -> dict[str, Any]:
        active_records = sum(item.state == "active" for item in self._records.values())
        manager = self.manager.health_summary()
        return {
            "status": "degraded"
            if self._load_failures or manager["status"] == "degraded"
            else "ok",
            "enabled": True,
            "started": self._started,
            "installed": len(self._records),
            "activeRecords": active_records,
            "runningEntrypoints": manager["active"],
            "subscriptions": len(self.events.snapshot()["subscriptions"]),
            "jobs": len(self.jobs.snapshot()),
            "failedPlugins": len(self._load_failures),
        }

    def diagnostics(self) -> dict[str, Any]:
        entrypoints = []
        for owner in self.manager.owner_keys():
            snapshot = self.manager.supervisor(*owner).snapshot()
            failure = snapshot["lastFailure"]
            entrypoints.append(
                {
                    "pluginId": owner[0],
                    "entrypointId": owner[1],
                    "state": snapshot["state"],
                    "generation": snapshot["generation"],
                    "starts": snapshot["starts"],
                    "restarts": snapshot["restarts"],
                    "requests": snapshot["requests"],
                    "failures": snapshot["failures"],
                    "lastFailureCode": failure.get("code")
                    if isinstance(failure, dict)
                    else None,
                }
            )
        return {
            "health": self.health_summary(),
            "catalog": self.catalog(),
            "runtime": {
                "health": self.manager.health_summary(),
                "entrypoints": entrypoints,
            },
            "events": self.events.snapshot(),
            "jobs": self.jobs.snapshot(),
            "notifications": self.notifications.snapshot(),
            "market": self.market.diagnostics(),
            "loadFailures": [
                {
                    "pluginId": key,
                    "code": self._load_failures[key].get(
                        "code", "PLUGIN_CORE_LOAD_FAILED"
                    ),
                }
                for key in sorted(self._load_failures)
            ],
        }


class DisabledCorePluginPlatform:
    """Zero-state default until the v2 product root is explicitly enabled."""

    enabled = False

    async def start(self) -> None:
        return None

    async def stop(self) -> None:
        return None

    def bind_market_data(self, port: Any) -> None:
        return None

    def publish_event(self, event_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return {
            "eventId": event_id,
            "sequence": 0,
            "matchedSubscriptions": 0,
            "dropped": 0,
            "platformStarted": False,
        }

    def catalog(self) -> dict[str, Any]:
        return {
            "schemaVersion": CATALOG_SCHEMA_VERSION,
            "platform": {
                "enabled": False,
                "started": False,
                "status": "disabled",
                "registryRevision": 0,
            },
            "plugins": [],
        }

    def health_summary(self) -> dict[str, Any]:
        return {
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
