from __future__ import annotations

from scripts import plugin_platform_multi_runtime_phase8 as phase8


def test_phase8_frozen_contract_matches_implementation() -> None:
    contract = phase8.validate_contract()
    assert contract["schemaVersion"] == phase8.CONTRACT_SCHEMA_VERSION
    assert contract["runtimeRegistry"]["revision"] == 5
    assert contract["provider"]["managedRuntimeOnly"] is True
    assert contract["provider"]["network"] is False
    assert contract["referencePlugin"]["reproducibleBuilds"] == 2


def test_phase8_recorded_real_gate_is_current_and_passed() -> None:
    evidence = phase8.validate_real_gate_evidence()
    assert evidence["wasmtime"]["offlineQuick"] is True
    assert evidence["runtime"]["cancelCode"] == "PLUGIN_WASM_CANCELLED"
    assert evidence["crossHost"]["sandboxClaim"] == "wasi-boundary-only"
    assert evidence["marketplace"]["sandboxStatus"] == "windows-appcontainer"
    assert evidence["marketplace"]["residualProcesses"] == 0


def test_phase8_release_gate_summary_is_fail_closed() -> None:
    result = phase8.run_gate()
    assert result["schemaVersion"] == phase8.GATE_SCHEMA_VERSION
    assert result["result"] == "pass"
    assert result["defaultsRemainOff"] is True
    assert result["linuxSandboxClaim"] == "wasi-boundary-only"
