from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_strategy_capture_status_json_report() -> None:
    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "strategy_capture_status.py"),
            "--json",
        ],
        check=True,
        cwd=ROOT,
        capture_output=True,
        text=True,
    )

    report = json.loads(completed.stdout)

    assert report["counts"]["total"] == 27
    assert report["counts"]["captured"] == 27
    assert report["counts"]["not_captured"] == 0
    assert report["counts"]["missing"] == 0
    assert report["counts"]["priority_total"] == 10
    assert report["counts"]["priority_captured"] == 10
    assert all(case["provider"] == "tradingview" for case in report["cases"])
    smoke = report["cases"][0]
    assert smoke["fixture"] == "strategy_pine_equivalent_smoke.json"
    assert smoke["case"] == "market_round_trip_process_on_close"
    assert smoke["priority"] is True
    assert smoke["provider"] == "tradingview"
    assert smoke["status"] == "captured"


def test_strategy_capture_status_priority_cases_have_capture_contract() -> None:
    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "strategy_capture_status.py"),
            "--json",
        ],
        check=True,
        cwd=ROOT,
        capture_output=True,
        text=True,
    )

    report = json.loads(completed.stdout)
    priority_cases = [case for case in report["cases"] if case["priority"]]

    assert len(priority_cases) == report["counts"]["priority_total"]
    assert priority_cases
    assert all(case["provider"] == "tradingview" for case in priority_cases)
    assert all(case["status"] in {"not_captured", "captured"} for case in priority_cases)


def test_strategy_capture_status_missing_only() -> None:
    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "strategy_capture_status.py"),
            "--json",
            "--missing-only",
        ],
        check=True,
        cwd=ROOT,
        capture_output=True,
        text=True,
    )

    report = json.loads(completed.stdout)

    assert all(case["status"] != "captured" for case in report["cases"])
    expected_missing = report["counts"]["not_captured"] + report["counts"]["missing"]
    assert len(report["cases"]) == expected_missing
