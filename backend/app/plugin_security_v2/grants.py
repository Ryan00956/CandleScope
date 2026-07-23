"""Bundle-bound permission decisions for Plugin Platform v2."""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterable

from candlescope_plugin_sdk.platform_v2 import PermissionRequest, PluginManifest

from .audit import AuditLog
from .errors import security_error
from .scope import (
    assert_grant_within_request,
    classify_scope_change,
    normalize_scope,
    scope_contains,
)
from .storage import atomic_write_json, read_json, security_lock


GRANT_STORE_SCHEMA_VERSION = 1
GRANT_STORE_FILE_NAME = "platform-grants-v2.json"
GRANT_DECISIONS = frozenset({"pending", "granted", "denied", "revoked"})
PERMISSION_KINDS = frozenset({"required", "optional"})
GRANT_SOURCES = frozenset({"cli", "management-api", "installer", "inherit"})

KNOWN_PERMISSION_IDS = frozenset(
    {
        "storage.private",
        "settings.plugin.read",
        "settings.plugin.write",
        "notifications.show",
        "chart.context.read",
        "chart.layer.publish",
        "market.symbols.read",
        "market.bars.read",
        "market.bars.subscribe",
        "market.trades.read",
        "market.order-book.read",
        "market.data.provide",
        "events.public.subscribe",
        "jobs.schedule",
        "network.connect",
        "filesystem.open-user-selected",
        "filesystem.save-user-selected",
        "http.endpoint.serve",
        "secrets.use",
        "accounts.read",
        "trade.simulate",
        "trade.submit",
        "trade.cancel",
    }
)
UNAVAILABLE_HIGH_RISK_PERMISSIONS = frozenset(
    {"secrets.use", "accounts.read", "trade.simulate", "trade.submit", "trade.cancel"}
)
PAPER_ONLY_PERMISSION_IDS = frozenset({"accounts.read", "trade.simulate"})

_SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
_PLUGIN_ID = re.compile(r"^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$")
_PERMISSION_ID = re.compile(r"^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+$")


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


def _major_version(version: str) -> int:
    try:
        major_text = version.split(".", 1)[0]
        major = int(major_text)
    except (ValueError, IndexError) as exc:
        raise security_error(
            "PLUGIN_GRANT_BINDING_INVALID",
            "plugin version does not contain a valid SemVer major",
        ) from exc
    if major < 0:
        raise security_error(
            "PLUGIN_GRANT_BINDING_INVALID",
            "plugin version major must not be negative",
        )
    return major


def manifest_publisher_identity(manifest: PluginManifest) -> str:
    """Return the explicit local identity until signed publisher keys ship."""

    return f"manifest:{manifest.plugin.publisher}"


def _permission_map(
    manifest: PluginManifest,
) -> dict[str, tuple[str, PermissionRequest]]:
    values: dict[str, tuple[str, PermissionRequest]] = {}
    for kind, requests in (
        ("required", manifest.permissions.required),
        ("optional", manifest.permissions.optional),
    ):
        for request in requests:
            if request.id not in KNOWN_PERMISSION_IDS:
                raise security_error(
                    "PLUGIN_PERMISSION_UNKNOWN",
                    "manifest requests an unknown permission",
                    plugin_id=manifest.plugin.id,
                    details={"permissionId": request.id},
                )
            values[request.id] = (kind, request)
    return values


def _require_string(value: Any, label: str, *, maximum: int = 256) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or len(value) > maximum
    ):
        raise security_error(
            "PLUGIN_GRANT_STORE_INVALID",
            f"{label} must be a bounded non-empty string",
        )
    return value


def _require_keys(value: Any, expected: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != expected:
        raise security_error(
            "PLUGIN_GRANT_STORE_INVALID",
            f"{label} schema is invalid",
        )
    return value


@dataclass(frozen=True, slots=True)
class GrantPermissionRecord:
    permission_id: str
    kind: str
    requested_scope: dict[str, Any]
    decision: str
    granted_scope: dict[str, Any] | None
    decided_at: str
    source: str
    confirmation_version: int
    inherited_from_bundle_sha256: str | None = None

    def __post_init__(self) -> None:
        if not _PERMISSION_ID.fullmatch(self.permission_id):
            raise security_error(
                "PLUGIN_GRANT_STORE_INVALID", "grant permissionId is invalid"
            )
        if self.kind not in PERMISSION_KINDS or self.decision not in GRANT_DECISIONS:
            raise security_error(
                "PLUGIN_GRANT_STORE_INVALID", "grant kind or decision is invalid"
            )
        requested = normalize_scope(self.requested_scope, path="grant.requestedScope")
        granted = (
            normalize_scope(self.granted_scope, path="grant.grantedScope")
            if self.granted_scope is not None
            else None
        )
        if (self.decision == "granted") != (granted is not None):
            raise security_error(
                "PLUGIN_GRANT_STORE_INVALID",
                "grantedScope must exist only for a granted decision",
            )
        if granted is not None:
            assert_grant_within_request(requested, granted)
        if self.source not in GRANT_SOURCES:
            raise security_error(
                "PLUGIN_GRANT_STORE_INVALID", "grant source is invalid"
            )
        if (
            isinstance(self.confirmation_version, bool)
            or not isinstance(self.confirmation_version, int)
            or self.confirmation_version < 1
        ):
            raise security_error(
                "PLUGIN_GRANT_STORE_INVALID", "confirmationVersion is invalid"
            )
        if self.inherited_from_bundle_sha256 is not None and not _SHA256.fullmatch(
            self.inherited_from_bundle_sha256
        ):
            raise security_error(
                "PLUGIN_GRANT_STORE_INVALID", "inherited bundle digest is invalid"
            )
        object.__setattr__(self, "requested_scope", requested)
        object.__setattr__(self, "granted_scope", granted)
        _require_string(self.decided_at, "grant.decidedAt", maximum=64)

    def to_wire(self) -> dict[str, Any]:
        return {
            "permissionId": self.permission_id,
            "kind": self.kind,
            "requestedScope": dict(self.requested_scope),
            "decision": self.decision,
            "grantedScope": (
                dict(self.granted_scope) if self.granted_scope is not None else None
            ),
            "decidedAt": self.decided_at,
            "source": self.source,
            "confirmationVersion": self.confirmation_version,
            "inheritedFromBundleSha256": self.inherited_from_bundle_sha256,
        }

    @classmethod
    def from_wire(cls, value: Any, label: str) -> "GrantPermissionRecord":
        data = _require_keys(
            value,
            {
                "permissionId",
                "kind",
                "requestedScope",
                "decision",
                "grantedScope",
                "decidedAt",
                "source",
                "confirmationVersion",
                "inheritedFromBundleSha256",
            },
            label,
        )
        return cls(
            permission_id=data["permissionId"],
            kind=data["kind"],
            requested_scope=data["requestedScope"],
            decision=data["decision"],
            granted_scope=data["grantedScope"],
            decided_at=data["decidedAt"],
            source=data["source"],
            confirmation_version=data["confirmationVersion"],
            inherited_from_bundle_sha256=data["inheritedFromBundleSha256"],
        )


@dataclass(frozen=True, slots=True)
class PluginGrantRecord:
    plugin_id: str
    publisher_identity: str
    major_version: int
    bundle_sha256: str
    manifest_sha256: str
    updated_at: str
    permissions: tuple[GrantPermissionRecord, ...]

    def __post_init__(self) -> None:
        if not _PLUGIN_ID.fullmatch(self.plugin_id):
            raise security_error(
                "PLUGIN_GRANT_STORE_INVALID", "grant pluginId is invalid"
            )
        _require_string(self.publisher_identity, "grant.publisherIdentity")
        if (
            isinstance(self.major_version, bool)
            or not isinstance(self.major_version, int)
            or self.major_version < 0
        ):
            raise security_error(
                "PLUGIN_GRANT_STORE_INVALID", "grant majorVersion is invalid"
            )
        if not _SHA256.fullmatch(self.bundle_sha256) or not _SHA256.fullmatch(
            self.manifest_sha256
        ):
            raise security_error(
                "PLUGIN_GRANT_STORE_INVALID", "grant digest binding is invalid"
            )
        _require_string(self.updated_at, "grant.updatedAt", maximum=64)
        permissions = tuple(self.permissions)
        ids = [item.permission_id for item in permissions]
        if ids != sorted(ids) or len(ids) != len(set(ids)):
            raise security_error(
                "PLUGIN_GRANT_STORE_INVALID",
                "grant permissions must be ID-sorted and unique",
            )
        object.__setattr__(self, "permissions", permissions)

    def by_id(self) -> dict[str, GrantPermissionRecord]:
        return {item.permission_id: item for item in self.permissions}

    def to_wire(self) -> dict[str, Any]:
        return {
            "pluginId": self.plugin_id,
            "publisherIdentity": self.publisher_identity,
            "majorVersion": self.major_version,
            "bundleSha256": self.bundle_sha256,
            "manifestSha256": self.manifest_sha256,
            "updatedAt": self.updated_at,
            "permissions": [item.to_wire() for item in self.permissions],
        }

    @classmethod
    def from_wire(cls, value: Any, label: str) -> "PluginGrantRecord":
        data = _require_keys(
            value,
            {
                "pluginId",
                "publisherIdentity",
                "majorVersion",
                "bundleSha256",
                "manifestSha256",
                "updatedAt",
                "permissions",
            },
            label,
        )
        if not isinstance(data["permissions"], list):
            raise security_error(
                "PLUGIN_GRANT_STORE_INVALID", f"{label}.permissions must be an array"
            )
        return cls(
            plugin_id=data["pluginId"],
            publisher_identity=data["publisherIdentity"],
            major_version=data["majorVersion"],
            bundle_sha256=data["bundleSha256"],
            manifest_sha256=data["manifestSha256"],
            updated_at=data["updatedAt"],
            permissions=tuple(
                GrantPermissionRecord.from_wire(item, f"{label}.permissions[{index}]")
                for index, item in enumerate(data["permissions"])
            ),
        )


@dataclass(frozen=True, slots=True)
class GrantDocument:
    revision: int = 0
    plugins: tuple[PluginGrantRecord, ...] = ()
    schema_version: int = GRANT_STORE_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != GRANT_STORE_SCHEMA_VERSION:
            raise security_error(
                "PLUGIN_GRANT_STORE_INVALID", "grant schemaVersion must be 1"
            )
        if (
            isinstance(self.revision, bool)
            or not isinstance(self.revision, int)
            or self.revision < 0
        ):
            raise security_error(
                "PLUGIN_GRANT_STORE_INVALID", "grant revision is invalid"
            )
        plugins = tuple(self.plugins)
        ids = [item.plugin_id for item in plugins]
        if ids != sorted(ids) or len(ids) != len(set(ids)):
            raise security_error(
                "PLUGIN_GRANT_STORE_INVALID",
                "grant plugins must be ID-sorted and unique",
            )
        object.__setattr__(self, "plugins", plugins)

    def by_id(self) -> dict[str, PluginGrantRecord]:
        return {item.plugin_id: item for item in self.plugins}

    def replace(self, record: PluginGrantRecord) -> "GrantDocument":
        values = self.by_id()
        values[record.plugin_id] = record
        return GrantDocument(
            revision=self.revision + 1,
            plugins=tuple(values[key] for key in sorted(values)),
        )

    def to_wire(self) -> dict[str, Any]:
        return {
            "schemaVersion": self.schema_version,
            "revision": self.revision,
            "plugins": [item.to_wire() for item in self.plugins],
        }

    @classmethod
    def from_wire(cls, value: Any) -> "GrantDocument":
        data = _require_keys(
            value, {"schemaVersion", "revision", "plugins"}, "grant store"
        )
        if not isinstance(data["plugins"], list):
            raise security_error(
                "PLUGIN_GRANT_STORE_INVALID", "grant store plugins must be an array"
            )
        return cls(
            schema_version=data["schemaVersion"],
            revision=data["revision"],
            plugins=tuple(
                PluginGrantRecord.from_wire(item, f"grant store.plugins[{index}]")
                for index, item in enumerate(data["plugins"])
            ),
        )


@dataclass(frozen=True, slots=True)
class PermissionDiffItem:
    permission_id: str
    kind: str | None
    previous_kind: str | None
    change: str
    previous_decision: str | None
    requested_scope: dict[str, Any] | None
    previous_scope: dict[str, Any] | None
    requires_confirmation: bool

    def to_wire(self) -> dict[str, Any]:
        return {
            "permissionId": self.permission_id,
            "kind": self.kind,
            "previousKind": self.previous_kind,
            "change": self.change,
            "previousDecision": self.previous_decision,
            "requestedScope": self.requested_scope,
            "previousScope": self.previous_scope,
            "requiresConfirmation": self.requires_confirmation,
        }


@dataclass(frozen=True, slots=True)
class PermissionDiff:
    plugin_id: str
    publisher_identity_changed: bool
    major_version_changed: bool
    bundle_changed: bool
    items: tuple[PermissionDiffItem, ...]

    @property
    def requires_confirmation(self) -> bool:
        return any(item.requires_confirmation for item in self.items)

    def to_wire(self) -> dict[str, Any]:
        return {
            "pluginId": self.plugin_id,
            "publisherIdentityChanged": self.publisher_identity_changed,
            "majorVersionChanged": self.major_version_changed,
            "bundleChanged": self.bundle_changed,
            "requiresConfirmation": self.requires_confirmation,
            "permissions": [item.to_wire() for item in self.items],
        }


@dataclass(frozen=True, slots=True)
class EffectiveGrant:
    plugin_id: str
    permission_id: str
    kind: str
    scope: dict[str, Any]
    store_revision: int
    bundle_sha256: str
    publisher_identity: str
    confirmation_version: int

    def to_wire(self) -> dict[str, Any]:
        return {
            "pluginId": self.plugin_id,
            "permissionId": self.permission_id,
            "kind": self.kind,
            "scope": dict(self.scope),
            "storeRevision": self.store_revision,
            "bundleSha256": self.bundle_sha256,
            "publisherIdentity": self.publisher_identity,
            "confirmationVersion": self.confirmation_version,
        }


@dataclass(frozen=True, slots=True)
class GrantMutationResult:
    plugin_id: str
    permission_id: str | None
    decision: str | None
    changed: bool
    store_revision: int
    required_satisfied: bool
    audit_event_id: str | None

    def to_wire(self) -> dict[str, Any]:
        return {
            "pluginId": self.plugin_id,
            "permissionId": self.permission_id,
            "decision": self.decision,
            "changed": self.changed,
            "storeRevision": self.store_revision,
            "requiredSatisfied": self.required_satisfied,
            "auditEventId": self.audit_event_id,
        }


class GrantStore:
    def __init__(
        self,
        path: Path | str,
        *,
        audit_log: AuditLog,
        lock_timeout_seconds: float = 10.0,
        available_restricted_permissions: Iterable[str] = (),
    ) -> None:
        self.path = Path(path).resolve(strict=False)
        if self.path.name.casefold() != GRANT_STORE_FILE_NAME.casefold():
            raise security_error(
                "PLUGIN_GRANT_PATH_INVALID",
                f"Grant Store must use the dedicated {GRANT_STORE_FILE_NAME} filename",
            )
        self.lock_path = self.path.parent / "platform-grants-v2.lock"
        self.audit_log = audit_log
        self.lock_timeout_seconds = lock_timeout_seconds
        available = frozenset(available_restricted_permissions)
        if not available <= PAPER_ONLY_PERMISSION_IDS:
            raise security_error(
                "PLUGIN_PERMISSION_POLICY_INVALID",
                "only Phase 11A paper permissions may be selectively enabled",
            )
        self.available_restricted_permissions = available

    def load(self) -> GrantDocument:
        if not self.path.exists():
            return GrantDocument()
        return GrantDocument.from_wire(read_json(self.path, "Grant Store"))

    @staticmethod
    def _binding(
        manifest: PluginManifest,
        bundle_sha256: str,
        manifest_sha256: str,
        publisher_identity: str | None,
    ) -> tuple[str, int, str, str]:
        if not _SHA256.fullmatch(bundle_sha256) or not _SHA256.fullmatch(
            manifest_sha256
        ):
            raise security_error(
                "PLUGIN_GRANT_BINDING_INVALID",
                "grant binding requires lowercase prefixed SHA-256 values",
                plugin_id=manifest.plugin.id,
            )
        identity = publisher_identity or manifest_publisher_identity(manifest)
        _require_string(identity, "publisherIdentity")
        return (
            identity,
            _major_version(manifest.plugin.version),
            bundle_sha256,
            manifest_sha256,
        )

    def permission_diff(
        self,
        manifest: PluginManifest,
        *,
        bundle_sha256: str,
        manifest_sha256: str,
        publisher_identity: str | None = None,
    ) -> PermissionDiff:
        document = self.load()
        return self._permission_diff(
            document,
            manifest,
            bundle_sha256=bundle_sha256,
            manifest_sha256=manifest_sha256,
            publisher_identity=publisher_identity,
        )

    def _permission_diff(
        self,
        document: GrantDocument,
        manifest: PluginManifest,
        *,
        bundle_sha256: str,
        manifest_sha256: str,
        publisher_identity: str | None,
    ) -> PermissionDiff:
        identity, major, digest, _ = self._binding(
            manifest, bundle_sha256, manifest_sha256, publisher_identity
        )
        current = _permission_map(manifest)
        previous = document.by_id().get(manifest.plugin.id)
        identity_changed = (
            previous is not None and previous.publisher_identity != identity
        )
        major_changed = previous is not None and previous.major_version != major
        previous_permissions = previous.by_id() if previous is not None else {}
        items: list[PermissionDiffItem] = []
        for permission_id in sorted(set(current) | set(previous_permissions)):
            current_value = current.get(permission_id)
            old = previous_permissions.get(permission_id)
            if current_value is None:
                assert old is not None
                items.append(
                    PermissionDiffItem(
                        permission_id,
                        None,
                        old.kind,
                        "removed",
                        old.decision,
                        None,
                        dict(old.requested_scope),
                        False,
                    )
                )
                continue
            kind, request = current_value
            if old is None:
                change = "added"
                requires = True
            elif identity_changed or major_changed:
                change = "identity-changed"
                requires = True
            elif old.kind != kind:
                change = "kind-changed"
                requires = old.kind == "optional" and kind == "required"
            else:
                change = classify_scope_change(old.requested_scope, request.scope)
                requires = change in {"expanded", "changed"}
            items.append(
                PermissionDiffItem(
                    permission_id,
                    kind,
                    old.kind if old is not None else None,
                    change,
                    old.decision if old is not None else None,
                    dict(request.scope),
                    dict(old.requested_scope) if old is not None else None,
                    requires,
                )
            )
        return PermissionDiff(
            manifest.plugin.id,
            identity_changed,
            major_changed,
            previous is None or previous.bundle_sha256 != digest,
            tuple(items),
        )

    def _permission_available(self, permission_id: str) -> bool:
        return (
            permission_id not in UNAVAILABLE_HIGH_RISK_PERMISSIONS
            or permission_id in self.available_restricted_permissions
        )

    def _required_satisfied(self, record: PluginGrantRecord) -> bool:
        return all(
            self._permission_available(item.permission_id)
            and item.decision == "granted"
            and item.granted_scope is not None
            and scope_contains(item.granted_scope, item.requested_scope)
            for item in record.permissions
            if item.kind == "required"
        )

    @staticmethod
    def _record_matches_manifest(
        record: PluginGrantRecord,
        manifest: PluginManifest,
        *,
        identity: str,
        major: int,
        bundle_sha256: str,
        manifest_sha256: str,
    ) -> bool:
        if (
            record.publisher_identity != identity
            or record.major_version != major
            or record.bundle_sha256 != bundle_sha256
            or record.manifest_sha256 != manifest_sha256
        ):
            return False
        requested = _permission_map(manifest)
        if set(requested) != set(record.by_id()):
            return False
        return all(
            item.kind == requested[item.permission_id][0]
            and item.requested_scope == requested[item.permission_id][1].scope
            for item in record.permissions
        )

    def _reconciled_record(
        self,
        previous: PluginGrantRecord | None,
        manifest: PluginManifest,
        *,
        identity: str,
        major: int,
        bundle_sha256: str,
        manifest_sha256: str,
    ) -> PluginGrantRecord:
        previous_permissions = previous.by_id() if previous is not None else {}
        same_identity = (
            previous is not None
            and previous.publisher_identity == identity
            and previous.major_version == major
        )
        now = _utc_now()
        permissions: list[GrantPermissionRecord] = []
        for permission_id, (kind, request) in sorted(_permission_map(manifest).items()):
            old = previous_permissions.get(permission_id) if same_identity else None
            inherited = False
            decision = "pending"
            granted_scope: dict[str, Any] | None = None
            source = "installer"
            inherited_from: str | None = None
            confirmation_version = 1
            if old is not None:
                change = classify_scope_change(old.requested_scope, request.scope)
                kind_expanded = old.kind == "optional" and kind == "required"
                safe_change = change in {"unchanged", "narrowed"} and not kind_expanded
                if (
                    safe_change
                    and old.decision == "granted"
                    and old.granted_scope is not None
                ):
                    if scope_contains(old.granted_scope, request.scope):
                        decision = "granted"
                        granted_scope = dict(request.scope)
                        inherited = True
                elif safe_change and old.decision in {"denied", "revoked"}:
                    decision = old.decision
                    inherited = True
                if inherited:
                    source = "inherit"
                    inherited_from = (
                        previous.bundle_sha256 if previous is not None else None
                    )
                    confirmation_version = old.confirmation_version
            permissions.append(
                GrantPermissionRecord(
                    permission_id,
                    kind,
                    dict(request.scope),
                    decision,
                    granted_scope,
                    now,
                    source,
                    confirmation_version,
                    inherited_from,
                )
            )
        return PluginGrantRecord(
            manifest.plugin.id,
            identity,
            major,
            bundle_sha256,
            manifest_sha256,
            now,
            tuple(permissions),
        )

    def reconcile(
        self,
        manifest: PluginManifest,
        *,
        bundle_sha256: str,
        manifest_sha256: str,
        publisher_identity: str | None = None,
        trace_id: str | None = None,
    ) -> GrantMutationResult:
        identity, major, digest, manifest_digest = self._binding(
            manifest, bundle_sha256, manifest_sha256, publisher_identity
        )
        trace = trace_id or f"grant-reconcile-{uuid.uuid4().hex}"
        with security_lock(self.lock_path, self.lock_timeout_seconds):
            document = self.load()
            previous = document.by_id().get(manifest.plugin.id)
            if previous is not None and self._record_matches_manifest(
                previous,
                manifest,
                identity=identity,
                major=major,
                bundle_sha256=digest,
                manifest_sha256=manifest_digest,
            ):
                return GrantMutationResult(
                    manifest.plugin.id,
                    None,
                    None,
                    False,
                    document.revision,
                    self._required_satisfied(previous),
                    None,
                )
            diff = self._permission_diff(
                document,
                manifest,
                bundle_sha256=digest,
                manifest_sha256=manifest_digest,
                publisher_identity=identity,
            )
            record = self._reconciled_record(
                previous,
                manifest,
                identity=identity,
                major=major,
                bundle_sha256=digest,
                manifest_sha256=manifest_digest,
            )
            updated = document.replace(record)
            event = self.audit_log.append(
                category="permission",
                action="reconcile",
                outcome="recorded",
                trace_id=trace,
                plugin_id=manifest.plugin.id,
                data={
                    "fromRevision": document.revision,
                    "toRevision": updated.revision,
                    "bundleSha256": digest,
                    "manifestSha256": manifest_digest,
                    "permissionDiff": diff.to_wire(),
                },
            )
            atomic_write_json(self.path, updated.to_wire())
            return GrantMutationResult(
                manifest.plugin.id,
                None,
                None,
                True,
                updated.revision,
                self._required_satisfied(record),
                event.event_id,
            )

    def _mutate_permission(
        self,
        manifest: PluginManifest,
        *,
        bundle_sha256: str,
        manifest_sha256: str,
        permission_id: str,
        decision: str,
        granted_scope: dict[str, Any] | None,
        source: str,
        publisher_identity: str | None,
        trace_id: str | None,
    ) -> GrantMutationResult:
        if decision not in {"granted", "denied", "revoked"}:
            raise security_error(
                "PLUGIN_PERMISSION_DECISION_INVALID", "decision is invalid"
            )
        if source not in {"cli", "management-api"}:
            raise security_error(
                "PLUGIN_PERMISSION_SOURCE_INVALID", "source is invalid"
            )
        if (
            permission_id in UNAVAILABLE_HIGH_RISK_PERMISSIONS
            and permission_id not in self.available_restricted_permissions
            and decision == "granted"
        ):
            raise security_error(
                "PLUGIN_PERMISSION_NOT_AVAILABLE",
                "credential, account, and trading permissions remain unavailable before signed-publisher and trading phases",
                plugin_id=manifest.plugin.id,
                details={"permissionId": permission_id},
            )
        identity, major, digest, manifest_digest = self._binding(
            manifest, bundle_sha256, manifest_sha256, publisher_identity
        )
        requests = _permission_map(manifest)
        requested = requests.get(permission_id)
        if requested is None:
            raise security_error(
                "PLUGIN_PERMISSION_NOT_DECLARED",
                "permission is not declared by the immutable manifest",
                plugin_id=manifest.plugin.id,
                details={"permissionId": permission_id},
            )
        trace = trace_id or f"grant-{uuid.uuid4().hex}"
        with security_lock(self.lock_path, self.lock_timeout_seconds):
            document = self.load()
            previous = document.by_id().get(manifest.plugin.id)
            if previous is None or not self._record_matches_manifest(
                previous,
                manifest,
                identity=identity,
                major=major,
                bundle_sha256=digest,
                manifest_sha256=manifest_digest,
            ):
                previous = self._reconciled_record(
                    previous,
                    manifest,
                    identity=identity,
                    major=major,
                    bundle_sha256=digest,
                    manifest_sha256=manifest_digest,
                )
                document = document.replace(previous)
            current = previous.by_id()[permission_id]
            scope = None
            if decision == "granted":
                scope = normalize_scope(
                    granted_scope if granted_scope is not None else requested[1].scope,
                    path="grant.scope",
                )
                assert_grant_within_request(requested[1].scope, scope)
            replacement = replace(
                current,
                decision=decision,
                granted_scope=scope,
                decided_at=_utc_now(),
                source=source,
                confirmation_version=current.confirmation_version + 1,
                inherited_from_bundle_sha256=None,
            )
            if replacement == current:
                return GrantMutationResult(
                    manifest.plugin.id,
                    permission_id,
                    decision,
                    False,
                    document.revision,
                    self._required_satisfied(previous),
                    None,
                )
            values = previous.by_id()
            values[permission_id] = replacement
            updated_record = replace(
                previous,
                updated_at=_utc_now(),
                permissions=tuple(values[key] for key in sorted(values)),
            )
            updated = document.replace(updated_record)
            event = self.audit_log.append(
                category="permission",
                action=decision,
                outcome="recorded",
                trace_id=trace,
                plugin_id=manifest.plugin.id,
                data={
                    "permissionId": permission_id,
                    "kind": replacement.kind,
                    "requestedScope": replacement.requested_scope,
                    "grantedScope": replacement.granted_scope,
                    "fromDecision": current.decision,
                    "toDecision": decision,
                    "fromRevision": document.revision,
                    "toRevision": updated.revision,
                    "bundleSha256": digest,
                },
            )
            atomic_write_json(self.path, updated.to_wire())
            return GrantMutationResult(
                manifest.plugin.id,
                permission_id,
                decision,
                True,
                updated.revision,
                self._required_satisfied(updated_record),
                event.event_id,
            )

    def grant(
        self,
        manifest: PluginManifest,
        *,
        bundle_sha256: str,
        manifest_sha256: str,
        permission_id: str,
        scope: dict[str, Any] | None = None,
        source: str = "cli",
        publisher_identity: str | None = None,
        trace_id: str | None = None,
    ) -> GrantMutationResult:
        return self._mutate_permission(
            manifest,
            bundle_sha256=bundle_sha256,
            manifest_sha256=manifest_sha256,
            permission_id=permission_id,
            decision="granted",
            granted_scope=scope,
            source=source,
            publisher_identity=publisher_identity,
            trace_id=trace_id,
        )

    def deny(
        self,
        manifest: PluginManifest,
        *,
        bundle_sha256: str,
        manifest_sha256: str,
        permission_id: str,
        source: str = "cli",
        publisher_identity: str | None = None,
        trace_id: str | None = None,
    ) -> GrantMutationResult:
        return self._mutate_permission(
            manifest,
            bundle_sha256=bundle_sha256,
            manifest_sha256=manifest_sha256,
            permission_id=permission_id,
            decision="denied",
            granted_scope=None,
            source=source,
            publisher_identity=publisher_identity,
            trace_id=trace_id,
        )

    def revoke(
        self,
        manifest: PluginManifest,
        *,
        bundle_sha256: str,
        manifest_sha256: str,
        permission_id: str,
        source: str = "cli",
        publisher_identity: str | None = None,
        trace_id: str | None = None,
    ) -> GrantMutationResult:
        return self._mutate_permission(
            manifest,
            bundle_sha256=bundle_sha256,
            manifest_sha256=manifest_sha256,
            permission_id=permission_id,
            decision="revoked",
            granted_scope=None,
            source=source,
            publisher_identity=publisher_identity,
            trace_id=trace_id,
        )

    def effective_grants(
        self,
        manifest: PluginManifest,
        *,
        bundle_sha256: str,
        manifest_sha256: str,
        publisher_identity: str | None = None,
    ) -> tuple[EffectiveGrant, ...]:
        identity, major, digest, manifest_digest = self._binding(
            manifest, bundle_sha256, manifest_sha256, publisher_identity
        )
        document = self.load()
        record = document.by_id().get(manifest.plugin.id)
        if record is None or not self._record_matches_manifest(
            record,
            manifest,
            identity=identity,
            major=major,
            bundle_sha256=digest,
            manifest_sha256=manifest_digest,
        ):
            return ()
        return tuple(
            EffectiveGrant(
                manifest.plugin.id,
                item.permission_id,
                item.kind,
                dict(item.granted_scope),
                document.revision,
                record.bundle_sha256,
                record.publisher_identity,
                item.confirmation_version,
            )
            for item in record.permissions
            if item.decision == "granted"
            and item.granted_scope is not None
            and self._permission_available(item.permission_id)
        )

    def required_satisfied(
        self,
        manifest: PluginManifest,
        *,
        bundle_sha256: str,
        manifest_sha256: str,
        publisher_identity: str | None = None,
    ) -> bool:
        identity, major, digest, manifest_digest = self._binding(
            manifest, bundle_sha256, manifest_sha256, publisher_identity
        )
        record = self.load().by_id().get(manifest.plugin.id)
        return bool(
            record is not None
            and self._record_matches_manifest(
                record,
                manifest,
                identity=identity,
                major=major,
                bundle_sha256=digest,
                manifest_sha256=manifest_digest,
            )
            and self._required_satisfied(record)
        )

    def activation_ready(
        self,
        manifest: PluginManifest,
        *,
        bundle_sha256: str,
        manifest_sha256: str,
        publisher_identity: str | None = None,
    ) -> bool:
        """Return true only after every prompt is resolved and required scope is full."""

        identity, major, digest, manifest_digest = self._binding(
            manifest, bundle_sha256, manifest_sha256, publisher_identity
        )
        record = self.load().by_id().get(manifest.plugin.id)
        return bool(
            record is not None
            and self._record_matches_manifest(
                record,
                manifest,
                identity=identity,
                major=major,
                bundle_sha256=digest,
                manifest_sha256=manifest_digest,
            )
            and self._required_satisfied(record)
            and all(item.decision != "pending" for item in record.permissions)
        )

    def is_effective_binding(
        self,
        *,
        plugin_id: str,
        permission_id: str,
        scope: dict[str, Any],
        bundle_sha256: str,
        publisher_identity: str,
        confirmation_version: int,
    ) -> bool:
        record = self.load().by_id().get(plugin_id)
        if (
            record is None
            or record.bundle_sha256 != bundle_sha256
            or record.publisher_identity != publisher_identity
        ):
            return False
        permission = record.by_id().get(permission_id)
        return bool(
            permission is not None
            and self._permission_available(permission_id)
            and permission.decision == "granted"
            and permission.granted_scope
            == normalize_scope(scope, path="capability.scope")
            and permission.confirmation_version == confirmation_version
        )

    def summary(self, plugin_id: str | None = None) -> tuple[dict[str, Any], ...]:
        document = self.load()
        records = (
            tuple(item for item in document.plugins if item.plugin_id == plugin_id)
            if plugin_id is not None
            else document.plugins
        )
        return tuple(
            {
                "pluginId": item.plugin_id,
                "publisherIdentity": item.publisher_identity,
                "majorVersion": item.major_version,
                "bundleSha256": item.bundle_sha256,
                "manifestSha256": item.manifest_sha256,
                "updatedAt": item.updated_at,
                "requiredSatisfied": self._required_satisfied(item),
                "activationReady": self._required_satisfied(item)
                and all(
                    permission.decision != "pending" for permission in item.permissions
                ),
                "permissions": [
                    permission.to_wire() for permission in item.permissions
                ],
                "storeRevision": document.revision,
            }
            for item in records
        )
