from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from scripts import run_alerts_delivery_soak as soak_launcher


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


@pytest.mark.parametrize("expected_exit_code", [0, 7])
def test_owned_soak_process_records_integer_exit_code(
    tmp_path: Path,
    expected_exit_code: int,
) -> None:
    evidence_dir = tmp_path / f"exit-{expected_exit_code}"
    evidence_dir.mkdir()
    exit_code = soak_launcher.run_owned_process(
        [
            sys.executable,
            "-c",
            (
                "import sys; "
                "print('owned stdout'); "
                "print('owned stderr', file=sys.stderr); "
                f"raise SystemExit({expected_exit_code})"
            ),
        ],
        cwd=tmp_path,
        evidence_dir=evidence_dir,
        manifest={"gitSha": "test-sha", "gitDirty": False},
    )

    assert exit_code == expected_exit_code
    process_exit = json.loads(
        (evidence_dir / "process-exit.json").read_text(encoding="utf-8")
    )
    assert process_exit["exitCode"] == expected_exit_code
    assert isinstance(process_exit["exitCode"], int)
    assert process_exit["pid"] > 0
    assert (evidence_dir / "alerts-delivery-soak.stdout.log").read_text(
        encoding="utf-8"
    ).strip() == "owned stdout"
    assert (evidence_dir / "alerts-delivery-soak.stderr.log").read_text(
        encoding="utf-8"
    ).strip() == "owned stderr"


def test_soak_launcher_refuses_to_overwrite_existing_evidence(tmp_path: Path) -> None:
    occupied = tmp_path / "abc123" / "alerts"
    occupied.mkdir(parents=True)
    (occupied / "process-exit.json").write_text("preserve", encoding="utf-8")

    with pytest.raises(RuntimeError, match="evidence directory must be empty"):
        soak_launcher._prepare_evidence_dir(tmp_path, "abc123")

    assert (occupied / "process-exit.json").read_text(encoding="utf-8") == "preserve"


def test_owned_soak_process_is_stopped_if_manifest_write_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    evidence_dir = tmp_path / "manifest-failure"
    evidence_dir.mkdir()
    atomic_json = soak_launcher._atomic_json

    def fail_manifest_once(path: Path, value: dict[str, object]) -> None:
        if path.name == "launch-manifest.json":
            raise OSError("injected manifest failure")
        atomic_json(path, value)

    monkeypatch.setattr(soak_launcher, "_atomic_json", fail_manifest_once)
    with pytest.raises(OSError, match="injected manifest failure"):
        soak_launcher.run_owned_process(
            [sys.executable, "-c", "import time; time.sleep(60)"],
            cwd=tmp_path,
            evidence_dir=evidence_dir,
            manifest={"gitSha": "test-sha", "gitDirty": False},
        )

    process_exit = json.loads(
        (evidence_dir / "process-exit.json").read_text(encoding="utf-8")
    )
    assert isinstance(process_exit["exitCode"], int)
    assert process_exit["exitCode"] != 0
    assert process_exit["launcherFailure"] == {
        "type": "OSError",
        "message": "injected manifest failure",
    }
