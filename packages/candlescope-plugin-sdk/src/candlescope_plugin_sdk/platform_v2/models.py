"""Dependency-free typed models for the Plugin Platform v2 public contract."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from .constants import (
    ACTIVATION_EVENTS,
    CONTROL_TRANSPORT_V1,
    FRONTEND_SURFACE_TYPES,
    HOST_API_V1,
    MANIFEST_SCHEMA_VERSION,
    PLUGIN_PROTOCOL_V2,
    PROBE_KINDS,
    RESOURCE_PROFILES,
)
from .errors import PlatformContractError, contract_error
from .json_codec import canonical_sha256, normalize_json


_LOCAL_ID_RE = re.compile(r"^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$")
_PLUGIN_ID_RE = re.compile(r"^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$")
_PERMISSION_ID_RE = re.compile(r"^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+$")
_KIND_RE = re.compile(r"^[a-z][a-z0-9-]*/[1-9][0-9]*$")
_PYTHON_MODULE_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$")
_SEMVER_RE = re.compile(
    r"^(0|[1-9][0-9]*)\."
    r"(0|[1-9][0-9]*)\."
    r"(0|[1-9][0-9]*)"
    r"(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)"
    r"(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?"
    r"(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$"
)
_SHA256_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
_TRACE_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")


def _mapping(
    value: Any,
    path: str,
    *,
    required: frozenset[str] = frozenset(),
    optional: frozenset[str] = frozenset(),
) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise contract_error(f"{path} must be an object", path=path)
    if not all(isinstance(key, str) for key in value):
        raise contract_error(f"{path} keys must be strings", path=path)
    keys = set(value)
    missing = sorted(required - keys)
    unknown = sorted(keys - required - optional)
    if missing:
        raise contract_error(
            f"{path} is missing required fields: {', '.join(missing)}",
            path=path,
        )
    if unknown:
        raise contract_error(
            f"{path} contains unknown fields: {', '.join(unknown)}",
            path=path,
        )
    return value


def _sequence(value: Any, path: str) -> Sequence[Any]:
    if isinstance(value, (str, bytes, bytearray)) or not isinstance(value, Sequence):
        raise contract_error(f"{path} must be an array", path=path)
    return value


def _string(
    value: Any,
    path: str,
    *,
    allow_empty: bool = False,
    max_length: int = 256,
) -> str:
    if not isinstance(value, str):
        raise contract_error(f"{path} must be a string", path=path)
    if not allow_empty and not value.strip():
        raise contract_error(f"{path} must not be empty", path=path)
    if len(value) > max_length:
        raise contract_error(
            f"{path} must not exceed {max_length} characters",
            path=path,
        )
    return value


def _integer(value: Any, path: str, *, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise contract_error(
            f"{path} must be an integer greater than or equal to {minimum}",
            path=path,
        )
    return value


def _local_id(value: Any, path: str) -> str:
    item = _string(value, path, max_length=64)
    if not _LOCAL_ID_RE.fullmatch(item):
        raise contract_error(f"{path} must be a lowercase local identifier", path=path)
    return item


def _plugin_id(value: Any, path: str) -> str:
    item = _string(value, path, max_length=128)
    if not _PLUGIN_ID_RE.fullmatch(item):
        raise contract_error(
            f"{path} must be a namespaced lowercase plugin identifier",
            path=path,
        )
    return item


def _permission_id(value: Any, path: str) -> str:
    item = _string(value, path, max_length=128)
    if not _PERMISSION_ID_RE.fullmatch(item):
        raise contract_error(f"{path} must be a dotted permission identifier", path=path)
    return item


def _string_tuple(
    value: Any,
    path: str,
    *,
    allow_empty: bool = True,
    max_length: int = 128,
) -> tuple[str, ...]:
    items = tuple(
        _string(item, f"{path}[{index}]", max_length=max_length)
        for index, item in enumerate(_sequence(value, path))
    )
    if not allow_empty and not items:
        raise contract_error(f"{path} must not be empty", path=path)
    if len(set(items)) != len(items):
        raise contract_error(f"{path} must not contain duplicates", path=path)
    return items


def _json_object(value: Any, path: str) -> dict[str, Any]:
    normalized = normalize_json(value, path=path)
    if not isinstance(normalized, dict):
        raise contract_error(f"{path} must be an object", path=path)
    return normalized


def _optional_string(value: Any, path: str, *, max_length: int = 256) -> str | None:
    if value is None:
        return None
    return _string(value, path, max_length=max_length)


@dataclass(frozen=True, slots=True)
class PluginIdentity:
    id: str
    name: str
    version: str
    publisher: str
    license: str
    candlescope_engine: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "id", _plugin_id(self.id, "plugin.id"))
        object.__setattr__(self, "name", _string(self.name, "plugin.name"))
        version = _string(self.version, "plugin.version", max_length=64)
        if not _SEMVER_RE.fullmatch(version):
            raise contract_error("plugin.version must be SemVer", path="plugin.version")
        object.__setattr__(self, "version", version)
        object.__setattr__(
            self,
            "publisher",
            _local_id(self.publisher, "plugin.publisher"),
        )
        object.__setattr__(
            self,
            "license",
            _string(self.license, "plugin.license", max_length=64),
        )
        object.__setattr__(
            self,
            "candlescope_engine",
            _string(
                self.candlescope_engine,
                "plugin.engines.candlescope",
                max_length=128,
            ),
        )

    def to_wire(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "version": self.version,
            "publisher": self.publisher,
            "license": self.license,
            "engines": {"candlescope": self.candlescope_engine},
        }

    def to_descriptor_wire(self) -> dict[str, str]:
        return {
            "id": self.id,
            "name": self.name,
            "version": self.version,
            "publisher": self.publisher,
        }

    @classmethod
    def from_wire(cls, value: Any) -> "PluginIdentity":
        data = _mapping(
            value,
            "plugin",
            required=frozenset({"id", "name", "version", "publisher", "license", "engines"}),
        )
        engines = _mapping(
            data["engines"],
            "plugin.engines",
            required=frozenset({"candlescope"}),
        )
        return cls(
            id=data["id"],
            name=data["name"],
            version=data["version"],
            publisher=data["publisher"],
            license=data["license"],
            candlescope_engine=engines["candlescope"],
        )


@dataclass(frozen=True, slots=True)
class BackendEntrypoint:
    id: str
    python_module: str
    resource_profile: str
    activation_events: tuple[str, ...]

    def __post_init__(self) -> None:
        object.__setattr__(self, "id", _local_id(self.id, "entrypoint.id"))
        module = _string(self.python_module, "entrypoint.pythonModule", max_length=256)
        if not _PYTHON_MODULE_RE.fullmatch(module):
            raise contract_error(
                "entrypoint.pythonModule must be an importable module name",
                path="entrypoint.pythonModule",
            )
        object.__setattr__(self, "python_module", module)
        profile = _string(self.resource_profile, "entrypoint.resourceProfile")
        if profile not in RESOURCE_PROFILES:
            raise contract_error(
                "entrypoint.resourceProfile is not supported",
                path="entrypoint.resourceProfile",
            )
        object.__setattr__(self, "resource_profile", profile)
        events = _string_tuple(
            self.activation_events,
            "entrypoint.activationEvents",
            allow_empty=False,
        )
        unknown = sorted(set(events) - ACTIVATION_EVENTS)
        if unknown:
            raise contract_error(
                "entrypoint.activationEvents contains unsupported events: " + ", ".join(unknown),
                path="entrypoint.activationEvents",
            )
        object.__setattr__(self, "activation_events", events)

    def to_wire(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "pythonModule": self.python_module,
            "resourceProfile": self.resource_profile,
            "activationEvents": list(self.activation_events),
        }

    @classmethod
    def from_wire(cls, value: Any) -> "BackendEntrypoint":
        data = _mapping(
            value,
            "entrypoint",
            required=frozenset({"id", "pythonModule", "resourceProfile", "activationEvents"}),
        )
        return cls(
            id=data["id"],
            python_module=data["pythonModule"],
            resource_profile=data["resourceProfile"],
            activation_events=_string_tuple(
                data["activationEvents"],
                "entrypoint.activationEvents",
                allow_empty=False,
            ),
        )


@dataclass(frozen=True, slots=True)
class FrontendSurface:
    id: str
    type: str
    entry: str
    slot: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "id", _local_id(self.id, "surface.id"))
        surface_type = _string(self.type, "surface.type")
        if surface_type not in FRONTEND_SURFACE_TYPES:
            raise contract_error("surface.type is not supported", path="surface.type")
        object.__setattr__(self, "type", surface_type)
        entry = _string(self.entry, "surface.entry", max_length=256)
        if entry.startswith(("/", "\\")) or ".." in entry or ":" in entry:
            raise contract_error("surface.entry must be a relative safe path", path="surface.entry")
        object.__setattr__(self, "entry", entry.replace("\\", "/"))
        object.__setattr__(self, "slot", _local_id(self.slot, "surface.slot"))

    def to_wire(self) -> dict[str, str]:
        return {"id": self.id, "type": self.type, "entry": self.entry, "slot": self.slot}

    @classmethod
    def from_wire(cls, value: Any) -> "FrontendSurface":
        data = _mapping(
            value,
            "surface",
            required=frozenset({"id", "type", "entry", "slot"}),
        )
        return cls(id=data["id"], type=data["type"], entry=data["entry"], slot=data["slot"])


@dataclass(frozen=True, slots=True)
class FrontendDefinition:
    assets_root: str
    surfaces: tuple[FrontendSurface, ...]

    def __post_init__(self) -> None:
        root = _string(self.assets_root, "frontend.assetsRoot", max_length=128)
        if root.startswith(("/", "\\")) or ".." in root or ":" in root:
            raise contract_error(
                "frontend.assetsRoot must be a relative safe path",
                path="frontend.assetsRoot",
            )
        object.__setattr__(self, "assets_root", root.replace("\\", "/"))
        surfaces = tuple(self.surfaces)
        if not all(isinstance(item, FrontendSurface) for item in surfaces):
            raise contract_error("frontend.surfaces contains invalid values")
        if len({item.id for item in surfaces}) != len(surfaces):
            raise contract_error("frontend.surfaces ids must be unique")
        object.__setattr__(self, "surfaces", surfaces)

    def to_wire(self) -> dict[str, Any]:
        return {
            "assetsRoot": self.assets_root,
            "surfaces": [item.to_wire() for item in self.surfaces],
        }

    @classmethod
    def from_wire(cls, value: Any) -> "FrontendDefinition":
        data = _mapping(
            value,
            "frontend",
            required=frozenset({"assetsRoot", "surfaces"}),
        )
        return cls(
            assets_root=data["assetsRoot"],
            surfaces=tuple(
                FrontendSurface.from_wire(item)
                for item in _sequence(data["surfaces"], "frontend.surfaces")
            ),
        )


@dataclass(frozen=True, slots=True)
class Contribution:
    id: str
    kind: str
    title: str
    entrypoint: str
    configuration: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "id", _local_id(self.id, "contribution.id"))
        kind = _string(self.kind, "contribution.kind", max_length=64)
        if not _KIND_RE.fullmatch(kind):
            raise contract_error(
                "contribution.kind must be a versioned kind such as command/1",
                path="contribution.kind",
            )
        object.__setattr__(self, "kind", kind)
        object.__setattr__(self, "title", _string(self.title, "contribution.title"))
        object.__setattr__(
            self,
            "entrypoint",
            _local_id(self.entrypoint, "contribution.entrypoint"),
        )
        object.__setattr__(
            self,
            "configuration",
            _json_object(self.configuration, "contribution.configuration"),
        )

    def to_wire(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind,
            "title": self.title,
            "entrypoint": self.entrypoint,
            "configuration": dict(self.configuration),
        }

    def descriptor(self) -> "ContributionDescriptor":
        return ContributionDescriptor(
            id=self.id,
            kind=self.kind,
            title=self.title,
            entrypoint=self.entrypoint,
        )

    @classmethod
    def from_wire(cls, value: Any) -> "Contribution":
        data = _mapping(
            value,
            "contribution",
            required=frozenset({"id", "kind", "title", "entrypoint"}),
            optional=frozenset({"configuration"}),
        )
        return cls(
            id=data["id"],
            kind=data["kind"],
            title=data["title"],
            entrypoint=data["entrypoint"],
            configuration=_json_object(
                data.get("configuration", {}),
                "contribution.configuration",
            ),
        )


@dataclass(frozen=True, slots=True)
class ContributionDescriptor:
    id: str
    kind: str
    title: str
    entrypoint: str

    def __post_init__(self) -> None:
        base = Contribution(
            id=self.id,
            kind=self.kind,
            title=self.title,
            entrypoint=self.entrypoint,
        )
        object.__setattr__(self, "id", base.id)
        object.__setattr__(self, "kind", base.kind)
        object.__setattr__(self, "title", base.title)
        object.__setattr__(self, "entrypoint", base.entrypoint)

    def to_wire(self) -> dict[str, str]:
        return {
            "id": self.id,
            "kind": self.kind,
            "title": self.title,
            "entrypoint": self.entrypoint,
        }

    @classmethod
    def from_wire(cls, value: Any) -> "ContributionDescriptor":
        data = _mapping(
            value,
            "descriptor.contribution",
            required=frozenset({"id", "kind", "title", "entrypoint"}),
        )
        return cls(**data)


@dataclass(frozen=True, slots=True)
class PermissionRequest:
    id: str
    scope: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "id", _permission_id(self.id, "permission.id"))
        object.__setattr__(self, "scope", _json_object(self.scope, "permission.scope"))

    def to_wire(self) -> dict[str, Any]:
        return {"id": self.id, "scope": dict(self.scope)}

    @classmethod
    def from_wire(cls, value: Any) -> "PermissionRequest":
        data = _mapping(
            value,
            "permission",
            required=frozenset({"id"}),
            optional=frozenset({"scope"}),
        )
        return cls(id=data["id"], scope=_json_object(data.get("scope", {}), "permission.scope"))


@dataclass(frozen=True, slots=True)
class PermissionSet:
    required: tuple[PermissionRequest, ...] = ()
    optional: tuple[PermissionRequest, ...] = ()

    def __post_init__(self) -> None:
        required = tuple(self.required)
        optional = tuple(self.optional)
        if not all(isinstance(item, PermissionRequest) for item in required + optional):
            raise contract_error("permissions contain invalid values")
        required_ids = [item.id for item in required]
        optional_ids = [item.id for item in optional]
        if len(set(required_ids)) != len(required_ids):
            raise contract_error("permissions.required ids must be unique")
        if len(set(optional_ids)) != len(optional_ids):
            raise contract_error("permissions.optional ids must be unique")
        overlap = sorted(set(required_ids) & set(optional_ids))
        if overlap:
            raise contract_error("required and optional permissions overlap: " + ", ".join(overlap))
        object.__setattr__(self, "required", required)
        object.__setattr__(self, "optional", optional)

    def to_wire(self) -> dict[str, Any]:
        return {
            "required": [item.to_wire() for item in self.required],
            "optional": [item.to_wire() for item in self.optional],
        }

    @classmethod
    def from_wire(cls, value: Any) -> "PermissionSet":
        data = _mapping(
            value,
            "permissions",
            required=frozenset({"required", "optional"}),
        )
        return cls(
            required=tuple(
                PermissionRequest.from_wire(item)
                for item in _sequence(data["required"], "permissions.required")
            ),
            optional=tuple(
                PermissionRequest.from_wire(item)
                for item in _sequence(data["optional"], "permissions.optional")
            ),
        )


@dataclass(frozen=True, slots=True)
class Probe:
    id: str
    kind: str
    sha256: str
    entrypoint: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "id", _local_id(self.id, "probe.id"))
        kind = _string(self.kind, "probe.kind")
        if kind not in PROBE_KINDS:
            raise contract_error("probe.kind is not supported", path="probe.kind")
        object.__setattr__(self, "kind", kind)
        digest = _string(self.sha256, "probe.sha256", max_length=71)
        if not _SHA256_RE.fullmatch(digest):
            raise contract_error("probe.sha256 must be lowercase SHA-256", path="probe.sha256")
        object.__setattr__(self, "sha256", digest)
        object.__setattr__(self, "entrypoint", _local_id(self.entrypoint, "probe.entrypoint"))

    def to_wire(self) -> dict[str, str]:
        return {
            "id": self.id,
            "kind": self.kind,
            "sha256": self.sha256,
            "entrypoint": self.entrypoint,
        }

    @classmethod
    def from_wire(cls, value: Any) -> "Probe":
        data = _mapping(
            value,
            "probe",
            required=frozenset({"id", "kind", "sha256", "entrypoint"}),
        )
        return cls(**data)


@dataclass(frozen=True, slots=True)
class PluginManifest:
    plugin: PluginIdentity
    backend_entrypoints: tuple[BackendEntrypoint, ...]
    contributions: tuple[Contribution, ...]
    permissions: PermissionSet
    probes: tuple[Probe, ...]
    frontend: FrontendDefinition | None = None
    schema_version: int = MANIFEST_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != MANIFEST_SCHEMA_VERSION:
            raise contract_error(
                f"schemaVersion must be {MANIFEST_SCHEMA_VERSION}",
                path="schemaVersion",
            )
        if not isinstance(self.plugin, PluginIdentity):
            raise contract_error("plugin is invalid", path="plugin")
        entrypoints = tuple(self.backend_entrypoints)
        if not entrypoints or not all(isinstance(item, BackendEntrypoint) for item in entrypoints):
            raise contract_error("backend.entrypoints must contain at least one entrypoint")
        entrypoint_ids = {item.id for item in entrypoints}
        if len(entrypoint_ids) != len(entrypoints):
            raise contract_error("backend.entrypoints ids must be unique")
        contributions = tuple(self.contributions)
        if not contributions or not all(isinstance(item, Contribution) for item in contributions):
            raise contract_error("contributions must contain at least one contribution")
        if len({item.id for item in contributions}) != len(contributions):
            raise contract_error("contribution ids must be unique")
        missing_entrypoints = sorted({item.entrypoint for item in contributions} - entrypoint_ids)
        if missing_entrypoints:
            raise contract_error(
                "contributions reference unknown entrypoints: " + ", ".join(missing_entrypoints)
            )
        if not isinstance(self.permissions, PermissionSet):
            raise contract_error("permissions are invalid")
        probes = tuple(self.probes)
        if not all(isinstance(item, Probe) for item in probes):
            raise contract_error("probes contain invalid values")
        if len({item.id for item in probes}) != len(probes):
            raise contract_error("probe ids must be unique")
        missing_probe_entrypoints = sorted({item.entrypoint for item in probes} - entrypoint_ids)
        if missing_probe_entrypoints:
            raise contract_error(
                "probes reference unknown entrypoints: " + ", ".join(missing_probe_entrypoints)
            )
        if self.frontend is not None and not isinstance(self.frontend, FrontendDefinition):
            raise contract_error("frontend is invalid")
        object.__setattr__(self, "backend_entrypoints", entrypoints)
        object.__setattr__(self, "contributions", contributions)
        object.__setattr__(self, "probes", probes)

    def to_wire(self) -> dict[str, Any]:
        return {
            "schemaVersion": self.schema_version,
            "plugin": self.plugin.to_wire(),
            "backend": {"entrypoints": [item.to_wire() for item in self.backend_entrypoints]},
            **({"frontend": self.frontend.to_wire()} if self.frontend is not None else {}),
            "contributions": [item.to_wire() for item in self.contributions],
            "permissions": self.permissions.to_wire(),
            "probes": [item.to_wire() for item in self.probes],
        }

    @classmethod
    def from_wire(cls, value: Any) -> "PluginManifest":
        data = _mapping(
            value,
            "manifest",
            required=frozenset(
                {"schemaVersion", "plugin", "backend", "contributions", "permissions", "probes"}
            ),
            optional=frozenset({"frontend"}),
        )
        backend = _mapping(
            data["backend"],
            "backend",
            required=frozenset({"entrypoints"}),
        )
        return cls(
            schema_version=_integer(data["schemaVersion"], "schemaVersion", minimum=0),
            plugin=PluginIdentity.from_wire(data["plugin"]),
            backend_entrypoints=tuple(
                BackendEntrypoint.from_wire(item)
                for item in _sequence(backend["entrypoints"], "backend.entrypoints")
            ),
            frontend=(
                FrontendDefinition.from_wire(data["frontend"]) if "frontend" in data else None
            ),
            contributions=tuple(
                Contribution.from_wire(item)
                for item in _sequence(data["contributions"], "contributions")
            ),
            permissions=PermissionSet.from_wire(data["permissions"]),
            probes=tuple(Probe.from_wire(item) for item in _sequence(data["probes"], "probes")),
        )

    @property
    def canonical_sha256(self) -> str:
        return canonical_sha256(self.to_wire())

    def validate_descriptor(self, descriptor: "RuntimeDescriptor") -> None:
        if not isinstance(descriptor, RuntimeDescriptor):
            raise contract_error("runtime descriptor is invalid")
        identity = self.plugin
        if (
            descriptor.plugin_id,
            descriptor.name,
            descriptor.version,
            descriptor.publisher,
        ) != (identity.id, identity.name, identity.version, identity.publisher):
            raise contract_error("runtime descriptor plugin identity does not match manifest")
        entrypoint_ids = {item.id for item in self.backend_entrypoints}
        if descriptor.entrypoint_id not in entrypoint_ids:
            raise contract_error("runtime descriptor references an unknown entrypoint")
        declared = {item.id: item.descriptor() for item in self.contributions}
        for item in descriptor.contributions:
            if item.id not in declared or item != declared[item.id]:
                raise contract_error(f"runtime descriptor contribution is not declared: {item.id}")
            if item.entrypoint != descriptor.entrypoint_id:
                raise contract_error(
                    f"runtime descriptor contribution belongs to another entrypoint: {item.id}"
                )
        required_ids = tuple(item.id for item in self.permissions.required)
        optional_ids = tuple(item.id for item in self.permissions.optional)
        if descriptor.required_permissions != required_ids:
            raise contract_error("runtime descriptor required permissions do not match manifest")
        if descriptor.optional_permissions != optional_ids:
            raise contract_error("runtime descriptor optional permissions do not match manifest")


@dataclass(frozen=True, slots=True)
class RuntimeDescriptor:
    plugin_id: str
    name: str
    version: str
    publisher: str
    entrypoint_id: str
    contributions: tuple[ContributionDescriptor, ...]
    required_permissions: tuple[str, ...] = ()
    optional_permissions: tuple[str, ...] = ()
    required_host_apis: tuple[str, ...] = ()
    optional_host_apis: tuple[str, ...] = ()
    features: tuple[str, ...] = ()
    protocol: str = PLUGIN_PROTOCOL_V2

    def __post_init__(self) -> None:
        object.__setattr__(self, "plugin_id", _plugin_id(self.plugin_id, "descriptor.plugin.id"))
        object.__setattr__(self, "name", _string(self.name, "descriptor.plugin.name"))
        version = _string(self.version, "descriptor.plugin.version", max_length=64)
        if not _SEMVER_RE.fullmatch(version):
            raise contract_error("descriptor.plugin.version must be SemVer")
        object.__setattr__(self, "version", version)
        object.__setattr__(
            self, "publisher", _local_id(self.publisher, "descriptor.plugin.publisher")
        )
        object.__setattr__(
            self, "entrypoint_id", _local_id(self.entrypoint_id, "descriptor.entrypointId")
        )
        contributions = tuple(self.contributions)
        if not contributions or not all(
            isinstance(item, ContributionDescriptor) for item in contributions
        ):
            raise contract_error("descriptor.contributions must not be empty")
        if len({item.id for item in contributions}) != len(contributions):
            raise contract_error("descriptor.contribution ids must be unique")
        object.__setattr__(self, "contributions", contributions)
        required_permissions = tuple(
            _permission_id(item, "descriptor.permissions.required[]")
            for item in self.required_permissions
        )
        optional_permissions = tuple(
            _permission_id(item, "descriptor.permissions.optional[]")
            for item in self.optional_permissions
        )
        if len(set(required_permissions)) != len(required_permissions):
            raise contract_error("descriptor required permissions must be unique")
        if len(set(optional_permissions)) != len(optional_permissions):
            raise contract_error("descriptor optional permissions must be unique")
        if set(required_permissions) & set(optional_permissions):
            raise contract_error("descriptor required and optional permissions overlap")
        required_apis = _string_tuple(self.required_host_apis, "descriptor.hostApis.required")
        optional_apis = _string_tuple(self.optional_host_apis, "descriptor.hostApis.optional")
        if set(required_apis) & set(optional_apis):
            raise contract_error("descriptor required and optional Host APIs overlap")
        features = _string_tuple(self.features, "descriptor.features")
        if self.protocol != PLUGIN_PROTOCOL_V2:
            raise contract_error(f"descriptor.protocol must be {PLUGIN_PROTOCOL_V2}")
        object.__setattr__(self, "required_permissions", required_permissions)
        object.__setattr__(self, "optional_permissions", optional_permissions)
        object.__setattr__(self, "required_host_apis", required_apis)
        object.__setattr__(self, "optional_host_apis", optional_apis)
        object.__setattr__(self, "features", features)

    def to_wire(self) -> dict[str, Any]:
        return {
            "protocol": self.protocol,
            "plugin": {
                "id": self.plugin_id,
                "name": self.name,
                "version": self.version,
                "publisher": self.publisher,
            },
            "entrypointId": self.entrypoint_id,
            "contributions": [item.to_wire() for item in self.contributions],
            "permissions": {
                "required": list(self.required_permissions),
                "optional": list(self.optional_permissions),
            },
            "hostApis": {
                "required": list(self.required_host_apis),
                "optional": list(self.optional_host_apis),
            },
            "features": list(self.features),
        }

    @classmethod
    def from_wire(cls, value: Any) -> "RuntimeDescriptor":
        data = _mapping(
            value,
            "descriptor",
            required=frozenset(
                {
                    "protocol",
                    "plugin",
                    "entrypointId",
                    "contributions",
                    "permissions",
                    "hostApis",
                    "features",
                }
            ),
        )
        plugin = _mapping(
            data["plugin"],
            "descriptor.plugin",
            required=frozenset({"id", "name", "version", "publisher"}),
        )
        permissions = _mapping(
            data["permissions"],
            "descriptor.permissions",
            required=frozenset({"required", "optional"}),
        )
        host_apis = _mapping(
            data["hostApis"],
            "descriptor.hostApis",
            required=frozenset({"required", "optional"}),
        )
        return cls(
            protocol=data["protocol"],
            plugin_id=plugin["id"],
            name=plugin["name"],
            version=plugin["version"],
            publisher=plugin["publisher"],
            entrypoint_id=data["entrypointId"],
            contributions=tuple(
                ContributionDescriptor.from_wire(item)
                for item in _sequence(data["contributions"], "descriptor.contributions")
            ),
            required_permissions=_string_tuple(
                permissions["required"], "descriptor.permissions.required"
            ),
            optional_permissions=_string_tuple(
                permissions["optional"], "descriptor.permissions.optional"
            ),
            required_host_apis=_string_tuple(host_apis["required"], "descriptor.hostApis.required"),
            optional_host_apis=_string_tuple(host_apis["optional"], "descriptor.hostApis.optional"),
            features=_string_tuple(data["features"], "descriptor.features"),
        )


@dataclass(frozen=True, slots=True)
class RequestContext:
    contribution_id: str
    user_action: bool
    generation: int
    trace_id: str

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "contribution_id",
            _local_id(self.contribution_id, "requestContext.contributionId"),
        )
        if not isinstance(self.user_action, bool):
            raise contract_error("requestContext.userAction must be a boolean")
        object.__setattr__(
            self,
            "generation",
            _integer(self.generation, "requestContext.generation", minimum=1),
        )
        trace_id = _string(self.trace_id, "requestContext.traceId", max_length=128)
        if not _TRACE_ID_RE.fullmatch(trace_id):
            raise contract_error("requestContext.traceId contains unsupported characters")
        object.__setattr__(self, "trace_id", trace_id)

    def to_wire(self) -> dict[str, Any]:
        return {
            "contributionId": self.contribution_id,
            "userAction": self.user_action,
            "generation": self.generation,
            "traceId": self.trace_id,
        }

    @classmethod
    def from_wire(cls, value: Any) -> "RequestContext":
        data = _mapping(
            value,
            "requestContext",
            required=frozenset({"contributionId", "userAction", "generation", "traceId"}),
        )
        return cls(
            contribution_id=data["contributionId"],
            user_action=data["userAction"],
            generation=data["generation"],
            trace_id=data["traceId"],
        )


@dataclass(frozen=True, slots=True)
class CapabilityGrant:
    handle: str
    permission_id: str
    scope: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "handle", _string(self.handle, "capability.handle", max_length=512)
        )
        object.__setattr__(
            self,
            "permission_id",
            _permission_id(self.permission_id, "capability.permissionId"),
        )
        object.__setattr__(self, "scope", _json_object(self.scope, "capability.scope"))

    def to_wire(self) -> dict[str, Any]:
        return {
            "handle": self.handle,
            "permissionId": self.permission_id,
            "scope": dict(self.scope),
        }

    @classmethod
    def from_wire(cls, value: Any) -> "CapabilityGrant":
        data = _mapping(
            value,
            "capability",
            required=frozenset({"handle", "permissionId", "scope"}),
        )
        return cls(handle=data["handle"], permission_id=data["permissionId"], scope=data["scope"])


@dataclass(frozen=True, slots=True)
class HandshakeRequest:
    protocols: tuple[str, ...]
    host_name: str
    host_version: str
    entrypoint_id: str
    host_apis: tuple[str, ...]
    transports: tuple[str, ...]

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "protocols",
            _string_tuple(self.protocols, "handshake.protocols", allow_empty=False),
        )
        object.__setattr__(self, "host_name", _string(self.host_name, "handshake.host.name"))
        object.__setattr__(
            self,
            "host_version",
            _string(self.host_version, "handshake.host.version", max_length=64),
        )
        object.__setattr__(
            self, "entrypoint_id", _local_id(self.entrypoint_id, "handshake.entrypointId")
        )
        object.__setattr__(self, "host_apis", _string_tuple(self.host_apis, "handshake.hostApis"))
        object.__setattr__(
            self,
            "transports",
            _string_tuple(self.transports, "handshake.transports", allow_empty=False),
        )

    def to_wire(self) -> dict[str, Any]:
        return {
            "protocols": list(self.protocols),
            "host": {"name": self.host_name, "version": self.host_version},
            "entrypointId": self.entrypoint_id,
            "hostApis": list(self.host_apis),
            "transports": list(self.transports),
        }

    @classmethod
    def from_wire(cls, value: Any) -> "HandshakeRequest":
        data = _mapping(
            value,
            "handshake",
            required=frozenset({"protocols", "host", "entrypointId", "hostApis", "transports"}),
        )
        host = _mapping(
            data["host"],
            "handshake.host",
            required=frozenset({"name", "version"}),
        )
        return cls(
            protocols=_string_tuple(data["protocols"], "handshake.protocols", allow_empty=False),
            host_name=host["name"],
            host_version=host["version"],
            entrypoint_id=data["entrypointId"],
            host_apis=_string_tuple(data["hostApis"], "handshake.hostApis"),
            transports=_string_tuple(data["transports"], "handshake.transports", allow_empty=False),
        )


@dataclass(frozen=True, slots=True)
class ActivationRequest:
    instance_id: str
    generation: int
    capabilities: tuple[CapabilityGrant, ...]

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "instance_id", _string(self.instance_id, "activate.instanceId", max_length=128)
        )
        object.__setattr__(
            self, "generation", _integer(self.generation, "activate.generation", minimum=1)
        )
        capabilities = tuple(self.capabilities)
        if not all(isinstance(item, CapabilityGrant) for item in capabilities):
            raise contract_error("activate.capabilities contains invalid values")
        if len({item.handle for item in capabilities}) != len(capabilities):
            raise contract_error("activate capability handles must be unique")
        if len({item.permission_id for item in capabilities}) != len(capabilities):
            raise contract_error("activate capability permissions must be unique")
        object.__setattr__(self, "capabilities", capabilities)

    def to_wire(self) -> dict[str, Any]:
        return {
            "instanceId": self.instance_id,
            "generation": self.generation,
            "capabilities": [item.to_wire() for item in self.capabilities],
        }

    @classmethod
    def from_wire(cls, value: Any) -> "ActivationRequest":
        data = _mapping(
            value,
            "activate",
            required=frozenset({"instanceId", "generation", "capabilities"}),
        )
        return cls(
            instance_id=data["instanceId"],
            generation=data["generation"],
            capabilities=tuple(
                CapabilityGrant.from_wire(item)
                for item in _sequence(data["capabilities"], "activate.capabilities")
            ),
        )


@dataclass(frozen=True, slots=True)
class InvokeRequest:
    contribution_id: str
    input: dict[str, Any]
    request_context: RequestContext

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "contribution_id", _local_id(self.contribution_id, "invoke.contributionId")
        )
        object.__setattr__(self, "input", _json_object(self.input, "invoke.input"))
        if not isinstance(self.request_context, RequestContext):
            raise contract_error("invoke.requestContext is invalid")
        if self.request_context.contribution_id != self.contribution_id:
            raise contract_error("invoke contribution does not match requestContext")

    def to_wire(self) -> dict[str, Any]:
        return {
            "contributionId": self.contribution_id,
            "input": dict(self.input),
            "requestContext": self.request_context.to_wire(),
        }

    @classmethod
    def from_wire(cls, value: Any) -> "InvokeRequest":
        data = _mapping(
            value,
            "invoke",
            required=frozenset({"contributionId", "input", "requestContext"}),
        )
        return cls(
            contribution_id=data["contributionId"],
            input=_json_object(data["input"], "invoke.input"),
            request_context=RequestContext.from_wire(data["requestContext"]),
        )


@dataclass(frozen=True, slots=True)
class HostCallRequest:
    capability_handle: str
    method: str
    params: dict[str, Any]
    request_context: RequestContext

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "capability_handle",
            _string(self.capability_handle, "host.call.capabilityHandle", max_length=512),
        )
        object.__setattr__(self, "method", _string(self.method, "host.call.method", max_length=128))
        object.__setattr__(self, "params", _json_object(self.params, "host.call.params"))
        if not isinstance(self.request_context, RequestContext):
            raise contract_error("host.call.requestContext is invalid")

    def to_wire(self) -> dict[str, Any]:
        return {
            "capabilityHandle": self.capability_handle,
            "method": self.method,
            "params": dict(self.params),
            "requestContext": self.request_context.to_wire(),
        }

    @classmethod
    def from_wire(cls, value: Any) -> "HostCallRequest":
        data = _mapping(
            value,
            "host.call",
            required=frozenset({"capabilityHandle", "method", "params", "requestContext"}),
        )
        return cls(
            capability_handle=data["capabilityHandle"],
            method=data["method"],
            params=_json_object(data["params"], "host.call.params"),
            request_context=RequestContext.from_wire(data["requestContext"]),
        )


def descriptor_from_manifest(
    manifest: PluginManifest,
    *,
    entrypoint_id: str,
    required_host_apis: tuple[str, ...] | None = None,
    optional_host_apis: tuple[str, ...] = (),
    features: tuple[str, ...] = (),
) -> RuntimeDescriptor:
    """Build the static descriptor subset for one manifest entrypoint."""

    entrypoint = _local_id(entrypoint_id, "entrypointId")
    contributions = tuple(
        item.descriptor() for item in manifest.contributions if item.entrypoint == entrypoint
    )
    if not contributions:
        raise PlatformContractError(
            "INVALID_CONTRACT",
            f"manifest has no contributions for entrypoint {entrypoint}",
        )
    has_permissions = bool(manifest.permissions.required or manifest.permissions.optional)
    if required_host_apis is None:
        required_apis = (HOST_API_V1,) if has_permissions else ()
    else:
        required_apis = required_host_apis
    descriptor = RuntimeDescriptor(
        plugin_id=manifest.plugin.id,
        name=manifest.plugin.name,
        version=manifest.plugin.version,
        publisher=manifest.plugin.publisher,
        entrypoint_id=entrypoint,
        contributions=contributions,
        required_permissions=tuple(item.id for item in manifest.permissions.required),
        optional_permissions=tuple(item.id for item in manifest.permissions.optional),
        required_host_apis=required_apis,
        optional_host_apis=optional_host_apis,
        features=features,
    )
    manifest.validate_descriptor(descriptor)
    return descriptor


def default_control_transport() -> str:
    return CONTROL_TRANSPORT_V1
