"""Pinned Wasmtime provider for WASI Preview 2 command components."""

from __future__ import annotations

import hashlib
import platform
from pathlib import Path, PurePosixPath
from typing import Any

from candlescope_plugin_sdk.platform_v2 import WasmComponentRuntime, canonical_sha256

from .base import (
    RUNTIME_PROVIDER_API_VERSION,
    InstallCommandRunner,
    PreparedLaunch,
    PreparedRuntime,
    RuntimeArtifact,
    RuntimeInstallationRequest,
    RuntimeProviderBinding,
    RuntimeProviderError,
    RuntimeSupplyBinding,
    SandboxRuntime,
)
from .wasmtime_policy import (
    WASM_COMPONENT_HEADER,
    WASM_COMPONENT_PROVIDER_VERSION,
    WASM_LINEAR_MEMORY_BYTES,
    WASM_MAX_COMPONENT_BYTES,
    WASM_PROCESS_FUEL,
    WASM_RUNTIME_ENABLED_ENV,
    WASMTIME_FIXED_ARGUMENTS,
    WASMTIME_RUNTIME_ID,
    WASMTIME_VERSION,
)


def _provider_error(
    code: str,
    message: str,
    *,
    details: dict[str, Any] | None = None,
) -> RuntimeProviderError:
    return RuntimeProviderError(code, message, details=details)


def _host_target() -> tuple[str, str]:
    operating_system = {"Windows": "windows", "Linux": "linux"}.get(platform.system())
    architecture = {"AMD64": "x86_64", "x86_64": "x86_64"}.get(platform.machine())
    if operating_system is None or architecture is None:
        raise _provider_error(
            "PLUGIN_RUNTIME_PROVIDER_PLATFORM_UNSUPPORTED",
            "WASM Provider v1 is verified only on Windows/Linux x86_64",
            details={"system": platform.system(), "machine": platform.machine()},
        )
    return operating_system, architecture


def _inspect_component(
    artifact: RuntimeArtifact | None,
    *,
    path: Path,
    expected_sha256: str,
) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    header = b""
    try:
        with path.open("rb") as stream:
            header = stream.read(len(WASM_COMPONENT_HEADER))
            digest.update(header)
            size = len(header)
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                size += len(chunk)
                if size > WASM_MAX_COMPONENT_BYTES:
                    raise _provider_error(
                        "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_LIMIT_EXCEEDED",
                        "WASM component exceeds the 64 MiB Host limit",
                    )
                digest.update(chunk)
    except RuntimeProviderError:
        raise
    except OSError as exc:
        raise _provider_error(
            "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
            "WASM component could not be read",
            details={"errorType": type(exc).__name__},
        ) from exc
    actual_sha256 = f"sha256:{digest.hexdigest()}"
    if header != WASM_COMPONENT_HEADER:
        raise _provider_error(
            "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
            "WASM Provider v1 requires a Component Model binary, not a core module",
        )
    if actual_sha256 != expected_sha256 or (
        artifact is not None
        and (actual_sha256, size) != (artifact.sha256, artifact.size)
    ):
        raise _provider_error(
            "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_MISMATCH",
            "WASM component digest or size does not match its immutable inventory",
            details={"artifact": artifact.relative_path if artifact else path.name},
        )
    return actual_sha256, size


def _runtime_identity(runtime_id: str, supply: RuntimeSupplyBinding) -> str:
    return canonical_sha256(
        {
            "runtimeKind": "wasm-component",
            "runtimeId": runtime_id,
            "providerVersion": WASM_COMPONENT_PROVIDER_VERSION,
            "runtimeSupply": supply.to_wire(),
            "policy": {
                "componentModel": "wasm32-wasip2-command-v1",
                "descriptorExport": "wasi:cli.run",
                "componentExport": "wasi:cli/run",
                "wasiProfile": "wasi-preview2-minimal-v1",
                "bridge": "stdin-stdout-jsonl-v1",
                "preopenedDirectories": [],
                "environmentInheritance": False,
                "network": False,
                "subprocess": False,
                "linearMemoryBytes": WASM_LINEAR_MEMORY_BYTES,
                "processFuel": WASM_PROCESS_FUEL,
                "maxProcesses": 1,
                "processTree": "host-managed-v1",
                "searchPath": "isolated-v1",
            },
        }
    )


class WasmPreparedLaunch(PreparedLaunch):
    """Add WASM-only Host policy without widening the frozen Provider v1 DTO."""

    __slots__ = ()

    @property
    def failure_classifier(self) -> str:
        return "wasmtime-v1"

    @property
    def terminate_on_cancel(self) -> bool:
        return True


class WasmComponentProvider:
    api_version = RUNTIME_PROVIDER_API_VERSION
    kind = "wasm-component"
    provider_version = WASM_COMPONENT_PROVIDER_VERSION

    def __init__(self, managed_runtime_registry: Any) -> None:
        if managed_runtime_registry is None or not callable(
            getattr(managed_runtime_registry, "ensure", None)
        ):
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_CONFIGURATION_INVALID",
                "WasmComponentProvider requires the Host-managed Runtime Registry",
            )
        self._managed_runtime_registry = managed_runtime_registry

    def validate_runtime(self, runtime: object) -> None:
        if not isinstance(runtime, WasmComponentRuntime):
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID",
                "WasmComponentProvider received a non-WASM runtime descriptor",
            )
        if PurePosixPath(runtime.artifact).suffix.casefold() != ".wasm":
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID",
                "WASM Provider v1 accepts only .wasm component artifacts",
            )
        if runtime.export != "wasi:cli.run":
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID",
                "WASM Provider v1 maps only wasi:cli.run to the wasi:cli/run component entry",
            )
        if runtime.wasi_profile != "wasi-preview2":
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID",
                "WASM Provider v1 accepts only the frozen wasi-preview2 profile",
            )
        if runtime.args:
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID",
                "WASM Provider v1 does not allow plugin-controlled Wasmtime arguments",
            )

    @staticmethod
    def _validate_request(request: RuntimeInstallationRequest) -> None:
        if request.wheel_paths or request.distributions:
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID",
                "wasm-component installation must not receive Python packages",
            )
        if not request.artifacts or not request.entry_artifacts:
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID",
                "wasm-component installation requires immutable component artifacts",
            )
        if any(item.role != "wasm-component" for item in request.artifacts):
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID",
                "WasmComponentProvider received a wrongly typed artifact",
            )
        if set(request.entry_artifacts) != {
            item.relative_path for item in request.artifacts
        }:
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
                "WASM runtime inventory must contain only declared entry components",
            )
        operating_system, architecture = _host_target()
        for artifact in request.artifacts:
            if (
                operating_system not in artifact.operating_systems
                or architecture not in artifact.architectures
            ):
                raise _provider_error(
                    "PLUGIN_RUNTIME_PROVIDER_PLATFORM_UNSUPPORTED",
                    "WASM component bundle does not declare the current verified target",
                    details={
                        "artifact": artifact.relative_path,
                        "os": operating_system,
                        "arch": architecture,
                    },
                )

    def _ensure(self, runtime_id: str, *, offline: bool) -> Any:
        if runtime_id != WASMTIME_RUNTIME_ID:
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_VERSION_INCOMPATIBLE",
                "WASM Provider v1 requires the pinned Wasmtime 47.0.3 runtime id",
                details={"runtimeId": runtime_id},
            )
        try:
            ensured = self._managed_runtime_registry.ensure(
                runtime_id,
                "wasm",
                offline=offline,
            )
        except Exception as exc:
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_SUPPLY_UNAVAILABLE",
                "exact Host-managed Wasmtime runtime could not be resolved and verified",
                details={
                    "runtimeId": runtime_id,
                    "causeCode": getattr(exc, "code", type(exc).__name__),
                },
            ) from exc
        supply = getattr(ensured, "supply", None)
        executable = getattr(ensured, "executable", None)
        if (
            not isinstance(supply, RuntimeSupplyBinding)
            or supply.runtime_kind != "wasm"
            or supply.runtime_id != runtime_id
            or not supply.version.startswith(WASMTIME_VERSION)
            or not isinstance(executable, Path)
            or executable.resolve(strict=False) != supply.executable
            or not executable.is_file()
            or executable.is_symlink()
        ):
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_SUPPLY_INVALID",
                "Host-managed Wasmtime result does not match the pinned identity",
                details={"runtimeId": runtime_id},
            )
        return ensured

    def _bindings(
        self,
        request: RuntimeInstallationRequest,
        *,
        offline: bool,
    ) -> tuple[RuntimeProviderBinding, ...]:
        result = []
        for runtime_id in sorted(request.runtime_ids):
            ensured = self._ensure(runtime_id, offline=offline)
            result.append(
                RuntimeProviderBinding(
                    runtime_kind=self.kind,
                    runtime_id=runtime_id,
                    provider_version=self.provider_version,
                    runtime_identity=_runtime_identity(runtime_id, ensured.supply),
                    runtime_supply=ensured.supply,
                )
            )
        return tuple(result)

    @staticmethod
    def _inspect_install_artifacts(request: RuntimeInstallationRequest) -> None:
        by_path = {item.relative_path: item for item in request.artifacts}
        for entry in request.entry_artifacts:
            artifact = by_path[entry]
            _inspect_component(
                artifact,
                path=artifact.path,
                expected_sha256=artifact.sha256,
            )

    def prepare_installation(
        self,
        request: RuntimeInstallationRequest,
        run_command: InstallCommandRunner,
    ) -> tuple[RuntimeProviderBinding, ...]:
        del run_command
        self._validate_request(request)
        bindings = self._bindings(request, offline=False)
        self._inspect_install_artifacts(request)
        return bindings

    def verify_installation(
        self,
        request: RuntimeInstallationRequest,
        run_command: InstallCommandRunner,
    ) -> tuple[RuntimeProviderBinding, ...]:
        del run_command
        self._validate_request(request)
        bindings = self._bindings(request, offline=True)
        self._inspect_install_artifacts(request)
        return bindings

    def prepare_runtime(
        self,
        *,
        runtime: object,
        executable: Path,
        working_directory: Path,
        artifact_sha256: str | None,
    ) -> PreparedRuntime:
        self.validate_runtime(runtime)
        assert isinstance(runtime, WasmComponentRuntime)
        if artifact_sha256 is None:
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_MISMATCH",
                "wasm-component activation has no immutable artifact digest",
            )
        try:
            working = Path(working_directory).resolve(strict=True)
            content_root = (working / "content").resolve(strict=True)
            expected = content_root.joinpath(
                *PurePosixPath(runtime.artifact).parts
            ).resolve(strict=True)
            component = Path(executable).resolve(strict=True)
        except OSError as exc:
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_LAUNCH_INVALID",
                "WASM component or installation directory is unavailable",
                details={"artifact": runtime.artifact},
            ) from exc
        if component != expected or component.is_symlink() or not component.is_file():
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_LAUNCH_INVALID",
                "WASM launch target is not the declared immutable component",
                details={"artifact": runtime.artifact},
            )
        _inspect_component(None, path=component, expected_sha256=artifact_sha256)
        ensured = self._ensure(runtime.runtime_id, offline=True)
        return PreparedRuntime(
            runtime_kind=self.kind,
            runtime_id=runtime.runtime_id,
            provider_version=self.provider_version,
            runtime_identity=_runtime_identity(runtime.runtime_id, ensured.supply),
            executable=ensured.executable,
            working_directory=working,
            artifact=component,
            arguments=(*WASMTIME_FIXED_ARGUMENTS, "--", str(component)),
            artifact_sha256=artifact_sha256,
            runtime_supply=ensured.supply,
        )

    def _build_launch(
        self,
        prepared: PreparedRuntime,
        *,
        sandbox_runtime: SandboxRuntime | None,
    ) -> PreparedLaunch:
        if sandbox_runtime is not None:
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_LAUNCH_INVALID",
                "wasm-component must use its frozen Wasmtime supply",
            )
        if (
            prepared.runtime_kind != self.kind
            or prepared.artifact is None
            or prepared.runtime_supply is None
            or prepared.runtime_supply.runtime_kind != "wasm"
            or prepared.executable != prepared.runtime_supply.executable
            or not prepared.artifact.is_file()
            or prepared.artifact.is_symlink()
        ):
            raise _provider_error(
                "PLUGIN_RUNTIME_PROVIDER_LAUNCH_INVALID",
                "prepared wasm-component runtime is incomplete or has the wrong supply",
            )
        return WasmPreparedLaunch(
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


__all__ = [
    "WASM_COMPONENT_PROVIDER_VERSION",
    "WASM_LINEAR_MEMORY_BYTES",
    "WASM_PROCESS_FUEL",
    "WASM_RUNTIME_ENABLED_ENV",
    "WASMTIME_FIXED_ARGUMENTS",
    "WASMTIME_RUNTIME_ID",
    "WasmComponentProvider",
]
