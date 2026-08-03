from __future__ import annotations

import io
import json
import stat
import zipfile
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.plugin_core_v2.runtime import CorePluginPlatform
from app.plugin_core_v2.runtime_providers import RuntimeProviderBinding
from app.plugin_installer_v2.installer import InstallationReceipt
from app.plugin_installer_v2.registry import (
    ActivationRecord,
    ActivationRegistry,
    EntrypointActivation,
)
from app.plugin_runtime_registry_v3 import (
    EVIDENCE_ROLES,
    OFFICIAL_REGISTRY_V1_PATH,
    OFFICIAL_ROOTS_V1_PATH,
    RUNTIME_REGISTRY_ENABLED_ENV,
    RUNTIME_REGISTRY_NETWORK_UPDATES_ENV,
    ManagedRuntimeRegistryService,
    RuntimeRegistryError,
    canonical_bytes,
    load_runtime_registry_roots_bytes,
    verify_runtime_registry_bytes,
)
from scripts import candlescope_runtime_registry
from tests.plugin_platform_multi_runtime_testkit import build_v3_runtime_bundle
from tests.plugin_platform_runtime_registry_testkit import (
    FIXTURE_OUTPUT,
    FIXTURE_RUNTIME_ID,
    LocalRuntimeArtifactFetcher,
    RuntimeRegistryFixture,
    build_runtime_registry_fixture,
    copy_system_runtime_fixture,
    interrupted_fetcher,
)


@pytest.fixture(scope="module")
def runtime_fixture() -> RuntimeRegistryFixture:
    return build_runtime_registry_fixture()


def _error(exc: pytest.ExceptionInfo[RuntimeRegistryError]) -> RuntimeRegistryError:
    return exc.value


def _make_service(
    fixture: RuntimeRegistryFixture,
    root: Path,
    payloads: dict[str, bytes] | None = None,
) -> tuple[ManagedRuntimeRegistryService, LocalRuntimeArtifactFetcher]:
    fetcher = LocalRuntimeArtifactFetcher(
        fixture.payloads if payloads is None else payloads
    )
    return fixture.service(root, fetcher=fetcher), fetcher


def _activation_record(
    *,
    plugin_id: str,
    activation_id: str,
    supply: object,
    work: Path,
) -> ActivationRecord:
    jar = work / f"{plugin_id}.jar"
    jar.parent.mkdir(parents=True, exist_ok=True)
    jar.write_bytes(plugin_id.encode("utf-8"))
    return ActivationRecord(
        plugin_id=plugin_id,
        name=plugin_id,
        version="1.0.0",
        publisher="candlescope",
        installation_id="1" * 64,
        bundle_sha256="sha256:" + "2" * 64,
        manifest_sha256="sha256:" + "3" * 64,
        activation_id=activation_id,
        activated_at="2026-08-03T00:00:00Z",
        state="active",
        enabled=True,
        restart_required=False,
        required_permissions=(),
        entrypoints=(
            EntrypointActivation(
                id="main",
                executable=supply.executable,
                module=None,
                working_directory=work,
                runtime_kind="java-jar",
                runtime_id=supply.runtime_id,
                artifact_sha256="sha256:" + "4" * 64,
                artifact=jar,
                main_class="io.candlescope.fixture.Main",
                runtime_supply=supply,
            ),
        ),
        schema_version=4,
    )


def test_official_registry_is_signed_and_pins_complete_temurin_supply_chain() -> None:
    roots = load_runtime_registry_roots_bytes(OFFICIAL_ROOTS_V1_PATH.read_bytes())
    registry = verify_runtime_registry_bytes(
        OFFICIAL_REGISTRY_V1_PATH.read_bytes(), roots
    )

    assert len(roots) == 1
    assert roots[0].registry_id == "candlescope.reference-runtime"
    assert registry.revision == 1
    assert registry.previous_registry_sha256 is None
    assert registry.automatic_network_updates is False
    assert len(registry.runtimes) == 1
    release = registry.runtimes[0]
    assert release.runtime_id == "temurin-21.0.12.8"
    assert release.kind == "java"
    assert release.version == "21.0.12+8-LTS"
    assert release.sha256 == (
        "sha256:b8aa18fef5edb69bee8618f99677d66d0873d22cb40d974c15ac9ffcdecf73ba"
    )
    assert release.size == 48_993_215
    assert release.file_count == 315
    assert release.extracted_size == 151_523_285
    assert release.legal_file_count == 179
    assert release.legal_size == 228_708
    assert {item.role for item in release.evidence} == set(EVIDENCE_ROLES)
    assert len(release.license_files) == 4
    assert release.probe.argv == ("bin/java.exe", "-version")

    tampered = OFFICIAL_REGISTRY_V1_PATH.read_bytes().replace(
        b"21.0.12+8-LTS", b"21.0.13+8-LTS", 1
    )
    with pytest.raises(RuntimeRegistryError) as failure:
        verify_runtime_registry_bytes(tampered, roots)
    assert failure.value.code == "PLUGIN_RUNTIME_REGISTRY_SIGNATURE_INVALID"


def test_registry_flags_default_off_and_invalid_values_fail_closed(
    tmp_path: Path,
    runtime_fixture: RuntimeRegistryFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv(RUNTIME_REGISTRY_ENABLED_ENV, raising=False)
    monkeypatch.delenv(RUNTIME_REGISTRY_NETWORK_UPDATES_ENV, raising=False)
    root = tmp_path / "disabled"
    disabled = ManagedRuntimeRegistryService(
        root=root,
        roots=load_runtime_registry_roots_bytes(runtime_fixture.roots_bytes),
        bootstrap_registry=runtime_fixture.registry_bytes,
        enabled=None,
        network_updates_enabled=None,
        fetcher=LocalRuntimeArtifactFetcher(runtime_fixture.payloads),
    )
    assert disabled.enabled is False
    assert disabled.network_updates_enabled is False
    assert not root.exists()
    assert disabled.public_status() == {
        "schemaVersion": "candlescope.runtime-registry-status/1",
        "enabled": False,
        "networkUpdatesEnabled": False,
        "automaticUpdates": False,
        "active": None,
        "runtimes": [],
        "systemRuntimes": [],
    }
    with pytest.raises(RuntimeRegistryError) as failure:
        disabled.ensure(FIXTURE_RUNTIME_ID, "java")
    assert failure.value.code == "PLUGIN_RUNTIME_REGISTRY_DISABLED"

    monkeypatch.setenv(RUNTIME_REGISTRY_ENABLED_ENV, "sometimes")
    with pytest.raises(RuntimeRegistryError) as invalid:
        ManagedRuntimeRegistryService(
            root=tmp_path / "invalid",
            roots=load_runtime_registry_roots_bytes(runtime_fixture.roots_bytes),
            bootstrap_registry=runtime_fixture.registry_bytes,
            enabled=None,
        )
    assert invalid.value.code == "PLUGIN_RUNTIME_REGISTRY_CONFIGURATION_INVALID"


def test_first_install_quick_repeat_and_offline_hit_are_exact_and_auditable(
    tmp_path: Path,
    runtime_fixture: RuntimeRegistryFixture,
) -> None:
    service, fetcher = _make_service(runtime_fixture, tmp_path / "runtimes")
    first = service.ensure(FIXTURE_RUNTIME_ID, "java")

    assert first.quick_repeat is False
    assert first.downloaded_files == 1 + len(EVIDENCE_ROLES)
    assert first.quarantined_entries == 0
    assert first.executable.is_absolute() and first.executable.is_file()
    assert first.probe.stdout.strip() == FIXTURE_OUTPUT
    assert first.supply.source == "host-managed"
    assert first.supply.reproducible is True
    assert first.supply.registry_revision == 1
    assert first.supply.artifact_sha256 == runtime_fixture.archive_sha256
    assert len(fetcher.calls) == 1 + len(EVIDENCE_ROLES)
    assert not (first.executable.stat().st_mode & stat.S_IWUSR)

    calls = tuple(fetcher.calls)
    repeat = service.ensure(FIXTURE_RUNTIME_ID, "java")
    offline = service.ensure(FIXTURE_RUNTIME_ID, "java", offline=True)
    assert repeat.quick_repeat is True and offline.quick_repeat is True
    assert repeat.downloaded_files == offline.downloaded_files == 0
    assert tuple(fetcher.calls) == calls
    assert repeat.probe.sha256 == offline.probe.sha256 == first.probe.sha256

    status = service.public_status()
    assert status["enabled"] is True
    assert status["networkUpdatesEnabled"] is False
    assert status["automaticUpdates"] is False
    assert status["active"]["revision"] == 1
    assert status["runtimes"][0]["verificationStatus"] == "verified"
    assert status["runtimes"][0]["cached"] is True
    for item in runtime_fixture.runtime_release["evidence"]:
        evidence = (
            service.evidence_directory
            / item["sha256"].removeprefix("sha256:")
            / item["fileName"]
        )
        assert evidence.is_file()


def test_offline_cache_miss_never_fetches_or_falls_back(
    tmp_path: Path,
    runtime_fixture: RuntimeRegistryFixture,
) -> None:
    service, fetcher = _make_service(runtime_fixture, tmp_path / "offline-miss")
    with pytest.raises(RuntimeRegistryError) as failure:
        service.ensure(FIXTURE_RUNTIME_ID, "java", offline=True)
    assert failure.value.code == "PLUGIN_RUNTIME_REGISTRY_OFFLINE_CACHE_MISS"
    assert fetcher.calls == []
    assert service.system_registry_path.exists() is False


def test_interrupted_download_is_bounded_and_leaves_no_partial_artifact(
    tmp_path: Path,
    runtime_fixture: RuntimeRegistryFixture,
) -> None:
    fetcher = interrupted_fetcher(runtime_fixture)
    service = runtime_fixture.service(tmp_path / "interrupt", fetcher=fetcher)
    with pytest.raises(RuntimeRegistryError) as failure:
        service.ensure(FIXTURE_RUNTIME_ID, "java")
    assert failure.value.code == "PLUGIN_RUNTIME_REGISTRY_DOWNLOAD_FAILED"
    assert list(service.staging_directory.iterdir()) == []
    assert list(service.archives_directory.iterdir()) == []


@pytest.mark.parametrize(
    ("mutation", "same_size"),
    (("digest", True), ("size", False)),
)
def test_download_digest_and_size_mismatch_fail_before_cache_publish(
    tmp_path: Path,
    runtime_fixture: RuntimeRegistryFixture,
    mutation: str,
    same_size: bool,
) -> None:
    payloads = dict(runtime_fixture.payloads)
    original = payloads[runtime_fixture.archive_url]
    payloads[runtime_fixture.archive_url] = (
        bytes([original[0] ^ 1]) + original[1:] if same_size else original[:-1]
    )
    service, _fetcher = _make_service(
        runtime_fixture, tmp_path / mutation, payloads=payloads
    )
    with pytest.raises(RuntimeRegistryError) as failure:
        service.ensure(FIXTURE_RUNTIME_ID, "java")
    assert failure.value.code == "PLUGIN_RUNTIME_REGISTRY_ARTIFACT_MISMATCH"
    if mutation == "digest":
        assert (
            failure.value.details["actualSize"] == failure.value.details["expectedSize"]
        )
    else:
        assert (
            failure.value.details["actualSize"] < failure.value.details["expectedSize"]
        )
    assert not service.cache_directory.joinpath(FIXTURE_RUNTIME_ID).exists()


def test_invalid_archive_and_disk_full_fail_with_stable_errors(
    tmp_path: Path,
    runtime_fixture: RuntimeRegistryFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    invalid = build_runtime_registry_fixture(archive_override=b"not-a-zip-file")
    broken, _fetcher = _make_service(invalid, tmp_path / "invalid-archive")
    with pytest.raises(RuntimeRegistryError) as extraction:
        broken.ensure(FIXTURE_RUNTIME_ID, "java")
    assert extraction.value.code == "PLUGIN_RUNTIME_REGISTRY_EXTRACT_FAILED"

    full, _fetcher = _make_service(runtime_fixture, tmp_path / "disk-full")
    monkeypatch.setattr(
        "app.plugin_runtime_registry_v3.service.shutil.disk_usage",
        lambda _path: SimpleNamespace(total=1, used=1, free=0),
    )
    with pytest.raises(RuntimeRegistryError) as disk:
        full.ensure(FIXTURE_RUNTIME_ID, "java")
    assert disk.value.code == "PLUGIN_RUNTIME_REGISTRY_DISK_FULL"
    assert disk.value.details["requiredBytes"] > disk.value.details["availableBytes"]


def test_archive_rejects_nonportable_windows_device_paths(tmp_path: Path) -> None:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as package:
        package.writestr("fixture-runtime-1/CON", b"not a portable runtime path")
    fixture = build_runtime_registry_fixture(archive_override=output.getvalue())
    service, _fetcher = _make_service(fixture, tmp_path / "unsafe-path")

    with pytest.raises(RuntimeRegistryError) as failure:
        service.ensure(FIXTURE_RUNTIME_ID, "java")
    assert failure.value.code == "PLUGIN_RUNTIME_REGISTRY_ARCHIVE_UNSAFE"


def test_payload_archive_evidence_and_receipt_corruption_are_quarantined_and_recovered(
    tmp_path: Path,
    runtime_fixture: RuntimeRegistryFixture,
) -> None:
    service, fetcher = _make_service(runtime_fixture, tmp_path / "corruption")
    installed = service.ensure(FIXTURE_RUNTIME_ID, "java")
    initial_calls = len(fetcher.calls)

    installed.executable.chmod(0o755)
    installed.executable.write_bytes(b"corrupt executable")
    payload_recovery = service.ensure(FIXTURE_RUNTIME_ID, "java", offline=True)
    assert payload_recovery.quick_repeat is False
    assert payload_recovery.downloaded_files == 0
    assert payload_recovery.quarantined_entries == 1
    assert payload_recovery.probe.stdout.strip() == FIXTURE_OUTPUT
    assert len(fetcher.calls) == initial_calls

    archive = service.archives_directory / (
        f"{runtime_fixture.archive_sha256.removeprefix('sha256:')}.zip"
    )
    archive.chmod(0o644)
    archive.write_bytes(b"x" * runtime_fixture.runtime_release["size"])
    archive_recovery = service.ensure(FIXTURE_RUNTIME_ID, "java")
    assert archive_recovery.quick_repeat is True
    assert archive_recovery.downloaded_files == 1
    assert archive_recovery.quarantined_entries == 1

    evidence_item = runtime_fixture.runtime_release["evidence"][0]
    evidence = (
        service.evidence_directory
        / evidence_item["sha256"].removeprefix("sha256:")
        / evidence_item["fileName"]
    )
    evidence.chmod(0o644)
    evidence.write_bytes(b"z" * evidence_item["size"])
    evidence_recovery = service.ensure(FIXTURE_RUNTIME_ID, "java")
    assert evidence_recovery.quick_repeat is True
    assert evidence_recovery.downloaded_files == 1
    assert evidence_recovery.quarantined_entries == 1

    receipt = (
        service.cache_directory
        / FIXTURE_RUNTIME_ID
        / (runtime_fixture.archive_sha256.removeprefix("sha256:"))
        / "runtime-receipt.json"
    )
    receipt.chmod(0o644)
    value = json.loads(receipt.read_text(encoding="utf-8"))
    value["registry"]["sha256"] = "sha256:" + "0" * 64
    receipt.write_bytes(canonical_bytes(value))
    receipt_recovery = service.ensure(FIXTURE_RUNTIME_ID, "java", offline=True)
    assert receipt_recovery.quick_repeat is False
    assert receipt_recovery.quarantined_entries == 1
    assert list(service.quarantine_directory.rglob("*.reason.json"))


def test_signed_revision_chain_rollback_and_revocation_are_fail_closed(
    tmp_path: Path,
    runtime_fixture: RuntimeRegistryFixture,
) -> None:
    service, _fetcher = _make_service(runtime_fixture, tmp_path / "chain")
    revision1 = service.active_registry()
    revision2_bytes = runtime_fixture.signed_revision(
        revision=2,
        previous_registry_sha256=revision1.sha256,
        revocations=(
            {
                "sha256": runtime_fixture.archive_sha256,
                "reason": "fixture security withdrawal",
                "revokedAt": "2026-08-03T00:01:00Z",
            },
        ),
    )
    activated = service.activate_registry(revision2_bytes)
    assert activated["revision"] == 2
    assert activated["revokedArtifactSha256"] == [runtime_fixture.archive_sha256]
    with pytest.raises(RuntimeRegistryError) as revoked:
        service.ensure(FIXTURE_RUNTIME_ID, "java")
    assert revoked.value.code == "PLUGIN_RUNTIME_REGISTRY_RUNTIME_REVOKED"

    rollback = service.rollback_registry()
    assert rollback["fromRevision"] == 2 and rollback["toRevision"] == 1
    assert rollback["revocationsPreserved"] == [runtime_fixture.archive_sha256]
    with pytest.raises(RuntimeRegistryError) as still_revoked:
        service.resolve(FIXTURE_RUNTIME_ID, "java")
    assert still_revoked.value.code == "PLUGIN_RUNTIME_REGISTRY_RUNTIME_REVOKED"

    rolled_forward = service.activate_registry(revision2_bytes)
    assert rolled_forward["changed"] is True and rolled_forward["revision"] == 2

    bad_chain = runtime_fixture.signed_revision(
        revision=3,
        previous_registry_sha256="sha256:" + "f" * 64,
    )
    with pytest.raises(RuntimeRegistryError) as chain:
        service.activate_registry(bad_chain)
    assert chain.value.code == "PLUGIN_RUNTIME_REGISTRY_CHAIN_INVALID"


def test_build_pinned_roots_support_cross_key_revision_rotation(
    tmp_path: Path,
    runtime_fixture: RuntimeRegistryFixture,
) -> None:
    successor = build_runtime_registry_fixture()
    root_entries = [
        *json.loads(runtime_fixture.roots_bytes)["registries"],
        *json.loads(successor.roots_bytes)["registries"],
    ]
    root_entries.sort(key=lambda item: (item["registryId"], item["keyId"]))
    roots = load_runtime_registry_roots_bytes(
        canonical_bytes({"schemaVersion": 1, "registries": root_entries})
    )
    service = ManagedRuntimeRegistryService(
        root=tmp_path / "rotated-root",
        roots=roots,
        bootstrap_registry=runtime_fixture.registry_bytes,
        enabled=True,
        network_updates_enabled=False,
        fetcher=LocalRuntimeArtifactFetcher(runtime_fixture.payloads),
    )
    revision1 = service.active_registry()
    revision2 = successor.signed_revision(
        revision=2,
        previous_registry_sha256=revision1.sha256,
    )

    result = service.activate_registry(revision2)

    assert result["revision"] == 2
    active = service.active_registry()
    assert active.signature["keyId"] != revision1.signature["keyId"]
    assert active.previous_registry_sha256 == revision1.sha256


def test_schema4_activation_receipt_binds_runtime_registry_and_schema3_stays_stable(
    tmp_path: Path,
    runtime_fixture: RuntimeRegistryFixture,
) -> None:
    service, _fetcher = _make_service(runtime_fixture, tmp_path / "receipts")
    ensured = service.ensure(FIXTURE_RUNTIME_ID, "java")
    binding = RuntimeProviderBinding(
        runtime_kind="java-jar",
        runtime_id=FIXTURE_RUNTIME_ID,
        provider_version="1.0.0",
        runtime_identity="sha256:" + "5" * 64,
        runtime_supply=ensured.supply,
    )
    with pytest.raises(ValueError, match="does not match provider binding"):
        RuntimeProviderBinding(
            runtime_kind="java-jar",
            runtime_id=FIXTURE_RUNTIME_ID,
            provider_version="1.0.0",
            runtime_identity="sha256:" + "5" * 64,
            runtime_supply=replace(ensured.supply, runtime_kind="node"),
        )
    manifest = json.loads(
        (
            Path(__file__).parents[2]
            / "packages/candlescope-plugin-sdk/tests/fixtures/platform_v3/valid-java-jar.json"
        ).read_text(encoding="utf-8")
    )
    manifest["backend"]["entrypoints"][0]["runtime"]["runtimeId"] = FIXTURE_RUNTIME_ID
    bundle = build_v3_runtime_bundle(
        tmp_path / "bundle", "java-jar", manifest=manifest
    ).bundle
    managed_receipt = InstallationReceipt.from_bundle(
        bundle,
        probe={"status": "pass"},
        runtime_providers=(binding.to_wire(),),
    )
    assert managed_receipt.schema_version == 4
    round_trip = InstallationReceipt.from_wire(managed_receipt.to_wire())
    supply_wire = round_trip.runtime_providers[0]["runtimeSupply"]
    assert supply_wire["registryRevision"] == 1
    assert supply_wire["registrySha256"] == ensured.supply.registry_sha256
    assert supply_wire["artifactSha256"] == runtime_fixture.archive_sha256

    unmanaged = RuntimeProviderBinding(
        runtime_kind="java-jar",
        runtime_id=FIXTURE_RUNTIME_ID,
        provider_version="1.0.0",
        runtime_identity="sha256:" + "5" * 64,
    )
    legacy_receipt = InstallationReceipt.from_bundle(
        bundle,
        probe={"status": "pass"},
        runtime_providers=(unmanaged.to_wire(),),
    )
    assert legacy_receipt.schema_version == 3

    record = _activation_record(
        plugin_id="candlescope.phase4-a",
        activation_id="activation-a",
        supply=ensured.supply,
        work=tmp_path / "activation",
    )
    registry = ActivationRegistry().replace(record.plugin_id, record)
    assert registry.schema_version == 4
    restored = ActivationRegistry.from_wire(registry.to_wire())
    assert restored.to_wire() == registry.to_wire()
    assert (
        restored.plugins[0].entrypoints[0].runtime_supply.registry_sha256
        == ensured.supply.registry_sha256
    )


def test_shared_runtime_references_include_rollback_history_and_cleanup_is_recoverable(
    tmp_path: Path,
    runtime_fixture: RuntimeRegistryFixture,
) -> None:
    service, _fetcher = _make_service(runtime_fixture, tmp_path / "refs-runtime")
    ensured = service.ensure(FIXTURE_RUNTIME_ID, "java")
    current_record = _activation_record(
        plugin_id="candlescope.phase4-current",
        activation_id="activation-current",
        supply=ensured.supply,
        work=tmp_path / "current",
    )
    history_record = _activation_record(
        plugin_id="candlescope.phase4-rollback",
        activation_id="activation-rollback",
        supply=ensured.supply,
        work=tmp_path / "history-work",
    )
    activation_path = tmp_path / "activation-registry.json"
    activation_path.write_bytes(
        canonical_bytes(
            ActivationRegistry()
            .replace(current_record.plugin_id, current_record)
            .to_wire()
        )
    )
    history_directory = tmp_path / "history"
    history_directory.mkdir()
    (history_directory / "rollback.json").write_bytes(
        canonical_bytes(
            ActivationRegistry()
            .replace(history_record.plugin_id, history_record)
            .to_wire()
        )
    )

    counts = service.reference_counts(
        activation_registry=activation_path,
        history_directory=history_directory,
    )
    assert counts == {runtime_fixture.archive_sha256: 2}
    with pytest.raises(RuntimeRegistryError) as referenced:
        service.cleanup_unreferenced(
            runtime_fixture.archive_sha256,
            activation_registry=activation_path,
            history_directory=history_directory,
        )
    assert referenced.value.code == "PLUGIN_RUNTIME_REGISTRY_RUNTIME_REFERENCED"
    assert referenced.value.details["referenceCount"] == 2
    assert service.ensure(FIXTURE_RUNTIME_ID, "java", offline=True).quick_repeat is True

    empty_registry = tmp_path / "empty-registry.json"
    empty_registry.write_bytes(canonical_bytes(ActivationRegistry().to_wire()))
    empty_history = tmp_path / "empty-history"
    empty_history.mkdir()
    cleaned = service.cleanup_unreferenced(
        runtime_fixture.archive_sha256,
        activation_registry=empty_registry,
        history_directory=empty_history,
    )
    assert cleaned["referenceCount"] == 0
    assert cleaned["archiveRetained"] is True
    assert cleaned["recoverable"] is True
    assert len(cleaned["retired"]) == 1
    assert Path(cleaned["retired"][0]).is_dir()


def test_system_runtime_requires_explicit_developer_local_confirmation_and_is_nonreproducible(
    tmp_path: Path,
    runtime_fixture: RuntimeRegistryFixture,
) -> None:
    service, _fetcher = _make_service(runtime_fixture, tmp_path / "system-state")
    executable, probe_args, pattern = copy_system_runtime_fixture(
        tmp_path / "system-bin"
    )
    with pytest.raises(RuntimeRegistryError) as confirmation:
        service.register_system_runtime(
            runtime_id="fixture-system-java",
            kind="java",
            version="1.0.0-system",
            executable=executable,
            probe_args=probe_args,
            expected_pattern=pattern,
            developer_local=True,
            confirm_nonreproducible=False,
        )
    assert confirmation.value.code == (
        "PLUGIN_RUNTIME_REGISTRY_SYSTEM_CONFIRMATION_REQUIRED"
    )

    with pytest.raises(RuntimeRegistryError) as malformed_probe:
        service.register_system_runtime(
            runtime_id="fixture-system-java",
            kind="java",
            version="1.0.0-system",
            executable=executable,
            probe_args="--version",
            expected_pattern=pattern,
            developer_local=True,
            confirm_nonreproducible=True,
        )
    assert malformed_probe.value.code == (
        "PLUGIN_RUNTIME_REGISTRY_SYSTEM_SELECTION_INVALID"
    )

    binding = service.register_system_runtime(
        runtime_id="fixture-system-java",
        kind="java",
        version="1.0.0-system",
        executable=executable,
        probe_args=probe_args,
        expected_pattern=pattern,
        developer_local=True,
        confirm_nonreproducible=True,
    )
    assert binding.source == "system"
    assert binding.reproducible is False
    assert binding.executable == executable
    assert binding.registry_sha256 is None
    assert (
        service.system_runtime("fixture-system-java", "java").to_wire()
        == binding.to_wire()
    )
    system = service.public_status()["systemRuntimes"][0]
    assert system["reproducible"] is False
    assert system["executable"] == str(executable)

    registry = json.loads(service.system_registry_path.read_text(encoding="utf-8"))
    registry["runtimes"][0]["probe"]["sha256"] = "sha256:" + ("0" * 64)
    service.system_registry_path.write_text(
        json.dumps(registry, separators=(",", ":"), sort_keys=True),
        encoding="utf-8",
    )
    with pytest.raises(RuntimeRegistryError) as corrupted_state:
        service.public_status()
    assert corrupted_state.value.code == "PLUGIN_RUNTIME_REGISTRY_SYSTEM_STATE_INVALID"


def test_plugin_catalog_projects_registry_only_when_explicitly_enabled(
    tmp_path: Path,
    runtime_fixture: RuntimeRegistryFixture,
) -> None:
    disabled_service = runtime_fixture.service(
        tmp_path / "disabled-runtime", enabled=False
    )
    disabled = CorePluginPlatform(
        root=tmp_path / "disabled-platform",
        host_name="CandleScope",
        host_version="0.4.0",
        managed_runtime_registry=disabled_service,
    )
    assert "runtimeRegistry" not in disabled.catalog()

    enabled_service = runtime_fixture.service(tmp_path / "enabled-runtime")
    enabled = CorePluginPlatform(
        root=tmp_path / "enabled-platform",
        host_name="CandleScope",
        host_version="0.4.0",
        managed_runtime_registry=enabled_service,
    )
    projected = enabled.catalog()["runtimeRegistry"]
    assert projected["enabled"] is True
    assert projected["active"]["revision"] == 1
    assert projected["runtimes"][0]["source"] == "host-managed"


def test_runtime_registry_cli_is_explicit_json_only_and_offline_safe(
    tmp_path: Path,
    runtime_fixture: RuntimeRegistryFixture,
    capsys: pytest.CaptureFixture[str],
) -> None:
    roots, registry = runtime_fixture.write_configuration(tmp_path / "configuration")
    root = tmp_path / "cli-state"
    common = [
        "--root",
        str(root),
        "--roots",
        str(roots),
        "--bootstrap-registry",
        str(registry),
    ]
    assert candlescope_runtime_registry.main([*common, "status"]) == 0
    success = capsys.readouterr()
    assert success.err == ""
    value = json.loads(success.out)
    assert value["ok"] is True
    assert value["result"]["automaticUpdates"] is False

    assert (
        candlescope_runtime_registry.main(
            [*common, "ensure", FIXTURE_RUNTIME_ID, "java", "--offline"]
        )
        == 2
    )
    failure = capsys.readouterr()
    assert failure.out == ""
    error = json.loads(failure.err)
    assert error["ok"] is False
    assert error["error"]["code"] == "PLUGIN_RUNTIME_REGISTRY_OFFLINE_CACHE_MISS"


def test_runtime_registry_contains_no_source_build_or_automatic_system_fallback() -> (
    None
):
    source = (
        Path(__file__).parents[1] / "app/plugin_runtime_registry_v3/service.py"
    ).read_text(encoding="utf-8")
    lowered = source.casefold()
    assert "shutil.which" not in source
    assert "javac" not in lowered
    assert "npm install" not in lowered
    assert "cargo build" not in lowered
    assert "automatic runtime fallback" not in lowered
    assert "system_runtime(" in source
    assert "register_system_runtime(" in source
