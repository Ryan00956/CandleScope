"""Offline, isolated and rollback-safe installer for verified runtime bundles."""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .bundle import (
    MAX_BUNDLE_BYTES,
    BundleManifest,
    VerifiedBundle,
    canonical_sha256,
    normalize_expected_sha256,
    parse_bundle_manifest,
    verify_plugin_bundle,
)
from .errors import (
    PluginBundleError,
    PluginHostError,
    PluginInstallerError,
    PluginRegistryError,
)
from .registry import (
    ManagedRuntimeIdentity,
    RuntimeProcessSpec,
    RuntimeRegistry,
    default_runtime_registry_path,
    load_runtime_registry,
    runtime_process_spec_to_wire,
    runtime_registry_from_wire,
    runtime_registry_to_wire,
)
from .supervisor import RuntimeSupervisor


RECEIPT_SCHEMA_VERSION = 1
ACTIVATION_HISTORY_SCHEMA_VERSION = 1
DEFAULT_INSTALL_LOCK_TIMEOUT_SECONDS = 120.0
DEFAULT_COMMAND_OUTPUT_BYTES = 64 * 1024
MAX_INSTALLER_JSON_BYTES = 4 * 1024 * 1024

_SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
_INSTALLATION_ID = re.compile(r"^[0-9a-f]{64}$")
_ACTIVATION_ID = re.compile(r"^[0-9a-f]{32}$")
_SAFE_ENVIRONMENT_KEYS = frozenset(
    {
        "APPDATA",
        "COMSPEC",
        "HOME",
        "LANG",
        "LC_ALL",
        "LOCALAPPDATA",
        "PATH",
        "PATHEXT",
        "SSL_CERT_DIR",
        "SSL_CERT_FILE",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
        "TMPDIR",
        "USERPROFILE",
        "WINDIR",
    }
)


def _utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"non-standard JSON constant is not allowed: {value}")


def _unique_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON object key: {key}")
        result[key] = value
    return result


def _mapping(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise PluginInstallerError(f"{label} must be a JSON object")
    return value


def _only_keys(value: Mapping[str, Any], allowed: set[str], label: str) -> None:
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise PluginInstallerError(
            f"{label} contains unsupported fields: {', '.join(unknown)}"
        )


def _string(value: Any, label: str, *, maximum: int = 4096) -> str:
    if not isinstance(value, str) or not value.strip() or "\0" in value:
        raise PluginInstallerError(f"{label} must be a non-empty string")
    if len(value) > maximum:
        raise PluginInstallerError(f"{label} exceeds {maximum} characters")
    return value


def _positive_int(value: Any, label: str, *, maximum: int) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not 0 < value <= maximum
    ):
        raise PluginInstallerError(f"{label} must be an integer from 1 to {maximum}")
    return value


def _json_bytes(value: Any) -> bytes:
    try:
        return (
            json.dumps(
                value,
                ensure_ascii=False,
                allow_nan=False,
                sort_keys=True,
                indent=2,
            )
            + "\n"
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise PluginInstallerError(
            f"installer state is not JSON-compatible: {exc}"
        ) from exc


def _read_json(path: Path, label: str) -> Mapping[str, Any]:
    try:
        size = path.stat().st_size
        if size <= 0 or size > MAX_INSTALLER_JSON_BYTES:
            raise PluginInstallerError(f"{label} has an invalid size")
        payload = path.read_bytes()
        value = json.loads(
            payload.decode("utf-8"),
            parse_constant=_reject_json_constant,
            object_pairs_hook=_unique_json_object,
        )
    except PluginInstallerError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
        raise PluginInstallerError(f"unable to read {label}: {exc}") from exc
    return _mapping(value, label)


def _fsync_directory(path: Path) -> None:
    if os.name == "nt":
        return
    try:
        descriptor = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    except OSError:
        pass
    finally:
        os.close(descriptor)


def _atomic_write_json(
    path: Path, value: Any, *, replace_existing: bool = True
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.parent / f".{path.name}.{uuid.uuid4().hex}.part"
    try:
        with temporary.open("xb") as handle:
            try:
                os.chmod(temporary, 0o600)
            except OSError:
                pass
            handle.write(_json_bytes(value))
            handle.flush()
            os.fsync(handle.fileno())
        if not replace_existing and path.exists():
            raise PluginInstallerError(f"installer state already exists: {path.name}")
        _replace_file(temporary, path)
        _fsync_directory(path.parent)
    except PluginInstallerError:
        raise
    except OSError as exc:
        raise PluginInstallerError(
            f"unable to atomically write {path.name}: {exc}"
        ) from exc
    finally:
        try:
            temporary.unlink()
        except OSError:
            pass


def _rename_directory(source: Path, destination: Path) -> None:
    """Rename once on POSIX and tolerate short-lived Windows scanner handles."""

    deadline = time.monotonic() + (5.0 if os.name == "nt" else 0.0)
    while True:
        try:
            os.rename(source, destination)
            return
        except OSError as exc:
            retryable = os.name == "nt" and getattr(exc, "winerror", None) in {5, 32}
            if not retryable or time.monotonic() >= deadline:
                raise
            time.sleep(0.05)


def _replace_file(source: Path, destination: Path) -> None:
    deadline = time.monotonic() + (5.0 if os.name == "nt" else 0.0)
    while True:
        try:
            os.replace(source, destination)
            return
        except OSError as exc:
            retryable = os.name == "nt" and getattr(exc, "winerror", None) in {5, 32}
            if not retryable or time.monotonic() >= deadline:
                raise
            time.sleep(0.05)


def _subprocess_environment(executable_directory: Path) -> dict[str, str]:
    environment = {
        key.upper(): value
        for key, value in os.environ.items()
        if key.upper() in _SAFE_ENVIRONMENT_KEYS
    }
    inherited_path = environment.get("PATH", "")
    environment["PATH"] = (
        str(executable_directory)
        if not inherited_path
        else str(executable_directory) + os.pathsep + inherited_path
    )
    environment.update(
        {
            "PIP_CONFIG_FILE": os.devnull,
            "PIP_DISABLE_PIP_VERSION_CHECK": "1",
            "PIP_NO_INDEX": "1",
            "PIP_REQUIRE_VIRTUALENV": "1",
            "PYTHONIOENCODING": "utf-8",
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONNOUSERSITE": "1",
            "PYTHONUNBUFFERED": "1",
            "PYTHONUTF8": "1",
        }
    )
    return environment


def _decode_output(value: bytes) -> str:
    return (
        value[-DEFAULT_COMMAND_OUTPUT_BYTES:].decode("utf-8", errors="replace").strip()
    )


def _run_command(
    command: Sequence[str],
    *,
    label: str,
    timeout_seconds: float,
    cwd: Path | None = None,
) -> bytes:
    try:
        completed = subprocess.run(
            tuple(command),
            cwd=cwd,
            env=_subprocess_environment(Path(command[0]).resolve(strict=False).parent),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout_seconds,
            check=False,
            creationflags=(
                subprocess.CREATE_NO_WINDOW
                if os.name == "nt" and hasattr(subprocess, "CREATE_NO_WINDOW")
                else 0
            ),
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise PluginInstallerError(f"{label} could not complete: {exc}") from exc
    if completed.returncode != 0:
        raise PluginInstallerError(
            f"{label} failed with exit code {completed.returncode}",
            details={"stderr": _decode_output(completed.stderr)},
        )
    if len(completed.stdout) > DEFAULT_COMMAND_OUTPUT_BYTES:
        raise PluginInstallerError(f"{label} produced too much output")
    return completed.stdout


@contextmanager
def _installation_lock(path: Path, timeout_seconds: float) -> Iterator[None]:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        handle = path.open("a+b")
    except OSError as exc:
        raise PluginInstallerError(f"unable to open installer lock: {exc}") from exc
    acquired = False
    try:
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
        deadline = time.monotonic() + timeout_seconds
        while True:
            try:
                handle.seek(0)
                if os.name == "nt":
                    import msvcrt

                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
                break
            except OSError as exc:
                if time.monotonic() >= deadline:
                    raise PluginInstallerError(
                        f"timed out waiting for the installer lock after {timeout_seconds:g}s"
                    ) from exc
                time.sleep(0.05)
        yield
    finally:
        if acquired:
            try:
                handle.seek(0)
                if os.name == "nt":
                    import msvcrt

                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            except OSError:
                pass
        handle.close()


@dataclass(frozen=True, slots=True)
class InstallationReceipt:
    installation_id: str
    bundle_sha256: str
    bundle_size: int
    manifest_sha256: str
    manifest_contract_sha256: str
    manifest: BundleManifest

    @classmethod
    def from_bundle(cls, bundle: VerifiedBundle) -> "InstallationReceipt":
        return cls(
            installation_id=bundle.sha256.removeprefix("sha256:"),
            bundle_sha256=bundle.sha256,
            bundle_size=bundle.size,
            manifest_sha256=bundle.manifest_sha256,
            manifest_contract_sha256=canonical_sha256(bundle.manifest.to_wire()),
            manifest=bundle.manifest,
        )

    @classmethod
    def from_wire(cls, value: Any) -> "InstallationReceipt":
        root = _mapping(value, "installation receipt")
        _only_keys(
            root,
            {
                "schemaVersion",
                "installationId",
                "bundle",
                "manifestContractSha256",
                "manifest",
            },
            "installation receipt",
        )
        if root.get("schemaVersion") != RECEIPT_SCHEMA_VERSION:
            raise PluginInstallerError("unsupported installation receipt schema")
        installation_id = _string(
            root.get("installationId"),
            "installation receipt.installationId",
            maximum=64,
        )
        if not _INSTALLATION_ID.fullmatch(installation_id):
            raise PluginInstallerError(
                "installation receipt has an invalid installation ID"
            )
        bundle = _mapping(root.get("bundle"), "installation receipt.bundle")
        _only_keys(
            bundle, {"sha256", "size", "manifestSha256"}, "installation receipt.bundle"
        )
        bundle_sha256 = _string(
            bundle.get("sha256"), "installation receipt.bundle.sha256", maximum=71
        )
        manifest_sha256 = _string(
            bundle.get("manifestSha256"),
            "installation receipt.bundle.manifestSha256",
            maximum=71,
        )
        contract_sha256 = _string(
            root.get("manifestContractSha256"),
            "installation receipt.manifestContractSha256",
            maximum=71,
        )
        if not all(
            _SHA256.fullmatch(value)
            for value in (bundle_sha256, manifest_sha256, contract_sha256)
        ):
            raise PluginInstallerError(
                "installation receipt contains an invalid SHA-256"
            )
        if installation_id != bundle_sha256.removeprefix("sha256:"):
            raise PluginInstallerError(
                "installation receipt identity does not match its bundle"
            )
        try:
            manifest = parse_bundle_manifest(root.get("manifest"))
        except PluginBundleError as exc:
            raise PluginInstallerError(
                f"installation receipt manifest is invalid: {exc.message}"
            ) from exc
        if canonical_sha256(manifest.to_wire()) != contract_sha256:
            raise PluginInstallerError(
                "installation receipt manifest hash does not match"
            )
        return cls(
            installation_id=installation_id,
            bundle_sha256=bundle_sha256,
            bundle_size=_positive_int(
                bundle.get("size"),
                "installation receipt.bundle.size",
                maximum=MAX_BUNDLE_BYTES,
            ),
            manifest_sha256=manifest_sha256,
            manifest_contract_sha256=contract_sha256,
            manifest=manifest,
        )

    def to_wire(self) -> dict[str, Any]:
        return {
            "schemaVersion": RECEIPT_SCHEMA_VERSION,
            "installationId": self.installation_id,
            "bundle": {
                "sha256": self.bundle_sha256,
                "size": self.bundle_size,
                "manifestSha256": self.manifest_sha256,
            },
            "manifestContractSha256": self.manifest_contract_sha256,
            "manifest": self.manifest.to_wire(),
        }


@dataclass(frozen=True, slots=True)
class InstallResult:
    runtime_id: str
    version: str
    installation_id: str
    activation_id: str
    changed: bool
    reused_installation: bool
    installation_path: Path
    registry_path: Path

    def to_wire(self) -> dict[str, Any]:
        return {
            "runtimeId": self.runtime_id,
            "version": self.version,
            "installationId": self.installation_id,
            "activationId": self.activation_id,
            "changed": self.changed,
            "reusedInstallation": self.reused_installation,
            "installationPath": str(self.installation_path),
            "registryPath": str(self.registry_path),
            "restartRequired": self.changed,
        }


@dataclass(frozen=True, slots=True)
class CheckResult:
    runtime_id: str
    version: str
    installation_id: str
    activation_id: str
    bundle_sha256: str

    def to_wire(self) -> dict[str, Any]:
        return {
            "runtimeId": self.runtime_id,
            "version": self.version,
            "installationId": self.installation_id,
            "activationId": self.activation_id,
            "bundleSha256": self.bundle_sha256,
            "status": "ok",
        }


@dataclass(frozen=True, slots=True)
class RollbackResult:
    runtime_id: str
    from_activation_id: str
    to_activation_id: str | None
    removed: bool

    def to_wire(self) -> dict[str, Any]:
        return {
            "runtimeId": self.runtime_id,
            "fromActivationId": self.from_activation_id,
            "toActivationId": self.to_activation_id,
            "removed": self.removed,
            "changed": True,
            "restartRequired": True,
        }


class PluginInstaller:
    """Owns immutable installs and atomically commits one registry entry at a time."""

    def __init__(
        self,
        *,
        root: Path | str | None = None,
        registry_path: Path | str | None = None,
        python_executable: Path | str | None = None,
        host_name: str = "CandleScope",
        host_version: str = "0.3.0",
        lock_timeout_seconds: float = DEFAULT_INSTALL_LOCK_TIMEOUT_SECONDS,
    ) -> None:
        if registry_path is None:
            default_registry = default_runtime_registry_path()
            selected_root = (
                Path(root).expanduser() if root is not None else default_registry.parent
            )
            selected_registry = selected_root / default_registry.name
        else:
            selected_registry = Path(registry_path).expanduser()
            selected_root = (
                Path(root).expanduser()
                if root is not None
                else selected_registry.parent
            )
        self.root = selected_root.resolve(strict=False)
        self.registry_path = selected_registry.resolve(strict=False)
        if self.registry_path.parent != self.root:
            raise PluginInstallerError(
                "activation registry must be stored directly inside the managed plugin root"
            )
        self.python_executable = (
            Path(sys.executable if python_executable is None else python_executable)
            .expanduser()
            .resolve(strict=False)
        )
        self.host_name = _string(host_name, "host name", maximum=128)
        self.host_version = _string(host_version, "host version", maximum=128)
        if lock_timeout_seconds <= 0:
            raise PluginInstallerError("installer lock timeout must be positive")
        self.lock_timeout_seconds = float(lock_timeout_seconds)

    @property
    def installs_directory(self) -> Path:
        return self.root / "installs"

    @property
    def staging_directory(self) -> Path:
        return self.root / "staging"

    @property
    def quarantine_directory(self) -> Path:
        return self.root / "quarantine"

    @property
    def history_directory(self) -> Path:
        return self.root / "history"

    @property
    def lock_path(self) -> Path:
        return self.root / ".installer.lock"

    def install(
        self,
        bundle_path: Path | str,
        *,
        expected_sha256: str,
        enabled: bool = True,
        auto_start: bool = False,
        required: bool = False,
    ) -> InstallResult:
        bundle = verify_plugin_bundle(
            bundle_path,
            expected_sha256=normalize_expected_sha256(expected_sha256),
        )
        runtime_id = bundle.manifest.runtime_id
        python_version = self._python_version()
        if not bundle.manifest.python_requirement.supports(python_version):
            requirement = bundle.manifest.python_requirement.raw
            raise PluginInstallerError(
                f"plugin requires Python {requirement}, found {python_version[0]}.{python_version[1]}",
                runtime_id=runtime_id,
            )
        if required and (not enabled or not auto_start):
            raise PluginInstallerError(
                "required plugins must be enabled with auto-start",
                runtime_id=runtime_id,
            )
        if not enabled and auto_start:
            raise PluginInstallerError(
                "disabled plugins cannot use auto-start",
                runtime_id=runtime_id,
            )

        receipt = InstallationReceipt.from_bundle(bundle)
        final_path = self._installation_path(runtime_id, receipt.installation_id)
        reused = False
        with _installation_lock(self.lock_path, self.lock_timeout_seconds):
            registry = self._load_registry()
            if final_path.exists():
                installed_receipt = self._load_receipt(final_path)
                self._assert_receipt_matches_bundle(installed_receipt, receipt)
                self._verify_managed_environment(final_path, installed_receipt)
                reused = True
            else:
                self._create_installation(bundle, receipt, final_path)

            current = registry.by_id().get(runtime_id)
            if current is not None and current.managed is not None:
                candidate = self._build_spec(
                    receipt,
                    final_path,
                    activation_id=current.managed.activation_id,
                    enabled=enabled,
                    auto_start=auto_start,
                    required=required,
                )
                if candidate == current:
                    return InstallResult(
                        runtime_id=runtime_id,
                        version=receipt.manifest.version,
                        installation_id=receipt.installation_id,
                        activation_id=current.managed.activation_id,
                        changed=False,
                        reused_installation=reused,
                        installation_path=final_path,
                        registry_path=self.registry_path,
                    )

            activation_id = uuid.uuid4().hex
            activated = self._build_spec(
                receipt,
                final_path,
                activation_id=activation_id,
                enabled=enabled,
                auto_start=auto_start,
                required=required,
            )
            self._record_activation(current, activated)
            self._write_registry(self._replace_plugin(registry, activated))
            return InstallResult(
                runtime_id=runtime_id,
                version=receipt.manifest.version,
                installation_id=receipt.installation_id,
                activation_id=activation_id,
                changed=True,
                reused_installation=reused,
                installation_path=final_path,
                registry_path=self.registry_path,
            )

    def check(self, runtime_id: str) -> CheckResult:
        runtime_id = _string(runtime_id, "runtime ID", maximum=64)
        with _installation_lock(self.lock_path, self.lock_timeout_seconds):
            registry = self._load_registry()
            spec = registry.by_id().get(runtime_id)
            if spec is None:
                raise PluginInstallerError(
                    f"runtime {runtime_id!r} is not active", runtime_id=runtime_id
                )
            if spec.managed is None:
                raise PluginInstallerError(
                    f"runtime {runtime_id!r} is not installer-managed",
                    runtime_id=runtime_id,
                )
            installation_path = self._installation_path(
                runtime_id, spec.managed.installation_id
            )
            receipt = self._load_receipt(installation_path)
            self._assert_spec_matches_receipt(spec, receipt, installation_path)
            self._verify_managed_environment(installation_path, receipt, spec=spec)
            return CheckResult(
                runtime_id=runtime_id,
                version=spec.expected_version,
                installation_id=spec.managed.installation_id,
                activation_id=spec.managed.activation_id,
                bundle_sha256=spec.managed.bundle_sha256,
            )

    def list_plugins(self) -> tuple[dict[str, Any], ...]:
        with _installation_lock(self.lock_path, self.lock_timeout_seconds):
            registry = self._load_registry()
            return tuple(
                {
                    "runtimeId": spec.runtime_id,
                    "package": spec.expected_package,
                    "version": spec.expected_version,
                    "enabled": spec.enabled,
                    "autoStart": spec.auto_start,
                    "required": spec.required,
                    "managed": spec.managed is not None,
                    **(
                        {
                            "installationId": spec.managed.installation_id,
                            "activationId": spec.managed.activation_id,
                            "bundleSha256": spec.managed.bundle_sha256,
                        }
                        if spec.managed is not None
                        else {}
                    ),
                }
                for spec in registry.plugins
            )

    def rollback(self, runtime_id: str) -> RollbackResult:
        runtime_id = _string(runtime_id, "runtime ID", maximum=64)
        with _installation_lock(self.lock_path, self.lock_timeout_seconds):
            registry = self._load_registry()
            current = registry.by_id().get(runtime_id)
            if current is None:
                raise PluginInstallerError(
                    f"runtime {runtime_id!r} is not active", runtime_id=runtime_id
                )
            if current.managed is None:
                raise PluginInstallerError(
                    f"runtime {runtime_id!r} is not installer-managed",
                    runtime_id=runtime_id,
                )
            transaction = self._load_activation(current)
            before = self._transaction_before_spec(transaction, runtime_id)
            if before is not None:
                self._verify_rollback_target(before)
            audit_id = uuid.uuid4().hex
            self._record_rollback(audit_id, current, before)
            self._write_registry(
                self._replace_plugin(registry, before, runtime_id=runtime_id)
            )
            return RollbackResult(
                runtime_id=runtime_id,
                from_activation_id=current.managed.activation_id,
                to_activation_id=(
                    before.managed.activation_id
                    if before is not None and before.managed is not None
                    else None
                ),
                removed=before is None,
            )

    def _python_version(self) -> tuple[int, int]:
        output = _run_command(
            (
                str(self.python_executable),
                "-I",
                "-c",
                "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')",
            ),
            label="Python interpreter probe",
            timeout_seconds=15,
        )
        try:
            major, minor = output.decode("ascii").strip().split(".")
            return int(major), int(minor)
        except (UnicodeError, ValueError) as exc:
            raise PluginInstallerError(
                "Python interpreter returned an invalid version"
            ) from exc

    def _load_registry(self) -> RuntimeRegistry:
        try:
            return load_runtime_registry(self.registry_path, allow_missing=True)
        except PluginRegistryError as exc:
            raise PluginInstallerError(
                f"activation registry is invalid: {exc.message}"
            ) from exc

    def _write_registry(self, registry: RuntimeRegistry) -> None:
        payload = runtime_registry_to_wire(registry)
        try:
            runtime_registry_from_wire(payload, source=self.registry_path)
        except PluginRegistryError as exc:
            raise PluginInstallerError(
                f"refusing to write an invalid activation registry: {exc.message}"
            ) from exc
        _atomic_write_json(self.registry_path, payload)

    def _installation_path(self, runtime_id: str, installation_id: str) -> Path:
        if not _INSTALLATION_ID.fullmatch(installation_id):
            raise PluginInstallerError(
                "managed installation ID is invalid", runtime_id=runtime_id
            )
        return self.installs_directory / runtime_id / installation_id

    def _venv_python(self, installation_path: Path) -> Path:
        return installation_path / (
            "venv/Scripts/python.exe" if os.name == "nt" else "venv/bin/python"
        )

    def _receipt_path(self, installation_path: Path) -> Path:
        return installation_path / "receipt.json"

    def _load_receipt(self, installation_path: Path) -> InstallationReceipt:
        self._assert_safe_installation_directory(installation_path)
        try:
            return InstallationReceipt.from_wire(
                _read_json(
                    self._receipt_path(installation_path), "installation receipt"
                )
            )
        except PluginInstallerError as exc:
            raise PluginInstallerError(
                f"managed installation is invalid: {exc.message}"
            ) from exc

    def _assert_safe_installation_directory(self, installation_path: Path) -> None:
        expected_parent = self.installs_directory.resolve(strict=False)
        try:
            relative = installation_path.relative_to(self.installs_directory)
        except ValueError as exc:
            raise PluginInstallerError(
                "managed installation escapes the install root"
            ) from exc
        if len(relative.parts) != 2 or not installation_path.is_dir():
            raise PluginInstallerError(
                "managed installation directory is missing or invalid"
            )
        current = self.installs_directory
        for part in relative.parts:
            current = current / part
            if current.is_symlink():
                raise PluginInstallerError(
                    "managed installation must not use symbolic links"
                )
        if installation_path.resolve(strict=False).parent.parent != expected_parent:
            raise PluginInstallerError(
                "managed installation resolves outside the install root"
            )

    def _prepare_runtime_install_directory(self, installation_path: Path) -> None:
        self.installs_directory.mkdir(parents=True, exist_ok=True)
        if self.installs_directory.is_symlink():
            raise PluginInstallerError(
                "managed install root must not be a symbolic link"
            )
        runtime_directory = installation_path.parent
        runtime_directory.mkdir(parents=True, exist_ok=True)
        if runtime_directory.is_symlink():
            raise PluginInstallerError(
                "managed runtime directory must not be a symbolic link"
            )
        if runtime_directory.resolve(
            strict=False
        ).parent != self.installs_directory.resolve(strict=False):
            raise PluginInstallerError(
                "managed runtime directory resolves outside the install root"
            )

    def _assert_receipt_matches_bundle(
        self,
        installed: InstallationReceipt,
        expected: InstallationReceipt,
    ) -> None:
        if installed.to_wire() != expected.to_wire():
            raise PluginInstallerError(
                "existing immutable installation does not match the verified bundle",
                runtime_id=expected.manifest.runtime_id,
            )

    def _create_installation(
        self,
        bundle: VerifiedBundle,
        receipt: InstallationReceipt,
        final_path: Path,
    ) -> None:
        self.staging_directory.mkdir(parents=True, exist_ok=True)
        staging = self.staging_directory / f"install-{uuid.uuid4().hex}.part"
        moved_to_final = False
        try:
            staging.mkdir()
            wheels_directory = staging / "wheels"
            wheels = bundle.extract_wheels(wheels_directory)
            self._create_venv(staging)
            self._install_wheels(staging, wheels)
            self._verify_distributions(self._venv_python(staging), receipt.manifest)
            self._probe(self._build_probe_spec(receipt, staging), receipt.manifest)
            _atomic_write_json(self._receipt_path(staging), receipt.to_wire())
            self._remove_wheel_cache(wheels_directory)
            self._prepare_runtime_install_directory(final_path)
            if final_path.exists():
                raise PluginInstallerError(
                    "immutable installation appeared concurrently",
                    runtime_id=receipt.manifest.runtime_id,
                )
            _rename_directory(staging, final_path)
            moved_to_final = True
            _fsync_directory(final_path.parent)
            self._verify_managed_environment(final_path, receipt)
        except (OSError, PluginHostError) as exc:
            if moved_to_final:
                self._quarantine(final_path, receipt.manifest.runtime_id)
            if isinstance(exc, (PluginInstallerError, PluginBundleError)):
                raise
            if isinstance(exc, PluginHostError):
                raise PluginInstallerError(
                    f"runtime probe failed: {exc.message}",
                    runtime_id=receipt.manifest.runtime_id,
                    details={"causeCode": exc.code},
                ) from exc
            raise PluginInstallerError(
                f"unable to create immutable installation: {exc}",
                runtime_id=receipt.manifest.runtime_id,
            ) from exc
        finally:
            self._remove_staging(staging)

    def _create_venv(self, installation_path: Path) -> None:
        _run_command(
            (
                str(self.python_executable),
                "-I",
                "-m",
                "venv",
                str(installation_path / "venv"),
            ),
            label="isolated virtual environment creation",
            timeout_seconds=180,
            cwd=installation_path,
        )
        venv_python = self._venv_python(installation_path)
        if not venv_python.is_file():
            raise PluginInstallerError(
                "virtual environment did not create a Python executable"
            )

    def _install_wheels(self, installation_path: Path, wheels: Sequence[Path]) -> None:
        venv_python = self._venv_python(installation_path)
        _run_command(
            (
                str(venv_python),
                "-I",
                "-m",
                "pip",
                "--isolated",
                "install",
                "--disable-pip-version-check",
                "--no-index",
                "--no-deps",
                "--only-binary=:all:",
                *(str(path) for path in wheels),
            ),
            label="offline wheel installation",
            timeout_seconds=300,
            cwd=installation_path,
        )
        self._pip_check(venv_python, installation_path)

    def _pip_check(self, venv_python: Path, installation_path: Path) -> None:
        _run_command(
            (str(venv_python), "-I", "-m", "pip", "--isolated", "check"),
            label="installed dependency check",
            timeout_seconds=120,
            cwd=installation_path,
        )

    def _verify_distributions(
        self,
        venv_python: Path,
        manifest: BundleManifest,
    ) -> None:
        script = (
            "import importlib.metadata as m,json,sys;"
            "print(json.dumps({name:m.version(name) for name in sys.argv[1:]},sort_keys=True))"
        )
        packages = tuple(wheel.package for wheel in manifest.wheels)
        output = _run_command(
            (str(venv_python), "-I", "-c", script, *packages),
            label="installed distribution verification",
            timeout_seconds=30,
        )
        try:
            installed = json.loads(
                output.decode("utf-8"),
                parse_constant=_reject_json_constant,
                object_pairs_hook=_unique_json_object,
            )
        except (UnicodeError, json.JSONDecodeError, ValueError) as exc:
            raise PluginInstallerError(
                "installed distribution verification returned invalid JSON"
            ) from exc
        expected = {wheel.package: wheel.version for wheel in manifest.wheels}
        if installed != expected:
            raise PluginInstallerError(
                "installed distribution versions do not match the bundle",
                runtime_id=manifest.runtime_id,
                details={"expected": expected, "installed": installed},
            )

    def _verify_managed_environment(
        self,
        installation_path: Path,
        receipt: InstallationReceipt,
        *,
        spec: RuntimeProcessSpec | None = None,
    ) -> None:
        self._assert_safe_installation_directory(installation_path)
        if spec is not None:
            self._assert_spec_matches_receipt(spec, receipt, installation_path)
        venv_python = self._venv_python(installation_path)
        if not venv_python.is_file():
            raise PluginInstallerError(
                "managed virtual environment Python executable is missing",
                runtime_id=receipt.manifest.runtime_id,
            )
        self._verify_distributions(venv_python, receipt.manifest)
        self._pip_check(venv_python, installation_path)
        self._probe(
            self._build_probe_spec(receipt, installation_path), receipt.manifest
        )

    def _build_probe_spec(
        self,
        receipt: InstallationReceipt,
        installation_path: Path,
    ) -> RuntimeProcessSpec:
        return RuntimeProcessSpec(
            runtime_id=receipt.manifest.runtime_id,
            expected_package=receipt.manifest.package,
            expected_version=receipt.manifest.version,
            executable=self._venv_python(installation_path),
            arguments=("-I", "-u", "-m", receipt.manifest.module),
            working_directory=installation_path,
            startup_timeout_seconds=15.0,
            request_timeout_seconds=30.0,
            shutdown_timeout_seconds=2.0,
            max_restart_attempts=0,
        )

    def _build_spec(
        self,
        receipt: InstallationReceipt,
        installation_path: Path,
        *,
        activation_id: str,
        enabled: bool,
        auto_start: bool,
        required: bool,
    ) -> RuntimeProcessSpec:
        return RuntimeProcessSpec(
            runtime_id=receipt.manifest.runtime_id,
            expected_package=receipt.manifest.package,
            expected_version=receipt.manifest.version,
            executable=self._venv_python(installation_path),
            arguments=("-I", "-u", "-m", receipt.manifest.module),
            working_directory=installation_path,
            enabled=enabled,
            auto_start=auto_start,
            required=required,
            managed=ManagedRuntimeIdentity(
                installation_id=receipt.installation_id,
                activation_id=activation_id,
                bundle_sha256=receipt.bundle_sha256,
            ),
        )

    def _probe(self, spec: RuntimeProcessSpec, manifest: BundleManifest) -> None:
        async def run() -> None:
            supervisor = RuntimeSupervisor(
                replace(spec, enabled=True, auto_start=False, required=False),
                host_name=self.host_name,
                host_version=self.host_version,
            )
            try:
                await supervisor.start()
                analysis = await supervisor.analyze(manifest.probe.analyze_request)
                execution = await supervisor.execute_batch(
                    manifest.probe.execute_request
                )
                actual_analysis = canonical_sha256(analysis.to_wire())
                actual_execution = canonical_sha256(execution.to_wire())
                if actual_analysis != manifest.probe.analysis_sha256:
                    raise PluginInstallerError(
                        "runtime analysis probe hash does not match the bundle manifest",
                        runtime_id=manifest.runtime_id,
                        details={
                            "expected": manifest.probe.analysis_sha256,
                            "actual": actual_analysis,
                        },
                    )
                if actual_execution != manifest.probe.execution_sha256:
                    raise PluginInstallerError(
                        "runtime execution probe hash does not match the bundle manifest",
                        runtime_id=manifest.runtime_id,
                        details={
                            "expected": manifest.probe.execution_sha256,
                            "actual": actual_execution,
                        },
                    )
            finally:
                await supervisor.stop()

        try:
            asyncio.get_running_loop()
        except RuntimeError:
            pass
        else:
            raise PluginInstallerError(
                "plugin installation cannot run inside an active asyncio event loop"
            )
        try:
            asyncio.run(run())
        except PluginInstallerError:
            raise
        except PluginHostError as exc:
            raise PluginInstallerError(
                f"runtime protocol probe failed: {exc.message}",
                runtime_id=manifest.runtime_id,
                details={"causeCode": exc.code},
            ) from exc

    def _assert_spec_matches_receipt(
        self,
        spec: RuntimeProcessSpec,
        receipt: InstallationReceipt,
        installation_path: Path,
    ) -> None:
        managed = spec.managed
        if managed is None:
            raise PluginInstallerError("runtime activation is not installer-managed")
        expected = self._build_spec(
            receipt,
            installation_path,
            activation_id=managed.activation_id,
            enabled=spec.enabled,
            auto_start=spec.auto_start,
            required=spec.required,
        )
        if expected != spec:
            raise PluginInstallerError(
                "managed activation does not match its immutable installation receipt",
                runtime_id=spec.runtime_id,
            )

    def _record_activation(
        self,
        before: RuntimeProcessSpec | None,
        after: RuntimeProcessSpec,
    ) -> None:
        assert after.managed is not None
        path = (
            self.history_directory
            / after.runtime_id
            / "activations"
            / f"{after.managed.activation_id}.json"
        )
        _atomic_write_json(
            path,
            {
                "schemaVersion": ACTIVATION_HISTORY_SCHEMA_VERSION,
                "operation": "install",
                "runtimeId": after.runtime_id,
                "activationId": after.managed.activation_id,
                "createdAt": _utc_now(),
                "before": (
                    runtime_process_spec_to_wire(before) if before is not None else None
                ),
                "after": runtime_process_spec_to_wire(after),
            },
            replace_existing=False,
        )

    def _load_activation(self, current: RuntimeProcessSpec) -> Mapping[str, Any]:
        assert current.managed is not None
        path = (
            self.history_directory
            / current.runtime_id
            / "activations"
            / f"{current.managed.activation_id}.json"
        )
        transaction = _read_json(path, "activation history")
        _only_keys(
            transaction,
            {
                "schemaVersion",
                "operation",
                "runtimeId",
                "activationId",
                "createdAt",
                "before",
                "after",
            },
            "activation history",
        )
        if (
            transaction.get("schemaVersion") != ACTIVATION_HISTORY_SCHEMA_VERSION
            or transaction.get("operation") != "install"
            or transaction.get("runtimeId") != current.runtime_id
            or transaction.get("activationId") != current.managed.activation_id
            or transaction.get("after") != runtime_process_spec_to_wire(current)
        ):
            raise PluginInstallerError(
                "activation history does not match the current registry entry",
                runtime_id=current.runtime_id,
            )
        _string(
            transaction.get("createdAt"), "activation history.createdAt", maximum=64
        )
        return transaction

    def _transaction_before_spec(
        self,
        transaction: Mapping[str, Any],
        runtime_id: str,
    ) -> RuntimeProcessSpec | None:
        before = transaction.get("before")
        if before is None:
            return None
        try:
            registry = runtime_registry_from_wire(
                {"schemaVersion": 1, "plugins": [before]}
            )
        except PluginRegistryError as exc:
            raise PluginInstallerError(
                f"rollback target is invalid: {exc.message}", runtime_id=runtime_id
            ) from exc
        target = registry.plugins[0]
        if target.runtime_id != runtime_id:
            raise PluginInstallerError(
                "rollback target belongs to a different runtime", runtime_id=runtime_id
            )
        return target

    def _verify_rollback_target(self, target: RuntimeProcessSpec) -> None:
        if target.managed is None:
            self._probe_unmanaged(target)
            return
        installation_path = self._installation_path(
            target.runtime_id, target.managed.installation_id
        )
        receipt = self._load_receipt(installation_path)
        self._assert_spec_matches_receipt(target, receipt, installation_path)
        self._verify_managed_environment(installation_path, receipt, spec=target)

    def _probe_unmanaged(self, target: RuntimeProcessSpec) -> None:
        async def run() -> None:
            supervisor = RuntimeSupervisor(
                replace(target, enabled=True, auto_start=False, required=False),
                host_name=self.host_name,
                host_version=self.host_version,
            )
            try:
                await supervisor.start()
            finally:
                await supervisor.stop()

        try:
            asyncio.run(run())
        except PluginHostError as exc:
            raise PluginInstallerError(
                f"unmanaged rollback target failed its protocol probe: {exc.message}",
                runtime_id=target.runtime_id,
                details={"causeCode": exc.code},
            ) from exc

    def _record_rollback(
        self,
        audit_id: str,
        before: RuntimeProcessSpec,
        after: RuntimeProcessSpec | None,
    ) -> None:
        path = (
            self.history_directory / before.runtime_id / "events" / f"{audit_id}.json"
        )
        _atomic_write_json(
            path,
            {
                "schemaVersion": ACTIVATION_HISTORY_SCHEMA_VERSION,
                "operation": "rollback",
                "eventId": audit_id,
                "runtimeId": before.runtime_id,
                "createdAt": _utc_now(),
                "before": runtime_process_spec_to_wire(before),
                "after": (
                    runtime_process_spec_to_wire(after) if after is not None else None
                ),
            },
            replace_existing=False,
        )

    def _replace_plugin(
        self,
        registry: RuntimeRegistry,
        replacement: RuntimeProcessSpec | None,
        *,
        runtime_id: str | None = None,
    ) -> RuntimeRegistry:
        selected_id = replacement.runtime_id if replacement is not None else runtime_id
        if selected_id is None:
            raise PluginInstallerError("registry replacement requires a runtime ID")
        plugins: list[RuntimeProcessSpec] = []
        found = False
        for plugin in registry.plugins:
            if plugin.runtime_id == selected_id:
                found = True
                if replacement is not None:
                    plugins.append(replacement)
            else:
                plugins.append(plugin)
        if not found and replacement is not None:
            plugins.append(replacement)
        return RuntimeRegistry(plugins=tuple(plugins), source=self.registry_path)

    def _remove_wheel_cache(self, path: Path) -> None:
        if path.parent.parent != self.staging_directory:
            raise PluginInstallerError("refusing to remove wheels outside staging")
        if path.is_symlink() or path.resolve(
            strict=False
        ).parent != path.parent.resolve(strict=False):
            raise PluginInstallerError("refusing to remove a redirected wheel cache")
        shutil.rmtree(path)

    def _remove_staging(self, path: Path) -> None:
        try:
            if path.parent != self.staging_directory or not path.name.endswith(".part"):
                raise PluginInstallerError("refusing to clean an unsafe staging path")
            if path.is_symlink():
                path.unlink()
            elif path.exists():
                if path.resolve(strict=False).parent != self.staging_directory.resolve(
                    strict=False
                ):
                    raise PluginInstallerError(
                        "refusing to clean a redirected staging directory"
                    )
                shutil.rmtree(path)
        except FileNotFoundError:
            pass
        except OSError as exc:
            raise PluginInstallerError(
                f"unable to clean installer staging: {exc}"
            ) from exc

    def _quarantine(self, path: Path, runtime_id: str) -> None:
        target = (
            self.quarantine_directory / runtime_id / f"{path.name}-{uuid.uuid4().hex}"
        )
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            _rename_directory(path, target)
            _fsync_directory(target.parent)
        except OSError as exc:
            raise PluginInstallerError(
                f"failed installation could not be quarantined: {exc}",
                runtime_id=runtime_id,
            ) from exc


__all__ = [
    "ACTIVATION_HISTORY_SCHEMA_VERSION",
    "CheckResult",
    "InstallResult",
    "InstallationReceipt",
    "PluginInstaller",
    "RECEIPT_SCHEMA_VERSION",
    "RollbackResult",
]
