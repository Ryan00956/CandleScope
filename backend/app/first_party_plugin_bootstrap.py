"""Pinned first-party runtime installation before the generic plugin host starts.

The generic installer deliberately accepts local ``.cspkg`` files only.  This
module is the product-owned layer that maps CandleScope's default runtime route
to one immutable public Release asset, downloads it, verifies the outer digest,
and hands the local file to that installer.
"""

from __future__ import annotations

from app.core.config import runtime_environment

import hashlib
import json
import os
import platform
import re
import sys
import tempfile
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO
from urllib.parse import urlparse

from app.indicator.runtime_routes import (
    ROUTE_MODE_LEGACY,
    load_indicator_runtime_routes_from_environment,
)
from app.plugin_runtime.bootstrap import (
    PLUGIN_HOST_ENABLED_ENV,
    RUNTIME_REGISTRY_ENV,
)
from app.plugin_runtime.errors import PluginHostError
from app.plugin_runtime.installer import PluginInstaller
from app.plugin_runtime.registry import default_runtime_registry_path


OFFICIAL_PLUGIN_BOOTSTRAP_ENV = "CANDLESCOPE_OFFICIAL_PLUGIN_BOOTSTRAP"
OFFICIAL_PLUGIN_BUNDLE_ENV = "CANDLESCOPE_OFFICIAL_PLUGIN_BUNDLE"
OFFICIAL_PLUGIN_DOWNLOAD_CACHE_ENV = "CANDLESCOPE_PLUGIN_DOWNLOAD_CACHE"
OFFICIAL_PLUGIN_DOWNLOAD_TIMEOUT_ENV = "CANDLESCOPE_PLUGIN_DOWNLOAD_TIMEOUT_SECONDS"
DEFAULT_RELEASE_LOCK_PATH = Path(__file__).with_name("official-plugin-releases.json")
MAX_RELEASE_LOCK_BYTES = 64 * 1024
MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024
FIRST_PARTY_RUNTIME_IDS = frozenset({"candlescope.pyne", "candlescope.pine-compat"})

_SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
_RUNTIME_ID = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$")


class FirstPartyPluginBootstrapError(PluginHostError):
    """A pinned first-party runtime could not be resolved safely."""

    def __init__(
        self,
        message: str,
        *,
        runtime_id: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(
            code="FIRST_PARTY_PLUGIN_BOOTSTRAP_FAILED",
            message=message,
            runtime_id=runtime_id,
            details=details or {},
        )


@dataclass(frozen=True, slots=True)
class OfficialPluginRelease:
    runtime_id: str
    package: str
    version: str
    filename: str
    url: str
    sha256: str
    size: int
    system: str
    machine: str
    implementation: str
    python_version: str


@dataclass(frozen=True, slots=True)
class FirstPartyPluginBootstrapItemResult:
    status: str
    runtime_id: str
    version: str
    bundle_sha256: str
    registry_path: Path | None = None
    installation_path: Path | None = None
    changed: bool = False
    downloaded: bool = False
    reason: str | None = None

    def to_wire(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "runtimeId": self.runtime_id,
            "version": self.version,
            "bundleSha256": self.bundle_sha256,
            "changed": self.changed,
            "downloaded": self.downloaded,
            **({"registryPath": str(self.registry_path)} if self.registry_path else {}),
            **(
                {"installationPath": str(self.installation_path)}
                if self.installation_path
                else {}
            ),
            **({"reason": self.reason} if self.reason else {}),
        }


@dataclass(frozen=True, slots=True)
class FirstPartyPluginBootstrapResult:
    status: str
    runtime_id: str | None = None
    version: str | None = None
    bundle_sha256: str | None = None
    registry_path: Path | None = None
    installation_path: Path | None = None
    changed: bool = False
    downloaded: bool = False
    reason: str | None = None
    plugins: tuple[FirstPartyPluginBootstrapItemResult, ...] = ()

    @classmethod
    def unavailable(cls, reason: str) -> "FirstPartyPluginBootstrapResult":
        return cls(status="unavailable", reason=reason)

    def to_wire(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "status": self.status,
            "changed": self.changed,
            "downloaded": self.downloaded,
        }
        if self.plugins:
            payload["plugins"] = [item.to_wire() for item in self.plugins]
            payload["count"] = len(self.plugins)
        else:
            payload.update(
                {
                    **({"runtimeId": self.runtime_id} if self.runtime_id else {}),
                    **({"version": self.version} if self.version else {}),
                    **(
                        {"bundleSha256": self.bundle_sha256}
                        if self.bundle_sha256
                        else {}
                    ),
                    **(
                        {"installationPath": str(self.installation_path)}
                        if self.installation_path
                        else {}
                    ),
                }
            )
        if self.registry_path:
            payload["registryPath"] = str(self.registry_path)
        if self.reason:
            payload["reason"] = self.reason
        return payload


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"non-standard JSON constant is not allowed: {value}")


def _unique_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON object key: {key}")
        result[key] = value
    return result


def _only_keys(value: Mapping[str, Any], allowed: set[str], label: str) -> None:
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise FirstPartyPluginBootstrapError(
            f"{label} contains unsupported fields: {', '.join(unknown)}"
        )


def _string(value: Any, label: str, *, maximum: int = 512) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise FirstPartyPluginBootstrapError(f"{label} must be a non-empty string")
    return value.strip()


def load_official_plugin_releases(
    path: Path | str = DEFAULT_RELEASE_LOCK_PATH,
) -> tuple[OfficialPluginRelease, ...]:
    lock_path = Path(path).expanduser().resolve(strict=False)
    try:
        if lock_path.stat().st_size > MAX_RELEASE_LOCK_BYTES:
            raise FirstPartyPluginBootstrapError(
                "official plugin release lock is too large"
            )
        value = json.loads(
            lock_path.read_text(encoding="utf-8"),
            object_pairs_hook=_unique_json_object,
            parse_constant=_reject_json_constant,
        )
    except FirstPartyPluginBootstrapError:
        raise
    except (OSError, UnicodeError, ValueError, json.JSONDecodeError) as exc:
        raise FirstPartyPluginBootstrapError(
            f"unable to read official plugin release lock: {exc}"
        ) from exc
    if not isinstance(value, Mapping):
        raise FirstPartyPluginBootstrapError(
            "official plugin release lock must be an object"
        )
    _only_keys(value, {"schemaVersion", "plugins"}, "official plugin release lock")
    if value.get("schemaVersion") != 1:
        raise FirstPartyPluginBootstrapError(
            "official plugin release lock schemaVersion must be 1"
        )
    raw_plugins = value.get("plugins")
    if not isinstance(raw_plugins, list) or not raw_plugins:
        raise FirstPartyPluginBootstrapError(
            "official plugin releases must be a non-empty array"
        )

    releases: list[OfficialPluginRelease] = []
    for index, raw in enumerate(raw_plugins):
        label = f"plugins[{index}]"
        if not isinstance(raw, Mapping):
            raise FirstPartyPluginBootstrapError(f"{label} must be an object")
        _only_keys(
            raw,
            {
                "runtimeId",
                "package",
                "version",
                "filename",
                "url",
                "sha256",
                "size",
                "platform",
            },
            label,
        )
        runtime_id = _string(raw.get("runtimeId"), f"{label}.runtimeId", maximum=64)
        if _RUNTIME_ID.fullmatch(runtime_id) is None:
            raise FirstPartyPluginBootstrapError(f"{label}.runtimeId is invalid")
        filename = _string(raw.get("filename"), f"{label}.filename", maximum=255)
        if Path(filename).name != filename or not filename.endswith(".cspkg"):
            raise FirstPartyPluginBootstrapError(
                f"{label}.filename must be one local .cspkg filename"
            )
        url = _string(raw.get("url"), f"{label}.url", maximum=2048)
        parsed = urlparse(url)
        if parsed.scheme != "https" or parsed.hostname != "github.com":
            raise FirstPartyPluginBootstrapError(
                f"{label}.url must be an HTTPS github.com Release URL"
            )
        sha256 = _string(raw.get("sha256"), f"{label}.sha256", maximum=71)
        if _SHA256.fullmatch(sha256) is None:
            raise FirstPartyPluginBootstrapError(f"{label}.sha256 is invalid")
        size = raw.get("size")
        if (
            not isinstance(size, int)
            or isinstance(size, bool)
            or not (1 <= size <= MAX_DOWNLOAD_BYTES)
        ):
            raise FirstPartyPluginBootstrapError(f"{label}.size is invalid")
        target = raw.get("platform")
        if not isinstance(target, Mapping):
            raise FirstPartyPluginBootstrapError(f"{label}.platform must be an object")
        _only_keys(
            target,
            {"system", "machine", "implementation", "pythonVersion"},
            f"{label}.platform",
        )
        releases.append(
            OfficialPluginRelease(
                runtime_id=runtime_id,
                package=_string(raw.get("package"), f"{label}.package", maximum=128),
                version=_string(raw.get("version"), f"{label}.version", maximum=128),
                filename=filename,
                url=url,
                sha256=sha256,
                size=size,
                system=_string(
                    target.get("system"), f"{label}.platform.system", maximum=32
                ),
                machine=_string(
                    target.get("machine"), f"{label}.platform.machine", maximum=32
                ),
                implementation=_string(
                    target.get("implementation"),
                    f"{label}.platform.implementation",
                    maximum=32,
                ),
                python_version=_string(
                    target.get("pythonVersion"),
                    f"{label}.platform.pythonVersion",
                    maximum=16,
                ),
            )
        )
    ids = [release.runtime_id for release in releases]
    if len(ids) != len(set(ids)):
        raise FirstPartyPluginBootstrapError(
            "official plugin release lock contains duplicate runtime IDs"
        )
    return tuple(releases)


def _environment_bool(
    environ: Mapping[str, str],
    name: str,
    *,
    default: bool,
) -> bool:
    raw = environ.get(name)
    if raw is None:
        return default
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise FirstPartyPluginBootstrapError(
        f"{name} must be one of 1/0, true/false, yes/no, or on/off"
    )


def _registry_path(environ: Mapping[str, str]) -> Path:
    override = environ.get(RUNTIME_REGISTRY_ENV)
    if override is not None:
        if not override.strip():
            raise FirstPartyPluginBootstrapError(
                f"{RUNTIME_REGISTRY_ENV} must not be empty"
            )
        return Path(override).expanduser().resolve(strict=False)
    return default_runtime_registry_path(environ)


def _assert_platform(release: OfficialPluginRelease) -> None:
    actual = {
        "system": platform.system(),
        "machine": platform.machine(),
        "implementation": platform.python_implementation(),
        "pythonVersion": f"{sys.version_info.major}.{sys.version_info.minor}",
    }
    expected = {
        "system": release.system,
        "machine": release.machine,
        "implementation": release.implementation,
        "pythonVersion": release.python_version,
    }
    if actual != expected:
        raise FirstPartyPluginBootstrapError(
            "the pinned official plugin bundle does not support this host platform",
            runtime_id=release.runtime_id,
            details={"expected": expected, "actual": actual},
        )


def _sha256_file(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            size += len(chunk)
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}", size


def _verified_local_bundle(path: Path, release: OfficialPluginRelease) -> Path:
    try:
        digest, size = _sha256_file(path)
    except OSError as exc:
        raise FirstPartyPluginBootstrapError(
            f"unable to read official plugin bundle: {exc}",
            runtime_id=release.runtime_id,
        ) from exc
    if digest != release.sha256 or size != release.size:
        raise FirstPartyPluginBootstrapError(
            "official plugin bundle does not match the pinned size and SHA-256",
            runtime_id=release.runtime_id,
            details={
                "expectedSha256": release.sha256,
                "actualSha256": digest,
                "expectedSize": release.size,
                "actualSize": size,
            },
        )
    return path


def _copy_response(
    response: BinaryIO,
    destination: Path,
    *,
    expected_size: int,
) -> None:
    size = 0
    with destination.open("wb") as handle:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > expected_size or size > MAX_DOWNLOAD_BYTES:
                raise FirstPartyPluginBootstrapError(
                    "official plugin download exceeded its pinned size"
                )
            handle.write(chunk)
        handle.flush()
        os.fsync(handle.fileno())
    if size != expected_size:
        raise FirstPartyPluginBootstrapError(
            f"official plugin download size mismatch: expected {expected_size}, found {size}"
        )


def download_official_plugin_bundle(
    release: OfficialPluginRelease,
    cache_directory: Path | str,
    *,
    timeout_seconds: float = 30.0,
    opener: Callable[..., Any] | None = None,
) -> tuple[Path, bool]:
    cache = Path(cache_directory).expanduser().resolve(strict=False)
    destination = cache / release.filename
    if destination.is_file():
        return _verified_local_bundle(destination, release), False
    if destination.exists():
        raise FirstPartyPluginBootstrapError(
            f"official plugin cache target is not a file: {destination}",
            runtime_id=release.runtime_id,
        )
    cache.mkdir(parents=True, exist_ok=True)
    opener = urllib.request.urlopen if opener is None else opener
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            prefix=f".{release.filename}.",
            suffix=".download",
            dir=cache,
            delete=False,
        ) as temporary:
            temporary_path = Path(temporary.name)
        request = urllib.request.Request(
            release.url,
            headers={"User-Agent": "CandleScope/0.3 official-plugin-bootstrap"},
        )
        with opener(request, timeout=timeout_seconds) as response:
            _copy_response(response, temporary_path, expected_size=release.size)
        _verified_local_bundle(temporary_path, release)
        os.replace(temporary_path, destination)
        temporary_path = None
        return _verified_local_bundle(destination, release), True
    except FirstPartyPluginBootstrapError:
        raise
    except (OSError, TimeoutError, ValueError) as exc:
        raise FirstPartyPluginBootstrapError(
            f"unable to download official plugin bundle: {exc}",
            runtime_id=release.runtime_id,
        ) from exc
    finally:
        if temporary_path is not None:
            try:
                temporary_path.unlink(missing_ok=True)
            except OSError:
                pass


def ensure_first_party_plugins_from_environment(
    *,
    host_name: str,
    host_version: str,
    environ: Mapping[str, str] | None = None,
    release_lock_path: Path | str = DEFAULT_RELEASE_LOCK_PATH,
    opener: Callable[..., Any] | None = None,
    installer_factory: Callable[..., PluginInstaller] = PluginInstaller,
) -> FirstPartyPluginBootstrapResult:
    env = runtime_environment() if environ is None else environ
    if not _environment_bool(env, PLUGIN_HOST_ENABLED_ENV, default=True):
        return FirstPartyPluginBootstrapResult(
            status="skipped", reason="plugin-host-disabled"
        )
    if not _environment_bool(env, OFFICIAL_PLUGIN_BOOTSTRAP_ENV, default=True):
        return FirstPartyPluginBootstrapResult(
            status="skipped", reason="official-bootstrap-disabled"
        )

    routes = load_indicator_runtime_routes_from_environment(env)
    required_runtime_ids = {
        route.runtime_id
        for route in routes.routes
        if route.mode != ROUTE_MODE_LEGACY and route.runtime_id is not None
    }
    releases = {
        release.runtime_id: release
        for release in load_official_plugin_releases(release_lock_path)
    }
    missing_first_party = sorted(
        (required_runtime_ids & FIRST_PARTY_RUNTIME_IDS) - set(releases)
    )
    if missing_first_party:
        raise FirstPartyPluginBootstrapError(
            "official release lock is missing routed first-party runtimes: "
            + ", ".join(missing_first_party)
        )
    selected = [
        releases[runtime_id]
        for runtime_id in sorted(required_runtime_ids)
        if runtime_id in releases
    ]
    if not selected:
        return FirstPartyPluginBootstrapResult(
            status="skipped", reason="no-official-runtime-route"
        )
    for release in selected:
        _assert_platform(release)

    registry_path = _registry_path(env)
    installer = installer_factory(
        registry_path=registry_path,
        host_name=host_name,
        host_version=host_version,
    )
    current_by_runtime = {item["runtimeId"]: item for item in installer.list_plugins()}
    results: dict[str, FirstPartyPluginBootstrapItemResult] = {}
    pending: list[OfficialPluginRelease] = []
    for release in selected:
        current = current_by_runtime.get(release.runtime_id)
        if current is not None and not bool(current.get("managed")):
            raise FirstPartyPluginBootstrapError(
                "refusing to replace an unmanaged runtime activation",
                runtime_id=release.runtime_id,
            )
        if (
            current is not None
            and current.get("version") == release.version
            and current.get("bundleSha256") == release.sha256
            and current.get("enabled") is True
            and current.get("autoStart") is True
            and current.get("required") is True
        ):
            checked = installer.check(release.runtime_id)
            results[release.runtime_id] = FirstPartyPluginBootstrapItemResult(
                status="ready",
                runtime_id=release.runtime_id,
                version=release.version,
                bundle_sha256=release.sha256,
                registry_path=registry_path,
                reason=f"checked:{checked.activation_id}",
            )
        else:
            pending.append(release)

    resolved_bundles: dict[str, tuple[Path, bool]] = {}
    override = env.get(OFFICIAL_PLUGIN_BUNDLE_ENV)
    if pending and override is not None:
        if not override.strip():
            raise FirstPartyPluginBootstrapError(
                f"{OFFICIAL_PLUGIN_BUNDLE_ENV} must not be empty"
            )
        override_path = Path(override).expanduser().resolve(strict=False)
        if len(selected) == 1:
            release = pending[0]
            resolved_bundles[release.runtime_id] = (
                _verified_local_bundle(override_path, release),
                False,
            )
        else:
            if not override_path.is_dir():
                raise FirstPartyPluginBootstrapError(
                    f"{OFFICIAL_PLUGIN_BUNDLE_ENV} must name a directory when "
                    "multiple official runtimes are routed"
                )
            for release in pending:
                resolved_bundles[release.runtime_id] = (
                    _verified_local_bundle(override_path / release.filename, release),
                    False,
                )
    elif pending:
        cache_override = env.get(OFFICIAL_PLUGIN_DOWNLOAD_CACHE_ENV)
        if cache_override is not None and not cache_override.strip():
            raise FirstPartyPluginBootstrapError(
                f"{OFFICIAL_PLUGIN_DOWNLOAD_CACHE_ENV} must not be empty"
            )
        cache_directory = (
            Path(cache_override).expanduser()
            if cache_override is not None
            else registry_path.parent / "downloads"
        )
        raw_timeout = env.get(OFFICIAL_PLUGIN_DOWNLOAD_TIMEOUT_ENV, "30")
        try:
            timeout_seconds = float(raw_timeout)
        except ValueError as exc:
            raise FirstPartyPluginBootstrapError(
                f"{OFFICIAL_PLUGIN_DOWNLOAD_TIMEOUT_ENV} must be a number"
            ) from exc
        if not (0.1 <= timeout_seconds <= 300.0):
            raise FirstPartyPluginBootstrapError(
                f"{OFFICIAL_PLUGIN_DOWNLOAD_TIMEOUT_ENV} must be between 0.1 and 300"
            )
        for release in pending:
            resolved_bundles[release.runtime_id] = download_official_plugin_bundle(
                release,
                cache_directory,
                timeout_seconds=timeout_seconds,
                opener=opener,
            )

    # Every pending bundle is downloaded and outer-verified first. For multiple
    # runtimes the installer also completes every internal bundle/environment/
    # protocol probe before one atomic registry replacement publishes the set.
    if len(pending) > 1:
        installed_values = installer.install_many(
            tuple(
                (resolved_bundles[release.runtime_id][0], release.sha256)
                for release in pending
            ),
            enabled=True,
            auto_start=True,
            required=True,
        )
    else:
        installed_values = tuple(
            installer.install(
                resolved_bundles[release.runtime_id][0],
                expected_sha256=release.sha256,
                enabled=True,
                auto_start=True,
                required=True,
            )
            for release in pending
        )

    for release, installed in zip(pending, installed_values, strict=True):
        _bundle_path, downloaded = resolved_bundles[release.runtime_id]
        results[release.runtime_id] = FirstPartyPluginBootstrapItemResult(
            status="installed" if installed.changed else "ready",
            runtime_id=release.runtime_id,
            version=release.version,
            bundle_sha256=release.sha256,
            registry_path=registry_path,
            installation_path=installed.installation_path,
            changed=installed.changed,
            downloaded=downloaded,
            reason=("activated" if installed.changed else "reused-installation"),
        )

    ordered = tuple(results[release.runtime_id] for release in selected)
    if len(ordered) == 1:
        item = ordered[0]
        return FirstPartyPluginBootstrapResult(
            status=item.status,
            runtime_id=item.runtime_id,
            version=item.version,
            bundle_sha256=item.bundle_sha256,
            registry_path=item.registry_path,
            installation_path=item.installation_path,
            changed=item.changed,
            downloaded=item.downloaded,
            reason=item.reason,
        )
    changed = any(item.changed for item in ordered)
    downloaded = any(item.downloaded for item in ordered)
    return FirstPartyPluginBootstrapResult(
        status="installed" if changed else "ready",
        registry_path=registry_path,
        changed=changed,
        downloaded=downloaded,
        reason=(
            "official-runtimes-activated" if changed else "official-runtimes-checked"
        ),
        plugins=ordered,
    )


__all__ = [
    "DEFAULT_RELEASE_LOCK_PATH",
    "FirstPartyPluginBootstrapError",
    "FirstPartyPluginBootstrapItemResult",
    "FirstPartyPluginBootstrapResult",
    "OfficialPluginRelease",
    "download_official_plugin_bundle",
    "ensure_first_party_plugins_from_environment",
    "load_official_plugin_releases",
]
