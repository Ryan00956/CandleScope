from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from candlescope_plugin_sdk.platform_v2 import PluginManifest, canonical_sha256

from app.plugin_core_v2.runtime import CorePluginPlatform
from app.plugin_installer_v2.bundle import verify_platform_bundle
from app.plugin_runtime_registry_v3 import (
    OFFICIAL_REGISTRY_V2_PATH,
    OFFICIAL_REGISTRY_V3_PATH,
    OFFICIAL_ROOTS_V3_PATH,
    build_official_runtime_registry,
    load_runtime_registry_roots_bytes,
    verify_runtime_registry_bytes,
)
from app.plugin_security_v2 import AuditLog, GrantStore, PlatformSecurityError
from app.plugin_security_v2.grants import (
    GRANT_STORE_FILE_NAME,
    RUNTIME_BOUND_GRANT_STORE_SCHEMA_VERSION,
)
from app.plugin_security_v2.sandbox import (
    restricted_runtime_profile,
    restricted_runtime_profiles_status,
)
from app.plugin_security_v2.trust import (
    TRUST_ALIASES,
    PluginTrustService,
    TrustEvidence,
    canonical_trust_mode,
)
from tests.plugin_platform_bundle_testkit import (
    build_hello_platform_bundle,
    hello_platform_manifest,
)


def _digest(label: str) -> str:
    return canonical_sha256({"phase6": label})


def _manifest_with_permissions(*, required: list[dict[str, object]]) -> PluginManifest:
    value = hello_platform_manifest()
    value["permissions"] = {"required": required, "optional": []}
    value["probes"] = []
    return PluginManifest.from_wire(value)


def _python_executable() -> Path:
    executable = Path(sys.base_prefix) / (
        "python.exe" if os.name == "nt" else "bin/python"
    )
    assert executable.is_file()
    return executable


def _trust_service(
    root: Path,
    *,
    evidence: dict[str, TrustEvidence],
    enabled: bool = True,
) -> tuple[PluginTrustService, AuditLog]:
    audit = AuditLog(root / "audit" / "events")

    def resolve(bundle: object) -> TrustEvidence:
        return evidence[getattr(bundle, "sha256")]

    service = PluginTrustService(
        root=root / "trust",
        audit_log=audit,
        managed_runtime_registry=SimpleNamespace(),
        python_executable=_python_executable(),
        enabled=enabled,
        trust_evidence_resolver=resolve,
    )
    return service, audit


def test_phase6_freezes_aliases_and_runtime_profiles() -> None:
    assert TRUST_ALIASES == {
        "first-party-pinned": "first-party-pinned",
        "verified-publisher": "marketplace-sandboxed",
        "marketplace-sandboxed": "marketplace-sandboxed",
        "local-trusted": "trusted-local",
        "trusted-local": "trusted-local",
        "local-developer": "developer-local",
        "developer-local": "developer-local",
        "untrusted": "marketplace-sandboxed",
        "ui-only-untrusted": "ui-only-untrusted",
    }
    assert canonical_trust_mode("verified-publisher") == "marketplace-sandboxed"
    assert canonical_trust_mode("local-trusted") == "trusted-local"

    statuses = restricted_runtime_profiles_status(platform_name="windows")
    assert [item["runtimeKind"] for item in statuses] == [
        "java-jar",
        "native-executable",
        "node-module",
        "python-module",
    ]
    assert all(item["sandboxSupported"] is True for item in statuses)
    assert all(item["limits"]["maxProcesses"] == 1 for item in statuses)
    assert all(item["networkDefault"] == "denied" for item in statuses)
    unsupported = restricted_runtime_profiles_status(platform_name="linux")
    assert all(item["sandboxSupported"] is False for item in unsupported)
    assert all(item["trustedLocalOnly"] is True for item in unsupported)
    assert (
        restricted_runtime_profile("java-jar").memory_limit_bytes == 512 * 1024 * 1024
    )


def test_phase6_registry_migrates_java_to_appcontainer_compatible_jre(
    tmp_path: Path,
) -> None:
    roots = load_runtime_registry_roots_bytes(OFFICIAL_ROOTS_V3_PATH.read_bytes())
    revision_2 = verify_runtime_registry_bytes(
        OFFICIAL_REGISTRY_V2_PATH.read_bytes(), roots
    )
    revision_3 = verify_runtime_registry_bytes(
        OFFICIAL_REGISTRY_V3_PATH.read_bytes(), roots
    )
    releases = {item.runtime_id: item for item in revision_3.runtimes}

    assert OFFICIAL_REGISTRY_V3_PATH.name == "official-runtime-registry-v3.json"
    assert len(roots) == 3
    assert revision_3.revision == 3
    assert revision_3.previous_registry_sha256 == revision_2.sha256
    assert set(releases) == {
        "temurin-21.0.12.8",
        "temurin-25.0.4.7",
        "temurin-26.0.2.10",
    }
    release = releases["temurin-26.0.2.10"]
    assert release.version == "26.0.2+10"
    assert release.sha256 == (
        "sha256:4323e886b6320e2166072bdfd604a4236c3dba6e5ab289e10aef623f09d355a0"
    )
    assert release.size == 60_081_605
    assert release.file_count == 315
    assert release.extracted_size == 192_461_498
    assert release.legal_file_count == 179
    assert release.legal_size == 230_270

    service = build_official_runtime_registry(root=tmp_path / "registry", enabled=True)
    assert service.public_status()["active"]["revision"] == 5
    wasm_rolled = service.rollback_registry()
    assert wasm_rolled["fromRevision"] == 5
    assert wasm_rolled["toRevision"] == 4
    migrated = service.rollback_registry()
    assert migrated["fromRevision"] == 4
    assert migrated["toRevision"] == 3
    rolled = service.rollback_registry()
    assert rolled["changed"] is True
    assert rolled["fromRevision"] == 3
    assert rolled["toRevision"] == 2
    assert rolled["registrySha256"] == revision_2.sha256
    assert rolled["revocationsPreserved"] == []

    repository_root = Path(__file__).resolve().parents[2]
    example = repository_root / "examples" / "plugins" / "ta4j-elliott-adapter"
    manifest = json.loads((example / "manifest.json").read_text(encoding="utf-8"))
    lock = json.loads((example / "supply-chain.lock.json").read_text(encoding="utf-8"))
    runtime = manifest["backend"]["entrypoints"][0]["runtime"]
    assert manifest["plugin"]["version"] == "0.1.1"
    assert runtime["runtimeId"] == release.runtime_id
    assert lock["runtime"]["runtimeId"] == release.runtime_id
    assert lock["runtime"]["sha256"] == release.sha256
    assert lock["adapter"]["version"] == "0.1.0"


def test_runtime_bound_grants_migrate_only_the_exact_legacy_bundle(
    tmp_path: Path,
) -> None:
    audit = AuditLog(tmp_path / "audit" / "events")
    store = GrantStore(tmp_path / GRANT_STORE_FILE_NAME, audit_log=audit)
    manifest = _manifest_with_permissions(
        required=[
            {
                "id": "market.bars.read",
                "scope": {"symbols": ["BTCUSDT"], "maxHistoryBars": 500},
            }
        ]
    )
    bundle_sha256 = _digest("legacy-bundle")
    manifest_sha256 = _digest("legacy-manifest")
    authorization_v1 = _digest("authorization-v1")
    authorization_v2 = _digest("authorization-v2")

    store.reconcile(
        manifest,
        bundle_sha256=bundle_sha256,
        manifest_sha256=manifest_sha256,
    )
    store.grant(
        manifest,
        bundle_sha256=bundle_sha256,
        manifest_sha256=manifest_sha256,
        permission_id="market.bars.read",
    )
    assert store.load().schema_version == 1

    migrated = store.reconcile(
        manifest,
        bundle_sha256=bundle_sha256,
        manifest_sha256=manifest_sha256,
        authorization_identity=authorization_v1,
    )
    assert migrated.required_satisfied is True
    document = store.load()
    assert document.schema_version == RUNTIME_BOUND_GRANT_STORE_SCHEMA_VERSION
    record = document.by_id()[manifest.plugin.id]
    assert record.authorization_identity == authorization_v1
    assert record.permissions[0].decision == "granted"
    assert record.permissions[0].source == "inherit"

    changed = store.permission_diff(
        manifest,
        bundle_sha256=bundle_sha256,
        manifest_sha256=manifest_sha256,
        authorization_identity=authorization_v2,
    )
    assert changed.authorization_identity_changed is True
    assert changed.requires_confirmation is True
    assert changed.items[0].change == "identity-changed"
    reconciled = store.reconcile(
        manifest,
        bundle_sha256=bundle_sha256,
        manifest_sha256=manifest_sha256,
        authorization_identity=authorization_v2,
    )
    assert reconciled.required_satisfied is False
    assert (
        store.effective_grants(
            manifest,
            bundle_sha256=bundle_sha256,
            manifest_sha256=manifest_sha256,
            authorization_identity=authorization_v2,
        )
        == ()
    )

    state = json.loads(store.path.read_text(encoding="utf-8"))
    assert state["schemaVersion"] == 2
    assert state["plugins"][0]["authorizationIdentity"] == authorization_v2


def test_local_trust_requires_itemized_distinct_double_confirmation_and_binds_runtime(
    tmp_path: Path,
) -> None:
    fixture = build_hello_platform_bundle(tmp_path / "bundle")
    upload = tmp_path / "upload.cspkg"
    shutil.copyfile(fixture.bundle.path, upload)
    bundle = verify_platform_bundle(
        upload,
        expected_sha256=fixture.bundle.sha256,
        host_version="0.4.0",
    )
    local = TrustEvidence(
        "local-developer",
        "manifest:candlescope",
        "local-file",
    )
    evidence = {bundle.sha256: local}
    service, audit = _trust_service(tmp_path, evidence=evidence)
    authorization = service.build_authorization(bundle, local, mode="trusted-local")
    preview = service.build_preview(
        bundle=bundle,
        evidence=local,
        mode="trusted-local",
        permission_diff={
            "pluginId": bundle.manifest.plugin.id,
            "publisherIdentityChanged": False,
            "majorVersionChanged": False,
            "bundleChanged": True,
            "authorizationIdentityChanged": False,
            "requiresConfirmation": False,
            "items": [],
        },
        previous_bundle=None,
    )
    assert preview["authorization"] == authorization.to_wire()
    assert preview["authorization"]["entrypoints"][0]["systemRuntimePath"] == str(
        _python_executable().resolve(strict=False)
    )
    assert preview["requests"]["liveAuthority"] == {
        "grantedByTrust": False,
        "independentlyProtected": True,
    }

    prepared = service.prepare_local_install(
        upload_path=upload,
        bundle=bundle,
        preview=preview,
        user_action_id="phase6-prepare-1",
    )
    assert not upload.exists()
    assert audit.read_all()[-1].data["codeExecuted"] is False
    acknowledgements = prepared["preview"]["requiredAcknowledgements"]
    with pytest.raises(PlatformSecurityError) as incomplete:
        service.review_local_install(
            candidate_id=prepared["candidateId"],
            preview_sha256=prepared["previewSha256"],
            reason="I reviewed every exact local runtime and permission request.",
            acknowledgements=acknowledgements[:-1],
            actor="local-desktop-user",
            user_action_id="phase6-review-incomplete",
        )
    assert incomplete.value.code == "PLUGIN_TRUST_ACKNOWLEDGEMENT_INCOMPLETE"

    reviewed = service.review_local_install(
        candidate_id=prepared["candidateId"],
        preview_sha256=prepared["previewSha256"],
        reason="I reviewed every exact local runtime and permission request.",
        acknowledgements=acknowledgements,
        actor="local-desktop-user",
        user_action_id="phase6-review-1",
    )
    with pytest.raises(PlatformSecurityError) as same_action:
        service.claim_local_install(
            candidate_id=prepared["candidateId"],
            preview_sha256=prepared["previewSha256"],
            confirmation_token=reviewed["confirmationToken"],
            user_action_id="phase6-review-1",
        )
    assert same_action.value.code == "PLUGIN_TRUST_CONFIRMATION_INVALID"

    claim = service.claim_local_install(
        candidate_id=prepared["candidateId"],
        preview_sha256=prepared["previewSha256"],
        confirmation_token=reviewed["confirmationToken"],
        user_action_id="phase6-confirm-2",
    )
    with pytest.raises(PlatformSecurityError) as reused:
        service.claim_local_install(
            candidate_id=prepared["candidateId"],
            preview_sha256=prepared["previewSha256"],
            confirmation_token=reviewed["confirmationToken"],
            user_action_id="phase6-confirm-reuse",
        )
    assert reused.value.code == "PLUGIN_TRUST_CONFIRMATION_INVALID"

    previous = service.authorize_claimed_local_install(
        bundle=bundle,
        claim=claim,
        evidence=local,
    )
    assert previous is None
    assert service.resolve_authorization_identity(bundle) == (
        authorization.authorization_identity
    )
    service.finalize_local_install(claim=claim, plugin_id=bundle.manifest.plugin.id)
    assert not claim.path.exists()

    actions = [event.action for event in audit.read_all()]
    assert actions == [
        "install-prepare",
        "install-review",
        "install-confirm",
        "elevate",
        "install",
    ]
    confirm_event = audit.read_all()[2]
    assert confirm_event.data["reviewUserActionId"] == "phase6-review-1"
    assert confirm_event.data["confirmationUserActionId"] == "phase6-confirm-2"


def test_unconfirmed_local_bundle_is_rejected_before_semantic_probe(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = build_hello_platform_bundle(tmp_path / "bundle")
    platform = CorePluginPlatform(
        root=tmp_path / "managed",
        host_name="CandleScope",
        host_version="0.4.0",
        trust_ux_enabled=True,
    )
    create_calls = 0
    original = platform.installer._create_installation

    def counted_create(*args: object, **kwargs: object) -> object:
        nonlocal create_calls
        create_calls += 1
        return original(*args, **kwargs)

    monkeypatch.setattr(platform.installer, "_create_installation", counted_create)
    with pytest.raises(PlatformSecurityError) as denied:
        platform.installer.install(
            fixture.bundle.path,
            expected_sha256=fixture.bundle.sha256,
            enabled=True,
        )
    assert denied.value.code == "PLUGIN_TRUST_CONFIRMATION_REQUIRED"
    assert create_calls == 0
    assert not platform.installer.registry_path.exists()


def test_runtime_or_publisher_change_invalidates_exact_trust_decision(
    tmp_path: Path,
) -> None:
    fixture = build_hello_platform_bundle(tmp_path / "bundle")
    local = TrustEvidence("local-developer", "manifest:candlescope", "local-file")
    evidence = {fixture.bundle.sha256: local}
    service, _audit = _trust_service(tmp_path, evidence=evidence)
    authorization = service.build_authorization(
        fixture.bundle, local, mode="trusted-local"
    )
    with pytest.raises(PlatformSecurityError) as initial:
        service.resolve_authorization_identity(fixture.bundle)
    assert initial.value.code == "PLUGIN_TRUST_CONFIRMATION_REQUIRED"

    state = service._empty_state()
    state, _previous, _decision = service._record_decision_locked(
        state,
        bundle=fixture.bundle,
        evidence=local,
        authorization=authorization,
        reason="Exact local runtime identity was reviewed and accepted.",
        actor="local-desktop-user",
        user_action_id="phase6-confirm-seed",
        source="local-install-double-confirmation",
    )
    assert service.resolve_authorization_identity(fixture.bundle) == (
        authorization.authorization_identity
    )

    alternate_python = tmp_path / "alternate-python.exe"
    shutil.copyfile(_python_executable(), alternate_python)
    service.python_executable = alternate_python.resolve(strict=True)
    with pytest.raises(PlatformSecurityError) as runtime_changed:
        service.resolve_authorization_identity(fixture.bundle)
    assert runtime_changed.value.code == "PLUGIN_TRUST_BINDING_CHANGED"
    service.python_executable = _python_executable().resolve(strict=True)
    assert service.resolve_authorization_identity(fixture.bundle) == (
        authorization.authorization_identity
    )

    evidence[fixture.bundle.sha256] = TrustEvidence(
        "local-developer", "manifest:different-publisher", "local-file"
    )
    with pytest.raises(PlatformSecurityError) as changed:
        service.resolve_authorization_identity(fixture.bundle)
    assert changed.value.code == "PLUGIN_TRUST_BINDING_CHANGED"


def test_candidate_tamper_does_not_consume_single_use_confirmation(
    tmp_path: Path,
) -> None:
    fixture = build_hello_platform_bundle(tmp_path / "bundle")
    upload = tmp_path / "upload.cspkg"
    shutil.copyfile(fixture.bundle.path, upload)
    bundle = verify_platform_bundle(
        upload,
        expected_sha256=fixture.bundle.sha256,
        host_version="0.4.0",
    )
    local = TrustEvidence("local-developer", "manifest:candlescope", "local-file")
    service, _audit = _trust_service(tmp_path, evidence={bundle.sha256: local})
    preview = service.build_preview(
        bundle=bundle,
        evidence=local,
        mode="trusted-local",
        permission_diff={
            "pluginId": bundle.manifest.plugin.id,
            "publisherIdentityChanged": False,
            "majorVersionChanged": False,
            "bundleChanged": True,
            "authorizationIdentityChanged": False,
            "requiresConfirmation": False,
            "items": [],
        },
        previous_bundle=None,
    )
    prepared = service.prepare_local_install(
        upload_path=upload,
        bundle=bundle,
        preview=preview,
        user_action_id="phase6-tamper-prepare",
    )
    reviewed = service.review_local_install(
        candidate_id=prepared["candidateId"],
        preview_sha256=prepared["previewSha256"],
        reason="I reviewed the exact candidate before checking tamper recovery.",
        acknowledgements=preview["requiredAcknowledgements"],
        actor="local-desktop-user",
        user_action_id="phase6-tamper-review",
    )
    candidate_path = service._candidate_path(prepared["candidateId"])
    candidate_path.write_bytes(b"tampered")
    with pytest.raises(PlatformSecurityError) as tampered:
        service.claim_local_install(
            candidate_id=prepared["candidateId"],
            preview_sha256=prepared["previewSha256"],
            confirmation_token=reviewed["confirmationToken"],
            user_action_id="phase6-tamper-confirm-1",
        )
    assert tampered.value.code == "PLUGIN_TRUST_CANDIDATE_INVALID"

    shutil.copyfile(fixture.bundle.path, candidate_path)
    claim = service.claim_local_install(
        candidate_id=prepared["candidateId"],
        preview_sha256=prepared["previewSha256"],
        confirmation_token=reviewed["confirmationToken"],
        user_action_id="phase6-tamper-confirm-2",
    )
    assert claim.bundle_sha256 == fixture.bundle.sha256


def test_trust_never_unlocks_secrets_accounts_trading_or_live_authority(
    tmp_path: Path,
) -> None:
    manifest = _manifest_with_permissions(
        required=[{"id": "secrets.use", "scope": {"names": ["api-key"]}}]
    )
    store = GrantStore(
        tmp_path / GRANT_STORE_FILE_NAME,
        audit_log=AuditLog(tmp_path / "audit" / "events"),
    )
    bundle_sha256 = _digest("high-risk-bundle")
    manifest_sha256 = _digest("high-risk-manifest")
    authorization = _digest("trusted-local-authorization")
    store.reconcile(
        manifest,
        bundle_sha256=bundle_sha256,
        manifest_sha256=manifest_sha256,
        authorization_identity=authorization,
    )
    with pytest.raises(PlatformSecurityError) as unavailable:
        store.grant(
            manifest,
            bundle_sha256=bundle_sha256,
            manifest_sha256=manifest_sha256,
            authorization_identity=authorization,
            permission_id="secrets.use",
        )
    assert unavailable.value.code == "PLUGIN_PERMISSION_NOT_AVAILABLE"
    assert (
        store.effective_grants(
            manifest,
            bundle_sha256=bundle_sha256,
            manifest_sha256=manifest_sha256,
            authorization_identity=authorization,
        )
        == ()
    )


def test_java_and_node_sandbox_bind_exact_managed_runtime_root(
    tmp_path: Path,
) -> None:
    runtime_root = tmp_path / "managed-jre"
    runtime_root.mkdir()

    class Registry:
        def ensure(self, runtime_id: str, kind: str, *, offline: bool) -> object:
            assert (runtime_id, kind, offline) == ("temurin-25", "java", True)
            return SimpleNamespace(root=runtime_root)

    owner = SimpleNamespace(managed_runtime_registry=Registry())
    java = SimpleNamespace(kind="java-jar", runtime_id="temurin-25")
    assert CorePluginPlatform._sandbox_runtime_read_only_paths(owner, java) == (
        runtime_root.resolve(strict=True),
    )
    native = SimpleNamespace(kind="native-executable", runtime_id="native-host")
    assert CorePluginPlatform._sandbox_runtime_read_only_paths(owner, native) == ()


def test_disabled_trust_ux_rejects_stale_review_endpoints(tmp_path: Path) -> None:
    service, _audit = _trust_service(tmp_path, evidence={}, enabled=False)
    with pytest.raises(PlatformSecurityError) as disabled:
        service.review_local_install(
            candidate_id="candidate-" + "0" * 32,
            preview_sha256="sha256:" + "0" * 64,
            reason="This stale confirmation must remain disabled after rollback.",
            acknowledgements=["execute-local-code"],
            actor="local-desktop-user",
            user_action_id="phase6-disabled-review",
        )
    assert disabled.value.code == "PLUGIN_TRUST_UX_DISABLED"
