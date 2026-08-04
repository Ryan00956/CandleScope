"""Atomic download, cache, probe, rollback, and reference service for runtimes."""

from __future__ import annotations

import errno
import hashlib
import os
import platform
import re
import shutil
import stat
import subprocess
import tarfile
import unicodedata
import uuid
import zipfile
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any, Protocol
from urllib.parse import urljoin, urlsplit

import httpx
from candlescope_plugin_sdk.platform_v2 import (
    JsonLimits,
    PlatformContractError,
    loads_strict,
)

from app.plugin_core_v2.runtime_providers.base import RuntimeSupplyBinding
from app.plugin_security_v2.storage import security_lock

from .errors import RuntimeRegistryError, registry_error
from .models import (
    MAX_EVIDENCE_BYTES,
    MAX_REGISTRY_BYTES,
    MAX_RUNTIME_ARCHIVE_BYTES,
    STATE_SCHEMA_VERSION,
    SYSTEM_REGISTRY_SCHEMA_VERSION,
    RuntimeEvidence,
    RuntimeRegistryRoot,
    RuntimeRelease,
    VerifiedRuntimeRegistry,
    canonical_bytes,
    load_runtime_registry_roots_bytes,
    sha256_bytes,
    verify_runtime_registry_bytes,
)


RUNTIME_REGISTRY_ENABLED_ENV = "CANDLESCOPE_PLUGIN_RUNTIME_REGISTRY_ENABLED"
RUNTIME_REGISTRY_NETWORK_UPDATES_ENV = (
    "CANDLESCOPE_PLUGIN_RUNTIME_REGISTRY_NETWORK_UPDATES_ENABLED"
)
RUNTIME_CACHE_RECEIPT_SCHEMA = "candlescope.runtime-cache-receipt/1"
RUNTIME_REGISTRY_STATUS_SCHEMA = "candlescope.runtime-registry-status/1"
MAX_CACHE_RECEIPT_BYTES = 16 * 1024 * 1024
MAX_PROBE_OUTPUT_BYTES = 1024 * 1024
MAX_SYSTEM_RUNTIMES = 128
MAX_SYSTEM_PROBE_ARGS = 16
MAX_SYSTEM_PROBE_ARG_CHARS = 1024
MAX_SYSTEM_PATTERN_CHARS = 2048
DOWNLOAD_TIMEOUT_SECONDS = 120.0
MIN_FREE_SPACE_MARGIN_BYTES = 16 * 1024 * 1024

_SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
_ID = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$")
_WINDOWS_RESERVED_NAMES = frozenset(
    {"con", "prn", "aux", "nul"}
    | {f"com{index}" for index in range(1, 10)}
    | {f"lpt{index}" for index in range(1, 10)}
)
_JSON_LIMITS = JsonLimits(
    max_message_bytes=MAX_CACHE_RECEIPT_BYTES,
    max_depth=32,
    max_container_items=500_000,
    max_string_bytes=2 * 1024 * 1024,
)
_REFERENCE_JSON_LIMITS = JsonLimits(
    max_message_bytes=24 * 1024 * 1024,
    max_depth=32,
    max_container_items=500_000,
    max_string_bytes=2 * 1024 * 1024,
)
_EVIDENCE_SOURCE_JSON_LIMITS = JsonLimits(
    max_message_bytes=MAX_EVIDENCE_BYTES,
    max_depth=32,
    max_container_items=500_000,
    max_string_bytes=4 * 1024 * 1024,
)


def _utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _is_canonical_utc_timestamp(value: Any) -> bool:
    if not isinstance(value, str) or not value or len(value) > 64:
        return False
    if not value.endswith("Z"):
        return False
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError:
        return False
    return parsed.tzinfo == UTC and parsed.isoformat().replace("+00:00", "Z") == value


def _validated_system_probe_spec(
    probe_args: Any,
    expected_pattern: Any,
    *,
    code: str,
    message: str,
) -> tuple[tuple[str, ...], re.Pattern[str]]:
    if (
        not isinstance(probe_args, Sequence)
        or isinstance(probe_args, (str, bytes, bytearray))
        or len(probe_args) > MAX_SYSTEM_PROBE_ARGS
        or not all(
            isinstance(item, str)
            and item
            and len(item) <= MAX_SYSTEM_PROBE_ARG_CHARS
            and "\x00" not in item
            and "\r" not in item
            and "\n" not in item
            for item in probe_args
        )
        or not isinstance(expected_pattern, str)
        or not expected_pattern
        or len(expected_pattern) > MAX_SYSTEM_PATTERN_CHARS
        or "\x00" in expected_pattern
    ):
        raise registry_error(code, message)
    try:
        pattern = re.compile(expected_pattern)
    except re.error as exc:
        raise registry_error(code, message) from exc
    return tuple(probe_args), pattern


def _hash_file(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    try:
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
                size += len(chunk)
    except OSError as exc:
        raise _io_error(exc, "unable to hash runtime content") from exc
    return f"sha256:{digest.hexdigest()}", size


def _fsync_directory(path: Path) -> None:
    if os.name == "nt":
        return
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _io_error(exc: OSError, message: str) -> RuntimeRegistryError:
    if exc.errno in {errno.ENOSPC, getattr(errno, "EDQUOT", -1)}:
        return registry_error(
            "PLUGIN_RUNTIME_REGISTRY_DISK_FULL",
            "managed runtime storage does not have enough available space",
        )
    return registry_error(
        "PLUGIN_RUNTIME_REGISTRY_IO_FAILED",
        message,
        details={"errorType": type(exc).__name__},
    )


def _atomic_write_bytes(path: Path, value: bytes, *, replace: bool = True) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.parent.is_symlink():
            raise registry_error(
                "PLUGIN_RUNTIME_REGISTRY_CACHE_UNSAFE",
                "managed runtime cache directory must not be a symbolic link",
            )
        temporary = path.parent / f".{path.name}.{uuid.uuid4().hex}.part"
        try:
            with temporary.open("xb") as stream:
                stream.write(value)
                stream.flush()
                os.fsync(stream.fileno())
            if path.exists() and not replace:
                if (
                    path.is_symlink()
                    or not path.is_file()
                    or path.read_bytes() != value
                ):
                    raise registry_error(
                        "PLUGIN_RUNTIME_REGISTRY_IMMUTABILITY_VIOLATION",
                        "content-addressed runtime registry content changed",
                    )
                temporary.unlink()
                return
            os.replace(temporary, path)
            _fsync_directory(path.parent)
        finally:
            temporary.unlink(missing_ok=True)
    except RuntimeRegistryError:
        raise
    except OSError as exc:
        raise _io_error(
            exc, "unable to atomically persist managed runtime state"
        ) from exc


def _atomic_write_json(path: Path, value: Any, *, replace: bool = True) -> None:
    _atomic_write_bytes(path, canonical_bytes(value), replace=replace)


def _read_json(path: Path, label: str, *, maximum: int) -> Any:
    try:
        if path.is_symlink() or not path.is_file():
            raise registry_error(
                "PLUGIN_RUNTIME_REGISTRY_STATE_INVALID",
                f"{label} must be a regular file",
            )
        size = path.stat().st_size
        if not 0 < size <= maximum:
            raise registry_error(
                "PLUGIN_RUNTIME_REGISTRY_STATE_INVALID",
                f"{label} has an invalid size",
            )
        data = path.read_bytes()
        value = loads_strict(data, limits=_JSON_LIMITS)
        if data != canonical_bytes(value):
            raise registry_error(
                "PLUGIN_RUNTIME_REGISTRY_STATE_INVALID",
                f"{label} must use canonical JSON encoding",
            )
        return value
    except RuntimeRegistryError:
        raise
    except (OSError, PlatformContractError) as exc:
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_STATE_INVALID",
            f"unable to read {label}",
            details={"errorType": type(exc).__name__},
        ) from exc


def _environment_bool(name: str, *, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    normalized = raw.strip().casefold()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise registry_error(
        "PLUGIN_RUNTIME_REGISTRY_CONFIGURATION_INVALID",
        f"{name} must be one of 0/1/false/true/no/yes/off/on",
    )


def host_platform() -> tuple[str, str]:
    operating_system = {
        "Windows": "windows",
        "Linux": "linux",
        "Darwin": "macos",
    }.get(platform.system())
    architecture = {
        "amd64": "x86_64",
        "x86_64": "x86_64",
        "aarch64": "arm64",
        "arm64": "arm64",
    }.get(platform.machine().casefold())
    if operating_system is None or architecture is None:
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_PLATFORM_UNSUPPORTED",
            "Host platform cannot be mapped to a managed runtime target",
            details={"system": platform.system(), "machine": platform.machine()},
        )
    return operating_system, architecture


def _evidence_invalid(
    message: str, *, details: Mapping[str, Any] | None = None
) -> RuntimeRegistryError:
    return registry_error(
        "PLUGIN_RUNTIME_REGISTRY_EVIDENCE_INVALID",
        message,
        details=details,
    )


def _projection_mapping(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise _evidence_invalid(f"{label} must be a JSON object")
    return value


def _projection_string(value: Any, label: str, *, maximum: int) -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value.encode("utf-8")) > maximum
        or "\x00" in value
    ):
        raise _evidence_invalid(f"{label} must be a bounded string")
    return value


def _projection_sha(value: Any, label: str) -> str:
    raw = _projection_string(value, label, maximum=71)
    if re.fullmatch(r"[0-9a-f]{40}", raw) is None:
        raise _evidence_invalid(f"{label} must be a lowercase Git SHA-1")
    return raw


def _projection_timestamp(value: Any, label: str) -> str:
    raw = _projection_string(value, label, maximum=64)
    if not _is_canonical_utc_timestamp(raw):
        raise _evidence_invalid(f"{label} must be a canonical UTC timestamp")
    return raw


def _github_release_asset_projection(value: Any, *, source_url: str) -> dict[str, Any]:
    item = _projection_mapping(value, "GitHub release asset evidence")
    asset_id = item.get("id")
    size = item.get("size")
    if (
        isinstance(asset_id, bool)
        or not isinstance(asset_id, int)
        or not 0 < asset_id <= 2**63 - 1
        or isinstance(size, bool)
        or not isinstance(size, int)
        or not 0 < size <= MAX_RUNTIME_ARCHIVE_BYTES
    ):
        raise _evidence_invalid("GitHub release asset id or size is invalid")
    name = _projection_string(
        item.get("name"), "GitHub release asset name", maximum=256
    )
    if name in {".", ".."} or "/" in name or "\\" in name:
        raise _evidence_invalid("GitHub release asset name is unsafe")
    digest = _projection_string(
        item.get("digest"), "GitHub release asset digest", maximum=71
    )
    if _SHA256.fullmatch(digest) is None:
        raise _evidence_invalid("GitHub release asset digest must be SHA-256")
    api_url = _projection_string(
        item.get("url"), "GitHub release asset API URL", maximum=2048
    )
    browser_url = _projection_string(
        item.get("browser_download_url"),
        "GitHub release asset download URL",
        maximum=2048,
    )
    if api_url != source_url:
        raise _evidence_invalid(
            "GitHub release asset response does not match its requested URL"
        )
    browser = urlsplit(browser_url)
    if (
        browser.scheme != "https"
        or browser.hostname != "github.com"
        or browser.port is not None
        or browser.username is not None
        or browser.password is not None
        or browser.query
        or browser.fragment
    ):
        raise _evidence_invalid("GitHub release asset download URL is invalid")
    state = _projection_string(
        item.get("state"), "GitHub release asset state", maximum=32
    )
    if state != "uploaded":
        raise _evidence_invalid("GitHub release asset is not in the uploaded state")
    return {
        "schemaVersion": "candlescope.github-release-asset-evidence/1",
        "browserDownloadUrl": browser_url,
        "contentType": _projection_string(
            item.get("content_type"), "GitHub release asset content type", maximum=128
        ),
        "createdAt": _projection_timestamp(
            item.get("created_at"), "GitHub release asset created_at"
        ),
        "digest": digest,
        "id": asset_id,
        "name": name,
        "size": size,
        "state": state,
        "updatedAt": _projection_timestamp(
            item.get("updated_at"), "GitHub release asset updated_at"
        ),
        "url": api_url,
    }


def _github_identity_projection(value: Any, label: str) -> dict[str, str]:
    item = _projection_mapping(value, label)
    return {
        "date": _projection_timestamp(item.get("date"), f"{label}.date"),
        "email": _projection_string(item.get("email"), f"{label}.email", maximum=512),
        "name": _projection_string(item.get("name"), f"{label}.name", maximum=512),
    }


def _github_git_commit_projection(value: Any, *, source_url: str) -> dict[str, Any]:
    item = _projection_mapping(value, "GitHub git commit evidence")
    requested_sha = source_url.rsplit("/", 1)[-1]
    sha = _projection_sha(item.get("sha"), "GitHub git commit sha")
    if sha != requested_sha:
        raise _evidence_invalid(
            "GitHub git commit response does not match its requested SHA"
        )
    tree = _projection_mapping(item.get("tree"), "GitHub git commit tree")
    parents_value = item.get("parents")
    if (
        not isinstance(parents_value, Sequence)
        or isinstance(parents_value, (str, bytes, bytearray))
        or len(parents_value) > 64
    ):
        raise _evidence_invalid("GitHub git commit parents must be a bounded array")
    parents = [
        _projection_sha(
            _projection_mapping(parent, f"GitHub git commit parents[{index}]").get(
                "sha"
            ),
            f"GitHub git commit parents[{index}].sha",
        )
        for index, parent in enumerate(parents_value)
    ]
    verification = _projection_mapping(
        item.get("verification"), "GitHub git commit verification"
    )
    if (
        verification.get("verified") is not True
        or verification.get("reason") != "valid"
    ):
        raise _evidence_invalid("GitHub git commit signature is not verified")
    signature = _projection_string(
        verification.get("signature"),
        "GitHub git commit verification.signature",
        maximum=256 * 1024,
    )
    if not (
        signature.startswith("-----BEGIN PGP SIGNATURE-----")
        and signature.rstrip().endswith("-----END PGP SIGNATURE-----")
    ):
        raise _evidence_invalid(
            "GitHub git commit verification is not an armored PGP signature"
        )
    return {
        "schemaVersion": "candlescope.github-git-commit-evidence/1",
        "author": _github_identity_projection(
            item.get("author"), "GitHub git commit author"
        ),
        "committer": _github_identity_projection(
            item.get("committer"), "GitHub git commit committer"
        ),
        "message": _projection_string(
            item.get("message"), "GitHub git commit message", maximum=1024 * 1024
        ),
        "parents": parents,
        "sha": sha,
        "tree": _projection_sha(tree.get("sha"), "GitHub git commit tree.sha"),
        "verification": {
            "payload": _projection_string(
                verification.get("payload"),
                "GitHub git commit verification.payload",
                maximum=2 * 1024 * 1024,
            ),
            "reason": "valid",
            "signature": signature,
            "verified": True,
            "verifiedAt": _projection_timestamp(
                verification.get("verified_at"),
                "GitHub git commit verification.verified_at",
            ),
        },
    }


def project_runtime_evidence_bytes(
    source: bytes,
    *,
    projection: str,
    source_url: str,
) -> bytes:
    """Project mutable GitHub API envelopes into a minimal, signed canonical record."""

    try:
        value = loads_strict(source, limits=_EVIDENCE_SOURCE_JSON_LIMITS)
    except (PlatformContractError, UnicodeDecodeError) as exc:
        raise _evidence_invalid(
            "runtime evidence source is not strict bounded JSON",
            details={"projection": projection},
        ) from exc
    if projection == "github-release-asset-v1":
        projected = _github_release_asset_projection(value, source_url=source_url)
    elif projection == "github-git-commit-v1":
        projected = _github_git_commit_projection(value, source_url=source_url)
    else:
        raise _evidence_invalid(
            "runtime evidence projection is unsupported",
            details={"projection": projection},
        )
    return canonical_bytes(projected)


class RuntimeArtifactFetcher(Protocol):
    def fetch(self, url: str, destination: Path, *, maximum: int) -> None: ...


class HttpsRuntimeArtifactFetcher:
    """HTTPS-only streaming fetcher with no ambient proxy and bounded redirects."""

    def __init__(self, *, timeout_seconds: float = DOWNLOAD_TIMEOUT_SECONDS) -> None:
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be positive")
        self.timeout_seconds = float(timeout_seconds)

    @staticmethod
    def _validated_url(value: str) -> str:
        parsed = urlsplit(value)
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
        ):
            raise registry_error(
                "PLUGIN_RUNTIME_REGISTRY_DOWNLOAD_FAILED",
                "runtime download or redirect did not use credential-free HTTPS",
            )
        return value

    def fetch(self, url: str, destination: Path, *, maximum: int) -> None:
        if maximum <= 0 or maximum > MAX_RUNTIME_ARCHIVE_BYTES:
            raise ValueError("maximum download size is invalid")
        current = self._validated_url(url)
        try:
            with httpx.Client(
                trust_env=False,
                follow_redirects=False,
                timeout=self.timeout_seconds,
                headers={"User-Agent": "CandleScope-RuntimeRegistry/1"},
            ) as client:
                for redirect_count in range(6):
                    with client.stream("GET", current) as response:
                        if response.status_code in {301, 302, 303, 307, 308}:
                            location = response.headers.get("location")
                            if redirect_count == 5 or not location:
                                raise registry_error(
                                    "PLUGIN_RUNTIME_REGISTRY_DOWNLOAD_FAILED",
                                    "runtime download exceeded the redirect policy",
                                )
                            current = self._validated_url(urljoin(current, location))
                            continue
                        if response.status_code != 200:
                            raise registry_error(
                                "PLUGIN_RUNTIME_REGISTRY_DOWNLOAD_FAILED",
                                "runtime download returned an unexpected HTTP status",
                                details={"status": response.status_code},
                            )
                        raw_length = response.headers.get("content-length")
                        if raw_length is not None:
                            try:
                                content_length = int(raw_length)
                            except ValueError as exc:
                                raise registry_error(
                                    "PLUGIN_RUNTIME_REGISTRY_DOWNLOAD_FAILED",
                                    "runtime download Content-Length is invalid",
                                ) from exc
                            if content_length < 0 or content_length > maximum:
                                raise registry_error(
                                    "PLUGIN_RUNTIME_REGISTRY_DOWNLOAD_LIMIT_EXCEEDED",
                                    "runtime download exceeds its signed size bound",
                                )
                        written = 0
                        with destination.open("xb") as stream:
                            for chunk in response.iter_bytes(1024 * 1024):
                                written += len(chunk)
                                if written > maximum:
                                    raise registry_error(
                                        "PLUGIN_RUNTIME_REGISTRY_DOWNLOAD_LIMIT_EXCEEDED",
                                        "runtime download exceeds its signed size bound",
                                    )
                                stream.write(chunk)
                            stream.flush()
                            os.fsync(stream.fileno())
                        return
                raise AssertionError("redirect loop must return or raise")
        except RuntimeRegistryError:
            raise
        except OSError as exc:
            raise _io_error(exc, "runtime download could not be staged") from exc
        except httpx.HTTPError as exc:
            raise registry_error(
                "PLUGIN_RUNTIME_REGISTRY_DOWNLOAD_FAILED",
                "runtime download transport failed",
                details={"errorType": type(exc).__name__},
            ) from exc


@dataclass(frozen=True, slots=True)
class ProbeResult:
    argv: tuple[str, ...]
    exit_code: int
    stdout: str
    stderr: str
    sha256: str

    def to_wire(self) -> dict[str, Any]:
        return {
            "argv": list(self.argv),
            "exitCode": self.exit_code,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "sha256": self.sha256,
        }


@dataclass(frozen=True, slots=True)
class EnsuredRuntime:
    release: RuntimeRelease
    root: Path
    executable: Path
    supply: RuntimeSupplyBinding
    probe: ProbeResult
    quick_repeat: bool
    downloaded_files: int
    quarantined_entries: int

    def to_public_wire(self) -> dict[str, Any]:
        return {
            "runtime": self.supply.to_wire(),
            "root": str(self.root),
            "quickRepeat": self.quick_repeat,
            "downloadedFiles": self.downloaded_files,
            "quarantinedEntries": self.quarantined_entries,
            "probe": self.probe.to_wire(),
        }


def _safe_process_environment(runtime_root: Path) -> dict[str, str]:
    allowed = {
        "APPDATA",
        "HOME",
        "LANG",
        "LC_ALL",
        "LOCALAPPDATA",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
        "TMPDIR",
        "USERPROFILE",
        "WINDIR",
    }
    environment = {key: value for key, value in os.environ.items() if key in allowed}
    search = [str(runtime_root / "bin")]
    system_root = environment.get("SYSTEMROOT") or environment.get("WINDIR")
    if system_root:
        search.append(str(Path(system_root) / "System32"))
    environment["PATH"] = os.pathsep.join(search)
    environment["JAVA_HOME"] = str(runtime_root)
    environment["NO_COLOR"] = "1"
    return environment


def _decode_output(value: bytes, label: str) -> str:
    try:
        return value.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_PROBE_FAILED",
            f"runtime probe {label} is not UTF-8",
        ) from exc


def _run_probe(release: RuntimeRelease, runtime_root: Path) -> ProbeResult:
    executable = runtime_root.joinpath(*PurePosixPath(release.executable).parts)
    command = [
        str(executable),
        *release.probe.argv[1:],
    ]
    try:
        completed = subprocess.run(
            command,
            cwd=runtime_root,
            env=_safe_process_environment(runtime_root),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=release.probe.timeout_seconds,
            check=False,
            shell=False,
            creationflags=(subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0),
        )
    except subprocess.TimeoutExpired as exc:
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_PROBE_TIMEOUT",
            "managed runtime fresh-process probe timed out",
            details={"runtimeId": release.runtime_id},
        ) from exc
    except OSError as exc:
        raise _io_error(
            exc, "managed runtime fresh-process probe could not start"
        ) from exc
    if (
        len(completed.stdout) > MAX_PROBE_OUTPUT_BYTES
        or len(completed.stderr) > MAX_PROBE_OUTPUT_BYTES
    ):
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_PROBE_OUTPUT_LIMIT_EXCEEDED",
            "managed runtime probe exceeded the output limit",
        )
    stdout = _decode_output(completed.stdout, "stdout")
    stderr = _decode_output(completed.stderr, "stderr")
    if (
        completed.returncode != release.probe.expected_exit_code
        or re.search(release.probe.stdout_regex, stdout) is None
        or re.search(release.probe.stderr_regex, stderr) is None
    ):
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_PROBE_FAILED",
            "managed runtime fresh-process version probe did not match its signed contract",
            details={
                "runtimeId": release.runtime_id,
                "exitCode": completed.returncode,
            },
        )
    digest = sha256_bytes(
        canonical_bytes(
            {
                "argv": release.probe.to_wire()["argv"],
                "exitCode": completed.returncode,
                "stdout": stdout,
                "stderr": stderr,
            }
        )
    )
    return ProbeResult(
        tuple(release.probe.argv), completed.returncode, stdout, stderr, digest
    )


def _archive_member_path(name: str, *, strip_prefix: str) -> str | None:
    if "\\" in name or "\x00" in name:
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_ARCHIVE_UNSAFE",
            "runtime archive contains a non-canonical member path",
        )
    raw = name.rstrip("/")
    if not raw:
        return None
    path = PurePosixPath(raw)
    if (
        path.is_absolute()
        or path.as_posix() != raw
        or any(part in {"", ".", ".."} for part in path.parts)
    ):
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_ARCHIVE_UNSAFE",
            "runtime archive contains a traversal path",
        )
    prefix = PurePosixPath(strip_prefix)
    if path == prefix:
        return None
    try:
        relative = path.relative_to(prefix)
    except ValueError as exc:
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_ARCHIVE_UNSAFE",
            "runtime archive member is outside its signed strip prefix",
        ) from exc
    result = relative.as_posix()
    _portable_path_key(result)
    return result


def _portable_path_key(value: str) -> str:
    parts = value.split("/")
    if len(value) > 1024 or not parts:
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_ARCHIVE_UNSAFE",
            "runtime archive contains an overlong member path",
        )
    for part in parts:
        device_stem = part.split(".", 1)[0].casefold()
        if (
            not part
            or len(part) > 255
            or part[-1] in {".", " "}
            or ":" in part
            or any(ord(character) < 32 or ord(character) == 127 for character in part)
            or device_stem in _WINDOWS_RESERVED_NAMES
        ):
            raise registry_error(
                "PLUGIN_RUNTIME_REGISTRY_ARCHIVE_UNSAFE",
                "runtime archive contains a non-portable member path",
            )
    return unicodedata.normalize("NFC", value).casefold()


def _copy_stream(source: Any, target: Any, *, expected_size: int) -> None:
    written = 0
    while True:
        chunk = source.read(min(1024 * 1024, expected_size - written + 1))
        if not chunk:
            break
        written += len(chunk)
        if written > expected_size:
            raise registry_error(
                "PLUGIN_RUNTIME_REGISTRY_ARCHIVE_INVALID",
                "runtime archive member exceeded its declared size",
            )
        target.write(chunk)
    if written != expected_size:
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_ARCHIVE_INVALID",
            "runtime archive member size did not match its declaration",
        )


def _extract_zip(release: RuntimeRelease, archive: Path, destination: Path) -> None:
    try:
        with zipfile.ZipFile(archive, "r") as package:
            files: list[tuple[zipfile.ZipInfo, str]] = []
            seen: set[str] = set()
            total = 0
            for entry in package.infolist():
                relative = _archive_member_path(
                    entry.filename, strip_prefix=release.strip_prefix
                )
                if relative is None or entry.is_dir():
                    continue
                mode = entry.external_attr >> 16
                if stat.S_ISLNK(mode):
                    raise registry_error(
                        "PLUGIN_RUNTIME_REGISTRY_ARCHIVE_UNSAFE",
                        "runtime ZIP contains a symbolic link",
                    )
                folded = _portable_path_key(relative)
                if folded in seen:
                    raise registry_error(
                        "PLUGIN_RUNTIME_REGISTRY_ARCHIVE_UNSAFE",
                        "runtime ZIP contains case-colliding paths",
                    )
                seen.add(folded)
                total += entry.file_size
                if total > release.extracted_size or len(files) >= release.file_count:
                    raise registry_error(
                        "PLUGIN_RUNTIME_REGISTRY_ARCHIVE_LIMIT_EXCEEDED",
                        "runtime ZIP exceeds its signed extraction bounds",
                    )
                files.append((entry, relative))
            if len(files) != release.file_count or total != release.extracted_size:
                raise registry_error(
                    "PLUGIN_RUNTIME_REGISTRY_ARCHIVE_INVALID",
                    "runtime ZIP file count or extracted size does not match the signed registry",
                )
            for entry, relative in files:
                target = destination.joinpath(*PurePosixPath(relative).parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                if target.exists() or target.is_symlink():
                    raise registry_error(
                        "PLUGIN_RUNTIME_REGISTRY_ARCHIVE_UNSAFE",
                        "runtime ZIP attempted to replace an extracted path",
                    )
                with package.open(entry, "r") as source, target.open("xb") as output:
                    _copy_stream(source, output, expected_size=entry.file_size)
                    output.flush()
                    os.fsync(output.fileno())
                if mode & stat.S_IXUSR and os.name != "nt":
                    target.chmod(0o555)
    except RuntimeRegistryError:
        raise
    except (OSError, zipfile.BadZipFile, RuntimeError) as exc:
        if isinstance(exc, OSError):
            mapped = _io_error(exc, "runtime ZIP extraction failed")
            if mapped.code == "PLUGIN_RUNTIME_REGISTRY_DISK_FULL":
                raise mapped from exc
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_EXTRACT_FAILED",
            "runtime ZIP could not be safely extracted",
            details={"errorType": type(exc).__name__},
        ) from exc


def _extract_tar(release: RuntimeRelease, archive: Path, destination: Path) -> None:
    try:
        mode = "r:gz" if release.archive_format == "tar.gz" else "r:xz"
        with tarfile.open(archive, mode) as package:
            files: list[tuple[tarfile.TarInfo, str]] = []
            seen: set[str] = set()
            total = 0
            for entry in package.getmembers():
                relative = _archive_member_path(
                    entry.name, strip_prefix=release.strip_prefix
                )
                if relative is None or entry.isdir():
                    continue
                if not entry.isfile() or entry.issym() or entry.islnk():
                    raise registry_error(
                        "PLUGIN_RUNTIME_REGISTRY_ARCHIVE_UNSAFE",
                        "runtime tar archive contains a link or special file",
                    )
                folded = _portable_path_key(relative)
                if folded in seen:
                    raise registry_error(
                        "PLUGIN_RUNTIME_REGISTRY_ARCHIVE_UNSAFE",
                        "runtime tar archive contains case-colliding paths",
                    )
                seen.add(folded)
                total += entry.size
                if total > release.extracted_size or len(files) >= release.file_count:
                    raise registry_error(
                        "PLUGIN_RUNTIME_REGISTRY_ARCHIVE_LIMIT_EXCEEDED",
                        "runtime tar archive exceeds its signed extraction bounds",
                    )
                files.append((entry, relative))
            if len(files) != release.file_count or total != release.extracted_size:
                raise registry_error(
                    "PLUGIN_RUNTIME_REGISTRY_ARCHIVE_INVALID",
                    "runtime tar file count or extracted size does not match the signed registry",
                )
            for entry, relative in files:
                target = destination.joinpath(*PurePosixPath(relative).parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                source = package.extractfile(entry)
                if source is None:
                    raise registry_error(
                        "PLUGIN_RUNTIME_REGISTRY_ARCHIVE_INVALID",
                        "runtime tar member could not be read",
                    )
                with source, target.open("xb") as output:
                    _copy_stream(source, output, expected_size=entry.size)
                    output.flush()
                    os.fsync(output.fileno())
                target.chmod(0o555 if entry.mode & stat.S_IXUSR else 0o444)
    except RuntimeRegistryError:
        raise
    except (OSError, tarfile.TarError) as exc:
        if isinstance(exc, OSError):
            mapped = _io_error(exc, "runtime tar extraction failed")
            if mapped.code == "PLUGIN_RUNTIME_REGISTRY_DISK_FULL":
                raise mapped from exc
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_EXTRACT_FAILED",
            "runtime tar archive could not be safely extracted",
            details={"errorType": type(exc).__name__},
        ) from exc


def _inventory(root: Path) -> tuple[list[dict[str, Any]], int]:
    records: list[dict[str, Any]] = []
    total = 0
    try:
        for path in sorted(
            root.rglob("*"), key=lambda item: item.as_posix().casefold()
        ):
            if path.is_symlink():
                raise registry_error(
                    "PLUGIN_RUNTIME_REGISTRY_CACHE_UNSAFE",
                    "managed runtime cache contains a symbolic link",
                )
            if path.is_dir():
                continue
            if not path.is_file():
                raise registry_error(
                    "PLUGIN_RUNTIME_REGISTRY_CACHE_UNSAFE",
                    "managed runtime cache contains a special file",
                )
            relative = path.relative_to(root).as_posix()
            _portable_path_key(relative)
            digest, size = _hash_file(path)
            records.append({"path": relative, "sha256": digest, "size": size})
            total += size
    except RuntimeRegistryError:
        raise
    except OSError as exc:
        raise _io_error(exc, "managed runtime inventory could not be read") from exc
    paths = [_portable_path_key(item["path"]) for item in records]
    if len(paths) != len(set(paths)):
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_CACHE_UNSAFE",
            "managed runtime cache contains case-colliding files",
        )
    return records, total


def _validate_legal_inventory(release: RuntimeRelease, root: Path) -> None:
    if release.legal_directory == ".":
        legal_files = [
            root.joinpath(*PurePosixPath(item.path).parts)
            for item in release.license_files
        ]
    else:
        legal = root.joinpath(*PurePosixPath(release.legal_directory).parts)
        if legal.is_symlink() or not legal.is_dir():
            raise registry_error(
                "PLUGIN_RUNTIME_REGISTRY_LICENSE_INVALID",
                "managed runtime legal directory is missing",
            )
        legal_files = [path for path in legal.rglob("*") if path.is_file()]
    if any(path.is_symlink() or not path.is_file() for path in legal_files):
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_LICENSE_INVALID",
            "managed runtime legal inventory is missing or contains a symbolic link",
        )
    legal_size = sum(path.stat().st_size for path in legal_files)
    if len(legal_files) != release.legal_file_count or legal_size != release.legal_size:
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_LICENSE_INVALID",
            "managed runtime legal inventory does not match the signed registry",
        )
    for item in release.license_files:
        path = root.joinpath(*PurePosixPath(item.path).parts)
        if (
            path.is_symlink()
            or not path.is_file()
            or _hash_file(path)
            != (
                item.sha256,
                item.size,
            )
        ):
            raise registry_error(
                "PLUGIN_RUNTIME_REGISTRY_LICENSE_INVALID",
                "managed runtime license evidence does not match the signed registry",
                details={"path": item.path},
            )


def _mark_read_only(root: Path) -> None:
    try:
        for path in sorted(root.rglob("*"), reverse=True):
            if path.is_file():
                executable = bool(path.stat().st_mode & stat.S_IXUSR) or (
                    os.name == "nt" and path.suffix.casefold() in {".exe", ".dll"}
                )
                path.chmod(0o555 if executable else 0o444)
        if os.name != "nt":
            for path in sorted(
                (entry for entry in root.rglob("*") if entry.is_dir()), reverse=True
            ):
                path.chmod(0o555)
            root.chmod(0o555)
    except OSError as exc:
        raise _io_error(
            exc, "managed runtime cache could not be made read-only"
        ) from exc


def _make_tree_writable(root: Path) -> None:
    if not root.exists():
        return
    for path in root.rglob("*"):
        try:
            path.chmod(0o755 if path.is_dir() else 0o644)
        except OSError:
            pass
    try:
        root.chmod(0o755)
    except OSError:
        pass


class ManagedRuntimeRegistryService:
    """Owns signed registry state and content-addressed language runtimes."""

    def __init__(
        self,
        *,
        root: Path | str,
        roots: Iterable[RuntimeRegistryRoot],
        bootstrap_registry: bytes | None = None,
        bootstrap_history: Iterable[bytes] = (),
        enabled: bool | None = None,
        network_updates_enabled: bool | None = None,
        fetcher: RuntimeArtifactFetcher | None = None,
    ) -> None:
        self.root = Path(root).expanduser().resolve(strict=False)
        self.roots = tuple(roots)
        self.enabled = (
            _environment_bool(RUNTIME_REGISTRY_ENABLED_ENV, default=False)
            if enabled is None
            else enabled
        )
        self.network_updates_enabled = (
            _environment_bool(RUNTIME_REGISTRY_NETWORK_UPDATES_ENV, default=False)
            if network_updates_enabled is None
            else network_updates_enabled
        )
        if not isinstance(self.enabled, bool) or not isinstance(
            self.network_updates_enabled, bool
        ):
            raise ValueError("runtime registry enablement must be boolean")
        self.fetcher = fetcher or HttpsRuntimeArtifactFetcher()
        if not callable(getattr(self.fetcher, "fetch", None)):
            raise ValueError("runtime registry fetcher is invalid")
        self.bootstrap_registry = bootstrap_registry
        self.bootstrap_history = tuple(bootstrap_history)
        if self.enabled:
            if not self.roots:
                raise registry_error(
                    "PLUGIN_RUNTIME_REGISTRY_ROOT_UNTRUSTED",
                    "enabled managed runtime registry has no build-pinned trust root",
                )
            self._assert_root_safe()
            with security_lock(self.lock_path):
                if not self.state_path.exists():
                    if bootstrap_registry is None:
                        raise registry_error(
                            "PLUGIN_RUNTIME_REGISTRY_STATE_INVALID",
                            "enabled managed runtime registry has no bootstrap revision",
                        )
                    documents = (*self.bootstrap_history, bootstrap_registry)
                    verified_chain = [
                        verify_runtime_registry_bytes(document, self.roots)
                        for document in documents
                    ]
                    first = verified_chain[0]
                    if (
                        first.revision != 1
                        or first.previous_registry_sha256 is not None
                    ):
                        raise registry_error(
                            "PLUGIN_RUNTIME_REGISTRY_CHAIN_INVALID",
                            "bootstrap runtime registry chain must start at revision 1",
                        )
                    for previous, candidate in zip(
                        verified_chain, verified_chain[1:], strict=False
                    ):
                        if (
                            candidate.registry_id != previous.registry_id
                            or candidate.revision != previous.revision + 1
                            or candidate.previous_registry_sha256 != previous.sha256
                        ):
                            raise registry_error(
                                "PLUGIN_RUNTIME_REGISTRY_CHAIN_INVALID",
                                "bootstrap runtime registry history is not a continuous signed chain",
                            )
                    verified = verified_chain[-1]
                    for item in verified_chain:
                        self._store_registry(item)
                    self._write_state(
                        {
                            "schemaVersion": STATE_SCHEMA_VERSION,
                            "activeRegistrySha256": verified.sha256,
                            "history": [item.sha256 for item in verified_chain[:-1]],
                            "acceptedRegistrySha256": [
                                item.sha256 for item in verified_chain
                            ],
                            "revokedArtifactSha256": sorted(
                                {
                                    revocation.sha256
                                    for registry in verified_chain
                                    for revocation in registry.revocations
                                }
                            ),
                        }
                    )
                self._active_registry_locked()

    @classmethod
    def from_files(
        cls,
        *,
        root: Path | str,
        roots_path: Path | str,
        registry_path: Path | str,
        enabled: bool | None = None,
        network_updates_enabled: bool | None = None,
        fetcher: RuntimeArtifactFetcher | None = None,
    ) -> "ManagedRuntimeRegistryService":
        roots_file = Path(roots_path)
        registry_file = Path(registry_path)
        try:
            roots = load_runtime_registry_roots_bytes(roots_file.read_bytes())
            registry = registry_file.read_bytes()
        except OSError as exc:
            raise registry_error(
                "PLUGIN_RUNTIME_REGISTRY_CONFIGURATION_INVALID",
                "build-pinned Runtime Registry assets could not be read",
                details={"errorType": type(exc).__name__},
            ) from exc
        return cls(
            root=root,
            roots=roots,
            bootstrap_registry=registry,
            enabled=enabled,
            network_updates_enabled=network_updates_enabled,
            fetcher=fetcher,
        )

    @property
    def lock_path(self) -> Path:
        return self.root / ".runtime-registry.lock"

    @property
    def state_path(self) -> Path:
        return self.root / "registry-state.json"

    @property
    def registries_directory(self) -> Path:
        return self.root / "registries"

    @property
    def archives_directory(self) -> Path:
        return self.root / "archives"

    @property
    def evidence_directory(self) -> Path:
        return self.root / "evidence"

    @property
    def cache_directory(self) -> Path:
        return self.root / "cache"

    @property
    def staging_directory(self) -> Path:
        return self.root / "staging"

    @property
    def quarantine_directory(self) -> Path:
        return self.root / "quarantine"

    @property
    def retired_directory(self) -> Path:
        return self.root / "retired"

    @property
    def system_registry_path(self) -> Path:
        return self.root / "system-runtimes.json"

    def _assert_enabled(self) -> None:
        if not self.enabled:
            raise registry_error(
                "PLUGIN_RUNTIME_REGISTRY_DISABLED",
                "Host-managed Runtime Registry is disabled",
            )

    def _assert_root_safe(self) -> None:
        try:
            if self.root.exists() and (
                self.root.is_symlink() or not self.root.is_dir()
            ):
                raise registry_error(
                    "PLUGIN_RUNTIME_REGISTRY_CACHE_UNSAFE",
                    "managed runtime root must be a real directory",
                )
            self.root.mkdir(parents=True, exist_ok=True)
            for path in (
                self.registries_directory,
                self.archives_directory,
                self.evidence_directory,
                self.cache_directory,
                self.staging_directory,
                self.quarantine_directory,
                self.retired_directory,
            ):
                path.mkdir(parents=True, exist_ok=True)
                if path.is_symlink() or not path.is_dir():
                    raise registry_error(
                        "PLUGIN_RUNTIME_REGISTRY_CACHE_UNSAFE",
                        "managed runtime state contains an unsafe directory",
                    )
        except RuntimeRegistryError:
            raise
        except OSError as exc:
            raise _io_error(
                exc, "managed runtime directories could not be prepared"
            ) from exc

    def _registry_path(self, digest: str) -> Path:
        if _SHA256.fullmatch(digest) is None:
            raise registry_error(
                "PLUGIN_RUNTIME_REGISTRY_STATE_INVALID",
                "runtime registry digest is invalid",
            )
        return self.registries_directory / f"{digest.removeprefix('sha256:')}.json"

    def _archive_path(self, release: RuntimeRelease) -> Path:
        suffix = {
            "tar.gz": ".tar.gz",
            "tar.xz": ".tar.xz",
            "zip": ".zip",
        }[release.archive_format]
        return (
            self.archives_directory
            / f"{release.sha256.removeprefix('sha256:')}{suffix}"
        )

    def _evidence_path(self, evidence: RuntimeEvidence) -> Path:
        return (
            self.evidence_directory
            / evidence.sha256.removeprefix("sha256:")
            / evidence.file_name
        )

    def _cache_path(self, release: RuntimeRelease) -> Path:
        return (
            self.cache_directory
            / release.runtime_id
            / release.sha256.removeprefix("sha256:")
        )

    @staticmethod
    def _payload_path(cache: Path) -> Path:
        return cache / "payload"

    @staticmethod
    def _receipt_path(cache: Path) -> Path:
        return cache / "runtime-receipt.json"

    def _store_registry(self, registry: VerifiedRuntimeRegistry) -> None:
        _atomic_write_bytes(
            self._registry_path(registry.sha256),
            registry.canonical_document,
            replace=False,
        )

    def _read_state(self) -> dict[str, Any]:
        value = _read_json(
            self.state_path,
            "runtime registry state",
            maximum=MAX_REGISTRY_BYTES,
        )
        if not isinstance(value, dict) or set(value) != {
            "schemaVersion",
            "activeRegistrySha256",
            "history",
            "acceptedRegistrySha256",
            "revokedArtifactSha256",
        }:
            raise registry_error(
                "PLUGIN_RUNTIME_REGISTRY_STATE_INVALID",
                "runtime registry state fields are invalid",
            )
        if value["schemaVersion"] != STATE_SCHEMA_VERSION:
            raise registry_error(
                "PLUGIN_RUNTIME_REGISTRY_STATE_INVALID",
                "runtime registry state schemaVersion is unsupported",
            )
        for name in (
            "activeRegistrySha256",
            "history",
            "acceptedRegistrySha256",
            "revokedArtifactSha256",
        ):
            raw = value[name]
            values = [raw] if name == "activeRegistrySha256" else raw
            if not isinstance(values, list) or not all(
                isinstance(item, str) and _SHA256.fullmatch(item) for item in values
            ):
                raise registry_error(
                    "PLUGIN_RUNTIME_REGISTRY_STATE_INVALID",
                    f"runtime registry state {name} is invalid",
                )
        accepted = value["acceptedRegistrySha256"]
        revoked = value["revokedArtifactSha256"]
        history = value["history"]
        if (
            len(set(accepted)) != len(accepted)
            or revoked != sorted(set(revoked))
            or len(set(history)) != len(history)
            or value["activeRegistrySha256"] not in accepted
            or any(item not in accepted for item in history)
        ):
            raise registry_error(
                "PLUGIN_RUNTIME_REGISTRY_STATE_INVALID",
                "runtime registry state ordering or references are invalid",
            )
        return value

    def _write_state(self, value: Mapping[str, Any]) -> None:
        _atomic_write_json(self.state_path, dict(value))

    def _load_registry_digest(self, digest: str) -> VerifiedRuntimeRegistry:
        path = self._registry_path(digest)
        try:
            data = path.read_bytes()
        except OSError as exc:
            raise registry_error(
                "PLUGIN_RUNTIME_REGISTRY_STATE_INVALID",
                "accepted runtime registry revision is missing",
            ) from exc
        registry = verify_runtime_registry_bytes(data, self.roots)
        if registry.sha256 != digest:
            raise registry_error(
                "PLUGIN_RUNTIME_REGISTRY_STATE_INVALID",
                "accepted runtime registry digest changed",
            )
        return registry

    def _active_registry_locked(self) -> tuple[VerifiedRuntimeRegistry, dict[str, Any]]:
        state = self._read_state()
        return self._load_registry_digest(state["activeRegistrySha256"]), state

    def active_registry(self) -> VerifiedRuntimeRegistry:
        self._assert_enabled()
        with security_lock(self.lock_path):
            return self._active_registry_locked()[0]

    def activate_registry(self, document: bytes) -> dict[str, Any]:
        """Explicitly import the next signed revision; never fetch it automatically."""

        self._assert_enabled()
        candidate = verify_runtime_registry_bytes(document, self.roots)
        with security_lock(self.lock_path):
            current, state = self._active_registry_locked()
            if candidate.sha256 == current.sha256:
                return {
                    "changed": False,
                    "registryId": current.registry_id,
                    "revision": current.revision,
                    "registrySha256": current.sha256,
                }
            if (
                candidate.registry_id != current.registry_id
                or candidate.revision != current.revision + 1
                or candidate.previous_registry_sha256 != current.sha256
            ):
                raise registry_error(
                    "PLUGIN_RUNTIME_REGISTRY_CHAIN_INVALID",
                    "runtime registry update does not extend the active signed revision",
                    details={
                        "currentRevision": current.revision,
                        "candidateRevision": candidate.revision,
                    },
                )
            self._store_registry(candidate)
            accepted = [*state["acceptedRegistrySha256"]]
            if candidate.sha256 not in accepted:
                accepted.append(candidate.sha256)
            revoked = sorted(
                {
                    *state["revokedArtifactSha256"],
                    *(item.sha256 for item in candidate.revocations),
                }
            )
            self._write_state(
                {
                    "schemaVersion": STATE_SCHEMA_VERSION,
                    "activeRegistrySha256": candidate.sha256,
                    "history": [*state["history"], current.sha256],
                    "acceptedRegistrySha256": accepted,
                    "revokedArtifactSha256": revoked,
                }
            )
            return {
                "changed": True,
                "registryId": candidate.registry_id,
                "revision": candidate.revision,
                "registrySha256": candidate.sha256,
                "revokedArtifactSha256": revoked,
            }

    def rollback_registry(self) -> dict[str, Any]:
        self._assert_enabled()
        with security_lock(self.lock_path):
            current, state = self._active_registry_locked()
            history = list(state["history"])
            if not history:
                raise registry_error(
                    "PLUGIN_RUNTIME_REGISTRY_ROLLBACK_UNAVAILABLE",
                    "runtime registry has no prior verified revision",
                )
            target_digest = history.pop()
            target = self._load_registry_digest(target_digest)
            if (
                target.registry_id != current.registry_id
                or current.previous_registry_sha256 != target.sha256
            ):
                raise registry_error(
                    "PLUGIN_RUNTIME_REGISTRY_CHAIN_INVALID",
                    "runtime registry rollback target does not match the signed chain",
                )
            self._write_state(
                {
                    **state,
                    "activeRegistrySha256": target.sha256,
                    "history": history,
                }
            )
            return {
                "changed": True,
                "fromRevision": current.revision,
                "toRevision": target.revision,
                "registrySha256": target.sha256,
                "revocationsPreserved": list(state["revokedArtifactSha256"]),
            }

    def _resolve_locked(
        self,
        runtime_id: str,
        kind: str,
        *,
        operating_system: str | None,
        architecture: str | None,
    ) -> tuple[VerifiedRuntimeRegistry, RuntimeRelease, dict[str, Any]]:
        if _ID.fullmatch(runtime_id) is None:
            raise registry_error(
                "PLUGIN_RUNTIME_REGISTRY_RUNTIME_NOT_FOUND",
                "managed runtime id is invalid",
            )
        os_name, arch_name = host_platform()
        operating_system = operating_system or os_name
        architecture = architecture or arch_name
        registry, state = self._active_registry_locked()
        release = registry.by_key().get(
            (runtime_id, kind, operating_system, architecture)
        )
        if release is None:
            raise registry_error(
                "PLUGIN_RUNTIME_REGISTRY_RUNTIME_NOT_FOUND",
                "signed Runtime Registry has no exact runtime for this Host target",
                details={
                    "runtimeId": runtime_id,
                    "kind": kind,
                    "os": operating_system,
                    "arch": architecture,
                },
            )
        if release.sha256 in state["revokedArtifactSha256"]:
            raise registry_error(
                "PLUGIN_RUNTIME_REGISTRY_RUNTIME_REVOKED",
                "managed runtime artifact has been revoked",
                details={"runtimeId": runtime_id, "sha256": release.sha256},
            )
        return registry, release, state

    def resolve(
        self,
        runtime_id: str,
        kind: str,
        *,
        operating_system: str | None = None,
        architecture: str | None = None,
    ) -> tuple[VerifiedRuntimeRegistry, RuntimeRelease]:
        self._assert_enabled()
        with security_lock(self.lock_path):
            registry, release, _state = self._resolve_locked(
                runtime_id,
                kind,
                operating_system=operating_system,
                architecture=architecture,
            )
            return registry, release

    def verify_marketplace_binding(
        self,
        *,
        registry_id: str,
        registry_revision: int,
        registry_sha256: str,
        runtime_id: str,
        runtime_kind: str,
        runtime_artifact_sha256: str,
        license_expression: str,
        operating_system: str,
        architecture: str,
    ) -> dict[str, Any]:
        """Verify signed Marketplace evidence against the active registry ancestry.

        A release may bind an older accepted registry revision only while that
        revision remains an ancestor of the active head.  A forward revision
        left in storage after rollback is intentionally rejected.
        """

        self._assert_enabled()
        with security_lock(self.lock_path):
            active, state = self._active_registry_locked()
            ancestry: dict[str, VerifiedRuntimeRegistry] = {}
            current = active
            while True:
                ancestry[current.sha256] = current
                if current.previous_registry_sha256 is None:
                    break
                current = self._load_registry_digest(current.previous_registry_sha256)
            registry = ancestry.get(registry_sha256)
            if (
                registry is None
                or registry.registry_id != registry_id
                or registry.revision != registry_revision
            ):
                raise registry_error(
                    "PLUGIN_RUNTIME_REGISTRY_BINDING_INVALID",
                    "Marketplace runtime binding is not on the active signed registry ancestry",
                    details={
                        "registryId": registry_id,
                        "registryRevision": registry_revision,
                        "registrySha256": registry_sha256,
                        "activeRegistrySha256": active.sha256,
                    },
                )
            release = registry.by_key().get(
                (runtime_id, runtime_kind, operating_system, architecture)
            )
            if (
                release is None
                or release.sha256 != runtime_artifact_sha256
                or release.license_spdx != license_expression
            ):
                raise registry_error(
                    "PLUGIN_RUNTIME_REGISTRY_BINDING_INVALID",
                    "Marketplace runtime binding does not match the signed registry release",
                    details={
                        "runtimeId": runtime_id,
                        "runtimeKind": runtime_kind,
                        "os": operating_system,
                        "arch": architecture,
                    },
                )
            if release.sha256 in state["revokedArtifactSha256"]:
                raise registry_error(
                    "PLUGIN_RUNTIME_REGISTRY_RUNTIME_REVOKED",
                    "Marketplace runtime binding references a revoked runtime artifact",
                    details={
                        "runtimeId": runtime_id,
                        "sha256": release.sha256,
                    },
                )
            return {
                "registryId": registry.registry_id,
                "registryRevision": registry.revision,
                "registrySha256": registry.sha256,
                "activeRegistrySha256": active.sha256,
                "runtimeId": release.runtime_id,
                "runtimeKind": release.kind,
                "runtimeArtifactSha256": release.sha256,
                "licenseExpression": release.license_spdx,
                "verified": True,
            }

    def _stage_download(
        self,
        *,
        url: str,
        digest: str,
        size: int,
        destination: Path,
        projection: str = "raw",
    ) -> None:
        self.staging_directory.mkdir(parents=True, exist_ok=True)
        staging = self.staging_directory / f"download-{uuid.uuid4().hex}.part"
        source_staging = (
            staging
            if projection == "raw"
            else self.staging_directory / f"source-{uuid.uuid4().hex}.part"
        )
        try:
            self.fetcher.fetch(
                url,
                source_staging,
                maximum=size if projection == "raw" else MAX_EVIDENCE_BYTES,
            )
            if projection != "raw":
                try:
                    projected = project_runtime_evidence_bytes(
                        source_staging.read_bytes(),
                        projection=projection,
                        source_url=url,
                    )
                    with staging.open("xb") as stream:
                        stream.write(projected)
                        stream.flush()
                        os.fsync(stream.fileno())
                except RuntimeRegistryError:
                    raise
                except OSError as exc:
                    raise _io_error(
                        exc, "runtime evidence projection could not be staged"
                    ) from exc
            actual = _hash_file(staging)
            if actual != (digest, size):
                raise registry_error(
                    "PLUGIN_RUNTIME_REGISTRY_ARTIFACT_MISMATCH",
                    "downloaded runtime content does not match its signed size and digest",
                    details={
                        "expectedSha256": digest,
                        "actualSha256": actual[0],
                        "expectedSize": size,
                        "actualSize": actual[1],
                    },
                )
            destination.parent.mkdir(parents=True, exist_ok=True)
            if destination.exists():
                if (
                    destination.is_symlink()
                    or not destination.is_file()
                    or _hash_file(destination) != (digest, size)
                ):
                    raise registry_error(
                        "PLUGIN_RUNTIME_REGISTRY_IMMUTABILITY_VIOLATION",
                        "content-addressed runtime download target changed",
                    )
                return
            os.replace(staging, destination)
            _fsync_directory(destination.parent)
        except RuntimeRegistryError:
            raise
        except OSError as exc:
            raise _io_error(exc, "runtime download could not be committed") from exc
        finally:
            staging.unlink(missing_ok=True)
            if source_staging != staging:
                source_staging.unlink(missing_ok=True)

    def _validate_projected_evidence_bindings(self, release: RuntimeRelease) -> None:
        for evidence in release.evidence:
            if evidence.projection == "raw":
                continue
            path = self._evidence_path(evidence)
            try:
                raw = path.read_bytes()
                value = loads_strict(raw, limits=_EVIDENCE_SOURCE_JSON_LIMITS)
            except (OSError, PlatformContractError, UnicodeDecodeError) as exc:
                raise _evidence_invalid(
                    "cached projected runtime evidence is unreadable",
                    details={"role": evidence.role},
                ) from exc
            if raw != canonical_bytes(value) or not isinstance(value, Mapping):
                raise _evidence_invalid(
                    "cached projected runtime evidence is not canonical JSON",
                    details={"role": evidence.role},
                )
            if evidence.projection == "github-release-asset-v1":
                if (
                    value.get("schemaVersion")
                    != "candlescope.github-release-asset-evidence/1"
                    or value.get("browserDownloadUrl") != release.url
                    or value.get("digest") != release.sha256
                    or value.get("size") != release.size
                    or value.get("state") != "uploaded"
                ):
                    raise _evidence_invalid(
                        "GitHub release asset evidence does not bind the runtime archive",
                        details={"runtimeId": release.runtime_id},
                    )
            elif evidence.projection == "github-git-commit-v1":
                sha = value.get("sha")
                verification = value.get("verification")
                if (
                    value.get("schemaVersion")
                    != "candlescope.github-git-commit-evidence/1"
                    or not isinstance(sha, str)
                    or sha not in release.upstream_scm_ref
                    or not release.upstream_build_ref.endswith(f"/{sha}")
                    or not isinstance(verification, Mapping)
                    or verification.get("verified") is not True
                    or verification.get("reason") != "valid"
                ):
                    raise _evidence_invalid(
                        "GitHub git commit evidence does not bind the runtime SCM reference",
                        details={"runtimeId": release.runtime_id},
                    )
            else:
                raise AssertionError("signed evidence projection was not validated")

    def _quarantine_file(self, path: Path, *, label: str) -> bool:
        if not path.exists():
            return False
        target = self.quarantine_directory / label / f"{path.name}-{uuid.uuid4().hex}"
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.replace(path, target)
            _atomic_write_json(
                target.parent / f"{target.name}.reason.json",
                {
                    "schemaVersion": 1,
                    "reason": "integrity-failure",
                    "quarantinedAt": _utc_now(),
                },
            )
            return True
        except OSError as exc:
            raise _io_error(
                exc, "corrupted runtime cache could not be quarantined"
            ) from exc

    def _quarantine_tree(self, path: Path, *, label: str) -> bool:
        if not path.exists():
            return False
        _make_tree_writable(path)
        target = self.quarantine_directory / label / f"{path.name}-{uuid.uuid4().hex}"
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.replace(path, target)
            _atomic_write_json(
                target.parent / f"{target.name}.reason.json",
                {
                    "schemaVersion": 1,
                    "reason": "integrity-failure",
                    "quarantinedAt": _utc_now(),
                },
            )
            return True
        except OSError as exc:
            raise _io_error(
                exc, "corrupted runtime cache could not be quarantined"
            ) from exc

    @staticmethod
    def _valid_file(path: Path, digest: str, size: int) -> bool:
        return (
            path.exists()
            and not path.is_symlink()
            and path.is_file()
            and _hash_file(path) == (digest, size)
        )

    def _ensure_artifact_files(
        self,
        release: RuntimeRelease,
        *,
        offline: bool,
    ) -> tuple[int, int]:
        downloaded = 0
        quarantined = 0
        archive = self._archive_path(release)
        if archive.exists() and not self._valid_file(
            archive, release.sha256, release.size
        ):
            quarantined += int(self._quarantine_file(archive, label="archives"))
        if not archive.exists():
            if offline:
                raise registry_error(
                    "PLUGIN_RUNTIME_REGISTRY_OFFLINE_CACHE_MISS",
                    "offline mode has no verified managed runtime archive",
                    details={"runtimeId": release.runtime_id},
                )
            self._stage_download(
                url=release.url,
                digest=release.sha256,
                size=release.size,
                destination=archive,
            )
            downloaded += 1
        for evidence in release.evidence:
            path = self._evidence_path(evidence)
            if path.exists() and not self._valid_file(
                path, evidence.sha256, evidence.size
            ):
                quarantined += int(self._quarantine_file(path, label="evidence"))
            if not path.exists():
                if offline:
                    raise registry_error(
                        "PLUGIN_RUNTIME_REGISTRY_OFFLINE_EVIDENCE_MISS",
                        "offline mode is missing signed runtime supply-chain evidence",
                        details={
                            "runtimeId": release.runtime_id,
                            "role": evidence.role,
                        },
                    )
                self._stage_download(
                    url=evidence.url,
                    digest=evidence.sha256,
                    size=evidence.size,
                    destination=path,
                    projection=evidence.projection,
                )
                downloaded += 1
        self._validate_projected_evidence_bindings(release)
        return downloaded, quarantined

    def _cache_receipt(
        self,
        release: RuntimeRelease,
        registry: VerifiedRuntimeRegistry,
        inventory: Sequence[Mapping[str, Any]],
        probe: ProbeResult,
    ) -> dict[str, Any]:
        return {
            "schemaVersion": RUNTIME_CACHE_RECEIPT_SCHEMA,
            "runtime": {
                "id": release.runtime_id,
                "kind": release.kind,
                "version": release.version,
                "os": release.operating_system,
                "arch": release.architecture,
                "artifactSha256": release.sha256,
                "artifactSize": release.size,
                "executable": release.executable,
                "licenseSpdx": release.license_spdx,
            },
            "registry": {
                "id": registry.registry_id,
                "revision": registry.revision,
                "sha256": registry.sha256,
            },
            "evidence": [item.to_wire() for item in release.evidence],
            "inventory": [dict(item) for item in inventory],
            "probe": probe.to_wire(),
            "installedAt": _utc_now(),
        }

    def _validate_cache(
        self,
        release: RuntimeRelease,
    ) -> tuple[bool, str | None, dict[str, Any] | None]:
        cache = self._cache_path(release)
        if not cache.exists():
            return False, "missing", None
        if cache.is_symlink() or not cache.is_dir():
            return False, "payload", None
        receipt_path = self._receipt_path(cache)
        try:
            receipt = _read_json(
                receipt_path,
                "managed runtime cache receipt",
                maximum=MAX_CACHE_RECEIPT_BYTES,
            )
            if not isinstance(receipt, dict) or set(receipt) != {
                "schemaVersion",
                "runtime",
                "registry",
                "evidence",
                "inventory",
                "probe",
                "installedAt",
            }:
                return False, "payload", None
            if receipt["schemaVersion"] != RUNTIME_CACHE_RECEIPT_SCHEMA:
                return False, "payload", None
            runtime = receipt["runtime"]
            if not isinstance(runtime, dict) or runtime != {
                "id": release.runtime_id,
                "kind": release.kind,
                "version": release.version,
                "os": release.operating_system,
                "arch": release.architecture,
                "artifactSha256": release.sha256,
                "artifactSize": release.size,
                "executable": release.executable,
                "licenseSpdx": release.license_spdx,
            }:
                return False, "payload", None
            if receipt["evidence"] != [item.to_wire() for item in release.evidence]:
                return False, "payload", None
            registry_receipt = receipt["registry"]
            if (
                not isinstance(registry_receipt, dict)
                or set(registry_receipt) != {"id", "revision", "sha256"}
                or not isinstance(registry_receipt["id"], str)
                or isinstance(registry_receipt["revision"], bool)
                or not isinstance(registry_receipt["revision"], int)
                or registry_receipt["revision"] <= 0
                or not isinstance(registry_receipt["sha256"], str)
                or _SHA256.fullmatch(registry_receipt["sha256"]) is None
            ):
                return False, "payload", None
            receipt_registry = self._load_registry_digest(registry_receipt["sha256"])
            receipt_release = receipt_registry.by_key().get(release.key)
            if (
                registry_receipt
                != {
                    "id": receipt_registry.registry_id,
                    "revision": receipt_registry.revision,
                    "sha256": receipt_registry.sha256,
                }
                or receipt_release is None
                or receipt_release.sha256 != release.sha256
                or receipt_release.version != release.version
            ):
                return False, "payload", None
            probe = receipt["probe"]
            if (
                not isinstance(probe, dict)
                or set(probe) != {"argv", "exitCode", "stdout", "stderr", "sha256"}
                or probe["argv"] != list(release.probe.argv)
                or probe["exitCode"] != release.probe.expected_exit_code
                or not isinstance(probe["stdout"], str)
                or not isinstance(probe["stderr"], str)
                or not isinstance(probe["sha256"], str)
                or _SHA256.fullmatch(probe["sha256"]) is None
                or probe["sha256"]
                != sha256_bytes(
                    canonical_bytes(
                        {
                            "argv": probe["argv"],
                            "exitCode": probe["exitCode"],
                            "stdout": probe["stdout"],
                            "stderr": probe["stderr"],
                        }
                    )
                )
            ):
                return False, "payload", None
            payload = self._payload_path(cache)
            inventory, total = _inventory(payload)
            if (
                inventory != receipt["inventory"]
                or len(inventory) != release.file_count
                or total != release.extracted_size
            ):
                return False, "payload", None
            executable = payload.joinpath(*PurePosixPath(release.executable).parts)
            if executable.is_symlink() or not executable.is_file():
                return False, "payload", None
            _validate_legal_inventory(release, payload)
            archive = self._archive_path(release)
            if not self._valid_file(archive, release.sha256, release.size):
                return False, "archive", receipt
            for evidence in release.evidence:
                if not self._valid_file(
                    self._evidence_path(evidence), evidence.sha256, evidence.size
                ):
                    return False, f"evidence:{evidence.sha256}", receipt
            return True, None, receipt
        except RuntimeRegistryError:
            return False, "payload", None

    def _quarantine_component(self, release: RuntimeRelease, component: str) -> int:
        if component == "payload":
            return int(
                self._quarantine_tree(
                    self._cache_path(release), label=f"runtime-{release.runtime_id}"
                )
            )
        if component == "archive":
            return int(
                self._quarantine_file(self._archive_path(release), label="archives")
            )
        if component.startswith("evidence:"):
            digest = component.partition(":")[2]
            evidence = next(
                (item for item in release.evidence if item.sha256 == digest), None
            )
            if evidence is not None:
                return int(
                    self._quarantine_file(
                        self._evidence_path(evidence), label="evidence"
                    )
                )
        return 0

    def _extract_runtime(
        self,
        release: RuntimeRelease,
        registry: VerifiedRuntimeRegistry,
    ) -> tuple[Path, ProbeResult]:
        required_free = (
            release.size + release.extracted_size + MIN_FREE_SPACE_MARGIN_BYTES
        )
        try:
            free = shutil.disk_usage(self.root).free
        except OSError as exc:
            raise _io_error(
                exc, "managed runtime free space could not be inspected"
            ) from exc
        if free < required_free:
            raise registry_error(
                "PLUGIN_RUNTIME_REGISTRY_DISK_FULL",
                "managed runtime storage does not have enough available space",
                details={"requiredBytes": required_free, "availableBytes": free},
            )
        staging = self.staging_directory / f"runtime-{uuid.uuid4().hex}.part"
        final = self._cache_path(release)
        moved = False
        try:
            staging.mkdir(parents=False)
            payload = self._payload_path(staging)
            payload.mkdir()
            archive = self._archive_path(release)
            if release.archive_format == "zip":
                _extract_zip(release, archive, payload)
            else:
                _extract_tar(release, archive, payload)
            inventory, total = _inventory(payload)
            if len(inventory) != release.file_count or total != release.extracted_size:
                raise registry_error(
                    "PLUGIN_RUNTIME_REGISTRY_ARCHIVE_INVALID",
                    "extracted runtime inventory does not match signed bounds",
                )
            _validate_legal_inventory(release, payload)
            staging_probe = _run_probe(release, payload)
            _atomic_write_json(
                self._receipt_path(staging),
                self._cache_receipt(release, registry, inventory, staging_probe),
            )
            final.parent.mkdir(parents=True, exist_ok=True)
            if final.exists():
                raise registry_error(
                    "PLUGIN_RUNTIME_REGISTRY_IMMUTABILITY_VIOLATION",
                    "managed runtime cache destination unexpectedly exists",
                )
            os.replace(staging, final)
            moved = True
            _fsync_directory(final.parent)
            final_payload = self._payload_path(final)
            final_probe = _run_probe(release, final_payload)
            if final_probe.sha256 != staging_probe.sha256:
                raise registry_error(
                    "PLUGIN_RUNTIME_REGISTRY_PROBE_FAILED",
                    "managed runtime probe changed after atomic cache publication",
                )
            _mark_read_only(final)
            return final, final_probe
        except RuntimeRegistryError:
            if moved:
                self._quarantine_tree(final, label=f"runtime-{release.runtime_id}")
            raise
        except OSError as exc:
            if moved:
                self._quarantine_tree(final, label=f"runtime-{release.runtime_id}")
            raise _io_error(
                exc, "managed runtime cache could not be published"
            ) from exc
        finally:
            if staging.exists():
                _make_tree_writable(staging)
                shutil.rmtree(staging, ignore_errors=True)

    @staticmethod
    def _supply_binding(
        registry: VerifiedRuntimeRegistry,
        release: RuntimeRelease,
        executable: Path,
        probe: ProbeResult,
    ) -> RuntimeSupplyBinding:
        return RuntimeSupplyBinding(
            source="host-managed",
            runtime_id=release.runtime_id,
            runtime_kind=release.kind,
            version=release.version,
            executable=executable,
            artifact_sha256=release.sha256,
            artifact_size=release.size,
            probe_sha256=probe.sha256,
            verification_status="verified",
            reproducible=True,
            registry_id=registry.registry_id,
            registry_revision=registry.revision,
            registry_sha256=registry.sha256,
            source_url=release.url,
            license_spdx=release.license_spdx,
        )

    def ensure(
        self,
        runtime_id: str,
        kind: str,
        *,
        offline: bool = False,
        operating_system: str | None = None,
        architecture: str | None = None,
    ) -> EnsuredRuntime:
        """Resolve, install, verify, and fresh-process probe one exact runtime."""

        self._assert_enabled()
        if not isinstance(offline, bool):
            raise ValueError("offline must be a boolean")
        with security_lock(self.lock_path):
            self._assert_root_safe()
            registry, release, _state = self._resolve_locked(
                runtime_id,
                kind,
                operating_system=operating_system,
                architecture=architecture,
            )
            quarantined = 0
            valid, component, _receipt = self._validate_cache(release)
            if not valid and component not in {None, "missing"}:
                quarantined += self._quarantine_component(release, component)
                valid = False
            downloaded, artifact_quarantine = self._ensure_artifact_files(
                release, offline=offline
            )
            quarantined += artifact_quarantine
            # A valid extracted cache may outlive a missing/corrupt retained
            # archive or evidence file.  Once that component has been restored,
            # revalidate the immutable cache instead of attempting to publish a
            # second tree at the same content-addressed destination.
            if not valid and self._cache_path(release).exists():
                valid, component, _receipt = self._validate_cache(release)
                if not valid and component not in {None, "missing"}:
                    quarantined += self._quarantine_component(release, component)
            if valid:
                cache = self._cache_path(release)
                payload = self._payload_path(cache)
                probe = _run_probe(release, payload)
                executable = payload.joinpath(*PurePosixPath(release.executable).parts)
                return EnsuredRuntime(
                    release,
                    cache,
                    executable,
                    self._supply_binding(registry, release, executable, probe),
                    probe,
                    True,
                    downloaded,
                    quarantined,
                )
            cache, probe = self._extract_runtime(release, registry)
            payload = self._payload_path(cache)
            executable = payload.joinpath(*PurePosixPath(release.executable).parts)
            return EnsuredRuntime(
                release,
                cache,
                executable,
                self._supply_binding(registry, release, executable, probe),
                probe,
                False,
                downloaded,
                quarantined,
            )

    def _load_system_registry(self) -> dict[str, Any]:
        if not self.system_registry_path.exists():
            return {"schemaVersion": SYSTEM_REGISTRY_SCHEMA_VERSION, "runtimes": []}
        value = _read_json(
            self.system_registry_path,
            "system runtime registry",
            maximum=MAX_REGISTRY_BYTES,
        )
        if (
            not isinstance(value, dict)
            or set(value) != {"schemaVersion", "runtimes"}
            or value["schemaVersion"] != SYSTEM_REGISTRY_SCHEMA_VERSION
            or not isinstance(value["runtimes"], list)
            or len(value["runtimes"]) > MAX_SYSTEM_RUNTIMES
        ):
            raise registry_error(
                "PLUGIN_RUNTIME_REGISTRY_SYSTEM_STATE_INVALID",
                "system runtime registry schema is invalid",
            )
        keys: list[tuple[str, str]] = []
        for item in value["runtimes"]:
            if not isinstance(item, dict) or set(item) != {
                "runtimeId",
                "kind",
                "version",
                "executable",
                "artifactSha256",
                "artifactSize",
                "probeArgs",
                "expectedPattern",
                "probe",
                "registeredAt",
                "reproducible",
            }:
                raise registry_error(
                    "PLUGIN_RUNTIME_REGISTRY_SYSTEM_STATE_INVALID",
                    "system runtime record fields are invalid",
                )
            if item["reproducible"] is not False:
                raise registry_error(
                    "PLUGIN_RUNTIME_REGISTRY_SYSTEM_STATE_INVALID",
                    "system runtime must remain explicitly non-reproducible",
                )
            probe_args, expected_pattern = _validated_system_probe_spec(
                item["probeArgs"],
                item["expectedPattern"],
                code="PLUGIN_RUNTIME_REGISTRY_SYSTEM_STATE_INVALID",
                message="system runtime probe specification is invalid",
            )
            probe = item.get("probe")
            if (
                not isinstance(probe, dict)
                or set(probe) != {"argv", "exitCode", "stdout", "stderr", "sha256"}
                or not isinstance(probe["argv"], list)
                or probe["argv"] != [item["executable"], *probe_args]
                or probe["exitCode"] != 0
                or not isinstance(probe["stdout"], str)
                or not isinstance(probe["stderr"], str)
                or len(probe["stdout"].encode("utf-8")) > MAX_PROBE_OUTPUT_BYTES
                or len(probe["stderr"].encode("utf-8")) > MAX_PROBE_OUTPUT_BYTES
                or not isinstance(probe["sha256"], str)
                or _SHA256.fullmatch(probe["sha256"]) is None
                or probe["sha256"]
                != sha256_bytes(
                    canonical_bytes(
                        {
                            "argv": probe["argv"],
                            "exitCode": probe["exitCode"],
                            "stdout": probe["stdout"],
                            "stderr": probe["stderr"],
                        }
                    )
                )
                or expected_pattern.search(probe["stdout"] + "\n" + probe["stderr"])
                is None
                or not _is_canonical_utc_timestamp(item["registeredAt"])
            ):
                raise registry_error(
                    "PLUGIN_RUNTIME_REGISTRY_SYSTEM_STATE_INVALID",
                    "system runtime probe receipt is invalid",
                )
            try:
                binding = RuntimeSupplyBinding.from_wire(
                    {
                        "source": "system",
                        "runtimeId": item["runtimeId"],
                        "runtimeKind": item["kind"],
                        "version": item["version"],
                        "executable": item["executable"],
                        "artifactSha256": item["artifactSha256"],
                        "artifactSize": item["artifactSize"],
                        "probeSha256": item["probe"]["sha256"],
                        "verificationStatus": "probed",
                        "reproducible": False,
                        "licenseSpdx": "NOASSERTION",
                    },
                    label="system runtime binding",
                )
            except (OSError, ValueError) as exc:
                raise registry_error(
                    "PLUGIN_RUNTIME_REGISTRY_SYSTEM_STATE_INVALID",
                    "system runtime binding is invalid",
                ) from exc
            if str(binding.executable) != item["executable"]:
                raise registry_error(
                    "PLUGIN_RUNTIME_REGISTRY_SYSTEM_STATE_INVALID",
                    "system runtime executable path is not canonical",
                )
            keys.append((item["runtimeId"], item["kind"]))
        if keys != sorted(keys) or len(set(keys)) != len(keys):
            raise registry_error(
                "PLUGIN_RUNTIME_REGISTRY_SYSTEM_STATE_INVALID",
                "system runtimes must be key-sorted and unique",
            )
        return value

    @staticmethod
    def _run_system_probe(
        executable: Path,
        probe_args: Sequence[str],
        expected_pattern: str,
    ) -> ProbeResult:
        validated_args, pattern = _validated_system_probe_spec(
            probe_args,
            expected_pattern,
            code="PLUGIN_RUNTIME_REGISTRY_SYSTEM_SELECTION_INVALID",
            message="system runtime probe specification is invalid",
        )
        try:
            completed = subprocess.run(
                [str(executable), *validated_args],
                cwd=executable.parent,
                env=_safe_process_environment(executable.parent.parent),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=15,
                check=False,
                shell=False,
                creationflags=(subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0),
            )
        except subprocess.TimeoutExpired as exc:
            raise registry_error(
                "PLUGIN_RUNTIME_REGISTRY_PROBE_TIMEOUT",
                "explicit system runtime probe timed out",
            ) from exc
        except OSError as exc:
            raise _io_error(
                exc, "explicit system runtime probe could not start"
            ) from exc
        stdout = _decode_output(completed.stdout, "stdout")
        stderr = _decode_output(completed.stderr, "stderr")
        if (
            completed.returncode != 0
            or len(completed.stdout) > MAX_PROBE_OUTPUT_BYTES
            or len(completed.stderr) > MAX_PROBE_OUTPUT_BYTES
            or pattern.search(stdout + "\n" + stderr) is None
        ):
            raise registry_error(
                "PLUGIN_RUNTIME_REGISTRY_PROBE_FAILED",
                "explicit system runtime did not match its expected version probe",
            )
        wire = {
            "argv": [str(executable), *validated_args],
            "exitCode": completed.returncode,
            "stdout": stdout,
            "stderr": stderr,
        }
        return ProbeResult(
            tuple(wire["argv"]),
            completed.returncode,
            stdout,
            stderr,
            sha256_bytes(canonical_bytes(wire)),
        )

    def register_system_runtime(
        self,
        *,
        runtime_id: str,
        kind: str,
        version: str,
        executable: Path | str,
        probe_args: Sequence[str],
        expected_pattern: str,
        developer_local: bool,
        confirm_nonreproducible: bool,
    ) -> RuntimeSupplyBinding:
        """Record an explicit developer-local system runtime; never a fallback."""

        self._assert_enabled()
        if developer_local is not True or confirm_nonreproducible is not True:
            raise registry_error(
                "PLUGIN_RUNTIME_REGISTRY_SYSTEM_CONFIRMATION_REQUIRED",
                "system runtime selection requires developer-local mode and explicit non-reproducible confirmation",
            )
        if _ID.fullmatch(runtime_id) is None or kind not in {"java", "node", "wasm"}:
            raise registry_error(
                "PLUGIN_RUNTIME_REGISTRY_SYSTEM_SELECTION_INVALID",
                "system runtime identity is invalid",
            )
        if not isinstance(version, str) or not version.strip() or len(version) > 128:
            raise registry_error(
                "PLUGIN_RUNTIME_REGISTRY_SYSTEM_SELECTION_INVALID",
                "system runtime version is invalid",
            )
        path = Path(executable).expanduser()
        if not path.is_absolute():
            raise registry_error(
                "PLUGIN_RUNTIME_REGISTRY_SYSTEM_SELECTION_INVALID",
                "system runtime executable path must be absolute",
            )
        path = path.resolve(strict=False)
        if path.is_symlink() or not path.is_file():
            raise registry_error(
                "PLUGIN_RUNTIME_REGISTRY_SYSTEM_SELECTION_INVALID",
                "system runtime executable must be a real file",
            )
        probe = self._run_system_probe(path, probe_args, expected_pattern)
        digest, size = _hash_file(path)
        record = {
            "runtimeId": runtime_id,
            "kind": kind,
            "version": version.strip(),
            "executable": str(path),
            "artifactSha256": digest,
            "artifactSize": size,
            "probeArgs": list(probe.argv[1:]),
            "expectedPattern": expected_pattern,
            "probe": probe.to_wire(),
            "registeredAt": _utc_now(),
            "reproducible": False,
        }
        with security_lock(self.lock_path):
            current = self._load_system_registry()
            by_key = {
                (item["runtimeId"], item["kind"]): item for item in current["runtimes"]
            }
            key = (runtime_id, kind)
            existing = by_key.get(key)
            if existing is not None:
                immutable = {
                    name: existing[name]
                    for name in existing
                    if name not in {"probe", "registeredAt"}
                }
                candidate = {
                    name: record[name]
                    for name in record
                    if name not in {"probe", "registeredAt"}
                }
                if immutable != candidate:
                    raise registry_error(
                        "PLUGIN_RUNTIME_REGISTRY_SYSTEM_REPLACEMENT_REQUIRED",
                        "system runtime identity is already bound to a different executable",
                    )
            by_key[key] = record
            _atomic_write_json(
                self.system_registry_path,
                {
                    "schemaVersion": SYSTEM_REGISTRY_SCHEMA_VERSION,
                    "runtimes": [by_key[item] for item in sorted(by_key)],
                },
            )
        return RuntimeSupplyBinding(
            source="system",
            runtime_id=runtime_id,
            runtime_kind=kind,
            version=version.strip(),
            executable=path,
            artifact_sha256=digest,
            artifact_size=size,
            probe_sha256=probe.sha256,
            verification_status="probed",
            reproducible=False,
            license_spdx="NOASSERTION",
        )

    def system_runtime(self, runtime_id: str, kind: str) -> RuntimeSupplyBinding:
        """Resolve only an explicitly recorded system runtime; no managed fallback."""

        self._assert_enabled()
        with security_lock(self.lock_path):
            state = self._load_system_registry()
            item = next(
                (
                    value
                    for value in state["runtimes"]
                    if value["runtimeId"] == runtime_id and value["kind"] == kind
                ),
                None,
            )
            if item is None:
                raise registry_error(
                    "PLUGIN_RUNTIME_REGISTRY_SYSTEM_RUNTIME_NOT_FOUND",
                    "no explicitly selected system runtime matches this identity",
                )
            path = Path(item["executable"])
            if (
                path.is_symlink()
                or not path.is_file()
                or _hash_file(path)
                != (
                    item["artifactSha256"],
                    item["artifactSize"],
                )
            ):
                raise registry_error(
                    "PLUGIN_RUNTIME_REGISTRY_SYSTEM_RUNTIME_CHANGED",
                    "explicit system runtime executable changed after registration",
                )
            probe = self._run_system_probe(
                path, item["probeArgs"], item["expectedPattern"]
            )
            return RuntimeSupplyBinding(
                source="system",
                runtime_id=runtime_id,
                runtime_kind=kind,
                version=item["version"],
                executable=path,
                artifact_sha256=item["artifactSha256"],
                artifact_size=item["artifactSize"],
                probe_sha256=probe.sha256,
                verification_status="probed",
                reproducible=False,
                license_spdx="NOASSERTION",
            )

    @staticmethod
    def _collect_supply_references(value: Any, source: str) -> set[tuple[str, ...]]:
        references: set[tuple[str, ...]] = set()

        def visit(
            node: Any, plugin_id: str = "unknown", activation_id: str = "unknown"
        ) -> None:
            if isinstance(node, Mapping):
                next_plugin = node.get("pluginId", plugin_id)
                next_activation = node.get("activationId", activation_id)
                if not isinstance(next_plugin, str):
                    next_plugin = plugin_id
                if not isinstance(next_activation, str):
                    next_activation = activation_id
                supply = node.get("runtimeSupply")
                if (
                    isinstance(supply, Mapping)
                    and supply.get("source") == "host-managed"
                ):
                    try:
                        binding = RuntimeSupplyBinding.from_wire(
                            supply, label="activation runtime supply"
                        )
                    except ValueError as exc:
                        raise registry_error(
                            "PLUGIN_RUNTIME_REGISTRY_REFERENCE_INVALID",
                            "activation history contains an invalid runtime supply binding",
                            details={"source": source},
                        ) from exc
                    references.add(
                        (
                            source,
                            next_plugin,
                            next_activation,
                            binding.runtime_id,
                            binding.artifact_sha256,
                        )
                    )
                for child in node.values():
                    visit(child, next_plugin, next_activation)
            elif isinstance(node, Sequence) and not isinstance(
                node, (str, bytes, bytearray)
            ):
                for child in node:
                    visit(child, plugin_id, activation_id)

        visit(value)
        return references

    def reference_counts(
        self,
        *,
        activation_registry: Path | str | None = None,
        history_directory: Path | str | None = None,
    ) -> dict[str, int]:
        references: set[tuple[str, ...]] = set()
        paths: list[Path] = []
        if activation_registry is not None:
            path = Path(activation_registry).resolve(strict=False)
            if path.exists():
                paths.append(path)
        if history_directory is not None:
            history = Path(history_directory).resolve(strict=False)
            if history.exists():
                if history.is_symlink() or not history.is_dir():
                    raise registry_error(
                        "PLUGIN_RUNTIME_REGISTRY_REFERENCE_INVALID",
                        "activation history root is unsafe",
                    )
                paths.extend(sorted(history.rglob("*.json")))
        for path in paths:
            try:
                if path.is_symlink() or not path.is_file():
                    raise registry_error(
                        "PLUGIN_RUNTIME_REGISTRY_REFERENCE_INVALID",
                        "activation reference source is unsafe",
                    )
                if path.stat().st_size > 24 * 1024 * 1024:
                    raise registry_error(
                        "PLUGIN_RUNTIME_REGISTRY_REFERENCE_INVALID",
                        "activation reference source exceeds the bounded size",
                    )
                value = loads_strict(path.read_bytes(), limits=_REFERENCE_JSON_LIMITS)
            except RuntimeRegistryError:
                raise
            except (OSError, PlatformContractError) as exc:
                raise registry_error(
                    "PLUGIN_RUNTIME_REGISTRY_REFERENCE_INVALID",
                    "activation references could not be read strictly",
                    details={"source": str(path), "errorType": type(exc).__name__},
                ) from exc
            references.update(self._collect_supply_references(value, str(path)))
        counts: dict[str, int] = {}
        for reference in references:
            digest = reference[-1]
            counts[digest] = counts.get(digest, 0) + 1
        return dict(sorted(counts.items()))

    def cleanup_unreferenced(
        self,
        artifact_sha256: str,
        *,
        activation_registry: Path | str | None = None,
        history_directory: Path | str | None = None,
    ) -> dict[str, Any]:
        """Retire extracted caches only when no activation or rollback can use them."""

        self._assert_enabled()
        if _SHA256.fullmatch(artifact_sha256) is None:
            raise registry_error(
                "PLUGIN_RUNTIME_REGISTRY_CLEANUP_INVALID",
                "runtime cleanup digest is invalid",
            )
        counts = self.reference_counts(
            activation_registry=activation_registry,
            history_directory=history_directory,
        )
        reference_count = counts.get(artifact_sha256, 0)
        if reference_count:
            raise registry_error(
                "PLUGIN_RUNTIME_REGISTRY_RUNTIME_REFERENCED",
                "managed runtime cache is still referenced by activation or rollback history",
                details={
                    "artifactSha256": artifact_sha256,
                    "referenceCount": reference_count,
                },
            )
        moved: list[str] = []
        digest_name = artifact_sha256.removeprefix("sha256:")
        with security_lock(self.lock_path):
            if self.cache_directory.exists():
                for candidate in sorted(self.cache_directory.glob(f"*/{digest_name}")):
                    _make_tree_writable(candidate)
                    target = (
                        self.retired_directory
                        / candidate.parent.name
                        / f"{digest_name}-{uuid.uuid4().hex}"
                    )
                    target.parent.mkdir(parents=True, exist_ok=True)
                    try:
                        os.replace(candidate, target)
                    except OSError as exc:
                        raise _io_error(
                            exc, "unreferenced runtime cache could not be retired"
                        ) from exc
                    moved.append(str(target))
        return {
            "artifactSha256": artifact_sha256,
            "referenceCount": 0,
            "retired": moved,
            "archiveRetained": True,
            "recoverable": True,
        }

    def public_status(
        self,
        *,
        activation_registry: Path | str | None = None,
        history_directory: Path | str | None = None,
    ) -> dict[str, Any]:
        if not self.enabled:
            return {
                "schemaVersion": RUNTIME_REGISTRY_STATUS_SCHEMA,
                "enabled": False,
                "networkUpdatesEnabled": False,
                "automaticUpdates": False,
                "active": None,
                "runtimes": [],
                "systemRuntimes": [],
            }
        with security_lock(self.lock_path):
            registry, state = self._active_registry_locked()
            os_name, arch_name = host_platform()
            counts = self.reference_counts(
                activation_registry=activation_registry,
                history_directory=history_directory,
            )
            runtimes: list[dict[str, Any]] = []
            for release in registry.runtimes:
                if (
                    release.operating_system != os_name
                    or release.architecture != arch_name
                ):
                    continue
                revoked = release.sha256 in state["revokedArtifactSha256"]
                valid, component, receipt = self._validate_cache(release)
                runtimes.append(
                    {
                        **release.to_public_wire(),
                        "source": "host-managed",
                        "registryId": registry.registry_id,
                        "registryRevision": registry.revision,
                        "registrySha256": registry.sha256,
                        "verificationStatus": (
                            "revoked"
                            if revoked
                            else (
                                "verified"
                                if valid
                                else (
                                    "missing" if component == "missing" else "corrupt"
                                )
                            )
                        ),
                        "cached": valid,
                        "probeSha256": (
                            receipt.get("probe", {}).get("sha256")
                            if isinstance(receipt, dict)
                            else None
                        ),
                        "referenceCount": counts.get(release.sha256, 0),
                        "reproducible": True,
                    }
                )
            system = self._load_system_registry()
            system_runtimes = [
                {
                    "runtimeId": item["runtimeId"],
                    "kind": item["kind"],
                    "version": item["version"],
                    "source": "system",
                    "executable": item["executable"],
                    "artifactSha256": item["artifactSha256"],
                    "artifactSize": item["artifactSize"],
                    "probeSha256": item["probe"]["sha256"],
                    "verificationStatus": "probed",
                    "reproducible": False,
                    "license": "NOASSERTION",
                }
                for item in system["runtimes"]
            ]
            return {
                "schemaVersion": RUNTIME_REGISTRY_STATUS_SCHEMA,
                "enabled": True,
                "networkUpdatesEnabled": self.network_updates_enabled,
                "automaticUpdates": False,
                "active": {
                    "registryId": registry.registry_id,
                    "revision": registry.revision,
                    "registrySha256": registry.sha256,
                    "issuedAt": registry.issued_at,
                    "rollbackAvailable": bool(state["history"]),
                    "revokedArtifactCount": len(state["revokedArtifactSha256"]),
                },
                "runtimes": runtimes,
                "systemRuntimes": system_runtimes,
            }


__all__ = [
    "DOWNLOAD_TIMEOUT_SECONDS",
    "EnsuredRuntime",
    "HttpsRuntimeArtifactFetcher",
    "ManagedRuntimeRegistryService",
    "ProbeResult",
    "RUNTIME_CACHE_RECEIPT_SCHEMA",
    "RUNTIME_REGISTRY_ENABLED_ENV",
    "RUNTIME_REGISTRY_NETWORK_UPDATES_ENV",
    "RUNTIME_REGISTRY_STATUS_SCHEMA",
    "RuntimeArtifactFetcher",
    "host_platform",
    "project_runtime_evidence_bytes",
]
