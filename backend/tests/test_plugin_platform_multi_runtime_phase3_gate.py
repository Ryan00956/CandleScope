from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts import plugin_platform_multi_runtime_phase3 as phase3


@pytest.fixture(scope="module")
def gate_result() -> dict[str, object]:
    return phase3.run_gate()


def test_phase3_contract_freezes_native_artifact_job_and_rollout_policy() -> None:
    contract = phase3.validate_contract()

    assert contract["schemaVersion"] == phase3.CONTRACT_SCHEMA_VERSION
    assert contract["providerApi"]["apiVersion"] == 1
    assert contract["providerApi"]["nativeProviderVersion"] == "1.0.0"
    assert contract["providerApi"]["registeredKindsWhenDisabled"] == ["python-module"]
    assert contract["providerApi"]["registeredKindsWhenEnabled"] == [
        "native-executable",
        "python-module",
    ]
    assert contract["artifactPolicy"] == {
        "declaredArtifactOnly": True,
        "inventoryDigestAndSizeRequired": True,
        "operatingSystemAndArchitectureRequired": True,
        "postInstallBinaryInspection": [
            "elf64-executable",
            "macho64-executable",
            "pe32+-executable",
        ],
        "role": "native-executable",
        "runtimeId": "native-host",
        "scriptAndShellRejected": True,
    }
    assert contract["launchPolicy"]["windowsCreateSuspended"] is True
    assert contract["launchPolicy"]["windowsKillOnJobClose"] is True
    assert contract["launchPolicy"]["windowsAtomicResume"] is True
    assert contract["launchPolicy"]["windowsExplicitApplicationName"] is True
    assert contract["referencePlugin"]["responseCount"] == 10
    assert (
        contract["referencePlugin"]["transcriptSha256"]
        == "sha256:a3da7d49d645be03a6d33962c0a6c5f6664c4398fda5c260ddea47bb92e003d5"
    )
    assert contract["rollout"]["nativeDefault"] is False
    assert contract["rollout"]["automaticExecutableFallback"] is False


def test_phase3_contract_drift_fails_closed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    drifted = json.loads(phase3.CONTRACT_PATH.read_text(encoding="utf-8"))
    drifted["providerApi"]["nativeProviderVersion"] = "9.9.9"
    path = tmp_path / "drifted.json"
    path.write_text(json.dumps(drifted), encoding="utf-8")
    monkeypatch.setattr(phase3, "CONTRACT_PATH", path)

    with pytest.raises(phase3.Phase3GateError, match="contract drift"):
        phase3.validate_contract()


def test_phase3_gate_runs_native_transcript_faults_sandbox_rollback_and_budgets(
    gate_result: dict[str, object],
) -> None:
    assert gate_result["schemaVersion"] == phase3.GATE_SCHEMA_VERSION
    assert gate_result["result"] == "pass"
    boundary = gate_result["boundary"]
    assert boundary["installation"] == {
        "check": "active",
        "declaredArtifactOnly": True,
        "pluginId": "candlescope.native-reference",
        "providerVersion": "1.0.0",
        "quickRepeat": True,
        "receiptSchema": 3,
        "runtimeId": "native-host",
        "runtimeKind": "native-executable",
        "transcriptSha256": (
            "sha256:a3da7d49d645be03a6d33962c0a6c5f6664c4398fda5c260ddea47bb92e003d5"
        ),
        "venvCreated": False,
    }
    assert boundary["errors"] == {
        "artifactTamper": "PLUGIN_PLATFORM_INSTALLER_FAILED",
        "multiRuntimeOff": "PLUGIN_MULTI_RUNTIME_FEATURE_DISABLED",
        "nativeFlagOff": "PLUGIN_RUNTIME_PROVIDER_UNAVAILABLE",
        "platformMismatch": "PLUGIN_RUNTIME_PROVIDER_PLATFORM_MISMATCH",
    }
    assert boundary["faults"] == {
        "crash-invoke": "PLUGIN_PLATFORM_EXITED",
        "crash-start": "PLUGIN_PLATFORM_EXITED",
        "hang-invoke": "PLUGIN_PLATFORM_TIMEOUT",
        "hang-start": "PLUGIN_PLATFORM_TIMEOUT",
        "invalid-utf8": "PLUGIN_PLATFORM_RESPONSE_INVALID_JSON",
        "stderr-flood": "PLUGIN_PLATFORM_STDERR_LIMIT_EXCEEDED",
        "stdout-pollution": "PLUGIN_PLATFORM_RESPONSE_INVALID_JSON",
    }
    assert boundary["disabledActivation"] == {
        "automaticFallback": False,
        "available": False,
        "enabled": True,
        "reason": "PLUGIN_RUNTIME_PROVIDER_UNAVAILABLE",
        "state": "active",
        "supervisors": 0,
    }
    assert boundary["trustedLocal"]["processTreeControl"] is True
    assert boundary["trustedLocal"]["residualProcesses"] == 0
    assert boundary["trustedLocal"]["residualSupervisors"] == 0
    assert boundary["restrictedWindows"] == {
        "activeProcesses": 1,
        "appContainerSid": True,
        "declaredArtifactOnly": True,
        "outsideExecutableStarted": False,
        "outsideFileRead": False,
        "processTreeControl": True,
        "residualProcesses": 0,
        "residualSupervisors": 0,
        "trust": "untrusted-appcontainer",
    }
    assert boundary["rollback"]["nativeFlag"] is False
    assert boundary["rollback"]["restoredRuntimeKind"] == "python-module"
    assert boundary["rollback"]["restoredArtifact"] is None
    assert boundary["rollback"]["invoke"] == "pass"
    assert boundary["performance"]["result"] == "within-budget"
    assert (
        boundary["performance"]["nativeInstallMs"]
        <= boundary["performance"]["installMaximumMs"]
    )
    assert (
        boundary["performance"]["nativeStartupMedianMs"]
        <= boundary["performance"]["startupMaximumMs"]
    )
    assert (
        boundary["performance"]["nativeWorkingSetMedianBytes"]
        <= boundary["performance"]["workingSetMaximumBytes"]
    )


def test_phase3_cli_prints_and_atomically_writes_contract(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    output = tmp_path / "nested" / "phase3-contract.json"
    assert phase3.main(["--print-contract", "--output", str(output)]) == 0
    captured = capsys.readouterr()

    assert captured.err == ""
    assert json.loads(captured.out) == phase3.capture_contract()
    assert json.loads(output.read_text(encoding="utf-8")) == phase3.capture_contract()
    assert list(output.parent.glob(f".{output.name}.*")) == []
