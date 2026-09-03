"""Python module Runtime Provider with v2-equivalent launch semantics."""

from __future__ import annotations

import hashlib
from pathlib import Path

from candlescope_plugin_sdk.platform_v2 import (
    PythonModuleRuntime,
    canonical_sha256,
)

from app.core.python_wheel_install import (
    InstalledDependencyError,
    host_wheel_install_command,
    installed_distribution_versions,
    venv_python,
    venv_site_packages,
    verify_installed_dependencies,
)
from app.plugin_security_v2.python_runtime import SANDBOX_PYTHON_BOOTSTRAP

from .base import (
    RUNTIME_PROVIDER_API_VERSION,
    InstallCommandRunner,
    PreparedLaunch,
    PreparedRuntime,
    RuntimeInstallationRequest,
    RuntimeProviderBinding,
    RuntimeProviderError,
    SandboxRuntime,
)


PYTHON_MODULE_PROVIDER_VERSION = "1.0.0"
_PYTHON_FLAG_ARGS = frozenset(
    {
        "-B",
        "-d",
        "-E",
        "-I",
        "-O",
        "-OO",
        "-P",
        "-q",
        "-s",
        "-S",
        "-u",
        "-v",
        "-x",
    }
)


def _validate_interpreter_args(arguments: tuple[str, ...]) -> None:
    index = 0
    while index < len(arguments):
        argument = arguments[index]
        if argument in _PYTHON_FLAG_ARGS or argument.startswith(
            "--check-hash-based-pycs="
        ):
            index += 1
            continue
        if argument in {"-W", "-X"}:
            if index + 1 >= len(arguments):
                break
            index += 2
            continue
        if (argument.startswith("-W") or argument.startswith("-X")) and len(
            argument
        ) > 2:
            index += 1
            continue
        break
    if index != len(arguments):
        raise RuntimeProviderError(
            "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID",
            "Python interpreterArgs contain an option that could replace the declared module",
        )


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as exc:
        raise RuntimeProviderError(
            "PLUGIN_RUNTIME_PROVIDER_VERIFY_FAILED",
            "Python runtime executable could not be hashed",
            details={"errorType": type(exc).__name__},
        ) from exc
    return f"sha256:{digest.hexdigest()}"


def _venv_python(installation: Path) -> Path:
    return venv_python(installation)


def _runtime_identity(runtime_id: str, executable: Path) -> str:
    resolved = executable.resolve(strict=False)
    if not resolved.is_file():
        raise RuntimeProviderError(
            "PLUGIN_RUNTIME_PROVIDER_VERIFY_FAILED",
            "managed Python runtime executable is unavailable",
            details={"runtimeId": runtime_id},
        )
    venv_root = resolved.parent.parent
    configuration = venv_root / "pyvenv.cfg"
    configuration_sha256 = _sha256(configuration) if configuration.is_file() else None
    return canonical_sha256(
        {
            "runtimeKind": "python-module",
            "runtimeId": runtime_id,
            "providerVersion": PYTHON_MODULE_PROVIDER_VERSION,
            "executableSha256": _sha256(resolved),
            "pyvenvConfigSha256": configuration_sha256,
        }
    )


class PythonModuleProvider:
    api_version = RUNTIME_PROVIDER_API_VERSION
    kind = "python-module"
    provider_version = PYTHON_MODULE_PROVIDER_VERSION

    @staticmethod
    def _validate_installation_request(
        request: RuntimeInstallationRequest,
    ) -> None:
        if not request.wheel_paths or not request.distributions:
            raise RuntimeProviderError(
                "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID",
                "Python runtime installation requires wheels and distributions",
            )

    def validate_runtime(self, runtime: object) -> None:
        if not isinstance(runtime, PythonModuleRuntime):
            raise RuntimeProviderError(
                "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID",
                "PythonModuleProvider received a non-Python runtime descriptor",
            )
        _validate_interpreter_args(runtime.interpreter_args)

    @staticmethod
    def _bindings(
        request: RuntimeInstallationRequest,
    ) -> tuple[RuntimeProviderBinding, ...]:
        executable = _venv_python(request.installation)
        return tuple(
            RuntimeProviderBinding(
                runtime_kind="python-module",
                runtime_id=runtime_id,
                provider_version=PYTHON_MODULE_PROVIDER_VERSION,
                runtime_identity=_runtime_identity(runtime_id, executable),
            )
            for runtime_id in sorted(request.runtime_ids)
        )

    def prepare_installation(
        self,
        request: RuntimeInstallationRequest,
        run_command: InstallCommandRunner,
    ) -> tuple[RuntimeProviderBinding, ...]:
        self._validate_installation_request(request)
        run_command(
            (
                str(request.host_executable),
                "-I",
                "-m",
                "venv",
                str(request.installation / "venv"),
            ),
            label="isolated virtual environment creation",
            timeout_seconds=180,
            cwd=request.installation,
        )
        executable = _venv_python(request.installation)
        if not executable.is_file():
            raise RuntimeProviderError(
                "PLUGIN_RUNTIME_PROVIDER_PREPARE_FAILED",
                "virtual environment did not create Python",
            )
        site_packages = venv_site_packages(request.installation)
        site_packages.mkdir(parents=True, exist_ok=True)
        run_command(
            host_wheel_install_command(
                request.host_executable,
                site_packages,
                request.wheel_paths,
            ),
            label="offline wheel installation",
            timeout_seconds=300,
            cwd=request.installation,
        )
        return self.verify_installation(request, run_command)

    def verify_installation(
        self,
        request: RuntimeInstallationRequest,
        run_command: InstallCommandRunner,
    ) -> tuple[RuntimeProviderBinding, ...]:
        self._validate_installation_request(request)
        del run_command
        executable = _venv_python(request.installation)
        if not executable.is_file():
            raise RuntimeProviderError(
                "PLUGIN_RUNTIME_PROVIDER_VERIFY_FAILED",
                "managed virtual environment Python is missing",
            )
        expected = dict(request.distributions)
        installed = installed_distribution_versions(request.installation, expected)
        if installed != expected:
            raise RuntimeProviderError(
                "PLUGIN_RUNTIME_PROVIDER_VERIFY_FAILED",
                "installed distribution versions do not match the bundle",
                details={"expected": expected, "actual": installed},
            )
        try:
            verify_installed_dependencies(request.installation)
        except InstalledDependencyError as exc:
            raise RuntimeProviderError(
                "PLUGIN_RUNTIME_PROVIDER_VERIFY_FAILED",
                f"installed dependency check failed: {exc}",
            ) from exc
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
        assert isinstance(runtime, PythonModuleRuntime)
        return PreparedRuntime(
            runtime_kind=self.kind,
            runtime_id=runtime.runtime_id,
            provider_version=self.provider_version,
            runtime_identity=_runtime_identity(runtime.runtime_id, executable),
            executable=executable,
            working_directory=working_directory,
            module=runtime.module,
            arguments=runtime.interpreter_args,
            artifact_sha256=artifact_sha256,
        )

    def _build_launch(
        self,
        prepared: PreparedRuntime,
        *,
        sandbox_runtime: SandboxRuntime | None,
    ) -> PreparedLaunch:
        if prepared.runtime_kind != self.kind or prepared.module is None:
            raise RuntimeProviderError(
                "PLUGIN_RUNTIME_PROVIDER_LAUNCH_INVALID",
                "prepared Python runtime is incomplete or has the wrong kind",
            )
        if sandbox_runtime is None:
            executable = prepared.executable
            arguments = (
                "-I",
                "-u",
                *prepared.arguments,
                "-m",
                prepared.module,
            )
            identity = prepared.runtime_identity
        else:
            executable = sandbox_runtime.executable.resolve(strict=True)
            site_packages = sandbox_runtime.site_packages.resolve(strict=True)
            working = prepared.working_directory.resolve(strict=True)
            if (
                not executable.is_file()
                or executable.is_symlink()
                or not site_packages.is_dir()
                or site_packages.is_symlink()
                or working not in site_packages.parents
            ):
                raise RuntimeProviderError(
                    "PLUGIN_RUNTIME_PROVIDER_LAUNCH_INVALID",
                    "sandbox Python runtime paths are invalid",
                )
            arguments = (
                "-I",
                "-u",
                *prepared.arguments,
                "-c",
                SANDBOX_PYTHON_BOOTSTRAP,
                str(site_packages),
                prepared.module,
            )
            identity = sandbox_runtime.runtime_identity or _runtime_identity(
                prepared.runtime_id, executable
            )
        return PreparedLaunch(
            runtime_kind=self.kind,
            runtime_id=prepared.runtime_id,
            provider_version=self.provider_version,
            runtime_identity=identity,
            executable=executable,
            arguments=arguments,
            working_directory=prepared.working_directory,
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
