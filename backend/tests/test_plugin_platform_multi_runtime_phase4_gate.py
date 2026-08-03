from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts import plugin_platform_multi_runtime_phase4 as phase4


@pytest.fixture(scope="module")
def gate_result() -> dict[str, object]:
    return phase4.run_gate()


def test_phase4_contract_freezes_registry_supply_receipt_and_rollout_policy() -> None:
    contract = phase4.validate_contract()

    assert contract["schemaVersion"] == phase4.CONTRACT_SCHEMA_VERSION
    assert contract["signedRegistry"]["signatureAlgorithm"] == "ed25519"
    assert contract["signedRegistry"]["multipleKeysPerRegistry"] is True
    assert contract["signedRegistry"]["crossKeyRevisionRotation"] is True
    assert contract["signedRegistry"]["revision"] == 1
    assert contract["signedRegistry"]["automaticNetworkUpdates"] is False
    assert contract["referenceRuntime"]["runtimeId"] == phase4.OFFICIAL_RUNTIME_ID
    assert contract["referenceRuntime"]["version"] == phase4.OFFICIAL_RUNTIME_VERSION
    assert (
        contract["referenceRuntime"]["archiveSha256"] == phase4.OFFICIAL_ARCHIVE_SHA256
    )
    assert contract["referenceRuntime"]["archiveSize"] == phase4.OFFICIAL_ARCHIVE_SIZE
    assert contract["referenceRuntime"]["fileCount"] == 315
    assert contract["referenceRuntime"]["legalFileCount"] == 179
    assert contract["receipts"] == {
        "bindsProbeDigest": True,
        "bindsRegistryDigest": True,
        "bindsRegistryRevision": True,
        "bindsRuntimeDigest": True,
        "managedActivationSchema": 4,
        "managedInstallationSchema": 4,
        "unmanagedActivationSchema": 3,
        "unmanagedInstallationSchema": 3,
    }
    assert contract["rollout"]["enabledDefault"] is False
    assert contract["rollout"]["networkUpdatesDefault"] is False
    assert contract["supplyBinding"]["automaticSystemFallback"] is False
    assert contract["supplyBinding"]["sourceCompilation"] is False
    assert contract["sourcePolicy"] == {
        "ambientProxyDisabled": True,
        "cargoBuild": False,
        "javac": False,
        "npmInstall": False,
        "shellDisabled": True,
        "systemPathSearch": False,
    }


def test_phase4_contract_drift_fails_closed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    drifted = json.loads(phase4.CONTRACT_PATH.read_text(encoding="utf-8"))
    drifted["referenceRuntime"]["archiveSize"] += 1
    path = tmp_path / "drifted.json"
    path.write_text(json.dumps(drifted), encoding="utf-8")
    monkeypatch.setattr(phase4, "CONTRACT_PATH", path)

    with pytest.raises(phase4.Phase4GateError, match="contract drift"):
        phase4.validate_contract()


def test_phase4_deterministic_gate_exercises_cache_failures_revision_and_references(
    gate_result: dict[str, object],
) -> None:
    assert gate_result["schemaVersion"] == phase4.GATE_SCHEMA_VERSION
    assert gate_result["result"] == "pass"
    assert gate_result["realJre"] is None
    boundary = gate_result["deterministic"]
    assert boundary["runtime"] == {
        "artifactSha256": boundary["runtime"]["artifactSha256"],
        "automaticUpdates": False,
        "firstDownloadedFiles": 5,
        "firstQuickRepeat": False,
        "offlineDownloadedFiles": 0,
        "offlineQuickRepeat": True,
        "probeOutput": "candlescope-fixture-runtime-1.0.0",
        "registryRevision": 1,
        "repeatDownloadedFiles": 0,
        "repeatQuickRepeat": True,
        "runtimeId": "fixture-java-1",
        "source": "host-managed",
        "version": "1.0.0+fixture",
    }
    assert boundary["corruption"] == {
        "downloadedFiles": 0,
        "offlineRecovery": True,
        "quarantinedEntries": 1,
    }
    assert boundary["errors"] == {
        "digestMismatch": "PLUGIN_RUNTIME_REGISTRY_ARTIFACT_MISMATCH",
        "diskFull": "PLUGIN_RUNTIME_REGISTRY_DISK_FULL",
        "extract": "PLUGIN_RUNTIME_REGISTRY_EXTRACT_FAILED",
        "interrupted": "PLUGIN_RUNTIME_REGISTRY_DOWNLOAD_FAILED",
        "offlineMiss": "PLUGIN_RUNTIME_REGISTRY_OFFLINE_CACHE_MISS",
        "sizeMismatch": "PLUGIN_RUNTIME_REGISTRY_ARTIFACT_MISMATCH",
    }
    assert boundary["revision"]["revoked"] == (
        "PLUGIN_RUNTIME_REGISTRY_RUNTIME_REVOKED"
    )
    assert boundary["revision"]["revokedAfterRollback"] == (
        "PLUGIN_RUNTIME_REGISTRY_RUNTIME_REVOKED"
    )
    assert boundary["revision"]["rollbackFrom"] == 2
    assert boundary["revision"]["rollbackTo"] == 1
    assert boundary["system"] == {
        "absoluteExecutable": True,
        "confirmationError": "PLUGIN_RUNTIME_REGISTRY_SYSTEM_CONFIRMATION_REQUIRED",
        "registrySha256": None,
        "reproducible": False,
        "source": "system",
    }
    assert boundary["receipts"] == {
        "installationSchema": 4,
        "runtimeSupply": True,
    }
    assert boundary["references"] == {
        "archiveRetained": True,
        "cleanupError": "PLUGIN_RUNTIME_REGISTRY_RUNTIME_REFERENCED",
        "count": 2,
    }


def test_phase4_recorded_real_jre_gate_is_complete_and_offline() -> None:
    evidence = phase4.validate_real_gate_evidence()
    real = evidence["realJre"]

    assert real["cleanRoot"] is True
    assert real["runtime"]["fileCount"] == 315
    assert real["runtime"]["extractedSize"] == 151_523_285
    assert real["runtime"]["legalFileCount"] == 179
    assert real["runtime"]["probeStderr"].startswith('openjdk version "21.0.12"')
    assert real["supplyChain"]["downloadedFiles"] == 5
    assert len(real["supplyChain"]["downloadUrls"]) == 5
    assert len(real["supplyChain"]["evidence"]) == 4
    assert len(real["supplyChain"]["licenseFiles"]) == 4
    assert real["cache"] == {
        "firstQuickRepeat": False,
        "offlineDownloadedFiles": 0,
        "offlineNetworkCalls": 0,
        "offlineQuickRepeat": True,
        "recoveryDownloadedFiles": 0,
        "recoveryQuarantinedEntries": 1,
        "recoveryQuickRepeat": False,
        "repeatDownloadedFiles": 0,
        "repeatQuickRepeat": True,
        "stagingEntries": 0,
        "verificationStatus": "verified",
    }


def test_phase4_cli_prints_and_atomically_writes_contract(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    output = tmp_path / "nested" / "phase4-contract.json"
    assert phase4.main(["--print-contract", "--output", str(output)]) == 0
    captured = capsys.readouterr()

    assert captured.err == ""
    assert json.loads(captured.out) == phase4.capture_contract()
    assert json.loads(output.read_text(encoding="utf-8")) == phase4.capture_contract()
    assert list(output.parent.glob(f".{output.name}.*")) == []
