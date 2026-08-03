"""Signed schema and immutable records for Host-managed language runtimes."""

from __future__ import annotations

import base64
import binascii
import hashlib
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlsplit

from candlescope_plugin_sdk.platform_v2 import (
    JsonLimits,
    PlatformContractError,
    canonical_dumps,
    loads_strict,
)
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .errors import RuntimeRegistryError, registry_error


ROOTS_SCHEMA_VERSION = 1
REGISTRY_SCHEMA_VERSION = 1
REGISTRY_SCHEMA_ID = "candlescope.runtime-registry/1"
STATE_SCHEMA_VERSION = 1
SYSTEM_REGISTRY_SCHEMA_VERSION = 1
RUNTIME_KINDS = frozenset({"java", "node", "wasm"})
ARCHIVE_FORMATS = frozenset({"tar.gz", "zip"})
EVIDENCE_ROLES = frozenset(
    {"vendor-checksum", "vendor-metadata", "vendor-sbom", "vendor-signature"}
)
MAX_ROOTS_BYTES = 128 * 1024
MAX_REGISTRY_BYTES = 4 * 1024 * 1024
MAX_RUNTIME_ARCHIVE_BYTES = 1024 * 1024 * 1024
MAX_EXTRACTED_BYTES = 4 * 1024 * 1024 * 1024
MAX_ARCHIVE_FILES = 100_000
MAX_EVIDENCE_BYTES = 32 * 1024 * 1024
MAX_PROBE_SECONDS = 30

_ID = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$")
_SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
_KEY_ID = re.compile(r"^ed25519:[0-9a-f]{64}$")
_SPDX = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.+() -]{0,254}$")
_RELATIVE_PATH = re.compile(r"^[^\\\x00\r\n:]+$")
_JSON_LIMITS = JsonLimits(
    max_message_bytes=MAX_REGISTRY_BYTES,
    max_depth=32,
    max_container_items=200_000,
    max_string_bytes=2 * 1024 * 1024,
)


def _mapping(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_SCHEMA_INVALID",
            f"{label} must be a JSON object",
        )
    return value


def _sequence(
    value: Any,
    label: str,
    *,
    maximum: int,
) -> Sequence[Any]:
    if (
        not isinstance(value, Sequence)
        or isinstance(value, (str, bytes, bytearray))
        or len(value) > maximum
    ):
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_SCHEMA_INVALID",
            f"{label} must be a bounded JSON array",
        )
    return value


def _only_keys(
    value: Mapping[str, Any],
    required: set[str],
    label: str,
    *,
    optional: set[str] | None = None,
) -> None:
    optional = optional or set()
    if not required.issubset(value) or not set(value).issubset(required | optional):
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_SCHEMA_INVALID",
            f"{label} fields do not match the signed schema",
            details={
                "missing": sorted(required - set(value)),
                "unknown": sorted(set(value) - required - optional),
            },
        )


def _string(value: Any, label: str, *, maximum: int = 512) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or len(value) > maximum
        or "\x00" in value
        or "\r" in value
        or "\n" in value
    ):
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_SCHEMA_INVALID",
            f"{label} must be a bounded canonical string",
        )
    return value


def _identifier(value: Any, label: str) -> str:
    result = _string(value, label, maximum=128)
    if _ID.fullmatch(result) is None:
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_SCHEMA_INVALID",
            f"{label} must be a canonical identifier",
        )
    return result


def _sha256(value: Any, label: str) -> str:
    result = _string(value, label, maximum=71)
    if _SHA256.fullmatch(result) is None:
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_SCHEMA_INVALID",
            f"{label} must be a lowercase prefixed SHA-256",
        )
    return result


def _positive_int(value: Any, label: str, *, maximum: int) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not 0 < value <= maximum
    ):
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_SCHEMA_INVALID",
            f"{label} must be a bounded positive integer",
        )
    return value


def _utc_timestamp(value: Any, label: str) -> str:
    raw = _string(value, label, maximum=64)
    if not raw.endswith("Z"):
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_SCHEMA_INVALID",
            f"{label} must use canonical UTC Z form",
        )
    try:
        parsed = datetime.fromisoformat(raw[:-1] + "+00:00")
    except ValueError as exc:
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_SCHEMA_INVALID",
            f"{label} is not a valid UTC timestamp",
        ) from exc
    if parsed.tzinfo != UTC or parsed.isoformat().replace("+00:00", "Z") != raw:
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_SCHEMA_INVALID",
            f"{label} is not a canonical UTC timestamp",
        )
    return raw


def _relative_path(value: Any, label: str) -> str:
    raw = _string(value, label, maximum=512)
    parts = raw.split("/")
    if (
        _RELATIVE_PATH.fullmatch(raw) is None
        or raw.startswith("/")
        or raw.endswith("/")
        or any(part in {"", ".", ".."} for part in parts)
    ):
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_SCHEMA_INVALID",
            f"{label} must be a canonical relative path",
        )
    return raw


def _https_url(value: Any, label: str, allowed_origins: frozenset[str]) -> str:
    raw = _string(value, label, maximum=2048)
    parsed = urlsplit(raw)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or not parsed.path.startswith("/")
        or "\\" in parsed.path
        or origin not in allowed_origins
    ):
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_URL_INVALID",
            f"{label} must use a root-approved HTTPS origin",
        )
    return raw


def _decode_base64url(value: Any, *, label: str, expected_size: int) -> bytes:
    raw = _string(value, label, maximum=256)
    if "=" in raw:
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_SIGNATURE_INVALID",
            f"{label} must be unpadded base64url",
        )
    try:
        decoded = base64.urlsafe_b64decode(raw + ("=" * (-len(raw) % 4)))
    except (ValueError, binascii.Error) as exc:
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_SIGNATURE_INVALID",
            f"{label} is not valid base64url",
        ) from exc
    if (
        len(decoded) != expected_size
        or base64.urlsafe_b64encode(decoded).rstrip(b"=").decode("ascii") != raw
    ):
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_SIGNATURE_INVALID",
            f"{label} has a non-canonical encoding",
        )
    return decoded


def encode_base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def key_id(public_key: bytes) -> str:
    if not isinstance(public_key, bytes) or len(public_key) != 32:
        raise ValueError("Ed25519 public keys must contain exactly 32 bytes")
    return f"ed25519:{hashlib.sha256(public_key).hexdigest()}"


def canonical_bytes(value: Any) -> bytes:
    return canonical_dumps(value).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


@dataclass(frozen=True, slots=True)
class RuntimeRegistryRoot:
    registry_id: str
    key_id: str
    public_key: bytes
    source_origins: frozenset[str]
    enabled: bool

    def __post_init__(self) -> None:
        if _ID.fullmatch(self.registry_id) is None:
            raise ValueError("registry_id is invalid")
        if (
            _KEY_ID.fullmatch(self.key_id) is None
            or key_id(self.public_key) != self.key_id
        ):
            raise ValueError("runtime registry root key is invalid")
        if not self.source_origins:
            raise ValueError("runtime registry root must approve at least one origin")


@dataclass(frozen=True, slots=True)
class RuntimeEvidence:
    role: str
    url: str
    sha256: str
    size: int
    file_name: str

    def to_wire(self) -> dict[str, Any]:
        return {
            "role": self.role,
            "url": self.url,
            "sha256": self.sha256,
            "size": self.size,
            "fileName": self.file_name,
        }


@dataclass(frozen=True, slots=True)
class RuntimeLicenseFile:
    path: str
    sha256: str
    size: int

    def to_wire(self) -> dict[str, Any]:
        return {"path": self.path, "sha256": self.sha256, "size": self.size}


@dataclass(frozen=True, slots=True)
class RuntimeProbe:
    argv: tuple[str, ...]
    expected_exit_code: int
    stdout_regex: str
    stderr_regex: str
    timeout_seconds: int

    def to_wire(self) -> dict[str, Any]:
        return {
            "argv": list(self.argv),
            "expectedExitCode": self.expected_exit_code,
            "stdoutRegex": self.stdout_regex,
            "stderrRegex": self.stderr_regex,
            "timeoutSeconds": self.timeout_seconds,
        }


@dataclass(frozen=True, slots=True)
class RuntimeRelease:
    runtime_id: str
    kind: str
    version: str
    operating_system: str
    architecture: str
    url: str
    sha256: str
    size: int
    archive_format: str
    strip_prefix: str
    executable: str
    extracted_size: int
    file_count: int
    license_spdx: str
    license_name: str
    license_url: str
    legal_directory: str
    legal_file_count: int
    legal_size: int
    license_files: tuple[RuntimeLicenseFile, ...]
    evidence: tuple[RuntimeEvidence, ...]
    probe: RuntimeProbe
    upstream_release_url: str
    upstream_scm_ref: str
    upstream_build_ref: str

    @property
    def key(self) -> tuple[str, str, str, str]:
        return (
            self.runtime_id,
            self.kind,
            self.operating_system,
            self.architecture,
        )

    def to_public_wire(self) -> dict[str, Any]:
        return {
            "runtimeId": self.runtime_id,
            "kind": self.kind,
            "version": self.version,
            "os": self.operating_system,
            "arch": self.architecture,
            "sourceUrl": self.url,
            "sha256": self.sha256,
            "size": self.size,
            "license": self.license_spdx,
            "upstreamReleaseUrl": self.upstream_release_url,
        }


@dataclass(frozen=True, slots=True)
class RuntimeRevocation:
    sha256: str
    reason: str
    revoked_at: str

    def to_wire(self) -> dict[str, str]:
        return {
            "sha256": self.sha256,
            "reason": self.reason,
            "revokedAt": self.revoked_at,
        }


@dataclass(frozen=True, slots=True)
class VerifiedRuntimeRegistry:
    registry_id: str
    revision: int
    issued_at: str
    previous_registry_sha256: str | None
    automatic_network_updates: bool
    runtimes: tuple[RuntimeRelease, ...]
    revocations: tuple[RuntimeRevocation, ...]
    signature: dict[str, str]
    sha256: str
    canonical_document: bytes

    def by_key(self) -> dict[tuple[str, str, str, str], RuntimeRelease]:
        return {item.key: item for item in self.runtimes}


def load_runtime_registry_roots_bytes(data: bytes) -> tuple[RuntimeRegistryRoot, ...]:
    if not 0 < len(data) <= MAX_ROOTS_BYTES:
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_ROOTS_INVALID",
            "runtime registry roots document has an invalid size",
        )
    try:
        value = loads_strict(data, limits=_JSON_LIMITS)
    except PlatformContractError as exc:
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_ROOTS_INVALID",
            "runtime registry roots document is not strict JSON",
        ) from exc
    root = _mapping(value, "runtime registry roots")
    _only_keys(root, {"schemaVersion", "registries"}, "runtime registry roots")
    if root["schemaVersion"] != ROOTS_SCHEMA_VERSION:
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_ROOTS_INVALID",
            "runtime registry roots schemaVersion is unsupported",
        )
    values: list[RuntimeRegistryRoot] = []
    for index, raw in enumerate(
        _sequence(root["registries"], "runtime registry roots.registries", maximum=32)
    ):
        label = f"runtime registry roots.registries[{index}]"
        item = _mapping(raw, label)
        _only_keys(
            item,
            {"registryId", "keyId", "publicKey", "sourceOrigins", "enabled"},
            label,
        )
        registry_id = _identifier(item["registryId"], f"{label}.registryId")
        key_identity = _string(item["keyId"], f"{label}.keyId", maximum=72)
        if _KEY_ID.fullmatch(key_identity) is None:
            raise registry_error(
                "PLUGIN_RUNTIME_REGISTRY_ROOTS_INVALID",
                f"{label}.keyId is invalid",
            )
        public_key = _decode_base64url(
            item["publicKey"], label=f"{label}.publicKey", expected_size=32
        )
        if key_id(public_key) != key_identity:
            raise registry_error(
                "PLUGIN_RUNTIME_REGISTRY_ROOTS_INVALID",
                f"{label} public key does not match keyId",
            )
        origins: list[str] = []
        for origin_index, origin_value in enumerate(
            _sequence(item["sourceOrigins"], f"{label}.sourceOrigins", maximum=16)
        ):
            origin_label = f"{label}.sourceOrigins[{origin_index}]"
            origin = _string(origin_value, origin_label, maximum=512)
            parsed = urlsplit(origin)
            if (
                parsed.scheme != "https"
                or not parsed.hostname
                or parsed.username is not None
                or parsed.password is not None
                or parsed.path not in {"", "/"}
                or parsed.query
                or parsed.fragment
                or origin.endswith("/")
            ):
                raise registry_error(
                    "PLUGIN_RUNTIME_REGISTRY_ROOTS_INVALID",
                    f"{origin_label} must be an HTTPS origin",
                )
            origins.append(origin)
        if origins != sorted(set(origins)) or not origins:
            raise registry_error(
                "PLUGIN_RUNTIME_REGISTRY_ROOTS_INVALID",
                f"{label}.sourceOrigins must be sorted and unique",
            )
        if not isinstance(item["enabled"], bool):
            raise registry_error(
                "PLUGIN_RUNTIME_REGISTRY_ROOTS_INVALID",
                f"{label}.enabled must be a boolean",
            )
        values.append(
            RuntimeRegistryRoot(
                registry_id,
                key_identity,
                public_key,
                frozenset(origins),
                item["enabled"],
            )
        )
    identities = [(item.registry_id, item.key_id) for item in values]
    if identities != sorted(identities) or len(set(identities)) != len(identities):
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_ROOTS_INVALID",
            "runtime registry roots must be registry/key-sorted and unique",
        )
    return tuple(values)


def _parse_evidence(
    value: Any,
    label: str,
    *,
    allowed_origins: frozenset[str],
) -> RuntimeEvidence:
    item = _mapping(value, label)
    _only_keys(item, {"role", "url", "sha256", "size", "fileName"}, label)
    role = _string(item["role"], f"{label}.role", maximum=32)
    if role not in EVIDENCE_ROLES:
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_SCHEMA_INVALID",
            f"{label}.role is unsupported",
        )
    file_name = _string(item["fileName"], f"{label}.fileName", maximum=256)
    if "/" in file_name or "\\" in file_name or file_name in {".", ".."}:
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_SCHEMA_INVALID",
            f"{label}.fileName is invalid",
        )
    return RuntimeEvidence(
        role,
        _https_url(item["url"], f"{label}.url", allowed_origins),
        _sha256(item["sha256"], f"{label}.sha256"),
        _positive_int(item["size"], f"{label}.size", maximum=MAX_EVIDENCE_BYTES),
        file_name,
    )


def _parse_license_file(value: Any, label: str) -> RuntimeLicenseFile:
    item = _mapping(value, label)
    _only_keys(item, {"path", "sha256", "size"}, label)
    return RuntimeLicenseFile(
        _relative_path(item["path"], f"{label}.path"),
        _sha256(item["sha256"], f"{label}.sha256"),
        _positive_int(item["size"], f"{label}.size", maximum=16 * 1024 * 1024),
    )


def _parse_probe(value: Any, label: str, *, executable: str) -> RuntimeProbe:
    item = _mapping(value, label)
    _only_keys(
        item,
        {
            "argv",
            "expectedExitCode",
            "stdoutRegex",
            "stderrRegex",
            "timeoutSeconds",
        },
        label,
    )
    raw_argv = _sequence(item["argv"], f"{label}.argv", maximum=32)
    argv = tuple(
        _relative_path(raw, f"{label}.argv[{index}]")
        if index == 0
        else _string(raw, f"{label}.argv[{index}]", maximum=1024)
        for index, raw in enumerate(raw_argv)
    )
    if not argv or argv[0] != executable:
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_SCHEMA_INVALID",
            f"{label}.argv must start with the declared executable",
        )
    exit_code = item["expectedExitCode"]
    if (
        isinstance(exit_code, bool)
        or not isinstance(exit_code, int)
        or not -255 <= exit_code <= 255
    ):
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_SCHEMA_INVALID",
            f"{label}.expectedExitCode is invalid",
        )
    stdout_regex = _string(item["stdoutRegex"], f"{label}.stdoutRegex", maximum=2048)
    stderr_regex = _string(item["stderrRegex"], f"{label}.stderrRegex", maximum=2048)
    try:
        re.compile(stdout_regex)
        re.compile(stderr_regex)
    except re.error as exc:
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_SCHEMA_INVALID",
            f"{label} contains an invalid probe regex",
        ) from exc
    return RuntimeProbe(
        argv,
        exit_code,
        stdout_regex,
        stderr_regex,
        _positive_int(
            item["timeoutSeconds"],
            f"{label}.timeoutSeconds",
            maximum=MAX_PROBE_SECONDS,
        ),
    )


def _parse_release(
    value: Any,
    label: str,
    *,
    allowed_origins: frozenset[str],
) -> RuntimeRelease:
    item = _mapping(value, label)
    _only_keys(
        item,
        {
            "id",
            "kind",
            "version",
            "os",
            "arch",
            "url",
            "sha256",
            "size",
            "archive",
            "stripPrefix",
            "executable",
            "extractedSize",
            "fileCount",
            "license",
            "licenseFiles",
            "evidence",
            "probe",
            "upstream",
        },
        label,
    )
    runtime_id = _identifier(item["id"], f"{label}.id")
    kind = _string(item["kind"], f"{label}.kind", maximum=16)
    if kind not in RUNTIME_KINDS:
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_SCHEMA_INVALID",
            f"{label}.kind is unsupported",
        )
    archive_format = _string(item["archive"], f"{label}.archive", maximum=16)
    if archive_format not in ARCHIVE_FORMATS:
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_SCHEMA_INVALID",
            f"{label}.archive is unsupported",
        )
    executable = _relative_path(item["executable"], f"{label}.executable")
    license_value = _mapping(item["license"], f"{label}.license")
    _only_keys(
        license_value,
        {
            "spdx",
            "name",
            "url",
            "legalDirectory",
            "legalFileCount",
            "legalSize",
        },
        f"{label}.license",
    )
    spdx = _string(license_value["spdx"], f"{label}.license.spdx", maximum=255)
    if _SPDX.fullmatch(spdx) is None:
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_SCHEMA_INVALID",
            f"{label}.license.spdx is invalid",
        )
    legal_directory = _relative_path(
        license_value["legalDirectory"], f"{label}.license.legalDirectory"
    )
    license_files = tuple(
        _parse_license_file(raw, f"{label}.licenseFiles[{index}]")
        for index, raw in enumerate(
            _sequence(item["licenseFiles"], f"{label}.licenseFiles", maximum=512)
        )
    )
    license_paths = [entry.path for entry in license_files]
    if (
        not license_files
        or license_paths != sorted(license_paths)
        or len(set(path.casefold() for path in license_paths)) != len(license_paths)
    ):
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_SCHEMA_INVALID",
            f"{label}.licenseFiles must be path-sorted and unique",
        )
    evidence = tuple(
        _parse_evidence(
            raw,
            f"{label}.evidence[{index}]",
            allowed_origins=allowed_origins,
        )
        for index, raw in enumerate(
            _sequence(item["evidence"], f"{label}.evidence", maximum=32)
        )
    )
    evidence_roles = [entry.role for entry in evidence]
    if (
        evidence_roles != sorted(EVIDENCE_ROLES)
        or len(evidence_roles) != len(EVIDENCE_ROLES)
        or len({entry.sha256 for entry in evidence}) != len(evidence)
    ):
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_SCHEMA_INVALID",
            f"{label}.evidence must contain each required role exactly once in role order",
        )
    upstream = _mapping(item["upstream"], f"{label}.upstream")
    _only_keys(
        upstream,
        {"releaseUrl", "scmRef", "buildRef"},
        f"{label}.upstream",
    )
    probe = _parse_probe(item["probe"], f"{label}.probe", executable=executable)
    return RuntimeRelease(
        runtime_id=runtime_id,
        kind=kind,
        version=_string(item["version"], f"{label}.version", maximum=128),
        operating_system=_identifier(item["os"], f"{label}.os"),
        architecture=_identifier(item["arch"], f"{label}.arch"),
        url=_https_url(item["url"], f"{label}.url", allowed_origins),
        sha256=_sha256(item["sha256"], f"{label}.sha256"),
        size=_positive_int(
            item["size"], f"{label}.size", maximum=MAX_RUNTIME_ARCHIVE_BYTES
        ),
        archive_format=archive_format,
        strip_prefix=_relative_path(item["stripPrefix"], f"{label}.stripPrefix"),
        executable=executable,
        extracted_size=_positive_int(
            item["extractedSize"],
            f"{label}.extractedSize",
            maximum=MAX_EXTRACTED_BYTES,
        ),
        file_count=_positive_int(
            item["fileCount"], f"{label}.fileCount", maximum=MAX_ARCHIVE_FILES
        ),
        license_spdx=spdx,
        license_name=_string(
            license_value["name"], f"{label}.license.name", maximum=256
        ),
        license_url=_https_url(
            license_value["url"], f"{label}.license.url", allowed_origins
        ),
        legal_directory=legal_directory,
        legal_file_count=_positive_int(
            license_value["legalFileCount"],
            f"{label}.license.legalFileCount",
            maximum=MAX_ARCHIVE_FILES,
        ),
        legal_size=_positive_int(
            license_value["legalSize"],
            f"{label}.license.legalSize",
            maximum=MAX_EXTRACTED_BYTES,
        ),
        license_files=license_files,
        evidence=evidence,
        probe=probe,
        upstream_release_url=_https_url(
            upstream["releaseUrl"], f"{label}.upstream.releaseUrl", allowed_origins
        ),
        upstream_scm_ref=_string(
            upstream["scmRef"], f"{label}.upstream.scmRef", maximum=256
        ),
        upstream_build_ref=_https_url(
            upstream["buildRef"], f"{label}.upstream.buildRef", allowed_origins
        ),
    )


def _parse_revocation(value: Any, label: str) -> RuntimeRevocation:
    item = _mapping(value, label)
    _only_keys(item, {"sha256", "reason", "revokedAt"}, label)
    return RuntimeRevocation(
        _sha256(item["sha256"], f"{label}.sha256"),
        _string(item["reason"], f"{label}.reason", maximum=512),
        _utc_timestamp(item["revokedAt"], f"{label}.revokedAt"),
    )


def verify_runtime_registry_bytes(
    data: bytes,
    roots: Sequence[RuntimeRegistryRoot],
) -> VerifiedRuntimeRegistry:
    if not 0 < len(data) <= MAX_REGISTRY_BYTES:
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_SCHEMA_INVALID",
            "runtime registry document has an invalid size",
        )
    canonical_source = data[:-1] if data.endswith(b"\n") else data
    try:
        value = loads_strict(canonical_source, limits=_JSON_LIMITS)
    except PlatformContractError as exc:
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_SCHEMA_INVALID",
            "runtime registry document is not strict JSON",
        ) from exc
    document = _mapping(value, "runtime registry")
    _only_keys(
        document,
        {"schemaVersion", "registry", "runtimes", "revocations", "signature"},
        "runtime registry",
    )
    if document["schemaVersion"] != REGISTRY_SCHEMA_VERSION:
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_SCHEMA_INVALID",
            "runtime registry schemaVersion is unsupported",
        )
    metadata = _mapping(document["registry"], "runtime registry.registry")
    _only_keys(
        metadata,
        {
            "id",
            "revision",
            "issuedAt",
            "previousRegistrySha256",
            "automaticNetworkUpdates",
        },
        "runtime registry.registry",
    )
    registry_id = _identifier(metadata["id"], "runtime registry.registry.id")
    enabled_registry_roots = tuple(
        item for item in roots if item.enabled and item.registry_id == registry_id
    )
    if not enabled_registry_roots:
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_ROOT_UNTRUSTED",
            "runtime registry is not signed by an enabled build-pinned root",
            details={"registryId": registry_id},
        )
    signature = _mapping(document["signature"], "runtime registry.signature")
    _only_keys(signature, {"algorithm", "keyId", "value"}, "runtime registry.signature")
    signature_key_id = _string(
        signature["keyId"], "runtime registry.signature.keyId", maximum=72
    )
    root = next(
        (item for item in enabled_registry_roots if item.key_id == signature_key_id),
        None,
    )
    if signature["algorithm"] != "ed25519" or root is None:
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_KEY_MISMATCH",
            "runtime registry signature key is not build-pinned",
        )
    signature_value = _string(
        signature["value"], "runtime registry.signature.value", maximum=128
    )
    raw_signature = _decode_base64url(
        signature_value,
        label="runtime registry.signature.value",
        expected_size=64,
    )
    revision = _positive_int(
        metadata["revision"], "runtime registry.registry.revision", maximum=2**31 - 1
    )
    previous = metadata["previousRegistrySha256"]
    if previous is not None:
        previous = _sha256(previous, "runtime registry.registry.previousRegistrySha256")
    if (revision == 1) != (previous is None):
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_SCHEMA_INVALID",
            "runtime registry revision and previous digest are inconsistent",
        )
    if metadata["automaticNetworkUpdates"] is not False:
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_SCHEMA_INVALID",
            "signed runtime registries must keep automatic network updates disabled",
        )
    releases = tuple(
        _parse_release(
            raw,
            f"runtime registry.runtimes[{index}]",
            allowed_origins=root.source_origins,
        )
        for index, raw in enumerate(
            _sequence(document["runtimes"], "runtime registry.runtimes", maximum=4096)
        )
    )
    release_keys = [item.key for item in releases]
    if release_keys != sorted(release_keys) or len(set(release_keys)) != len(
        release_keys
    ):
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_SCHEMA_INVALID",
            "runtime releases must be key-sorted and unique",
        )
    revocations = tuple(
        _parse_revocation(raw, f"runtime registry.revocations[{index}]")
        for index, raw in enumerate(
            _sequence(
                document["revocations"], "runtime registry.revocations", maximum=4096
            )
        )
    )
    revoked_digests = [item.sha256 for item in revocations]
    if revoked_digests != sorted(revoked_digests) or len(set(revoked_digests)) != len(
        revoked_digests
    ):
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_SCHEMA_INVALID",
            "runtime revocations must be digest-sorted and unique",
        )
    body = {key: document[key] for key in document if key != "signature"}
    try:
        Ed25519PublicKey.from_public_bytes(root.public_key).verify(
            raw_signature,
            canonical_bytes(body),
        )
    except (InvalidSignature, ValueError) as exc:
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_SIGNATURE_INVALID",
            "runtime registry signature verification failed",
        ) from exc
    canonical_document = canonical_bytes(document)
    if canonical_source != canonical_document:
        raise registry_error(
            "PLUGIN_RUNTIME_REGISTRY_CANONICAL_JSON_REQUIRED",
            "runtime registry document must use canonical JSON encoding",
        )
    return VerifiedRuntimeRegistry(
        registry_id=registry_id,
        revision=revision,
        issued_at=_utc_timestamp(
            metadata["issuedAt"], "runtime registry.registry.issuedAt"
        ),
        previous_registry_sha256=previous,
        automatic_network_updates=False,
        runtimes=releases,
        revocations=revocations,
        signature={
            "algorithm": "ed25519",
            "keyId": root.key_id,
            "value": signature_value,
        },
        sha256=sha256_bytes(canonical_document),
        canonical_document=canonical_document,
    )


def runtime_release_to_wire(release: RuntimeRelease) -> dict[str, Any]:
    """Return the exact signed entry shape for fixtures and gate capture."""

    return {
        "id": release.runtime_id,
        "kind": release.kind,
        "version": release.version,
        "os": release.operating_system,
        "arch": release.architecture,
        "url": release.url,
        "sha256": release.sha256,
        "size": release.size,
        "archive": release.archive_format,
        "stripPrefix": release.strip_prefix,
        "executable": release.executable,
        "extractedSize": release.extracted_size,
        "fileCount": release.file_count,
        "license": {
            "spdx": release.license_spdx,
            "name": release.license_name,
            "url": release.license_url,
            "legalDirectory": release.legal_directory,
            "legalFileCount": release.legal_file_count,
            "legalSize": release.legal_size,
        },
        "licenseFiles": [item.to_wire() for item in release.license_files],
        "evidence": [item.to_wire() for item in release.evidence],
        "probe": release.probe.to_wire(),
        "upstream": {
            "releaseUrl": release.upstream_release_url,
            "scmRef": release.upstream_scm_ref,
            "buildRef": release.upstream_build_ref,
        },
    }


__all__ = [
    "ARCHIVE_FORMATS",
    "EVIDENCE_ROLES",
    "MAX_ARCHIVE_FILES",
    "MAX_EXTRACTED_BYTES",
    "MAX_REGISTRY_BYTES",
    "MAX_RUNTIME_ARCHIVE_BYTES",
    "REGISTRY_SCHEMA_ID",
    "REGISTRY_SCHEMA_VERSION",
    "ROOTS_SCHEMA_VERSION",
    "RUNTIME_KINDS",
    "RuntimeEvidence",
    "RuntimeLicenseFile",
    "RuntimeProbe",
    "RuntimeRegistryError",
    "RuntimeRegistryRoot",
    "RuntimeRelease",
    "RuntimeRevocation",
    "VerifiedRuntimeRegistry",
    "canonical_bytes",
    "encode_base64url",
    "key_id",
    "load_runtime_registry_roots_bytes",
    "runtime_release_to_wire",
    "sha256_bytes",
    "verify_runtime_registry_bytes",
]
