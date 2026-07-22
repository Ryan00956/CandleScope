"""Content-addressed installation store and atomic activation registry v2."""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
import time
import uuid
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any

from candlescope_plugin_sdk.platform_v2 import (
    PlatformContractError,
    canonical_dumps,
    loads_strict,
)

from .bundle import (
    DEFAULT_HOST_VERSION,
    ContentRecord,
    VerifiedPlatformBundle,
    inspect_platform_bundle,
    verify_platform_bundle,
)
from .errors import PlatformBundleError, PlatformInstallerError
from .registry import (
    LEGACY_REGISTRY_FILE_NAME,
    REGISTRY_FILE_NAME,
    ActivationRecord,
    ActivationRegistry,
    EntrypointActivation,
    load_activation_registry,
)


RECEIPT_SCHEMA_VERSION = 2
HISTORY_SCHEMA_VERSION = 2
MAX_STATE_JSON_BYTES = 4 * 1024 * 1024
DEFAULT_INSTALL_LOCK_TIMEOUT_SECONDS = 30.0
DEFAULT_COMMAND_OUTPUT_BYTES = 1024 * 1024
PROBE_RUNNER = Path(__file__).with_name("probe_runner.py").resolve()

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


def _read_json(path: Path, label: str) -> Mapping[str, Any]:
    try:
        if path.is_symlink() or not path.is_file():
            raise PlatformInstallerError(f"{label} must be a regular file")
        size = path.stat().st_size
        if not 0 < size <= MAX_STATE_JSON_BYTES:
            raise PlatformInstallerError(f"{label} has an invalid size")
        value = loads_strict(path.read_bytes())
    except PlatformInstallerError:
        raise
    except (OSError, PlatformContractError) as exc:
        raise PlatformInstallerError(f"unable to read {label}: {exc}") from exc
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

    @classmethod
    def from_bundle(
        cls, bundle: VerifiedPlatformBundle, *, probe: Mapping[str, Any]
    ) -> "InstallationReceipt":
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
        )

    def to_wire(self) -> dict[str, Any]:
        return {
            "schemaVersion": RECEIPT_SCHEMA_VERSION,
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
        }

    @classmethod
    def from_wire(cls, value: Any) -> "InstallationReceipt":
        data = _mapping(value, "installation receipt")
        expected = {
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
        if set(data) != expected or data.get("schemaVersion") != RECEIPT_SCHEMA_VERSION:
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


class PlatformPluginInstaller:
    """Own v2 installs without reading or writing the legacy registry."""

    def __init__(
        self,
        *,
        root: Path | str | None = None,
        registry_path: Path | str | None = None,
        python_executable: Path | str | None = None,
        host_version: str = DEFAULT_HOST_VERSION,
        lock_timeout_seconds: float = DEFAULT_INSTALL_LOCK_TIMEOUT_SECONDS,
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
        output = _run_command(
            (
                str(self.python_executable),
                "-I",
                str(PROBE_RUNNER),
                "--manifest",
                str(self._content_directory(installation) / "manifest.json"),
                "--bundle-descriptor",
                str(self._content_directory(installation) / "bundle.json"),
                "--python",
                str(self._venv_python(installation)),
                "--working-directory",
                str(installation),
                "--host-version",
                self.host_version,
            ),
            label="fresh-process platform Host probe",
            timeout_seconds=max(60.0, 25.0 * len(bundle.manifest.backend_entrypoints)),
            cwd=installation,
        )
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
        if not self._venv_python(installation).is_file():
            raise PlatformInstallerError(
                "managed virtual environment Python is missing"
            )
        self._verify_distributions(installation, bundle)
        self._pip_check(installation)
        probe = self._run_probe(installation, bundle)
        return bundle, receipt, probe

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
            self._create_venv(staging)
            self._install_wheels(staging, bundle)
            self._verify_distributions(staging, bundle)
            probe = self._run_probe(staging, bundle)
            receipt = InstallationReceipt.from_bundle(bundle, probe=probe)
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
        except (OSError, PlatformBundleError, PlatformInstallerError) as exc:
            if moved:
                self._quarantine(final_path, bundle.manifest.plugin.id)
            if isinstance(exc, (PlatformBundleError, PlatformInstallerError)):
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
        executable = self._venv_python(installation).resolve(strict=False)
        working_directory = installation.resolve(strict=False)
        return tuple(
            EntrypointActivation(
                item.id,
                executable,
                item.python_module,
                working_directory,
            )
            for item in bundle.manifest.backend_entrypoints
        )

    def _new_record(
        self,
        bundle: VerifiedPlatformBundle,
        installation: Path,
        *,
        enabled: bool,
    ) -> ActivationRecord:
        required = tuple(item.id for item in bundle.manifest.permissions.required)
        state = "staged" if required else ("active" if enabled else "disabled")
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
            entrypoints=self._entrypoint_activations(bundle, installation),
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
    ) -> InstallResult:
        if not isinstance(enabled, bool):
            raise PlatformInstallerError("enabled must be a boolean")
        bundle = verify_platform_bundle(
            bundle_path,
            expected_sha256=expected_sha256,
            host_version=self.host_version,
        )
        plugin_id = bundle.manifest.plugin.id
        final_path = self._installation_path(plugin_id, bundle.installation_id)
        with _installation_lock(self.lock_path, self.lock_timeout_seconds):
            self._assert_root_safe()
            registry = load_activation_registry(self.registry_path)
            reused = final_path.exists()
            if reused:
                self._verify_installation(final_path)
            else:
                self._create_installation(bundle, final_path)
            current = registry.by_id().get(plugin_id)
            candidate = self._new_record(bundle, final_path, enabled=enabled)
            if current is not None and self._same_activation_intent(current, candidate):
                return InstallResult(
                    plugin_id,
                    bundle.installation_id,
                    current.activation_id,
                    current.state,
                    current.enabled,
                    current.restart_required,
                    False,
                    True,
                    final_path,
                    self.registry_path,
                )
            self._commit_registry_change(registry, plugin_id, current, candidate)
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

    def _change_state(self, plugin_id: str, target_state: str) -> StateChangeResult:
        with _installation_lock(self.lock_path, self.lock_timeout_seconds):
            registry = load_activation_registry(self.registry_path)
            current = registry.by_id().get(plugin_id)
            if current is None:
                raise PlatformInstallerError(
                    "plugin is not present in v2 activation registry"
                )
            if target_state == "active" and current.required_permissions:
                raise PlatformInstallerError(
                    "plugin remains staged until Phase 4 permission grants are implemented",
                    plugin_id=plugin_id,
                    details={"requiredPermissions": list(current.required_permissions)},
                )
            if current.state == target_state:
                return StateChangeResult(
                    plugin_id,
                    current.state,
                    current.state,
                    current.activation_id,
                    False,
                )
            installation = self._installation_path(plugin_id, current.installation_id)
            self._verify_installation(installation, expected_record=current)
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
            if target is not None:
                installation = self._installation_path(
                    plugin_id, target.installation_id
                )
                _bundle, _receipt, probe = self._verify_installation(
                    installation, expected_record=target
                )
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
            updated = registry.replace(plugin_id, target)
            _atomic_write_json(self.registry_path, updated.to_wire())
            return RollbackResult(
                plugin_id,
                current.activation_id,
                target.activation_id if target is not None else None,
                target is None,
                self.registry_path,
            )
