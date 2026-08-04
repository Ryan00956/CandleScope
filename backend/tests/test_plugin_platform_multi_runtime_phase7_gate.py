from __future__ import annotations

from scripts import plugin_platform_multi_runtime_phase7 as phase7


def test_phase7_frozen_contract_matches_implementation() -> None:
    contract = phase7.validate_contract()
    assert contract["schemaVersion"] == phase7.CONTRACT_SCHEMA_VERSION
    assert contract["runtimeRegistry"]["revision"] == 4
    assert contract["provider"]["esmOnly"] is True
    assert contract["provider"]["packageManagerAtInstallOrRuntime"] is False
    assert contract["typescriptSdk"]["tarballSha256"].startswith("sha256:")


def test_phase7_recorded_real_gate_is_current_and_passed() -> None:
    evidence = phase7.validate_real_gate_evidence()
    assert evidence["node"]["offlineQuick"] is True
    assert evidence["node"]["freshProcess"]["quickRepeat"] is True
    assert evidence["installation"]["globalNpmCacheUntouched"] is True
    assert evidence["runtime"]["cancelled"] is True
    assert evidence["sandbox"]["sandboxMode"] == "windows-appcontainer"
    assert evidence["marketplace"]["residualProcesses"] == 0
    assert evidence["registryRollback"] == {
        "fromRevision": 5,
        "steps": [
            {"fromRevision": 5, "toRevision": 4},
            {"fromRevision": 4, "toRevision": 3},
        ],
        "toRevision": 3,
        "nodeUnavailableCode": "PLUGIN_RUNTIME_REGISTRY_RUNTIME_NOT_FOUND",
        "restoredRevision": 4,
    }


def test_phase7_release_gate_summary_is_fail_closed() -> None:
    result = phase7.run_gate()
    assert result["schemaVersion"] == phase7.GATE_SCHEMA_VERSION
    assert result["result"] == "pass"
    assert result["defaultsRemainOff"] is True
    assert result["signedMarketplaceSandbox"] == "windows-appcontainer"
