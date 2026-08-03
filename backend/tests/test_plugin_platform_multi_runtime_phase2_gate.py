from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts import plugin_platform_multi_runtime_phase2 as phase2


@pytest.fixture(scope="module")
def gate_result() -> dict[str, object]:
    return phase2.run_gate()


def test_phase2_contract_freezes_provider_seam_and_python_equivalence() -> None:
    contract = phase2.validate_contract()

    assert contract["schemaVersion"] == phase2.CONTRACT_SCHEMA_VERSION
    assert contract["providerApi"] == {
        "apiVersion": 1,
        "registeredKinds": ["python-module"],
        "pythonProviderVersion": "1.0.0",
        "contracts": [
            "PreparedRuntime",
            "PreparedLaunch",
            "RuntimeProviderBinding",
        ],
        "methods": [
            "validate_runtime",
            "prepare_installation",
            "verify_installation",
            "prepare_runtime",
            "build_probe_launch",
            "build_runtime_launch",
        ],
    }
    assert contract["pythonV2Launch"]["arguments"] == [
        "-I",
        "-u",
        "-m",
        "candlescope_plugin_sdk.platform_v2.examples.hello_command",
    ]
    assert contract["receipt"]["readSchemaVersions"] == [2, 3]
    assert contract["receipt"]["writeSchemaVersion"] == 3
    assert contract["rollout"] == {
        "multiRuntimeFlag": "CANDLESCOPE_PLUGIN_MULTI_RUNTIME_ENABLED",
        "multiRuntimeDefault": False,
        "providerSeamFlag": "CANDLESCOPE_PLUGIN_RUNTIME_PROVIDER_SEAM_ENABLED",
        "providerSeamDefault": True,
        "rollbackValue": False,
    }
    assert contract["supervisorBoundary"]["importsRuntimeProvider"] is False
    assert contract["supervisorBoundary"]["importsPythonProvider"] is False


def test_phase2_contract_drift_fails_closed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    drifted = json.loads(phase2.CONTRACT_PATH.read_text(encoding="utf-8"))
    drifted["providerApi"]["pythonProviderVersion"] = "9.9.9"
    path = tmp_path / "drifted.json"
    path.write_text(json.dumps(drifted), encoding="utf-8")
    monkeypatch.setattr(phase2, "CONTRACT_PATH", path)

    with pytest.raises(phase2.Phase2GateError, match="contract drift"):
        phase2.validate_contract()


def test_phase2_gate_runs_v2_dual_path_v3_python_and_budgets(
    gate_result: dict[str, object],
) -> None:
    assert gate_result["schemaVersion"] == phase2.GATE_SCHEMA_VERSION
    assert gate_result["result"] == "pass"
    boundary = gate_result["boundary"]
    assert boundary["schemaV2"] == {
        "providerReceiptSchema": 3,
        "rollbackReceiptSchema": 2,
        "probeEquivalent": True,
        "activationEquivalent": True,
        "quickRepeat": True,
        "exactRollback": True,
        "tamperError": "PLUGIN_RUNTIME_PROVIDER_RECEIPT_MISMATCH",
    }
    assert boundary["schemaV3Python"]["runtimeKind"] == "python-module"
    assert boundary["schemaV3Python"]["runtimeId"] == "python-3-13"
    assert boundary["schemaV3Python"]["arguments"] == [
        "-I",
        "-u",
        "-X",
        "utf8",
        "-m",
        "candlescope_plugin_sdk.platform_v2.examples.hello_command",
    ]
    assert boundary["schemaV3Python"]["residualSupervisors"] == 0
    assert boundary["nonPython"] == {
        "nativeError": "PLUGIN_RUNTIME_PROVIDER_UNAVAILABLE"
    }
    assert boundary["performance"]["result"] == "within-budget"
    assert (
        boundary["performance"]["providerRuntime"]["arguments"]
        == (boundary["performance"]["rollbackRuntime"]["arguments"])
    )
    assert boundary["performance"]["providerRuntime"]["residualSupervisors"] == 0
    assert boundary["performance"]["rollbackRuntime"]["residualSupervisors"] == 0


def test_phase2_cli_prints_and_atomically_writes_contract(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    output = tmp_path / "nested" / "phase2-contract.json"
    assert phase2.main(["--print-contract", "--output", str(output)]) == 0
    captured = capsys.readouterr()

    assert captured.err == ""
    assert json.loads(captured.out) == phase2.capture_contract()
    assert json.loads(output.read_text(encoding="utf-8")) == phase2.capture_contract()
    assert list(output.parent.glob(f".{output.name}.*")) == []
