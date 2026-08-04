"""Strict multi-runtime Marketplace release and supply-chain contracts.

Index v2 keeps the root/index/transparency trust chain from Marketplace v1,
while signing each OS/architecture bundle independently.  The contract is
deliberately distribution-only: Marketplace artifacts may never request a
source build, ambient system runtime, or undeclared download on the user's
machine.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from urllib.parse import urlsplit

from .crypto import ED25519_ALGORITHM, validate_key_id, verify_ed25519
from .errors import MarketplaceError
from .models import (
    MAX_ARTIFACT_BYTES,
    MAX_CLOCK_SKEW,
    MAX_RELEASES,
    ZERO_SHA256,
    DependencyRecord,
    PublisherRecord,
    _artifact_url,
    _canonical_bytes,
    _dependency,
    _digest,
    _identifier,
    _mapping,
    _only_keys,
    _positive_int,
    _sequence,
    _sha256,
    _string,
    _utc_timestamp,
    _FILE_NAME,
    _LICENSE,
    _PLUGIN_ID,
    _SEMVER,
)


RUNTIME_KINDS = frozenset(
    {
        "python-module",
        "native-executable",
        "java-jar",
        "node-module",
        "wasm-component",
    }
)
ROLLOUT_STAGES = ("internal", "opted-in-local", "preview", "stable")
_OPERATING_SYSTEMS = frozenset({"windows", "linux", "macos"})
_ARCHITECTURES = frozenset({"x86_64", "arm64"})
_SUPPLY_SOURCE = {
    "python-module": "host-python",
    "native-executable": "plugin-bundled",
    "java-jar": "host-managed",
    "node-module": "host-managed",
    "wasm-component": "host-managed",
}
_HOST_RUNTIME_KIND = {
    "java-jar": "java",
    "node-module": "node",
    "wasm-component": "wasm",
}
_SOURCE_COMMIT = re.compile(r"^[0-9a-f]{40}$")
_ARTIFACT_PATH = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$")


def _boolean(value: Any, label: str) -> bool:
    if not isinstance(value, bool):
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_SCHEMA_INVALID",
            f"{label} must be a boolean",
        )
    return value


def _https_url(value: Any, label: str) -> str:
    raw = _string(value, label, maximum=2048)
    parsed = urlsplit(raw)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
    ):
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_URL_INVALID",
            f"{label} must be an HTTPS URL without credentials or fragment",
        )
    return raw


def _safe_artifact_path(value: Any, label: str) -> str:
    raw = _string(value, label, maximum=256).replace("\\", "/")
    if (
        _ARTIFACT_PATH.fullmatch(raw) is None
        or raw.startswith("/")
        or "//" in raw
        or any(part in {"", ".", ".."} for part in raw.split("/"))
    ):
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_ARTIFACT_INVALID",
            f"{label} must be a safe bundle-relative path",
        )
    return raw


def _json_value(value: Any, label: str, *, depth: int = 0) -> Any:
    if depth > 12:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_LIMIT_EXCEEDED",
            f"{label} exceeds the signed JSON depth limit",
        )
    if value is None or isinstance(value, (str, bool)):
        return value
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, float):
        if not value == value or value in {float("inf"), float("-inf")}:
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_SCHEMA_INVALID",
                f"{label} contains a non-finite number",
            )
        return value
    if isinstance(value, Mapping):
        if len(value) > 128 or not all(
            isinstance(key, str) and 0 < len(key) <= 128 for key in value
        ):
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_LIMIT_EXCEEDED",
                f"{label} contains too many or invalid object fields",
            )
        return {
            key: _json_value(item, f"{label}.{key}", depth=depth + 1)
            for key, item in value.items()
        }
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        if len(value) > 1_000:
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_LIMIT_EXCEEDED",
                f"{label} contains too many array items",
            )
        return [
            _json_value(item, f"{label}[{index}]", depth=depth + 1)
            for index, item in enumerate(value)
        ]
    raise MarketplaceError(
        "PLUGIN_MARKETPLACE_SCHEMA_INVALID",
        f"{label} is not a JSON value",
    )


@dataclass(frozen=True, slots=True)
class HostRuntimeEvidence:
    registry_id: str
    registry_revision: int
    registry_sha256: str
    runtime_artifact_sha256: str
    license_expression: str

    def to_wire(self) -> dict[str, Any]:
        return {
            "registryId": self.registry_id,
            "registryRevision": self.registry_revision,
            "registrySha256": self.registry_sha256,
            "runtimeArtifactSha256": self.runtime_artifact_sha256,
            "licenseExpression": self.license_expression,
        }


@dataclass(frozen=True, slots=True)
class RuntimeBinding:
    entrypoint_id: str
    runtime_kind: str
    runtime_id: str
    plugin_artifact_path: str
    plugin_artifact_sha256: str
    supply_source: str
    host_runtime: HostRuntimeEvidence | None

    def to_wire(self) -> dict[str, Any]:
        return {
            "entrypointId": self.entrypoint_id,
            "runtimeKind": self.runtime_kind,
            "runtimeId": self.runtime_id,
            "pluginArtifactPath": self.plugin_artifact_path,
            "pluginArtifactSha256": self.plugin_artifact_sha256,
            "supplySource": self.supply_source,
            "hostRuntime": (
                self.host_runtime.to_wire() if self.host_runtime is not None else None
            ),
        }


@dataclass(frozen=True, slots=True)
class ArtifactProvenance:
    source_repository: str
    source_commit: str
    build_receipt_url: str
    build_receipt_sha256: str
    rebuild_instructions_url: str
    rebuild_instructions_sha256: str
    reproducible_builds: bool

    def to_wire(self) -> dict[str, Any]:
        return {
            "sourceRepository": self.source_repository,
            "sourceCommit": self.source_commit,
            "buildReceiptUrl": self.build_receipt_url,
            "buildReceiptSha256": self.build_receipt_sha256,
            "rebuildInstructionsUrl": self.rebuild_instructions_url,
            "rebuildInstructionsSha256": self.rebuild_instructions_sha256,
            "reproducibleBuilds": self.reproducible_builds,
        }


@dataclass(frozen=True, slots=True)
class MarketplaceReviewPolicy:
    distribution: str
    source_build: bool
    system_runtime_fallback: bool
    undeclared_downloads: bool

    def to_wire(self) -> dict[str, Any]:
        return {
            "distribution": self.distribution,
            "sourceBuild": self.source_build,
            "systemRuntimeFallback": self.system_runtime_fallback,
            "undeclaredDownloads": self.undeclared_downloads,
        }


@dataclass(frozen=True, slots=True)
class SignedArtifactRecord:
    artifact_id: str
    operating_system: str
    architecture: str
    file_name: str
    url: str
    sha256: str
    size: int
    manifest_sha256: str
    sbom_sha256: str
    license_inventory_sha256: str
    runtime_bindings: tuple[RuntimeBinding, ...]
    provenance: ArtifactProvenance
    review_policy: MarketplaceReviewPolicy
    signature: dict[str, str]

    @property
    def platform(self) -> tuple[str, str]:
        return self.operating_system, self.architecture

    @property
    def runtime_kinds(self) -> tuple[str, ...]:
        return tuple(sorted({item.runtime_kind for item in self.runtime_bindings}))

    def statement_wire(self) -> dict[str, Any]:
        return {
            "artifactId": self.artifact_id,
            "os": self.operating_system,
            "arch": self.architecture,
            "fileName": self.file_name,
            "url": self.url,
            "sha256": self.sha256,
            "size": self.size,
            "manifestSha256": self.manifest_sha256,
            "sbomSha256": self.sbom_sha256,
            "licenseInventorySha256": self.license_inventory_sha256,
            "runtimeBindings": [item.to_wire() for item in self.runtime_bindings],
            "provenance": self.provenance.to_wire(),
            "reviewPolicy": self.review_policy.to_wire(),
        }

    def to_wire(self) -> dict[str, Any]:
        return {**self.statement_wire(), "signature": dict(self.signature)}


@dataclass(frozen=True, slots=True)
class MultiRuntimeReleaseRecord:
    plugin_id: str
    version: str
    publisher_id: str
    platform_artifacts: tuple[SignedArtifactRecord, ...]
    published_at: str
    license_expression: str
    dependencies: tuple[DependencyRecord, ...]
    minimum_host_version: str
    rollout_stage: str
    official_maintained: bool
    permissions: dict[str, Any]
    sha256_sums: str
    sha256_sums_sha256: str
    signature: dict[str, str]
    log_index: int
    leaf_sha256: str
    previous_record_sha256: str
    record_sha256: str

    @property
    def artifacts(self) -> tuple[SignedArtifactRecord, ...]:
        return self.platform_artifacts

    @property
    def artifact(self) -> SignedArtifactRecord:
        # Compatibility for v1 service callers.  Multi-runtime-aware callers
        # must select with artifact_for_platform before downloading.
        return self.platform_artifacts[0]

    @property
    def identity(self) -> tuple[str, str]:
        return self.plugin_id, self.version

    def artifact_for_platform(
        self, operating_system: str, architecture: str
    ) -> SignedArtifactRecord:
        matches = [
            item
            for item in self.platform_artifacts
            if item.platform == (operating_system, architecture)
        ]
        if len(matches) != 1:
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_PLATFORM_UNAVAILABLE",
                "release has no unique signed artifact for this Host platform",
                details={"os": operating_system, "arch": architecture},
            )
        return matches[0]

    def statement_wire(self) -> dict[str, Any]:
        return {
            "pluginId": self.plugin_id,
            "version": self.version,
            "publisherId": self.publisher_id,
            "artifacts": [item.to_wire() for item in self.platform_artifacts],
            "publishedAt": self.published_at,
            "licenseExpression": self.license_expression,
            "dependencies": [item.to_wire() for item in self.dependencies],
            "minimumHostVersion": self.minimum_host_version,
            "rolloutStage": self.rollout_stage,
            "officialMaintained": self.official_maintained,
            "permissions": self.permissions,
            "sha256Sums": self.sha256_sums,
            "sha256SumsSha256": self.sha256_sums_sha256,
        }

    def to_public_wire(self, *, revoked: bool) -> dict[str, Any]:
        return {
            **self.statement_wire(),
            "publisherKeyId": self.signature["keyId"],
            "runtimeKinds": sorted(
                {
                    kind
                    for artifact in self.platform_artifacts
                    for kind in artifact.runtime_kinds
                }
            ),
            "transparency": {
                "logIndex": self.log_index,
                "leafSha256": self.leaf_sha256,
                "recordSha256": self.record_sha256,
            },
            "revoked": revoked,
        }


def _signature(
    value: Any,
    *,
    label: str,
    publisher: PublisherRecord,
    statement: Mapping[str, Any],
) -> dict[str, str]:
    item = _mapping(value, label)
    _only_keys(item, {"algorithm", "keyId", "value"}, label)
    if item["algorithm"] != ED25519_ALGORITHM:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_SIGNATURE_INVALID",
            f"{label} algorithm is unsupported",
        )
    signature_key_id = validate_key_id(item["keyId"], label=f"{label}.keyId")
    if signature_key_id != publisher.key_id:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_KEY_MISMATCH",
            f"{label} key does not match the publisher",
        )
    result = {
        "algorithm": ED25519_ALGORITHM,
        "keyId": signature_key_id,
        "value": _string(item["value"], f"{label}.value", maximum=128),
    }
    verify_ed25519(
        public_key=publisher.public_key,
        expected_key_id=publisher.key_id,
        signature=result["value"],
        message=_canonical_bytes(statement),
        label=label,
    )
    return result


def _host_runtime(value: Any, label: str) -> HostRuntimeEvidence:
    item = _mapping(value, label)
    _only_keys(
        item,
        {
            "registryId",
            "registryRevision",
            "registrySha256",
            "runtimeArtifactSha256",
            "licenseExpression",
        },
        label,
    )
    license_expression = _string(
        item["licenseExpression"], f"{label}.licenseExpression", maximum=256
    )
    if _LICENSE.fullmatch(license_expression) is None:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_LICENSE_INVALID",
            f"{label}.licenseExpression is invalid",
        )
    return HostRuntimeEvidence(
        _identifier(item["registryId"], f"{label}.registryId"),
        _positive_int(
            item["registryRevision"], f"{label}.registryRevision", maximum=2**63 - 1
        ),
        _sha256(item["registrySha256"], f"{label}.registrySha256"),
        _sha256(item["runtimeArtifactSha256"], f"{label}.runtimeArtifactSha256"),
        license_expression,
    )


def _runtime_binding(value: Any, label: str) -> RuntimeBinding:
    item = _mapping(value, label)
    _only_keys(
        item,
        {
            "entrypointId",
            "runtimeKind",
            "runtimeId",
            "pluginArtifactPath",
            "pluginArtifactSha256",
            "supplySource",
            "hostRuntime",
        },
        label,
    )
    runtime_kind = _string(item["runtimeKind"], f"{label}.runtimeKind", maximum=32)
    if runtime_kind not in RUNTIME_KINDS:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_RUNTIME_INVALID",
            f"{label}.runtimeKind is unsupported",
        )
    supply_source = _string(item["supplySource"], f"{label}.supplySource", maximum=32)
    if supply_source != _SUPPLY_SOURCE[runtime_kind]:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_REVIEW_POLICY_DENIED",
            f"{label} requests an undeclared or system runtime supply",
        )
    raw_host_runtime = item["hostRuntime"]
    host_runtime = (
        _host_runtime(raw_host_runtime, f"{label}.hostRuntime")
        if raw_host_runtime is not None
        else None
    )
    expected_host_kind = _HOST_RUNTIME_KIND.get(runtime_kind)
    if (expected_host_kind is None) != (host_runtime is None):
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_RUNTIME_INVALID",
            f"{label}.hostRuntime does not match runtimeKind",
        )
    runtime_id = _identifier(item["runtimeId"], f"{label}.runtimeId")
    return RuntimeBinding(
        _identifier(item["entrypointId"], f"{label}.entrypointId"),
        runtime_kind,
        runtime_id,
        _safe_artifact_path(item["pluginArtifactPath"], f"{label}.pluginArtifactPath"),
        _sha256(item["pluginArtifactSha256"], f"{label}.pluginArtifactSha256"),
        supply_source,
        host_runtime,
    )


def _provenance(value: Any, label: str) -> ArtifactProvenance:
    item = _mapping(value, label)
    _only_keys(
        item,
        {
            "sourceRepository",
            "sourceCommit",
            "buildReceiptUrl",
            "buildReceiptSha256",
            "rebuildInstructionsUrl",
            "rebuildInstructionsSha256",
            "reproducibleBuilds",
        },
        label,
    )
    commit = _string(item["sourceCommit"], f"{label}.sourceCommit", maximum=40)
    if _SOURCE_COMMIT.fullmatch(commit) is None:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_PROVENANCE_INVALID",
            f"{label}.sourceCommit must be a full lowercase commit digest",
        )
    reproducible = _boolean(item["reproducibleBuilds"], f"{label}.reproducibleBuilds")
    if not reproducible:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_PROVENANCE_INVALID",
            "Marketplace artifacts require independently reproducible build evidence",
        )
    return ArtifactProvenance(
        _https_url(item["sourceRepository"], f"{label}.sourceRepository"),
        commit,
        _https_url(item["buildReceiptUrl"], f"{label}.buildReceiptUrl"),
        _sha256(item["buildReceiptSha256"], f"{label}.buildReceiptSha256"),
        _https_url(item["rebuildInstructionsUrl"], f"{label}.rebuildInstructionsUrl"),
        _sha256(
            item["rebuildInstructionsSha256"],
            f"{label}.rebuildInstructionsSha256",
        ),
        reproducible,
    )


def _review_policy(value: Any, label: str) -> MarketplaceReviewPolicy:
    item = _mapping(value, label)
    _only_keys(
        item,
        {
            "distribution",
            "sourceBuild",
            "systemRuntimeFallback",
            "undeclaredDownloads",
        },
        label,
    )
    result = MarketplaceReviewPolicy(
        _string(item["distribution"], f"{label}.distribution", maximum=32),
        _boolean(item["sourceBuild"], f"{label}.sourceBuild"),
        _boolean(item["systemRuntimeFallback"], f"{label}.systemRuntimeFallback"),
        _boolean(item["undeclaredDownloads"], f"{label}.undeclaredDownloads"),
    )
    if result != MarketplaceReviewPolicy("prebuilt-only", False, False, False):
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_REVIEW_POLICY_DENIED",
            "Marketplace release requests source compilation, system fallback, or undeclared downloads",
        )
    return result


def _artifact(
    value: Any,
    *,
    label: str,
    plugin_id: str,
    version: str,
    publisher_id: str,
    publisher: PublisherRecord,
    source_origin: str,
) -> SignedArtifactRecord:
    item = _mapping(value, label)
    _only_keys(
        item,
        {
            "artifactId",
            "os",
            "arch",
            "fileName",
            "url",
            "sha256",
            "size",
            "manifestSha256",
            "sbomSha256",
            "licenseInventorySha256",
            "runtimeBindings",
            "provenance",
            "reviewPolicy",
            "signature",
        },
        label,
    )
    operating_system = _string(item["os"], f"{label}.os", maximum=16)
    architecture = _string(item["arch"], f"{label}.arch", maximum=16)
    if operating_system not in _OPERATING_SYSTEMS or architecture not in _ARCHITECTURES:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_PLATFORM_UNAVAILABLE",
            f"{label} has an unsupported platform target",
        )
    file_name = _string(item["fileName"], f"{label}.fileName", maximum=207)
    if _FILE_NAME.fullmatch(file_name) is None:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_ARTIFACT_INVALID",
            f"{label}.fileName is invalid",
        )
    bindings = tuple(
        _runtime_binding(raw, f"{label}.runtimeBindings[{index}]")
        for index, raw in enumerate(
            _sequence(item["runtimeBindings"], f"{label}.runtimeBindings", maximum=32)
        )
    )
    binding_ids = [binding.entrypoint_id for binding in bindings]
    if (
        not bindings
        or binding_ids != sorted(binding_ids)
        or len(set(binding_ids)) != len(binding_ids)
    ):
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_RUNTIME_INVALID",
            f"{label}.runtimeBindings must be entrypoint-sorted and unique",
        )
    statement = {
        "artifactId": _identifier(item["artifactId"], f"{label}.artifactId"),
        "os": operating_system,
        "arch": architecture,
        "fileName": file_name,
        "url": _artifact_url(
            item["url"], source_origin=source_origin, label=f"{label}.url"
        ),
        "sha256": _sha256(item["sha256"], f"{label}.sha256"),
        "size": _positive_int(
            item["size"], f"{label}.size", maximum=MAX_ARTIFACT_BYTES
        ),
        "manifestSha256": _sha256(item["manifestSha256"], f"{label}.manifestSha256"),
        "sbomSha256": _sha256(item["sbomSha256"], f"{label}.sbomSha256"),
        "licenseInventorySha256": _sha256(
            item["licenseInventorySha256"], f"{label}.licenseInventorySha256"
        ),
        "runtimeBindings": [binding.to_wire() for binding in bindings],
        "provenance": _provenance(item["provenance"], f"{label}.provenance").to_wire(),
        "reviewPolicy": _review_policy(
            item["reviewPolicy"], f"{label}.reviewPolicy"
        ).to_wire(),
    }
    signature_statement = {
        "pluginId": plugin_id,
        "version": version,
        "publisherId": publisher_id,
        "artifact": statement,
    }
    signature = _signature(
        item["signature"],
        label=f"{label}.signature",
        publisher=publisher,
        statement=signature_statement,
    )
    return SignedArtifactRecord(
        statement["artifactId"],
        operating_system,
        architecture,
        file_name,
        statement["url"],
        statement["sha256"],
        statement["size"],
        statement["manifestSha256"],
        statement["sbomSha256"],
        statement["licenseInventorySha256"],
        bindings,
        _provenance(item["provenance"], f"{label}.provenance"),
        _review_policy(item["reviewPolicy"], f"{label}.reviewPolicy"),
        signature,
    )


def _permissions(value: Any, label: str) -> dict[str, Any]:
    item = _mapping(value, label)
    _only_keys(item, {"required", "optional"}, label)
    result: dict[str, Any] = {"required": [], "optional": []}
    seen: set[str] = set()
    for kind in ("required", "optional"):
        values = []
        for index, raw in enumerate(
            _sequence(item[kind], f"{label}.{kind}", maximum=128)
        ):
            permission_label = f"{label}.{kind}[{index}]"
            permission = _mapping(raw, permission_label)
            _only_keys(permission, {"id", "scope"}, permission_label)
            permission_id = _identifier(permission["id"], f"{permission_label}.id")
            if permission_id in seen:
                raise MarketplaceError(
                    "PLUGIN_MARKETPLACE_PERMISSION_INVALID",
                    f"{label} contains a duplicate permission",
                )
            seen.add(permission_id)
            scope = _json_value(permission["scope"], f"{permission_label}.scope")
            if not isinstance(scope, dict):
                raise MarketplaceError(
                    "PLUGIN_MARKETPLACE_PERMISSION_INVALID",
                    f"{permission_label}.scope must be an object",
                )
            values.append({"id": permission_id, "scope": scope})
        if [entry["id"] for entry in values] != sorted(entry["id"] for entry in values):
            raise MarketplaceError(
                "PLUGIN_MARKETPLACE_PERMISSION_INVALID",
                f"{label}.{kind} must be permission-ID-sorted",
            )
        result[kind] = values
    return result


def parse_multi_runtime_release(
    value: Any,
    index: int,
    *,
    publishers: Mapping[str, PublisherRecord],
    source_origin: str,
    generated_at: datetime,
) -> MultiRuntimeReleaseRecord:
    """Parse and verify one independently signed Marketplace index v2 release."""

    label = f"marketplace index.releases[{index}]"
    item = _mapping(value, label)
    _only_keys(
        item,
        {
            "pluginId",
            "version",
            "publisherId",
            "artifacts",
            "publishedAt",
            "licenseExpression",
            "dependencies",
            "minimumHostVersion",
            "rolloutStage",
            "officialMaintained",
            "permissions",
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
            f"{label}.pluginId must be namespaced",
        )
    version = _string(item["version"], f"{label}.version", maximum=64)
    minimum_host_version = _string(
        item["minimumHostVersion"], f"{label}.minimumHostVersion", maximum=64
    )
    if (
        _SEMVER.fullmatch(version) is None
        or _SEMVER.fullmatch(minimum_host_version) is None
    ):
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_VERSION_INVALID",
            f"{label} versions must be SemVer",
        )
    publisher_id = _identifier(item["publisherId"], f"{label}.publisherId")
    publisher = publishers.get(publisher_id)
    if publisher is None:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_PUBLISHER_INVALID",
            f"{label} references an unknown publisher",
        )
    artifacts = tuple(
        _artifact(
            raw,
            label=f"{label}.artifacts[{artifact_index}]",
            plugin_id=plugin_id,
            version=version,
            publisher_id=publisher_id,
            publisher=publisher,
            source_origin=source_origin,
        )
        for artifact_index, raw in enumerate(
            _sequence(item["artifacts"], f"{label}.artifacts", maximum=16)
        )
    )
    artifact_keys = [
        (artifact.operating_system, artifact.architecture, artifact.artifact_id)
        for artifact in artifacts
    ]
    platforms = [artifact.platform for artifact in artifacts]
    if (
        not artifacts
        or artifact_keys != sorted(artifact_keys)
        or len(set(platforms)) != len(platforms)
    ):
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_ARTIFACT_INVALID",
            f"{label}.artifacts must be platform-sorted with one artifact per target",
        )
    published_at, published_datetime = _utc_timestamp(
        item["publishedAt"], f"{label}.publishedAt"
    )
    if published_datetime > generated_at + MAX_CLOCK_SKEW:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_TIMESTAMP_INVALID",
            f"{label}.publishedAt is later than index generation",
        )
    license_expression = _string(
        item["licenseExpression"], f"{label}.licenseExpression", maximum=256
    )
    if _LICENSE.fullmatch(license_expression) is None:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_LICENSE_INVALID",
            f"{label}.licenseExpression is invalid",
        )
    dependencies = tuple(
        _dependency(raw, f"{label}.dependencies[{dependency_index}]")
        for dependency_index, raw in enumerate(
            _sequence(item["dependencies"], f"{label}.dependencies", maximum=1_000)
        )
    )
    dependency_keys = [(entry.name, entry.version) for entry in dependencies]
    if dependency_keys != sorted(dependency_keys) or len(set(dependency_keys)) != len(
        dependency_keys
    ):
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_DEPENDENCIES_INVALID",
            f"{label}.dependencies must be identity-sorted and unique",
        )
    rollout_stage = _string(item["rolloutStage"], f"{label}.rolloutStage", maximum=32)
    if rollout_stage not in ROLLOUT_STAGES:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_ROLLOUT_INVALID",
            f"{label}.rolloutStage is unsupported",
        )
    official_maintained = _boolean(
        item["officialMaintained"], f"{label}.officialMaintained"
    )
    if official_maintained and publisher.verification_tier != "official":
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_PUBLISHER_INVALID",
            "only an official publisher may sign officialMaintained=true",
        )
    permissions = _permissions(item["permissions"], f"{label}.permissions")
    sha256_sums = item["sha256Sums"]
    expected_sums = "".join(
        f"{artifact.sha256.removeprefix('sha256:')}  {artifact.file_name}\n"
        for artifact in sorted(artifacts, key=lambda entry: entry.file_name)
    )
    if (
        not isinstance(sha256_sums, str)
        or sha256_sums != expected_sums
        or len(sha256_sums) > 4_096
    ):
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_SHA256SUMS_INVALID",
            f"{label}.sha256Sums does not pin every platform artifact",
        )
    sha256_sums_sha256 = _sha256(item["sha256SumsSha256"], f"{label}.sha256SumsSha256")
    if _digest(sha256_sums.encode("utf-8")) != sha256_sums_sha256:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_SHA256SUMS_INVALID",
            f"{label}.sha256Sums digest mismatch",
        )
    statement = {
        "pluginId": plugin_id,
        "version": version,
        "publisherId": publisher_id,
        "artifacts": [artifact.to_wire() for artifact in artifacts],
        "publishedAt": published_at,
        "licenseExpression": license_expression,
        "dependencies": [entry.to_wire() for entry in dependencies],
        "minimumHostVersion": minimum_host_version,
        "rolloutStage": rollout_stage,
        "officialMaintained": official_maintained,
        "permissions": permissions,
        "sha256Sums": sha256_sums,
        "sha256SumsSha256": sha256_sums_sha256,
    }
    signature = _signature(
        item["signature"],
        label=f"{label}.signature",
        publisher=publisher,
        statement=statement,
    )
    transparency = _mapping(item["transparency"], f"{label}.transparency")
    _only_keys(
        transparency,
        {"logIndex", "leafSha256", "previousRecordSha256", "recordSha256"},
        f"{label}.transparency",
    )
    log_index = _positive_int(
        transparency["logIndex"],
        f"{label}.transparency.logIndex",
        maximum=MAX_RELEASES,
    )
    leaf_sha256 = _sha256(
        transparency["leafSha256"], f"{label}.transparency.leafSha256"
    )
    if leaf_sha256 != _digest(
        _canonical_bytes({"statement": statement, "signature": signature})
    ):
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_TRANSPARENCY_INVALID",
            f"{label} transparency leaf does not match the signed release",
        )
    previous_record_sha256 = _sha256(
        transparency["previousRecordSha256"],
        f"{label}.transparency.previousRecordSha256",
    )
    if log_index == 1 and previous_record_sha256 != ZERO_SHA256:
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_TRANSPARENCY_INVALID",
            f"{label} first transparency record has a non-zero predecessor",
        )
    record_sha256 = _sha256(
        transparency["recordSha256"], f"{label}.transparency.recordSha256"
    )
    if record_sha256 != _digest(
        _canonical_bytes(
            {
                "logIndex": log_index,
                "leafSha256": leaf_sha256,
                "previousRecordSha256": previous_record_sha256,
            }
        )
    ):
        raise MarketplaceError(
            "PLUGIN_MARKETPLACE_TRANSPARENCY_INVALID",
            f"{label} transparency record digest is invalid",
        )
    return MultiRuntimeReleaseRecord(
        plugin_id,
        version,
        publisher_id,
        artifacts,
        published_at,
        license_expression,
        dependencies,
        minimum_host_version,
        rollout_stage,
        official_maintained,
        permissions,
        sha256_sums,
        sha256_sums_sha256,
        signature,
        log_index,
        leaf_sha256,
        previous_record_sha256,
        record_sha256,
    )
