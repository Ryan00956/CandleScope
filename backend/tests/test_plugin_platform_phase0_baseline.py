from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from scripts import plugin_platform_phase0_baseline as phase0


REFERENCE_PLUGINS = (
    Path(__file__).parent
    / "fixtures"
    / "plugin_platform_v2"
    / "reference_plugins_v1.json"
)


def test_phase0_frozen_contracts_match_current_v1_fixtures() -> None:
    contracts = phase0.frozen_contracts()

    assert contracts["status"] == "verified"
    assert contracts["fileSha256"] == phase0.FROZEN_FILE_SHA256
    assert contracts["currentOfficialReleaseLockSha256"] == (
        phase0.CURRENT_OFFICIAL_RELEASE_LOCK_SHA256
    )
    assert contracts["wireSha256"] == phase0.FROZEN_WIRE_SHA256
    assert contracts["schemas"] == {
        "sdkTranscript": "candlescope.plugin-sdk-transcript.v1",
        "indicatorTransport": "candlescope.pyne-transport-baseline.v1",
    }


def test_phase0_contract_drift_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    changed = tmp_path / "changed-transcript.json"
    changed.write_text("{}\n", encoding="utf-8")
    monkeypatch.setattr(phase0, "SDK_TRANSCRIPT_FIXTURE", changed)

    with pytest.raises(phase0.BaselineError, match="fixture drift"):
        phase0.frozen_contracts()


def test_reference_plugin_contracts_are_complete_and_fail_closed() -> None:
    fixture = json.loads(REFERENCE_PLUGINS.read_text(encoding="utf-8"))
    plugins = fixture["plugins"]
    by_id = {plugin["id"]: plugin for plugin in plugins}

    assert (
        fixture["schemaVersion"] == "candlescope.plugin-platform.reference-plugins.v1"
    )
    assert len(plugins) == 6
    assert len(by_id) == 6
    assert set(by_id) == {
        "phase0.hello-command",
        "phase0.market-scanner",
        "phase0.sandbox-view",
        "phase0.mock-provider",
        "phase0.paper-broker",
        "phase0.v1-script-runtime-adapter",
    }
    expected_target_phases = {
        "phase0.hello-command": 1,
        "phase0.market-scanner": 7,
        "phase0.sandbox-view": 8,
        "phase0.mock-provider": 10,
        "phase0.paper-broker": 11,
        "phase0.v1-script-runtime-adapter": 13,
    }
    for plugin in plugins:
        assert plugin["firstTargetPhase"] == expected_target_phases[plugin["id"]]
        assert plugin["contributions"]
        assert plugin["acceptance"]
        assert len(set(plugin["contributions"])) == len(plugin["contributions"])
        assert len(set(plugin["requiredCapabilities"])) == len(
            plugin["requiredCapabilities"]
        )
        required = set(plugin["requiredCapabilities"])
        optional = set(plugin["optionalCapabilities"])
        forbidden = set(plugin["forbiddenCapabilities"])
        assert not required & optional
        assert not required & forbidden
        assert not optional & forbidden
        assert "trade.submit" in forbidden

    scanner = by_id["phase0.market-scanner"]
    assert "market.bars.read" in scanner["requiredCapabilities"]
    assert "trade.submit" in scanner["forbiddenCapabilities"]
    paper = by_id["phase0.paper-broker"]
    assert "trade.simulate" in paper["requiredCapabilities"]
    assert "trade.submit" in paper["forbiddenCapabilities"]


def test_quick_baseline_writes_a_machine_readable_artifact(tmp_path: Path) -> None:
    output = tmp_path / "phase0.json"
    environment = dict(os.environ)
    environment["PYTHONIOENCODING"] = "utf-8"
    environment["PYTHONUTF8"] = "1"
    completed = subprocess.run(
        [
            sys.executable,
            str(phase0.SCRIPT_PATH),
            "--quick",
            "--skip-installer",
            "--output",
            str(output),
        ],
        cwd=phase0.REPOSITORY_ROOT,
        env=environment,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=60,
    )
    summary = json.loads(completed.stdout)
    artifact = json.loads(output.read_text(encoding="utf-8"))

    assert summary["ok"] is True
    assert artifact["schemaVersion"] == phase0.SCHEMA_VERSION
    assert artifact["mode"] == "quick"
    assert artifact["contracts"]["status"] == "verified"
    registry = artifact["baselines"]["registryColdStart"]["scenarios"]
    assert {
        name: value["lastChild"]["configured"] for name, value in registry.items()
    } == {
        "0": 0,
        "10": 10,
        "50": 50,
    }
    assert artifact["baselines"]["controlAndIndicator"]["runtime"]["id"] == (
        "hello-runtime"
    )
    assert artifact["baselines"]["controlAndIndicator"]["indicatorBatch"][
        "lastResult"
    ] == {"ok": True, "points": 200, "series": 1}
    assert artifact["baselines"]["klineEventBus"]["eventsDropped"] == 0
    assert artifact["baselines"]["tradeFlow"]["accepted"] == 1_000
    assert artifact["baselines"]["fullOrderBook"]["gaps"] == 0
    assert artifact["baselines"]["installerLifecycle"]["status"] == "not_run"
    assert artifact["baselines"]["officialRuntimes"]["status"] == "not_run"

    artifact["baselines"]["fullOrderBook"]["gaps"] = 1
    with pytest.raises(phase0.BaselineError, match="order-book"):
        phase0.validate_baseline_invariants(artifact, require_official=False)
