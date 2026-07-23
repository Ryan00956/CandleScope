"""Strict signed index and release contracts for Plugin Marketplace v1."""

from __future__ import annotations

import hashlib
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlsplit

from candlescope_plugin_sdk.platform_v2 import (
    JsonLimits,
    PlatformContractError,
    canonical_dumps,
    loads_strict,
)

from .crypto import (
    ED25519_ALGORITHM,
    decode_base64url,
    key_id,
    validate_key_id,
    verify_ed25519,
)
from .errors import MarketplaceError


ROOTS_SCHEMA_VERSION = 1
INDEX_SCHEMA_VERSION = "candlescope.marketplace-index/1"
MAX_ROOTS_BYTES = 256 * 1024
MAX_INDEX_BYTES = 8 * 1024 * 1024
MAX_PUBLISHERS = 2_000
MAX_RELEASES = 20_000
MAX_REVOCATIONS = 20_000
MAX_ARTIFACT_BYTES = 512 * 1024 * 1024
MAX_INDEX_LIFETIME = timedelta(days=90)
MAX_CLOCK_SKEW = timedelta(minutes=5)
ZERO_SHA256 = "sha256:" + ("0" * 64)

_JSON_LIMITS = JsonLimits(
    max_message_bytes=MAX_INDEX_BYTES,
    max_depth=32,
    max_container_items=200_000,
    max_string_bytes=2 * 1024 * 1024,
)
_ID = re.compile(r"^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$")
_PLUGIN_ID = re.compile(r"^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$")
_SEMVER = re.compile(
    r"^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)"
    r"(?:-(?:0|[1-9]\d*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)"
    r"(?:\.(?:0|[1-9]\d*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)
_SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
_FILE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.cspkg$")
_LICENSE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.+(): /-]{0,255}$")
_REASON = re.compile(r"^[A-Z][A-Z0-9_]{2,63}$")


def _mapping(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_SCHEMA_INVALID",
            f"{label} must be an object",
        )
    return value


def _sequence(value: Any, label: str, *, maximum: int) -> Sequence[Any]:
    if isinstance(value, (str, bytes)) or not isinstance(value, Sequence):
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_SCHEMA_INVALID",
            f"{label} must be an array",
        )
    if len(value) > maximum:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_LIMIT_EXCEEDED",
            f"{label} exceeds its item limit",
        )
    return value


def _only_keys(
    value: Mapping[str, Any],
    expected: set[str],
    label: str,
) -> None:
    if set(value) != expected:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_SCHEMA_INVALID",
            f"{label} fields do not match the signed schema",
            details={
                "missing": sorted(expected - set(value)),
                "unknown": sorted(set(value) - expected),
            },
        )


def _string(value: Any, label: str, *, maximum: int = 512) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or len(value) > maximum
        or "\x00" in value
    ):
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_SCHEMA_INVALID",
            f"{label} must be a bounded non-empty string",
        )
    return value


def _identifier(value: Any, label: str) -> str:
    result = _string(value, label, maximum=128)
    if _ID.fullmatch(result) is None:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_SCHEMA_INVALID",
            f"{label} is not a canonical identifier",
        )
    return result


def _sha256(value: Any, label: str) -> str:
    result = _string(value, label, maximum=71)
    if _SHA256.fullmatch(result) is None:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_SCHEMA_INVALID",
            f"{label} must be a lowercase prefixed SHA-256",
        )
    return result


def _positive_int(value: Any, label: str, *, maximum: int) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not 0 < value <= maximum
    ):
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_SCHEMA_INVALID",
            f"{label} must be a bounded positive integer",
        )
    return value


def _utc_timestamp(value: Any, label: str) -> tuple[str, datetime]:
    raw = _string(value, label, maximum=64)
    if not raw.endswith("Z"):
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_TIMESTAMP_INVALID",
            f"{label} must use canonical UTC Z form",
        )
    try:
        parsed = datetime.fromisoformat(raw[:-1] + "+00:00")
    except ValueError as exc:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_TIMESTAMP_INVALID",
            f"{label} is not a valid timestamp",
        ) from exc
    if parsed.tzinfo != UTC or parsed.isoformat().replace("+00:00", "Z") != raw:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_TIMESTAMP_INVALID",
            f"{label} is not a canonical UTC timestamp",
        )
    return raw, parsed


def _canonical_bytes(value: Any) -> bytes:
    return canonical_dumps(value).encode("utf-8")


def _digest(value: bytes) -> str:
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


def _origin(value: str, label: str) -> str:
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_URL_INVALID",
            f"{label} must be an HTTPS URL without credentials, query, or fragment",
        )
    try:
        port = parsed.port
    except ValueError as exc:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_URL_INVALID",
            f"{label} has an invalid port",
        ) from exc
    if port not in {None, 443}:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_URL_INVALID",
            f"{label} must use the default HTTPS port",
        )
    hostname = parsed.hostname.lower()
    return f"https://{hostname}"


def _artifact_url(value: Any, *, source_origin: str, label: str) -> str:
    raw = _string(value, label, maximum=2048)
    parsed = urlsplit(raw)
    if _origin(raw, label) != source_origin or not parsed.path.startswith("/"):
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_URL_INVALID",
            f"{label} must use the build-pinned marketplace origin",
        )
    if "//" in parsed.path or "\\" in parsed.path:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_URL_INVALID",
            f"{label} contains a non-canonical path",
        )
    return raw


@dataclass(frozen=True, slots=True)
class MarketplaceRoot:
    marketplace_id: str
    index_url: str
    key_id: str
    public_key: bytes
    enabled: bool

    @property
    def source_origin(self) -> str:
        return _origin(self.index_url, "marketplace root indexUrl")

    def to_public_wire(self) -> dict[str, Any]:
        return {
            "marketplaceId": self.marketplace_id,
            "indexUrl": self.index_url,
            "keyId": self.key_id,
            "enabled": self.enabled,
        }


def load_marketplace_roots_bytes(data: bytes) -> tuple[MarketplaceRoot, ...]:
    if not 0 < len(data) <= MAX_ROOTS_BYTES:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_ROOTS_INVALID",
            "marketplace roots document has an invalid size",
        )
    try:
        value = loads_strict(data, limits=_JSON_LIMITS)
    except PlatformContractError as exc:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_ROOTS_INVALID",
            "marketplace roots document is not strict JSON",
        ) from exc
    root = _mapping(value, "marketplace roots")
    _only_keys(root, {"schemaVersion", "marketplaces"}, "marketplace roots")
    if root["schemaVersion"] != ROOTS_SCHEMA_VERSION:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_ROOTS_INVALID",
            "marketplace roots schemaVersion is unsupported",
        )
    values: list[MarketplaceRoot] = []
    for index, raw in enumerate(
        _sequence(root["marketplaces"], "marketplace roots.marketplaces", maximum=32)
    ):
        label = f"marketplace roots.marketplaces[{index}]"
        item = _mapping(raw, label)
        _only_keys(
            item,
            {"marketplaceId", "indexUrl", "keyId", "publicKey", "enabled"},
            label,
        )
        marketplace_id = _identifier(item["marketplaceId"], f"{label}.marketplaceId")
        index_url = _string(item["indexUrl"], f"{label}.indexUrl", maximum=2048)
        _origin(index_url, f"{label}.indexUrl")
        public_key = decode_base64url(
            item["publicKey"],
            label=f"{label}.publicKey",
            expected_size=32,
        )
        expected_key_id = validate_key_id(item["keyId"], label=f"{label}.keyId")
        if key_id(public_key) != expected_key_id:
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_KEY_MISMATCH",
                f"{label} public key does not match keyId",
            )
        if not isinstance(item["enabled"], bool):
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_ROOTS_INVALID",
                f"{label}.enabled must be a boolean",
            )
        values.append(
            MarketplaceRoot(
                marketplace_id,
                index_url,
                expected_key_id,
                public_key,
                item["enabled"],
            )
        )
    identifiers = [item.marketplace_id for item in values]
    if identifiers != sorted(identifiers) or len(set(identifiers)) != len(identifiers):
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_ROOTS_INVALID",
            "marketplace roots must be ID-sorted and unique",
        )
    return tuple(values)


@dataclass(frozen=True, slots=True)
class PublisherRecord:
    publisher_id: str
    display_name: str
    key_id: str
    public_key: bytes
    status: str

    def to_public_wire(self) -> dict[str, Any]:
        return {
            "publisherId": self.publisher_id,
            "displayName": self.display_name,
            "keyId": self.key_id,
            "status": self.status,
        }


@dataclass(frozen=True, slots=True)
class ArtifactRecord:
    file_name: str
    url: str
    sha256: str
    size: int
    manifest_sha256: str
    sbom_sha256: str

    def to_wire(self) -> dict[str, Any]:
        return {
            "fileName": self.file_name,
            "url": self.url,
            "sha256": self.sha256,
            "size": self.size,
            "manifestSha256": self.manifest_sha256,
            "sbomSha256": self.sbom_sha256,
        }


@dataclass(frozen=True, slots=True)
class DependencyRecord:
    name: str
    version: str
    license_expression: str

    def to_wire(self) -> dict[str, str]:
        return {
            "name": self.name,
            "version": self.version,
            "licenseExpression": self.license_expression,
        }


@dataclass(frozen=True, slots=True)
class ReleaseRecord:
    plugin_id: str
    version: str
    publisher_id: str
    artifact: ArtifactRecord
    published_at: str
    license_expression: str
    dependencies: tuple[DependencyRecord, ...]
    sha256_sums: str
    sha256_sums_sha256: str
    signature: dict[str, str]
    log_index: int
    leaf_sha256: str
    previous_record_sha256: str
    record_sha256: str

    @property
    def identity(self) -> tuple[str, str]:
        return self.plugin_id, self.version

    def statement_wire(self) -> dict[str, Any]:
        return {
            "pluginId": self.plugin_id,
            "version": self.version,
            "publisherId": self.publisher_id,
            "artifact": self.artifact.to_wire(),
            "publishedAt": self.published_at,
            "licenseExpression": self.license_expression,
            "dependencies": [item.to_wire() for item in self.dependencies],
            "sha256Sums": self.sha256_sums,
            "sha256SumsSha256": self.sha256_sums_sha256,
        }

    def to_public_wire(self, *, revoked: bool) -> dict[str, Any]:
        return {
            **self.statement_wire(),
            "publisherKeyId": self.signature["keyId"],
            "transparency": {
                "logIndex": self.log_index,
                "leafSha256": self.leaf_sha256,
                "recordSha256": self.record_sha256,
            },
            "revoked": revoked,
        }


@dataclass(frozen=True, slots=True)
class RevocationRecord:
    scope: str
    subject: str
    reason_code: str
    effective_at: str
    effective_datetime: datetime

    def to_wire(self) -> dict[str, str]:
        return {
            "scope": self.scope,
            "subject": self.subject,
            "reasonCode": self.reason_code,
            "effectiveAt": self.effective_at,
        }


@dataclass(frozen=True, slots=True)
class VerifiedMarketplaceIndex:
    marketplace_id: str
    sequence: int
    generated_at: str
    generated_datetime: datetime
    expires_at: str
    expires_datetime: datetime
    previous_index_sha256: str | None
    source_origin: str
    transparency_head_sha256: str
    publishers: tuple[PublisherRecord, ...]
    releases: tuple[ReleaseRecord, ...]
    revocations: tuple[RevocationRecord, ...]
    index_sha256: str
    canonical_bytes: bytes

    def release_by_identity(self) -> dict[tuple[str, str], ReleaseRecord]:
        return {item.identity: item for item in self.releases}

    def release_by_digest(self) -> dict[str, ReleaseRecord]:
        return {item.artifact.sha256: item for item in self.releases}

    def publisher_by_id(self) -> dict[str, PublisherRecord]:
        return {item.publisher_id: item for item in self.publishers}

    def is_revoked(
        self,
        release: ReleaseRecord,
        *,
        now: datetime | None = None,
    ) -> bool:
        current = now or datetime.now(UTC)
        subjects = {
            ("publisher", release.publisher_id),
            ("plugin", release.plugin_id),
            ("release", release.artifact.sha256),
        }
        return any(
            item.effective_datetime <= current
            and (item.scope, item.subject) in subjects
            for item in self.revocations
        )


def _publisher(value: Any, index: int) -> PublisherRecord:
    label = f"marketplace index.publishers[{index}]"
    item = _mapping(value, label)
    _only_keys(
        item,
        {"publisherId", "displayName", "keyId", "publicKey", "status"},
        label,
    )
    publisher_id = _identifier(item["publisherId"], f"{label}.publisherId")
    display_name = _string(item["displayName"], f"{label}.displayName", maximum=128)
    public_key = decode_base64url(
        item["publicKey"],
        label=f"{label}.publicKey",
        expected_size=32,
    )
    expected_key_id = validate_key_id(item["keyId"], label=f"{label}.keyId")
    if key_id(public_key) != expected_key_id:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_KEY_MISMATCH",
            f"{label} public key does not match keyId",
        )
    status = _string(item["status"], f"{label}.status", maximum=16)
    if status != "active":
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_PUBLISHER_INVALID",
            f"{label} has an unsupported publisher status",
        )
    return PublisherRecord(
        publisher_id,
        display_name,
        expected_key_id,
        public_key,
        status,
    )


def _dependency(value: Any, label: str) -> DependencyRecord:
    item = _mapping(value, label)
    _only_keys(item, {"name", "version", "licenseExpression"}, label)
    name = _identifier(item["name"], f"{label}.name")
    version = _string(item["version"], f"{label}.version", maximum=128)
    license_expression = _string(
        item["licenseExpression"],
        f"{label}.licenseExpression",
        maximum=256,
    )
    if _LICENSE.fullmatch(license_expression) is None:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_LICENSE_INVALID",
            f"{label}.licenseExpression is invalid",
        )
    return DependencyRecord(name, version, license_expression)


def _release(
    value: Any,
    index: int,
    *,
    publishers: Mapping[str, PublisherRecord],
    source_origin: str,
    generated_at: datetime,
) -> ReleaseRecord:
    label = f"marketplace index.releases[{index}]"
    item = _mapping(value, label)
    _only_keys(
        item,
        {
            "pluginId",
            "version",
            "publisherId",
            "artifact",
            "publishedAt",
            "licenseExpression",
            "dependencies",
            "sha256Sums",
            "sha256SumsSha256",
            "signature",
            "transparency",
        },
        label,
    )
    plugin_id = _identifier(item["pluginId"], f"{label}.pluginId")
    if _PLUGIN_ID.fullmatch(plugin_id) is None:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_PLUGIN_ID_INVALID",
            f"{label}.pluginId must be a namespaced plugin identifier",
        )
    version = _string(item["version"], f"{label}.version", maximum=64)
    if _SEMVER.fullmatch(version) is None:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_VERSION_INVALID",
            f"{label}.version must be SemVer",
        )
    publisher_id = _identifier(item["publisherId"], f"{label}.publisherId")
    publisher = publishers.get(publisher_id)
    if publisher is None:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_PUBLISHER_INVALID",
            f"{label} references an unknown publisher",
        )
    raw_artifact = _mapping(item["artifact"], f"{label}.artifact")
    _only_keys(
        raw_artifact,
        {
            "fileName",
            "url",
            "sha256",
            "size",
            "manifestSha256",
            "sbomSha256",
        },
        f"{label}.artifact",
    )
    file_name = _string(
        raw_artifact["fileName"],
        f"{label}.artifact.fileName",
        maximum=207,
    )
    if _FILE_NAME.fullmatch(file_name) is None:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_ARTIFACT_INVALID",
            f"{label}.artifact.fileName is invalid",
        )
    artifact = ArtifactRecord(
        file_name,
        _artifact_url(
            raw_artifact["url"],
            source_origin=source_origin,
            label=f"{label}.artifact.url",
        ),
        _sha256(raw_artifact["sha256"], f"{label}.artifact.sha256"),
        _positive_int(
            raw_artifact["size"],
            f"{label}.artifact.size",
            maximum=MAX_ARTIFACT_BYTES,
        ),
        _sha256(
            raw_artifact["manifestSha256"],
            f"{label}.artifact.manifestSha256",
        ),
        _sha256(raw_artifact["sbomSha256"], f"{label}.artifact.sbomSha256"),
    )
    published_at, published_datetime = _utc_timestamp(
        item["publishedAt"],
        f"{label}.publishedAt",
    )
    if published_datetime > generated_at + MAX_CLOCK_SKEW:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_TIMESTAMP_INVALID",
            f"{label}.publishedAt is later than index generation",
        )
    license_expression = _string(
        item["licenseExpression"],
        f"{label}.licenseExpression",
        maximum=256,
    )
    if _LICENSE.fullmatch(license_expression) is None:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_LICENSE_INVALID",
            f"{label}.licenseExpression is invalid",
        )
    dependencies = tuple(
        _dependency(raw, f"{label}.dependencies[{dependency_index}]")
        for dependency_index, raw in enumerate(
            _sequence(
                item["dependencies"],
                f"{label}.dependencies",
                maximum=1_000,
            )
        )
    )
    dependency_keys = [(value.name, value.version) for value in dependencies]
    if dependency_keys != sorted(dependency_keys) or len(set(dependency_keys)) != len(
        dependency_keys
    ):
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_DEPENDENCIES_INVALID",
            f"{label}.dependencies must be identity-sorted and unique",
        )
    sha256_sums = item["sha256Sums"]
    if (
        not isinstance(sha256_sums, str)
        or not sha256_sums
        or len(sha256_sums) > 512
        or "\x00" in sha256_sums
    ):
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_SHA256SUMS_INVALID",
            f"{label}.sha256Sums is invalid",
        )
    expected_sums = f"{artifact.sha256.removeprefix('sha256:')}  {file_name}\n"
    if sha256_sums != expected_sums:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_SHA256SUMS_INVALID",
            f"{label}.sha256Sums does not pin the artifact",
        )
    sha256_sums_sha256 = _sha256(
        item["sha256SumsSha256"],
        f"{label}.sha256SumsSha256",
    )
    if _digest(sha256_sums.encode("utf-8")) != sha256_sums_sha256:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_SHA256SUMS_INVALID",
            f"{label}.sha256Sums digest mismatch",
        )
    signature = _mapping(item["signature"], f"{label}.signature")
    _only_keys(
        signature,
        {"algorithm", "keyId", "value"},
        f"{label}.signature",
    )
    if signature["algorithm"] != ED25519_ALGORITHM:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_SIGNATURE_INVALID",
            f"{label}.signature algorithm is unsupported",
        )
    signature_key_id = validate_key_id(
        signature["keyId"],
        label=f"{label}.signature.keyId",
    )
    if signature_key_id != publisher.key_id:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_KEY_MISMATCH",
            f"{label} signature key does not match the publisher",
        )
    statement = {
        "pluginId": plugin_id,
        "version": version,
        "publisherId": publisher_id,
        "artifact": artifact.to_wire(),
        "publishedAt": published_at,
        "licenseExpression": license_expression,
        "dependencies": [value.to_wire() for value in dependencies],
        "sha256Sums": sha256_sums,
        "sha256SumsSha256": sha256_sums_sha256,
    }
    signature_wire = {
        "algorithm": ED25519_ALGORITHM,
        "keyId": signature_key_id,
        "value": _string(
            signature["value"],
            f"{label}.signature.value",
            maximum=128,
        ),
    }
    verify_ed25519(
        public_key=publisher.public_key,
        expected_key_id=publisher.key_id,
        signature=signature_wire["value"],
        message=_canonical_bytes(statement),
        label=f"{label}.signature",
    )
    transparency = _mapping(item["transparency"], f"{label}.transparency")
    _only_keys(
        transparency,
        {
            "logIndex",
            "leafSha256",
            "previousRecordSha256",
            "recordSha256",
        },
        f"{label}.transparency",
    )
    log_index = _positive_int(
        transparency["logIndex"],
        f"{label}.transparency.logIndex",
        maximum=MAX_RELEASES,
    )
    leaf_sha256 = _sha256(
        transparency["leafSha256"],
        f"{label}.transparency.leafSha256",
    )
    expected_leaf = _digest(
        _canonical_bytes({"statement": statement, "signature": signature_wire})
    )
    if leaf_sha256 != expected_leaf:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_TRANSPARENCY_INVALID",
            f"{label} transparency leaf does not match the signed release",
        )
    previous_record_sha256 = _sha256(
        transparency["previousRecordSha256"],
        f"{label}.transparency.previousRecordSha256",
    )
    record_sha256 = _sha256(
        transparency["recordSha256"],
        f"{label}.transparency.recordSha256",
    )
    expected_record = _digest(
        _canonical_bytes(
            {
                "logIndex": log_index,
                "leafSha256": leaf_sha256,
                "previousRecordSha256": previous_record_sha256,
            }
        )
    )
    if record_sha256 != expected_record:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_TRANSPARENCY_INVALID",
            f"{label} transparency record digest is invalid",
        )
    return ReleaseRecord(
        plugin_id,
        version,
        publisher_id,
        artifact,
        published_at,
        license_expression,
        dependencies,
        sha256_sums,
        sha256_sums_sha256,
        signature_wire,
        log_index,
        leaf_sha256,
        previous_record_sha256,
        record_sha256,
    )


def _revocation(value: Any, index: int, generated_at: datetime) -> RevocationRecord:
    label = f"marketplace index.revocations[{index}]"
    item = _mapping(value, label)
    _only_keys(item, {"scope", "subject", "reasonCode", "effectiveAt"}, label)
    scope = _string(item["scope"], f"{label}.scope", maximum=16)
    if scope not in {"publisher", "plugin", "release"}:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_REVOCATION_INVALID",
            f"{label}.scope is unsupported",
        )
    subject = (
        _sha256(item["subject"], f"{label}.subject")
        if scope == "release"
        else _identifier(item["subject"], f"{label}.subject")
    )
    reason_code = _string(item["reasonCode"], f"{label}.reasonCode", maximum=64)
    if _REASON.fullmatch(reason_code) is None:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_REVOCATION_INVALID",
            f"{label}.reasonCode is invalid",
        )
    effective_at, effective_datetime = _utc_timestamp(
        item["effectiveAt"],
        f"{label}.effectiveAt",
    )
    if effective_datetime > generated_at + MAX_CLOCK_SKEW:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_REVOCATION_INVALID",
            f"{label}.effectiveAt is later than index generation",
        )
    return RevocationRecord(
        scope,
        subject,
        reason_code,
        effective_at,
        effective_datetime,
    )


def verify_marketplace_index(
    data: bytes,
    *,
    root: MarketplaceRoot,
    now: datetime | None = None,
    allow_expired: bool = False,
) -> VerifiedMarketplaceIndex:
    if not root.enabled:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_ROOT_DISABLED",
            "marketplace root is disabled in the build trust store",
        )
    if not 0 < len(data) <= MAX_INDEX_BYTES:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_LIMIT_EXCEEDED",
            "marketplace index has an invalid size",
        )
    try:
        value = loads_strict(data, limits=_JSON_LIMITS)
    except PlatformContractError as exc:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_SCHEMA_INVALID",
            "marketplace index is not strict JSON",
        ) from exc
    document = _mapping(value, "marketplace index")
    _only_keys(
        document,
        {
            "schemaVersion",
            "marketplace",
            "publishers",
            "releases",
            "revocations",
            "signature",
        },
        "marketplace index",
    )
    canonical = _canonical_bytes(document)
    if data != canonical:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_CANONICAL_JSON_REQUIRED",
            "marketplace index must use canonical JSON bytes",
        )
    if document["schemaVersion"] != INDEX_SCHEMA_VERSION:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_SCHEMA_INVALID",
            "marketplace index schemaVersion is unsupported",
        )
    marketplace = _mapping(document["marketplace"], "marketplace index.marketplace")
    _only_keys(
        marketplace,
        {
            "id",
            "sequence",
            "generatedAt",
            "expiresAt",
            "previousIndexSha256",
            "sourceOrigin",
            "transparencyHeadSha256",
        },
        "marketplace index.marketplace",
    )
    marketplace_id = _identifier(
        marketplace["id"],
        "marketplace index.marketplace.id",
    )
    if marketplace_id != root.marketplace_id:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_IDENTITY_MISMATCH",
            "marketplace index identity does not match its build-pinned root",
        )
    sequence = _positive_int(
        marketplace["sequence"],
        "marketplace index.marketplace.sequence",
        maximum=2**63 - 1,
    )
    generated_at, generated_datetime = _utc_timestamp(
        marketplace["generatedAt"],
        "marketplace index.marketplace.generatedAt",
    )
    expires_at, expires_datetime = _utc_timestamp(
        marketplace["expiresAt"],
        "marketplace index.marketplace.expiresAt",
    )
    current = now or datetime.now(UTC)
    if generated_datetime > current + MAX_CLOCK_SKEW:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_INDEX_NOT_YET_VALID",
            "marketplace index generation time is in the future",
        )
    if expires_datetime <= current and not allow_expired:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_INDEX_EXPIRED",
            "marketplace index has expired",
        )
    if (
        expires_datetime <= generated_datetime
        or expires_datetime - generated_datetime > MAX_INDEX_LIFETIME
    ):
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_TIMESTAMP_INVALID",
            "marketplace index validity window is invalid",
        )
    previous_value = marketplace["previousIndexSha256"]
    previous_index_sha256 = (
        None
        if previous_value is None
        else _sha256(
            previous_value,
            "marketplace index.marketplace.previousIndexSha256",
        )
    )
    source_origin = _string(
        marketplace["sourceOrigin"],
        "marketplace index.marketplace.sourceOrigin",
        maximum=512,
    )
    if (
        _origin(source_origin, "marketplace index.marketplace.sourceOrigin")
        != (root.source_origin)
        or source_origin != root.source_origin
    ):
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_ORIGIN_MISMATCH",
            "marketplace source origin does not match the build-pinned index origin",
        )
    transparency_head = _sha256(
        marketplace["transparencyHeadSha256"],
        "marketplace index.marketplace.transparencyHeadSha256",
    )
    signature = _mapping(document["signature"], "marketplace index.signature")
    _only_keys(
        signature,
        {"algorithm", "keyId", "value"},
        "marketplace index.signature",
    )
    if signature["algorithm"] != ED25519_ALGORITHM or signature["keyId"] != root.key_id:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_KEY_MISMATCH",
            "marketplace index signature key is not build-pinned",
        )
    body = {key: document[key] for key in document if key != "signature"}
    verify_ed25519(
        public_key=root.public_key,
        expected_key_id=root.key_id,
        signature=_string(
            signature["value"],
            "marketplace index.signature.value",
            maximum=128,
        ),
        message=_canonical_bytes(body),
        label="marketplace index.signature",
    )
    publishers = tuple(
        _publisher(raw, index)
        for index, raw in enumerate(
            _sequence(
                document["publishers"],
                "marketplace index.publishers",
                maximum=MAX_PUBLISHERS,
            )
        )
    )
    publisher_ids = [item.publisher_id for item in publishers]
    if publisher_ids != sorted(publisher_ids) or len(set(publisher_ids)) != len(
        publisher_ids
    ):
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_PUBLISHER_INVALID",
            "marketplace publishers must be ID-sorted and unique",
        )
    publisher_map = {item.publisher_id: item for item in publishers}
    releases = tuple(
        _release(
            raw,
            index,
            publishers=publisher_map,
            source_origin=source_origin,
            generated_at=generated_datetime,
        )
        for index, raw in enumerate(
            _sequence(
                document["releases"],
                "marketplace index.releases",
                maximum=MAX_RELEASES,
            )
        )
    )
    identities = [item.identity for item in releases]
    digests = [item.artifact.sha256 for item in releases]
    if len(set(identities)) != len(identities) or len(set(digests)) != len(digests):
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_RELEASE_CONFLICT",
            "marketplace releases contain duplicate identities or artifacts",
        )
    expected_previous = ZERO_SHA256
    for expected_log_index, release in enumerate(releases, start=1):
        if (
            release.log_index != expected_log_index
            or release.previous_record_sha256 != expected_previous
        ):
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_TRANSPARENCY_INVALID",
                "marketplace transparency records are not one contiguous hash chain",
            )
        expected_previous = release.record_sha256
    expected_head = expected_previous if releases else ZERO_SHA256
    if transparency_head != expected_head:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_TRANSPARENCY_INVALID",
            "marketplace transparency head does not match its release chain",
        )
    revocations = tuple(
        _revocation(raw, index, generated_datetime)
        for index, raw in enumerate(
            _sequence(
                document["revocations"],
                "marketplace index.revocations",
                maximum=MAX_REVOCATIONS,
            )
        )
    )
    revocation_keys = [
        (item.scope, item.subject, item.effective_at) for item in revocations
    ]
    if revocation_keys != sorted(revocation_keys) or len(set(revocation_keys)) != len(
        revocation_keys
    ):
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_REVOCATION_INVALID",
            "marketplace revocations must be sorted and unique",
        )
    return VerifiedMarketplaceIndex(
        marketplace_id,
        sequence,
        generated_at,
        generated_datetime,
        expires_at,
        expires_datetime,
        previous_index_sha256,
        source_origin,
        transparency_head,
        publishers,
        releases,
        revocations,
        _digest(canonical),
        canonical,
    )
