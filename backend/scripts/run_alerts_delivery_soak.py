"""Own and record a durable alert-delivery soak process.

The launcher must remain the parent of the soak process.  On Windows, a
``Process`` object obtained later with ``Get-Process`` can be waited on but does
not expose the process exit code.  Keeping the original ``Popen`` handle makes
the exit code authoritative and lets the release gate fail closed.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Sequence

BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_DIR = BACKEND_DIR.parent
SOAK_SCRIPT = Path(__file__).with_name("soak_alerts_delivery.py")


def _now() -> datetime:
    return datetime.now().astimezone()


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    rendered = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    try:
        temporary.write_text(rendered, encoding="utf-8")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _git_output(*args: str) -> str:
    completed = subprocess.run(
        ["git", *args],
        cwd=REPO_DIR,
        capture_output=True,
        text=True,
        check=True,
    )
    return completed.stdout.strip()


def _git_metadata() -> dict[str, Any]:
    return {
        "sha": _git_output("rev-parse", "HEAD"),
        "dirty": bool(_git_output("status", "--porcelain", "--untracked-files=all")),
    }


def _prepare_evidence_dir(evidence_root: Path, git_sha: str) -> Path:
    evidence_dir = evidence_root.resolve() / git_sha / "alerts"
    evidence_dir.mkdir(parents=True, exist_ok=True)
    if any(evidence_dir.iterdir()):
        raise RuntimeError(f"evidence directory must be empty: {evidence_dir}")
    return evidence_dir


def run_owned_process(
    command: Sequence[str],
    *,
    cwd: Path,
    evidence_dir: Path,
    manifest: dict[str, Any],
) -> int:
    """Run one child, retaining its original handle until exit evidence exists."""

    stdout_path = evidence_dir / "alerts-delivery-soak.stdout.log"
    stderr_path = evidence_dir / "alerts-delivery-soak.stderr.log"
    exit_path = evidence_dir / "process-exit.json"
    started_at = _now()

    with stdout_path.open("xb") as stdout, stderr_path.open("xb") as stderr:
        process = subprocess.Popen(
            [str(item) for item in command],
            cwd=cwd,
            stdout=stdout,
            stderr=stderr,
        )
        try:
            launch_manifest = {
                **manifest,
                "schemaVersion": 2,
                "launcherPid": os.getpid(),
                "pid": process.pid,
                "startedAt": started_at.isoformat(),
                "workingDirectory": str(cwd),
                "command": [str(item) for item in command],
                "stdout": stdout_path.name,
                "stderr": stderr_path.name,
                "processExit": exit_path.name,
            }
            _atomic_json(evidence_dir / "launch-manifest.json", launch_manifest)
            exit_code = int(process.wait())
        except BaseException as exc:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            _atomic_json(
                exit_path,
                {
                    "schemaVersion": 1,
                    "pid": process.pid,
                    "exitCode": int(process.returncode),
                    "exitedAt": _now().isoformat(),
                    "launcherFailure": {
                        "type": type(exc).__name__,
                        "message": str(exc)[:2_000],
                    },
                },
            )
            raise

    _atomic_json(
        exit_path,
        {
            "schemaVersion": 1,
            "pid": process.pid,
            "exitCode": exit_code,
            "exitedAt": _now().isoformat(),
        },
    )
    return exit_code


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence-root", type=Path, required=True)
    parser.add_argument("--duration-seconds", type=float, default=86_400.0)
    parser.add_argument("--cycles", type=int, default=0)
    parser.add_argument("--restart-every", type=int, default=25)
    parser.add_argument("--crash-every", type=int, default=100)
    parser.add_argument("--failure-every", type=int, default=7)
    parser.add_argument("--retain-delivered", type=int, default=100_000)
    parser.add_argument("--sample-every-seconds", type=float, default=30.0)
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    if args.duration_seconds <= 0 or args.cycles < 0:
        raise SystemExit("duration must be positive and cycles must be non-negative")

    git = _git_metadata()
    if git["dirty"]:
        raise SystemExit("formal soak launcher requires a clean Git HEAD")
    evidence_dir = _prepare_evidence_dir(args.evidence_root, str(git["sha"]))
    report_path = evidence_dir / "alerts-delivery-soak-24h.json"
    state_dir = evidence_dir / "state"
    command = [
        sys.executable,
        str(SOAK_SCRIPT),
        "--duration-seconds",
        str(args.duration_seconds),
        "--cycles",
        str(args.cycles),
        "--restart-every",
        str(args.restart_every),
        "--crash-every",
        str(args.crash_every),
        "--failure-every",
        str(args.failure_every),
        "--retain-delivered",
        str(args.retain_delivered),
        "--sample-every-seconds",
        str(args.sample_every_seconds),
        "--require-clean-head",
        "--state-dir",
        str(state_dir),
        "--report",
        str(report_path),
    ]
    expected_end = (
        None
        if args.cycles > 0
        else (_now() + timedelta(seconds=args.duration_seconds)).isoformat()
    )
    exit_code = run_owned_process(
        command,
        cwd=REPO_DIR,
        evidence_dir=evidence_dir,
        manifest={
            "gitSha": git["sha"],
            "gitDirty": git["dirty"],
            "expectedEndAt": expected_end,
            "report": report_path.name,
        },
    )
    print(
        json.dumps(
            {
                "evidenceDirectory": str(evidence_dir),
                "exitCode": exit_code,
                "report": str(report_path),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
