"""Phase 4 signed Runtime Registry contract and executable release gate."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import tempfile
import time
import uuid
from dataclasses import fields
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable
from unittest.mock import patch


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = REPOSITORY_ROOT / "backend"
SDK_SOURCE = REPOSITORY_ROOT / "packages" / "candlescope-plugin-sdk" / "src"
CONTRACT_PATH = (
    BACKEND_ROOT
    / "tests"
    / "fixtures"
    / "plugin_platform_multi_runtime"
    / "phase4_contract_v1.json"
)
REAL_GATE_EVIDENCE_PATH = (
    REPOSITORY_ROOT
    / "docs"
    / "perf-baselines"
    / "plugin-platform-v2"
    / "multi-runtime-phase4-2026-08-03-windows-amd64.json"
)
CONTRACT_SCHEMA_VERSION = "candlescope.plugin-platform.multi-runtime.phase4-contract/1"
GATE_SCHEMA_VERSION = "candlescope.plugin-platform.multi-runtime.phase4-gate/1"
OFFICIAL_RUNTIME_ID = "temurin-21.0.12.8"
OFFICIAL_RUNTIME_VERSION = "21.0.12+8-LTS"
OFFICIAL_ARCHIVE_SHA256 = (
    "sha256:b8aa18fef5edb69bee8618f99677d66d0873d22cb40d974c15ac9ffcdecf73ba"
)
OFFICIAL_ARCHIVE_SIZE = 48_993_215


class Phase4GateError(RuntimeError):
    """The reviewed Runtime Registry boundary or a real exit gate drifted."""


def _ensure_import_paths() -> None:
    scripts_dir = str(Path(__file__).resolve().parent)
    if scripts_dir not in sys.path:
        sys.path.insert(0, scripts_dir)
    from plugin_sdk_isolation import pin_in_repo_plugin_sdk

    pin_in_repo_plugin_sdk(BACKEND_ROOT)


def _strict_json(path: Path) -> dict[str, Any]:
    _ensure_import_paths()
    from candlescope_plugin_sdk.platform_v2 import loads_strict

    value = loads_strict(path.read_bytes())
    if not isinstance(value, dict):
        raise Phase4GateError(f"{path} must contain a JSON object")
    return value


def _sha256_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def _sha256_path(path: Path) -> str:
    return _sha256_bytes(path.read_bytes())


def _required_error_codes() -> list[str]:
    return sorted(
        {
            "PLUGIN_RUNTIME_REGISTRY_ARCHIVE_INVALID",
            "PLUGIN_RUNTIME_REGISTRY_ARCHIVE_LIMIT_EXCEEDED",
            "PLUGIN_RUNTIME_REGISTRY_ARCHIVE_UNSAFE",
            "PLUGIN_RUNTIME_REGISTRY_ARTIFACT_MISMATCH",
            "PLUGIN_RUNTIME_REGISTRY_CACHE_UNSAFE",
            "PLUGIN_RUNTIME_REGISTRY_CANONICAL_JSON_REQUIRED",
            "PLUGIN_RUNTIME_REGISTRY_CHAIN_INVALID",
            "PLUGIN_RUNTIME_REGISTRY_CONFIGURATION_INVALID",
            "PLUGIN_RUNTIME_REGISTRY_DISABLED",
            "PLUGIN_RUNTIME_REGISTRY_DISK_FULL",
            "PLUGIN_RUNTIME_REGISTRY_DOWNLOAD_FAILED",
            "PLUGIN_RUNTIME_REGISTRY_DOWNLOAD_LIMIT_EXCEEDED",
            "PLUGIN_RUNTIME_REGISTRY_EXTRACT_FAILED",
            "PLUGIN_RUNTIME_REGISTRY_LICENSE_INVALID",
            "PLUGIN_RUNTIME_REGISTRY_OFFLINE_CACHE_MISS",
            "PLUGIN_RUNTIME_REGISTRY_OFFLINE_EVIDENCE_MISS",
            "PLUGIN_RUNTIME_REGISTRY_PROBE_FAILED",
            "PLUGIN_RUNTIME_REGISTRY_PROBE_TIMEOUT",
            "PLUGIN_RUNTIME_REGISTRY_REFERENCE_INVALID",
            "PLUGIN_RUNTIME_REGISTRY_ROOT_UNTRUSTED",
            "PLUGIN_RUNTIME_REGISTRY_RUNTIME_NOT_FOUND",
            "PLUGIN_RUNTIME_REGISTRY_RUNTIME_REFERENCED",
            "PLUGIN_RUNTIME_REGISTRY_RUNTIME_REVOKED",
            "PLUGIN_RUNTIME_REGISTRY_SIGNATURE_INVALID",
            "PLUGIN_RUNTIME_REGISTRY_SYSTEM_CONFIRMATION_REQUIRED",
            "PLUGIN_RUNTIME_REGISTRY_SYSTEM_RUNTIME_CHANGED",
            "PLUGIN_RUNTIME_REGISTRY_SYSTEM_RUNTIME_NOT_FOUND",
            "PLUGIN_RUNTIME_REGISTRY_SYSTEM_SELECTION_INVALID",
        }
    )


def capture_contract() -> dict[str, Any]:
    _ensure_import_paths()
    from app.plugin_core_v2.runtime_providers import RuntimeSupplyBinding
    from app.plugin_installer_v2.installer import (
        MANAGED_RUNTIME_RECEIPT_SCHEMA_VERSION,
        RECEIPT_SCHEMA_VERSION,
    )
    from app.plugin_installer_v2.registry import (
        REGISTRY_SCHEMA_VERSION_V3,
        REGISTRY_SCHEMA_VERSION_V4,
        EntrypointActivation,
    )
    from app.plugin_runtime_registry_v3 import (
        EVIDENCE_ROLES,
        OFFICIAL_REGISTRY_V1_PATH,
        OFFICIAL_ROOTS_V1_PATH,
        RUNTIME_CACHE_RECEIPT_SCHEMA,
        RUNTIME_REGISTRY_ENABLED_ENV,
        RUNTIME_REGISTRY_NETWORK_UPDATES_ENV,
        RUNTIME_REGISTRY_STATUS_SCHEMA,
        EnsuredRuntime,
        load_runtime_registry_roots_bytes,
        verify_runtime_registry_bytes,
    )
    from scripts import candlescope_runtime_registry
    from scripts import plugin_platform_multi_runtime_phase3 as phase3

    phase3_contract = phase3.validate_contract()
    roots = load_runtime_registry_roots_bytes(OFFICIAL_ROOTS_V1_PATH.read_bytes())
    registry = verify_runtime_registry_bytes(
        OFFICIAL_REGISTRY_V1_PATH.read_bytes(), roots
    )
    release = registry.runtimes[0]
    sources = {
        path.name: path.read_text(encoding="utf-8")
        for path in (
            BACKEND_ROOT / "app/plugin_runtime_registry_v3/models.py",
            BACKEND_ROOT / "app/plugin_runtime_registry_v3/service.py",
            BACKEND_ROOT / "app/plugin_installer_v2/installer.py",
            BACKEND_ROOT / "app/plugin_installer_v2/registry.py",
        )
    }
    source_text = "\n".join(sources.values())
    required_errors = _required_error_codes()
    missing_errors = [item for item in required_errors if item not in source_text]
    if missing_errors:
        raise Phase4GateError(
            f"required Runtime Registry errors are missing: {missing_errors}"
        )

    parser = candlescope_runtime_registry.build_parser()
    subcommands: list[str] = []
    for action in parser._actions:
        choices = getattr(action, "choices", None)
        if isinstance(choices, dict):
            subcommands.extend(choices)
    return {
        "schemaVersion": CONTRACT_SCHEMA_VERSION,
        "implementedOn": "2026-08-03",
        "phase3ContractSha256": _sha256_bytes(
            json.dumps(phase3_contract, sort_keys=True, separators=(",", ":")).encode(
                "utf-8"
            )
        ),
        "signedRegistry": {
            "rootsSha256": _sha256_path(OFFICIAL_ROOTS_V1_PATH),
            "registrySha256": registry.sha256,
            "registryId": registry.registry_id,
            "revision": registry.revision,
            "keyId": registry.signature["keyId"],
            "automaticNetworkUpdates": registry.automatic_network_updates,
            "sourceOrigins": sorted(roots[0].source_origins),
            "signatureAlgorithm": registry.signature["algorithm"],
            "multipleKeysPerRegistry": True,
            "crossKeyRevisionRotation": True,
        },
        "referenceRuntime": {
            "runtimeId": release.runtime_id,
            "kind": release.kind,
            "version": release.version,
            "os": release.operating_system,
            "arch": release.architecture,
            "archive": release.archive_format,
            "archiveRoot": release.strip_prefix,
            "archiveSha256": release.sha256,
            "archiveSize": release.size,
            "fileCount": release.file_count,
            "extractedSize": release.extracted_size,
            "executable": release.executable,
            "probe": release.probe.to_wire(),
            "licenseSpdx": release.license_spdx,
            "legalFileCount": release.legal_file_count,
            "legalSize": release.legal_size,
            "licenseFiles": [item.to_wire() for item in release.license_files],
            "evidence": [item.to_wire() for item in release.evidence],
            "evidenceRoles": sorted(EVIDENCE_ROLES),
            "upstream": {
                "releaseUrl": release.upstream_release_url,
                "scmRef": release.upstream_scm_ref,
                "buildRef": release.upstream_build_ref,
            },
        },
        "storage": {
            "contentAddressedRegistry": True,
            "contentAddressedArchive": True,
            "contentAddressedEvidence": True,
            "contentAddressedExtractedCache": True,
            "downloadStaging": True,
            "atomicPublication": True,
            "readOnlyVerifiedCache": True,
            "corruptionQuarantine": True,
            "recoverableRetirement": True,
            "archiveRetainedAfterCleanup": True,
            "cacheReceiptSchema": RUNTIME_CACHE_RECEIPT_SCHEMA,
            "statusSchema": RUNTIME_REGISTRY_STATUS_SCHEMA,
        },
        "supplyBinding": {
            "fields": [item.name for item in fields(RuntimeSupplyBinding)],
            "ensuredRuntimeFields": [item.name for item in fields(EnsuredRuntime)],
            "activationEntrypointFields": [
                item.name for item in fields(EntrypointActivation)
            ],
            "managedSource": "host-managed",
            "developerSource": "system",
            "managedReproducible": True,
            "systemReproducible": False,
            "systemRequiresDeveloperLocal": True,
            "systemRequiresExplicitConfirmation": True,
            "automaticSystemFallback": False,
            "sourceCompilation": False,
        },
        "receipts": {
            "unmanagedInstallationSchema": RECEIPT_SCHEMA_VERSION,
            "managedInstallationSchema": MANAGED_RUNTIME_RECEIPT_SCHEMA_VERSION,
            "unmanagedActivationSchema": REGISTRY_SCHEMA_VERSION_V3,
            "managedActivationSchema": REGISTRY_SCHEMA_VERSION_V4,
            "bindsRegistryRevision": True,
            "bindsRegistryDigest": True,
            "bindsRuntimeDigest": True,
            "bindsProbeDigest": True,
        },
        "rollout": {
            "enabledFlag": RUNTIME_REGISTRY_ENABLED_ENV,
            "enabledDefault": False,
            "networkUpdatesFlag": RUNTIME_REGISTRY_NETWORK_UPDATES_ENV,
            "networkUpdatesDefault": False,
            "automaticRegistryFetch": False,
            "rollbackRetainsVerifiedCache": True,
            "revocationsMonotonicAcrossRollback": True,
        },
        "management": {
            "cliSubcommands": sorted(set(subcommands)),
            "pluginManagerRuntimeRegistry": True,
            "pluginManagerRuntimeSupply": True,
            "statusFields": [
                "active",
                "automaticUpdates",
                "enabled",
                "networkUpdatesEnabled",
                "runtimes",
                "schemaVersion",
                "systemRuntimes",
            ],
        },
        "failClosedErrors": required_errors,
        "sourcePolicy": {
            "ambientProxyDisabled": "trust_env=False" in sources["service.py"],
            "shellDisabled": "shell=False" in sources["service.py"],
            "systemPathSearch": "shutil.which" in sources["service.py"],
            "javac": "javac" in sources["service.py"].casefold(),
            "npmInstall": "npm install" in sources["service.py"].casefold(),
            "cargoBuild": "cargo build" in sources["service.py"].casefold(),
        },
    }


def validate_contract() -> dict[str, Any]:
    fixture = _strict_json(CONTRACT_PATH)
    current = capture_contract()
    if fixture != current:
        _ensure_import_paths()
        from candlescope_plugin_sdk.platform_v2 import canonical_sha256

        raise Phase4GateError(
            "multi-runtime Phase 4 contract drift: "
            f"fixture={canonical_sha256(fixture)} current={canonical_sha256(current)}"
        )
    return fixture


def _captured_error(callback: Callable[[], Any]) -> str:
    _ensure_import_paths()
    from app.plugin_runtime_registry_v3 import RuntimeRegistryError

    try:
        callback()
    except RuntimeRegistryError as exc:
        return exc.code
    raise Phase4GateError("expected RuntimeRegistryError was not raised")


def exercise_deterministic_boundary() -> dict[str, Any]:
    _ensure_import_paths()
    from app.plugin_core_v2.runtime_providers import RuntimeProviderBinding
    from app.plugin_installer_v2.installer import InstallationReceipt
    from app.plugin_runtime_registry_v3 import canonical_bytes
    from tests.plugin_platform_runtime_registry_testkit import (
        FIXTURE_OUTPUT,
        FIXTURE_RUNTIME_ID,
        LocalRuntimeArtifactFetcher,
        build_runtime_registry_fixture,
        copy_system_runtime_fixture,
        interrupted_fetcher,
    )

    fixture = build_runtime_registry_fixture()
    with tempfile.TemporaryDirectory(prefix="candlescope-phase4-") as raw_root:
        root = Path(raw_root)
        fetcher = LocalRuntimeArtifactFetcher(fixture.payloads)
        service = fixture.service(root / "runtime", fetcher=fetcher)
        first = service.ensure(FIXTURE_RUNTIME_ID, "java")
        repeat = service.ensure(FIXTURE_RUNTIME_ID, "java")
        offline = service.ensure(FIXTURE_RUNTIME_ID, "java", offline=True)
        initial_downloads = len(fetcher.calls)

        first.executable.chmod(0o755)
        first.executable.write_bytes(b"corrupted fixture executable")
        recovered = service.ensure(FIXTURE_RUNTIME_ID, "java", offline=True)
        if len(fetcher.calls) != initial_downloads:
            raise Phase4GateError("offline cache recovery unexpectedly fetched content")

        miss = fixture.service(
            root / "offline-miss",
            fetcher=LocalRuntimeArtifactFetcher(fixture.payloads),
        )
        interrupted = fixture.service(
            root / "interrupted",
            fetcher=interrupted_fetcher(fixture),
        )
        digest_payloads = dict(fixture.payloads)
        archive = digest_payloads[fixture.archive_url]
        digest_payloads[fixture.archive_url] = bytes([archive[0] ^ 1]) + archive[1:]
        digest_service = fixture.service(
            root / "digest",
            fetcher=LocalRuntimeArtifactFetcher(digest_payloads),
        )
        size_payloads = dict(fixture.payloads)
        size_payloads[fixture.archive_url] = archive[:-1]
        size_service = fixture.service(
            root / "size",
            fetcher=LocalRuntimeArtifactFetcher(size_payloads),
        )
        invalid_fixture = build_runtime_registry_fixture(archive_override=b"bad zip")
        invalid_archive = invalid_fixture.service(root / "extract")
        disk_full = fixture.service(root / "disk-full")
        with patch(
            "app.plugin_runtime_registry_v3.service.shutil.disk_usage",
            return_value=SimpleNamespace(total=1, used=1, free=0),
        ):
            disk_error = _captured_error(
                lambda: disk_full.ensure(FIXTURE_RUNTIME_ID, "java")
            )

        revision_service = fixture.service(root / "revision")
        revision1 = revision_service.active_registry()
        revision2 = fixture.signed_revision(
            revision=2,
            previous_registry_sha256=revision1.sha256,
            revocations=(
                {
                    "sha256": fixture.archive_sha256,
                    "reason": "phase4 gate revocation",
                    "revokedAt": "2026-08-03T00:01:00Z",
                },
            ),
        )
        revision_service.activate_registry(revision2)
        revoked_error = _captured_error(
            lambda: revision_service.resolve(FIXTURE_RUNTIME_ID, "java")
        )
        rollback = revision_service.rollback_registry()
        rollback_revoked_error = _captured_error(
            lambda: revision_service.resolve(FIXTURE_RUNTIME_ID, "java")
        )

        system_executable, system_args, system_pattern = copy_system_runtime_fixture(
            root / "system"
        )
        confirmation_error = _captured_error(
            lambda: service.register_system_runtime(
                runtime_id="phase4-system-java",
                kind="java",
                version="1.0.0-system",
                executable=system_executable,
                probe_args=system_args,
                expected_pattern=system_pattern,
                developer_local=True,
                confirm_nonreproducible=False,
            )
        )
        system = service.register_system_runtime(
            runtime_id="phase4-system-java",
            kind="java",
            version="1.0.0-system",
            executable=system_executable,
            probe_args=system_args,
            expected_pattern=system_pattern,
            developer_local=True,
            confirm_nonreproducible=True,
        )

        provider = RuntimeProviderBinding(
            runtime_kind="java-jar",
            runtime_id=FIXTURE_RUNTIME_ID,
            provider_version="1.0.0",
            runtime_identity="sha256:" + "5" * 64,
            runtime_supply=recovered.supply,
        )
        receipt = InstallationReceipt(
            installation_id="1" * 64,
            bundle_sha256="sha256:" + "2" * 64,
            bundle_size=1,
            envelope_sha256="sha256:" + "3" * 64,
            manifest_sha256="sha256:" + "4" * 64,
            manifest_contract_sha256="sha256:" + "5" * 64,
            plugin_id="candlescope.phase4-gate",
            version="1.0.0",
            publisher="candlescope",
            created_at="2026-08-03T00:00:00Z",
            wheels=(),
            probe={"status": "pass"},
            runtime_providers=(provider.to_wire(),),
            schema_version=4,
        )
        receipt_round_trip = InstallationReceipt.from_wire(receipt.to_wire())

        activation = root / "activation.json"
        history = root / "history"
        history.mkdir()
        supply_wire = recovered.supply.to_wire()
        activation.write_bytes(
            canonical_bytes(
                {
                    "pluginId": "candlescope.phase4-a",
                    "activationId": "activation-a",
                    "runtimeSupply": supply_wire,
                }
            )
        )
        (history / "rollback.json").write_bytes(
            canonical_bytes(
                {
                    "pluginId": "candlescope.phase4-b",
                    "activationId": "activation-b",
                    "runtimeSupply": supply_wire,
                }
            )
        )
        references = service.reference_counts(
            activation_registry=activation,
            history_directory=history,
        )
        cleanup_error = _captured_error(
            lambda: service.cleanup_unreferenced(
                fixture.archive_sha256,
                activation_registry=activation,
                history_directory=history,
            )
        )

        return {
            "runtime": {
                "runtimeId": first.supply.runtime_id,
                "version": first.supply.version,
                "source": first.supply.source,
                "registryRevision": first.supply.registry_revision,
                "artifactSha256": first.supply.artifact_sha256,
                "probeOutput": first.probe.stdout.strip(),
                "firstDownloadedFiles": first.downloaded_files,
                "firstQuickRepeat": first.quick_repeat,
                "repeatQuickRepeat": repeat.quick_repeat,
                "repeatDownloadedFiles": repeat.downloaded_files,
                "offlineQuickRepeat": offline.quick_repeat,
                "offlineDownloadedFiles": offline.downloaded_files,
                "automaticUpdates": service.public_status()["automaticUpdates"],
            },
            "corruption": {
                "offlineRecovery": recovered.probe.stdout.strip() == FIXTURE_OUTPUT,
                "quarantinedEntries": recovered.quarantined_entries,
                "downloadedFiles": recovered.downloaded_files,
            },
            "errors": {
                "offlineMiss": _captured_error(
                    lambda: miss.ensure(FIXTURE_RUNTIME_ID, "java", offline=True)
                ),
                "interrupted": _captured_error(
                    lambda: interrupted.ensure(FIXTURE_RUNTIME_ID, "java")
                ),
                "digestMismatch": _captured_error(
                    lambda: digest_service.ensure(FIXTURE_RUNTIME_ID, "java")
                ),
                "sizeMismatch": _captured_error(
                    lambda: size_service.ensure(FIXTURE_RUNTIME_ID, "java")
                ),
                "extract": _captured_error(
                    lambda: invalid_archive.ensure(FIXTURE_RUNTIME_ID, "java")
                ),
                "diskFull": disk_error,
            },
            "revision": {
                "revoked": revoked_error,
                "rollbackFrom": rollback["fromRevision"],
                "rollbackTo": rollback["toRevision"],
                "revocationsPreserved": rollback["revocationsPreserved"],
                "revokedAfterRollback": rollback_revoked_error,
            },
            "system": {
                "confirmationError": confirmation_error,
                "source": system.source,
                "reproducible": system.reproducible,
                "absoluteExecutable": system.executable.is_absolute(),
                "registrySha256": system.registry_sha256,
            },
            "receipts": {
                "installationSchema": receipt_round_trip.schema_version,
                "runtimeSupply": (
                    receipt_round_trip.runtime_providers[0]["runtimeSupply"]
                    == recovered.supply.to_wire()
                ),
            },
            "references": {
                "count": references[fixture.archive_sha256],
                "cleanupError": cleanup_error,
                "archiveRetained": service.archives_directory.joinpath(
                    f"{fixture.archive_sha256.removeprefix('sha256:')}.zip"
                ).is_file(),
            },
        }


class _RecordingFetcher:
    def __init__(self, inner: Any) -> None:
        self.inner = inner
        self.calls: list[str] = []

    def fetch(self, url: str, destination: Path, *, maximum: int) -> None:
        self.calls.append(url)
        self.inner.fetch(url, destination, maximum=maximum)


class _RejectingFetcher:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def fetch(self, url: str, destination: Path, *, maximum: int) -> None:
        self.calls.append(url)
        raise Phase4GateError("offline gate attempted a network fetch")


def exercise_real_jre_exit_gate() -> dict[str, Any]:
    _ensure_import_paths()
    from app.plugin_runtime_registry_v3 import (
        HttpsRuntimeArtifactFetcher,
        build_official_runtime_registry,
    )

    if os.name != "nt":
        raise Phase4GateError("the pinned Phase 4 reference JRE is Windows x86_64")
    with tempfile.TemporaryDirectory(prefix="candlescope-phase4-real-jre-") as raw:
        root = Path(raw) / "managed-runtimes"
        root_clean = not root.exists()
        recording = _RecordingFetcher(HttpsRuntimeArtifactFetcher())
        service = build_official_runtime_registry(
            root=root,
            enabled=True,
            network_updates_enabled=False,
            fetcher=recording,
        )

        started = time.perf_counter()
        first = service.ensure(OFFICIAL_RUNTIME_ID, "java")
        first_ms = (time.perf_counter() - started) * 1000.0
        calls_after_first = tuple(recording.calls)

        started = time.perf_counter()
        repeat = service.ensure(OFFICIAL_RUNTIME_ID, "java")
        repeat_ms = (time.perf_counter() - started) * 1000.0
        if tuple(recording.calls) != calls_after_first:
            raise Phase4GateError(
                "real JRE quick repeat unexpectedly downloaded content"
            )

        rejecting = _RejectingFetcher()
        offline_service = build_official_runtime_registry(
            root=root,
            enabled=True,
            network_updates_enabled=False,
            fetcher=rejecting,
        )
        started = time.perf_counter()
        offline = offline_service.ensure(OFFICIAL_RUNTIME_ID, "java", offline=True)
        offline_ms = (time.perf_counter() - started) * 1000.0

        first.executable.chmod(0o755)
        first.executable.write_bytes(b"CandleScope Phase 4 corruption probe")
        started = time.perf_counter()
        recovered = offline_service.ensure(OFFICIAL_RUNTIME_ID, "java", offline=True)
        recovery_ms = (time.perf_counter() - started) * 1000.0
        if rejecting.calls:
            raise Phase4GateError("real JRE offline/recovery gate fetched content")

        release = recovered.release
        status = offline_service.public_status()
        evidence = [item.to_wire() for item in release.evidence]
        legal_files = [item.to_wire() for item in release.license_files]
        if (
            first.supply.artifact_sha256 != OFFICIAL_ARCHIVE_SHA256
            or first.supply.artifact_size != OFFICIAL_ARCHIVE_SIZE
            or not first.probe.stderr.startswith('openjdk version "21.0.12"')
            or not repeat.quick_repeat
            or not offline.quick_repeat
            or recovered.quick_repeat
            or recovered.quarantined_entries < 1
            or status["runtimes"][0]["verificationStatus"] != "verified"
        ):
            raise Phase4GateError(
                "real fixed JRE exit gate did not meet its frozen contract"
            )
        return {
            "result": "pass",
            "platform": {"os": "windows", "arch": "x86_64"},
            "cleanRoot": root_clean,
            "runtime": {
                "runtimeId": release.runtime_id,
                "version": release.version,
                "artifactSha256": release.sha256,
                "artifactSize": release.size,
                "fileCount": release.file_count,
                "extractedSize": release.extracted_size,
                "probeSha256": first.probe.sha256,
                "probeStderr": first.probe.stderr,
                "registryId": first.supply.registry_id,
                "registryRevision": first.supply.registry_revision,
                "registrySha256": first.supply.registry_sha256,
                "licenseSpdx": release.license_spdx,
                "legalFileCount": release.legal_file_count,
                "legalSize": release.legal_size,
            },
            "supplyChain": {
                "downloadedFiles": first.downloaded_files,
                "downloadUrls": list(calls_after_first),
                "evidence": evidence,
                "licenseFiles": legal_files,
                "automaticUpdates": status["automaticUpdates"],
                "networkUpdatesEnabled": status["networkUpdatesEnabled"],
            },
            "cache": {
                "firstQuickRepeat": first.quick_repeat,
                "repeatQuickRepeat": repeat.quick_repeat,
                "repeatDownloadedFiles": repeat.downloaded_files,
                "offlineQuickRepeat": offline.quick_repeat,
                "offlineDownloadedFiles": offline.downloaded_files,
                "offlineNetworkCalls": len(rejecting.calls),
                "recoveryQuickRepeat": recovered.quick_repeat,
                "recoveryDownloadedFiles": recovered.downloaded_files,
                "recoveryQuarantinedEntries": recovered.quarantined_entries,
                "stagingEntries": len(
                    list(offline_service.staging_directory.iterdir())
                ),
                "verificationStatus": status["runtimes"][0]["verificationStatus"],
            },
            "performance": {
                "firstInstallMs": round(first_ms, 3),
                "quickRepeatMs": round(repeat_ms, 3),
                "offlineHitMs": round(offline_ms, 3),
                "corruptionRecoveryMs": round(recovery_ms, 3),
            },
        }


def run_gate(*, real_jre: bool = False) -> dict[str, Any]:
    contract = validate_contract()
    deterministic = exercise_deterministic_boundary()
    real = exercise_real_jre_exit_gate() if real_jre else None
    return {
        "schemaVersion": GATE_SCHEMA_VERSION,
        "result": "pass",
        "contractSha256": _sha256_bytes(
            json.dumps(contract, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ),
        "deterministic": deterministic,
        "realJre": real,
    }


def validate_real_gate_evidence() -> dict[str, Any]:
    value = _strict_json(REAL_GATE_EVIDENCE_PATH)
    if (
        value.get("schemaVersion") != GATE_SCHEMA_VERSION
        or value.get("result") != "pass"
        or not isinstance(value.get("realJre"), dict)
        or value["realJre"].get("result") != "pass"
        or value["realJre"].get("runtime", {}).get("runtimeId") != OFFICIAL_RUNTIME_ID
        or value["realJre"].get("runtime", {}).get("version")
        != OFFICIAL_RUNTIME_VERSION
        or value["realJre"].get("runtime", {}).get("artifactSha256")
        != OFFICIAL_ARCHIVE_SHA256
        or value["realJre"].get("runtime", {}).get("artifactSize")
        != OFFICIAL_ARCHIVE_SIZE
        or value["realJre"].get("cache", {}).get("verificationStatus") != "verified"
        or value["realJre"].get("cache", {}).get("offlineNetworkCalls") != 0
        or value["realJre"].get("supplyChain", {}).get("automaticUpdates") is not False
    ):
        raise Phase4GateError("recorded real JRE evidence is missing or invalid")
    performance = value["realJre"].get("performance")
    if not isinstance(performance, dict) or not all(
        isinstance(performance.get(key), (int, float)) and performance[key] > 0
        for key in (
            "firstInstallMs",
            "quickRepeatMs",
            "offlineHitMs",
            "corruptionRecoveryMs",
        )
    ):
        raise Phase4GateError("recorded real JRE performance evidence is invalid")
    return value


def _atomic_write(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.parent / f".{path.name}.{uuid.uuid4().hex}.tmp"
    try:
        temporary.write_text(
            json.dumps(value, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--print-contract", action="store_true")
    parser.add_argument("--run-gate", action="store_true")
    parser.add_argument("--real-jre", action="store_true")
    parser.add_argument("--validate-real-evidence", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    if args.real_jre and not args.run_gate:
        parser.error("--real-jre requires --run-gate")
    if args.validate_real_evidence:
        value = validate_real_gate_evidence()
    elif args.run_gate:
        value = run_gate(real_jre=args.real_jre)
    else:
        value = capture_contract()
    if args.output is not None:
        _atomic_write(args.output, value)
    if (
        args.print_contract
        or args.run_gate
        or args.validate_real_evidence
        or args.output is None
    ):
        print(json.dumps(value, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
