"""Language-neutral contracts for Plugin Platform Runtime Providers."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Protocol
from urllib.parse import urlsplit


RUNTIME_PROVIDER_API_VERSION = 1
_KIND = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
_LOCAL_ID = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$")
_VERSION = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")
_SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
_SUPPLY_KINDS = frozenset({"java", "node", "wasm"})
_SUPPLY_SOURCES = frozenset({"host-managed", "system"})
_SUPPLY_PROVIDER_KINDS = {
    "java-jar": "java",
    "node-module": "node",
    "wasm-component": "wasm",
}
_MAX_RUNTIME_ARTIFACT_BYTES = 1024 * 1024 * 1024


class RuntimeProviderError(RuntimeError):
    """Stable fail-closed error emitted before a runtime is launched."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        details: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = dict(details or {})

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "message": self.message,
            **({"details": dict(self.details)} if self.details else {}),
        }


class InstallCommandRunner(Protocol):
    def __call__(
        self,
        command: Sequence[str],
        *,
        label: str,
        timeout_seconds: float,
        cwd: Path | None = None,
    ) -> bytes: ...


@dataclass(frozen=True, slots=True)
class RuntimeArtifact:
    relative_path: str
    path: Path
    role: str
    sha256: str
    size: int
    operating_systems: tuple[str, ...]
    architectures: tuple[str, ...]

    def __post_init__(self) -> None:
        relative = PurePosixPath(self.relative_path)
        if (
            not self.relative_path
            or relative.is_absolute()
            or ".." in relative.parts
            or relative.as_posix() != self.relative_path
        ):
            raise ValueError("runtime artifact relative_path is invalid")
        if not isinstance(self.role, str) or not self.role:
            raise ValueError("runtime artifact role is invalid")
        if not _SHA256.fullmatch(self.sha256):
            raise ValueError("runtime artifact sha256 is invalid")
        if (
            isinstance(self.size, bool)
            or not isinstance(self.size, int)
            or self.size <= 0
        ):
            raise ValueError("runtime artifact size is invalid")
        operating_systems = tuple(self.operating_systems)
        architectures = tuple(self.architectures)
        if (
            not operating_systems
            or len(set(operating_systems)) != len(operating_systems)
            or not architectures
            or len(set(architectures)) != len(architectures)
            or not all(isinstance(item, str) and item for item in operating_systems)
            or not all(isinstance(item, str) and item for item in architectures)
        ):
            raise ValueError("runtime artifact platform declarations are invalid")
        object.__setattr__(self, "path", Path(self.path).resolve(strict=False))
        object.__setattr__(self, "operating_systems", operating_systems)
        object.__setattr__(self, "architectures", architectures)


@dataclass(frozen=True, slots=True)
class RuntimeInstallationRequest:
    installation: Path
    host_executable: Path
    wheel_paths: tuple[Path, ...]
    distributions: tuple[tuple[str, str], ...]
    runtime_ids: tuple[str, ...]
    artifacts: tuple[RuntimeArtifact, ...] = ()
    entry_artifacts: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        installation = Path(self.installation).resolve(strict=False)
        host_executable = Path(self.host_executable).resolve(strict=False)
        wheel_paths = tuple(
            Path(item).resolve(strict=False) for item in self.wheel_paths
        )
        if any(
            installation not in path.parents or not path.is_file()
            for path in wheel_paths
        ):
            raise ValueError(
                "wheel_paths must be existing files inside the installation when supplied"
            )
        if not self.runtime_ids or len(set(self.runtime_ids)) != len(self.runtime_ids):
            raise ValueError("runtime_ids must be non-empty and unique")
        if not all(_LOCAL_ID.fullmatch(item) for item in self.runtime_ids):
            raise ValueError("runtime_ids contain an invalid runtime identity")
        distributions_valid = all(
            isinstance(name, str)
            and bool(name)
            and isinstance(version, str)
            and bool(version)
            for name, version in self.distributions
        )
        distribution_names = (
            [name.casefold() for name, _version in self.distributions]
            if distributions_valid
            else []
        )
        if not distributions_valid or len(set(distribution_names)) != len(
            distribution_names
        ):
            raise ValueError("distributions must contain unique name/version pairs")
        artifacts = tuple(self.artifacts)
        if not all(isinstance(item, RuntimeArtifact) for item in artifacts):
            raise ValueError("artifacts must contain RuntimeArtifact values")
        if len({item.relative_path.casefold() for item in artifacts}) != len(artifacts):
            raise ValueError("artifacts must have unique case-insensitive paths")
        if any(
            installation not in item.path.parents
            or not item.path.is_file()
            or item.path.is_symlink()
            for item in artifacts
        ):
            raise ValueError(
                "runtime artifacts must be real files inside the installation"
            )
        entry_artifacts = tuple(self.entry_artifacts)
        if len(set(value.casefold() for value in entry_artifacts)) != len(
            entry_artifacts
        ) or any(
            not isinstance(value, str)
            or value not in {item.relative_path for item in artifacts}
            for value in entry_artifacts
        ):
            raise ValueError(
                "entry_artifacts must be unique paths from the runtime artifact inventory"
            )
        object.__setattr__(self, "installation", installation)
        object.__setattr__(self, "host_executable", host_executable)
        object.__setattr__(self, "wheel_paths", wheel_paths)
        object.__setattr__(self, "runtime_ids", tuple(self.runtime_ids))
        object.__setattr__(self, "distributions", tuple(self.distributions))
        object.__setattr__(self, "artifacts", artifacts)
        object.__setattr__(self, "entry_artifacts", entry_artifacts)


@dataclass(frozen=True, slots=True)
class RuntimeSupplyBinding:
    """Immutable provenance for a language runtime used by an activation.

    This is deliberately distinct from the plugin artifact identity.  A Java
    activation, for example, binds both its immutable JAR and the exact JRE
    archive or explicitly selected system executable that launches it.
    """

    source: str
    runtime_id: str
    runtime_kind: str
    version: str
    executable: Path
    artifact_sha256: str
    artifact_size: int
    probe_sha256: str
    verification_status: str
    reproducible: bool
    registry_id: str | None = None
    registry_revision: int | None = None
    registry_sha256: str | None = None
    source_url: str | None = None
    license_spdx: str = "NOASSERTION"

    def __post_init__(self) -> None:
        if self.source not in _SUPPLY_SOURCES:
            raise ValueError("runtime supply source is invalid")
        if not _LOCAL_ID.fullmatch(self.runtime_id):
            raise ValueError("runtime supply runtime_id is invalid")
        if self.runtime_kind not in _SUPPLY_KINDS:
            raise ValueError("runtime supply runtime_kind is invalid")
        if (
            not isinstance(self.version, str)
            or not self.version
            or len(self.version) > 128
            or self.version != self.version.strip()
        ):
            raise ValueError("runtime supply version is invalid")
        raw_executable = Path(self.executable)
        if not raw_executable.is_absolute():
            raise ValueError("runtime supply executable must be absolute")
        executable = raw_executable.resolve(strict=False)
        object.__setattr__(self, "executable", executable)
        if not _SHA256.fullmatch(self.artifact_sha256):
            raise ValueError("runtime supply artifact_sha256 is invalid")
        if (
            isinstance(self.artifact_size, bool)
            or not isinstance(self.artifact_size, int)
            or self.artifact_size <= 0
            or self.artifact_size > _MAX_RUNTIME_ARTIFACT_BYTES
        ):
            raise ValueError("runtime supply artifact_size is invalid")
        if not _SHA256.fullmatch(self.probe_sha256):
            raise ValueError("runtime supply probe_sha256 is invalid")
        if (
            not isinstance(self.license_spdx, str)
            or not self.license_spdx
            or len(self.license_spdx) > 255
            or self.license_spdx != self.license_spdx.strip()
        ):
            raise ValueError("runtime supply license_spdx is invalid")
        if self.source == "host-managed":
            source_url = (
                urlsplit(self.source_url) if isinstance(self.source_url, str) else None
            )
            if (
                self.verification_status != "verified"
                or self.reproducible is not True
                or not isinstance(self.registry_id, str)
                or _LOCAL_ID.fullmatch(self.registry_id) is None
                or isinstance(self.registry_revision, bool)
                or not isinstance(self.registry_revision, int)
                or self.registry_revision <= 0
                or not isinstance(self.registry_sha256, str)
                or _SHA256.fullmatch(self.registry_sha256) is None
                or source_url is None
                or source_url.scheme != "https"
                or not source_url.hostname
                or source_url.username is not None
                or source_url.password is not None
            ):
                raise ValueError("host-managed runtime supply provenance is invalid")
        elif (
            self.verification_status != "probed"
            or self.reproducible is not False
            or self.license_spdx != "NOASSERTION"
            or any(
                value is not None
                for value in (
                    self.registry_id,
                    self.registry_revision,
                    self.registry_sha256,
                    self.source_url,
                )
            )
        ):
            raise ValueError("system runtime supply provenance is invalid")

    def to_wire(self) -> dict[str, Any]:
        common: dict[str, Any] = {
            "source": self.source,
            "runtimeId": self.runtime_id,
            "runtimeKind": self.runtime_kind,
            "version": self.version,
            "executable": str(self.executable),
            "artifactSha256": self.artifact_sha256,
            "artifactSize": self.artifact_size,
            "probeSha256": self.probe_sha256,
            "verificationStatus": self.verification_status,
            "reproducible": self.reproducible,
            "licenseSpdx": self.license_spdx,
        }
        if self.source == "host-managed":
            common.update(
                {
                    "registryId": self.registry_id,
                    "registryRevision": self.registry_revision,
                    "registrySha256": self.registry_sha256,
                    "sourceUrl": self.source_url,
                }
            )
        return common

    @classmethod
    def from_wire(
        cls, value: Any, *, label: str = "runtime supply"
    ) -> "RuntimeSupplyBinding":
        if not isinstance(value, Mapping):
            raise ValueError(f"{label} must be an object")
        source = value.get("source")
        common = {
            "source",
            "runtimeId",
            "runtimeKind",
            "version",
            "executable",
            "artifactSha256",
            "artifactSize",
            "probeSha256",
            "verificationStatus",
            "reproducible",
            "licenseSpdx",
        }
        managed = {"registryId", "registryRevision", "registrySha256", "sourceUrl"}
        expected = common | managed if source == "host-managed" else common
        if source not in _SUPPLY_SOURCES or set(value) != expected:
            raise ValueError(f"{label} fields are invalid")
        string_fields = {
            "runtimeId",
            "runtimeKind",
            "version",
            "executable",
            "artifactSha256",
            "probeSha256",
            "verificationStatus",
            "licenseSpdx",
        } | (managed - {"registryRevision"} if source == "host-managed" else set())
        if not all(
            isinstance(value.get(key), str) and value[key] for key in string_fields
        ):
            raise ValueError(f"{label} strings are invalid")
        return cls(
            source=source,
            runtime_id=value["runtimeId"],
            runtime_kind=value["runtimeKind"],
            version=value["version"],
            executable=Path(value["executable"]),
            artifact_sha256=value["artifactSha256"],
            artifact_size=value["artifactSize"],
            probe_sha256=value["probeSha256"],
            verification_status=value["verificationStatus"],
            reproducible=value["reproducible"],
            registry_id=value.get("registryId"),
            registry_revision=value.get("registryRevision"),
            registry_sha256=value.get("registrySha256"),
            source_url=value.get("sourceUrl"),
            license_spdx=value["licenseSpdx"],
        )


@dataclass(frozen=True, slots=True)
class RuntimeProviderBinding:
    runtime_kind: str
    runtime_id: str
    provider_version: str
    runtime_identity: str
    runtime_supply: RuntimeSupplyBinding | None = None

    def __post_init__(self) -> None:
        if not _KIND.fullmatch(self.runtime_kind):
            raise ValueError("runtime_kind is invalid")
        if not _LOCAL_ID.fullmatch(self.runtime_id):
            raise ValueError("runtime_id is invalid")
        if not _VERSION.fullmatch(self.provider_version):
            raise ValueError("provider_version is invalid")
        if not _SHA256.fullmatch(self.runtime_identity):
            raise ValueError("runtime_identity is invalid")
        if self.runtime_supply is not None:
            if not isinstance(self.runtime_supply, RuntimeSupplyBinding):
                raise ValueError("runtime_supply is invalid")
            if (
                _SUPPLY_PROVIDER_KINDS.get(self.runtime_kind)
                != self.runtime_supply.runtime_kind
                or self.runtime_supply.runtime_id != self.runtime_id
            ):
                raise ValueError(
                    "runtime supply identity does not match provider binding"
                )

    def to_wire(self) -> dict[str, Any]:
        return {
            "runtimeKind": self.runtime_kind,
            "runtimeId": self.runtime_id,
            "providerVersion": self.provider_version,
            "runtimeIdentity": self.runtime_identity,
            **(
                {"runtimeSupply": self.runtime_supply.to_wire()}
                if self.runtime_supply is not None
                else {}
            ),
        }


@dataclass(frozen=True, slots=True)
class PreparedRuntime:
    runtime_kind: str
    runtime_id: str
    provider_version: str
    runtime_identity: str
    executable: Path
    working_directory: Path
    module: str | None = None
    artifact: Path | None = None
    arguments: tuple[str, ...] = ()
    artifact_sha256: str | None = None
    runtime_supply: RuntimeSupplyBinding | None = None

    def __post_init__(self) -> None:
        RuntimeProviderBinding(
            self.runtime_kind,
            self.runtime_id,
            self.provider_version,
            self.runtime_identity,
            self.runtime_supply,
        )
        arguments = tuple(self.arguments)
        if len(arguments) > 64 or not all(
            isinstance(item, str)
            and len(item) <= 1024
            and "\0" not in item
            and "\r" not in item
            and "\n" not in item
            for item in arguments
        ):
            raise ValueError("prepared runtime arguments are invalid")
        if self.artifact_sha256 is not None and not _SHA256.fullmatch(
            self.artifact_sha256
        ):
            raise ValueError("prepared runtime artifact_sha256 is invalid")
        if self.runtime_supply is not None:
            if not isinstance(self.runtime_supply, RuntimeSupplyBinding):
                raise ValueError("prepared runtime runtime_supply is invalid")
            if self.runtime_supply.runtime_id != self.runtime_id:
                raise ValueError("prepared runtime supply identity does not match")
        object.__setattr__(
            self, "executable", Path(self.executable).resolve(strict=False)
        )
        object.__setattr__(
            self,
            "working_directory",
            Path(self.working_directory).resolve(strict=False),
        )
        object.__setattr__(
            self,
            "artifact",
            Path(self.artifact).resolve(strict=False)
            if self.artifact is not None
            else None,
        )
        object.__setattr__(self, "arguments", arguments)


@dataclass(frozen=True, slots=True)
class SandboxRuntime:
    executable: Path
    site_packages: Path
    runtime_identity: str | None = None

    def __post_init__(self) -> None:
        if self.runtime_identity is not None and not _SHA256.fullmatch(
            self.runtime_identity
        ):
            raise ValueError("sandbox runtime identity is invalid")
        object.__setattr__(
            self, "executable", Path(self.executable).resolve(strict=False)
        )
        object.__setattr__(
            self, "site_packages", Path(self.site_packages).resolve(strict=False)
        )


@dataclass(frozen=True, slots=True)
class PreparedLaunch:
    runtime_kind: str
    runtime_id: str
    provider_version: str
    runtime_identity: str
    executable: Path
    arguments: tuple[str, ...]
    working_directory: Path
    manage_process_tree: bool = False
    isolated_search_path: bool = False
    max_processes: int = 1

    def __post_init__(self) -> None:
        RuntimeProviderBinding(
            self.runtime_kind,
            self.runtime_id,
            self.provider_version,
            self.runtime_identity,
        )
        prepared = PreparedRuntime(
            runtime_kind=self.runtime_kind,
            runtime_id=self.runtime_id,
            provider_version=self.provider_version,
            runtime_identity=self.runtime_identity,
            executable=self.executable,
            working_directory=self.working_directory,
            arguments=self.arguments,
        )
        object.__setattr__(self, "executable", prepared.executable)
        object.__setattr__(self, "arguments", prepared.arguments)
        object.__setattr__(self, "working_directory", prepared.working_directory)
        if not isinstance(self.manage_process_tree, bool):
            raise ValueError("manage_process_tree must be a boolean")
        if not isinstance(self.isolated_search_path, bool):
            raise ValueError("isolated_search_path must be a boolean")
        if (
            isinstance(self.max_processes, bool)
            or not isinstance(self.max_processes, int)
            or not 1 <= self.max_processes <= 32
        ):
            raise ValueError("max_processes is outside the supported range")


class RuntimeProvider(Protocol):
    api_version: int
    kind: str
    provider_version: str

    def validate_runtime(self, runtime: object) -> None: ...

    def prepare_installation(
        self,
        request: RuntimeInstallationRequest,
        run_command: InstallCommandRunner,
    ) -> tuple[RuntimeProviderBinding, ...]: ...

    def verify_installation(
        self,
        request: RuntimeInstallationRequest,
        run_command: InstallCommandRunner,
    ) -> tuple[RuntimeProviderBinding, ...]: ...

    def prepare_runtime(
        self,
        *,
        runtime: object,
        executable: Path,
        working_directory: Path,
        artifact_sha256: str | None,
    ) -> PreparedRuntime: ...

    def build_probe_launch(
        self,
        prepared: PreparedRuntime,
        *,
        sandbox_runtime: SandboxRuntime | None = None,
    ) -> PreparedLaunch: ...

    def build_runtime_launch(
        self,
        prepared: PreparedRuntime,
        *,
        sandbox_runtime: SandboxRuntime | None = None,
    ) -> PreparedLaunch: ...
