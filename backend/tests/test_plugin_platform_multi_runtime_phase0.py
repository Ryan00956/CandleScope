from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from scripts import plugin_platform_multi_runtime_phase0 as phase0


BOOTSTRAP = (
    phase0.REPOSITORY_ROOT / "backend" / "app" / "plugin_core_v2" / "bootstrap.py"
)


@pytest.fixture(scope="module")
def gate_result() -> dict[str, object]:
    return phase0.run_gate()


def test_phase0_contract_matches_current_v2_and_freezes_future_names() -> None:
    contract = phase0.validate_frozen_contract()

    assert contract["schemaVersion"] == phase0.CONTRACT_SCHEMA_VERSION
    assert contract["frozenV2"]["protocol"] == {
        "plugin": "candlescope.plugin/2",
        "hostApi": "candlescope.host-api/1",
        "controlTransport": "jsonl/1",
    }
    assert contract["frozenV2"]["manifestV2"]["schemaVersion"] == 2
    assert contract["frozenV2"]["manifestV2"]["entrypointRequired"] == [
        "id",
        "pythonModule",
        "resourceProfile",
        "activationEvents",
    ]
    assert contract["frozenV2"]["referencePythonPlugin"]["normalizationTarget"][
        "runtime"
    ] == {
        "kind": "python-module",
        "runtimeId": "python-v2-compat",
        "module": "candlescope_plugin_sdk.platform_v2.examples.hello_command",
    }

    future = contract["futureContract"]
    assert future["manifestSchemaVersion"] == 3
    assert [item["kind"] for item in future["runtimeKinds"]] == [
        "python-module",
        "native-executable",
        "java-jar",
        "node-module",
        "wasm-component",
    ]
    assert len(future["artifactRoles"]) == len(set(future["artifactRoles"]))
    assert all(
        item["default"] is False and item["wiredInPhase0"] is False
        for item in future["featureFlags"]
    )
    assert {item["name"] for item in future["featureFlags"]} == set(
        phase0.FEATURE_FLAGS
    )
    assert future["errorNamespaces"] == list(phase0.ERROR_NAMESPACES)

    ta4j = contract["ta4j"]
    assert ta4j["stableTag"] == "0.23.0"
    assert ta4j["javaRelease"] == 25
    assert ta4j["license"] == "MIT"
    assert re.fullmatch(r"[0-9a-f]{40}", ta4j["peeledCommit"])


def test_phase0_flags_were_not_wired_into_the_phase0_composition_root() -> None:
    bootstrap = BOOTSTRAP.read_text(encoding="utf-8")
    for name in phase0.FEATURE_FLAGS:
        assert name not in bootstrap


def test_phase0_contract_drift_fails_closed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    drifted = json.loads(phase0.CONTRACT_PATH.read_text(encoding="utf-8"))
    drifted["frozenV2"]["manifestV2"]["canonicalSha256"] = "sha256:" + "0" * 64
    path = tmp_path / "drifted.json"
    path.write_text(json.dumps(drifted), encoding="utf-8")
    monkeypatch.setattr(phase0, "CONTRACT_PATH", path)

    with pytest.raises(phase0.Phase0GateError, match="contract drift"):
        phase0.validate_frozen_contract()


def test_phase0_gate_exercises_real_python_bundle_lifecycle(
    gate_result: dict[str, object],
) -> None:
    assert gate_result["schemaVersion"] == phase0.GATE_SCHEMA_VERSION
    assert gate_result["result"] == "pass"
    contract = gate_result["contract"]
    assert isinstance(contract, dict)
    assert contract["newFeatureFlagsEnabled"] == []

    lifecycle = gate_result["lifecycle"]
    assert isinstance(lifecycle, dict)
    phase0.validate_lifecycle(lifecycle)
    assert lifecycle["activation"]["version"] == "0.1.0"
    assert lifecycle["activation"]["entrypoints"] == [
        {
            "id": "main",
            "module": "candlescope_plugin_sdk.platform_v2.examples.hello_command",
            "executableRole": "managed-python",
            "workingDirectory": ".",
        }
    ]
    assert lifecycle["freshProcessProbe"]["semanticProbes"] == [
        {
            "id": "hello-transcript",
            "entrypointId": "main",
            "sha256": (
                "sha256:d98ebd2fc9f5b0695925caf47ecf961eae47a56b5e8ec110f28acc9365afdd38"
            ),
        }
    ]


def test_phase0_cli_prints_and_atomically_writes_contract(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    output = tmp_path / "nested" / "contract.json"
    assert phase0.main(["--print-contract", "--output", str(output)]) == 0
    captured = capsys.readouterr()
    assert captured.err == ""
    assert json.loads(captured.out) == phase0.expected_contract()
    assert json.loads(output.read_text(encoding="utf-8")) == phase0.expected_contract()
    assert list(output.parent.glob(f".{output.name}.*")) == []
