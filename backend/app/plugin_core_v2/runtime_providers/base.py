"""Language-neutral contracts for Plugin Platform Runtime Providers."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol


RUNTIME_PROVIDER_API_VERSION = 1
_KIND = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
_LOCAL_ID = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$")
_VERSION = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")
_SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")


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
class RuntimeInstallationRequest:
    installation: Path
    host_executable: Path
    wheel_paths: tuple[Path, ...]
    distributions: tuple[tuple[str, str], ...]
    runtime_ids: tuple[str, ...]

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
        object.__setattr__(self, "installation", installation)
        object.__setattr__(self, "host_executable", host_executable)
        object.__setattr__(self, "wheel_paths", wheel_paths)
        object.__setattr__(self, "runtime_ids", tuple(self.runtime_ids))
        object.__setattr__(self, "distributions", tuple(self.distributions))


@dataclass(frozen=True, slots=True)
class RuntimeProviderBinding:
    runtime_kind: str
    runtime_id: str
    provider_version: str
    runtime_identity: str

    def __post_init__(self) -> None:
        if not _KIND.fullmatch(self.runtime_kind):
            raise ValueError("runtime_kind is invalid")
        if not _LOCAL_ID.fullmatch(self.runtime_id):
            raise ValueError("runtime_id is invalid")
        if not _VERSION.fullmatch(self.provider_version):
            raise ValueError("provider_version is invalid")
        if not _SHA256.fullmatch(self.runtime_identity):
            raise ValueError("runtime_identity is invalid")

    def to_wire(self) -> dict[str, str]:
        return {
            "runtimeKind": self.runtime_kind,
            "runtimeId": self.runtime_id,
            "providerVersion": self.provider_version,
            "runtimeIdentity": self.runtime_identity,
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
    arguments: tuple[str, ...] = ()
    artifact_sha256: str | None = None

    def __post_init__(self) -> None:
        RuntimeProviderBinding(
            self.runtime_kind,
            self.runtime_id,
            self.provider_version,
            self.runtime_identity,
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
        object.__setattr__(
            self, "executable", Path(self.executable).resolve(strict=False)
        )
        object.__setattr__(
            self,
            "working_directory",
            Path(self.working_directory).resolve(strict=False),
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
