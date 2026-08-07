from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


def test_delivery_soak_covers_retention_and_all_process_abort_states(tmp_path: Path) -> None:
    backend_dir = Path(__file__).resolve().parents[1]
    repo_dir = backend_dir.parent
    report_path = tmp_path / "soak-report.json"
    completed = subprocess.run(
        [
            sys.executable,
            str(backend_dir / "scripts" / "soak_alerts_delivery.py"),
            "--cycles",
            "3",
            "--restart-every",
            "0",
            "--crash-every",
            "1",
            "--failure-every",
            "2",
            "--retain-delivered",
            "1",
            "--sample-every-seconds",
            "0.1",
            "--report",
            str(report_path),
        ],
        cwd=repo_dir,
        capture_output=True,
        text=True,
        timeout=30,
    )

    assert completed.returncode == 0, completed.stdout + completed.stderr
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["schemaVersion"] == 2
    assert report["passed"] is True
    assert report["deliveriesCreated"] == 6
    assert report["finalOutbox"]["delivered"] == 1
    assert report["finalOutbox"]["totalDelivered"] == 6
    assert report["finalOutbox"]["totalAttempts"] > 6
    assert report["finalOutbox"]["totalRetryScheduled"] > 0
    assert report["finalOutbox"]["totalDeadLetter"] == 0
    assert report["senderSuccessfulResponses"] == 6
    assert report["crashRecovery"] == {
        "staged": {"injected": 1, "recovered": 1},
        "processing": {"injected": 1, "recovered": 1},
        "retrying": {"injected": 1, "recovered": 1},
    }
    assert report["resourceSummary"]["rssPeakBytes"] > 0
    assert report["resourceSummary"]["databasePeakBytes"] > 0
