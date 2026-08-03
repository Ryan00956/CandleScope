"""Strict deterministic ``.cspkg`` schema v2 plus inspect-only schema v3.

``manifest.json`` is the frozen public SDK manifest.  ``bundle.json`` is a
package envelope that pins every other archive member.  Keeping those two
contracts separate lets schema v1, schema v2, and schema v3 remain fail-closed
without an implicit execution migration path.
"""

from __future__ import annotations

import email.policy
import hashlib
import os
import platform
import re
import stat
import tempfile
import time
import zipfile
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from email.parser import BytesParser
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO

from candlescope_plugin_sdk.platform_v2 import (
    JavaJarRuntime,
    JsonLimits,
    MANIFEST_SCHEMA_VERSION_V2,
    MANIFEST_SCHEMA_VERSION_V3,
    NativeExecutableRuntime,
    NodeModuleRuntime,
    PlatformContractError,
    PluginManifest,
    PythonModuleRuntime,
    WasmComponentRuntime,
    canonical_dumps,
    loads_strict,
)

from .errors import PlatformBundleError


BUNDLE_FORMAT_V2 = "candlescope.plugin-bundle/2"
BUNDLE_FORMAT_V3 = "candlescope.plugin-bundle/3"
BUNDLE_SCHEMA_VERSION_V2 = 2
BUNDLE_SCHEMA_VERSION_V3 = 3
# Backward-compatible aliases used by the established v2 CLI and tests.
BUNDLE_FORMAT = BUNDLE_FORMAT_V2
BUNDLE_SCHEMA_VERSION = BUNDLE_SCHEMA_VERSION_V2
BUNDLE_EXTENSION = ".cspkg"
BUNDLE_DESCRIPTOR_PATH = "bundle.json"
MANIFEST_PATH = "manifest.json"
SBOM_PATH = "sbom/cyclonedx.json"
DEFAULT_HOST_VERSION = "0.4.0"
DEFAULT_PYTHON_REQUIRES = ">=3.11,<3.14"

MAX_BUNDLE_BYTES = 512 * 1024 * 1024
MAX_ARCHIVE_ENTRIES = 1024
MAX_ENTRY_BYTES = 256 * 1024 * 1024
MAX_TOTAL_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024
MAX_JSON_BYTES = 4 * 1024 * 1024
MAX_WHEEL_UNCOMPRESSED_BYTES = 512 * 1024 * 1024
MAX_TOTAL_WHEEL_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024
MAX_COMPRESSION_RATIO = 100
COPY_CHUNK_BYTES = 1024 * 1024

_JSON_LIMITS = JsonLimits(
    max_message_bytes=MAX_JSON_BYTES,
    max_depth=32,
    max_container_items=20_000,
    max_string_bytes=1024 * 1024,
)
_SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
_PYTHON_REQUIRES = re.compile(
    r"^>=(?P<min_major>\d+)\.(?P<min_minor>\d+)"
    r"(?:,<(?P<max_major>\d+)\.(?P<max_minor>\d+))?$"
)
_SEMVER = re.compile(
    r"^(?P<major>0|[1-9]\d*)\.(?P<minor>0|[1-9]\d*)\."
    r"(?P<patch>0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$"
)
_ENGINE_TERM = re.compile(r"^(>=|<=|>|<|=)?(.+)$")
_NORMALIZE_PACKAGE = re.compile(r"[-_.]+")
_WINDOWS_RESERVED_NAMES = {
    "aux",
    "clock$",
    "con",
    "nul",
    "prn",
    *(f"com{index}" for index in range(1, 10)),
    *(f"lpt{index}" for index in range(1, 10)),
}
_CONTENT_PREFIXES = {
    "license": "licenses/",
    "runtime": "runtime/",
    "source-map": "source-maps/",
    "wheel": "wheels/",
    "web": "web/",
    "schema": "schemas/",
    "probe": "probes/",
    "sbom": "sbom/",
}
ARTIFACT_ROLES = frozenset(
    {
        "java-jar",
        "license-notice",
        "native-executable",
        "node-bundle",
        "probe",
        "python-wheel",
        "sbom",
        "schema",
        "source-map",
        "wasm-component",
        "web-asset",
    }
)
_CONTENT_ARTIFACT_ROLES = {
    "license": "license-notice",
    "probe": "probe",
    "sbom": "sbom",
    "schema": "schema",
    "source-map": "source-map",
    "web": "web-asset",
    "wheel": "python-wheel",
}
_RUNTIME_ARTIFACT_ROLES = {
    "java-jar": "java-jar",
    "native-executable": "native-executable",
    "node-module": "node-bundle",
    "wasm-component": "wasm-component",
}
_ALLOWED_OS = frozenset({"windows", "linux", "macos"})
_ALLOWED_ARCH = frozenset({"x86_64", "arm64"})


def _mapping(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise PlatformBundleError(f"{label} must be a JSON object")
    return value


def _sequence(value: Any, label: str) -> Sequence[Any]:
    if isinstance(value, (str, bytes)) or not isinstance(value, Sequence):
        raise PlatformBundleError(f"{label} must be a JSON array")
    return value


def _only_keys(
    value: Mapping[str, Any],
    *,
    required: set[str],
    optional: set[str] = frozenset(),
    label: str,
) -> None:
    missing = sorted(required - set(value))
    unknown = sorted(set(value) - required - optional)
    if missing:
        raise PlatformBundleError(f"{label} is missing fields: {', '.join(missing)}")
    if unknown:
        raise PlatformBundleError(
            f"{label} contains unsupported fields: {', '.join(unknown)}"
        )


def _string(value: Any, label: str, *, maximum: int = 4096) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise PlatformBundleError(f"{label} must be a non-empty trimmed string")
    if "\0" in value or len(value) > maximum:
        raise PlatformBundleError(f"{label} is invalid or exceeds its size limit")
    return value


def _positive_int(value: Any, label: str, *, maximum: int) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not 0 < value <= maximum
    ):
        raise PlatformBundleError(f"{label} must be an integer from 1 to {maximum}")
    return value


def _sha256_bytes(value: bytes) -> str:
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


def _sha256_stream(stream: BinaryIO) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    for chunk in iter(lambda: stream.read(COPY_CHUNK_BYTES), b""):
        digest.update(chunk)
        size += len(chunk)
    return f"sha256:{digest.hexdigest()}", size


def sha256_file(path: Path | str) -> str:
    try:
        with Path(path).open("rb") as handle:
            return _sha256_stream(handle)[0]
    except OSError as exc:
        raise PlatformBundleError(f"unable to hash bundle artifact: {exc}") from exc


def normalize_expected_sha256(value: str) -> str:
    digest = _string(value, "expected SHA-256", maximum=71).lower()
    if not digest.startswith("sha256:"):
        digest = f"sha256:{digest}"
    if not _SHA256.fullmatch(digest):
        raise PlatformBundleError("expected SHA-256 must contain 64 hexadecimal digits")
    return digest


def _strict_json(data: bytes, label: str) -> Any:
    try:
        return loads_strict(data, limits=_JSON_LIMITS)
    except PlatformContractError as exc:
        raise PlatformBundleError(
            f"{label} is not strict bounded UTF-8 JSON",
            details={"contractCode": exc.code, "path": exc.path},
        ) from exc


def _canonical_json_bytes(value: Any) -> bytes:
    try:
        return (canonical_dumps(value, limits=_JSON_LIMITS) + "\n").encode("utf-8")
    except PlatformContractError as exc:
        raise PlatformBundleError(
            "bundle JSON is outside the canonical JSON contract",
            details={"contractCode": exc.code, "path": exc.path},
        ) from exc


def _require_canonical_json(data: bytes, label: str) -> Any:
    value = _strict_json(data, label)
    if data != _canonical_json_bytes(value):
        raise PlatformBundleError(f"{label} must use canonical JSON plus one newline")
    return value


def _safe_archive_path(name: str, label: str) -> PurePosixPath:
    if not name or "\\" in name or "\0" in name:
        raise PlatformBundleError(f"{label} contains an unsafe archive path")
    if any(part in {"", ".", ".."} for part in name.split("/")):
        raise PlatformBundleError(
            f"{label} contains a non-canonical archive path: {name!r}"
        )
    path = PurePosixPath(name)
    if path.is_absolute():
        raise PlatformBundleError(f"{label} contains an absolute archive path")
    for part in path.parts:
        if (
            any(ord(character) < 32 or character in '<>:"|?*' for character in part)
            or part.endswith((" ", "."))
            or part.split(".", 1)[0].casefold() in _WINDOWS_RESERVED_NAMES
        ):
            raise PlatformBundleError(
                f"{label} contains a platform-unsafe archive path: {name!r}"
            )
    return path


def _zip_symlink(info: zipfile.ZipInfo) -> bool:
    mode = (info.external_attr >> 16) & 0xFFFF
    return info.create_system == 3 and stat.S_ISLNK(mode)


def _validate_zip_infos(infos: Sequence[zipfile.ZipInfo]) -> dict[str, zipfile.ZipInfo]:
    if not 1 <= len(infos) <= MAX_ARCHIVE_ENTRIES:
        raise PlatformBundleError("plugin bundle has an invalid archive entry count")
    by_name: dict[str, zipfile.ZipInfo] = {}
    casefolded: dict[str, str] = {}
    total = 0
    for info in infos:
        name = info.filename
        _safe_archive_path(name, "plugin bundle")
        if info.is_dir():
            raise PlatformBundleError(
                "plugin bundle must not contain directory entries"
            )
        if _zip_symlink(info):
            raise PlatformBundleError("plugin bundle must not contain symbolic links")
        mode = (info.external_attr >> 16) & 0xFFFF
        if info.create_system == 3 and mode and not stat.S_ISREG(mode):
            raise PlatformBundleError("plugin bundle must contain regular files only")
        if info.flag_bits & 0x1:
            raise PlatformBundleError(
                "plugin bundle must not contain encrypted entries"
            )
        if info.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}:
            raise PlatformBundleError(
                "plugin bundle uses an unsupported compression method"
            )
        folded = name.casefold()
        if name in by_name or folded in casefolded:
            raise PlatformBundleError(
                "plugin bundle contains duplicate or case-conflicting paths",
                details={"path": name, "conflictsWith": casefolded.get(folded)},
            )
        if info.file_size < 0 or info.file_size > MAX_ENTRY_BYTES:
            raise PlatformBundleError(f"archive entry {name!r} exceeds its size limit")
        if info.file_size and info.compress_size == 0:
            raise PlatformBundleError(
                f"archive entry {name!r} has an invalid compression size"
            )
        if info.compress_size and info.file_size > max(
            1024 * 1024, info.compress_size * MAX_COMPRESSION_RATIO
        ):
            raise PlatformBundleError(
                f"archive entry {name!r} exceeds compression ratio limit"
            )
        total += info.file_size
        if total > MAX_TOTAL_UNCOMPRESSED_BYTES:
            raise PlatformBundleError(
                "plugin bundle exceeds the uncompressed-size limit"
            )
        by_name[name] = info
        casefolded[folded] = name
    return by_name


@dataclass(frozen=True, slots=True)
class PythonRequirement:
    raw: str
    minimum: tuple[int, int]
    maximum_exclusive: tuple[int, int] | None

    def supports(self, version: tuple[int, int]) -> bool:
        return version >= self.minimum and (
            self.maximum_exclusive is None or version < self.maximum_exclusive
        )


def _parse_python_requirement(value: Any) -> PythonRequirement:
    raw = _string(value, "bundle.compatibility.python", maximum=32)
    match = _PYTHON_REQUIRES.fullmatch(raw)
    if match is None:
        raise PlatformBundleError(
            "bundle.compatibility.python must use >=X.Y or >=X.Y,<A.B"
        )
    minimum = (int(match.group("min_major")), int(match.group("min_minor")))
    maximum = (
        (int(match.group("max_major")), int(match.group("max_minor")))
        if match.group("max_major") is not None
        else None
    )
    if maximum is not None and maximum <= minimum:
        raise PlatformBundleError(
            "Python compatibility maximum must exceed its minimum"
        )
    return PythonRequirement(raw, minimum, maximum)


def _current_os() -> str:
    return {"Windows": "windows", "Linux": "linux", "Darwin": "macos"}.get(
        platform.system(), platform.system().lower()
    )


def _current_architecture() -> str:
    value = platform.machine().lower()
    return {
        "amd64": "x86_64",
        "x64": "x86_64",
        "x86_64": "x86_64",
        "aarch64": "arm64",
        "arm64": "arm64",
    }.get(value, value)


def _string_set(value: Any, label: str, allowed: frozenset[str]) -> tuple[str, ...]:
    items = tuple(
        _string(item, f"{label}[]", maximum=32) for item in _sequence(value, label)
    )
    if not items or len(set(items)) != len(items) or tuple(sorted(items)) != items:
        raise PlatformBundleError(f"{label} must be a non-empty sorted unique array")
    unknown = sorted(set(items) - allowed)
    if unknown:
        raise PlatformBundleError(
            f"{label} contains unsupported values: {', '.join(unknown)}"
        )
    return items


@dataclass(frozen=True, slots=True)
class Compatibility:
    python: PythonRequirement | None
    operating_systems: tuple[str, ...]
    architectures: tuple[str, ...]

    def to_wire(self) -> dict[str, Any]:
        return {
            **({"python": self.python.raw} if self.python is not None else {}),
            "operatingSystems": list(self.operating_systems),
            "architectures": list(self.architectures),
        }

    def assert_current(self) -> None:
        current_python = (os.sys.version_info.major, os.sys.version_info.minor)
        if self.python is not None and not self.python.supports(current_python):
            raise PlatformBundleError(
                "plugin bundle does not support the current Python version",
                details={
                    "requires": self.python.raw,
                    "current": ".".join(map(str, current_python)),
                },
            )
        current_os = _current_os()
        current_arch = _current_architecture()
        if (
            current_os not in self.operating_systems
            or current_arch not in self.architectures
        ):
            raise PlatformBundleError(
                "plugin bundle does not support the current platform",
                details={
                    "current": {
                        "operatingSystem": current_os,
                        "architecture": current_arch,
                    },
                    "supported": {
                        "operatingSystems": list(self.operating_systems),
                        "architectures": list(self.architectures),
                    },
                },
            )


@dataclass(frozen=True, slots=True)
class ContentRecord:
    path: str
    kind: str
    sha256: str
    size: int

    def to_wire(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "kind": self.kind,
            "sha256": self.sha256,
            "size": self.size,
        }


@dataclass(frozen=True, slots=True)
class ArtifactRecord:
    path: str
    role: str
    sha256: str
    size: int
    operating_systems: tuple[str, ...]
    architectures: tuple[str, ...]

    def to_wire(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "role": self.role,
            "sha256": self.sha256,
            "size": self.size,
            "os": list(self.operating_systems),
            "arch": list(self.architectures),
        }


@dataclass(frozen=True, slots=True)
class BundleEnvelope:
    compatibility: Compatibility
    contents: tuple[ContentRecord, ...]
    probe_assets: tuple[tuple[str, str], ...]
    artifacts: tuple[ArtifactRecord, ...] = ()
    schema_version: int = BUNDLE_SCHEMA_VERSION_V2
    format: str = BUNDLE_FORMAT_V2

    def to_wire(self) -> dict[str, Any]:
        return {
            "schemaVersion": self.schema_version,
            "format": self.format,
            "compatibility": self.compatibility.to_wire(),
            "contents": [item.to_wire() for item in self.contents],
            "probeAssets": [
                {"id": probe_id, "path": path} for probe_id, path in self.probe_assets
            ],
            **(
                {"artifacts": [item.to_wire() for item in self.artifacts]}
                if self.schema_version == BUNDLE_SCHEMA_VERSION_V3
                else {}
            ),
        }


@dataclass(frozen=True, slots=True)
class WheelMetadata:
    path: str
    package: str
    version: str
    requires_python: str | None
    tags: tuple[str, ...]
    uncompressed_size: int

    def to_wire(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "package": self.package,
            "version": self.version,
            "requiresPython": self.requires_python,
            "tags": list(self.tags),
            "uncompressedSize": self.uncompressed_size,
        }


@dataclass(frozen=True, slots=True)
class VerifiedPlatformBundle:
    path: Path
    sha256: str
    size: int
    envelope_sha256: str
    manifest_sha256: str
    envelope: BundleEnvelope
    manifest: PluginManifest
    wheels: tuple[WheelMetadata, ...]

    @property
    def installation_id(self) -> str:
        return self.sha256.removeprefix("sha256:")

    def to_wire(self) -> dict[str, Any]:
        return {
            "path": str(self.path),
            "sha256": self.sha256,
            "size": self.size,
            "envelopeSha256": self.envelope_sha256,
            "manifestSha256": self.manifest_sha256,
            "manifestContractSha256": self.manifest.canonical_sha256,
            "manifest": self.manifest.to_wire(),
            "compatibility": self.envelope.compatibility.to_wire(),
            "contents": [item.to_wire() for item in self.envelope.contents],
            **(
                {"artifacts": [item.to_wire() for item in self.envelope.artifacts]}
                if self.envelope.schema_version == BUNDLE_SCHEMA_VERSION_V3
                else {}
            ),
            "wheels": [item.to_wire() for item in self.wheels],
        }

    def extract_to(self, destination: Path | str) -> tuple[Path, ...]:
        destination_path = Path(destination).resolve(strict=False)
        if destination_path.exists() and any(destination_path.iterdir()):
            raise PlatformBundleError("bundle extraction destination must be empty")
        destination_path.mkdir(parents=True, exist_ok=True)
        created: list[Path] = []
        try:
            with self.path.open("rb") as bundle_file:
                actual, actual_size = _sha256_stream(bundle_file)
                if (actual, actual_size) != (self.sha256, self.size):
                    raise PlatformBundleError("bundle changed after verification")
                bundle_file.seek(0)
                with zipfile.ZipFile(bundle_file, "r") as archive:
                    records = {item.path: item for item in self.envelope.contents}
                    records[BUNDLE_DESCRIPTOR_PATH] = ContentRecord(
                        BUNDLE_DESCRIPTOR_PATH,
                        "envelope",
                        self.envelope_sha256,
                        archive.getinfo(BUNDLE_DESCRIPTOR_PATH).file_size,
                    )
                    for name in sorted(records):
                        record = records[name]
                        target = destination_path.joinpath(*PurePosixPath(name).parts)
                        target.parent.mkdir(parents=True, exist_ok=True)
                        digest = hashlib.sha256()
                        size = 0
                        with (
                            archive.open(name, "r") as source,
                            target.open("xb") as output,
                        ):
                            for chunk in iter(
                                lambda: source.read(COPY_CHUNK_BYTES), b""
                            ):
                                digest.update(chunk)
                                size += len(chunk)
                                if size > record.size:
                                    raise PlatformBundleError(
                                        f"archive entry {name!r} exceeds its verified size"
                                    )
                                output.write(chunk)
                            output.flush()
                            os.fsync(output.fileno())
                        if (
                            size != record.size
                            or f"sha256:{digest.hexdigest()}" != record.sha256
                        ):
                            raise PlatformBundleError(
                                f"archive entry {name!r} changed during extraction"
                            )
                        created.append(target)
        except (OSError, KeyError, zipfile.BadZipFile, RuntimeError) as exc:
            if isinstance(exc, PlatformBundleError):
                raise
            raise PlatformBundleError(
                f"unable to extract verified bundle: {exc}"
            ) from exc
        return tuple(created)


def _parse_content(value: Any, index: int) -> ContentRecord:
    label = f"bundle.contents[{index}]"
    data = _mapping(value, label)
    _only_keys(data, required={"path", "kind", "sha256", "size"}, label=label)
    path = _string(data["path"], f"{label}.path", maximum=512)
    _safe_archive_path(path, label)
    kind = _string(data["kind"], f"{label}.kind", maximum=32)
    if path == MANIFEST_PATH:
        if kind != "manifest":
            raise PlatformBundleError("manifest.json must use content kind manifest")
    else:
        prefix = _CONTENT_PREFIXES.get(kind)
        if prefix is None or not path.startswith(prefix) or path == prefix:
            raise PlatformBundleError(f"{label} has a path/kind mismatch")
    digest = _string(data["sha256"], f"{label}.sha256", maximum=71)
    if not _SHA256.fullmatch(digest):
        raise PlatformBundleError(f"{label}.sha256 must be lowercase SHA-256")
    size = _positive_int(data["size"], f"{label}.size", maximum=MAX_ENTRY_BYTES)
    return ContentRecord(path, kind, digest, size)


def _parse_artifact(
    value: Any,
    index: int,
    records: Mapping[str, ContentRecord],
) -> ArtifactRecord:
    label = f"bundle.artifacts[{index}]"
    data = _mapping(value, label)
    _only_keys(
        data,
        required={"path", "role", "sha256", "size", "os", "arch"},
        label=label,
    )
    path = _string(data["path"], f"{label}.path", maximum=512)
    _safe_archive_path(path, label)
    role = _string(data["role"], f"{label}.role", maximum=32)
    if role not in ARTIFACT_ROLES:
        raise PlatformBundleError(f"{label}.role is not supported")
    digest = _string(data["sha256"], f"{label}.sha256", maximum=71)
    if not _SHA256.fullmatch(digest):
        raise PlatformBundleError(f"{label}.sha256 must be lowercase SHA-256")
    size = _positive_int(data["size"], f"{label}.size", maximum=MAX_ENTRY_BYTES)
    operating_systems = _string_set(data["os"], f"{label}.os", _ALLOWED_OS)
    architectures = _string_set(data["arch"], f"{label}.arch", _ALLOWED_ARCH)
    content = records.get(path)
    if content is None or (content.sha256, content.size) != (digest, size):
        raise PlatformBundleError(
            f"{label} does not match the content digest table",
            details={"path": path},
        )
    return ArtifactRecord(
        path,
        role,
        digest,
        size,
        operating_systems,
        architectures,
    )


def _parse_envelope(value: Any) -> BundleEnvelope:
    root = _mapping(value, "bundle")
    schema_version = root.get("schemaVersion")
    format_value = root.get("format")
    if schema_version == BUNDLE_SCHEMA_VERSION_V2:
        expected_format = BUNDLE_FORMAT_V2
        required_fields = {
            "schemaVersion",
            "format",
            "compatibility",
            "contents",
            "probeAssets",
        }
    elif schema_version == BUNDLE_SCHEMA_VERSION_V3:
        expected_format = BUNDLE_FORMAT_V3
        required_fields = {
            "schemaVersion",
            "format",
            "compatibility",
            "contents",
            "probeAssets",
            "artifacts",
        }
    else:
        raise PlatformBundleError("bundle schemaVersion must explicitly be 2 or 3")
    _only_keys(
        root,
        required=required_fields,
        label="bundle",
    )
    if format_value != expected_format:
        raise PlatformBundleError(
            f"bundle format must be {expected_format} for schema {schema_version}"
        )
    raw_compatibility = _mapping(root["compatibility"], "bundle.compatibility")
    _only_keys(
        raw_compatibility,
        required=(
            {"python", "operatingSystems", "architectures"}
            if schema_version == BUNDLE_SCHEMA_VERSION_V2
            else {"operatingSystems", "architectures"}
        ),
        optional=(
            frozenset() if schema_version == BUNDLE_SCHEMA_VERSION_V2 else {"python"}
        ),
        label="bundle.compatibility",
    )
    compatibility = Compatibility(
        python=(
            _parse_python_requirement(raw_compatibility["python"])
            if "python" in raw_compatibility
            else None
        ),
        operating_systems=_string_set(
            raw_compatibility["operatingSystems"],
            "bundle.compatibility.operatingSystems",
            _ALLOWED_OS,
        ),
        architectures=_string_set(
            raw_compatibility["architectures"],
            "bundle.compatibility.architectures",
            _ALLOWED_ARCH,
        ),
    )
    contents = tuple(
        _parse_content(item, index)
        for index, item in enumerate(_sequence(root["contents"], "bundle.contents"))
    )
    if not contents or tuple(item.path for item in contents) != tuple(
        sorted(item.path for item in contents)
    ):
        raise PlatformBundleError(
            "bundle.contents must be a non-empty path-sorted array"
        )
    paths = [item.path for item in contents]
    if len(set(paths)) != len(paths) or len({path.casefold() for path in paths}) != len(
        paths
    ):
        raise PlatformBundleError(
            "bundle.contents contains duplicate or case-conflicting paths"
        )
    if paths.count(MANIFEST_PATH) != 1:
        raise PlatformBundleError("bundle must declare exactly one manifest")
    if schema_version == BUNDLE_SCHEMA_VERSION_V2 and not any(
        item.kind == "wheel" for item in contents
    ):
        raise PlatformBundleError(
            "bundle must declare one manifest and at least one wheel"
        )
    if schema_version == BUNDLE_SCHEMA_VERSION_V2:
        unsupported_v2 = sorted(
            item.path
            for item in contents
            if item.kind in {"license", "runtime", "source-map"}
        )
        if unsupported_v2:
            raise PlatformBundleError(
                "schema-v2 bundle contains content outside the frozen layout",
                details={"paths": unsupported_v2},
            )
    if paths.count(SBOM_PATH) != 1:
        raise PlatformBundleError(f"bundle must declare exactly one {SBOM_PATH}")
    probe_assets: list[tuple[str, str]] = []
    for index, raw_probe in enumerate(
        _sequence(root["probeAssets"], "bundle.probeAssets")
    ):
        label = f"bundle.probeAssets[{index}]"
        probe = _mapping(raw_probe, label)
        _only_keys(probe, required={"id", "path"}, label=label)
        probe_id = _string(probe["id"], f"{label}.id", maximum=128)
        path = _string(probe["path"], f"{label}.path", maximum=512)
        if path not in paths or not path.startswith("probes/"):
            raise PlatformBundleError(f"{label}.path does not reference probe content")
        probe_assets.append((probe_id, path))
    if (
        probe_assets != sorted(probe_assets)
        or len({item[0] for item in probe_assets}) != len(probe_assets)
        or len({item[1] for item in probe_assets}) != len(probe_assets)
    ):
        raise PlatformBundleError(
            "bundle.probeAssets must be sorted with unique IDs and paths"
        )
    probe_content_paths = {item.path for item in contents if item.kind == "probe"}
    if {item[1] for item in probe_assets} != probe_content_paths:
        raise PlatformBundleError(
            "bundle.probeAssets must cover every probe content exactly once"
        )
    artifacts: tuple[ArtifactRecord, ...] = ()
    if schema_version == BUNDLE_SCHEMA_VERSION_V3:
        records = {item.path: item for item in contents}
        artifacts = tuple(
            _parse_artifact(item, index, records)
            for index, item in enumerate(
                _sequence(root["artifacts"], "bundle.artifacts")
            )
        )
        artifact_paths = [item.path for item in artifacts]
        expected_artifact_paths = sorted(set(paths) - {MANIFEST_PATH})
        if artifact_paths != sorted(artifact_paths):
            raise PlatformBundleError("bundle.artifacts must be path-sorted")
        if len(set(artifact_paths)) != len(artifact_paths) or len(
            {path.casefold() for path in artifact_paths}
        ) != len(artifact_paths):
            raise PlatformBundleError(
                "bundle.artifacts contains duplicate or case-conflicting paths"
            )
        if artifact_paths != expected_artifact_paths:
            raise PlatformBundleError(
                "bundle.artifacts must cover every non-manifest content exactly once",
                details={
                    "extra": sorted(set(artifact_paths) - set(expected_artifact_paths)),
                    "missing": sorted(
                        set(expected_artifact_paths) - set(artifact_paths)
                    ),
                },
            )
    return BundleEnvelope(
        compatibility=compatibility,
        contents=contents,
        probe_assets=tuple(probe_assets),
        artifacts=artifacts,
        schema_version=schema_version,
        format=expected_format,
    )


def _parse_semver(value: str, label: str) -> tuple[int, int, int]:
    match = _SEMVER.fullmatch(value)
    if match is None:
        raise PlatformBundleError(f"{label} must be a supported SemVer value")
    return tuple(int(match.group(name)) for name in ("major", "minor", "patch"))


def _assert_engine_supports(range_value: str, host_version: str) -> None:
    current = _parse_semver(host_version, "host version")
    terms = range_value.replace(",", " ").split()
    if not terms:
        raise PlatformBundleError("plugin.engines.candlescope is empty")
    for term in terms:
        match = _ENGINE_TERM.fullmatch(term)
        if match is None:
            raise PlatformBundleError(
                "plugin.engines.candlescope has unsupported syntax"
            )
        operator = match.group(1) or "="
        expected = _parse_semver(match.group(2), "plugin.engines.candlescope")
        supported = {
            ">=": current >= expected,
            "<=": current <= expected,
            ">": current > expected,
            "<": current < expected,
            "=": current == expected,
        }[operator]
        if not supported:
            raise PlatformBundleError(
                "plugin manifest does not support this CandleScope Host version",
                details={"requires": range_value, "current": host_version},
            )


def _parse_wheel_metadata(archive: zipfile.ZipFile, path: str) -> WheelMetadata:
    infos = archive.infolist()
    if not infos:
        raise PlatformBundleError(f"wheel {path!r} is empty")
    by_name = _validate_nested_wheel_infos(infos, path)
    metadata_paths = [name for name in by_name if name.endswith(".dist-info/METADATA")]
    wheel_paths = [name for name in by_name if name.endswith(".dist-info/WHEEL")]
    record_paths = [name for name in by_name if name.endswith(".dist-info/RECORD")]
    if not (len(metadata_paths) == len(wheel_paths) == len(record_paths) == 1):
        raise PlatformBundleError(
            f"wheel {path!r} must contain one dist-info metadata set"
        )
    dist_root = metadata_paths[0].removesuffix("METADATA")
    if (
        wheel_paths[0].removesuffix("WHEEL") != dist_root
        or record_paths[0].removesuffix("RECORD") != dist_root
    ):
        raise PlatformBundleError(f"wheel {path!r} has inconsistent dist-info roots")
    try:
        metadata = BytesParser(policy=email.policy.default).parsebytes(
            archive.read(metadata_paths[0])
        )
        wheel_data = BytesParser(policy=email.policy.default).parsebytes(
            archive.read(wheel_paths[0])
        )
    except (OSError, KeyError, UnicodeError) as exc:
        raise PlatformBundleError(f"wheel {path!r} metadata cannot be read") from exc
    package = metadata.get("Name")
    version = metadata.get("Version")
    if (
        not isinstance(package, str)
        or not package.strip()
        or not isinstance(version, str)
        or not version.strip()
    ):
        raise PlatformBundleError(f"wheel {path!r} metadata lacks Name or Version")
    tags = tuple(sorted(wheel_data.get_all("Tag", [])))
    if not tags:
        raise PlatformBundleError(
            f"wheel {path!r} does not declare any compatibility tags"
        )
    total = sum(info.file_size for info in infos if not info.is_dir())
    return WheelMetadata(
        path=path,
        package=package,
        version=version,
        requires_python=metadata.get("Requires-Python"),
        tags=tags,
        uncompressed_size=total,
    )


def _validate_nested_wheel_infos(
    infos: Sequence[zipfile.ZipInfo], wheel_path: str
) -> dict[str, zipfile.ZipInfo]:
    by_name: dict[str, zipfile.ZipInfo] = {}
    folded: set[str] = set()
    total = 0
    for info in infos:
        name = info.filename
        if info.is_dir():
            if info.file_size != 0 or not name.endswith("/"):
                raise PlatformBundleError(
                    f"wheel {wheel_path!r} has an invalid directory"
                )
            continue
        _safe_archive_path(name, f"wheel {wheel_path!r}")
        if _zip_symlink(info):
            raise PlatformBundleError(f"wheel {wheel_path!r} contains a symbolic link")
        mode = (info.external_attr >> 16) & 0xFFFF
        if info.create_system == 3 and mode and not stat.S_ISREG(mode):
            raise PlatformBundleError(
                f"wheel {wheel_path!r} contains a non-regular file"
            )
        if info.flag_bits & 0x1:
            raise PlatformBundleError(
                f"wheel {wheel_path!r} contains encrypted content"
            )
        if name in by_name or name.casefold() in folded:
            raise PlatformBundleError(f"wheel {wheel_path!r} contains duplicate paths")
        total += info.file_size
        if total > MAX_WHEEL_UNCOMPRESSED_BYTES:
            raise PlatformBundleError(
                f"wheel {wheel_path!r} exceeds installed-size limit"
            )
        by_name[name] = info
        folded.add(name.casefold())
    return by_name


def _audit_nested_wheel(
    bundle: zipfile.ZipFile, record: ContentRecord
) -> WheelMetadata:
    try:
        with (
            bundle.open(record.path, "r") as nested,
            zipfile.ZipFile(nested, "r") as wheel,
        ):
            return _parse_wheel_metadata(wheel, record.path)
    except PlatformBundleError:
        raise
    except (OSError, zipfile.BadZipFile, RuntimeError) as exc:
        raise PlatformBundleError(f"wheel {record.path!r} is invalid: {exc}") from exc


def _runtime_artifact_path(runtime: Any) -> str | None:
    if isinstance(runtime, PythonModuleRuntime):
        return None
    if isinstance(
        runtime,
        (
            NativeExecutableRuntime,
            JavaJarRuntime,
            NodeModuleRuntime,
            WasmComponentRuntime,
        ),
    ):
        return runtime.artifact
    raise AssertionError("manifest runtime normalization produced an unknown type")


def _verify_artifact_inventory(
    envelope: BundleEnvelope,
    manifest: PluginManifest,
) -> None:
    if envelope.schema_version != BUNDLE_SCHEMA_VERSION_V3:
        if envelope.artifacts:
            raise AssertionError("schema-v2 envelope unexpectedly has artifacts")
        return
    by_path = {item.path: item for item in envelope.artifacts}
    for content in envelope.contents:
        if content.path == MANIFEST_PATH or content.kind == "runtime":
            continue
        expected_role = _CONTENT_ARTIFACT_ROLES.get(content.kind)
        artifact = by_path.get(content.path)
        if expected_role is None or artifact is None or artifact.role != expected_role:
            raise PlatformBundleError(
                "bundle artifact role does not match its content path",
                plugin_id=manifest.plugin.id,
                details={"path": content.path, "expectedRole": expected_role},
            )

    referenced_runtime_paths: dict[str, str] = {}
    has_python = False
    has_node = False
    current_os = _current_os()
    current_arch = _current_architecture()
    for entrypoint in manifest.normalized_entrypoints:
        runtime = entrypoint.runtime
        path = _runtime_artifact_path(runtime)
        if path is None:
            has_python = True
            continue
        has_node = has_node or isinstance(runtime, NodeModuleRuntime)
        artifact = by_path.get(path)
        expected_role = _RUNTIME_ARTIFACT_ROLES[runtime.kind]
        if artifact is None or artifact.role != expected_role:
            raise PlatformBundleError(
                "manifest runtime references a missing or wrongly typed artifact",
                plugin_id=manifest.plugin.id,
                details={
                    "entrypointId": entrypoint.id,
                    "path": path,
                    "expectedRole": expected_role,
                },
            )
        if (
            current_os not in artifact.operating_systems
            or current_arch not in artifact.architectures
        ):
            raise PlatformBundleError(
                "runtime artifact does not support the current platform",
                plugin_id=manifest.plugin.id,
                details={
                    "entrypointId": entrypoint.id,
                    "path": path,
                    "current": {
                        "operatingSystem": current_os,
                        "architecture": current_arch,
                    },
                },
            )
        if isinstance(runtime, NativeExecutableRuntime) and (
            runtime.operating_systems != artifact.operating_systems
            or runtime.architectures != artifact.architectures
        ):
            raise PlatformBundleError(
                "native runtime platform declaration does not match its artifact",
                plugin_id=manifest.plugin.id,
                details={"entrypointId": entrypoint.id, "path": path},
            )
        referenced_runtime_paths[path] = expected_role

    if has_node:
        for artifact in envelope.artifacts:
            if artifact.role == _RUNTIME_ARTIFACT_ROLES["node-module"]:
                referenced_runtime_paths[artifact.path] = artifact.role

    if has_python and not any(
        item.role == "python-wheel" for item in envelope.artifacts
    ):
        raise PlatformBundleError(
            "python-module runtime requires at least one python-wheel artifact",
            plugin_id=manifest.plugin.id,
        )
    declared_runtime_paths = {
        item.path
        for item in envelope.artifacts
        if item.role in set(_RUNTIME_ARTIFACT_ROLES.values())
    }
    if declared_runtime_paths != set(referenced_runtime_paths):
        raise PlatformBundleError(
            "runtime artifacts must be referenced by manifest entrypoints",
            plugin_id=manifest.plugin.id,
            details={
                "unreferenced": sorted(
                    declared_runtime_paths - set(referenced_runtime_paths)
                ),
                "missing": sorted(
                    set(referenced_runtime_paths) - declared_runtime_paths
                ),
            },
        )


def _verify_semantic_assets(
    archive: zipfile.ZipFile,
    envelope: BundleEnvelope,
    manifest: PluginManifest,
    records: Mapping[str, ContentRecord],
    wheels: Sequence[WheelMetadata],
) -> None:
    manifest_probes = {item.id: item for item in manifest.probes}
    mapped_probes = dict(envelope.probe_assets)
    if set(manifest_probes) != set(mapped_probes):
        raise PlatformBundleError(
            "bundle probe assets do not exactly match manifest probes",
            plugin_id=manifest.plugin.id,
        )
    for probe_id, path in envelope.probe_assets:
        value = _require_canonical_json(archive.read(path), f"probe asset {probe_id!r}")
        expected = _mapping(value, f"probe asset {probe_id!r}").get("expected")
        expected_map = _mapping(expected, f"probe asset {probe_id!r}.expected")
        if expected_map.get("transcriptSha256") != manifest_probes[probe_id].sha256:
            raise PlatformBundleError(
                f"probe asset {probe_id!r} does not bind the manifest semantic digest",
                plugin_id=manifest.plugin.id,
            )
    sbom = _mapping(
        _require_canonical_json(archive.read(SBOM_PATH), "CycloneDX SBOM"),
        "CycloneDX SBOM",
    )
    if (
        sbom.get("bomFormat") != "CycloneDX"
        or not isinstance(sbom.get("specVersion"), str)
        or isinstance(sbom.get("version"), bool)
        or not isinstance(sbom.get("version"), int)
        or sbom["version"] <= 0
    ):
        raise PlatformBundleError(
            "sbom/cyclonedx.json is not a minimal CycloneDX document"
        )
    components = sbom.get("components")
    if not isinstance(components, list) or not all(
        isinstance(item, dict) for item in components
    ):
        raise PlatformBundleError(
            "CycloneDX SBOM components must be an array of objects"
        )
    declared_components = {
        (
            _NORMALIZE_PACKAGE.sub("-", item["name"]).lower(),
            item["version"],
        )
        for item in components
        if isinstance(item.get("name"), str) and isinstance(item.get("version"), str)
    }
    missing_wheels = sorted(
        f"{item.package}=={item.version}"
        for item in wheels
        if (
            _NORMALIZE_PACKAGE.sub("-", item.package).lower(),
            item.version,
        )
        not in declared_components
    )
    if missing_wheels:
        raise PlatformBundleError(
            "CycloneDX SBOM does not cover every bundled wheel",
            details={"missing": missing_wheels},
        )
    for record in envelope.contents:
        if record.path.endswith(".json") and record.path != MANIFEST_PATH:
            _require_canonical_json(
                archive.read(record.path), f"content {record.path!r}"
            )
    web_paths = {item.path for item in envelope.contents if item.kind == "web"}
    if manifest.frontend is None:
        if web_paths:
            raise PlatformBundleError(
                "bundle has web assets but manifest has no frontend"
            )
    else:
        if manifest.frontend.assets_root != "web":
            raise PlatformBundleError(
                "v2 bundle frontend.assetsRoot must be exactly 'web'"
            )
        required_entries = {
            f"web/{surface.entry}" for surface in manifest.frontend.surfaces
        }
        missing = sorted(required_entries - web_paths)
        if missing:
            raise PlatformBundleError(
                "bundle is missing declared frontend entries",
                details={"missing": missing},
            )
    if set(records) != {item.path for item in envelope.contents}:
        raise AssertionError("content record map drifted during verification")


def verify_platform_bundle(
    path: Path | str,
    *,
    expected_sha256: str | None,
    host_version: str = DEFAULT_HOST_VERSION,
) -> VerifiedPlatformBundle:
    bundle_path = Path(path).expanduser().resolve(strict=False)
    if bundle_path.suffix.lower() != BUNDLE_EXTENSION:
        raise PlatformBundleError(
            f"plugin bundle must use the {BUNDLE_EXTENSION} extension"
        )
    if expected_sha256 is None:
        raise PlatformBundleError(
            "installing a v2 bundle requires an expected SHA-256 digest"
        )
    expected = normalize_expected_sha256(expected_sha256)
    try:
        with bundle_path.open("rb") as bundle_file:
            size = os.fstat(bundle_file.fileno()).st_size
            if not 0 < size <= MAX_BUNDLE_BYTES:
                raise PlatformBundleError(
                    "plugin bundle is empty or exceeds the size limit"
                )
            actual_sha256, streamed_size = _sha256_stream(bundle_file)
            if streamed_size != size:
                raise PlatformBundleError(
                    "plugin bundle changed while it was being read"
                )
            if actual_sha256 != expected:
                raise PlatformBundleError(
                    "plugin bundle SHA-256 mismatch",
                    details={"expected": expected, "actual": actual_sha256},
                )
            bundle_file.seek(0)
            with zipfile.ZipFile(bundle_file, "r") as archive:
                by_name = _validate_zip_infos(archive.infolist())
                descriptor_info = by_name.get(BUNDLE_DESCRIPTOR_PATH)
                if descriptor_info is None:
                    raise PlatformBundleError(
                        "bundle is not schema v2 because bundle.json is absent"
                    )
                descriptor_bytes = archive.read(descriptor_info)
                envelope = _parse_envelope(
                    _require_canonical_json(descriptor_bytes, "bundle descriptor")
                )
                records = {item.path: item for item in envelope.contents}
                expected_entries = {BUNDLE_DESCRIPTOR_PATH, *records}
                if set(by_name) != expected_entries:
                    raise PlatformBundleError(
                        "plugin bundle entries do not match the digest table",
                        details={
                            "extra": sorted(set(by_name) - expected_entries),
                            "missing": sorted(expected_entries - set(by_name)),
                        },
                    )
                for record in envelope.contents:
                    info = by_name[record.path]
                    if info.file_size != record.size:
                        raise PlatformBundleError(
                            f"content {record.path!r} size does not match the digest table"
                        )
                    with archive.open(info, "r") as stream:
                        digest, content_size = _sha256_stream(stream)
                    if (digest, content_size) != (record.sha256, record.size):
                        raise PlatformBundleError(
                            f"content {record.path!r} failed SHA-256 verification"
                        )
                manifest_record = records[MANIFEST_PATH]
                manifest_bytes = archive.read(MANIFEST_PATH)
                manifest_value = _require_canonical_json(
                    manifest_bytes, "plugin manifest"
                )
                try:
                    manifest = PluginManifest.from_wire(manifest_value)
                except PlatformContractError as exc:
                    raise PlatformBundleError(
                        "plugin manifest violates the public SDK contract",
                        details={"contractCode": exc.code, "path": exc.path},
                    ) from exc
                if manifest_record.sha256 != _sha256_bytes(manifest_bytes):
                    raise AssertionError("manifest digest was not checked")
                if manifest.schema_version != envelope.schema_version:
                    raise PlatformBundleError(
                        "bundle and manifest schemaVersion values must match",
                        plugin_id=manifest.plugin.id,
                    )
                envelope.compatibility.assert_current()
                _assert_engine_supports(
                    manifest.plugin.candlescope_engine, host_version
                )
                wheels = tuple(
                    _audit_nested_wheel(archive, record)
                    for record in envelope.contents
                    if record.kind == "wheel"
                )
                normalized_packages = [
                    _NORMALIZE_PACKAGE.sub("-", item.package).lower() for item in wheels
                ]
                if len(set(normalized_packages)) != len(normalized_packages):
                    raise PlatformBundleError(
                        "bundle contains duplicate wheel distributions"
                    )
                if (
                    sum(item.uncompressed_size for item in wheels)
                    > MAX_TOTAL_WHEEL_UNCOMPRESSED_BYTES
                ):
                    raise PlatformBundleError(
                        "bundled wheels exceed the installed-size limit"
                    )
                _verify_artifact_inventory(envelope, manifest)
                _verify_semantic_assets(
                    archive,
                    envelope,
                    manifest,
                    records,
                    wheels,
                )
    except PlatformBundleError:
        raise
    except OSError as exc:
        raise PlatformBundleError(f"unable to read plugin bundle: {exc}") from exc
    except (KeyError, zipfile.BadZipFile, RuntimeError) as exc:
        raise PlatformBundleError(
            f"plugin bundle is not a valid ZIP archive: {exc}"
        ) from exc
    return VerifiedPlatformBundle(
        path=bundle_path,
        sha256=actual_sha256,
        size=size,
        envelope_sha256=_sha256_bytes(descriptor_bytes),
        manifest_sha256=_sha256_bytes(manifest_bytes),
        envelope=envelope,
        manifest=manifest,
        wheels=wheels,
    )


def inspect_platform_bundle(
    path: Path | str, *, host_version: str = DEFAULT_HOST_VERSION
) -> VerifiedPlatformBundle:
    bundle_path = Path(path).expanduser().resolve(strict=False)
    return verify_platform_bundle(
        bundle_path,
        expected_sha256=sha256_file(bundle_path),
        host_version=host_version,
    )


def _content_kind(path: str) -> str:
    if path == MANIFEST_PATH:
        return "manifest"
    for kind, prefix in _CONTENT_PREFIXES.items():
        if path.startswith(prefix) and path != prefix:
            return kind
    raise PlatformBundleError(
        f"bundle source contains an unsupported file outside the platform layout: {path!r}"
    )


def _artifact_role_by_runtime_path(
    manifest: PluginManifest,
    runtime_paths: Sequence[str] = (),
) -> dict[str, str]:
    roles: dict[str, str] = {}
    for entrypoint in manifest.normalized_entrypoints:
        path = _runtime_artifact_path(entrypoint.runtime)
        if path is None:
            continue
        role = _RUNTIME_ARTIFACT_ROLES[entrypoint.runtime.kind]
        existing = roles.get(path)
        if existing is not None and existing != role:
            raise PlatformBundleError(
                "one runtime artifact cannot have multiple roles",
                plugin_id=manifest.plugin.id,
                details={"path": path, "roles": sorted({existing, role})},
            )
        roles[path] = role
    if any(
        isinstance(entrypoint.runtime, NodeModuleRuntime)
        for entrypoint in manifest.normalized_entrypoints
    ):
        for path in runtime_paths:
            if path.startswith("runtime/") and path.casefold().endswith(".mjs"):
                roles[path] = _RUNTIME_ARTIFACT_ROLES["node-module"]
    return roles


def _zip_info(name: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_STORED
    info.create_system = 3
    info.external_attr = (stat.S_IFREG | 0o644) << 16
    return info


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


def build_platform_bundle(
    source_directory: Path | str,
    output_path: Path | str,
    *,
    python_requires: str | None = DEFAULT_PYTHON_REQUIRES,
    operating_systems: Sequence[str] = ("linux", "macos", "windows"),
    architectures: Sequence[str] = ("arm64", "x86_64"),
    host_version: str = DEFAULT_HOST_VERSION,
    force: bool = False,
) -> VerifiedPlatformBundle:
    source = Path(source_directory).expanduser().resolve(strict=False)
    output = Path(output_path).expanduser().resolve(strict=False)
    if not source.is_dir() or source.is_symlink():
        raise PlatformBundleError("bundle source must be a real directory")
    if output.suffix.lower() != BUNDLE_EXTENSION:
        raise PlatformBundleError(
            f"bundle output must use the {BUNDLE_EXTENSION} extension"
        )
    if output == source or source in output.parents:
        raise PlatformBundleError("bundle output must be outside the source directory")
    raw_files: dict[str, bytes] = {}
    for candidate in sorted(source.rglob("*")):
        if candidate.is_symlink():
            raise PlatformBundleError("bundle source must not contain symbolic links")
        if candidate.is_dir():
            continue
        if not candidate.is_file():
            raise PlatformBundleError("bundle source must contain regular files only")
        relative = candidate.relative_to(source).as_posix()
        _safe_archive_path(relative, "bundle source")
        if relative == BUNDLE_DESCRIPTOR_PATH:
            raise PlatformBundleError(
                "bundle.json is generated and must not exist in the source"
            )
        _content_kind(relative)
        try:
            data = candidate.read_bytes()
        except OSError as exc:
            raise PlatformBundleError(
                f"unable to read bundle source {relative!r}: {exc}"
            ) from exc
        if not data or len(data) > MAX_ENTRY_BYTES:
            raise PlatformBundleError(
                f"bundle source {relative!r} is empty or too large"
            )
        if relative.endswith(".json"):
            data = _canonical_json_bytes(
                _strict_json(data, f"bundle source {relative!r}")
            )
        raw_files[relative] = data
    if MANIFEST_PATH not in raw_files or SBOM_PATH not in raw_files:
        raise PlatformBundleError(
            f"bundle source must contain {MANIFEST_PATH} and {SBOM_PATH}"
        )
    manifest_value = _strict_json(raw_files[MANIFEST_PATH], "plugin manifest")
    try:
        manifest = PluginManifest.from_wire(manifest_value)
    except PlatformContractError as exc:
        raise PlatformBundleError(
            "plugin manifest violates the public SDK contract",
            details={"contractCode": exc.code, "path": exc.path},
        ) from exc
    if (
        manifest.schema_version == MANIFEST_SCHEMA_VERSION_V2
        and python_requires is None
    ):
        raise PlatformBundleError("schema-v2 bundle requires Python compatibility")
    probe_assets: list[tuple[str, str]] = []
    for probe in manifest.probes:
        path = f"probes/{probe.id}.json"
        if path not in raw_files:
            raise PlatformBundleError(f"bundle source is missing probe asset {path!r}")
        probe_assets.append((probe.id, path))
    records = tuple(
        ContentRecord(path, _content_kind(path), _sha256_bytes(data), len(data))
        for path, data in sorted(raw_files.items())
    )
    operating_system_values = _string_set(
        list(operating_systems), "operatingSystems", _ALLOWED_OS
    )
    architecture_values = _string_set(
        list(architectures), "architectures", _ALLOWED_ARCH
    )
    artifacts: tuple[ArtifactRecord, ...] = ()
    envelope_schema_version = BUNDLE_SCHEMA_VERSION_V2
    envelope_format = BUNDLE_FORMAT_V2
    if manifest.schema_version == MANIFEST_SCHEMA_VERSION_V3:
        envelope_schema_version = BUNDLE_SCHEMA_VERSION_V3
        envelope_format = BUNDLE_FORMAT_V3
        runtime_roles = _artifact_role_by_runtime_path(
            manifest,
            tuple(record.path for record in records if record.kind == "runtime"),
        )
        native_platforms = {
            runtime.artifact: (runtime.operating_systems, runtime.architectures)
            for runtime in (item.runtime for item in manifest.normalized_entrypoints)
            if isinstance(runtime, NativeExecutableRuntime)
        }
        artifact_values: list[ArtifactRecord] = []
        for record in records:
            if record.path == MANIFEST_PATH:
                continue
            if record.kind == "runtime":
                role = runtime_roles.get(record.path)
                if role is None:
                    raise PlatformBundleError(
                        "bundle source contains an unreferenced runtime artifact",
                        plugin_id=manifest.plugin.id,
                        details={"path": record.path},
                    )
            else:
                role = _CONTENT_ARTIFACT_ROLES.get(record.kind)
                if role is None:
                    raise PlatformBundleError(
                        "bundle source content has no artifact role",
                        details={"path": record.path, "kind": record.kind},
                    )
            artifact_os, artifact_arch = native_platforms.get(
                record.path,
                (operating_system_values, architecture_values),
            )
            artifact_values.append(
                ArtifactRecord(
                    record.path,
                    role,
                    record.sha256,
                    record.size,
                    artifact_os,
                    artifact_arch,
                )
            )
        artifacts = tuple(artifact_values)
    envelope = BundleEnvelope(
        compatibility=Compatibility(
            python=(
                _parse_python_requirement(python_requires)
                if python_requires is not None
                else None
            ),
            operating_systems=operating_system_values,
            architectures=architecture_values,
        ),
        contents=records,
        probe_assets=tuple(sorted(probe_assets)),
        artifacts=artifacts,
        schema_version=envelope_schema_version,
        format=envelope_format,
    )
    descriptor_bytes = _canonical_json_bytes(envelope.to_wire())
    try:
        output.parent.mkdir(parents=True, exist_ok=True)
        temporary_handle = tempfile.NamedTemporaryFile(
            mode="wb",
            prefix=f".{output.name}.",
            suffix=f".part{BUNDLE_EXTENSION}",
            dir=output.parent,
            delete=False,
        )
        temporary = Path(temporary_handle.name)
        temporary_handle.close()
    except OSError as exc:
        raise PlatformBundleError(f"unable to prepare bundle output: {exc}") from exc
    try:
        with zipfile.ZipFile(temporary, "w", allowZip64=True) as archive:
            archive.writestr(_zip_info(BUNDLE_DESCRIPTOR_PATH), descriptor_bytes)
            for path, data in sorted(raw_files.items()):
                archive.writestr(_zip_info(path), data)
        with temporary.open("r+b") as handle:
            handle.flush()
            os.fsync(handle.fileno())
        inspect_platform_bundle(temporary, host_version=host_version)
        if output.exists() and not force:
            raise PlatformBundleError(f"bundle output already exists: {output}")
        _replace_file(temporary, output)
        _fsync_directory(output.parent)
    except PlatformBundleError:
        raise
    except (OSError, zipfile.BadZipFile, RuntimeError) as exc:
        raise PlatformBundleError(f"unable to build plugin bundle: {exc}") from exc
    finally:
        try:
            temporary.unlink()
        except OSError:
            pass
    return inspect_platform_bundle(output, host_version=host_version)
