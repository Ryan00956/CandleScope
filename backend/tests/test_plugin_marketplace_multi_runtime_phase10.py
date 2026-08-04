from __future__ import annotations

from datetime import UTC, datetime

import pytest

from app.plugin_marketplace_v2 import MarketplaceError
from app.plugin_marketplace_v2.models import verify_marketplace_index
from tests.plugin_marketplace_phase10_testkit import SignedMarketplaceV2Builder
from tests.plugin_marketplace_testkit import build_marketplace_bundle


NOW = datetime(2026, 8, 3, 1, 0, tzinfo=UTC)


def test_v2_verifies_independent_platform_signature_and_supply_evidence(
    tmp_path,
) -> None:
    fixture = build_marketplace_bundle(tmp_path / "bundle")
    builder = SignedMarketplaceV2Builder.create()
    builder.add_release(fixture.bundle)

    index = verify_marketplace_index(builder.index_bytes(), root=builder.root, now=NOW)

    release = index.releases[0]
    artifact = release.artifact_for_platform("windows", "x86_64")
    assert index.schema_version == "candlescope.marketplace-index/2"
    assert artifact.sha256 == fixture.bundle.sha256
    assert artifact.runtime_kinds == ("python-module",)
    assert artifact.review_policy.distribution == "prebuilt-only"
    assert release.minimum_host_version == "0.4.0"
    assert release.rollout_stage == "stable"
    assert release.official_maintained is True
    assert index.publisher_by_id()[release.publisher_id].verification_tier == "official"


def test_v2_artifact_signature_cannot_be_replaced_by_index_signature(tmp_path) -> None:
    fixture = build_marketplace_bundle(tmp_path / "bundle")
    builder = SignedMarketplaceV2Builder.create()
    builder.add_release(fixture.bundle)
    document = builder.index_document()
    document["releases"][0]["artifacts"][0]["size"] += 1

    with pytest.raises(MarketplaceError) as failure:
        verify_marketplace_index(
            builder.resign_index(document),
            root=builder.root,
            now=NOW,
        )

    assert failure.value.code == "PLUGIN_MARKETPLACE_SIGNATURE_INVALID"


@pytest.mark.parametrize(
    "field",
    ["sourceBuild", "systemRuntimeFallback", "undeclaredDownloads"],
)
def test_v2_rejects_unsafe_distribution_policy_before_install(
    tmp_path,
    field: str,
) -> None:
    fixture = build_marketplace_bundle(tmp_path / field)
    builder = SignedMarketplaceV2Builder.create()
    builder.add_release(fixture.bundle)
    document = builder.index_document()
    document["releases"][0]["artifacts"][0]["reviewPolicy"][field] = True

    with pytest.raises(MarketplaceError) as failure:
        verify_marketplace_index(
            builder.resign_index(document),
            root=builder.root,
            now=NOW,
        )

    assert failure.value.code == "PLUGIN_MARKETPLACE_REVIEW_POLICY_DENIED"


def test_v2_rejects_system_runtime_fallback_binding(tmp_path) -> None:
    fixture = build_marketplace_bundle(tmp_path / "bundle")
    builder = SignedMarketplaceV2Builder.create()
    builder.add_release(fixture.bundle)
    document = builder.index_document()
    binding = document["releases"][0]["artifacts"][0]["runtimeBindings"][0]
    binding["supplySource"] = "system"

    with pytest.raises(MarketplaceError) as failure:
        verify_marketplace_index(
            builder.resign_index(document),
            root=builder.root,
            now=NOW,
        )

    assert failure.value.code == "PLUGIN_MARKETPLACE_REVIEW_POLICY_DENIED"


def test_v2_runtime_registry_revocation_blocks_release(tmp_path) -> None:
    fixture = build_marketplace_bundle(tmp_path / "bundle")
    builder = SignedMarketplaceV2Builder.create()
    wheel = fixture.bundle.wheels[0]
    content = next(
        item for item in fixture.bundle.envelope.contents if item.path == wheel.path
    )
    registry_sha256 = "sha256:" + ("7" * 64)
    builder.add_release(
        fixture.bundle,
        runtime_bindings=[
            {
                "entrypointId": "main",
                "runtimeKind": "java-jar",
                "runtimeId": "temurin-26.0.2.10",
                "pluginArtifactPath": content.path,
                "pluginArtifactSha256": content.sha256,
                "supplySource": "host-managed",
                "hostRuntime": {
                    "registryId": "candlescope.official",
                    "registryRevision": 5,
                    "registrySha256": registry_sha256,
                    "runtimeArtifactSha256": "sha256:" + ("8" * 64),
                    "licenseExpression": "GPL-2.0-only WITH Classpath-exception-2.0",
                },
            }
        ],
    )
    index = verify_marketplace_index(
        builder.index_bytes(
            revocations=[
                {
                    "scope": "runtime-registry",
                    "subject": registry_sha256,
                    "reasonCode": "RUNTIME_REGISTRY_COMPROMISED",
                    "effectiveAt": "2026-08-02T00:00:00Z",
                }
            ]
        ),
        root=builder.root,
        now=NOW,
    )

    assert index.is_revoked(index.releases[0], now=NOW) is True


def test_v1_index_contract_remains_accepted(tmp_path) -> None:
    from tests.plugin_marketplace_testkit import SignedMarketplaceBuilder

    fixture = build_marketplace_bundle(tmp_path / "legacy")
    builder = SignedMarketplaceBuilder.create()
    builder.add_release(fixture.bundle)

    index = verify_marketplace_index(builder.index_bytes(), root=builder.root, now=NOW)

    assert index.schema_version == "candlescope.marketplace-index/1"
    assert index.releases[0].artifact.sha256 == fixture.bundle.sha256
