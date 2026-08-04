from __future__ import annotations

import copy
import hashlib
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Mapping, Sequence

from candlescope_plugin_sdk.platform_v2 import canonical_dumps, canonical_sha256
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from app.plugin_installer_v2.bundle import VerifiedPlatformBundle
from app.plugin_marketplace_v2 import MarketplaceRoot, encode_base64url, key_id
from app.plugin_marketplace_v2.models import ZERO_SHA256
from tests.plugin_marketplace_testkit import (
    INDEX_URL,
    MARKETPLACE_ID,
    PUBLISHER_ID,
    SOURCE_ORIGIN,
)


def _timestamp(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _digest_bytes(value: bytes) -> str:
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


def _public_bytes(private_key: Ed25519PrivateKey) -> bytes:
    return private_key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )


def _sign(private_key: Ed25519PrivateKey, value: Mapping[str, Any]) -> str:
    return encode_base64url(private_key.sign(canonical_dumps(value).encode("utf-8")))


def _default_runtime_binding(bundle: VerifiedPlatformBundle) -> dict[str, Any]:
    entrypoint = bundle.manifest.normalized_entrypoints[0]
    runtime = entrypoint.runtime
    if runtime.kind != "python-module":
        raise ValueError("default Phase 10 test binding only supports Python fixtures")
    wheel = bundle.wheels[0]
    content = next(item for item in bundle.envelope.contents if item.path == wheel.path)
    return {
        "entrypointId": entrypoint.id,
        "runtimeKind": runtime.kind,
        "runtimeId": runtime.runtime_id,
        "pluginArtifactPath": content.path,
        "pluginArtifactSha256": content.sha256,
        "supplySource": "host-python",
        "hostRuntime": None,
    }


@dataclass(slots=True)
class SignedMarketplaceV2Builder:
    root_private_key: Ed25519PrivateKey
    publisher_private_key: Ed25519PrivateKey
    releases: list[dict[str, Any]]

    @classmethod
    def create(cls) -> "SignedMarketplaceV2Builder":
        return cls(Ed25519PrivateKey.generate(), Ed25519PrivateKey.generate(), [])

    @property
    def root(self) -> MarketplaceRoot:
        public = _public_bytes(self.root_private_key)
        return MarketplaceRoot(
            MARKETPLACE_ID,
            INDEX_URL,
            key_id(public),
            public,
            True,
        )

    @property
    def publisher(self) -> dict[str, Any]:
        public = _public_bytes(self.publisher_private_key)
        return {
            "publisherId": PUBLISHER_ID,
            "displayName": "CandleScope Official",
            "keyId": key_id(public),
            "publicKey": encode_base64url(public),
            "status": "active",
            "verificationTier": "official",
        }

    def sign_artifact(
        self,
        *,
        plugin_id: str,
        version: str,
        artifact: Mapping[str, Any],
    ) -> dict[str, Any]:
        statement = {
            "pluginId": plugin_id,
            "version": version,
            "publisherId": PUBLISHER_ID,
            "artifact": dict(artifact),
        }
        return {
            **dict(artifact),
            "signature": {
                "algorithm": "ed25519",
                "keyId": self.publisher["keyId"],
                "value": _sign(self.publisher_private_key, statement),
            },
        }

    def resign_release(self, release: dict[str, Any]) -> None:
        statement = {
            key: value
            for key, value in release.items()
            if key not in {"signature", "transparency"}
        }
        release["signature"] = {
            "algorithm": "ed25519",
            "keyId": self.publisher["keyId"],
            "value": _sign(self.publisher_private_key, statement),
        }
        leaf = canonical_sha256(
            {"statement": statement, "signature": release["signature"]}
        )
        log_index = self.releases.index(release) + 1
        previous = (
            self.releases[log_index - 2]["transparency"]["recordSha256"]
            if log_index > 1
            else ZERO_SHA256
        )
        record = canonical_sha256(
            {
                "logIndex": log_index,
                "leafSha256": leaf,
                "previousRecordSha256": previous,
            }
        )
        release["transparency"] = {
            "logIndex": log_index,
            "leafSha256": leaf,
            "previousRecordSha256": previous,
            "recordSha256": record,
        }

    def add_release(
        self,
        bundle: VerifiedPlatformBundle,
        *,
        operating_system: str = "windows",
        architecture: str = "x86_64",
        runtime_bindings: Sequence[Mapping[str, Any]] | None = None,
        rollout_stage: str = "stable",
        minimum_host_version: str = "0.4.0",
        official_maintained: bool = True,
        published_at: datetime | None = None,
        dependencies: Sequence[Mapping[str, str]] | None = None,
        dependency_license: str = "Apache-2.0",
        source_commit: str = "a" * 40,
    ) -> dict[str, Any]:
        published = published_at or datetime(2026, 8, 1, tzinfo=UTC)
        sbom_sha256 = next(
            item.sha256
            for item in bundle.envelope.contents
            if item.path == "sbom/cyclonedx.json"
        )
        bindings = [
            dict(item)
            for item in (
                runtime_bindings
                if runtime_bindings is not None
                else [_default_runtime_binding(bundle)]
            )
        ]
        dependency_values = sorted(
            (
                [dict(item) for item in dependencies]
                if dependencies is not None
                else [
                    {
                        "name": item.package.replace("_", "-").lower(),
                        "version": item.version,
                        "licenseExpression": dependency_license,
                    }
                    for item in bundle.wheels
                ]
            ),
            key=lambda item: (item["name"], item["version"]),
        )
        runtime_licenses = sorted(
            {
                binding["hostRuntime"]["licenseExpression"]
                for binding in bindings
                if binding["hostRuntime"] is not None
            }
        )
        license_inventory_sha256 = canonical_sha256(
            {
                "plugin": bundle.manifest.plugin.license,
                "dependencies": dependency_values,
                "runtimeLicenses": runtime_licenses,
            }
        )
        artifact_statement = {
            "artifactId": f"{operating_system}-{architecture}",
            "os": operating_system,
            "arch": architecture,
            "fileName": bundle.path.name,
            "url": f"{SOURCE_ORIGIN}/artifacts/{bundle.path.name}",
            "sha256": bundle.sha256,
            "size": bundle.size,
            "manifestSha256": bundle.manifest_sha256,
            "sbomSha256": sbom_sha256,
            "licenseInventorySha256": license_inventory_sha256,
            "runtimeBindings": bindings,
            "provenance": {
                "sourceRepository": "https://github.com/candlescope/reference-plugin",
                "sourceCommit": source_commit,
                "buildReceiptUrl": (
                    f"{SOURCE_ORIGIN}/provenance/{bundle.path.name}.receipt.json"
                ),
                "buildReceiptSha256": _digest_bytes(b"phase10-build-receipt"),
                "rebuildInstructionsUrl": (
                    f"{SOURCE_ORIGIN}/provenance/{bundle.path.name}.rebuild.md"
                ),
                "rebuildInstructionsSha256": _digest_bytes(
                    b"phase10-rebuild-instructions"
                ),
                "reproducibleBuilds": True,
            },
            "reviewPolicy": {
                "distribution": "prebuilt-only",
                "sourceBuild": False,
                "systemRuntimeFallback": False,
                "undeclaredDownloads": False,
            },
        }
        artifact = self.sign_artifact(
            plugin_id=bundle.manifest.plugin.id,
            version=bundle.manifest.plugin.version,
            artifact=artifact_statement,
        )
        permissions = bundle.manifest.permissions.to_wire()
        permissions = {
            kind: sorted(permissions[kind], key=lambda item: item["id"])
            for kind in ("required", "optional")
        }
        statement: dict[str, Any] = {
            "pluginId": bundle.manifest.plugin.id,
            "version": bundle.manifest.plugin.version,
            "publisherId": PUBLISHER_ID,
            "artifacts": [artifact],
            "publishedAt": _timestamp(published),
            "licenseExpression": bundle.manifest.plugin.license,
            "dependencies": dependency_values,
            "minimumHostVersion": minimum_host_version,
            "rolloutStage": rollout_stage,
            "officialMaintained": official_maintained,
            "permissions": permissions,
            "sha256Sums": (
                f"{bundle.sha256.removeprefix('sha256:')}  {bundle.path.name}\n"
            ),
        }
        statement["sha256SumsSha256"] = _digest_bytes(
            statement["sha256Sums"].encode("utf-8")
        )
        signature = {
            "algorithm": "ed25519",
            "keyId": self.publisher["keyId"],
            "value": _sign(self.publisher_private_key, statement),
        }
        leaf = canonical_sha256({"statement": statement, "signature": signature})
        log_index = len(self.releases) + 1
        previous = (
            self.releases[-1]["transparency"]["recordSha256"]
            if self.releases
            else ZERO_SHA256
        )
        record = canonical_sha256(
            {
                "logIndex": log_index,
                "leafSha256": leaf,
                "previousRecordSha256": previous,
            }
        )
        release = {
            **statement,
            "signature": signature,
            "transparency": {
                "logIndex": log_index,
                "leafSha256": leaf,
                "previousRecordSha256": previous,
                "recordSha256": record,
            },
        }
        self.releases.append(release)
        return copy.deepcopy(release)

    def index_document(
        self,
        *,
        sequence: int = 1,
        previous_index_sha256: str | None = None,
        revocations: list[dict[str, Any]] | None = None,
        generated_at: datetime | None = None,
        expires_at: datetime | None = None,
        releases: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        generated = generated_at or datetime(2026, 8, 3, tzinfo=UTC)
        expires = expires_at or generated + timedelta(days=30)
        values = copy.deepcopy(self.releases if releases is None else releases)
        body = {
            "schemaVersion": "candlescope.marketplace-index/2",
            "marketplace": {
                "id": MARKETPLACE_ID,
                "sequence": sequence,
                "generatedAt": _timestamp(generated),
                "expiresAt": _timestamp(expires),
                "previousIndexSha256": previous_index_sha256,
                "sourceOrigin": SOURCE_ORIGIN,
                "transparencyHeadSha256": (
                    values[-1]["transparency"]["recordSha256"]
                    if values
                    else ZERO_SHA256
                ),
            },
            "publishers": [self.publisher],
            "releases": values,
            "revocations": sorted(
                copy.deepcopy(revocations or []),
                key=lambda item: (
                    item["scope"],
                    item["subject"],
                    item["effectiveAt"],
                ),
            ),
        }
        return {
            **body,
            "signature": {
                "algorithm": "ed25519",
                "keyId": self.root.key_id,
                "value": _sign(self.root_private_key, body),
            },
        }

    def index_bytes(self, **kwargs: Any) -> bytes:
        return canonical_dumps(self.index_document(**kwargs)).encode("utf-8")

    def resign_index(self, document: dict[str, Any]) -> bytes:
        body = {key: value for key, value in document.items() if key != "signature"}
        document["signature"] = {
            "algorithm": "ed25519",
            "keyId": self.root.key_id,
            "value": _sign(self.root_private_key, body),
        }
        return canonical_dumps(document).encode("utf-8")
