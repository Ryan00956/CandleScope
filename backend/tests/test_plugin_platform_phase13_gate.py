from __future__ import annotations

from scripts.plugin_platform_phase13_gate import run_gate


def test_phase13_gate_preserves_frozen_v1_and_v1_only_rollback() -> None:
    evidence = run_gate()

    assert evidence["schemaVersion"] == "candlescope.plugin-platform.phase13-gate/1"
    assert evidence["referenceContract"]["contributions"] == ["script-runtime/1"]
    assert evidence["referenceContract"]["requiredCapabilities"] == []
    assert evidence["frozenV1Contracts"]["wireSha256"] == {
        "sdkTranscript": (
            "sha256:021825fb264a63555e0eb331f24f6ea0632b0d2a0c962ef89a35673526391ba2"
        ),
        "httpCompute": (
            "sha256:b2467295cc14ec0e772e97fce195f236739cecb260e967190d73af305ab6f7ee"
        ),
        "httpRange": (
            "sha256:ba66866f0330d62f1121c3a5ff77d6339d786df796672c9795e78a293c1ebb26"
        ),
        "indicatorWebSocket": (
            "sha256:6326a43822000618fe2feddcfe9b28b5a02e3663be106ef1dabfa511f6e418f2"
        ),
    }
    assert (
        evidence["releaseOne"]["bundleSha256"] != evidence["releaseTwo"]["bundleSha256"]
    )
    assert evidence["rollback"] == {
        "previewSha256": evidence["rollback"]["previewSha256"],
        "restoredSnapshotRevision": 1,
        "statusAgainstLiveReleaseTwo": "stale",
        "v1OnlyPlatformStatus": "disabled",
        "v1OnlyPluginCount": 0,
        "v1WireUnchanged": True,
    }
