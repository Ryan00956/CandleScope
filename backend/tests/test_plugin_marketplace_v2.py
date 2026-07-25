from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime, timedelta

import pytest

from app.plugin_installer_v2 import PlatformPluginInstaller
from app.plugin_installer_v2.registry import load_activation_registry
from app.plugin_marketplace_v2 import (
    MarketplaceError,
    PinnedMarketplaceFetcher,
    PluginMarketplaceService,
)
from app.plugin_marketplace_v2.models import _SEMVER, verify_marketplace_index
from app.plugin_marketplace_v2.service import (
    MAX_REMOTE_ARTIFACT_BYTES,
    _version_key,
)
from tests.plugin_marketplace_testkit import (
    MARKETPLACE_ID,
    PUBLISHER_ID,
    SignedMarketplaceBuilder,
    build_marketplace_bundle,
)


NOW = datetime(2026, 7, 23, 2, 0, tzinfo=UTC)


def test_marketplace_versions_follow_semver_precedence() -> None:
    assert _SEMVER.fullmatch("1.0.0-1alpha+build.01") is not None
    assert _SEMVER.fullmatch("1.0.0-01") is None
    assert _SEMVER.fullmatch("01.0.0") is None
    assert _version_key("1.0.0-beta.2") < _version_key("1.0.0-beta.10")
    assert _version_key("1.0.0-beta.10") < _version_key("1.0.0-rc.1")
    assert _version_key("1.0.0-rc.1") < _version_key("1.0.0")
    assert _version_key("1.0.0+build.1") == _version_key("1.0.0+build.2")


def test_public_catalog_marks_oversized_remote_artifacts_uninstallable(
    tmp_path,
) -> None:
    fixture = build_marketplace_bundle(tmp_path / "bundle")
    builder = SignedMarketplaceBuilder.create()
    builder.add_release(fixture.bundle)
    _installer, service = _service(tmp_path, builder)
    service.import_index(builder.index_bytes(), marketplace_id=MARKETPLACE_ID)

    verified = service._indexes[MARKETPLACE_ID]
    release = verified.releases[0]
    oversized = replace(
        release,
        artifact=replace(
            release.artifact,
            size=MAX_REMOTE_ARTIFACT_BYTES + 1,
        ),
    )
    service._indexes[MARKETPLACE_ID] = replace(
        verified,
        releases=(oversized,),
    )

    entry = service.public_catalog()["plugins"][0]
    assert entry["latest"]["artifact"]["size"] == MAX_REMOTE_ARTIFACT_BYTES + 1
    assert entry["installable"] is False


def _service(tmp_path, builder: SignedMarketplaceBuilder):
    installer = PlatformPluginInstaller(root=tmp_path / "managed")
    service = PluginMarketplaceService(
        root=tmp_path / "managed",
        installer=installer,
        roots=(builder.root,),
        enabled=True,
    )
    installer.publisher_identity_resolver = lambda bundle: (
        service.bundle_trust(
            bundle,
            fallback_trust_level="local-trusted",
        ).publisher_identity
    )
    installer.execution_trust_resolver = lambda bundle: (
        "untrusted"
        if service.bundle_trust(
            bundle,
            fallback_trust_level="local-trusted",
        ).trust_level
        == "verified-publisher"
        else "local-trusted"
    )
    return installer, service


def test_index_verifies_root_publisher_release_and_transparency(tmp_path) -> None:
    fixture = build_marketplace_bundle(tmp_path / "bundle")
    builder = SignedMarketplaceBuilder.create()
    builder.add_release(fixture.bundle)
    verified = verify_marketplace_index(
        builder.index_bytes(),
        root=builder.root,
        now=NOW,
    )
    assert verified.marketplace_id == MARKETPLACE_ID
    assert verified.releases[0].artifact.sha256 == fixture.bundle.sha256
    assert verified.publisher_by_id()[PUBLISHER_ID].key_id.startswith("ed25519:")
    assert not verified.is_revoked(verified.releases[0], now=NOW)


def test_marketplace_fetcher_revalidates_injected_dns_results() -> None:
    fetcher = PinnedMarketplaceFetcher(
        resolver=lambda _host, _port: ("127.0.0.1",),
    )
    with pytest.raises(MarketplaceError) as failure:
        fetcher.get(
            "https://plugins.example.test/index.json",
            maximum=1024,
        )
    assert failure.value.code == "PLUGIN_MARKETPLACE_PRIVATE_ADDRESS_DENIED"


@pytest.mark.parametrize(
    ("mutation", "code"),
    [
        (
            lambda document: document["releases"][0]["artifact"].__setitem__(
                "size", document["releases"][0]["artifact"]["size"] + 1
            ),
            "PLUGIN_MARKETPLACE_SIGNATURE_INVALID",
        ),
        (
            lambda document: document["releases"][0]["transparency"].__setitem__(
                "leafSha256", "sha256:" + ("a" * 64)
            ),
            "PLUGIN_MARKETPLACE_TRANSPARENCY_INVALID",
        ),
        (
            lambda document: document["marketplace"].__setitem__(
                "transparencyHeadSha256", "sha256:" + ("b" * 64)
            ),
            "PLUGIN_MARKETPLACE_TRANSPARENCY_INVALID",
        ),
    ],
)
def test_index_rejects_release_and_transparency_mismatch(
    tmp_path,
    mutation,
    code,
) -> None:
    fixture = build_marketplace_bundle(tmp_path / "bundle")
    builder = SignedMarketplaceBuilder.create()
    builder.add_release(fixture.bundle)
    document = builder.index_document()
    mutation(document)
    data = builder.resign_index(document)
    with pytest.raises(MarketplaceError) as failure:
        verify_marketplace_index(data, root=builder.root, now=NOW)
    assert failure.value.code == code


def test_index_chain_is_append_only_and_rejects_in_place_replacement(tmp_path) -> None:
    first = build_marketplace_bundle(tmp_path / "first", version="0.1.0")
    second = build_marketplace_bundle(tmp_path / "second", version="0.2.0")
    builder = SignedMarketplaceBuilder.create()
    builder.add_release(first.bundle)
    _installer, service = _service(tmp_path, builder)
    first_result = service.import_index(
        builder.index_bytes(),
        marketplace_id=MARKETPLACE_ID,
    )
    assert first_result["changed"] is True
    first_digest = first_result["indexSha256"]

    replacement = builder.index_document()
    replacement["marketplace"]["expiresAt"] = "2026-08-20T01:00:00Z"
    replacement_bytes = builder.resign_index(replacement)
    with pytest.raises(MarketplaceError) as failure:
        service.import_index(replacement_bytes, marketplace_id=MARKETPLACE_ID)
    assert failure.value.code == "PLUGIN_MARKETPLACE_IMMUTABILITY_VIOLATION"

    builder.add_release(second.bundle)
    second_result = service.import_index(
        builder.index_bytes(
            sequence=2,
            previous_index_sha256=first_digest,
        ),
        marketplace_id=MARKETPLACE_ID,
    )
    assert second_result["sequence"] == 2
    assert second_result["releaseCount"] == 2


def test_prepare_verifies_bundle_sbom_licenses_and_stages_without_activation(
    tmp_path,
) -> None:
    fixture = build_marketplace_bundle(tmp_path / "bundle")
    builder = SignedMarketplaceBuilder.create()
    builder.add_release(fixture.bundle)
    installer, service = _service(tmp_path, builder)
    service.import_index(builder.index_bytes(), marketplace_id=MARKETPLACE_ID)

    candidate = service.prepare(
        fixture.bundle.manifest.plugin.id,
        version=fixture.bundle.manifest.plugin.version,
        artifact_bytes=fixture.bundle.path.read_bytes(),
    )
    assert candidate["phase"] == "verified-staged"
    assert candidate["compatibility"]["verified"] is True
    assert candidate["migration"]["policy"] == "same-major-only"
    assert installer.list_plugins() == ()

    trust = service.bundle_trust(
        fixture.bundle,
        fallback_trust_level="local-trusted",
    )
    assert trust.trust_level == "verified-publisher"
    assert trust.publisher_identity.startswith("publisher-key:ed25519:")


def test_prepare_rejects_signed_sbom_license_mismatch(tmp_path) -> None:
    fixture = build_marketplace_bundle(tmp_path / "bundle")
    builder = SignedMarketplaceBuilder.create()
    builder.add_release(fixture.bundle, dependency_license="MIT")
    _installer, service = _service(tmp_path, builder)
    service.import_index(builder.index_bytes(), marketplace_id=MARKETPLACE_ID)

    with pytest.raises(MarketplaceError) as failure:
        service.prepare(
            fixture.bundle.manifest.plugin.id,
            artifact_bytes=fixture.bundle.path.read_bytes(),
        )
    assert failure.value.code == "PLUGIN_MARKETPLACE_SBOM_DEPENDENCY_MISMATCH"


def test_verified_backend_apply_requires_os_sandbox_before_probe(tmp_path) -> None:
    fixture = build_marketplace_bundle(tmp_path / "bundle")
    builder = SignedMarketplaceBuilder.create()
    builder.add_release(fixture.bundle)
    _installer, service = _service(tmp_path, builder)
    service.import_index(builder.index_bytes(), marketplace_id=MARKETPLACE_ID)
    service.prepare(
        fixture.bundle.manifest.plugin.id,
        artifact_bytes=fixture.bundle.path.read_bytes(),
    )
    with pytest.raises(Exception, match="OS sandbox"):
        service.apply(fixture.bundle.manifest.plugin.id)
    assert service.status()["candidates"][0]["phase"] == "verified-staged"


def test_apply_state_write_failure_restores_previous_active_activation(
    tmp_path,
) -> None:
    initial = build_marketplace_bundle(
        tmp_path / "initial",
        version="0.1.0",
        required_permission=True,
    )
    update = build_marketplace_bundle(
        tmp_path / "update",
        version="0.2.0",
        required_permission=True,
        required_symbols=("BTCUSDT", "ETHUSDT"),
    )
    builder = SignedMarketplaceBuilder.create()
    builder.add_release(initial.bundle)
    builder.add_release(update.bundle)
    installer, service = _service(tmp_path, builder)
    installer.execution_trust_resolver = lambda _bundle: "local-trusted"
    service.import_index(builder.index_bytes(), marketplace_id=MARKETPLACE_ID)
    installed = installer.install(
        initial.bundle.path,
        expected_sha256=initial.bundle.sha256,
        enabled=True,
    )
    assert installed.state == "staged"
    installer.grant_permission(
        installed.plugin_id,
        "market.bars.read",
        scope={"symbols": ["BTCUSDT"]},
    )
    assert installer.enable(installed.plugin_id).state == "active"
    service.prepare(
        update.bundle.manifest.plugin.id,
        version=update.bundle.manifest.plugin.version,
        artifact_bytes=update.bundle.path.read_bytes(),
    )
    active_before = load_activation_registry(installer.registry_path).by_id()[
        initial.bundle.manifest.plugin.id
    ]
    grants_before = installer.permission_summary(initial.bundle.manifest.plugin.id)[0]
    original_commit_state = service._commit_state

    def fail_candidate_commit(_state) -> None:
        raise OSError("simulated marketplace candidate state write failure")

    service._commit_state = fail_candidate_commit
    try:
        with pytest.raises(
            OSError, match="simulated marketplace candidate state write failure"
        ):
            service.apply(update.bundle.manifest.plugin.id)
    finally:
        service._commit_state = original_commit_state

    active = load_activation_registry(installer.registry_path).by_id()[
        initial.bundle.manifest.plugin.id
    ]
    assert active == active_before
    restored_grant = installer.permission_summary(initial.bundle.manifest.plugin.id)[0]
    assert restored_grant["permissions"][0]["decision"] == "granted"
    assert restored_grant["permissions"][0]["grantedScope"] == {"symbols": ["BTCUSDT"]}
    assert {
        key: value for key, value in restored_grant.items() if key != "storeRevision"
    } == {key: value for key, value in grants_before.items() if key != "storeRevision"}
    assert active.version == "0.1.0"
    assert active.state == "active"
    assert service.status()["candidates"][0]["phase"] == "verified-staged"


def test_marketplace_cannot_override_local_activation(tmp_path) -> None:
    local = build_marketplace_bundle(tmp_path / "local", version="0.1.0")
    update = build_marketplace_bundle(tmp_path / "update", version="0.2.0")
    builder = SignedMarketplaceBuilder.create()
    builder.add_release(update.bundle)
    installer, service = _service(tmp_path, builder)
    service.record_local_bundle(local.bundle)
    installer.install(
        local.bundle.path,
        expected_sha256=local.bundle.sha256,
        enabled=True,
    )
    service.import_index(builder.index_bytes(), marketplace_id=MARKETPLACE_ID)
    with pytest.raises(MarketplaceError) as failure:
        service.prepare(
            update.bundle.manifest.plugin.id,
            artifact_bytes=update.bundle.path.read_bytes(),
        )
    assert failure.value.code == "PLUGIN_MARKETPLACE_ACTIVATION_OWNED"


def test_revocation_is_append_only_and_disables_without_deleting_installation(
    tmp_path,
) -> None:
    fixture = build_marketplace_bundle(tmp_path / "bundle")
    builder = SignedMarketplaceBuilder.create()
    builder.add_release(fixture.bundle)
    installer = PlatformPluginInstaller(root=tmp_path / "managed")
    installed = installer.install(
        fixture.bundle.path,
        expected_sha256=fixture.bundle.sha256,
        enabled=True,
    )
    service = PluginMarketplaceService(
        root=tmp_path / "managed",
        installer=installer,
        roots=(builder.root,),
        enabled=True,
    )
    first = service.import_index(
        builder.index_bytes(),
        marketplace_id=MARKETPLACE_ID,
    )
    revocation = {
        "scope": "release",
        "subject": fixture.bundle.sha256,
        "reasonCode": "MALICIOUS_RELEASE",
        "effectiveAt": "2026-07-22T01:30:00Z",
    }
    service.import_index(
        builder.index_bytes(
            sequence=2,
            previous_index_sha256=first["indexSha256"],
            revocations=[revocation],
        ),
        marketplace_id=MARKETPLACE_ID,
    )
    assert service.enforce_trust_policy() == (fixture.bundle.manifest.plugin.id,)
    record = installer.list_plugins()[0]
    assert record["state"] == "disabled"
    assert installed.installation_path.is_dir()
    public_entry = service.public_catalog()["plugins"][0]
    assert public_entry["latest"]["revoked"] is True
    assert public_entry["installable"] is False

    rollback_document = builder.index_document(
        sequence=3,
        previous_index_sha256=service._indexes[MARKETPLACE_ID].index_sha256,
        revocations=[],
    )
    with pytest.raises(MarketplaceError) as failure:
        service.import_index(
            builder.resign_index(rollback_document),
            marketplace_id=MARKETPLACE_ID,
        )
    assert failure.value.code == "PLUGIN_MARKETPLACE_REVOCATION_ROLLBACK"


def test_expired_cache_cannot_authorize_offline_verified_activation(tmp_path) -> None:
    fixture = build_marketplace_bundle(tmp_path / "bundle")
    builder = SignedMarketplaceBuilder.create()
    builder.add_release(fixture.bundle)
    _installer, service = _service(tmp_path, builder)
    service.import_index(
        builder.index_bytes(
            generated_at=datetime.now(UTC) - timedelta(days=1),
            expires_at=datetime.now(UTC) + timedelta(seconds=1),
        ),
        marketplace_id=MARKETPLACE_ID,
    )
    current = service._indexes[MARKETPLACE_ID]
    expired_at = datetime.now(UTC) - timedelta(seconds=1)
    service._indexes[MARKETPLACE_ID] = replace(
        current,
        expires_at=expired_at.isoformat().replace("+00:00", "Z"),
        expires_datetime=expired_at,
    )

    status = service.status()
    assert status["validCacheCount"] == 0
    assert status["cacheErrors"][MARKETPLACE_ID] == "PLUGIN_MARKETPLACE_INDEX_EXPIRED"
    assert service.public_catalog()["plugins"] == []
    with pytest.raises(MarketplaceError) as failure:
        service.bundle_trust(
            fixture.bundle,
            fallback_trust_level="local-trusted",
        )
    assert failure.value.code == "PLUGIN_MARKETPLACE_OFFLINE_CACHE_INVALID"


def test_missing_build_pinned_root_cannot_downgrade_signed_candidate_to_local(
    tmp_path,
) -> None:
    fixture = build_marketplace_bundle(tmp_path / "bundle")
    builder = SignedMarketplaceBuilder.create()
    builder.add_release(fixture.bundle)
    installer, service = _service(tmp_path, builder)
    service.import_index(builder.index_bytes(), marketplace_id=MARKETPLACE_ID)
    service.prepare(
        fixture.bundle.manifest.plugin.id,
        artifact_bytes=fixture.bundle.path.read_bytes(),
    )

    installer.publisher_identity_resolver = None
    installer.execution_trust_resolver = None
    installed = installer.install(
        fixture.bundle.path,
        expected_sha256=fixture.bundle.sha256,
        enabled=True,
    )
    unavailable = PluginMarketplaceService(
        root=tmp_path / "managed",
        installer=installer,
        roots=(),
        enabled=False,
    )

    with pytest.raises(MarketplaceError) as failure:
        unavailable.bundle_trust(
            fixture.bundle,
            fallback_trust_level="local-trusted",
        )
    assert failure.value.code == "PLUGIN_MARKETPLACE_OFFLINE_CACHE_INVALID"
    assert unavailable.enforce_trust_policy() == (fixture.bundle.manifest.plugin.id,)
    assert installer.list_plugins()[0]["state"] == "disabled"
    assert installed.installation_path.is_dir()
