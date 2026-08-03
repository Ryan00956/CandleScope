from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts import plugin_platform_multi_runtime_phase1 as phase1


@pytest.fixture(scope="module")
def gate_result() -> dict[str, object]:
    return phase1.run_gate()


def test_phase1_contract_rebuilds_exact_v2_and_v3_generations() -> None:
    contract = phase1.validate_contract()

    assert contract["schemaVersion"] == phase1.CONTRACT_SCHEMA_VERSION
    assert contract["protocol"] == {
        "plugin": "candlescope.plugin/2",
        "controlTransport": "jsonl/1",
    }
    assert contract["frozenV2"]["manifestSchemaVersion"] == 2
    assert contract["frozenV2"]["manifestSchemaCanonicalSha256"] == (
        "sha256:16bc9cb9f51b66ad2e717cd74798cd5c2e0b6a7d6d0fc2f442ba60f68cb1b5a5"
    )
    assert contract["frozenV2"]["historicalPhase0BundleSha256"] != {
        version: item["sha256"]
        for version, item in contract["frozenV2"]["phase1SdkBundleGeneration"].items()
    }
    assert contract["manifestV3"]["runtimeKinds"] == list(phase1.RUNTIME_KINDS)
    assert set(contract["bundleV3"]["referenceBundles"]) == set(phase1.RUNTIME_KINDS)
    assert contract["activationRegistry"] == {
        "readSchemaVersions": [2, 3],
        "writeSchemaVersion": 3,
        "losslessV2RollbackExport": True,
        "entrypointFields": [
            "artifactSha256",
            "id",
            "launch",
            "runtimeId",
            "runtimeKind",
        ],
        "v2RuntimeKind": "python-module",
        "v2RuntimeId": "python-v2-compat",
    }
    assert contract["executionBoundary"]["default"] is False
    assert contract["executionBoundary"]["schemaV3ProvidersAvailable"] == []


def test_phase1_contract_drift_fails_closed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    drifted = json.loads(phase1.CONTRACT_PATH.read_text(encoding="utf-8"))
    drifted["manifestV3"]["schemaCanonicalSha256"] = "sha256:" + "0" * 64
    path = tmp_path / "drifted.json"
    path.write_text(json.dumps(drifted), encoding="utf-8")
    monkeypatch.setattr(phase1, "CONTRACT_PATH", path)

    with pytest.raises(phase1.Phase1GateError, match="contract drift"):
        phase1.validate_contract()


def test_phase1_gate_executes_v2_and_keeps_v3_inspect_only(
    gate_result: dict[str, object],
) -> None:
    assert gate_result["schemaVersion"] == phase1.GATE_SCHEMA_VERSION
    assert gate_result["result"] == "pass"
    boundary = gate_result["boundary"]
    assert boundary["schemaV3"] == {
        "inspectedKind": "java-jar",
        "featureOffError": "PLUGIN_MULTI_RUNTIME_FEATURE_DISABLED",
        "providerUnavailableError": "PLUGIN_RUNTIME_PROVIDER_UNAVAILABLE",
        "productStateCreated": False,
    }
    assert boundary["schemaV2"]["checkState"] == "active"
    assert boundary["schemaV2"]["quickRepeat"] is True
    assert boundary["schemaV2"]["registrySchemaVersion"] == 3
    assert boundary["schemaV2"]["runtimeKind"] == "python-module"
    assert boundary["schemaV2"]["runtimeId"] == "python-v2-compat"
    assert boundary["registryMigration"] == {
        "sourceSchemaVersion": 2,
        "loadedSchemaVersion": 3,
        "writeSchemaVersion": 3,
        "rollbackExportSchemaVersion": 2,
        "sourceFileUnchanged": True,
    }


def test_phase1_cli_prints_and_atomically_writes_contract(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    output = tmp_path / "nested" / "contract.json"
    assert phase1.main(["--print-contract", "--output", str(output)]) == 0
    captured = capsys.readouterr()

    assert captured.err == ""
    assert json.loads(captured.out) == phase1.capture_contract()
    assert json.loads(output.read_text(encoding="utf-8")) == phase1.capture_contract()
    assert list(output.parent.glob(f".{output.name}.*")) == []
