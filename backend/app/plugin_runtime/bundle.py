"""Strict, deterministic ``.cspkg`` bundle format for runtime plugins."""

from __future__ import annotations

import email.policy
import hashlib
import json
import os
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

from candlescope_plugin_sdk import (
    AnalyzeRequest,
    Bar,
    ExecuteBatchRequest,
    MarketContext,
    PROTOCOL_V1,
    ProtocolError,
)

from .errors import PluginBundleError


BUNDLE_SCHEMA_VERSION = 1
BUNDLE_EXTENSION = ".cspkg"
MANIFEST_PATH = "manifest.json"
MAX_BUNDLE_BYTES = 512 * 1024 * 1024
MAX_ARCHIVE_ENTRIES = 256
MAX_MANIFEST_BYTES = 1024 * 1024
MAX_WHEELS = 64
MAX_WHEEL_BYTES = 250 * 1024 * 1024
MAX_WHEEL_UNCOMPRESSED_BYTES = 512 * 1024 * 1024
MAX_TOTAL_WHEEL_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024
MAX_PROBE_SOURCE_BYTES = 1024 * 1024
MAX_PROBE_BARS = 1000
COPY_CHUNK_BYTES = 1024 * 1024

_PLUGIN_ID = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$")
_PACKAGE_NAME = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$")
_VERSION = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9.!+_-]{0,126}[A-Za-z0-9])?$")
_MODULE = re.compile(r"^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$")
_SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
_PYTHON_REQUIRES = re.compile(
    r"^>=(?P<min_major>\d+)\.(?P<min_minor>\d+)"
    r"(?:,<(?P<max_major>\d+)\.(?P<max_minor>\d+))?$"
)
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


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"non-standard JSON constant is not allowed: {value}")


def _unique_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON object key: {key}")
        result[key] = value
    return result


def _decode_json(data: bytes, label: str) -> Any:
    try:
        return json.loads(
            data.decode("utf-8"),
            parse_constant=_reject_json_constant,
            object_pairs_hook=_unique_json_object,
        )
    except (UnicodeError, json.JSONDecodeError, ValueError) as exc:
        raise PluginBundleError(f"{label} is not strict UTF-8 JSON: {exc}") from exc


def _mapping(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise PluginBundleError(f"{label} must be a JSON object")
    return value


def _sequence(value: Any, label: str) -> Sequence[Any]:
    if isinstance(value, (str, bytes)) or not isinstance(value, Sequence):
        raise PluginBundleError(f"{label} must be a JSON array")
    return value


def _only_keys(value: Mapping[str, Any], allowed: set[str], label: str) -> None:
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise PluginBundleError(
            f"{label} contains unsupported fields: {', '.join(unknown)}"
        )


def _string(value: Any, label: str, *, max_length: int = 4096) -> str:
    if not isinstance(value, str) or not value.strip():
        raise PluginBundleError(f"{label} must be a non-empty string")
    if "\0" in value:
        raise PluginBundleError(f"{label} must not contain NUL")
    if len(value) > max_length:
        raise PluginBundleError(f"{label} exceeds {max_length} characters")
    return value


def _positive_int(value: Any, label: str, *, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise PluginBundleError(f"{label} must be a positive integer")
    if value > maximum:
        raise PluginBundleError(f"{label} exceeds {maximum}")
    return value


def _normalize_package(name: str) -> str:
    return _NORMALIZE_PACKAGE.sub("-", name).lower()


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
        raise PluginBundleError(f"unable to hash bundle artifact: {exc}") from exc


def normalize_expected_sha256(value: str) -> str:
    digest = _string(value, "expected SHA-256", max_length=71).lower()
    if not digest.startswith("sha256:"):
        digest = f"sha256:{digest}"
    if not _SHA256.fullmatch(digest):
        raise PluginBundleError("expected SHA-256 must contain 64 hexadecimal digits")
    return digest


def canonical_sha256(value: Any) -> str:
    try:
        encoded = json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise PluginBundleError(f"value is not canonical JSON: {exc}") from exc
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def _canonical_json_bytes(value: Any) -> bytes:
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
        raise PluginBundleError(f"manifest is not JSON-compatible: {exc}") from exc


def _safe_archive_path(name: str, label: str) -> PurePosixPath:
    if not name or "\\" in name or "\0" in name:
        raise PluginBundleError(f"{label} contains an unsafe archive path")
    if any(part in {"", ".", ".."} for part in name.split("/")):
        raise PluginBundleError(
            f"{label} contains a non-canonical archive path: {name!r}"
        )
    path = PurePosixPath(name)
    if path.is_absolute():
        raise PluginBundleError(f"{label} contains an unsafe archive path: {name!r}")
    for part in path.parts:
        if (
            any(ord(character) < 32 or character in '<>:"|?*' for character in part)
            or part.endswith((" ", "."))
            or part.split(".", 1)[0].casefold() in _WINDOWS_RESERVED_NAMES
        ):
            raise PluginBundleError(
                f"{label} contains a platform-unsafe archive path: {name!r}"
            )
    return path


def _is_zip_symlink(info: zipfile.ZipInfo) -> bool:
    mode = (info.external_attr >> 16) & 0xFFFF
    return info.create_system == 3 and stat.S_ISLNK(mode)


@dataclass(frozen=True, slots=True)
class PythonRequirement:
    raw: str
    minimum: tuple[int, int]
    maximum_exclusive: tuple[int, int] | None = None

    def supports(self, version: tuple[int, int]) -> bool:
        if version < self.minimum:
            return False
        return self.maximum_exclusive is None or version < self.maximum_exclusive


@dataclass(frozen=True, slots=True)
class BundleWheel:
    path: str
    package: str
    version: str
    sha256: str
    size: int

    def to_wire(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "package": self.package,
            "version": self.version,
            "sha256": self.sha256,
            "size": self.size,
        }


@dataclass(frozen=True, slots=True)
class ProbeContract:
    analyze_request: AnalyzeRequest
    execute_request: ExecuteBatchRequest
    analysis_sha256: str
    execution_sha256: str

    def to_wire(self) -> dict[str, Any]:
        analyze = self.analyze_request.to_wire()
        execute = self.execute_request.to_wire()
        return {
            "source": analyze["source"],
            "context": analyze["context"],
            "bars": execute["bars"],
            "params": execute["params"],
            "options": analyze["options"],
            "analysisSha256": self.analysis_sha256,
            "executionSha256": self.execution_sha256,
        }


@dataclass(frozen=True, slots=True)
class BundleManifest:
    runtime_id: str
    name: str
    version: str
    package: str
    protocol: str
    python_requirement: PythonRequirement
    module: str
    wheels: tuple[BundleWheel, ...]
    probe: ProbeContract
    schema_version: int = BUNDLE_SCHEMA_VERSION

    def to_wire(self) -> dict[str, Any]:
        return {
            "schemaVersion": self.schema_version,
            "plugin": {
                "id": self.runtime_id,
                "name": self.name,
                "version": self.version,
                "package": self.package,
                "protocol": self.protocol,
            },
            "python": {
                "requires": self.python_requirement.raw,
                "module": self.module,
            },
            "wheels": [wheel.to_wire() for wheel in self.wheels],
            "probe": self.probe.to_wire(),
        }


@dataclass(frozen=True, slots=True)
class WheelMetadata:
    package: str
    version: str
    requires_python: str | None
    tags: tuple[str, ...]
    uncompressed_size: int


@dataclass(frozen=True, slots=True)
class VerifiedBundle:
    path: Path
    sha256: str
    size: int
    manifest_sha256: str
    manifest: BundleManifest

    def extract_wheels(self, destination: Path | str) -> tuple[Path, ...]:
        destination_path = Path(destination).resolve(strict=False)
        destination_path.mkdir(parents=True, exist_ok=True)
        extracted: list[Path] = []
        created: list[Path] = []
        try:
            with self.path.open("rb") as bundle_file:
                bundle_digest, bundle_size = _sha256_stream(bundle_file)
                if bundle_digest != self.sha256 or bundle_size != self.size:
                    raise PluginBundleError("bundle changed after verification")
                bundle_file.seek(0)
                with zipfile.ZipFile(bundle_file, "r") as archive:
                    for wheel in self.manifest.wheels:
                        target = destination_path / PurePosixPath(wheel.path).name
                        if target.exists():
                            raise PluginBundleError(
                                f"wheel extraction target already exists: {target.name}"
                            )
                        digest = hashlib.sha256()
                        size = 0
                        created.append(target)
                        with (
                            archive.open(wheel.path, "r") as source,
                            target.open("xb") as output,
                        ):
                            for chunk in iter(
                                lambda: source.read(COPY_CHUNK_BYTES), b""
                            ):
                                digest.update(chunk)
                                size += len(chunk)
                                if size > wheel.size:
                                    raise PluginBundleError(
                                        f"wheel {wheel.path!r} exceeds its declared size"
                                    )
                                output.write(chunk)
                            output.flush()
                            os.fsync(output.fileno())
                        actual_sha256 = f"sha256:{digest.hexdigest()}"
                        if size != wheel.size or actual_sha256 != wheel.sha256:
                            raise PluginBundleError(
                                f"wheel {wheel.path!r} failed SHA-256 or size verification"
                            )
                        audit_wheel(target, wheel)
                        extracted.append(target)
        except (OSError, zipfile.BadZipFile, RuntimeError) as exc:
            for target in created:
                try:
                    target.unlink()
                except OSError:
                    pass
            if isinstance(exc, PluginBundleError):
                raise
            raise PluginBundleError(
                f"unable to extract verified wheels: {exc}"
            ) from exc
        return tuple(extracted)


def _parse_python_requirement(value: Any) -> PythonRequirement:
    raw = _string(value, "manifest.python.requires", max_length=32)
    matched = _PYTHON_REQUIRES.fullmatch(raw)
    if matched is None:
        raise PluginBundleError("manifest.python.requires must use >=X.Y or >=X.Y,<A.B")
    minimum = (int(matched.group("min_major")), int(matched.group("min_minor")))
    maximum = (
        (int(matched.group("max_major")), int(matched.group("max_minor")))
        if matched.group("max_major") is not None
        else None
    )
    if maximum is not None and maximum <= minimum:
        raise PluginBundleError(
            "manifest.python.requires maximum must be greater than its minimum"
        )
    return PythonRequirement(raw=raw, minimum=minimum, maximum_exclusive=maximum)


def _parse_wheel(value: Any, index: int) -> BundleWheel:
    label = f"manifest.wheels[{index}]"
    wheel = _mapping(value, label)
    _only_keys(wheel, {"path", "package", "version", "sha256", "size"}, label)
    path = _string(wheel.get("path"), f"{label}.path", max_length=255)
    archive_path = _safe_archive_path(path, f"{label}.path")
    if len(archive_path.parts) != 2 or archive_path.parts[0] != "wheels":
        raise PluginBundleError(f"{label}.path must use wheels/<filename>.whl")
    if not archive_path.name.endswith(".whl"):
        raise PluginBundleError(f"{label}.path must name a wheel")
    package = _string(wheel.get("package"), f"{label}.package", max_length=128)
    if not _PACKAGE_NAME.fullmatch(package):
        raise PluginBundleError(f"{label}.package has an invalid format")
    version = _string(wheel.get("version"), f"{label}.version", max_length=128)
    if not _VERSION.fullmatch(version):
        raise PluginBundleError(f"{label}.version has an invalid format")
    sha256 = _string(wheel.get("sha256"), f"{label}.sha256", max_length=71)
    if not _SHA256.fullmatch(sha256):
        raise PluginBundleError(f"{label}.sha256 must use sha256:<64 lowercase hex>")
    size = _positive_int(wheel.get("size"), f"{label}.size", maximum=MAX_WHEEL_BYTES)
    return BundleWheel(
        path=path,
        package=package,
        version=version,
        sha256=sha256,
        size=size,
    )


def _parse_probe(value: Any) -> ProbeContract:
    probe = _mapping(value, "manifest.probe")
    _only_keys(
        probe,
        {
            "source",
            "context",
            "bars",
            "params",
            "options",
            "analysisSha256",
            "executionSha256",
        },
        "manifest.probe",
    )
    source = probe.get("source")
    if not isinstance(source, str):
        raise PluginBundleError("manifest.probe.source must be a string")
    if len(source.encode("utf-8")) > MAX_PROBE_SOURCE_BYTES:
        raise PluginBundleError("manifest.probe.source exceeds the safety limit")
    raw_bars = _sequence(probe.get("bars"), "manifest.probe.bars")
    if not raw_bars or len(raw_bars) > MAX_PROBE_BARS:
        raise PluginBundleError(
            f"manifest.probe.bars must contain 1 to {MAX_PROBE_BARS} bars"
        )
    try:
        context = MarketContext.from_wire(probe.get("context"))
        options = dict(_mapping(probe.get("options", {}), "manifest.probe.options"))
        params = dict(_mapping(probe.get("params", {}), "manifest.probe.params"))
        bars = tuple(Bar.from_wire(bar) for bar in raw_bars)
        analyze_request = AnalyzeRequest(
            source=source,
            context=context,
            options=options,
        )
        execute_request = ExecuteBatchRequest(
            source=source,
            context=context,
            bars=bars,
            params=params,
            options=options,
        )
    except ProtocolError as exc:
        raise PluginBundleError(f"manifest.probe is invalid: {exc.message}") from exc
    analysis_sha256 = _string(
        probe.get("analysisSha256"),
        "manifest.probe.analysisSha256",
        max_length=71,
    )
    execution_sha256 = _string(
        probe.get("executionSha256"),
        "manifest.probe.executionSha256",
        max_length=71,
    )
    if not _SHA256.fullmatch(analysis_sha256) or not _SHA256.fullmatch(
        execution_sha256
    ):
        raise PluginBundleError(
            "manifest probe hashes must use sha256:<64 lowercase hex>"
        )
    return ProbeContract(
        analyze_request=analyze_request,
        execute_request=execute_request,
        analysis_sha256=analysis_sha256,
        execution_sha256=execution_sha256,
    )


def parse_bundle_manifest(value: Any) -> BundleManifest:
    root = _mapping(value, "manifest")
    _only_keys(
        root, {"schemaVersion", "plugin", "python", "wheels", "probe"}, "manifest"
    )
    schema_version = root.get("schemaVersion")
    if isinstance(schema_version, bool) or schema_version != BUNDLE_SCHEMA_VERSION:
        raise PluginBundleError(
            f"unsupported bundle schema; expected {BUNDLE_SCHEMA_VERSION}"
        )

    plugin = _mapping(root.get("plugin"), "manifest.plugin")
    _only_keys(
        plugin, {"id", "name", "version", "package", "protocol"}, "manifest.plugin"
    )
    runtime_id = _string(plugin.get("id"), "manifest.plugin.id", max_length=64)
    if not _PLUGIN_ID.fullmatch(runtime_id):
        raise PluginBundleError("manifest.plugin.id has an invalid format")
    name = _string(plugin.get("name"), "manifest.plugin.name", max_length=128)
    version = _string(plugin.get("version"), "manifest.plugin.version", max_length=128)
    if not _VERSION.fullmatch(version):
        raise PluginBundleError("manifest.plugin.version has an invalid format")
    package = _string(plugin.get("package"), "manifest.plugin.package", max_length=128)
    if not _PACKAGE_NAME.fullmatch(package):
        raise PluginBundleError("manifest.plugin.package has an invalid format")
    protocol = _string(
        plugin.get("protocol"), "manifest.plugin.protocol", max_length=128
    )
    if protocol != PROTOCOL_V1:
        raise PluginBundleError(f"manifest.plugin.protocol must be {PROTOCOL_V1}")

    python = _mapping(root.get("python"), "manifest.python")
    _only_keys(python, {"requires", "module"}, "manifest.python")
    requirement = _parse_python_requirement(python.get("requires"))
    module = _string(python.get("module"), "manifest.python.module", max_length=255)
    if not _MODULE.fullmatch(module):
        raise PluginBundleError("manifest.python.module has an invalid module path")

    raw_wheels = _sequence(root.get("wheels"), "manifest.wheels")
    if not raw_wheels or len(raw_wheels) > MAX_WHEELS:
        raise PluginBundleError(
            f"manifest.wheels must contain 1 to {MAX_WHEELS} wheels"
        )
    wheels = tuple(_parse_wheel(wheel, index) for index, wheel in enumerate(raw_wheels))
    paths = [wheel.path.casefold() for wheel in wheels]
    if len(paths) != len(set(paths)):
        raise PluginBundleError("manifest.wheels contains duplicate archive paths")
    packages = [_normalize_package(wheel.package) for wheel in wheels]
    if len(packages) != len(set(packages)):
        raise PluginBundleError("manifest.wheels contains duplicate package names")
    primary = [
        wheel
        for wheel in wheels
        if _normalize_package(wheel.package) == _normalize_package(package)
    ]
    if len(primary) != 1 or primary[0].version != version:
        raise PluginBundleError(
            "manifest plugin package/version must match exactly one bundled wheel"
        )

    return BundleManifest(
        runtime_id=runtime_id,
        name=name,
        version=version,
        package=package,
        protocol=protocol,
        python_requirement=requirement,
        module=module,
        wheels=wheels,
        probe=_parse_probe(root.get("probe")),
    )


def _validate_zip_infos(
    infos: Sequence[zipfile.ZipInfo],
    *,
    label: str,
    max_entries: int,
    max_total_size: int,
) -> dict[str, zipfile.ZipInfo]:
    if not infos or len(infos) > max_entries:
        raise PluginBundleError(f"{label} contains an invalid number of entries")
    by_name: dict[str, zipfile.ZipInfo] = {}
    casefolded: set[str] = set()
    total_size = 0
    for info in infos:
        path = _safe_archive_path(info.filename, label)
        if info.is_dir() or info.filename.endswith("/"):
            raise PluginBundleError(f"{label} must not contain directory entries")
        if info.flag_bits & 0x1:
            raise PluginBundleError(f"{label} must not contain encrypted entries")
        if info.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}:
            raise PluginBundleError(f"{label} uses an unsupported compression method")
        if _is_zip_symlink(info):
            raise PluginBundleError(f"{label} must not contain symlinks")
        key = str(path).casefold()
        if info.filename in by_name or key in casefolded:
            raise PluginBundleError(
                f"{label} contains duplicate or case-conflicting paths"
            )
        total_size += info.file_size
        if total_size > max_total_size:
            raise PluginBundleError(f"{label} exceeds its uncompressed size limit")
        if info.file_size > 0 and info.compress_size == 0:
            raise PluginBundleError(f"{label} contains an invalid compressed entry")
        by_name[info.filename] = info
        casefolded.add(key)
    return by_name


def _parse_wheel_metadata(
    archive: zipfile.ZipFile,
    declared: BundleWheel,
) -> WheelMetadata:
    infos = archive.infolist()
    by_name = _validate_zip_infos(
        infos,
        label=f"wheel {declared.path!r}",
        max_entries=10_000,
        max_total_size=MAX_WHEEL_UNCOMPRESSED_BYTES,
    )
    metadata_paths = [name for name in by_name if name.endswith(".dist-info/METADATA")]
    wheel_paths = [name for name in by_name if name.endswith(".dist-info/WHEEL")]
    record_paths = [name for name in by_name if name.endswith(".dist-info/RECORD")]
    if len(metadata_paths) != 1 or len(wheel_paths) != 1 or len(record_paths) != 1:
        raise PluginBundleError(
            f"wheel {declared.path!r} must contain one METADATA, WHEEL, and RECORD"
        )
    dist_info_roots = {
        path.split("/", 1)[0]
        for path in (metadata_paths[0], wheel_paths[0], record_paths[0])
    }
    if len(dist_info_roots) != 1:
        raise PluginBundleError(f"wheel {declared.path!r} has inconsistent dist-info")

    metadata_info = by_name[metadata_paths[0]]
    wheel_info = by_name[wheel_paths[0]]
    if (
        metadata_info.file_size > MAX_MANIFEST_BYTES
        or wheel_info.file_size > MAX_MANIFEST_BYTES
    ):
        raise PluginBundleError(f"wheel {declared.path!r} metadata is too large")
    metadata = BytesParser(policy=email.policy.compat32).parsebytes(
        archive.read(metadata_info)
    )
    wheel_metadata = BytesParser(policy=email.policy.compat32).parsebytes(
        archive.read(wheel_info)
    )
    package = metadata.get("Name")
    version = metadata.get("Version")
    if not isinstance(package, str) or not isinstance(version, str):
        raise PluginBundleError(
            f"wheel {declared.path!r} metadata lacks Name or Version"
        )
    if _normalize_package(package) != _normalize_package(declared.package):
        raise PluginBundleError(
            f"wheel {declared.path!r} declares package {package!r}, "
            f"expected {declared.package!r}"
        )
    if version != declared.version:
        raise PluginBundleError(
            f"wheel {declared.path!r} declares version {version!r}, "
            f"expected {declared.version!r}"
        )
    wheel_version = wheel_metadata.get("Wheel-Version")
    tags = tuple(wheel_metadata.get_all("Tag", []))
    if (
        not isinstance(wheel_version, str)
        or not wheel_version.startswith("1.")
        or not tags
    ):
        raise PluginBundleError(f"wheel {declared.path!r} has invalid WHEEL metadata")
    requires_python = metadata.get("Requires-Python")
    if requires_python is not None and not isinstance(requires_python, str):
        raise PluginBundleError(f"wheel {declared.path!r} has invalid Requires-Python")
    return WheelMetadata(
        package=package,
        version=version,
        requires_python=requires_python,
        tags=tags,
        uncompressed_size=sum(info.file_size for info in infos),
    )


def audit_wheel(path: Path | str, declared: BundleWheel) -> WheelMetadata:
    wheel_path = Path(path)
    try:
        stat_result = wheel_path.stat()
    except OSError as exc:
        raise PluginBundleError(
            f"unable to inspect wheel {declared.path!r}: {exc}"
        ) from exc
    if (
        stat_result.st_size != declared.size
        or sha256_file(wheel_path) != declared.sha256
    ):
        raise PluginBundleError(
            f"wheel {declared.path!r} failed SHA-256 or size verification"
        )
    try:
        with zipfile.ZipFile(wheel_path, "r") as archive:
            return _parse_wheel_metadata(archive, declared)
    except (OSError, zipfile.BadZipFile, RuntimeError) as exc:
        if isinstance(exc, PluginBundleError):
            raise
        raise PluginBundleError(f"wheel {declared.path!r} is invalid: {exc}") from exc


def _audit_nested_wheel(
    bundle: zipfile.ZipFile,
    wheel: BundleWheel,
) -> WheelMetadata:
    try:
        with bundle.open(wheel.path, "r") as nested:
            with zipfile.ZipFile(nested, "r") as wheel_archive:
                return _parse_wheel_metadata(wheel_archive, wheel)
    except (OSError, zipfile.BadZipFile, RuntimeError) as exc:
        if isinstance(exc, PluginBundleError):
            raise
        raise PluginBundleError(f"wheel {wheel.path!r} is invalid: {exc}") from exc


def verify_plugin_bundle(
    path: Path | str,
    *,
    expected_sha256: str | None,
) -> VerifiedBundle:
    bundle_path = Path(path).expanduser().resolve(strict=False)
    if bundle_path.suffix.lower() != BUNDLE_EXTENSION:
        raise PluginBundleError(
            f"plugin bundle must use the {BUNDLE_EXTENSION} extension"
        )
    if expected_sha256 is None:
        raise PluginBundleError(
            "installing a plugin bundle requires an expected SHA-256 digest"
        )
    expected = normalize_expected_sha256(expected_sha256)

    try:
        with bundle_path.open("rb") as bundle_file:
            size = os.fstat(bundle_file.fileno()).st_size
            if size <= 0 or size > MAX_BUNDLE_BYTES:
                raise PluginBundleError(
                    f"plugin bundle must be 1 to {MAX_BUNDLE_BYTES} bytes"
                )
            actual_sha256, streamed_bundle_size = _sha256_stream(bundle_file)
            if streamed_bundle_size != size:
                raise PluginBundleError("plugin bundle changed while it was being read")
            if actual_sha256 != expected:
                raise PluginBundleError(
                    f"plugin bundle SHA-256 mismatch: expected {expected}, got {actual_sha256}"
                )
            bundle_file.seek(0)
            with zipfile.ZipFile(bundle_file, "r") as archive:
                by_name = _validate_zip_infos(
                    archive.infolist(),
                    label="plugin bundle",
                    max_entries=MAX_ARCHIVE_ENTRIES,
                    max_total_size=MAX_BUNDLE_BYTES,
                )
                manifest_info = by_name.get(MANIFEST_PATH)
                if manifest_info is None:
                    raise PluginBundleError(f"plugin bundle is missing {MANIFEST_PATH}")
                if manifest_info.file_size > MAX_MANIFEST_BYTES:
                    raise PluginBundleError(
                        "plugin bundle manifest exceeds the size limit"
                    )
                manifest_bytes = archive.read(manifest_info)
                manifest = parse_bundle_manifest(
                    _decode_json(manifest_bytes, "plugin manifest")
                )
                expected_entries = {
                    MANIFEST_PATH,
                    *(wheel.path for wheel in manifest.wheels),
                }
                actual_entries = set(by_name)
                if actual_entries != expected_entries:
                    extras = sorted(actual_entries - expected_entries)
                    missing = sorted(expected_entries - actual_entries)
                    raise PluginBundleError(
                        "plugin bundle entries do not match its manifest",
                        runtime_id=manifest.runtime_id,
                        details={"extra": extras, "missing": missing},
                    )
                total_wheel_uncompressed = 0
                for wheel in manifest.wheels:
                    info = by_name[wheel.path]
                    if info.file_size != wheel.size:
                        raise PluginBundleError(
                            f"wheel {wheel.path!r} size does not match its manifest"
                        )
                    with archive.open(info, "r") as stream:
                        digest, streamed_size = _sha256_stream(stream)
                    if streamed_size != wheel.size or digest != wheel.sha256:
                        raise PluginBundleError(
                            f"wheel {wheel.path!r} failed SHA-256 verification"
                        )
                    metadata = _audit_nested_wheel(archive, wheel)
                    total_wheel_uncompressed += metadata.uncompressed_size
                    if total_wheel_uncompressed > MAX_TOTAL_WHEEL_UNCOMPRESSED_BYTES:
                        raise PluginBundleError(
                            "bundled wheels exceed the total installed-size safety limit"
                        )
    except PluginBundleError:
        raise
    except OSError as exc:
        raise PluginBundleError(f"unable to read plugin bundle: {exc}") from exc
    except (zipfile.BadZipFile, RuntimeError) as exc:
        raise PluginBundleError(
            f"plugin bundle is not a valid ZIP archive: {exc}"
        ) from exc

    return VerifiedBundle(
        path=bundle_path,
        sha256=actual_sha256,
        size=size,
        manifest_sha256=f"sha256:{hashlib.sha256(manifest_bytes).hexdigest()}",
        manifest=manifest,
    )


def inspect_plugin_bundle(path: Path | str) -> VerifiedBundle:
    """Inspect a local bundle while explicitly reporting its unpinned digest."""

    bundle_path = Path(path).expanduser().resolve(strict=False)
    actual = sha256_file(bundle_path)
    return verify_plugin_bundle(bundle_path, expected_sha256=actual)


def _read_template(path: Path) -> dict[str, Any]:
    try:
        data = path.read_bytes()
    except OSError as exc:
        raise PluginBundleError(
            f"unable to read bundle manifest template: {exc}"
        ) from exc
    if len(data) > MAX_MANIFEST_BYTES:
        raise PluginBundleError("bundle manifest template exceeds the size limit")
    return dict(_mapping(_decode_json(data, "bundle manifest template"), "manifest"))


def _zip_info(name: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_STORED
    info.create_system = 3
    info.external_attr = (stat.S_IFREG | 0o644) << 16
    return info


def _write_stored_file(
    archive: zipfile.ZipFile,
    archive_path: str,
    source_path: Path,
) -> None:
    with (
        source_path.open("rb") as source,
        archive.open(_zip_info(archive_path), "w", force_zip64=True) as output,
    ):
        for chunk in iter(lambda: source.read(COPY_CHUNK_BYTES), b""):
            output.write(chunk)


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


def build_plugin_bundle(
    manifest_template: Path | str,
    wheel_paths: Sequence[Path | str],
    output_path: Path | str,
    *,
    force: bool = False,
) -> VerifiedBundle:
    template_path = Path(manifest_template).expanduser().resolve(strict=False)
    output = Path(output_path).expanduser().resolve(strict=False)
    if output.suffix.lower() != BUNDLE_EXTENSION:
        raise PluginBundleError(
            f"bundle output must use the {BUNDLE_EXTENSION} extension"
        )
    if output.exists() and not force:
        raise PluginBundleError(f"bundle output already exists: {output}")

    wheel_files: dict[str, Path] = {}
    for raw_path in wheel_paths:
        wheel_path = Path(raw_path).expanduser().resolve(strict=False)
        key = wheel_path.name.casefold()
        if key in wheel_files:
            raise PluginBundleError(
                f"duplicate input wheel filename: {wheel_path.name}"
            )
        if not wheel_path.is_file() or wheel_path.suffix != ".whl":
            raise PluginBundleError(f"input is not a wheel file: {wheel_path}")
        wheel_files[key] = wheel_path

    root = _read_template(template_path)
    raw_wheels = _sequence(root.get("wheels"), "manifest.wheels")
    populated: list[dict[str, Any]] = []
    used_files: set[str] = set()
    for index, raw_wheel in enumerate(raw_wheels):
        label = f"manifest.wheels[{index}]"
        wheel = _mapping(raw_wheel, label)
        _only_keys(wheel, {"path", "package", "version", "sha256", "size"}, label)
        archive_path = _string(wheel.get("path"), f"{label}.path", max_length=255)
        filename = PurePosixPath(archive_path).name
        local_path = wheel_files.get(filename.casefold())
        if local_path is None:
            raise PluginBundleError(f"no input wheel supplied for {archive_path!r}")
        if local_path.name != filename:
            raise PluginBundleError(
                f"input wheel filename case does not match manifest: {filename!r}"
            )
        used_files.add(filename.casefold())
        try:
            wheel_size = local_path.stat().st_size
        except OSError as exc:
            raise PluginBundleError(
                f"unable to inspect input wheel {local_path.name!r}: {exc}"
            ) from exc
        populated.append(
            {
                "path": archive_path,
                "package": wheel.get("package"),
                "version": wheel.get("version"),
                "sha256": sha256_file(local_path),
                "size": wheel_size,
            }
        )
    unused = sorted(
        path.name for key, path in wheel_files.items() if key not in used_files
    )
    if unused:
        raise PluginBundleError(
            f"input wheels are not declared by the manifest: {unused}"
        )
    root["wheels"] = populated
    manifest = parse_bundle_manifest(root)
    for wheel in manifest.wheels:
        audit_wheel(wheel_files[PurePosixPath(wheel.path).name.casefold()], wheel)

    try:
        output.parent.mkdir(parents=True, exist_ok=True)
        temporary_handle = tempfile.NamedTemporaryFile(
            mode="wb",
            prefix=f".{output.name}.",
            suffix=f".part{BUNDLE_EXTENSION}",
            dir=output.parent,
            delete=False,
        )
    except OSError as exc:
        raise PluginBundleError(f"unable to prepare bundle output: {exc}") from exc
    temporary = Path(temporary_handle.name)
    temporary_handle.close()
    try:
        with zipfile.ZipFile(temporary, "w", allowZip64=True) as archive:
            archive.writestr(
                _zip_info(MANIFEST_PATH), _canonical_json_bytes(manifest.to_wire())
            )
            for wheel in sorted(manifest.wheels, key=lambda item: item.path):
                _write_stored_file(
                    archive,
                    wheel.path,
                    wheel_files[PurePosixPath(wheel.path).name.casefold()],
                )
        with temporary.open("r+b") as handle:
            handle.flush()
            os.fsync(handle.fileno())
        inspect_plugin_bundle(temporary)
        if output.exists() and not force:
            raise PluginBundleError(f"bundle output already exists: {output}")
        _replace_file(temporary, output)
        _fsync_directory(output.parent)
    except PluginBundleError:
        raise
    except (OSError, zipfile.BadZipFile, RuntimeError) as exc:
        raise PluginBundleError(f"unable to build plugin bundle: {exc}") from exc
    finally:
        try:
            temporary.unlink()
        except OSError:
            pass
    return inspect_plugin_bundle(output)
