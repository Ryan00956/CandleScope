from __future__ import annotations

import json

from scripts import plugin_platform_multi_runtime_phase10 as phase10


def test_recorded_phase10_gate_covers_signed_multi_runtime_release_lifecycle() -> None:
    evidence = phase10.validate_real_gate_evidence()

    assert evidence["schemaVersion"] == phase10.REAL_GATE_SCHEMA_VERSION
    assert evidence["result"] == "pass"
    assert evidence["signedIndexChain"]["sequences"] == [1, 2, 3]
    assert evidence["signedIndexChain"]["releaseCounts"] == [2, 3, 3]
    assert evidence["signedIndexChain"]["revocationCounts"] == [0, 0, 1]
    assert evidence["rebuild"] == {
        "independentBuilds": 2,
        "allArtifactDigestsEqual": True,
    }

    releases = evidence["referenceReleases"]
    assert {
        (item["pluginId"], item["version"], item["runtimeKind"]) for item in releases
    } == {
        ("candlescope.ta4j-elliott", "0.1.1", "java-jar"),
        ("candlescope.ta4j-elliott", "0.1.2", "java-jar"),
        ("candlescope.aho-corasick", "0.1.0", "native-executable"),
    }
    assert all(item["reproducibleBuilds"] is True for item in releases)
    assert all(
        item["reviewPolicy"]
        == {
            "distribution": "prebuilt-only",
            "sourceBuild": False,
            "systemRuntimeFallback": False,
            "undeclaredDownloads": False,
        }
        for item in releases
    )
    assert all(len(item["sourceCommit"]) == 40 for item in releases)

    assert evidence["update"]["passed"] is True
    assert evidence["rollback"]["passed"] is True
    assert evidence["rollback"]["reauthorizationRequired"] is True
    assert evidence["revocation"] == {
        "cachedArtifactQuarantined": True,
        "candidateQuarantined": True,
        "disabled": True,
        "installedPayloadRetained": True,
        "localSourceArtifactRetained": True,
        "reasonCode": "MALICIOUS_RELEASE",
    }
    assert evidence["managedRuntime"]["offlineQuickRepeat"] is True
    assert evidence["marketplaceArtifacts"]["offlineCacheRepeat"] is True
    assert evidence["sandbox"]["residualProcesses"] == 0
    assert evidence["sandbox"]["residualSupervisors"] == 0
    assert evidence["defaults"]["marketplaceEnabled"] is False
    assert evidence["telemetry"]["enabledByDefault"] is False
    assert "installationPath" not in json.dumps(evidence)
