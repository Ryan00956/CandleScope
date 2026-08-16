from __future__ import annotations

import pytest

from scripts import plugin_platform_multi_runtime_phase9 as phase9


@pytest.fixture(scope="session")
def gate_result() -> dict[str, object]:
    return phase9.run_gate()


def test_phase9_real_second_project_gate(gate_result: dict[str, object]) -> None:
    assert gate_result["schemaVersion"] == phase9.GATE_SCHEMA_VERSION
    assert gate_result["result"] == "pass"
    assessment = gate_result["assessment"]
    assert isinstance(assessment, dict)
    assert assessment["helperDisabledError"] == "PLUGIN_GITHUB_IMPORT_FEATURE_DISABLED"
    assert assessment["partialOutput"] is False
    build = gate_result["build"]
    assert isinstance(build, dict)
    assert build["networkAccessDuringBuild"] is False
    assert build["reproducibleBuilds"] == 2
    assert build["buildPath"] == {
        "canonicalDrive": "Q:",
        "remappedCargoHome": "/cargo/home",
        "remappedRepositoryRoot": "/candlescope/source",
        "strategy": "windows-subst-drive-v1",
    }
    assert build["bundleRepeatIdentical"] is True
    assert build["bundleSha256"] == phase9.EXPECTED_BUNDLE_SHA256


def test_phase9_install_check_and_rollback_gate(gate_result: dict[str, object]) -> None:
    installation = gate_result["installation"]
    assert isinstance(installation, dict)
    assert installation == {
        "disableEnable": True,
        "finalRegistryEmpty": True,
        "freshInstall": True,
        "freshProcessCheck": "active",
        "helperFlagRollbackCheck": "active",
        "nativeFlagOffError": "PLUGIN_RUNTIME_PROVIDER_UNAVAILABLE",
        "pluginId": "candlescope.aho-corasick",
        "quickRepeat": True,
        "runtimeId": "native-host",
        "runtimeKind": "native-executable",
        "semanticProbeSha256": (
            "sha256:6984851b56ecf44f860501c4fee6043742e34afa20e9198c102d858f344c91e2"
        ),
        "uninstall": True,
    }
