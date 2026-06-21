from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_ta_capture_preflight_accepts_export(tmp_path: Path) -> None:
    manifest = _write_manifest(tmp_path)
    (tmp_path / "sample.csv").write_text(
        "time,open,high,low,close,Close,Pyne Capture Index,Volume\n"
        "1,10,11,9,10,10,0,100\n"
        "2,11,12,10,11,11,1,200\n",
        encoding="utf-8",
    )

    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "ta_capture_preflight.py"),
            str(manifest),
        ],
        check=True,
        cwd=ROOT,
        capture_output=True,
        text=True,
    )

    assert "1/1 ok, 0 issue(s)" in completed.stdout


def test_ta_capture_preflight_reports_missing_index(tmp_path: Path) -> None:
    manifest = _write_manifest(tmp_path)
    (tmp_path / "sample.csv").write_text(
        "time,open,high,low,close,Close,Volume\n"
        "1,10,11,9,10,10,100\n"
        "2,11,12,10,11,11,200\n",
        encoding="utf-8",
    )

    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "ta_capture_preflight.py"),
            str(manifest),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 1
    assert "missing_capture_index" in completed.stdout


def _write_manifest(tmp_path: Path) -> Path:
    manifest = tmp_path / "manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "capture_type": "ta",
                "entries": [
                    {
                        "fixture": "ta_sample_indicators.json",
                        "expected_export_file": "sample.csv",
                        "bars_file": "sample_bars.csv",
                        "bar_count": 2,
                        "plot_titles": ["Close"],
                        "capture_index_title": "Pyne Capture Index",
                        "time_alignment_required": False,
                    }
                ],
            }
        )
        + "\n",
        encoding="utf-8",
    )
    return manifest
