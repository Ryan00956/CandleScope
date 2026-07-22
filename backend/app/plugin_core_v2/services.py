"""Host-owned settings and notification services for core contributions."""

from __future__ import annotations

import hashlib
import secrets
import threading
from collections import deque
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from candlescope_plugin_sdk.platform_v2 import canonical_sha256, normalize_json

from app.plugin_security_v2.storage import atomic_write_json, read_json

from .contracts import CoreContribution, validate_settings_value
from .errors import CorePluginError, core_error


SETTINGS_STORE_SCHEMA_VERSION = 1
MAX_NOTIFICATION_ITEMS = 256


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


def _publisher_hash(identity: str) -> str:
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()


@dataclass(frozen=True, slots=True)
class SettingsRecord:
    plugin_id: str
    publisher_identity_hash: str
    contribution_id: str
    schema_sha256: str
    value: dict[str, Any]
    updated_at: str

    @property
    def key(self) -> tuple[str, str, str]:
        return (self.publisher_identity_hash, self.plugin_id, self.contribution_id)

    def to_wire(self) -> dict[str, Any]:
        return {
            "pluginId": self.plugin_id,
            "publisherIdentityHash": self.publisher_identity_hash,
            "contributionId": self.contribution_id,
            "schemaSha256": self.schema_sha256,
            "value": dict(self.value),
            "updatedAt": self.updated_at,
        }

    @classmethod
    def from_wire(cls, value: Any) -> "SettingsRecord":
        fields = {
            "pluginId",
            "publisherIdentityHash",
            "contributionId",
            "schemaSha256",
            "value",
            "updatedAt",
        }
        if not isinstance(value, dict) or set(value) != fields:
            raise core_error(
                "PLUGIN_SETTINGS_STORE_INVALID", "settings record shape is invalid"
            )
        if not all(
            isinstance(value[key], str) and value[key] for key in fields - {"value"}
        ) or not isinstance(value["value"], dict):
            raise core_error(
                "PLUGIN_SETTINGS_STORE_INVALID", "settings record values are invalid"
            )
        return cls(
            value["pluginId"],
            value["publisherIdentityHash"],
            value["contributionId"],
            value["schemaSha256"],
            normalize_json(value["value"], path="settings.value"),
            value["updatedAt"],
        )


class PluginSettingsStore:
    """Persist schema-validated settings without allowing publisher crossover."""

    def __init__(self, path: Path | str) -> None:
        self.path = Path(path).expanduser().resolve(strict=False)
        self._lock = threading.RLock()
        self._contracts: dict[tuple[str, str, str], CoreContribution] = {}

    def _load(self) -> tuple[int, dict[tuple[str, str, str], SettingsRecord]]:
        if not self.path.exists():
            return 0, {}
        value = read_json(self.path, "plugin settings store")
        if (
            not isinstance(value, dict)
            or set(value) != {"schemaVersion", "revision", "records"}
            or value["schemaVersion"] != SETTINGS_STORE_SCHEMA_VERSION
            or isinstance(value["revision"], bool)
            or not isinstance(value["revision"], int)
            or value["revision"] < 0
            or not isinstance(value["records"], list)
        ):
            raise core_error(
                "PLUGIN_SETTINGS_STORE_INVALID", "settings store schema is invalid"
            )
        records = tuple(SettingsRecord.from_wire(item) for item in value["records"])
        by_key = {item.key: item for item in records}
        if len(by_key) != len(records) or list(by_key) != sorted(by_key):
            raise core_error(
                "PLUGIN_SETTINGS_STORE_INVALID",
                "settings records must be sorted and unique",
            )
        return value["revision"], by_key

    def _write(
        self, revision: int, records: dict[tuple[str, str, str], SettingsRecord]
    ) -> None:
        atomic_write_json(
            self.path,
            {
                "schemaVersion": SETTINGS_STORE_SCHEMA_VERSION,
                "revision": revision,
                "records": [records[key].to_wire() for key in sorted(records)],
            },
        )

    @staticmethod
    def _key(
        plugin_id: str, publisher_identity: str, contribution_id: str
    ) -> tuple[str, str, str]:
        return (_publisher_hash(publisher_identity), plugin_id, contribution_id)

    def bind(
        self, contribution: CoreContribution, *, publisher_identity: str
    ) -> dict[str, Any]:
        if contribution.kind != "settings/1":
            raise ValueError("only settings contributions can be bound")
        schema = contribution.configuration["schema"]
        defaults = contribution.configuration["defaults"]
        schema_sha256 = canonical_sha256(schema)
        key = self._key(contribution.plugin_id, publisher_identity, contribution.id)
        with self._lock:
            revision, records = self._load()
            current = records.get(key)
            changed = False
            if current is None:
                current = SettingsRecord(
                    contribution.plugin_id,
                    key[0],
                    contribution.id,
                    schema_sha256,
                    dict(defaults),
                    _utc_now(),
                )
                records[key] = current
                changed = True
            elif current.schema_sha256 != schema_sha256:
                try:
                    validated = validate_settings_value(
                        schema,
                        current.value,
                        plugin_id=contribution.plugin_id,
                        contribution_id=contribution.id,
                    )
                except CorePluginError as exc:
                    raise core_error(
                        "PLUGIN_SETTINGS_MIGRATION_REQUIRED",
                        "existing settings do not satisfy the new schema",
                        plugin_id=contribution.plugin_id,
                        details={"contributionId": contribution.id},
                    ) from exc
                assert isinstance(validated, dict)
                current = SettingsRecord(
                    current.plugin_id,
                    current.publisher_identity_hash,
                    current.contribution_id,
                    schema_sha256,
                    validated,
                    _utc_now(),
                )
                records[key] = current
                changed = True
            self._contracts[key] = contribution
            if changed:
                revision += 1
                self._write(revision, records)
            return {
                "pluginId": contribution.plugin_id,
                "contributionId": contribution.id,
                "revision": revision,
                "schemaSha256": schema_sha256,
                "changed": changed,
            }

    def read(
        self, plugin_id: str, publisher_identity: str, contribution_id: str
    ) -> dict[str, Any]:
        key = self._key(plugin_id, publisher_identity, contribution_id)
        with self._lock:
            revision, records = self._load()
            record = records.get(key)
            if record is None or key not in self._contracts:
                raise core_error(
                    "PLUGIN_SETTINGS_NOT_FOUND",
                    "settings contribution is not bound",
                    plugin_id=plugin_id,
                )
            return {
                "pluginId": plugin_id,
                "contributionId": contribution_id,
                "value": dict(record.value),
                "schemaSha256": record.schema_sha256,
                "storeRevision": revision,
            }

    def write(
        self,
        plugin_id: str,
        publisher_identity: str,
        contribution_id: str,
        value: dict[str, Any],
    ) -> dict[str, Any]:
        key = self._key(plugin_id, publisher_identity, contribution_id)
        with self._lock:
            contribution = self._contracts.get(key)
            if contribution is None:
                raise core_error(
                    "PLUGIN_SETTINGS_NOT_FOUND",
                    "settings contribution is not bound",
                    plugin_id=plugin_id,
                )
            validated = validate_settings_value(
                contribution.configuration["schema"],
                value,
                plugin_id=plugin_id,
                contribution_id=contribution_id,
            )
            assert isinstance(validated, dict)
            revision, records = self._load()
            current = records.get(key)
            if current is None:
                raise core_error(
                    "PLUGIN_SETTINGS_NOT_FOUND", "settings record is missing"
                )
            if current.value == validated:
                return {
                    "pluginId": plugin_id,
                    "contributionId": contribution_id,
                    "value": validated,
                    "storeRevision": revision,
                    "changed": False,
                }
            records[key] = SettingsRecord(
                current.plugin_id,
                current.publisher_identity_hash,
                current.contribution_id,
                current.schema_sha256,
                validated,
                _utc_now(),
            )
            revision += 1
            self._write(revision, records)
            return {
                "pluginId": plugin_id,
                "contributionId": contribution_id,
                "value": validated,
                "storeRevision": revision,
                "changed": True,
            }

    def unbind_plugin(self, plugin_id: str) -> None:
        with self._lock:
            self._contracts = {
                key: contribution
                for key, contribution in self._contracts.items()
                if contribution.plugin_id != plugin_id
            }


@dataclass(frozen=True, slots=True)
class NotificationRecord:
    id: str
    plugin_id: str
    source_id: str
    channel: str
    severity: str
    title: str
    message: str
    created_at: str
    trace_id: str

    def to_wire(self) -> dict[str, str]:
        return {
            "id": self.id,
            "pluginId": self.plugin_id,
            "sourceId": self.source_id,
            "channel": self.channel,
            "severity": self.severity,
            "title": self.title,
            "message": self.message,
            "createdAt": self.created_at,
            "traceId": self.trace_id,
        }


class NotificationCenter:
    """Bounded Host projection; frontend delivery remains a later native adapter."""

    def __init__(self, *, maximum_items: int = MAX_NOTIFICATION_ITEMS) -> None:
        if (
            isinstance(maximum_items, bool)
            or not isinstance(maximum_items, int)
            or not 1 <= maximum_items <= 4096
        ):
            raise ValueError("notification maximum_items is invalid")
        self._items: deque[NotificationRecord] = deque(maxlen=maximum_items)
        self._lock = threading.Lock()

    def publish(
        self,
        *,
        plugin_id: str,
        source: CoreContribution,
        params: dict[str, Any],
        trace_id: str,
    ) -> dict[str, Any]:
        if source.plugin_id != plugin_id or source.kind != "notification/1":
            raise core_error(
                "PLUGIN_NOTIFICATION_SOURCE_INVALID",
                "notification source is not owned by the caller",
                plugin_id=plugin_id,
            )
        expected = {"sourceId", "channel", "severity", "title", "message"}
        if not isinstance(params, dict) or set(params) != expected:
            raise core_error(
                "PLUGIN_NOTIFICATION_INVALID",
                "notification payload shape is invalid",
                plugin_id=plugin_id,
            )
        channel = params["channel"]
        severity = params["severity"]
        title = params["title"]
        message = params["message"]
        if (
            params["sourceId"] not in {source.id, source.full_id}
            or channel not in source.configuration["channels"]
            or severity not in source.configuration["severities"]
            or not isinstance(title, str)
            or not 1 <= len(title) <= 128
            or not isinstance(message, str)
            or not 1 <= len(message) <= 1024
        ):
            raise core_error(
                "PLUGIN_NOTIFICATION_INVALID",
                "notification payload exceeds its declared source",
                plugin_id=plugin_id,
            )
        record = NotificationRecord(
            f"notification-{secrets.token_hex(16)}",
            plugin_id,
            source.full_id,
            channel,
            severity,
            title,
            message,
            _utc_now(),
            trace_id,
        )
        with self._lock:
            self._items.append(record)
        return {"accepted": True, "notificationId": record.id}

    def snapshot(self, *, plugin_id: str | None = None) -> list[dict[str, str]]:
        with self._lock:
            values = tuple(self._items)
        return [
            item.to_wire()
            for item in values
            if plugin_id is None or item.plugin_id == plugin_id
        ]
