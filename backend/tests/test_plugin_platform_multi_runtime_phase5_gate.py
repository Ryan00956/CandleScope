from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts import plugin_platform_multi_runtime_phase5 as phase5


@pytest.fixture(scope="module")
def gate_result() -> dict[str, object]:
    return phase5.run_gate()


def test_phase5_contract_freezes_provider_sdk_registry_adapter_and_rollback() -> None:
    contract = phase5.validate_contract()

    assert contract["schemaVersion"] == phase5.CONTRACT_SCHEMA_VERSION
    assert contract["provider"] == {
        "kind": "java-jar",
        "version": "1.0.0",
        "enabledFlag": "CANDLESCOPE_PLUGIN_RUNTIME_JAVA_ENABLED",
        "enabledDefault": False,
        "registeredWhenDisabled": ["python-module"],
        "registeredWhenEnabled": ["java-jar", "python-module"],
        "policy": contract["provider"]["policy"],
    }
    policy = contract["provider"]["policy"]
    assert policy["sourceCompilation"] is False
    assert policy["maxProcesses"] == 1
    assert all(
        value is True
        for key, value in policy.items()
        if key not in {"sourceCompilation", "maxProcesses"}
    )
    assert contract["javaSdk"]["methods"] == [
        "activate",
        "cancel",
        "deactivate",
        "describe",
        "eventBatch",
        "handshake",
        "healthCheck",
        "invoke",
        "prepareUpgrade",
        "shutdown",
    ]
    assert contract["runtimeRegistry"]["revision"] == 2
    assert contract["runtimeRegistry"]["rollbackToRevision1"] is True
    assert contract["runtimeRegistry"]["runtimeId"] == phase5.JAVA_RUNTIME_ID
    adapter = contract["referenceAdapter"]
    assert adapter["pluginId"] == phase5.JAVA_PLUGIN_ID
    assert adapter["upstream"]["tag"] == "0.23.0"
    assert adapter["managerTrustMode"] == "local-trusted"
    assert adapter["upstreamAlgorithmCopied"] is False
    assert adapter["automaticReplacement"] is False
    assert adapter["hindsightCalibration"] is False
    assert contract["rollback"] == {
        "flag": "CANDLESCOPE_PLUGIN_RUNTIME_JAVA_ENABLED",
        "value": False,
        "pythonRuntimeUnaffected": True,
        "platformV2Unaffected": True,
    }


def test_phase5_contract_drift_fails_closed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    drifted = json.loads(phase5.CONTRACT_PATH.read_text(encoding="utf-8"))
    drifted["referenceAdapter"]["jarSize"] += 1
    path = tmp_path / "phase5-drifted.json"
    path.write_text(json.dumps(drifted), encoding="utf-8")
    monkeypatch.setattr(phase5, "CONTRACT_PATH", path)

    with pytest.raises(phase5.Phase5GateError, match="contract drift"):
        phase5.validate_contract()


def test_phase5_recorded_real_jre_gate_covers_release_lifecycle_and_faults() -> None:
    evidence = phase5.validate_real_gate_evidence()

    assert evidence["schemaVersion"] == phase5.REAL_GATE_SCHEMA_VERSION
    assert evidence["result"] == "pass"
    assert evidence["build"]["reproducibleBuilds"] == 2
    assert evidence["build"]["sdk"].endswith("self-test: PASS")
    assert (
        evidence["build"]["adapterCasesSha256"]
        == (evidence["stable"]["goldenCasesSha256"])
    )
    assert evidence["build"]["adapterBoundaries"] == {
        "maxBarsAnalyzed": 5000,
        "maxTimestampSeconds": 253_402_297_199,
        "numericType": "DecimalNum",
        "overMaxBarsRejected": True,
    }
    assert evidence["build"]["adapterLegalArtifacts"] == list(
        phase5.ADAPTER_LEGAL_ARTIFACTS
    )
    assert evidence["jre"]["runtimeId"] == phase5.JAVA_RUNTIME_ID
    assert evidence["jre"]["firstDownloadedFiles"] == 5
    assert evidence["jre"]["repeatQuick"] is True
    assert evidence["jre"]["offlineQuick"] is True
    assert len(evidence["jre"]["downloadUrls"]) == 5
    assert len(evidence["jre"]["evidence"]) == 4
    assert evidence["installation"]["state"] == "active"
    assert evidence["installation"]["quickRepeat"] is True
    assert (
        evidence["installation"]["freshProcessProbe"]
        == (evidence["stable"]["transcriptSha256"])
    )
    assert (
        evidence["installation"]["bundleSha256"]
        == (evidence["installation"]["rollbackBundleSha256"])
    )
    assert (
        evidence["installation"]["updateBundleSha256"]
        != (evidence["installation"]["bundleSha256"])
    )
    assert evidence["installation"]["updateState"] == "active"
    assert evidence["runtime"]["hotCalls"] == 100
    assert evidence["runtime"]["cancelled"] is True
    assert evidence["runtime"]["healthPending"] == 0
    assert evidence["runtime"]["residualProcesses"] == 0
    assert evidence["runtime"]["residualSupervisors"] == 0
    assert evidence["runtime"]["manager"] == {
        "runtimeKind": "java-jar",
        "runtimeId": phase5.JAVA_RUNTIME_ID,
        "jreVersion": "25.0.4+7-LTS",
        "trustMode": "local-trusted",
        "verificationStatus": "verified",
        "upstreamSourceUrl": evidence["jre"]["downloadUrls"][0],
        "artifactSha256": evidence["stable"]["adapterJarSha256"],
    }
    assert evidence["faults"] == {
        "Crash": "PLUGIN_PLATFORM_EXITED",
        "Hang": "PLUGIN_PLATFORM_TIMEOUT",
        "OutOfMemory": "PLUGIN_PLATFORM_RESPONSE_INVALID_JSON",
        "StderrFlood": "PLUGIN_PLATFORM_STDERR_LIMIT_EXCEEDED",
    }
    assert evidence["disabled"] == {
        "available": False,
        "reason": "PLUGIN_RUNTIME_PROVIDER_UNAVAILABLE",
        "supervisors": 0,
    }
    assert evidence["registryRollback"] == {
        "toRevision": 1,
        "java25UnavailableCode": "PLUGIN_RUNTIME_REGISTRY_RUNTIME_NOT_FOUND",
        "restoredRevision": 2,
    }


def test_phase5_gate_binds_recorded_evidence_to_the_frozen_contract(
    gate_result: dict[str, object],
) -> None:
    assert gate_result["schemaVersion"] == phase5.GATE_SCHEMA_VERSION
    assert gate_result["result"] == "pass"
    assert gate_result["real"] == {
        "runtimeId": phase5.JAVA_RUNTIME_ID,
        "hotCalls": 100,
        "faults": {
            "Crash": "PLUGIN_PLATFORM_EXITED",
            "Hang": "PLUGIN_PLATFORM_TIMEOUT",
            "OutOfMemory": "PLUGIN_PLATFORM_RESPONSE_INVALID_JSON",
            "StderrFlood": "PLUGIN_PLATFORM_STDERR_LIMIT_EXCEEDED",
        },
        "residualProcesses": 0,
    }


def test_phase5_cli_prints_and_atomically_writes_contract(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    output = tmp_path / "nested" / "phase5-contract.json"
    assert phase5.main(["--print-contract", "--output", str(output)]) == 0
    captured = capsys.readouterr()

    assert captured.err == ""
    assert json.loads(captured.out) == phase5.capture_contract()
    assert json.loads(output.read_text(encoding="utf-8")) == phase5.capture_contract()
    assert list(output.parent.glob(f".{output.name}.*")) == []
