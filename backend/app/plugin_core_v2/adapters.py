"""Capability Broker adapters for Phase 5 Host-owned core services."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any

from candlescope_plugin_sdk.platform_v2 import HostCallRequest

from app.plugin_security_v2.capabilities import (
    CapabilityBroker,
    CapabilityLease,
    CapabilityMethodPolicy,
)
from app.plugin_security_v2.errors import security_error

from .contracts import CoreContribution
from .errors import CorePluginError, core_error
from .private_storage import PluginPrivateStorage, StorageNamespace
from .services import NotificationCenter, PluginSettingsStore


ContributionResolver = Callable[[str, str, str], CoreContribution]


def _params(
    call: HostCallRequest,
    *,
    required: set[str],
    optional: set[str] = frozenset(),
) -> dict[str, Any]:
    value = dict(call.params)
    missing = sorted(required - set(value))
    unknown = sorted(set(value) - required - optional)
    if missing or unknown:
        raise core_error(
            "CAPABILITY_PARAMS_INVALID",
            "Host method parameters have an invalid shape",
            details={"missing": missing, "unknown": unknown},
        )
    return value


def _quota_from_lease(lease: CapabilityLease) -> int | None:
    value = lease.scope.get("maxBytes")
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise core_error("PLUGIN_STORAGE_QUOTA_INVALID", "granted maxBytes is invalid")
    return value


class CoreCapabilityAdapters:
    def __init__(
        self,
        *,
        storage: PluginPrivateStorage,
        settings: PluginSettingsStore,
        notifications: NotificationCenter,
        resolve_contribution: ContributionResolver,
    ) -> None:
        self.storage = storage
        self.settings = settings
        self.notifications = notifications
        self.resolve_contribution = resolve_contribution

    def register(self, broker: CapabilityBroker) -> None:
        storage_handlers = {
            "storage.kv.get": self._kv_get,
            "storage.kv.put": self._kv_put,
            "storage.kv.delete": self._kv_delete,
            "storage.kv.list": self._kv_list,
            "storage.document.get": self._document_get,
            "storage.document.put": self._document_put,
            "storage.document.delete": self._document_delete,
            "storage.document.list": self._document_list,
            "storage.blob.get": self._blob_get,
            "storage.blob.put": self._blob_put,
            "storage.blob.delete": self._blob_delete,
            "storage.blob.list": self._blob_list,
            "storage.snapshot.create": self._snapshot_create,
            "storage.snapshot.restore": self._snapshot_restore,
            "storage.migration.apply": self._migration_apply,
        }
        for method, handler in storage_handlers.items():
            broker.register(
                CapabilityMethodPolicy(
                    method,
                    "storage.private",
                    handler_with_lease=self._translate(handler),
                    require_user_action=method == "storage.snapshot.restore",
                    max_calls_per_minute=600,
                    max_calls_per_activation=20_000,
                )
            )
        broker.register(
            CapabilityMethodPolicy(
                "settings.plugin.read",
                "settings.plugin.read",
                handler_with_lease=self._translate(self._settings_read),
                max_calls_per_minute=120,
                max_calls_per_activation=5_000,
            )
        )
        broker.register(
            CapabilityMethodPolicy(
                "settings.plugin.write",
                "settings.plugin.write",
                handler_with_lease=self._translate(self._settings_write),
                require_user_action=True,
                max_calls_per_minute=60,
                max_calls_per_activation=1_000,
            )
        )
        broker.register(
            CapabilityMethodPolicy(
                "notifications.show",
                "notifications.show",
                handler_with_lease=self._translate(self._notification_show),
                scope_extractor=lambda value: {"channels": [value.get("channel", "")]},
                max_calls_per_minute=30,
                max_calls_per_activation=1_000,
            )
        )

    @staticmethod
    def _translate(handler):
        async def translated(
            call: HostCallRequest, lease: CapabilityLease
        ) -> dict[str, Any]:
            try:
                return await handler(call, lease)
            except CorePluginError as exc:
                raise security_error(
                    exc.code,
                    exc.message,
                    plugin_id=lease.plugin_id,
                    details=exc.details,
                ) from exc

        return translated

    @staticmethod
    def _namespace(lease: CapabilityLease) -> StorageNamespace:
        return StorageNamespace(lease.plugin_id, lease.publisher_identity)

    async def _kv_get(
        self, call: HostCallRequest, lease: CapabilityLease
    ) -> dict[str, Any]:
        value = _params(call, required={"key"})
        return await asyncio.to_thread(
            self.storage.kv_get, self._namespace(lease), value["key"]
        )

    async def _kv_put(
        self, call: HostCallRequest, lease: CapabilityLease
    ) -> dict[str, Any]:
        value = _params(call, required={"key", "value"})
        return await asyncio.to_thread(
            self.storage.kv_put,
            self._namespace(lease),
            value["key"],
            value["value"],
            quota_bytes=_quota_from_lease(lease),
        )

    async def _kv_delete(
        self, call: HostCallRequest, lease: CapabilityLease
    ) -> dict[str, Any]:
        value = _params(call, required={"key"})
        return await asyncio.to_thread(
            self.storage.kv_delete, self._namespace(lease), value["key"]
        )

    async def _list(
        self, call: HostCallRequest, lease: CapabilityLease, kind: str
    ) -> dict[str, Any]:
        value = _params(call, required=set(), optional={"after", "limit"})
        return await asyncio.to_thread(
            self.storage.list_names,
            self._namespace(lease),
            kind,
            after=value.get("after"),
            limit=value.get("limit", 100),
        )

    async def _kv_list(
        self, call: HostCallRequest, lease: CapabilityLease
    ) -> dict[str, Any]:
        return await self._list(call, lease, "kv")

    async def _document_get(
        self, call: HostCallRequest, lease: CapabilityLease
    ) -> dict[str, Any]:
        value = _params(call, required={"name"})
        return await asyncio.to_thread(
            self.storage.document_get, self._namespace(lease), value["name"]
        )

    async def _document_put(
        self, call: HostCallRequest, lease: CapabilityLease
    ) -> dict[str, Any]:
        value = _params(call, required={"name", "value"}, optional={"ifRevision"})
        return await asyncio.to_thread(
            self.storage.document_put,
            self._namespace(lease),
            value["name"],
            value["value"],
            quota_bytes=_quota_from_lease(lease),
            if_revision=value.get("ifRevision"),
        )

    async def _document_delete(
        self, call: HostCallRequest, lease: CapabilityLease
    ) -> dict[str, Any]:
        value = _params(call, required={"name"})
        return await asyncio.to_thread(
            self.storage.document_delete, self._namespace(lease), value["name"]
        )

    async def _document_list(
        self, call: HostCallRequest, lease: CapabilityLease
    ) -> dict[str, Any]:
        return await self._list(call, lease, "document")

    async def _blob_get(
        self, call: HostCallRequest, lease: CapabilityLease
    ) -> dict[str, Any]:
        value = _params(call, required={"name"})
        return await asyncio.to_thread(
            self.storage.blob_get, self._namespace(lease), value["name"]
        )

    async def _blob_put(
        self, call: HostCallRequest, lease: CapabilityLease
    ) -> dict[str, Any]:
        value = _params(call, required={"name", "base64", "mediaType"})
        return await asyncio.to_thread(
            self.storage.blob_put,
            self._namespace(lease),
            value["name"],
            value["base64"],
            value["mediaType"],
            quota_bytes=_quota_from_lease(lease),
        )

    async def _blob_delete(
        self, call: HostCallRequest, lease: CapabilityLease
    ) -> dict[str, Any]:
        value = _params(call, required={"name"})
        return await asyncio.to_thread(
            self.storage.blob_delete, self._namespace(lease), value["name"]
        )

    async def _blob_list(
        self, call: HostCallRequest, lease: CapabilityLease
    ) -> dict[str, Any]:
        return await self._list(call, lease, "blob")

    async def _snapshot_create(
        self, call: HostCallRequest, lease: CapabilityLease
    ) -> dict[str, Any]:
        value = _params(call, required={"label"})
        return await asyncio.to_thread(
            self.storage.create_snapshot,
            self._namespace(lease),
            label=value["label"],
        )

    async def _snapshot_restore(
        self, call: HostCallRequest, lease: CapabilityLease
    ) -> dict[str, Any]:
        value = _params(call, required={"snapshotId"})
        return await asyncio.to_thread(
            self.storage.restore_snapshot,
            self._namespace(lease),
            value["snapshotId"],
            quota_bytes=_quota_from_lease(lease),
        )

    async def _migration_apply(
        self, call: HostCallRequest, lease: CapabilityLease
    ) -> dict[str, Any]:
        value = _params(
            call,
            required={"expectedVersion", "targetVersion", "operations"},
        )
        return await asyncio.to_thread(
            self.storage.migrate,
            self._namespace(lease),
            expected_version=value["expectedVersion"],
            target_version=value["targetVersion"],
            operations=value["operations"],
            quota_bytes=_quota_from_lease(lease),
        )

    def _settings_contribution(
        self, lease: CapabilityLease, settings_id: Any
    ) -> CoreContribution:
        if not isinstance(settings_id, str):
            raise core_error("PLUGIN_SETTINGS_NOT_FOUND", "settingsId must be a string")
        return self.resolve_contribution(lease.plugin_id, "settings/1", settings_id)

    async def _settings_read(
        self, call: HostCallRequest, lease: CapabilityLease
    ) -> dict[str, Any]:
        value = _params(call, required={"settingsId"})
        contribution = self._settings_contribution(lease, value["settingsId"])
        return await asyncio.to_thread(
            self.settings.read,
            lease.plugin_id,
            lease.publisher_identity,
            contribution.id,
        )

    async def _settings_write(
        self, call: HostCallRequest, lease: CapabilityLease
    ) -> dict[str, Any]:
        value = _params(call, required={"settingsId", "value"})
        contribution = self._settings_contribution(lease, value["settingsId"])
        return await asyncio.to_thread(
            self.settings.write,
            lease.plugin_id,
            lease.publisher_identity,
            contribution.id,
            value["value"],
        )

    async def _notification_show(
        self, call: HostCallRequest, lease: CapabilityLease
    ) -> dict[str, Any]:
        value = _params(
            call,
            required={"sourceId", "channel", "severity", "title", "message"},
        )
        source = self.resolve_contribution(
            lease.plugin_id, "notification/1", value["sourceId"]
        )
        return self.notifications.publish(
            plugin_id=lease.plugin_id,
            source=source,
            params=value,
            trace_id=call.request_context.trace_id,
        )
