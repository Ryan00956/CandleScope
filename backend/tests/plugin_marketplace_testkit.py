from __future__ import annotations

import copy
import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from candlescope_plugin_sdk.platform_v2 import canonical_dumps, canonical_sha256
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from app.plugin_installer_v2.bundle import (
    VerifiedPlatformBundle,
    build_platform_bundle,
)
from app.plugin_marketplace_v2 import (
    MarketplaceRoot,
    encode_base64url,
    key_id,
)
from app.plugin_marketplace_v2.models import ZERO_SHA256
from tests.plugin_platform_bundle_testkit import (
    PlatformBundleFixture,
    build_hello_platform_bundle,
)


MARKETPLACE_ID = "candlescope.community"
PUBLISHER_ID = "candlescope"
INDEX_URL = "https://plugins.example.test/index.json"
SOURCE_ORIGIN = "https://plugins.example.test"


def _timestamp(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _digest_bytes(value: bytes) -> str:
    import hashlib

    return f"sha256:{hashlib.sha256(value).hexdigest()}"


def _public_bytes(private_key: Ed25519PrivateKey) -> bytes:
    return private_key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )


def _sign(private_key: Ed25519PrivateKey, value: dict[str, Any]) -> str:
    return encode_base64url(private_key.sign(canonical_dumps(value).encode("utf-8")))


def build_marketplace_bundle(
    directory: Path,
    *,
    version: str = "0.1.0",
    dependency_license: str = "Apache-2.0",
) -> PlatformBundleFixture:
    fixture = build_hello_platform_bundle(directory / "base", version=version)
    sbom_path = fixture.source_directory / "sbom" / "cyclonedx.json"
    sbom = json.loads(sbom_path.read_text(encoding="utf-8"))
    sbom["metadata"] = {
        "component": {
            "type": "application",
            "name": fixture.manifest["plugin"]["id"],
            "version": version,
            "licenses": [{"expression": fixture.manifest["plugin"]["license"]}],
        }
    }
    for component in sbom["components"]:
        component["licenses"] = [{"expression": dependency_license}]
    sbom_path.write_text(json.dumps(sbom, indent=2), encoding="utf-8")
    bundle = build_platform_bundle(
        fixture.source_directory,
        directory / f"hello-command-{version}.cspkg",
        operating_systems=("linux", "macos", "windows"),
        architectures=("arm64", "x86_64"),
    )
    return PlatformBundleFixture(
        bundle,
        fixture.source_directory,
        fixture.wheel_path,
        fixture.manifest,
    )


@dataclass(slots=True)
class SignedMarketplaceBuilder:
    root_private_key: Ed25519PrivateKey
    publisher_private_key: Ed25519PrivateKey
    releases: list[dict[str, Any]]

    @classmethod
    def create(cls) -> "SignedMarketplaceBuilder":
        return cls(
            Ed25519PrivateKey.generate(),
            Ed25519PrivateKey.generate(),
            [],
        )

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
            "displayName": "CandleScope Community",
            "keyId": key_id(public),
            "publicKey": encode_base64url(public),
            "status": "active",
        }

    def add_release(
        self,
        bundle: VerifiedPlatformBundle,
        *,
        published_at: datetime | None = None,
        dependency_license: str = "Apache-2.0",
    ) -> dict[str, Any]:
        published = published_at or datetime(2026, 7, 20, 0, 0, tzinfo=UTC)
        file_name = bundle.path.name
        sbom_sha256 = next(
            item.sha256
            for item in bundle.envelope.contents
            if item.path == "sbom/cyclonedx.json"
        )
        statement = {
            "pluginId": bundle.manifest.plugin.id,
            "version": bundle.manifest.plugin.version,
            "publisherId": PUBLISHER_ID,
            "artifact": {
                "fileName": file_name,
                "url": f"{SOURCE_ORIGIN}/artifacts/{file_name}",
                "sha256": bundle.sha256,
                "size": bundle.size,
                "manifestSha256": bundle.manifest_sha256,
                "sbomSha256": sbom_sha256,
            },
            "publishedAt": _timestamp(published),
            "licenseExpression": bundle.manifest.plugin.license,
            "dependencies": sorted(
                [
                    {
                        "name": item.package.replace("_", "-").lower(),
                        "version": item.version,
                        "licenseExpression": dependency_license,
                    }
                    for item in bundle.wheels
                ],
                key=lambda item: (item["name"], item["version"]),
            ),
            "sha256Sums": (f"{bundle.sha256.removeprefix('sha256:')}  {file_name}\n"),
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
        generated = generated_at or datetime(2026, 7, 23, 1, 0, tzinfo=UTC)
        expires = expires_at or generated + timedelta(days=30)
        release_values = copy.deepcopy(self.releases if releases is None else releases)
        body = {
            "schemaVersion": "candlescope.marketplace-index/1",
            "marketplace": {
                "id": MARKETPLACE_ID,
                "sequence": sequence,
                "generatedAt": _timestamp(generated),
                "expiresAt": _timestamp(expires),
                "previousIndexSha256": previous_index_sha256,
                "sourceOrigin": SOURCE_ORIGIN,
                "transparencyHeadSha256": (
                    release_values[-1]["transparency"]["recordSha256"]
                    if release_values
                    else ZERO_SHA256
                ),
            },
            "publishers": [self.publisher],
            "releases": release_values,
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
