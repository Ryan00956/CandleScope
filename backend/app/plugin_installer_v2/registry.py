"""Independent activation registry for schema-v2 platform plugins."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from candlescope_plugin_sdk.platform_v2 import PlatformContractError, loads_strict

from .errors import PlatformInstallerError


REGISTRY_SCHEMA_VERSION = 2
REGISTRY_FILE_NAME = "platform-registry-v2.json"
LEGACY_REGISTRY_FILE_NAME = "runtime-registry.json"
MAX_REGISTRY_BYTES = 4 * 1024 * 1024
ACTIVATION_STATES = frozenset({"active", "disabled", "staged"})

_SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
_ID = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$")
_HEX_ID = re.compile(r"^[0-9a-f]{64}$")


def _mapping(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise PlatformInstallerError(f"{label} must be a JSON object")
    return value


def _sequence(value: Any, label: str) -> Sequence[Any]:
    if isinstance(value, (str, bytes)) or not isinstance(value, Sequence):
        raise PlatformInstallerError(f"{label} must be a JSON array")
    return value


def _only_keys(value: Mapping[str, Any], required: set[str], label: str) -> None:
    missing = sorted(required - set(value))
    unknown = sorted(set(value) - required)
    if missing:
        raise PlatformInstallerError(f"{label} is missing fields: {', '.join(missing)}")
    if unknown:
        raise PlatformInstallerError(
            f"{label} contains unsupported fields: {', '.join(unknown)}"
        )


def _string(value: Any, label: str, *, maximum: int = 4096) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or "\0" in value
        or len(value) > maximum
    ):
        raise PlatformInstallerError(f"{label} must be a bounded non-empty string")
    return value


def _boolean(value: Any, label: str) -> bool:
    if not isinstance(value, bool):
        raise PlatformInstallerError(f"{label} must be a boolean")
    return value


@dataclass(frozen=True, slots=True)
class EntrypointActivation:
    id: str
    executable: Path
    module: str
    working_directory: Path

    def to_wire(self) -> dict[str, str]:
        return {
            "id": self.id,
            "executable": str(self.executable),
            "module": self.module,
            "workingDirectory": str(self.working_directory),
        }

    @classmethod
    def from_wire(cls, value: Any, label: str) -> "EntrypointActivation":
        data = _mapping(value, label)
        _only_keys(data, {"id", "executable", "module", "workingDirectory"}, label)
        entrypoint_id = _string(data["id"], f"{label}.id", maximum=128)
        if not _ID.fullmatch(entrypoint_id):
            raise PlatformInstallerError(f"{label}.id is invalid")
        module = _string(data["module"], f"{label}.module", maximum=256)
        executable = Path(_string(data["executable"], f"{label}.executable")).resolve(
            strict=False
        )
        working_directory = Path(
            _string(data["workingDirectory"], f"{label}.workingDirectory")
        ).resolve(strict=False)
        return cls(entrypoint_id, executable, module, working_directory)


@dataclass(frozen=True, slots=True)
class ActivationRecord:
    plugin_id: str
    name: str
    version: str
    publisher: str
    installation_id: str
    bundle_sha256: str
    manifest_sha256: str
    activation_id: str
    activated_at: str
    state: str
    enabled: bool
    restart_required: bool
    required_permissions: tuple[str, ...]
    entrypoints: tuple[EntrypointActivation, ...]

    def __post_init__(self) -> None:
        if not _ID.fullmatch(self.plugin_id):
            raise PlatformInstallerError("activation pluginId is invalid")
        if not _HEX_ID.fullmatch(self.installation_id):
            raise PlatformInstallerError("activation installationId is invalid")
        if not _ID.fullmatch(self.activation_id):
            raise PlatformInstallerError("activation activationId is invalid")
        if not _SHA256.fullmatch(self.bundle_sha256) or not _SHA256.fullmatch(
            self.manifest_sha256
        ):
            raise PlatformInstallerError("activation contains an invalid SHA-256")
        if self.state not in ACTIVATION_STATES:
            raise PlatformInstallerError("activation state is invalid")
        if (self.state == "active") != self.enabled:
            raise PlatformInstallerError(
                "activation state/enabled fields are inconsistent"
            )
        if self.state == "staged" and not self.required_permissions:
            raise PlatformInstallerError(
                "staged activation must declare required permissions"
            )
        if len(set(self.required_permissions)) != len(self.required_permissions):
            raise PlatformInstallerError(
                "activation requiredPermissions contains duplicates"
            )
        if not self.entrypoints or len({item.id for item in self.entrypoints}) != len(
            self.entrypoints
        ):
            raise PlatformInstallerError(
                "activation entrypoints must be non-empty and unique"
            )

    def to_wire(self) -> dict[str, Any]:
        return {
            "pluginId": self.plugin_id,
            "name": self.name,
            "version": self.version,
            "publisher": self.publisher,
            "installationId": self.installation_id,
            "bundleSha256": self.bundle_sha256,
            "manifestSha256": self.manifest_sha256,
            "activationId": self.activation_id,
            "activatedAt": self.activated_at,
            "state": self.state,
            "enabled": self.enabled,
            "restartRequired": self.restart_required,
            "requiredPermissions": list(self.required_permissions),
            "entrypoints": [item.to_wire() for item in self.entrypoints],
        }

    @classmethod
    def from_wire(cls, value: Any, label: str = "activation") -> "ActivationRecord":
        data = _mapping(value, label)
        fields = {
            "pluginId",
            "name",
            "version",
            "publisher",
            "installationId",
            "bundleSha256",
            "manifestSha256",
            "activationId",
            "activatedAt",
            "state",
            "enabled",
            "restartRequired",
            "requiredPermissions",
            "entrypoints",
        }
        _only_keys(data, fields, label)
        raw_permissions = tuple(
            _string(item, f"{label}.requiredPermissions[]", maximum=128)
            for item in _sequence(
                data["requiredPermissions"], f"{label}.requiredPermissions"
            )
        )
        return cls(
            plugin_id=_string(data["pluginId"], f"{label}.pluginId", maximum=128),
            name=_string(data["name"], f"{label}.name", maximum=128),
            version=_string(data["version"], f"{label}.version", maximum=64),
            publisher=_string(data["publisher"], f"{label}.publisher", maximum=128),
            installation_id=_string(
                data["installationId"], f"{label}.installationId", maximum=64
            ),
            bundle_sha256=_string(
                data["bundleSha256"], f"{label}.bundleSha256", maximum=71
            ),
            manifest_sha256=_string(
                data["manifestSha256"], f"{label}.manifestSha256", maximum=71
            ),
            activation_id=_string(
                data["activationId"], f"{label}.activationId", maximum=128
            ),
            activated_at=_string(
                data["activatedAt"], f"{label}.activatedAt", maximum=64
            ),
            state=_string(data["state"], f"{label}.state", maximum=16),
            enabled=_boolean(data["enabled"], f"{label}.enabled"),
            restart_required=_boolean(
                data["restartRequired"], f"{label}.restartRequired"
            ),
            required_permissions=raw_permissions,
            entrypoints=tuple(
                EntrypointActivation.from_wire(item, f"{label}.entrypoints[{index}]")
                for index, item in enumerate(
                    _sequence(data["entrypoints"], f"{label}.entrypoints")
                )
            ),
        )


@dataclass(frozen=True, slots=True)
class ActivationRegistry:
    revision: int = 0
    plugins: tuple[ActivationRecord, ...] = ()
    schema_version: int = REGISTRY_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != REGISTRY_SCHEMA_VERSION:
            raise PlatformInstallerError("activation registry schemaVersion must be 2")
        if (
            isinstance(self.revision, bool)
            or not isinstance(self.revision, int)
            or self.revision < 0
        ):
            raise PlatformInstallerError("activation registry revision is invalid")
        ids = [item.plugin_id for item in self.plugins]
        if len(set(ids)) != len(ids) or ids != sorted(ids):
            raise PlatformInstallerError(
                "activation registry plugins must be ID-sorted and unique"
            )

    def by_id(self) -> dict[str, ActivationRecord]:
        return {item.plugin_id: item for item in self.plugins}

    def replace(
        self, plugin_id: str, replacement: ActivationRecord | None
    ) -> "ActivationRegistry":
        by_id = self.by_id()
        if replacement is None:
            by_id.pop(plugin_id, None)
        else:
            if replacement.plugin_id != plugin_id:
                raise PlatformInstallerError("registry replacement plugin ID mismatch")
            by_id[plugin_id] = replacement
        return ActivationRegistry(
            revision=self.revision + 1,
            plugins=tuple(by_id[key] for key in sorted(by_id)),
        )

    def to_wire(self) -> dict[str, Any]:
        return {
            "schemaVersion": self.schema_version,
            "revision": self.revision,
            "plugins": [item.to_wire() for item in self.plugins],
        }

    @classmethod
    def from_wire(cls, value: Any) -> "ActivationRegistry":
        root = _mapping(value, "activation registry")
        _only_keys(
            root, {"schemaVersion", "revision", "plugins"}, "activation registry"
        )
        return cls(
            schema_version=root["schemaVersion"],
            revision=root["revision"],
            plugins=tuple(
                ActivationRecord.from_wire(
                    item, f"activation registry.plugins[{index}]"
                )
                for index, item in enumerate(
                    _sequence(root["plugins"], "activation registry.plugins")
                )
            ),
        )


def load_activation_registry(path: Path | str) -> ActivationRegistry:
    registry_path = Path(path).resolve(strict=False)
    if registry_path.name.casefold() == LEGACY_REGISTRY_FILE_NAME.casefold():
        raise PlatformInstallerError(
            "v2 activation registry must not use the legacy runtime-registry.json path"
        )
    if not registry_path.exists():
        return ActivationRegistry()
    if registry_path.is_symlink() or not registry_path.is_file():
        raise PlatformInstallerError("v2 activation registry must be a regular file")
    try:
        size = registry_path.stat().st_size
        if not 0 < size <= MAX_REGISTRY_BYTES:
            raise PlatformInstallerError("v2 activation registry has an invalid size")
        value = loads_strict(registry_path.read_bytes())
    except PlatformInstallerError:
        raise
    except (OSError, PlatformContractError) as exc:
        raise PlatformInstallerError(
            f"unable to read v2 activation registry: {exc}"
        ) from exc
    return ActivationRegistry.from_wire(value)
