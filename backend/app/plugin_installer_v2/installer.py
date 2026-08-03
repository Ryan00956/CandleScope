"""Content-addressed installation store and atomic activation registry v2."""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any

from candlescope_plugin_sdk.platform_v2 import (
    MANIFEST_SCHEMA_VERSION_V3,
    PlatformContractError,
    PythonModuleRuntime,
    canonical_dumps,
    loads_strict,
)

from app.plugin_security_v2 import AuditLog, GrantStore
from app.plugin_security_v2.grants import (
    GrantDocument,
    GrantMutationResult,
    PermissionDiff,
    PluginGrantRecord,
)
from app.plugin_security_v2.sandbox import SandboxPolicy
from app.plugin_security_v2.storage import security_lock

from .bundle import (
    DEFAULT_HOST_VERSION,
    ContentRecord,
    VerifiedPlatformBundle,
    inspect_platform_bundle,
    verify_platform_bundle,
)
from .errors import (
    PlatformBundleError,
    PlatformInstallerBaseError,
    PlatformInstallerError,
    MultiRuntimeFeatureDisabledError,
    RuntimeProviderReceiptMismatchError,
    RuntimeProviderUnavailableError,
)
from .registry import (
    LEGACY_REGISTRY_FILE_NAME,
    REGISTRY_FILE_NAME,
    REGISTRY_SCHEMA_VERSION_V3,
    REGISTRY_SCHEMA_VERSION_V4,
    ActivationRecord,
    ActivationRegistry,
    EntrypointActivation,
    load_activation_registry,
)


LEGACY_RECEIPT_SCHEMA_VERSION = 2
RECEIPT_SCHEMA_VERSION = 3
MANAGED_RUNTIME_RECEIPT_SCHEMA_VERSION = 4
HISTORY_SCHEMA_VERSION = 2
STATE_TRANSACTION_SCHEMA_VERSION = 1
MAX_STATE_JSON_BYTES = 4 * 1024 * 1024
MAX_STATE_TRANSACTION_JSON_BYTES = 24 * 1024 * 1024
DEFAULT_INSTALL_LOCK_TIMEOUT_SECONDS = 30.0
DEFAULT_COMMAND_OUTPUT_BYTES = 1024 * 1024
PROBE_RUNNER = Path(__file__).with_name("probe_runner.py").resolve()
_STATE_TRANSACTION_ID = re.compile(r"^state-[0-9a-f]{32}$")
_PLUGIN_ID = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$")
_RUNTIME_KIND = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
_PROVIDER_VERSION = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")
_SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
MULTI_RUNTIME_ENABLED_ENV = "CANDLESCOPE_PLUGIN_MULTI_RUNTIME_ENABLED"
RUNTIME_PROVIDER_SEAM_ENABLED_ENV = "CANDLESCOPE_PLUGIN_RUNTIME_PROVIDER_SEAM_ENABLED"
NATIVE_RUNTIME_ENABLED_ENV = "CANDLESCOPE_PLUGIN_RUNTIME_NATIVE_ENABLED"
JAVA_RUNTIME_ENABLED_ENV = "CANDLESCOPE_PLUGIN_RUNTIME_JAVA_ENABLED"

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


def _environment_bool(name: str, *, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise PlatformInstallerError(
        f"{name} must be one of 1/0, true/false, yes/no, or on/off"
    )


def _mapping(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise PlatformInstallerError(f"{label} must be a JSON object")
    return value


def _json_bytes(value: Any) -> bytes:
    try:
        return (canonical_dumps(value) + "\n").encode("utf-8")
    except PlatformContractError as exc:
        raise PlatformInstallerError(
            "installer state is not canonical JSON",
            details={"contractCode": exc.code, "path": exc.path},
        ) from exc


def _read_json(
    path: Path,
    label: str,
    *,
    maximum_bytes: int = MAX_STATE_JSON_BYTES,
) -> Mapping[str, Any]:
    try:
        if path.is_symlink() or not path.is_file():
            raise PlatformInstallerError(f"{label} must be a regular file")
        size = path.stat().st_size
        if not 0 < size <= maximum_bytes:
            raise PlatformInstallerError(f"{label} has an invalid size")
        value = loads_strict(path.read_bytes())
    except PlatformInstallerError:
        raise
    except (OSError, PlatformContractError) as exc:
        raise PlatformInstallerError(f"unable to read {label}: {exc}") from exc
    return _mapping(value, label)


def _grant_record_sha256(record: PluginGrantRecord | None) -> str:
    payload = canonical_dumps(record.to_wire() if record is not None else None)
    return f"sha256:{hashlib.sha256(payload.encode('utf-8')).hexdigest()}"


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


def _rename_directory(source: Path, destination: Path) -> None:
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


def _atomic_write_json(
    path: Path,
    value: Any,
    *,
    replace_existing: bool = True,
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
            raise PlatformInstallerError(f"installer state already exists: {path.name}")
        _replace_file(temporary, path)
        _fsync_directory(path.parent)
    except PlatformInstallerError:
        raise
    except OSError as exc:
        raise PlatformInstallerError(
            f"unable to atomically write {path.name}: {exc}"
        ) from exc
    finally:
        try:
            temporary.unlink()
        except OSError:
            pass


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
        raise PlatformInstallerError(f"{label} could not complete: {exc}") from exc
    if completed.returncode != 0:
        raise PlatformInstallerError(
            f"{label} failed with exit code {completed.returncode}",
            details={"stderr": _decode_output(completed.stderr)},
        )
    if len(completed.stdout) > DEFAULT_COMMAND_OUTPUT_BYTES:
        raise PlatformInstallerError(f"{label} produced too much output")
    return completed.stdout


@contextmanager
def _installation_lock(path: Path, timeout_seconds: float) -> Iterator[None]:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        handle = path.open("a+b")
    except OSError as exc:
        raise PlatformInstallerError(f"unable to open installer lock: {exc}") from exc
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
                    raise PlatformInstallerError(
                        f"timed out waiting for installer lock after {timeout_seconds:g}s"
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


def _default_root() -> Path:
    if os.name == "nt" and os.environ.get("LOCALAPPDATA"):
        return Path(os.environ["LOCALAPPDATA"]) / "CandleScope" / "plugin-platform-v2"
    return Path.home() / ".candlescope" / "plugin-platform-v2"


def _hash_path(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
                size += len(chunk)
    except OSError as exc:
        raise PlatformInstallerError(f"unable to hash managed content: {exc}") from exc
    return f"sha256:{digest.hexdigest()}", size


@dataclass(frozen=True, slots=True)
class InstallationReceipt:
    installation_id: str
    bundle_sha256: str
    bundle_size: int
    envelope_sha256: str
    manifest_sha256: str
    manifest_contract_sha256: str
    plugin_id: str
    version: str
    publisher: str
    created_at: str
    wheels: tuple[dict[str, Any], ...]
    probe: dict[str, Any]
    runtime_providers: tuple[dict[str, Any], ...] = ()
    schema_version: int = RECEIPT_SCHEMA_VERSION

    @classmethod
    def from_bundle(
        cls,
        bundle: VerifiedPlatformBundle,
        *,
        probe: Mapping[str, Any],
        runtime_providers: Sequence[Mapping[str, Any]] | None = None,
    ) -> "InstallationReceipt":
        providers = (
            tuple(dict(item) for item in runtime_providers)
            if runtime_providers is not None
            else ()
        )
        return cls(
            installation_id=bundle.installation_id,
            bundle_sha256=bundle.sha256,
            bundle_size=bundle.size,
            envelope_sha256=bundle.envelope_sha256,
            manifest_sha256=bundle.manifest_sha256,
            manifest_contract_sha256=bundle.manifest.canonical_sha256,
            plugin_id=bundle.manifest.plugin.id,
            version=bundle.manifest.plugin.version,
            publisher=bundle.manifest.plugin.publisher,
            created_at=_utc_now(),
            wheels=tuple(item.to_wire() for item in bundle.wheels),
            probe=dict(probe),
            runtime_providers=providers,
            schema_version=(
                (
                    MANAGED_RUNTIME_RECEIPT_SCHEMA_VERSION
                    if any("runtimeSupply" in item for item in providers)
                    else RECEIPT_SCHEMA_VERSION
                )
                if runtime_providers is not None
                else LEGACY_RECEIPT_SCHEMA_VERSION
            ),
        )

    def to_wire(self) -> dict[str, Any]:
        return {
            "schemaVersion": self.schema_version,
            "installationId": self.installation_id,
            "bundleSha256": self.bundle_sha256,
            "bundleSize": self.bundle_size,
            "envelopeSha256": self.envelope_sha256,
            "manifestSha256": self.manifest_sha256,
            "manifestContractSha256": self.manifest_contract_sha256,
            "pluginId": self.plugin_id,
            "version": self.version,
            "publisher": self.publisher,
            "createdAt": self.created_at,
            "wheels": list(self.wheels),
            "probe": dict(self.probe),
            **(
                {"runtimeProviders": [dict(item) for item in self.runtime_providers]}
                if self.schema_version
                in {RECEIPT_SCHEMA_VERSION, MANAGED_RUNTIME_RECEIPT_SCHEMA_VERSION}
                else {}
            ),
        }

    @classmethod
    def from_wire(cls, value: Any) -> "InstallationReceipt":
        data = _mapping(value, "installation receipt")
        common = {
            "schemaVersion",
            "installationId",
            "bundleSha256",
            "bundleSize",
            "envelopeSha256",
            "manifestSha256",
            "manifestContractSha256",
            "pluginId",
            "version",
            "publisher",
            "createdAt",
            "wheels",
            "probe",
        }
        schema_version = data.get("schemaVersion")
        expected = (
            common | {"runtimeProviders"}
            if schema_version
            in {RECEIPT_SCHEMA_VERSION, MANAGED_RUNTIME_RECEIPT_SCHEMA_VERSION}
            else common
        )
        if (
            schema_version
            not in {
                LEGACY_RECEIPT_SCHEMA_VERSION,
                RECEIPT_SCHEMA_VERSION,
                MANAGED_RUNTIME_RECEIPT_SCHEMA_VERSION,
            }
            or set(data) != expected
        ):
            raise PlatformInstallerError("installation receipt schema is invalid")
        scalar_strings = [
            "installationId",
            "bundleSha256",
            "envelopeSha256",
            "manifestSha256",
            "manifestContractSha256",
            "pluginId",
            "version",
            "publisher",
            "createdAt",
        ]
        if not all(isinstance(data[key], str) and data[key] for key in scalar_strings):
            raise PlatformInstallerError(
                "installation receipt contains invalid strings"
            )
        if (
            isinstance(data["bundleSize"], bool)
            or not isinstance(data["bundleSize"], int)
            or data["bundleSize"] <= 0
        ):
            raise PlatformInstallerError("installation receipt bundleSize is invalid")
        if not isinstance(data["wheels"], list) or not all(
            isinstance(item, dict) for item in data["wheels"]
        ):
            raise PlatformInstallerError("installation receipt wheels are invalid")
        raw_providers = data.get("runtimeProviders", [])
        provider_keys = {
            "runtimeKind",
            "runtimeId",
            "providerVersion",
            "runtimeIdentity",
        }
        managed_provider_keys = provider_keys | {"runtimeSupply"}
        from app.plugin_core_v2.runtime_providers import RuntimeSupplyBinding

        def provider_valid(item: Any) -> bool:
            if not isinstance(item, dict):
                return False
            expected_keys = (
                managed_provider_keys if "runtimeSupply" in item else provider_keys
            )
            if set(item) != expected_keys:
                return False
            if not all(
                isinstance(item[key], str) and item[key] for key in provider_keys
            ):
                return False
            if (
                _RUNTIME_KIND.fullmatch(item["runtimeKind"]) is None
                or _PLUGIN_ID.fullmatch(item["runtimeId"]) is None
                or _PROVIDER_VERSION.fullmatch(item["providerVersion"]) is None
                or _SHA256.fullmatch(item["runtimeIdentity"]) is None
            ):
                return False
            if "runtimeSupply" in item:
                try:
                    supply = RuntimeSupplyBinding.from_wire(
                        item["runtimeSupply"],
                        label="installation receipt runtimeSupply",
                    )
                except ValueError:
                    return False
                expected_supply_kind = {
                    "java-jar": "java",
                    "node-module": "node",
                    "wasm-component": "wasm",
                }.get(item["runtimeKind"])
                if (
                    expected_supply_kind != supply.runtime_kind
                    or supply.runtime_id != item["runtimeId"]
                ):
                    return False
            return True

        if (
            not isinstance(raw_providers, list)
            or (
                schema_version
                in {RECEIPT_SCHEMA_VERSION, MANAGED_RUNTIME_RECEIPT_SCHEMA_VERSION}
                and not raw_providers
            )
            or not all(provider_valid(item) for item in raw_providers)
            or (
                schema_version == RECEIPT_SCHEMA_VERSION
                and any("runtimeSupply" in item for item in raw_providers)
            )
            or (
                schema_version == MANAGED_RUNTIME_RECEIPT_SCHEMA_VERSION
                and not any("runtimeSupply" in item for item in raw_providers)
            )
            or [(item["runtimeKind"], item["runtimeId"]) for item in raw_providers]
            != sorted(
                {(item["runtimeKind"], item["runtimeId"]) for item in raw_providers}
            )
        ):
            raise PlatformInstallerError(
                "installation receipt runtimeProviders are invalid"
            )
        return cls(
            installation_id=data["installationId"],
            bundle_sha256=data["bundleSha256"],
            bundle_size=data["bundleSize"],
            envelope_sha256=data["envelopeSha256"],
            manifest_sha256=data["manifestSha256"],
            manifest_contract_sha256=data["manifestContractSha256"],
            plugin_id=data["pluginId"],
            version=data["version"],
            publisher=data["publisher"],
            created_at=data["createdAt"],
            wheels=tuple(dict(item) for item in data["wheels"]),
            probe=dict(_mapping(data["probe"], "installation receipt probe")),
            runtime_providers=tuple(dict(item) for item in raw_providers),
            schema_version=schema_version,
        )

    def assert_bundle(self, bundle: VerifiedPlatformBundle) -> None:
        actual = {
            "installationId": bundle.installation_id,
            "bundleSha256": bundle.sha256,
            "bundleSize": bundle.size,
            "envelopeSha256": bundle.envelope_sha256,
            "manifestSha256": bundle.manifest_sha256,
            "manifestContractSha256": bundle.manifest.canonical_sha256,
            "pluginId": bundle.manifest.plugin.id,
            "version": bundle.manifest.plugin.version,
            "publisher": bundle.manifest.plugin.publisher,
            "wheels": [item.to_wire() for item in bundle.wheels],
        }
        expected = {key: self.to_wire()[key] for key in actual}
        if expected != actual:
            raise PlatformInstallerError(
                "immutable installation receipt does not match its stored bundle",
                plugin_id=self.plugin_id,
            )

    def assert_runtime_providers(
        self,
        runtime_providers: Sequence[Mapping[str, Any]],
    ) -> None:
        if self.schema_version == LEGACY_RECEIPT_SCHEMA_VERSION:
            return
        actual = tuple(dict(item) for item in runtime_providers)
        if self.runtime_providers != actual:
            raise RuntimeProviderReceiptMismatchError(plugin_id=self.plugin_id)


@dataclass(frozen=True, slots=True)
class InstallResult:
    plugin_id: str
    installation_id: str
    activation_id: str
    state: str
    enabled: bool
    restart_required: bool
    changed: bool
    reused_installation: bool
    installation_path: Path
    registry_path: Path
    permission_diff: dict[str, Any]
    grant_store_revision: int
    grant_record_sha256: str
    activation_ready: bool

    def to_wire(self) -> dict[str, Any]:
        return {
            "pluginId": self.plugin_id,
            "installationId": self.installation_id,
            "activationId": self.activation_id,
            "state": self.state,
            "enabled": self.enabled,
            "restartRequired": self.restart_required,
            "changed": self.changed,
            "reusedInstallation": self.reused_installation,
            "installationPath": str(self.installation_path),
            "registryPath": str(self.registry_path),
            "permissionDiff": dict(self.permission_diff),
            "grantStoreRevision": self.grant_store_revision,
            "activationReady": self.activation_ready,
        }


@dataclass(frozen=True, slots=True)
class ActivationStateSnapshot:
    """Host-only savepoint for compensating one immediately preceding install."""

    registry_path: Path
    grant_store_path: Path
    plugin_id: str
    registry_present: bool
    activation: ActivationRecord | None
    grant_store_present: bool
    grant: PluginGrantRecord | None


@dataclass(frozen=True, slots=True)
class _StateRecoveryTarget:
    """Exact durable state that an interrupted transaction must converge to."""

    registry_present: bool
    registry: ActivationRegistry
    grant_store_present: bool
    grants: GrantDocument

    def to_wire(self) -> dict[str, Any]:
        return {
            "registryPresent": self.registry_present,
            "registry": self.registry.to_wire(),
            "grantStorePresent": self.grant_store_present,
            "grants": self.grants.to_wire(),
        }


@dataclass(frozen=True, slots=True)
class CheckResult:
    plugin_id: str
    installation_id: str
    bundle_sha256: str
    state: str
    probe: dict[str, Any]

    def to_wire(self) -> dict[str, Any]:
        return {
            "pluginId": self.plugin_id,
            "installationId": self.installation_id,
            "bundleSha256": self.bundle_sha256,
            "state": self.state,
            "freshProcessProbe": dict(self.probe),
        }


@dataclass(frozen=True, slots=True)
class RollbackResult:
    plugin_id: str
    from_activation_id: str
    to_activation_id: str | None
    removed: bool
    registry_path: Path

    def to_wire(self) -> dict[str, Any]:
        return {
            "pluginId": self.plugin_id,
            "fromActivationId": self.from_activation_id,
            "toActivationId": self.to_activation_id,
            "removed": self.removed,
            "restartRequired": True,
            "registryPath": str(self.registry_path),
        }


@dataclass(frozen=True, slots=True)
class StateChangeResult:
    plugin_id: str
    previous_state: str
    state: str | None
    activation_id: str | None
    changed: bool
    installation_retained: bool = True

    def to_wire(self) -> dict[str, Any]:
        return {
            "pluginId": self.plugin_id,
            "previousState": self.previous_state,
            "state": self.state,
            "activationId": self.activation_id,
            "changed": self.changed,
            "restartRequired": self.changed,
            "installationRetained": self.installation_retained,
        }


@dataclass(frozen=True, slots=True)
class PermissionChangeResult:
    mutation: GrantMutationResult
    activation_state: str
    activation_id: str
    activation_ready: bool
    state_changed: bool

    def to_wire(self) -> dict[str, Any]:
        return {
            "grant": self.mutation.to_wire(),
            "activationState": self.activation_state,
            "activationId": self.activation_id,
            "activationReady": self.activation_ready,
            "stateChanged": self.state_changed,
            "restartRequired": self.state_changed
            or (self.mutation.changed and self.activation_state == "active"),
        }


class PlatformPluginInstaller:
    """Own platform installs without touching the distinct v1 registry."""

    def __init__(
        self,
        *,
        root: Path | str | None = None,
        registry_path: Path | str | None = None,
        python_executable: Path | str | None = None,
        host_version: str = DEFAULT_HOST_VERSION,
        lock_timeout_seconds: float = DEFAULT_INSTALL_LOCK_TIMEOUT_SECONDS,
        audit_log: AuditLog | None = None,
        grant_store: GrantStore | None = None,
        publisher_identity_resolver: (
            Callable[[VerifiedPlatformBundle], str] | None
        ) = None,
        execution_trust_resolver: (
            Callable[[VerifiedPlatformBundle], str] | None
        ) = None,
        probe_sandbox_factory: (
            Callable[[VerifiedPlatformBundle, Path, str], SandboxPolicy] | None
        ) = None,
        probe_python_runtime_factory: (
            Callable[[VerifiedPlatformBundle, Path], tuple[Path, Path]] | None
        ) = None,
        multi_runtime_enabled: bool | None = None,
        runtime_provider_seam_enabled: bool | None = None,
        native_runtime_enabled: bool | None = None,
        java_runtime_enabled: bool | None = None,
        runtime_provider_registry: Any | None = None,
        managed_runtime_registry: Any | None = None,
    ) -> None:
        self.root = Path(root or _default_root()).expanduser().resolve(strict=False)
        self.registry_path = (
            Path(registry_path or self.root / REGISTRY_FILE_NAME)
            .expanduser()
            .resolve(strict=False)
        )
        if self.registry_path.name.casefold() == LEGACY_REGISTRY_FILE_NAME.casefold():
            raise PlatformInstallerError(
                "v2 installer refuses the legacy runtime-registry.json path"
            )
        self.python_executable = (
            Path(python_executable or sys.executable).expanduser().resolve(strict=False)
        )
        if not self.python_executable.is_file():
            raise PlatformInstallerError("installer Python executable does not exist")
        if not isinstance(host_version, str) or not host_version.strip():
            raise PlatformInstallerError("host version must be a non-empty string")
        if lock_timeout_seconds <= 0:
            raise PlatformInstallerError("installer lock timeout must be positive")
        self.host_version = host_version.strip()
        self.lock_timeout_seconds = float(lock_timeout_seconds)
        if multi_runtime_enabled is not None and not isinstance(
            multi_runtime_enabled, bool
        ):
            raise PlatformInstallerError("multi_runtime_enabled must be a boolean")
        self.multi_runtime_enabled = (
            _environment_bool(MULTI_RUNTIME_ENABLED_ENV, default=False)
            if multi_runtime_enabled is None
            else multi_runtime_enabled
        )
        if runtime_provider_seam_enabled is not None and not isinstance(
            runtime_provider_seam_enabled, bool
        ):
            raise PlatformInstallerError(
                "runtime_provider_seam_enabled must be a boolean"
            )
        self.runtime_provider_seam_enabled = (
            _environment_bool(RUNTIME_PROVIDER_SEAM_ENABLED_ENV, default=True)
            if runtime_provider_seam_enabled is None
            else runtime_provider_seam_enabled
        )
        if native_runtime_enabled is not None and not isinstance(
            native_runtime_enabled, bool
        ):
            raise PlatformInstallerError("native_runtime_enabled must be a boolean")
        self.native_runtime_enabled = (
            _environment_bool(NATIVE_RUNTIME_ENABLED_ENV, default=False)
            if native_runtime_enabled is None
            else native_runtime_enabled
        )
        if java_runtime_enabled is not None and not isinstance(
            java_runtime_enabled, bool
        ):
            raise PlatformInstallerError("java_runtime_enabled must be a boolean")
        self.java_runtime_enabled = (
            _environment_bool(JAVA_RUNTIME_ENABLED_ENV, default=False)
            if java_runtime_enabled is None
            else java_runtime_enabled
        )
        if managed_runtime_registry is not None and not all(
            callable(getattr(managed_runtime_registry, name, None))
            for name in ("ensure", "public_status", "resolve")
        ):
            raise PlatformInstallerError("managed_runtime_registry is invalid")
        self.managed_runtime_registry = managed_runtime_registry
        if runtime_provider_registry is None:
            from app.plugin_core_v2.runtime_providers import (
                default_runtime_provider_registry,
            )

            runtime_provider_registry = default_runtime_provider_registry(
                native_enabled=self.native_runtime_enabled,
                java_enabled=self.java_runtime_enabled,
                managed_runtime_registry=self.managed_runtime_registry,
            )
        if not callable(
            getattr(runtime_provider_registry, "get", None)
        ) or not callable(getattr(runtime_provider_registry, "resolve", None)):
            raise PlatformInstallerError("runtime_provider_registry is invalid")
        self.runtime_provider_registry = runtime_provider_registry
        if grant_store is not None:
            if audit_log is not None and grant_store.audit_log is not audit_log:
                raise PlatformInstallerError(
                    "injected Grant Store and audit log must share one audit owner"
                )
            self.grant_store = grant_store
            self.audit_log = grant_store.audit_log
        else:
            self.audit_log = audit_log or AuditLog(self.root / "audit-v2" / "events")
            self.grant_store = GrantStore(
                self.root / "platform-grants-v2.json",
                audit_log=self.audit_log,
            )
        self.publisher_identity_resolver = publisher_identity_resolver
        self.execution_trust_resolver = execution_trust_resolver
        self.probe_sandbox_factory = probe_sandbox_factory
        self.probe_python_runtime_factory = probe_python_runtime_factory
        if self.state_transaction_path.exists():
            with _installation_lock(self.lock_path, self.lock_timeout_seconds):
                self._assert_root_safe()
                with security_lock(
                    self.grant_store.lock_path,
                    self.grant_store.lock_timeout_seconds,
                ):
                    self._recover_state_transaction()

    @property
    def installs_directory(self) -> Path:
        return self.root / "installations"

    @property
    def staging_directory(self) -> Path:
        return self.root / "staging"

    @property
    def history_directory(self) -> Path:
        return self.root / "history"

    @property
    def quarantine_directory(self) -> Path:
        return self.root / "quarantine"

    @property
    def lock_path(self) -> Path:
        return self.root / ".installer-v2.lock"

    @property
    def state_transaction_path(self) -> Path:
        return self.root / "activation-grant-transaction-v1.json"

    def _installation_path(self, plugin_id: str, installation_id: str) -> Path:
        return self.installs_directory / plugin_id / installation_id

    @staticmethod
    def _content_directory(installation: Path) -> Path:
        return installation / "content"

    @staticmethod
    def _bundle_path(installation: Path) -> Path:
        return installation / "bundle.cspkg"

    @staticmethod
    def _receipt_path(installation: Path) -> Path:
        return installation / "receipt.json"

    @staticmethod
    def _venv_python(installation: Path) -> Path:
        return (
            installation / "venv" / "Scripts" / "python.exe"
            if os.name == "nt"
            else installation / "venv" / "bin" / "python"
        )

    def _assert_root_safe(self) -> None:
        if self.root.exists() and self.root.is_symlink():
            raise PlatformInstallerError("v2 plugin root must not be a symbolic link")
        for managed_directory in (
            self.installs_directory,
            self.staging_directory,
            self.history_directory,
            self.quarantine_directory,
        ):
            if managed_directory.exists() and managed_directory.is_symlink():
                raise PlatformInstallerError(
                    f"managed directory must not be a symbolic link: {managed_directory.name}"
                )
        if (
            self.registry_path.parent != self.root
            and self.registry_path.parent.is_symlink()
        ):
            raise PlatformInstallerError(
                "v2 registry directory must not be a symbolic link"
            )
        if self.state_transaction_path.exists() and (
            self.state_transaction_path.is_symlink()
            or not self.state_transaction_path.is_file()
        ):
            raise PlatformInstallerError(
                "activation/grant transaction journal must be a regular file"
            )

    def _begin_state_transaction(
        self,
        *,
        operation: str,
        plugin_id: str,
        registry: ActivationRegistry,
        recovery_target: _StateRecoveryTarget | None = None,
    ) -> dict[str, Any]:
        if self.state_transaction_path.exists():
            self._recover_state_transaction()
        grants_present = self.grant_store.path.exists()
        grants = self.grant_store.load()
        target = recovery_target or _StateRecoveryTarget(
            registry_present=self.registry_path.exists(),
            registry=registry,
            grant_store_present=grants_present,
            grants=grants,
        )
        transaction = {
            "schemaVersion": STATE_TRANSACTION_SCHEMA_VERSION,
            "transactionId": f"state-{uuid.uuid4().hex}",
            "operation": operation,
            "pluginId": plugin_id,
            "createdAt": _utc_now(),
            "beforeRegistryPresent": self.registry_path.exists(),
            "beforeRegistry": registry.to_wire(),
            "beforeGrantsPresent": grants_present,
            "beforeGrants": grants.to_wire(),
            "afterRegistry": None,
            "recoveryTarget": target.to_wire(),
        }
        _atomic_write_json(
            self.state_transaction_path,
            transaction,
            replace_existing=False,
        )
        return transaction

    def _set_state_transaction_after(
        self,
        transaction: dict[str, Any],
        registry: ActivationRegistry,
    ) -> None:
        transaction["afterRegistry"] = registry.to_wire()
        _atomic_write_json(self.state_transaction_path, transaction)

    def _finish_state_transaction(self) -> None:
        try:
            self.state_transaction_path.unlink()
            _fsync_directory(self.state_transaction_path.parent)
        except OSError as exc:
            raise PlatformInstallerError(
                f"unable to remove activation/grant transaction journal: {exc}"
            ) from exc

    @staticmethod
    def _grant_plugins_without(
        document: GrantDocument,
        plugin_id: str,
    ) -> dict[str, Any]:
        return {
            item.plugin_id: item.to_wire()
            for item in document.plugins
            if item.plugin_id != plugin_id
        }

    @staticmethod
    def _activation_plugins_without(
        registry: ActivationRegistry,
        plugin_id: str,
    ) -> dict[str, Any]:
        return {
            item.plugin_id: item.to_wire()
            for item in registry.plugins
            if item.plugin_id != plugin_id
        }

    def _record_state_compensation(
        self,
        transaction: Mapping[str, Any],
        *,
        before_registry: ActivationRegistry,
        before_grants: GrantDocument,
        after_registry: ActivationRegistry | None,
    ) -> None:
        plugin_id = transaction["pluginId"]
        transaction_id = transaction["transactionId"]
        attempted = (
            after_registry.by_id().get(plugin_id)
            if after_registry is not None
            else None
        )
        receipt = {
            "schemaVersion": STATE_TRANSACTION_SCHEMA_VERSION,
            "transactionId": transaction_id,
            "pluginId": plugin_id,
            "operation": transaction["operation"],
            "createdAt": transaction["createdAt"],
            "outcome": "compensated",
            "beforeRegistryRevision": before_registry.revision,
            "attemptedRegistryRevision": (
                after_registry.revision if after_registry is not None else None
            ),
            "beforeGrantRevision": before_grants.revision,
            "attemptedActivationId": (
                attempted.activation_id if attempted is not None else None
            ),
            "uncommittedHistoryPolicy": "retained-audit-only",
            "retainedEvidence": [
                "activation-history",
                "rollback-audit",
                "grant-reconcile-audit",
            ],
        }
        path = self._state_compensation_path(plugin_id, transaction_id)
        if path.exists():
            if _read_json(path, "state compensation receipt") != receipt:
                raise PlatformInstallerError(
                    "state compensation receipt conflicts with transaction journal",
                    plugin_id=plugin_id,
                )
            return
        _atomic_write_json(path, receipt, replace_existing=False)

    def _recover_state_transaction(self) -> None:
        if not self.state_transaction_path.exists():
            return
        transaction = _read_json(
            self.state_transaction_path,
            "activation/grant transaction journal",
            maximum_bytes=MAX_STATE_TRANSACTION_JSON_BYTES,
        )
        expected = {
            "schemaVersion",
            "transactionId",
            "operation",
            "pluginId",
            "createdAt",
            "beforeRegistryPresent",
            "beforeRegistry",
            "beforeGrantsPresent",
            "beforeGrants",
            "afterRegistry",
            "recoveryTarget",
        }
        if (
            set(transaction) != expected
            or transaction.get("schemaVersion") != STATE_TRANSACTION_SCHEMA_VERSION
            or transaction.get("operation") not in {"install", "restore", "rollback"}
            or not isinstance(transaction.get("transactionId"), str)
            or _STATE_TRANSACTION_ID.fullmatch(transaction["transactionId"]) is None
            or not isinstance(transaction.get("pluginId"), str)
            or _PLUGIN_ID.fullmatch(transaction["pluginId"]) is None
            or not isinstance(transaction.get("createdAt"), str)
            or not isinstance(transaction.get("beforeRegistryPresent"), bool)
            or not isinstance(transaction.get("beforeGrantsPresent"), bool)
            or not isinstance(transaction.get("recoveryTarget"), dict)
            or set(transaction["recoveryTarget"])
            != {
                "registryPresent",
                "registry",
                "grantStorePresent",
                "grants",
            }
            or not isinstance(
                transaction["recoveryTarget"].get("registryPresent"), bool
            )
            or not isinstance(
                transaction["recoveryTarget"].get("grantStorePresent"), bool
            )
        ):
            raise PlatformInstallerError(
                "activation/grant transaction journal schema is invalid"
            )
        plugin_id = transaction["pluginId"]
        try:
            before_registry = ActivationRegistry.from_wire(
                transaction["beforeRegistry"]
            )
            before_grants = GrantDocument.from_wire(transaction["beforeGrants"])
            after_value = transaction["afterRegistry"]
            after_registry = (
                ActivationRegistry.from_wire(after_value)
                if after_value is not None
                else None
            )
            recovery_value = transaction["recoveryTarget"]
            recovery_registry = ActivationRegistry.from_wire(recovery_value["registry"])
            recovery_grants = GrantDocument.from_wire(recovery_value["grants"])
        except Exception as exc:
            if isinstance(exc, PlatformInstallerError):
                raise
            raise PlatformInstallerError(
                f"activation/grant transaction journal state is invalid: {exc}"
            ) from exc
        if (
            (
                not transaction["recoveryTarget"]["registryPresent"]
                and bool(recovery_registry.plugins)
            )
            or (
                not transaction["recoveryTarget"]["grantStorePresent"]
                and bool(recovery_grants.plugins)
            )
            or self._activation_plugins_without(
                recovery_registry,
                plugin_id,
            )
            != self._activation_plugins_without(before_registry, plugin_id)
            or self._grant_plugins_without(
                recovery_grants,
                plugin_id,
            )
            != self._grant_plugins_without(before_grants, plugin_id)
            or (
                transaction["operation"] != "restore"
                and (
                    transaction["recoveryTarget"]["registryPresent"]
                    != transaction["beforeRegistryPresent"]
                    or recovery_registry.to_wire() != before_registry.to_wire()
                    or transaction["recoveryTarget"]["grantStorePresent"]
                    != transaction["beforeGrantsPresent"]
                    or recovery_grants.to_wire() != before_grants.to_wire()
                )
            )
        ):
            raise PlatformInstallerError(
                "activation/grant transaction recovery target is invalid",
                plugin_id=plugin_id,
            )

        current_registry = load_activation_registry(self.registry_path)
        allowed_registries = [before_registry.to_wire()]
        if after_registry is not None:
            allowed_registries.append(after_registry.to_wire())
        allowed_registries.append(recovery_registry.to_wire())
        if current_registry.to_wire() not in allowed_registries:
            raise PlatformInstallerError(
                "activation registry drifted during transaction recovery",
                plugin_id=plugin_id,
            )
        current_grants = self.grant_store.load()
        if self._grant_plugins_without(
            current_grants, plugin_id
        ) != self._grant_plugins_without(before_grants, plugin_id):
            raise PlatformInstallerError(
                "unrelated grants drifted during transaction recovery",
                plugin_id=plugin_id,
            )

        recovery_registry_present = transaction["recoveryTarget"]["registryPresent"]
        if (
            current_registry.to_wire() != recovery_registry.to_wire()
            or self.registry_path.exists() != recovery_registry_present
        ):
            if recovery_registry_present:
                _atomic_write_json(self.registry_path, recovery_registry.to_wire())
            else:
                try:
                    self.registry_path.unlink(missing_ok=True)
                    _fsync_directory(self.registry_path.parent)
                except OSError as exc:
                    raise PlatformInstallerError(
                        f"unable to restore activation registry: {exc}",
                        plugin_id=plugin_id,
                    ) from exc

        recovery_grants_present = transaction["recoveryTarget"]["grantStorePresent"]
        if (
            current_grants.to_wire() != recovery_grants.to_wire()
            or self.grant_store.path.exists() != recovery_grants_present
        ):
            if recovery_grants_present:
                _atomic_write_json(self.grant_store.path, recovery_grants.to_wire())
            else:
                try:
                    self.grant_store.path.unlink(missing_ok=True)
                    _fsync_directory(self.grant_store.path.parent)
                except OSError as exc:
                    raise PlatformInstallerError(
                        f"unable to restore Grant Store: {exc}",
                        plugin_id=plugin_id,
                    ) from exc
        self._record_state_compensation(
            transaction,
            before_registry=before_registry,
            before_grants=before_grants,
            after_registry=after_registry,
        )
        self._finish_state_transaction()

    def _compensate_state_transaction(
        self,
        *,
        plugin_id: str,
        original: BaseException,
    ) -> None:
        try:
            self._recover_state_transaction()
        except BaseException as compensation_error:
            raise PlatformInstallerError(
                "activation/grant transaction compensation failed",
                plugin_id=plugin_id,
                details={
                    "originalError": (f"{type(original).__name__}: {original}")[:1024],
                    "compensationError": (
                        f"{type(compensation_error).__name__}: {compensation_error}"
                    )[:1024],
                    "journalPath": str(self.state_transaction_path),
                },
            ) from compensation_error

    def _copy_bundle(self, bundle: VerifiedPlatformBundle, destination: Path) -> None:
        digest = hashlib.sha256()
        size = 0
        with bundle.path.open("rb") as source, destination.open("xb") as output:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
                size += len(chunk)
                output.write(chunk)
            output.flush()
            os.fsync(output.fileno())
        if (f"sha256:{digest.hexdigest()}", size) != (bundle.sha256, bundle.size):
            raise PlatformBundleError(
                "bundle changed while copying into installation store"
            )

    @staticmethod
    def _raise_provider_failure(
        exc: Exception,
        *,
        plugin_id: str,
    ) -> None:
        code = getattr(exc, "code", None)
        message = getattr(exc, "message", None)
        details = getattr(exc, "details", None)
        if (
            isinstance(code, str)
            and code.startswith("PLUGIN_RUNTIME_PROVIDER_")
            and isinstance(message, str)
        ):
            raise PlatformInstallerBaseError(
                code,
                message,
                plugin_id,
                dict(details) if isinstance(details, Mapping) else {},
            ) from exc
        raise exc

    def _provider_installation_requests(
        self,
        installation: Path,
        bundle: VerifiedPlatformBundle,
    ) -> tuple[tuple[Any, Any], ...]:
        from app.plugin_core_v2.runtime_providers import (
            RuntimeArtifact,
            RuntimeInstallationRequest,
        )

        runtime_ids: dict[str, set[str]] = {}
        runtime_artifact_paths: dict[str, set[str]] = {}
        providers: dict[str, Any] = {}
        for entrypoint in bundle.manifest.normalized_entrypoints:
            try:
                provider = self.runtime_provider_registry.resolve(entrypoint.runtime)
            except Exception as exc:
                self._raise_provider_failure(
                    exc,
                    plugin_id=bundle.manifest.plugin.id,
                )
                raise AssertionError("unreachable") from exc
            providers[entrypoint.runtime.kind] = provider
            runtime_ids.setdefault(entrypoint.runtime.kind, set()).add(
                entrypoint.runtime.runtime_id
            )
            artifact_path = getattr(entrypoint.runtime, "artifact", None)
            if isinstance(artifact_path, str):
                runtime_artifact_paths.setdefault(entrypoint.runtime.kind, set()).add(
                    artifact_path
                )
        artifact_records = {item.path: item for item in bundle.envelope.artifacts}
        wheel_paths = tuple(
            self._content_directory(installation).joinpath(
                *PurePosixPath(item.path).parts
            )
            for item in bundle.wheels
        )
        distributions = tuple((item.package, item.version) for item in bundle.wheels)
        return tuple(
            (
                providers[kind],
                RuntimeInstallationRequest(
                    installation=installation,
                    host_executable=self.python_executable,
                    wheel_paths=wheel_paths if kind == "python-module" else (),
                    distributions=(distributions if kind == "python-module" else ()),
                    runtime_ids=tuple(sorted(runtime_ids[kind])),
                    artifacts=tuple(
                        RuntimeArtifact(
                            relative_path=path,
                            path=self._content_directory(installation).joinpath(
                                *PurePosixPath(path).parts
                            ),
                            role=artifact_records[path].role,
                            sha256=artifact_records[path].sha256,
                            size=artifact_records[path].size,
                            operating_systems=artifact_records[path].operating_systems,
                            architectures=artifact_records[path].architectures,
                        )
                        for path in sorted(runtime_artifact_paths.get(kind, ()))
                    ),
                ),
            )
            for kind in sorted(providers)
        )

    def _prepare_runtime_providers(
        self,
        installation: Path,
        bundle: VerifiedPlatformBundle,
    ) -> tuple[dict[str, Any], ...]:
        bindings: list[dict[str, Any]] = []
        for provider, request in self._provider_installation_requests(
            installation, bundle
        ):
            try:
                prepared = provider.prepare_installation(request, _run_command)
            except Exception as exc:
                self._raise_provider_failure(
                    exc,
                    plugin_id=bundle.manifest.plugin.id,
                )
                raise AssertionError("unreachable") from exc
            bindings.extend(item.to_wire() for item in prepared)
        return tuple(
            sorted(
                bindings,
                key=lambda item: (item["runtimeKind"], item["runtimeId"]),
            )
        )

    def _verify_runtime_providers(
        self,
        installation: Path,
        bundle: VerifiedPlatformBundle,
    ) -> tuple[dict[str, Any], ...]:
        bindings: list[dict[str, Any]] = []
        for provider, request in self._provider_installation_requests(
            installation, bundle
        ):
            try:
                verified = provider.verify_installation(request, _run_command)
            except Exception as exc:
                self._raise_provider_failure(
                    exc,
                    plugin_id=bundle.manifest.plugin.id,
                )
                raise AssertionError("unreachable") from exc
            bindings.extend(item.to_wire() for item in verified)
        return tuple(
            sorted(
                bindings,
                key=lambda item: (item["runtimeKind"], item["runtimeId"]),
            )
        )

    def _runtime_launch_target(
        self,
        installation: Path,
        bundle: VerifiedPlatformBundle,
        runtime: object,
    ) -> tuple[Path, str]:
        artifact_path = getattr(runtime, "artifact", None)
        if artifact_path is None:
            return self._venv_python(installation).resolve(strict=False), bundle.sha256
        if not isinstance(artifact_path, str):
            raise PlatformInstallerError(
                "runtime artifact descriptor is invalid",
                plugin_id=bundle.manifest.plugin.id,
            )
        artifact = next(
            (item for item in bundle.envelope.artifacts if item.path == artifact_path),
            None,
        )
        if artifact is None:
            raise PlatformInstallerError(
                "runtime artifact is missing from the immutable inventory",
                plugin_id=bundle.manifest.plugin.id,
                details={"artifact": artifact_path},
            )
        return (
            self._content_directory(installation)
            .joinpath(*PurePosixPath(artifact_path).parts)
            .resolve(strict=False),
            artifact.sha256,
        )

    def _static_runtime_provider_bindings(
        self,
        installation: Path,
        bundle: VerifiedPlatformBundle,
    ) -> tuple[dict[str, Any], ...]:
        bindings: dict[tuple[str, str], dict[str, Any]] = {}
        for entrypoint in bundle.manifest.normalized_entrypoints:
            try:
                provider = self.runtime_provider_registry.resolve(entrypoint.runtime)
                executable, artifact_sha256 = self._runtime_launch_target(
                    installation,
                    bundle,
                    entrypoint.runtime,
                )
                prepared = provider.prepare_runtime(
                    runtime=entrypoint.runtime,
                    executable=executable,
                    working_directory=installation,
                    artifact_sha256=artifact_sha256,
                )
            except Exception as exc:
                self._raise_provider_failure(
                    exc,
                    plugin_id=bundle.manifest.plugin.id,
                )
                raise AssertionError("unreachable") from exc
            binding = {
                "runtimeKind": prepared.runtime_kind,
                "runtimeId": prepared.runtime_id,
                "providerVersion": prepared.provider_version,
                "runtimeIdentity": prepared.runtime_identity,
                **(
                    {"runtimeSupply": prepared.runtime_supply.to_wire()}
                    if prepared.runtime_supply is not None
                    else {}
                ),
            }
            bindings[(prepared.runtime_kind, prepared.runtime_id)] = binding
        return tuple(bindings[key] for key in sorted(bindings))

    def _create_venv(self, installation: Path) -> None:
        _run_command(
            (
                str(self.python_executable),
                "-I",
                "-m",
                "venv",
                str(installation / "venv"),
            ),
            label="isolated virtual environment creation",
            timeout_seconds=180,
            cwd=installation,
        )
        if not self._venv_python(installation).is_file():
            raise PlatformInstallerError("virtual environment did not create Python")

    def _install_wheels(
        self, installation: Path, bundle: VerifiedPlatformBundle
    ) -> None:
        wheels = [
            self._content_directory(installation).joinpath(
                *PurePosixPath(item.path).parts
            )
            for item in bundle.wheels
        ]
        _run_command(
            (
                str(self._venv_python(installation)),
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
            cwd=installation,
        )
        self._pip_check(installation)

    def _pip_check(self, installation: Path) -> None:
        _run_command(
            (
                str(self._venv_python(installation)),
                "-I",
                "-m",
                "pip",
                "--isolated",
                "check",
            ),
            label="installed dependency check",
            timeout_seconds=120,
            cwd=installation,
        )

    def _verify_distributions(
        self, installation: Path, bundle: VerifiedPlatformBundle
    ) -> None:
        script = (
            "import importlib.metadata as m,json,sys;"
            "print(json.dumps({n:m.version(n) for n in sys.argv[1:]},sort_keys=True))"
        )
        names = tuple(item.package for item in bundle.wheels)
        output = _run_command(
            (
                str(self._venv_python(installation)),
                "-I",
                "-c",
                script,
                *names,
            ),
            label="installed distribution verification",
            timeout_seconds=30,
            cwd=installation,
        )
        try:
            installed = loads_strict(output)
        except PlatformContractError as exc:
            raise PlatformInstallerError(
                "distribution verification returned invalid JSON"
            ) from exc
        expected = {item.package: item.version for item in bundle.wheels}
        if installed != expected:
            raise PlatformInstallerError(
                "installed distribution versions do not match the bundle",
                plugin_id=bundle.manifest.plugin.id,
                details={"expected": expected, "actual": installed},
            )

    def _run_probe(
        self, installation: Path, bundle: VerifiedPlatformBundle
    ) -> dict[str, Any]:
        trust_level = (
            self.execution_trust_resolver(bundle)
            if self.execution_trust_resolver is not None
            else "local-trusted"
        )
        if trust_level not in {
            "first-party-pinned",
            "local-trusted",
            "untrusted",
        }:
            raise PlatformInstallerError("resolved execution trust level is invalid")
        has_python_runtime = any(
            isinstance(item.runtime, PythonModuleRuntime)
            for item in bundle.manifest.normalized_entrypoints
        )
        managed_python = self._venv_python(installation)
        probe_python = (
            managed_python if managed_python.is_file() else self.python_executable
        )
        sandbox_path: Path | None = None
        command = [
            str(self.python_executable),
            "-I",
            str(PROBE_RUNNER),
            "--manifest",
            str(self._content_directory(installation) / "manifest.json"),
            "--bundle-descriptor",
            str(self._content_directory(installation) / "bundle.json"),
            "--python",
            str(probe_python),
            "--working-directory",
            str(installation),
            "--host-version",
            self.host_version,
        ]
        if self.runtime_provider_seam_enabled:
            command.append("--provider-seam")
        if self.native_runtime_enabled:
            command.append("--native-provider")
        if self.java_runtime_enabled:
            runtime_root = getattr(self.managed_runtime_registry, "root", None)
            if not isinstance(runtime_root, Path) or not runtime_root.is_dir():
                raise PlatformInstallerError(
                    "Java semantic probe requires an initialized managed Runtime Registry",
                    plugin_id=bundle.manifest.plugin.id,
                )
            command.extend(
                ("--java-provider", "--managed-runtime-root", str(runtime_root))
            )
        if trust_level == "untrusted":
            if self.probe_sandbox_factory is None:
                raise PlatformInstallerError(
                    "verified publisher probe requires an explicit OS sandbox",
                    plugin_id=bundle.manifest.plugin.id,
                )
            policies = {
                item.id: self.probe_sandbox_factory(
                    bundle,
                    installation,
                    item.id,
                ).to_wire()
                for item in bundle.manifest.backend_entrypoints
            }
            sandbox_path = installation / f".probe-sandbox-{uuid.uuid4().hex}.json"
            _atomic_write_json(
                sandbox_path,
                {"schemaVersion": 1, "entrypoints": policies},
                replace_existing=False,
            )
            command.extend(("--sandbox-policies", str(sandbox_path)))
            if has_python_runtime:
                if self.probe_python_runtime_factory is None:
                    raise PlatformInstallerError(
                        "verified publisher Python probe requires a pinned Python runtime",
                        plugin_id=bundle.manifest.plugin.id,
                    )
                runtime_executable, site_packages = self.probe_python_runtime_factory(
                    bundle, installation
                )
                if not isinstance(runtime_executable, Path) or not isinstance(
                    site_packages, Path
                ):
                    raise PlatformInstallerError(
                        "probe Python runtime factory returned an invalid result",
                        plugin_id=bundle.manifest.plugin.id,
                    )
                command.extend(
                    (
                        "--sandbox-python",
                        str(runtime_executable),
                        "--sandbox-site-packages",
                        str(site_packages),
                    )
                )
        try:
            output = _run_command(
                tuple(command),
                label="fresh-process platform Host probe",
                timeout_seconds=max(
                    60.0, 25.0 * len(bundle.manifest.backend_entrypoints)
                ),
                cwd=installation,
            )
        finally:
            if sandbox_path is not None:
                sandbox_path.unlink(missing_ok=True)
        try:
            value = _mapping(loads_strict(output), "fresh-process probe result")
        except (PlatformContractError, PlatformInstallerError) as exc:
            raise PlatformInstallerError(
                "fresh-process probe returned invalid JSON"
            ) from exc
        if set(value) != {"ok", "probe"} or value.get("ok") is not True:
            raise PlatformInstallerError(
                "fresh-process probe returned an invalid success result"
            )
        probe = dict(_mapping(value["probe"], "fresh-process probe"))
        expected_ids = [item.id for item in bundle.manifest.backend_entrypoints]
        raw_entrypoints = probe.get("entrypoints")
        actual_ids = (
            [item.get("entrypointId") for item in raw_entrypoints]
            if isinstance(raw_entrypoints, list)
            and all(isinstance(item, dict) for item in raw_entrypoints)
            else []
        )
        if (
            probe.get("pluginId") != bundle.manifest.plugin.id
            or probe.get("manifestContractSha256") != bundle.manifest.canonical_sha256
            or actual_ids != expected_ids
        ):
            raise PlatformInstallerError(
                "fresh-process probe identity does not match the verified bundle",
                plugin_id=bundle.manifest.plugin.id,
            )
        expected_semantic = [
            {
                "id": item.id,
                "entrypointId": item.entrypoint,
                "sha256": item.sha256,
            }
            for item in bundle.manifest.probes
        ]
        if probe.get("semanticProbes") != expected_semantic:
            raise PlatformInstallerError(
                "fresh-process semantic probes do not match the verified manifest",
                plugin_id=bundle.manifest.plugin.id,
            )
        return probe

    def _verify_content(
        self, installation: Path, records: Sequence[ContentRecord], envelope_sha256: str
    ) -> None:
        content = self._content_directory(installation)
        expected = {"bundle.json", *(item.path for item in records)}
        actual: set[str] = set()
        for candidate in content.rglob("*"):
            if candidate.is_symlink():
                raise PlatformInstallerError(
                    "managed content must not contain symbolic links"
                )
            if candidate.is_file():
                actual.add(candidate.relative_to(content).as_posix())
            elif not candidate.is_dir():
                raise PlatformInstallerError(
                    "managed content contains a non-regular file"
                )
        if actual != expected:
            raise PlatformInstallerError(
                "managed content does not match the bundle",
                details={
                    "extra": sorted(actual - expected),
                    "missing": sorted(expected - actual),
                },
            )
        descriptor = content / "bundle.json"
        if _hash_path(descriptor)[0] != envelope_sha256:
            raise PlatformInstallerError("managed bundle descriptor hash mismatch")
        for record in records:
            target = content.joinpath(*PurePosixPath(record.path).parts)
            if _hash_path(target) != (record.sha256, record.size):
                raise PlatformInstallerError(
                    f"managed content hash mismatch: {record.path}"
                )

    def _load_receipt(self, installation: Path) -> InstallationReceipt:
        return InstallationReceipt.from_wire(
            _read_json(self._receipt_path(installation), "installation receipt")
        )

    def _verify_installation(
        self,
        installation: Path,
        *,
        expected_record: ActivationRecord | None = None,
    ) -> tuple[VerifiedPlatformBundle, InstallationReceipt, dict[str, Any]]:
        if installation.is_symlink() or not installation.is_dir():
            raise PlatformInstallerError(
                "managed installation must be a real directory"
            )
        bundle = inspect_platform_bundle(
            self._bundle_path(installation), host_version=self.host_version
        )
        self._assert_bundle_installable(bundle)
        receipt = self._load_receipt(installation)
        receipt.assert_bundle(bundle)
        if (
            installation.name != bundle.installation_id
            or installation.parent.name != bundle.manifest.plugin.id
        ):
            raise PlatformInstallerError(
                "managed installation path does not match its identity"
            )
        if expected_record is not None:
            expected_path = self._installation_path(
                expected_record.plugin_id, expected_record.installation_id
            ).resolve(strict=False)
            if installation.resolve(strict=False) != expected_path:
                raise PlatformInstallerError(
                    "activation points outside its immutable installation"
                )
            if (
                expected_record.bundle_sha256 != bundle.sha256
                or expected_record.manifest_sha256 != bundle.manifest_sha256
                or expected_record.version != bundle.manifest.plugin.version
                or expected_record.publisher != bundle.manifest.plugin.publisher
            ):
                raise PlatformInstallerError(
                    "activation does not match its immutable installation"
                )
        self._verify_content(
            installation, bundle.envelope.contents, bundle.envelope_sha256
        )
        if self.runtime_provider_seam_enabled:
            bindings = self._verify_runtime_providers(installation, bundle)
            receipt.assert_runtime_providers(bindings)
        else:
            if not self._venv_python(installation).is_file():
                raise PlatformInstallerError(
                    "managed virtual environment Python is missing"
                )
            self._verify_distributions(installation, bundle)
            self._pip_check(installation)
        probe = self._run_probe(installation, bundle)
        return bundle, receipt, probe

    def verify_activation_static(
        self, record: ActivationRecord
    ) -> tuple[VerifiedPlatformBundle, Path]:
        """Verify an activation without executing code from a disabled plugin.

        Fresh-process semantics remain an install/check gate.  Product catalog
        bootstrap revalidates the immutable bundle, receipt, content digests,
        activation binding and venv launch target, but deliberately does not
        import or execute the plugin until an activation event occurs.
        """

        if not isinstance(record, ActivationRecord):
            raise TypeError("record must be an ActivationRecord")
        installation = self._installation_path(record.plugin_id, record.installation_id)
        with _installation_lock(self.lock_path, self.lock_timeout_seconds):
            if installation.is_symlink() or not installation.is_dir():
                raise PlatformInstallerError(
                    "managed installation must be a real directory",
                    plugin_id=record.plugin_id,
                )
            bundle = inspect_platform_bundle(
                self._bundle_path(installation), host_version=self.host_version
            )
            self._assert_bundle_installable(bundle)
            receipt = self._load_receipt(installation)
            receipt.assert_bundle(bundle)
            if (
                installation.name != bundle.installation_id
                or installation.parent.name != bundle.manifest.plugin.id
            ):
                raise PlatformInstallerError(
                    "managed installation path does not match its identity"
                )
            required_permissions = tuple(
                item.id for item in bundle.manifest.permissions.required
            )
            if (
                record.installation_id != bundle.installation_id
                or record.bundle_sha256 != bundle.sha256
                or record.manifest_sha256 != bundle.manifest_sha256
                or record.name != bundle.manifest.plugin.name
                or record.version != bundle.manifest.plugin.version
                or record.publisher != bundle.manifest.plugin.publisher
                or record.plugin_id != bundle.manifest.plugin.id
                or record.required_permissions != required_permissions
            ):
                raise PlatformInstallerError(
                    "activation does not match its immutable installation",
                    plugin_id=record.plugin_id,
                )
            self._verify_content(
                installation, bundle.envelope.contents, bundle.envelope_sha256
            )
            expected_python = self._venv_python(installation).resolve(strict=False)
            requires_python = not self.runtime_provider_seam_enabled or any(
                isinstance(item.runtime, PythonModuleRuntime)
                for item in bundle.manifest.normalized_entrypoints
            )
            if requires_python and not expected_python.is_file():
                raise PlatformInstallerError(
                    "managed virtual environment Python is missing",
                    plugin_id=record.plugin_id,
                )
            if self.runtime_provider_seam_enabled:
                expected_entrypoints = self._entrypoint_activations(
                    bundle, installation
                )
                if record.entrypoints != expected_entrypoints:
                    raise PlatformInstallerError(
                        "activation launch target does not match its immutable installation",
                        plugin_id=record.plugin_id,
                    )
                receipt.assert_runtime_providers(
                    self._static_runtime_provider_bindings(installation, bundle)
                )
            else:
                manifest_entrypoints = {
                    item.id: item for item in bundle.manifest.backend_entrypoints
                }
                if set(manifest_entrypoints) != {
                    item.id for item in record.entrypoints
                }:
                    raise PlatformInstallerError(
                        "activation entrypoints do not match the manifest",
                        plugin_id=record.plugin_id,
                    )
                for entrypoint in record.entrypoints:
                    declared = manifest_entrypoints[entrypoint.id]
                    if (
                        entrypoint.executable.resolve(strict=False) != expected_python
                        or entrypoint.working_directory.resolve(strict=False)
                        != installation.resolve(strict=False)
                        or entrypoint.module != declared.python_module
                        or entrypoint.runtime_kind != "python-module"
                        or entrypoint.runtime_id != "python-v2-compat"
                        or entrypoint.artifact_sha256 != bundle.sha256
                    ):
                        raise PlatformInstallerError(
                            "activation launch target does not match its immutable installation",
                            plugin_id=record.plugin_id,
                        )
            if self.execution_trust_resolver is not None:
                self.execution_trust_resolver(bundle)
            if self.publisher_identity_resolver is not None:
                self._publisher_identity(bundle)
            return bundle, installation

    def _remove_staging(self, path: Path) -> None:
        staging_root = self.staging_directory.resolve(strict=False)
        if path.resolve(strict=False).parent != staging_root or not path.name.endswith(
            ".part"
        ):
            raise PlatformInstallerError("refusing to remove an unsafe staging path")
        if path.exists():
            shutil.rmtree(path)

    def _quarantine(self, path: Path, plugin_id: str) -> None:
        if not path.exists():
            return
        target = (
            self.quarantine_directory / plugin_id / f"{path.name}-{uuid.uuid4().hex}"
        )
        target.parent.mkdir(parents=True, exist_ok=True)
        _rename_directory(path, target)
        _fsync_directory(target.parent)

    def _create_installation(
        self, bundle: VerifiedPlatformBundle, final_path: Path
    ) -> None:
        self.staging_directory.mkdir(parents=True, exist_ok=True)
        staging = self.staging_directory / f"install-{uuid.uuid4().hex}.part"
        moved = False
        try:
            staging.mkdir()
            bundle.extract_to(self._content_directory(staging))
            self._copy_bundle(bundle, self._bundle_path(staging))
            if self.runtime_provider_seam_enabled:
                runtime_providers = self._prepare_runtime_providers(staging, bundle)
            else:
                self._create_venv(staging)
                self._install_wheels(staging, bundle)
                self._verify_distributions(staging, bundle)
                runtime_providers = None
            probe = self._run_probe(staging, bundle)
            receipt = InstallationReceipt.from_bundle(
                bundle,
                probe=probe,
                runtime_providers=runtime_providers,
            )
            _atomic_write_json(self._receipt_path(staging), receipt.to_wire())
            final_path.parent.mkdir(parents=True, exist_ok=True)
            if final_path.parent.is_symlink() or final_path.exists():
                raise PlatformInstallerError(
                    "immutable installation target is unsafe or occupied"
                )
            _rename_directory(staging, final_path)
            moved = True
            _fsync_directory(final_path.parent)
            self._verify_installation(final_path)
        except (OSError, PlatformBundleError, PlatformInstallerBaseError) as exc:
            if moved:
                self._quarantine(final_path, bundle.manifest.plugin.id)
            if isinstance(exc, PlatformInstallerBaseError):
                raise
            raise PlatformInstallerError(
                f"unable to create immutable installation: {exc}",
                plugin_id=bundle.manifest.plugin.id,
            ) from exc
        finally:
            if staging.exists():
                self._remove_staging(staging)

    def _entrypoint_activations(
        self, bundle: VerifiedPlatformBundle, installation: Path
    ) -> tuple[EntrypointActivation, ...]:
        working_directory = installation.resolve(strict=False)
        activations: list[EntrypointActivation] = []
        for item in bundle.manifest.normalized_entrypoints:
            if self.runtime_provider_seam_enabled:
                try:
                    provider = self.runtime_provider_registry.resolve(item.runtime)
                    executable, artifact_sha256 = self._runtime_launch_target(
                        installation,
                        bundle,
                        item.runtime,
                    )
                    prepared = provider.prepare_runtime(
                        runtime=item.runtime,
                        executable=executable,
                        working_directory=working_directory,
                        artifact_sha256=artifact_sha256,
                    )
                except Exception as exc:
                    self._raise_provider_failure(
                        exc,
                        plugin_id=bundle.manifest.plugin.id,
                    )
                    raise AssertionError("unreachable") from exc
                if prepared.runtime_kind == "python-module":
                    if prepared.module is None or prepared.artifact is not None:
                        raise PlatformInstallerError(
                            "Python Provider returned an invalid activation target",
                            plugin_id=bundle.manifest.plugin.id,
                        )
                    main_class = None
                    export_name = None
                    wasi_profile = None
                elif prepared.runtime_kind == "native-executable":
                    if (
                        prepared.module is not None
                        or prepared.artifact is None
                        or prepared.artifact != prepared.executable
                    ):
                        raise PlatformInstallerError(
                            "Native Provider returned an invalid activation target",
                            plugin_id=bundle.manifest.plugin.id,
                        )
                    main_class = None
                    export_name = None
                    wasi_profile = None
                elif prepared.runtime_kind == "java-jar":
                    main_class = getattr(item.runtime, "main_class", None)
                    export_name = None
                    wasi_profile = None
                    if (
                        prepared.module is not None
                        or prepared.artifact is None
                        or not isinstance(main_class, str)
                        or not main_class
                        or prepared.runtime_supply is None
                        or prepared.runtime_supply.runtime_kind != "java"
                    ):
                        raise PlatformInstallerError(
                            "Java Provider returned an invalid managed activation target",
                            plugin_id=bundle.manifest.plugin.id,
                        )
                elif prepared.runtime_kind == "node-module":
                    main_class = None
                    export_name = None
                    wasi_profile = None
                    if (
                        prepared.module is not None
                        or prepared.artifact is None
                        or prepared.runtime_supply is None
                        or prepared.runtime_supply.runtime_kind != "node"
                    ):
                        raise PlatformInstallerError(
                            "Node Provider returned an invalid managed activation target",
                            plugin_id=bundle.manifest.plugin.id,
                        )
                elif prepared.runtime_kind == "wasm-component":
                    main_class = None
                    export_name = getattr(item.runtime, "export", None)
                    wasi_profile = getattr(item.runtime, "wasi_profile", None)
                    if (
                        prepared.module is not None
                        or prepared.artifact is None
                        or not isinstance(export_name, str)
                        or not export_name
                        or not isinstance(wasi_profile, str)
                        or not wasi_profile
                        or prepared.runtime_supply is None
                        or prepared.runtime_supply.runtime_kind != "wasm"
                    ):
                        raise PlatformInstallerError(
                            "WASM Provider returned an invalid managed activation target",
                            plugin_id=bundle.manifest.plugin.id,
                        )
                else:
                    raise RuntimeProviderUnavailableError(
                        plugin_id=bundle.manifest.plugin.id,
                        runtime_kinds=[prepared.runtime_kind],
                    )
                module = prepared.module
                runtime_kind = prepared.runtime_kind
                runtime_id = prepared.runtime_id
                arguments = prepared.arguments
                artifact = prepared.artifact
                activation_sha256 = prepared.artifact_sha256
                executable = prepared.executable
                runtime_supply = prepared.runtime_supply
            else:
                if not isinstance(item.runtime, PythonModuleRuntime):
                    raise RuntimeProviderUnavailableError(
                        plugin_id=bundle.manifest.plugin.id,
                        runtime_kinds=[item.runtime.kind],
                    )
                module = item.runtime.module
                runtime_kind = item.runtime.kind
                runtime_id = item.runtime.runtime_id
                arguments = item.runtime.interpreter_args
                artifact = None
                activation_sha256 = bundle.sha256
                executable = self._venv_python(installation).resolve(strict=False)
                runtime_supply = None
                main_class = None
                export_name = None
                wasi_profile = None
            activations.append(
                EntrypointActivation(
                    item.id,
                    executable,
                    module,
                    working_directory,
                    runtime_kind=runtime_kind,
                    runtime_id=runtime_id,
                    artifact_sha256=activation_sha256,
                    artifact=artifact,
                    arguments=arguments,
                    main_class=main_class,
                    export_name=export_name,
                    wasi_profile=wasi_profile,
                    runtime_supply=runtime_supply,
                )
            )
        return tuple(activations)

    def _assert_bundle_installable(self, bundle: VerifiedPlatformBundle) -> None:
        if bundle.manifest.schema_version != MANIFEST_SCHEMA_VERSION_V3:
            return
        runtime_kinds = sorted(
            {item.runtime.kind for item in bundle.manifest.normalized_entrypoints}
        )
        if not self.multi_runtime_enabled:
            raise MultiRuntimeFeatureDisabledError(
                plugin_id=bundle.manifest.plugin.id,
                runtime_kinds=runtime_kinds,
            )
        if not self.runtime_provider_seam_enabled:
            raise RuntimeProviderUnavailableError(
                plugin_id=bundle.manifest.plugin.id,
                runtime_kinds=runtime_kinds,
            )
        if "native-executable" in runtime_kinds and not self.native_runtime_enabled:
            raise RuntimeProviderUnavailableError(
                plugin_id=bundle.manifest.plugin.id,
                runtime_kinds=["native-executable"],
            )
        unavailable: list[str] = []
        for entrypoint in bundle.manifest.normalized_entrypoints:
            try:
                self.runtime_provider_registry.resolve(entrypoint.runtime)
            except Exception as exc:
                if getattr(exc, "code", None) == "PLUGIN_RUNTIME_PROVIDER_UNAVAILABLE":
                    unavailable.append(entrypoint.runtime.kind)
                    continue
                self._raise_provider_failure(
                    exc,
                    plugin_id=bundle.manifest.plugin.id,
                )
                raise AssertionError("unreachable") from exc
        if unavailable:
            raise RuntimeProviderUnavailableError(
                plugin_id=bundle.manifest.plugin.id,
                runtime_kinds=sorted(set(unavailable)),
            )

    def _new_record(
        self,
        bundle: VerifiedPlatformBundle,
        installation: Path,
        *,
        enabled: bool,
        activation_ready: bool,
        force_staged: bool = False,
    ) -> ActivationRecord:
        required = tuple(item.id for item in bundle.manifest.permissions.required)
        state = (
            "staged"
            if force_staged or not activation_ready
            else ("active" if enabled else "disabled")
        )
        entrypoints = self._entrypoint_activations(bundle, installation)
        return ActivationRecord(
            plugin_id=bundle.manifest.plugin.id,
            name=bundle.manifest.plugin.name,
            version=bundle.manifest.plugin.version,
            publisher=bundle.manifest.plugin.publisher,
            installation_id=bundle.installation_id,
            bundle_sha256=bundle.sha256,
            manifest_sha256=bundle.manifest_sha256,
            activation_id=f"activation-{uuid.uuid4().hex}",
            activated_at=_utc_now(),
            state=state,
            enabled=state == "active",
            restart_required=True,
            required_permissions=required,
            entrypoints=entrypoints,
            schema_version=(
                REGISTRY_SCHEMA_VERSION_V4
                if any(item.runtime_supply is not None for item in entrypoints)
                else REGISTRY_SCHEMA_VERSION_V3
            ),
        )

    @staticmethod
    def _same_activation_intent(
        current: ActivationRecord, candidate: ActivationRecord
    ) -> bool:
        ignored = {"activationId", "activatedAt", "restartRequired"}
        current_wire = {
            key: value for key, value in current.to_wire().items() if key not in ignored
        }
        candidate_wire = {
            key: value
            for key, value in candidate.to_wire().items()
            if key not in ignored
        }
        return current_wire == candidate_wire

    def _history_path(self, plugin_id: str, activation_id: str) -> Path:
        return (
            self.history_directory / plugin_id / "activations" / f"{activation_id}.json"
        )

    def _rollback_audit_path(self, plugin_id: str, rollback_id: str) -> Path:
        return self.history_directory / plugin_id / "rollbacks" / f"{rollback_id}.json"

    def _state_compensation_path(
        self,
        plugin_id: str,
        transaction_id: str,
    ) -> Path:
        return (
            self.history_directory
            / plugin_id
            / "compensations"
            / f"{transaction_id}.json"
        )

    def _commit_registry_change(
        self,
        registry: ActivationRegistry,
        plugin_id: str,
        before: ActivationRecord | None,
        after: ActivationRecord | None,
    ) -> ActivationRegistry:
        transaction_id = (
            after.activation_id
            if after is not None
            else f"activation-{uuid.uuid4().hex}"
        )
        transaction = {
            "schemaVersion": HISTORY_SCHEMA_VERSION,
            "transactionId": transaction_id,
            "pluginId": plugin_id,
            "createdAt": _utc_now(),
            "before": before.to_wire() if before is not None else None,
            "after": after.to_wire() if after is not None else None,
        }
        _atomic_write_json(
            self._history_path(plugin_id, transaction_id),
            transaction,
            replace_existing=False,
        )
        updated = registry.replace(plugin_id, after)
        _atomic_write_json(self.registry_path, updated.to_wire())
        return updated

    def install(
        self,
        bundle_path: Path | str,
        *,
        expected_sha256: str,
        enabled: bool = False,
        force_staged: bool = False,
    ) -> InstallResult:
        if not isinstance(enabled, bool) or not isinstance(force_staged, bool):
            raise PlatformInstallerError("enabled and force_staged must be booleans")
        if enabled and force_staged:
            raise PlatformInstallerError(
                "force_staged cannot be combined with enabled activation"
            )
        bundle = verify_platform_bundle(
            bundle_path,
            expected_sha256=expected_sha256,
            host_version=self.host_version,
        )
        self._assert_bundle_installable(bundle)
        plugin_id = bundle.manifest.plugin.id
        final_path = self._installation_path(plugin_id, bundle.installation_id)
        with _installation_lock(self.lock_path, self.lock_timeout_seconds):
            self._assert_root_safe()
            with security_lock(
                self.grant_store.lock_path,
                self.grant_store.lock_timeout_seconds,
            ):
                self._recover_state_transaction()
            reused = final_path.exists()
            if reused:
                self._verify_installation(final_path)
            else:
                self._create_installation(bundle, final_path)
            with security_lock(
                self.grant_store.lock_path,
                self.grant_store.lock_timeout_seconds,
            ):
                self._recover_state_transaction()
                registry = load_activation_registry(self.registry_path)
                transaction = self._begin_state_transaction(
                    operation="install",
                    plugin_id=plugin_id,
                    registry=registry,
                )
                try:
                    publisher_identity = self._publisher_identity(bundle)
                    permission_diff = self.grant_store.permission_diff(
                        bundle.manifest,
                        bundle_sha256=bundle.sha256,
                        manifest_sha256=bundle.manifest_sha256,
                        publisher_identity=publisher_identity,
                    )
                    grant_reconciliation = self.grant_store._reconcile_locked(
                        bundle.manifest,
                        bundle_sha256=bundle.sha256,
                        manifest_sha256=bundle.manifest_sha256,
                        publisher_identity=publisher_identity,
                    )
                    activation_ready = self.grant_store.activation_ready(
                        bundle.manifest,
                        bundle_sha256=bundle.sha256,
                        manifest_sha256=bundle.manifest_sha256,
                        publisher_identity=publisher_identity,
                    )
                    grant_record_sha256 = _grant_record_sha256(
                        self.grant_store.load().by_id().get(plugin_id)
                    )
                    current = registry.by_id().get(plugin_id)
                    candidate = self._new_record(
                        bundle,
                        final_path,
                        enabled=enabled,
                        activation_ready=activation_ready,
                        force_staged=force_staged,
                    )
                    if current is not None and self._same_activation_intent(
                        current, candidate
                    ):
                        self._finish_state_transaction()
                        return InstallResult(
                            plugin_id,
                            bundle.installation_id,
                            current.activation_id,
                            current.state,
                            current.enabled,
                            current.restart_required,
                            grant_reconciliation.changed,
                            True,
                            final_path,
                            self.registry_path,
                            permission_diff.to_wire(),
                            grant_reconciliation.store_revision,
                            grant_record_sha256,
                            activation_ready,
                        )
                    updated = registry.replace(plugin_id, candidate)
                    self._set_state_transaction_after(transaction, updated)
                    self._commit_registry_change(
                        registry, plugin_id, current, candidate
                    )
                    self._finish_state_transaction()
                    return InstallResult(
                        plugin_id,
                        bundle.installation_id,
                        candidate.activation_id,
                        candidate.state,
                        candidate.enabled,
                        candidate.restart_required,
                        True,
                        reused,
                        final_path,
                        self.registry_path,
                        permission_diff.to_wire(),
                        grant_reconciliation.store_revision,
                        grant_record_sha256,
                        activation_ready,
                    )
                except BaseException as exc:
                    self._compensate_state_transaction(
                        plugin_id=plugin_id,
                        original=exc,
                    )
                    raise

    def _publisher_identity(self, bundle: VerifiedPlatformBundle) -> str:
        if self.publisher_identity_resolver is None:
            return f"manifest:{bundle.manifest.plugin.publisher}"
        identity = self.publisher_identity_resolver(bundle)
        if not isinstance(identity, str) or not identity or len(identity) > 256:
            raise PlatformInstallerError("resolved publisher identity is invalid")
        return identity

    def _grant_arguments(self, bundle: VerifiedPlatformBundle) -> dict[str, str]:
        return {
            "bundle_sha256": bundle.sha256,
            "manifest_sha256": bundle.manifest_sha256,
            "publisher_identity": self._publisher_identity(bundle),
        }

    def _current_bundle(
        self,
        registry: ActivationRegistry,
        plugin_id: str,
    ) -> tuple[ActivationRecord, VerifiedPlatformBundle]:
        record = registry.by_id().get(plugin_id)
        if record is None:
            raise PlatformInstallerError(
                "plugin is not present in v2 activation registry"
            )
        installation = self._installation_path(plugin_id, record.installation_id)
        bundle, _receipt, _probe = self._verify_installation(
            installation, expected_record=record
        )
        return record, bundle

    def capture_activation_state(self, plugin_id: str) -> ActivationStateSnapshot:
        """Capture one plugin's activation and grants for immediate CAS undo."""

        with _installation_lock(self.lock_path, self.lock_timeout_seconds):
            self._assert_root_safe()
            with security_lock(
                self.grant_store.lock_path,
                self.grant_store.lock_timeout_seconds,
            ):
                self._recover_state_transaction()
                registry = load_activation_registry(self.registry_path)
                grants = self.grant_store.load()
                return ActivationStateSnapshot(
                    registry_path=self.registry_path,
                    grant_store_path=self.grant_store.path,
                    plugin_id=plugin_id,
                    registry_present=self.registry_path.exists(),
                    activation=registry.by_id().get(plugin_id),
                    grant_store_present=self.grant_store.path.exists(),
                    grant=grants.by_id().get(plugin_id),
                )

    def restore_activation_state(
        self,
        snapshot: ActivationStateSnapshot,
        *,
        expected_activation_id: str,
        expected_grant_record_sha256: str,
    ) -> None:
        """Undo one just-installed activation without re-evaluating old grants."""

        if (
            not isinstance(snapshot, ActivationStateSnapshot)
            or snapshot.registry_path != self.registry_path
            or snapshot.grant_store_path != self.grant_store.path
        ):
            raise PlatformInstallerError(
                "activation savepoint does not belong to this installer"
            )
        if (
            not isinstance(expected_grant_record_sha256, str)
            or re.fullmatch(r"sha256:[0-9a-f]{64}", expected_grant_record_sha256)
            is None
        ):
            raise PlatformInstallerError(
                "expected Grant Store record digest is invalid"
            )
        plugin_id = snapshot.plugin_id
        with _installation_lock(self.lock_path, self.lock_timeout_seconds):
            self._assert_root_safe()
            with security_lock(
                self.grant_store.lock_path,
                self.grant_store.lock_timeout_seconds,
            ):
                self._recover_state_transaction()
                registry = load_activation_registry(self.registry_path)
                current = registry.by_id().get(plugin_id)
                if current is None or current.activation_id != expected_activation_id:
                    raise PlatformInstallerError(
                        "current activation changed before savepoint restore",
                        plugin_id=plugin_id,
                        details={
                            "expectedActivationId": expected_activation_id,
                            "actualActivationId": (
                                current.activation_id if current is not None else None
                            ),
                        },
                    )
                grants = self.grant_store.load()
                current_grant_sha256 = _grant_record_sha256(
                    grants.by_id().get(plugin_id)
                )
                if current_grant_sha256 != expected_grant_record_sha256:
                    raise PlatformInstallerError(
                        "current Grant Store record changed before savepoint restore",
                        plugin_id=plugin_id,
                        details={
                            "expectedGrantRecordSha256": (expected_grant_record_sha256),
                            "actualGrantRecordSha256": current_grant_sha256,
                        },
                    )
                grant_values = grants.by_id()
                if snapshot.grant is None:
                    grant_values.pop(plugin_id, None)
                else:
                    grant_values[plugin_id] = snapshot.grant
                restored_grants = GrantDocument(
                    revision=grants.revision + 1,
                    plugins=tuple(grant_values[key] for key in sorted(grant_values)),
                )
                restored_registry = registry.replace(
                    plugin_id,
                    snapshot.activation,
                )
                recovery_target = _StateRecoveryTarget(
                    registry_present=(
                        bool(restored_registry.plugins) or snapshot.registry_present
                    ),
                    registry=restored_registry,
                    grant_store_present=(
                        bool(restored_grants.plugins) or snapshot.grant_store_present
                    ),
                    grants=restored_grants,
                )
                transaction = self._begin_state_transaction(
                    operation="restore",
                    plugin_id=plugin_id,
                    registry=registry,
                    recovery_target=recovery_target,
                )
                try:
                    self._set_state_transaction_after(
                        transaction,
                        restored_registry,
                    )
                    if not restored_grants.plugins and not snapshot.grant_store_present:
                        self.grant_store.path.unlink(missing_ok=True)
                        _fsync_directory(self.grant_store.path.parent)
                    else:
                        _atomic_write_json(
                            self.grant_store.path,
                            restored_grants.to_wire(),
                        )
                    if not restored_registry.plugins and not snapshot.registry_present:
                        self.registry_path.unlink(missing_ok=True)
                        _fsync_directory(self.registry_path.parent)
                    else:
                        _atomic_write_json(
                            self.registry_path,
                            restored_registry.to_wire(),
                        )
                    self._finish_state_transaction()
                except BaseException as exc:
                    self._compensate_state_transaction(
                        plugin_id=plugin_id,
                        original=exc,
                    )
                    raise

    def permission_summary(
        self, plugin_id: str | None = None
    ) -> tuple[dict[str, Any], ...]:
        return self.grant_store.summary(plugin_id)

    def preview_permission_diff(
        self,
        bundle_path: Path | str,
        *,
        expected_sha256: str,
    ) -> PermissionDiff:
        bundle = verify_platform_bundle(
            bundle_path,
            expected_sha256=expected_sha256,
            host_version=self.host_version,
        )
        return self.grant_store.permission_diff(
            bundle.manifest,
            **self._grant_arguments(bundle),
        )

    def permission_diff(self, plugin_id: str) -> PermissionDiff:
        with _installation_lock(self.lock_path, self.lock_timeout_seconds):
            registry = load_activation_registry(self.registry_path)
            _record, bundle = self._current_bundle(registry, plugin_id)
            return self.grant_store.permission_diff(
                bundle.manifest,
                **self._grant_arguments(bundle),
            )

    def _change_permission(
        self,
        plugin_id: str,
        permission_id: str,
        *,
        decision: str,
        scope: dict[str, Any] | None = None,
        source: str,
        trace_id: str | None = None,
    ) -> PermissionChangeResult:
        with _installation_lock(self.lock_path, self.lock_timeout_seconds):
            registry = load_activation_registry(self.registry_path)
            current, bundle = self._current_bundle(registry, plugin_id)
            arguments: dict[str, Any] = {
                **self._grant_arguments(bundle),
                "permission_id": permission_id,
                "source": source,
                "trace_id": trace_id,
            }
            if decision == "granted":
                mutation = self.grant_store.grant(
                    bundle.manifest,
                    scope=scope,
                    **arguments,
                )
            elif decision == "denied":
                mutation = self.grant_store.deny(bundle.manifest, **arguments)
            elif decision == "revoked":
                mutation = self.grant_store.revoke(bundle.manifest, **arguments)
            else:
                raise PlatformInstallerError("permission decision is invalid")
            activation_ready = self.grant_store.activation_ready(
                bundle.manifest,
                **self._grant_arguments(bundle),
            )
            replacement = current
            state_changed = False
            if current.state == "active" and not activation_ready:
                replacement = replace(
                    current,
                    activation_id=f"activation-{uuid.uuid4().hex}",
                    activated_at=_utc_now(),
                    state="staged",
                    enabled=False,
                    restart_required=True,
                )
                self._commit_registry_change(
                    registry,
                    plugin_id,
                    current,
                    replacement,
                )
                state_changed = True
            return PermissionChangeResult(
                mutation,
                replacement.state,
                replacement.activation_id,
                activation_ready,
                state_changed,
            )

    def grant_permission(
        self,
        plugin_id: str,
        permission_id: str,
        *,
        scope: dict[str, Any] | None = None,
        source: str = "cli",
        trace_id: str | None = None,
    ) -> PermissionChangeResult:
        return self._change_permission(
            plugin_id,
            permission_id,
            decision="granted",
            scope=scope,
            source=source,
            trace_id=trace_id,
        )

    def deny_permission(
        self,
        plugin_id: str,
        permission_id: str,
        *,
        source: str = "cli",
        trace_id: str | None = None,
    ) -> PermissionChangeResult:
        return self._change_permission(
            plugin_id,
            permission_id,
            decision="denied",
            source=source,
            trace_id=trace_id,
        )

    def revoke_permission(
        self,
        plugin_id: str,
        permission_id: str,
        *,
        source: str = "cli",
        trace_id: str | None = None,
    ) -> PermissionChangeResult:
        return self._change_permission(
            plugin_id,
            permission_id,
            decision="revoked",
            source=source,
            trace_id=trace_id,
        )

    def check(self, plugin_id: str) -> CheckResult:
        with _installation_lock(self.lock_path, self.lock_timeout_seconds):
            record = load_activation_registry(self.registry_path).by_id().get(plugin_id)
            if record is None:
                raise PlatformInstallerError(
                    "plugin is not present in v2 activation registry"
                )
            installation = self._installation_path(
                record.plugin_id, record.installation_id
            )
            bundle, _receipt, probe = self._verify_installation(
                installation, expected_record=record
            )
            return CheckResult(
                plugin_id,
                record.installation_id,
                bundle.sha256,
                record.state,
                probe,
            )

    def list_plugins(self) -> tuple[dict[str, Any], ...]:
        registry = load_activation_registry(self.registry_path)
        return tuple(item.to_wire() for item in registry.plugins)

    def rollback_status(self, plugin_id: str) -> dict[str, Any]:
        """Describe the exact local rollback target without mutating registry state."""

        registry = load_activation_registry(self.registry_path)
        current = registry.by_id().get(plugin_id)
        if current is None:
            raise PlatformInstallerError(
                "plugin is not present in v2 activation registry"
            )
        path = self._history_path(plugin_id, current.activation_id)
        if not path.exists():
            return {"available": False, "reason": "ROLLBACK_HISTORY_MISSING"}
        try:
            transaction = _read_json(path, "activation history")
            expected = {
                "schemaVersion",
                "transactionId",
                "pluginId",
                "createdAt",
                "before",
                "after",
            }
            if (
                set(transaction) != expected
                or transaction.get("schemaVersion") != HISTORY_SCHEMA_VERSION
                or transaction.get("transactionId") != current.activation_id
                or transaction.get("pluginId") != plugin_id
                or transaction.get("after") != current.to_wire()
            ):
                return {"available": False, "reason": "ROLLBACK_HISTORY_INVALID"}
            before_value = transaction.get("before")
            if before_value is None:
                return {
                    "available": True,
                    "target": {"state": "uninstalled", "version": None},
                }
            target = ActivationRecord.from_wire(
                before_value, "activation history.before"
            )
            return {
                "available": True,
                "target": {"state": target.state, "version": target.version},
            }
        except PlatformInstallerBaseError:
            return {"available": False, "reason": "ROLLBACK_HISTORY_INVALID"}

    def _change_state(self, plugin_id: str, target_state: str) -> StateChangeResult:
        with _installation_lock(self.lock_path, self.lock_timeout_seconds):
            registry = load_activation_registry(self.registry_path)
            current = registry.by_id().get(plugin_id)
            if current is None:
                raise PlatformInstallerError(
                    "plugin is not present in v2 activation registry"
                )
            if target_state == "active":
                current, bundle = self._current_bundle(registry, plugin_id)
                self.grant_store.reconcile(
                    bundle.manifest,
                    **self._grant_arguments(bundle),
                )
                if not self.grant_store.activation_ready(
                    bundle.manifest,
                    **self._grant_arguments(bundle),
                ):
                    raise PlatformInstallerError(
                        "plugin permissions are not fully resolved for activation",
                        plugin_id=plugin_id,
                        details={
                            "grants": list(self.grant_store.summary(plugin_id)),
                        },
                    )
            if current.state == target_state:
                return StateChangeResult(
                    plugin_id,
                    current.state,
                    current.state,
                    current.activation_id,
                    False,
                )
            replacement = replace(
                current,
                activation_id=f"activation-{uuid.uuid4().hex}",
                activated_at=_utc_now(),
                state=target_state,
                enabled=target_state == "active",
                restart_required=True,
            )
            self._commit_registry_change(registry, plugin_id, current, replacement)
            return StateChangeResult(
                plugin_id,
                current.state,
                replacement.state,
                replacement.activation_id,
                True,
            )

    def enable(self, plugin_id: str) -> StateChangeResult:
        return self._change_state(plugin_id, "active")

    def disable(self, plugin_id: str) -> StateChangeResult:
        return self._change_state(plugin_id, "disabled")

    def uninstall(self, plugin_id: str) -> StateChangeResult:
        with _installation_lock(self.lock_path, self.lock_timeout_seconds):
            registry = load_activation_registry(self.registry_path)
            current = registry.by_id().get(plugin_id)
            if current is None:
                raise PlatformInstallerError(
                    "plugin is not present in v2 activation registry"
                )
            self._commit_registry_change(registry, plugin_id, current, None)
            return StateChangeResult(
                plugin_id,
                current.state,
                None,
                None,
                True,
                installation_retained=True,
            )

    def rollback(self, plugin_id: str) -> RollbackResult:
        with _installation_lock(self.lock_path, self.lock_timeout_seconds):
            self._assert_root_safe()
            with security_lock(
                self.grant_store.lock_path,
                self.grant_store.lock_timeout_seconds,
            ):
                self._recover_state_transaction()
            registry = load_activation_registry(self.registry_path)
            current = registry.by_id().get(plugin_id)
            if current is None:
                raise PlatformInstallerError(
                    "plugin has no active v2 activation to roll back"
                )
            transaction = _read_json(
                self._history_path(plugin_id, current.activation_id),
                "activation history",
            )
            if (
                set(transaction)
                != {
                    "schemaVersion",
                    "transactionId",
                    "pluginId",
                    "createdAt",
                    "before",
                    "after",
                }
                or transaction.get("schemaVersion") != HISTORY_SCHEMA_VERSION
            ):
                raise PlatformInstallerError("activation history schema is invalid")
            if (
                transaction.get("transactionId") != current.activation_id
                or transaction.get("pluginId") != plugin_id
                or transaction.get("after") != current.to_wire()
            ):
                raise PlatformInstallerError(
                    "activation history does not match current registry"
                )
            before_value = transaction.get("before")
            target = (
                ActivationRecord.from_wire(before_value, "activation history.before")
                if before_value is not None
                else None
            )
            probe: dict[str, Any] | None = None
            security_adjusted = False
            if target is not None:
                installation = self._installation_path(
                    plugin_id, target.installation_id
                )
                target_bundle, _receipt, probe = self._verify_installation(
                    installation, expected_record=target
                )
            with security_lock(
                self.grant_store.lock_path,
                self.grant_store.lock_timeout_seconds,
            ):
                self._recover_state_transaction()
                transaction_state = self._begin_state_transaction(
                    operation="rollback",
                    plugin_id=plugin_id,
                    registry=registry,
                )
                try:
                    if target is not None:
                        grant_arguments = self._grant_arguments(target_bundle)
                        self.grant_store._reconcile_locked(
                            target_bundle.manifest,
                            **grant_arguments,
                        )
                        if (
                            target.state == "active"
                            and not self.grant_store.activation_ready(
                                target_bundle.manifest,
                                **grant_arguments,
                            )
                        ):
                            target = replace(
                                target,
                                activation_id=f"activation-{uuid.uuid4().hex}",
                                activated_at=_utc_now(),
                                state="staged",
                                enabled=False,
                                restart_required=True,
                            )
                            security_adjusted = True
                    updated = registry.replace(plugin_id, target)
                    self._set_state_transaction_after(transaction_state, updated)
                    rollback_id = f"rollback-{uuid.uuid4().hex}"
                    audit = {
                        "schemaVersion": HISTORY_SCHEMA_VERSION,
                        "rollbackId": rollback_id,
                        "pluginId": plugin_id,
                        "createdAt": _utc_now(),
                        "from": current.to_wire(),
                        "to": target.to_wire() if target is not None else None,
                        "freshProcessProbe": probe,
                    }
                    _atomic_write_json(
                        self._rollback_audit_path(plugin_id, rollback_id),
                        audit,
                        replace_existing=False,
                    )
                    if security_adjusted:
                        self._commit_registry_change(
                            registry,
                            plugin_id,
                            current,
                            target,
                        )
                    else:
                        _atomic_write_json(self.registry_path, updated.to_wire())
                    self._finish_state_transaction()
                    return RollbackResult(
                        plugin_id,
                        current.activation_id,
                        target.activation_id if target is not None else None,
                        target is None,
                        self.registry_path,
                    )
                except BaseException as exc:
                    self._compensate_state_transaction(
                        plugin_id=plugin_id,
                        original=exc,
                    )
                    raise
