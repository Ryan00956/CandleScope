from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_strategy_capture_preflight_accepts_matching_export(tmp_path: Path) -> None:
    manifest = write_pack(tmp_path)
    (tmp_path / "sample.csv").write_text(
        "time,Position,Net Profit\n1,0,0\n2,1,2\n",
        encoding="utf-8",
    )

    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "strategy_capture_preflight.py"),
            str(manifest),
            "--json",
        ],
        check=True,
        cwd=ROOT,
        capture_output=True,
        text=True,
    )

    report = json.loads(completed.stdout)
    assert report["counts"] == {"cases": 1, "ok": 1, "issues": 0}
    assert report["issues"] == []


def test_strategy_capture_preflight_reports_missing_export(tmp_path: Path) -> None:
    manifest = write_pack(tmp_path)

    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "strategy_capture_preflight.py"),
            str(manifest),
            "--json",
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 1
    report = json.loads(completed.stdout)
    assert report["issues"][0]["kind"] == "missing_export"


def test_strategy_capture_preflight_reports_plot_and_row_issues(tmp_path: Path) -> None:
    manifest = write_pack(tmp_path)
    (tmp_path / "sample.csv").write_text(
        "time,Position,Unknown\n1,0,9\n",
        encoding="utf-8",
    )

    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "strategy_capture_preflight.py"),
            str(manifest),
            "--json",
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 1
    report = json.loads(completed.stdout)
    kinds = [issue["kind"] for issue in report["issues"]]
    assert kinds == ["missing_plot", "unknown_plot", "row_count", "time_alignment"]


def test_strategy_capture_preflight_case_filter(tmp_path: Path) -> None:
    manifest = write_pack(tmp_path)

    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "strategy_capture_preflight.py"),
            str(manifest),
            "--case",
            "other",
            "--json",
        ],
        check=True,
        cwd=ROOT,
        capture_output=True,
        text=True,
    )

    report = json.loads(completed.stdout)
    assert report["counts"] == {"cases": 0, "ok": 0, "issues": 0}


def write_pack(tmp_path: Path) -> Path:
    (tmp_path / "sample_bars.csv").write_text(
        "time,open,high,low,close,volume\n1,10,10,10,10,100\n2,11,11,11,11,100\n",
        encoding="utf-8",
    )
    manifest = tmp_path / "manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "entries": [
                    {
                        "fixture": "fixture.json",
                        "case": "sample",
                        "expected_export_file": "sample.csv",
                        "bars_file": "sample_bars.csv",
                        "bar_count": 2,
                        "plot_titles": ["Position", "Net Profit"],
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    return manifest
