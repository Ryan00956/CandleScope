"""Direct native executable Runtime Provider with strict artifact verification."""

from __future__ import annotations

import hashlib
import os
import platform
import stat
import struct
from pathlib import Path, PurePosixPath

from candlescope_plugin_sdk.platform_v2 import (
    NativeExecutableRuntime,
    canonical_sha256,
)

from .base import (
    RUNTIME_PROVIDER_API_VERSION,
    InstallCommandRunner,
    PreparedLaunch,
    PreparedRuntime,
    RuntimeArtifact,
    RuntimeInstallationRequest,
    RuntimeProviderBinding,
    RuntimeProviderError,
    SandboxRuntime,
)


NATIVE_EXECUTABLE_PROVIDER_VERSION = "1.0.0"
_NATIVE_RUNTIME_ID = "native-host"
_SCRIPT_SUFFIXES = frozenset(
    {
        ".bat",
        ".cmd",
        ".com",
        ".js",
        ".mjs",
        ".ps1",
        ".py",
        ".pyw",
        ".sh",
        ".vbs",
        ".wsf",
    }
)
_SHELL_NAMES = frozenset(
    {
        "bash",
        "bash.exe",
        "cmd",
        "cmd.exe",
        "pwsh",
        "pwsh.exe",
        "powershell",
        "powershell.exe",
        "sh",
        "sh.exe",
        "zsh",
        "zsh.exe",
    }
)
_PE_MACHINE = {"x86_64": 0x8664, "arm64": 0xAA64}
_ELF_MACHINE = {"x86_64": 62, "arm64": 183}
_MACHO_CPU = {"x86_64": 0x01000007, "arm64": 0x0100000C}


def _host_platform() -> tuple[str, str]:
    operating_system = {
        "darwin": "macos",
        "linux": "linux",
        "windows": "windows",
    }.get(platform.system().casefold())
    machine = platform.machine().casefold()
    architecture = {
        "aarch64": "arm64",
        "amd64": "x86_64",
        "arm64": "arm64",
        "x86_64": "x86_64",
    }.get(machine)
    if operating_system is None or architecture is None:
        raise RuntimeProviderError(
            "PLUGIN_RUNTIME_PROVIDER_PLATFORM_MISMATCH",
            "the native Runtime Provider does not support this Host platform",
            details={"system": platform.system(), "machine": platform.machine()},
        )
    return operating_system, architecture


def _digest(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    try:
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
                size += len(chunk)
    except OSError as exc:
        raise RuntimeProviderError(
            "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
            "native executable could not be read",
            details={"errorType": type(exc).__name__},
        ) from exc
    return f"sha256:{digest.hexdigest()}", size


def _artifact_error(message: str, *, relative_path: str) -> RuntimeProviderError:
    return RuntimeProviderError(
        "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
        message,
        details={"artifact": relative_path},
    )


def _inspect_pe(path: Path, *, architecture: str, relative_path: str) -> str:
    try:
        with path.open("rb") as stream:
            dos = stream.read(64)
            if len(dos) < 64 or dos[:2] != b"MZ":
                raise _artifact_error(
                    "Windows native artifact is not a PE executable",
                    relative_path=relative_path,
                )
            pe_offset = struct.unpack_from("<I", dos, 0x3C)[0]
            if pe_offset < 64 or pe_offset > 1024 * 1024:
                raise _artifact_error(
                    "Windows native artifact has an unsafe PE header offset",
                    relative_path=relative_path,
                )
            stream.seek(pe_offset)
            header = stream.read(26)
    except RuntimeProviderError:
        raise
    except (OSError, struct.error) as exc:
        raise _artifact_error(
            "Windows native artifact PE header is truncated",
            relative_path=relative_path,
        ) from exc
    if len(header) < 26 or header[:4] != b"PE\0\0":
        raise _artifact_error(
            "Windows native artifact has an invalid PE signature",
            relative_path=relative_path,
        )
    machine = struct.unpack_from("<H", header, 4)[0]
    characteristics = struct.unpack_from("<H", header, 22)[0]
    optional_magic = struct.unpack_from("<H", header, 24)[0]
    if machine != _PE_MACHINE[architecture]:
        raise _artifact_error(
            "Windows native artifact architecture does not match the Host",
            relative_path=relative_path,
        )
    if not characteristics & 0x0002 or characteristics & 0x2000:
        raise _artifact_error(
            "Windows native artifact must be an executable image, not a DLL",
            relative_path=relative_path,
        )
    if optional_magic != 0x020B:
        raise _artifact_error(
            "Windows native artifact must use the 64-bit PE format",
            relative_path=relative_path,
        )
    return "pe32+-executable"


def _inspect_elf(path: Path, *, architecture: str, relative_path: str) -> str:
    try:
        with path.open("rb") as stream:
            header = stream.read(64)
    except OSError as exc:
        raise _artifact_error(
            "Linux native artifact could not be inspected",
            relative_path=relative_path,
        ) from exc
    if len(header) < 64 or header[:4] != b"\x7fELF" or header[4] != 2 or header[5] != 1:
        raise _artifact_error(
            "Linux native artifact must be a little-endian ELF64 executable",
            relative_path=relative_path,
        )
    executable_type, machine = struct.unpack_from("<HH", header, 16)
    if executable_type not in {2, 3} or machine != _ELF_MACHINE[architecture]:
        raise _artifact_error(
            "Linux native artifact type or architecture does not match the Host",
            relative_path=relative_path,
        )
    return "elf64-executable"


def _inspect_macho(path: Path, *, architecture: str, relative_path: str) -> str:
    try:
        with path.open("rb") as stream:
            header = stream.read(32)
    except OSError as exc:
        raise _artifact_error(
            "macOS native artifact could not be inspected",
            relative_path=relative_path,
        ) from exc
    if len(header) < 32 or header[:4] != b"\xcf\xfa\xed\xfe":
        raise _artifact_error(
            "macOS native artifact must be a thin little-endian Mach-O 64 executable",
            relative_path=relative_path,
        )
    cpu_type = struct.unpack_from("<I", header, 4)[0]
    file_type = struct.unpack_from("<I", header, 12)[0]
    if cpu_type != _MACHO_CPU[architecture] or file_type != 2:
        raise _artifact_error(
            "macOS native artifact type or architecture does not match the Host",
            relative_path=relative_path,
        )
    return "macho64-executable"


def _inspect_binary(path: Path, *, relative_path: str) -> str:
    operating_system, architecture = _host_platform()
    if operating_system == "windows":
        return _inspect_pe(
            path,
            architecture=architecture,
            relative_path=relative_path,
        )
    if operating_system == "linux":
        return _inspect_elf(
            path,
            architecture=architecture,
            relative_path=relative_path,
        )
    return _inspect_macho(
        path,
        architecture=architecture,
        relative_path=relative_path,
    )


def _verify_artifact(artifact: RuntimeArtifact) -> str:
    operating_system, architecture = _host_platform()
    name = PurePosixPath(artifact.relative_path).name.casefold()
    suffix = PurePosixPath(artifact.relative_path).suffix.casefold()
    if artifact.role != "native-executable":
        raise _artifact_error(
            "NativeExecutableProvider received a wrongly typed artifact",
            relative_path=artifact.relative_path,
        )
    if name in _SHELL_NAMES or suffix in _SCRIPT_SUFFIXES:
        raise _artifact_error(
            "native runtime artifact must not be a shell or script",
            relative_path=artifact.relative_path,
        )
    if operating_system == "windows" and suffix != ".exe":
        raise _artifact_error(
            "Windows native runtime artifact must use the .exe suffix",
            relative_path=artifact.relative_path,
        )
    if (
        operating_system not in artifact.operating_systems
        or architecture not in artifact.architectures
    ):
        raise RuntimeProviderError(
            "PLUGIN_RUNTIME_PROVIDER_PLATFORM_MISMATCH",
            "native runtime artifact does not support the current Host platform",
            details={
                "artifact": artifact.relative_path,
                "operatingSystem": operating_system,
                "architecture": architecture,
            },
        )
    actual_digest, actual_size = _digest(artifact.path)
    if (actual_digest, actual_size) != (artifact.sha256, artifact.size):
        raise RuntimeProviderError(
            "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_MISMATCH",
            "native runtime artifact digest or size does not match its inventory",
            details={"artifact": artifact.relative_path},
        )
    return _inspect_binary(artifact.path, relative_path=artifact.relative_path)


def _runtime_identity(runtime_id: str) -> str:
    operating_system, architecture = _host_platform()
    return canonical_sha256(
        {
            "runtimeKind": "native-executable",
            "runtimeId": runtime_id,
            "providerVersion": NATIVE_EXECUTABLE_PROVIDER_VERSION,
            "host": {
                "operatingSystem": operating_system,
                "architecture": architecture,
            },
            "policy": {
                "artifactFormat": "strict-native-v1",
                "processTree": "host-managed-v1",
                "searchPath": "isolated-v1",
                "maxProcesses": 1,
            },
        }
    )


class NativeExecutableProvider:
    api_version = RUNTIME_PROVIDER_API_VERSION
    kind = "native-executable"
    provider_version = NATIVE_EXECUTABLE_PROVIDER_VERSION

    def validate_runtime(self, runtime: object) -> None:
        if not isinstance(runtime, NativeExecutableRuntime):
            raise RuntimeProviderError(
                "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID",
                "NativeExecutableProvider received a non-native runtime descriptor",
            )
        operating_system, architecture = _host_platform()
        if (
            operating_system not in runtime.operating_systems
            or architecture not in runtime.architectures
        ):
            raise RuntimeProviderError(
                "PLUGIN_RUNTIME_PROVIDER_PLATFORM_MISMATCH",
                "native runtime descriptor does not support the current Host platform",
                details={
                    "operatingSystem": operating_system,
                    "architecture": architecture,
                },
            )
        name = PurePosixPath(runtime.artifact).name.casefold()
        suffix = PurePosixPath(runtime.artifact).suffix.casefold()
        if name in _SHELL_NAMES or suffix in _SCRIPT_SUFFIXES:
            raise RuntimeProviderError(
                "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID",
                "native runtime artifact must not reference a shell or script",
            )
        if operating_system == "windows" and suffix != ".exe":
            raise RuntimeProviderError(
                "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID",
                "Windows native runtime artifact must use the .exe suffix",
            )

    @staticmethod
    def _validate_installation_request(
        request: RuntimeInstallationRequest,
    ) -> None:
        if not request.artifacts:
            raise RuntimeProviderError(
                "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID",
                "native runtime installation requires declared artifacts",
            )
        if request.wheel_paths or request.distributions:
            raise RuntimeProviderError(
                "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID",
                "native runtime installation must not receive Python packages",
            )
        if set(request.runtime_ids) != {_NATIVE_RUNTIME_ID}:
            raise RuntimeProviderError(
                "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID",
                "native runtime installation has an unsupported runtime identity",
            )

    @staticmethod
    def _bindings(
        request: RuntimeInstallationRequest,
    ) -> tuple[RuntimeProviderBinding, ...]:
        return tuple(
            RuntimeProviderBinding(
                runtime_kind="native-executable",
                runtime_id=runtime_id,
                provider_version=NATIVE_EXECUTABLE_PROVIDER_VERSION,
                runtime_identity=_runtime_identity(runtime_id),
            )
            for runtime_id in sorted(request.runtime_ids)
        )

    def prepare_installation(
        self,
        request: RuntimeInstallationRequest,
        run_command: InstallCommandRunner,
    ) -> tuple[RuntimeProviderBinding, ...]:
        del run_command
        self._validate_installation_request(request)
        for artifact in request.artifacts:
            _verify_artifact(artifact)
            if os.name != "nt":
                try:
                    artifact.path.chmod(artifact.path.stat().st_mode | stat.S_IXUSR)
                except OSError as exc:
                    raise RuntimeProviderError(
                        "PLUGIN_RUNTIME_PROVIDER_PREPARE_FAILED",
                        "native executable permission could not be prepared",
                        details={"artifact": artifact.relative_path},
                    ) from exc
        return self.verify_installation(request, lambda *args, **kwargs: b"")

    def verify_installation(
        self,
        request: RuntimeInstallationRequest,
        run_command: InstallCommandRunner,
    ) -> tuple[RuntimeProviderBinding, ...]:
        del run_command
        self._validate_installation_request(request)
        for artifact in request.artifacts:
            _verify_artifact(artifact)
            if os.name != "nt" and not os.access(artifact.path, os.X_OK):
                raise RuntimeProviderError(
                    "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
                    "native artifact is not executable by the Host user",
                    details={"artifact": artifact.relative_path},
                )
        return self._bindings(request)

    def prepare_runtime(
        self,
        *,
        runtime: object,
        executable: Path,
        working_directory: Path,
        artifact_sha256: str | None,
    ) -> PreparedRuntime:
        self.validate_runtime(runtime)
        assert isinstance(runtime, NativeExecutableRuntime)
        try:
            working = Path(working_directory).resolve(strict=True)
            expected = working.joinpath(
                "content", *PurePosixPath(runtime.artifact).parts
            ).resolve(strict=True)
            target = Path(executable).resolve(strict=True)
        except OSError as exc:
            raise RuntimeProviderError(
                "PLUGIN_RUNTIME_PROVIDER_LAUNCH_INVALID",
                "native launch target or working directory is unavailable",
                details={"artifact": runtime.artifact},
            ) from exc
        if target != expected or target.is_symlink() or not target.is_file():
            raise RuntimeProviderError(
                "PLUGIN_RUNTIME_PROVIDER_LAUNCH_INVALID",
                "native launch target is not the declared immutable artifact",
                details={"artifact": runtime.artifact},
            )
        actual_digest, _actual_size = _digest(target)
        if artifact_sha256 is None or actual_digest != artifact_sha256:
            raise RuntimeProviderError(
                "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_MISMATCH",
                "native launch target digest does not match its activation identity",
                details={"artifact": runtime.artifact},
            )
        _inspect_binary(target, relative_path=runtime.artifact)
        return PreparedRuntime(
            runtime_kind=self.kind,
            runtime_id=runtime.runtime_id,
            provider_version=self.provider_version,
            runtime_identity=_runtime_identity(runtime.runtime_id),
            executable=target,
            working_directory=working,
            artifact=target,
            arguments=runtime.args,
            artifact_sha256=artifact_sha256,
        )

    def _build_launch(
        self,
        prepared: PreparedRuntime,
        *,
        sandbox_runtime: SandboxRuntime | None,
    ) -> PreparedLaunch:
        if sandbox_runtime is not None:
            raise RuntimeProviderError(
                "PLUGIN_RUNTIME_PROVIDER_LAUNCH_INVALID",
                "native runtime must not substitute a language runtime inside the sandbox",
            )
        if (
            prepared.runtime_kind != self.kind
            or prepared.artifact is None
            or prepared.executable != prepared.artifact
        ):
            raise RuntimeProviderError(
                "PLUGIN_RUNTIME_PROVIDER_LAUNCH_INVALID",
                "prepared native runtime is incomplete or has the wrong kind",
            )
        return PreparedLaunch(
            runtime_kind=self.kind,
            runtime_id=prepared.runtime_id,
            provider_version=self.provider_version,
            runtime_identity=prepared.runtime_identity,
            executable=prepared.executable,
            arguments=prepared.arguments,
            working_directory=prepared.working_directory,
            manage_process_tree=True,
            isolated_search_path=True,
            max_processes=1,
        )

    def build_probe_launch(
        self,
        prepared: PreparedRuntime,
        *,
        sandbox_runtime: SandboxRuntime | None = None,
    ) -> PreparedLaunch:
        return self._build_launch(prepared, sandbox_runtime=sandbox_runtime)

    def build_runtime_launch(
        self,
        prepared: PreparedRuntime,
        *,
        sandbox_runtime: SandboxRuntime | None = None,
    ) -> PreparedLaunch:
        return self._build_launch(prepared, sandbox_runtime=sandbox_runtime)
