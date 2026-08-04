from __future__ import annotations

from datetime import UTC, datetime

import pytest

from app.plugin_installer_v2 import PlatformPluginInstaller
from app.plugin_core_v2.runtime import CorePluginPlatform
from app.plugin_marketplace_v2 import MarketplaceError, PluginMarketplaceService
from app.plugin_runtime_registry_v3 import (
    OFFICIAL_REGISTRY_V3_PATH,
    OFFICIAL_REGISTRY_V5_PATH,
    OFFICIAL_ROOTS_PATH,
    RuntimeRegistryError,
    build_official_runtime_registry,
    load_runtime_registry_roots_bytes,
    verify_runtime_registry_bytes,
)
from tests.plugin_marketplace_phase10_testkit import SignedMarketplaceV2Builder
from tests.plugin_marketplace_testkit import MARKETPLACE_ID, build_marketplace_bundle
from tests.plugin_platform_bundle_testkit import build_scheduled_notification_bundle


def _service(
    tmp_path,
    builder: SignedMarketplaceV2Builder,
    *,
    rollout_stage: str = "stable",
    telemetry_enabled: bool = False,
) -> PluginMarketplaceService:
    installer = PlatformPluginInstaller(root=tmp_path / "managed")
    return PluginMarketplaceService(
        root=tmp_path / "managed",
        installer=installer,
        roots=(builder.root,),
        enabled=True,
        operating_system="windows",
        architecture="x86_64",
        rollout_stage=rollout_stage,
        telemetry_enabled=telemetry_enabled,
    )


def test_v2_catalog_separates_publisher_official_sandbox_and_permissions(
    tmp_path,
) -> None:
    fixture = build_marketplace_bundle(
        tmp_path / "bundle",
        required_permission=True,
    )
    builder = SignedMarketplaceV2Builder.create()
    builder.add_release(fixture.bundle)
    service = _service(tmp_path, builder)
    service.import_index(builder.index_bytes(), marketplace_id=MARKETPLACE_ID)

    catalog = service.public_catalog()
    entry = catalog["plugins"][0]

    assert catalog["schemaVersion"] == "candlescope.marketplace-catalog/2"
    assert catalog["rollout"]["channel"] == "stable"
    assert entry["publisher"]["verificationTier"] == "official"
    assert entry["assurances"]["publisherVerified"] is True
    assert entry["assurances"]["officialMaintained"] is True
    assert entry["assurances"]["sandbox"]["available"] is True
    assert entry["assurances"]["sandbox"]["runtimeKinds"] == ["python-module"]
    assert entry["assurances"]["permissions"]["required"][0]["id"] == (
        "market.bars.read"
    )
    assert entry["installable"] is True


def test_v2_prepare_uses_verified_offline_cache_and_opt_in_aggregate_telemetry(
    tmp_path,
) -> None:
    fixture = build_marketplace_bundle(tmp_path / "bundle")
    builder = SignedMarketplaceV2Builder.create()
    builder.add_release(fixture.bundle)
    service = _service(tmp_path, builder, telemetry_enabled=True)
    service.import_index(builder.index_bytes(), marketplace_id=MARKETPLACE_ID)

    first = service.prepare(
        fixture.bundle.manifest.plugin.id,
        artifact_bytes=fixture.bundle.path.read_bytes(),
    )
    repeat = service.prepare(fixture.bundle.manifest.plugin.id)
    status = service.status()

    assert first["compatibility"]["cacheReuse"] is False
    assert repeat["compatibility"]["cacheReuse"] is True
    assert status["schemaVersion"] == "candlescope.marketplace-status/2"
    assert status["telemetry"]["enabled"] is True
    assert status["telemetry"]["uploadEnabled"] is False
    assert status["telemetry"]["privacy"] == {
        "identifiers": False,
        "strategyInputs": False,
        "accounts": False,
        "pluginPrivateData": False,
    }
    assert {
        (item["runtimeKind"], item["operation"], item["count"])
        for item in status["telemetry"]["counters"]
    } == {
        ("python-module", "cache-reuse", 1),
        ("python-module", "prepare", 2),
    }


def test_v2_rollout_and_minimum_host_are_enforced_before_download(tmp_path) -> None:
    preview_fixture = build_marketplace_bundle(tmp_path / "preview")
    preview_builder = SignedMarketplaceV2Builder.create()
    preview_builder.add_release(preview_fixture.bundle, rollout_stage="preview")
    stable = _service(tmp_path / "stable", preview_builder, rollout_stage="stable")
    stable.import_index(
        preview_builder.index_bytes(),
        marketplace_id=MARKETPLACE_ID,
    )
    assert stable.public_catalog()["plugins"] == []

    preview = _service(tmp_path / "opted-in", preview_builder, rollout_stage="preview")
    preview.import_index(
        preview_builder.index_bytes(),
        marketplace_id=MARKETPLACE_ID,
    )
    assert len(preview.public_catalog()["plugins"]) == 1

    future_fixture = build_marketplace_bundle(tmp_path / "future")
    future_builder = SignedMarketplaceV2Builder.create()
    future_builder.add_release(future_fixture.bundle, minimum_host_version="0.5.0")
    future = _service(tmp_path / "future-service", future_builder)
    future.import_index(future_builder.index_bytes(), marketplace_id=MARKETPLACE_ID)
    assert future.public_catalog()["plugins"][0]["installable"] is False
    with pytest.raises(MarketplaceError) as failure:
        future.prepare(
            future_fixture.bundle.manifest.plugin.id,
            artifact_bytes=future_fixture.bundle.path.read_bytes(),
        )
    assert failure.value.code == "PLUGIN_MARKETPLACE_RELEASE_NOT_FOUND"


def test_signed_revocation_quarantines_cached_candidate_without_deleting_install(
    tmp_path,
) -> None:
    fixture = build_marketplace_bundle(tmp_path / "bundle")
    builder = SignedMarketplaceV2Builder.create()
    builder.add_release(fixture.bundle)
    service = _service(tmp_path, builder, telemetry_enabled=True)
    imported = service.import_index(
        builder.index_bytes(),
        marketplace_id=MARKETPLACE_ID,
    )
    service.prepare(
        fixture.bundle.manifest.plugin.id,
        artifact_bytes=fixture.bundle.path.read_bytes(),
    )

    revocation = {
        "scope": "artifact",
        "subject": fixture.bundle.sha256,
        "reasonCode": "MALICIOUS_RELEASE",
        "effectiveAt": datetime(2026, 8, 2, tzinfo=UTC)
        .isoformat()
        .replace("+00:00", "Z"),
    }
    service.import_index(
        builder.index_bytes(
            sequence=2,
            previous_index_sha256=imported["indexSha256"],
            revocations=[revocation],
        ),
        marketplace_id=MARKETPLACE_ID,
    )

    assert service.enforce_trust_policy() == ()
    status = service.status()
    assert status["candidates"][0]["phase"] == "quarantined"
    assert status["quarantine"][0]["bundleSha256"] == fixture.bundle.sha256
    assert status["quarantine"][0]["payloadMoved"] is True
    assert not service._artifact_path(fixture.bundle.sha256).exists()
    assert fixture.bundle.path.is_file()


def test_runtime_registry_binding_requires_active_ancestry_and_exact_artifact(
    tmp_path,
) -> None:
    service = build_official_runtime_registry(
        root=tmp_path / "registry",
        enabled=True,
    )
    roots = load_runtime_registry_roots_bytes(OFFICIAL_ROOTS_PATH.read_bytes())
    revision3 = verify_runtime_registry_bytes(
        OFFICIAL_REGISTRY_V3_PATH.read_bytes(), roots
    )
    revision5 = verify_runtime_registry_bytes(
        OFFICIAL_REGISTRY_V5_PATH.read_bytes(), roots
    )
    runtime = next(
        item for item in revision3.runtimes if item.runtime_id == "temurin-26.0.2.10"
    )

    evidence = service.verify_marketplace_binding(
        registry_id=revision3.registry_id,
        registry_revision=revision3.revision,
        registry_sha256=revision3.sha256,
        runtime_id=runtime.runtime_id,
        runtime_kind=runtime.kind,
        runtime_artifact_sha256=runtime.sha256,
        license_expression=runtime.license_spdx,
        operating_system=runtime.operating_system,
        architecture=runtime.architecture,
    )
    assert evidence["verified"] is True
    assert evidence["activeRegistrySha256"] == revision5.sha256

    service.rollback_registry()
    with pytest.raises(RuntimeRegistryError) as failure:
        service.verify_marketplace_binding(
            registry_id=revision5.registry_id,
            registry_revision=revision5.revision,
            registry_sha256=revision5.sha256,
            runtime_id=runtime.runtime_id,
            runtime_kind=runtime.kind,
            runtime_artifact_sha256=runtime.sha256,
            license_expression=runtime.license_spdx,
            operating_system=runtime.operating_system,
            architecture=runtime.architecture,
        )
    assert failure.value.code == "PLUGIN_RUNTIME_REGISTRY_BINDING_INVALID"


@pytest.mark.anyio
async def test_health_observation_passes_effective_grants_through_authority(
    tmp_path,
) -> None:
    fixture = build_scheduled_notification_bundle(tmp_path / "bundle")
    root = tmp_path / "managed"
    installer = PlatformPluginInstaller(root=root, host_version="0.4.0")
    installed = installer.install(
        fixture.bundle.path,
        expected_sha256=fixture.bundle.sha256,
        enabled=False,
    )
    for permission in fixture.bundle.manifest.permissions.required:
        installer.grant_permission(
            installed.plugin_id,
            permission.id,
            scope=permission.scope,
            source="management-api",
        )
    installer.enable(installed.plugin_id)
    platform = CorePluginPlatform(
        root=root,
        host_name="CandleScope",
        host_version="0.4.0",
    )
    await platform.start()
    try:
        result = await platform.observe_plugin_health(installed.plugin_id)
        assert result[0]["entrypointId"] == "main"
        assert result[0]["health"]["status"] == "ready"
    finally:
        await platform.stop()
