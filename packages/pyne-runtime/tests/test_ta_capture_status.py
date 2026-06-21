from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_ta_capture_status_json_report() -> None:
    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "ta_capture_status.py"),
            "--json",
        ],
        check=True,
        cwd=ROOT,
        capture_output=True,
        text=True,
    )

    report = json.loads(completed.stdout)

    assert report["counts"]["total"] == 9
    assert report["counts"]["captured"] == 9
    assert report["counts"]["not_captured"] == 0
    assert report["counts"]["missing"] == 0
    assert report["counts"]["priority_total"] == 1
    assert report["counts"]["priority_captured"] == 1
    first = report["fixtures"][0]
    assert first["fixture"] == "ta_core_indicators.json"
    assert first["priority"] is True
    assert first["status"] == "captured"
    assert first["assertion"] == "parity"
    second = report["fixtures"][1]
    assert second["fixture"] == "ta_advanced_indicators.json"
    assert second["priority"] is False
    assert second["status"] == "captured"
    assert second["assertion"] == "parity"
    third = report["fixtures"][2]
    assert third["fixture"] == "ta_context_indicators.json"
    assert third["priority"] is False
    assert third["status"] == "captured"
    assert third["assertion"] == "parity"
    fourth = report["fixtures"][3]
    assert fourth["fixture"] == "ta_oscillator_edges_indicators.json"
    assert fourth["priority"] is False
    assert fourth["status"] == "captured"
    assert fourth["assertion"] == "parity"
    fifth = report["fixtures"][4]
    assert fifth["fixture"] == "ta_remaining_indicators.json"
    assert fifth["priority"] is False
    assert fifth["status"] == "captured"
    assert fifth["assertion"] == "parity"
    sixth = report["fixtures"][5]
    assert sixth["fixture"] == "ta_statistics_edges_indicators.json"
    assert sixth["priority"] is False
    assert sixth["status"] == "captured"
    assert sixth["assertion"] == "parity"
    seventh = report["fixtures"][6]
    assert seventh["fixture"] == "ta_trend_switch_indicators.json"
    assert seventh["priority"] is False
    assert seventh["status"] == "captured"
    assert seventh["assertion"] == "parity"
    eighth = report["fixtures"][7]
    assert eighth["fixture"] == "ta_tuple_outputs_indicators.json"
    assert eighth["priority"] is False
    assert eighth["status"] == "captured"
    assert eighth["assertion"] == "parity"
    ninth = report["fixtures"][8]
    assert ninth["fixture"] == "ta_warmup_boundaries_indicators.json"
    assert ninth["priority"] is False
    assert ninth["status"] == "captured"
    assert ninth["assertion"] == "parity"
