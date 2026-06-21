from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_request_capture_next_uses_manifest(tmp_path: Path) -> None:
    out_dir = tmp_path / "capture-pack"
    golden_dir = tmp_path / "golden"
    golden_dir.mkdir()
    fixture_name = "request_security_time_close_capture.json"
    fixture = json.loads((ROOT / "tests" / "golden" / fixture_name).read_text(encoding="utf-8"))
    fixture["external_capture"] = {
        **fixture["external_capture"],
        "status": "not_captured",
        "series": {},
        "provider_bars": [],
    }
    (golden_dir / fixture_name).write_text(
        json.dumps(fixture, indent=2) + "\n",
        encoding="utf-8",
    )

    subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "request_capture_prepare.py"),
            "--out-dir",
            str(out_dir),
        ],
        check=True,
        cwd=ROOT,
    )

    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "request_capture_next.py"),
            "--golden-dir",
            str(golden_dir),
            "--manifest",
            str(out_dir / "manifest.json"),
            "--json",
        ],
        check=True,
        cwd=ROOT,
        capture_output=True,
        text=True,
    )

    task = json.loads(completed.stdout)
    assert task["status"] == "pending"
    assert task["fixture"] == fixture_name
    assert task["capture_status"] == "not_captured"
    assert task["priority"] is True
    assert task["pine_file"] == "03_request_security_time_close_capture.pine"
    assert task["expected_export_file"] == "03_request_security_time_close_capture.csv"
    assert f"{out_dir.as_posix()}/manifest.json" in task["preflight_command"]
    assert f"{out_dir.as_posix()}/03_request_security_time_close_capture.csv" in task[
        "import_command"
    ]
    assert "--assertion parity" in task["import_command"]
    assert "--assertion parity" in task["diff_command"]
