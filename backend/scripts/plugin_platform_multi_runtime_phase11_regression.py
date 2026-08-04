#!/usr/bin/env python3
"""Run full backend and frontend regression gates and save bounded evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BACKEND = REPOSITORY_ROOT / "backend"
FRONTEND = REPOSITORY_ROOT / "frontend"
DEFAULT_OUTPUT = (
    REPOSITORY_ROOT
    / "docs/evidence/plugin-platform-multi-runtime-phase11-regression.json"
)
SCHEMA = "candlescope.plugin-platform.multi-runtime.phase11-regression/1"
BACKEND_ENVIRONMENT_OVERRIDES = {
    # The repository-local developer .env may enable Replay against archives that
    # are intentionally absent on a clean test machine.  Plugin Platform GA owns
    # neither that external data nor Replay enablement, so run the general suite
    # against Replay's documented default-off baseline.  Individual Replay tests
    # still construct and exercise enabled settings explicitly.
    "REPLAY_ENABLED": "0",
    "REPLAY_AGG_TRADE_ENABLED": "0",
}


class RegressionError(RuntimeError):
    pass


def _failure_context(value: str, *, radius: int = 30, limit: int = 8_000) -> str:
    lines = value.splitlines()
    marker_indexes = [
        index
        for index, line in enumerate(lines)
        if line.startswith("not ok ") or line.startswith("FAILED ")
    ]
    selected: list[str] = []
    for marker_index in marker_indexes:
        start = max(0, marker_index - 5)
        end = min(len(lines), marker_index + radius + 1)
        selected.extend(lines[start:end])
    return "\n".join(selected)[-limit:]


def _run(
    command: tuple[str, ...],
    *,
    cwd: Path,
    timeout: float,
    environment: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(
        command,
        cwd=cwd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        timeout=timeout,
        check=False,
        shell=False,
        env=environment,
    )
    if completed.returncode:
        failure_context = _failure_context(completed.stdout)
        diagnostic = (
            f"\nfailure context:\n{failure_context}\n" if failure_context else "\n"
        )
        raise RegressionError(
            f"full regression failed ({completed.returncode}): {' '.join(command)}\n"
            + diagnostic
            + "output tail:\n"
            + completed.stdout[-12_000:]
        )
    return completed


def _output(value: str) -> dict[str, Any]:
    return {
        "sha256": "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest(),
        "tail": value[-4_000:].strip(),
    }


def _backend_summary(value: str) -> dict[str, int]:
    passed = re.findall(r"(\d+) passed", value)
    failed = re.findall(r"(\d+) failed", value)
    skipped = re.findall(r"(\d+) skipped", value)
    if not passed:
        raise RegressionError("pytest output contains no passed-test summary")
    return {
        "passed": int(passed[-1]),
        "failed": int(failed[-1]) if failed else 0,
        "skipped": int(skipped[-1]) if skipped else 0,
    }


def _backend_environment() -> dict[str, str]:
    environment = os.environ.copy()
    environment.update(BACKEND_ENVIRONMENT_OVERRIDES)
    return environment


def _git_head() -> str:
    return subprocess.run(
        ("git", "rev-parse", "HEAD"),
        cwd=REPOSITORY_ROOT,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    ).stdout.strip()


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        + "\n",
        encoding="utf-8",
        newline="\n",
    )
    os.replace(temporary, path)


def _console_json(value: dict[str, Any]) -> str:
    """Keep Windows legacy consoles from corrupting an otherwise valid gate result."""
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python", type=Path, required=True)
    parser.add_argument("--npm", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    python = args.python.resolve(strict=True)
    npm = args.npm.resolve(strict=True)
    backend = _run(
        (str(python), "-m", "pytest", "-q"),
        cwd=BACKEND,
        timeout=7_200,
        environment=_backend_environment(),
    )
    frontend = _run((str(npm), "run", "check"), cwd=FRONTEND, timeout=3_600)
    backend_counts = _backend_summary(backend.stdout)
    if backend_counts["failed"]:
        raise RegressionError("backend regression summary contains failures")
    result = {
        "schemaVersion": SCHEMA,
        "result": "pass",
        "generatedAt": datetime.now(UTC)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z"),
        "gitHead": _git_head(),
        "backend": {
            **backend_counts,
            **_output(backend.stdout),
            "environmentOverrides": dict(BACKEND_ENVIRONMENT_OVERRIDES),
        },
        "frontend": {"result": "pass", **_output(frontend.stdout)},
    }
    _atomic_json(args.output.resolve(strict=False), result)
    print(_console_json(result))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RegressionError, OSError, ValueError, subprocess.TimeoutExpired) as exc:
        print(
            _console_json(
                {"ok": False, "errorType": type(exc).__name__, "message": str(exc)}
            ),
            file=sys.stderr,
        )
        raise SystemExit(1) from exc
