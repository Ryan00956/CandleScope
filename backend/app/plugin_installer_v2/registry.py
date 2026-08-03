"""Read-old/write-new activation registry for normalized platform plugins."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from candlescope_plugin_sdk.platform_v2 import PlatformContractError, loads_strict

from app.plugin_core_v2.runtime_providers.base import RuntimeSupplyBinding

from .errors import PlatformInstallerError


REGISTRY_SCHEMA_VERSION_V2 = 2
REGISTRY_SCHEMA_VERSION_V3 = 3
REGISTRY_SCHEMA_VERSION_V4 = 4
REGISTRY_SCHEMA_VERSION = REGISTRY_SCHEMA_VERSION_V3
REGISTRY_FILE_NAME = "platform-registry-v2.json"
LEGACY_REGISTRY_FILE_NAME = "runtime-registry.json"
MAX_REGISTRY_BYTES = 4 * 1024 * 1024
ACTIVATION_STATES = frozenset({"active", "disabled", "staged"})

_SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
_ID = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$")
_HEX_ID = re.compile(r"^[0-9a-f]{64}$")
_RUNTIME_KINDS = frozenset(
    {
        "python-module",
        "native-executable",
        "java-jar",
        "node-module",
        "wasm-component",
    }
)
_PYTHON_MODULE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$")


def _mapping(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise PlatformInstallerError(f"{label} must be a JSON object")
    return value


def _sequence(value: Any, label: str) -> Sequence[Any]:
    if isinstance(value, (str, bytes)) or not isinstance(value, Sequence):
        raise PlatformInstallerError(f"{label} must be a JSON array")
    return value


def _only_keys(
    value: Mapping[str, Any],
    required: set[str],
    label: str,
    *,
    optional: set[str] | frozenset[str] = frozenset(),
) -> None:
    missing = sorted(required - set(value))
    unknown = sorted(set(value) - required - optional)
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


def _string_tuple(value: Any, label: str) -> tuple[str, ...]:
    items = tuple(
        _string(item, f"{label}[{index}]", maximum=1024)
        for index, item in enumerate(_sequence(value, label))
    )
    if len(items) > 64 or any("\r" in item or "\n" in item for item in items):
        raise PlatformInstallerError(f"{label} is invalid")
    return items


def _absolute_path(value: Any, label: str) -> Path:
    raw = _string(value, label)
    path = Path(raw)
    if not path.is_absolute():
        raise PlatformInstallerError(f"{label} must be an absolute path")
    return path.resolve(strict=False)


def _runtime_supply_from_wire(value: Any, label: str) -> RuntimeSupplyBinding:
    try:
        return RuntimeSupplyBinding.from_wire(value, label=label)
    except ValueError as exc:
        raise PlatformInstallerError(f"{label} is invalid") from exc


@dataclass(frozen=True, slots=True)
class EntrypointActivation:
    id: str
    executable: Path
    module: str | None
    working_directory: Path
    runtime_kind: str = "python-module"
    runtime_id: str = "python-v2-compat"
    artifact_sha256: str | None = None
    artifact: Path | None = None
    arguments: tuple[str, ...] = ()
    main_class: str | None = None
    export_name: str | None = None
    wasi_profile: str | None = None
    runtime_supply: RuntimeSupplyBinding | None = None

    def __post_init__(self) -> None:
        if not _ID.fullmatch(self.id):
            raise PlatformInstallerError("activation entrypoint id is invalid")
        if self.runtime_kind not in _RUNTIME_KINDS:
            raise PlatformInstallerError("activation runtimeKind is invalid")
        if not _ID.fullmatch(self.runtime_id):
            raise PlatformInstallerError("activation runtimeId is invalid")
        if self.artifact_sha256 is not None and not _SHA256.fullmatch(
            self.artifact_sha256
        ):
            raise PlatformInstallerError("activation artifactSha256 is invalid")
        executable = Path(self.executable).resolve(strict=False)
        working_directory = Path(self.working_directory).resolve(strict=False)
        artifact = (
            Path(self.artifact).resolve(strict=False)
            if self.artifact is not None
            else None
        )
        object.__setattr__(self, "executable", executable)
        object.__setattr__(self, "working_directory", working_directory)
        object.__setattr__(self, "artifact", artifact)
        arguments = tuple(self.arguments)
        if len(arguments) > 64 or not all(
            isinstance(item, str)
            and len(item) <= 1024
            and "\0" not in item
            and "\r" not in item
            and "\n" not in item
            for item in arguments
        ):
            raise PlatformInstallerError("activation launch arguments are invalid")
        object.__setattr__(self, "arguments", arguments)
        if self.runtime_supply is not None:
            if not isinstance(self.runtime_supply, RuntimeSupplyBinding):
                raise PlatformInstallerError("activation runtimeSupply is invalid")
            expected_supply_kind = {
                "java-jar": "java",
                "node-module": "node",
                "wasm-component": "wasm",
            }.get(self.runtime_kind)
            if (
                expected_supply_kind is None
                or self.runtime_supply.runtime_kind != expected_supply_kind
                or self.runtime_supply.runtime_id != self.runtime_id
                or self.runtime_supply.executable != executable
            ):
                raise PlatformInstallerError(
                    "activation runtimeSupply does not match its launch identity"
                )
        if self.runtime_kind == "python-module":
            if (
                not isinstance(self.module, str)
                or not _PYTHON_MODULE.fullmatch(self.module)
                or any(
                    value is not None
                    for value in (
                        self.artifact,
                        self.main_class,
                        self.export_name,
                        self.wasi_profile,
                    )
                )
            ):
                raise PlatformInstallerError(
                    "python-module activation launch is invalid"
                )
        elif self.runtime_kind == "native-executable":
            if (
                self.module is not None
                or self.artifact is None
                or any(
                    value is not None
                    for value in (self.main_class, self.export_name, self.wasi_profile)
                )
            ):
                raise PlatformInstallerError(
                    "native-executable activation launch is invalid"
                )
        elif self.runtime_kind == "java-jar":
            if (
                self.module is not None
                or self.artifact is None
                or not isinstance(self.main_class, str)
                or not self.main_class
                or self.export_name is not None
                or self.wasi_profile is not None
            ):
                raise PlatformInstallerError("java-jar activation launch is invalid")
        elif self.runtime_kind == "node-module":
            if (
                self.module is not None
                or self.artifact is None
                or any(
                    value is not None
                    for value in (self.main_class, self.export_name, self.wasi_profile)
                )
            ):
                raise PlatformInstallerError("node-module activation launch is invalid")
        elif (
            self.module is not None
            or self.artifact is None
            or not isinstance(self.export_name, str)
            or not self.export_name
            or self.main_class is not None
            or not isinstance(self.wasi_profile, str)
            or not self.wasi_profile
        ):
            raise PlatformInstallerError("wasm-component activation launch is invalid")

    def to_wire(self) -> dict[str, Any]:
        if self.artifact_sha256 is None:
            raise PlatformInstallerError(
                "activation artifactSha256 must be bound before serialization"
            )
        launch: dict[str, Any] = {
            "kind": self.runtime_kind,
            "executable": str(self.executable),
            "workingDirectory": str(self.working_directory),
        }
        if self.runtime_kind == "python-module":
            launch["module"] = self.module
            if self.arguments:
                launch["interpreterArgs"] = list(self.arguments)
        else:
            launch["artifact"] = str(self.artifact)
            if self.runtime_kind == "native-executable" and self.arguments:
                launch["args"] = list(self.arguments)
            elif self.runtime_kind == "java-jar":
                launch["mainClass"] = self.main_class
                if self.arguments:
                    launch["jvmArgs"] = list(self.arguments)
            elif self.runtime_kind == "node-module" and self.arguments:
                launch["nodeArgs"] = list(self.arguments)
            elif self.runtime_kind == "wasm-component":
                launch["export"] = self.export_name
                launch["wasiProfile"] = self.wasi_profile
                if self.arguments:
                    launch["args"] = list(self.arguments)
        return {
            "id": self.id,
            "runtimeKind": self.runtime_kind,
            "runtimeId": self.runtime_id,
            "artifactSha256": self.artifact_sha256,
            "launch": launch,
            **(
                {"runtimeSupply": self.runtime_supply.to_wire()}
                if self.runtime_supply is not None
                else {}
            ),
        }

    @classmethod
    def from_legacy_wire(
        cls,
        value: Any,
        label: str,
        *,
        bundle_sha256: str,
    ) -> "EntrypointActivation":
        data = _mapping(value, label)
        _only_keys(data, {"id", "executable", "module", "workingDirectory"}, label)
        entrypoint_id = _string(data["id"], f"{label}.id", maximum=128)
        if not _ID.fullmatch(entrypoint_id):
            raise PlatformInstallerError(f"{label}.id is invalid")
        module = _string(data["module"], f"{label}.module", maximum=256)
        executable = _absolute_path(data["executable"], f"{label}.executable")
        working_directory = _absolute_path(
            data["workingDirectory"], f"{label}.workingDirectory"
        )
        return cls(
            entrypoint_id,
            executable,
            module,
            working_directory,
            artifact_sha256=bundle_sha256,
        )

    @classmethod
    def from_wire(cls, value: Any, label: str) -> "EntrypointActivation":
        data = _mapping(value, label)
        _only_keys(
            data,
            {"id", "runtimeKind", "runtimeId", "artifactSha256", "launch"},
            label,
            optional={"runtimeSupply"},
        )
        runtime_kind = _string(data["runtimeKind"], f"{label}.runtimeKind", maximum=32)
        if runtime_kind not in _RUNTIME_KINDS:
            raise PlatformInstallerError(f"{label}.runtimeKind is unsupported")
        launch_label = f"{label}.launch"
        launch = _mapping(data["launch"], launch_label)
        common = {"kind", "executable", "workingDirectory"}
        optional_args: str | None = None
        if runtime_kind == "python-module":
            required = common | {"module"}
            optional = {"interpreterArgs"}
            optional_args = "interpreterArgs"
        elif runtime_kind == "native-executable":
            required = common | {"artifact"}
            optional = {"args"}
            optional_args = "args"
        elif runtime_kind == "java-jar":
            required = common | {"artifact", "mainClass"}
            optional = {"jvmArgs"}
            optional_args = "jvmArgs"
        elif runtime_kind == "node-module":
            required = common | {"artifact"}
            optional = {"nodeArgs"}
            optional_args = "nodeArgs"
        else:
            required = common | {"artifact", "export", "wasiProfile"}
            optional = {"args"}
            optional_args = "args"
        _only_keys(launch, required, launch_label, optional=optional)
        if launch["kind"] != runtime_kind:
            raise PlatformInstallerError(
                f"{launch_label}.kind does not match runtimeKind"
            )
        return cls(
            id=_string(data["id"], f"{label}.id", maximum=128),
            executable=_absolute_path(
                launch["executable"], f"{launch_label}.executable"
            ),
            module=(
                _string(launch["module"], f"{launch_label}.module", maximum=256)
                if "module" in launch
                else None
            ),
            working_directory=_absolute_path(
                launch["workingDirectory"],
                f"{launch_label}.workingDirectory",
            ),
            runtime_kind=runtime_kind,
            runtime_id=_string(data["runtimeId"], f"{label}.runtimeId", maximum=128),
            artifact_sha256=_string(
                data["artifactSha256"],
                f"{label}.artifactSha256",
                maximum=71,
            ),
            artifact=(
                _absolute_path(launch["artifact"], f"{launch_label}.artifact")
                if "artifact" in launch
                else None
            ),
            arguments=(
                _string_tuple(
                    launch.get(optional_args, ()),
                    f"{launch_label}.{optional_args}",
                )
                if optional_args is not None
                else ()
            ),
            main_class=(
                _string(launch["mainClass"], f"{launch_label}.mainClass", maximum=256)
                if "mainClass" in launch
                else None
            ),
            export_name=(
                _string(launch["export"], f"{launch_label}.export", maximum=256)
                if "export" in launch
                else None
            ),
            wasi_profile=(
                _string(
                    launch["wasiProfile"],
                    f"{launch_label}.wasiProfile",
                    maximum=32,
                )
                if "wasiProfile" in launch
                else None
            ),
            runtime_supply=(
                _runtime_supply_from_wire(
                    data["runtimeSupply"], f"{label}.runtimeSupply"
                )
                if "runtimeSupply" in data
                else None
            ),
        )


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
    schema_version: int = REGISTRY_SCHEMA_VERSION_V3

    def __post_init__(self) -> None:
        if self.schema_version not in {
            REGISTRY_SCHEMA_VERSION_V3,
            REGISTRY_SCHEMA_VERSION_V4,
        }:
            raise PlatformInstallerError("activation schemaVersion must be 3 or 4")
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
        if len(set(self.required_permissions)) != len(self.required_permissions):
            raise PlatformInstallerError(
                "activation requiredPermissions contains duplicates"
            )
        entrypoints = tuple(
            replace(item, artifact_sha256=self.bundle_sha256)
            if item.artifact_sha256 is None
            else item
            for item in self.entrypoints
        )
        if not entrypoints or len({item.id for item in entrypoints}) != len(
            entrypoints
        ):
            raise PlatformInstallerError(
                "activation entrypoints must be non-empty and unique"
            )
        object.__setattr__(self, "entrypoints", entrypoints)
        if (
            any(item.runtime_supply is not None for item in entrypoints)
            and self.schema_version != REGISTRY_SCHEMA_VERSION_V4
        ):
            raise PlatformInstallerError(
                "managed runtime activation must use schemaVersion 4"
            )

    def to_wire(self) -> dict[str, Any]:
        return {
            "schemaVersion": self.schema_version,
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
    def from_wire(
        cls,
        value: Any,
        label: str = "activation",
        *,
        legacy: bool | None = None,
    ) -> "ActivationRecord":
        data = _mapping(value, label)
        common_fields = {
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
        is_legacy = "schemaVersion" not in data if legacy is None else legacy
        fields = common_fields if is_legacy else common_fields | {"schemaVersion"}
        _only_keys(data, fields, label)
        if is_legacy:
            if "schemaVersion" in data:
                raise PlatformInstallerError(
                    f"{label} legacy record must not declare schemaVersion"
                )
        elif data["schemaVersion"] not in {
            REGISTRY_SCHEMA_VERSION_V3,
            REGISTRY_SCHEMA_VERSION_V4,
        }:
            raise PlatformInstallerError(f"{label}.schemaVersion must be 3 or 4")
        raw_permissions = tuple(
            _string(item, f"{label}.requiredPermissions[]", maximum=128)
            for item in _sequence(
                data["requiredPermissions"], f"{label}.requiredPermissions"
            )
        )
        bundle_sha256 = _string(
            data["bundleSha256"], f"{label}.bundleSha256", maximum=71
        )
        entrypoints = tuple(
            (
                EntrypointActivation.from_legacy_wire(
                    item,
                    f"{label}.entrypoints[{index}]",
                    bundle_sha256=bundle_sha256,
                )
                if is_legacy
                else EntrypointActivation.from_wire(
                    item, f"{label}.entrypoints[{index}]"
                )
            )
            for index, item in enumerate(
                _sequence(data["entrypoints"], f"{label}.entrypoints")
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
            bundle_sha256=bundle_sha256,
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
            entrypoints=entrypoints,
            schema_version=(
                REGISTRY_SCHEMA_VERSION_V3 if is_legacy else data["schemaVersion"]
            ),
        )


@dataclass(frozen=True, slots=True)
class ActivationRegistry:
    revision: int = 0
    plugins: tuple[ActivationRecord, ...] = ()
    schema_version: int = REGISTRY_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version not in {
            REGISTRY_SCHEMA_VERSION_V3,
            REGISTRY_SCHEMA_VERSION_V4,
        }:
            raise PlatformInstallerError(
                "activation registry schemaVersion must be 3 or 4"
            )
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
        if (
            any(
                item.schema_version == REGISTRY_SCHEMA_VERSION_V4
                for item in self.plugins
            )
            and self.schema_version != REGISTRY_SCHEMA_VERSION_V4
        ):
            raise PlatformInstallerError(
                "schemaVersion 4 activation requires a schemaVersion 4 registry"
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
            schema_version=(
                REGISTRY_SCHEMA_VERSION_V4
                if self.schema_version == REGISTRY_SCHEMA_VERSION_V4
                or any(
                    item.schema_version == REGISTRY_SCHEMA_VERSION_V4
                    for item in by_id.values()
                )
                else REGISTRY_SCHEMA_VERSION_V3
            ),
        )

    def to_wire(self) -> dict[str, Any]:
        return {
            "schemaVersion": self.schema_version,
            "revision": self.revision,
            "plugins": [item.to_wire() for item in self.plugins],
        }

    def to_schema_v2_wire(self) -> dict[str, Any]:
        """Export a lossless rollback view when every launch is v2-compatible.

        This method never writes state. Callers must retain the schema-v3 source
        and perform their own atomic replacement after explicit rollback review.
        """

        plugins: list[dict[str, Any]] = []
        for record in self.plugins:
            legacy_entrypoints: list[dict[str, str]] = []
            for entrypoint in record.entrypoints:
                if (
                    entrypoint.runtime_kind != "python-module"
                    or entrypoint.runtime_id != "python-v2-compat"
                    or entrypoint.artifact_sha256 != record.bundle_sha256
                    or entrypoint.module is None
                    or entrypoint.arguments
                    or entrypoint.runtime_supply is not None
                ):
                    raise PlatformInstallerError(
                        "activation registry cannot be represented losslessly as schemaVersion 2"
                    )
                legacy_entrypoints.append(
                    {
                        "id": entrypoint.id,
                        "executable": str(entrypoint.executable),
                        "module": entrypoint.module,
                        "workingDirectory": str(entrypoint.working_directory),
                    }
                )
            wire = record.to_wire()
            wire.pop("schemaVersion")
            wire["entrypoints"] = legacy_entrypoints
            plugins.append(wire)
        return {
            "schemaVersion": REGISTRY_SCHEMA_VERSION_V2,
            "revision": self.revision,
            "plugins": plugins,
        }

    @classmethod
    def from_wire(cls, value: Any) -> "ActivationRegistry":
        root = _mapping(value, "activation registry")
        _only_keys(
            root, {"schemaVersion", "revision", "plugins"}, "activation registry"
        )
        source_version = root["schemaVersion"]
        if source_version not in {
            REGISTRY_SCHEMA_VERSION_V2,
            REGISTRY_SCHEMA_VERSION_V3,
            REGISTRY_SCHEMA_VERSION_V4,
        }:
            raise PlatformInstallerError(
                "activation registry schemaVersion must be 2, 3, or 4"
            )
        return cls(
            schema_version=(
                REGISTRY_SCHEMA_VERSION_V4
                if source_version == REGISTRY_SCHEMA_VERSION_V4
                else REGISTRY_SCHEMA_VERSION_V3
            ),
            revision=root["revision"],
            plugins=tuple(
                ActivationRecord.from_wire(
                    item,
                    f"activation registry.plugins[{index}]",
                    legacy=source_version == REGISTRY_SCHEMA_VERSION_V2,
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
