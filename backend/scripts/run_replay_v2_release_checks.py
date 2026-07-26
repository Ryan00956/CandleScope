"""Run backend and frontend Phase 18 release checks on one clean Git HEAD."""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

try:
    from scripts.replay_v2_release_common import (
        BACKEND_ROOT,
        FRONTEND_ROOT,
        assert_clean_head,
        capture_clean_head,
        npm_command,
        require_external_head_path,
        run_recorded_command,
        utc_now,
        write_json,
    )
except ModuleNotFoundError:
    from replay_v2_release_common import (  # type: ignore[no-redef]
        BACKEND_ROOT,
        FRONTEND_ROOT,
        assert_clean_head,
        capture_clean_head,
        npm_command,
        require_external_head_path,
        run_recorded_command,
        utc_now,
        write_json,
    )


SCHEMA_VERSION = "replay.v2.release-checks.v1"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--npm", default="npm")
    parser.add_argument("--backend-timeout-seconds", type=int, default=7_200)
    parser.add_argument("--frontend-timeout-seconds", type=int, default=7_200)
    args = parser.parse_args()
    if args.backend_timeout_seconds < 60 or args.frontend_timeout_seconds < 60:
        parser.error("release check timeouts must be at least 60 seconds")
    return args


def main() -> int:
    args = parse_args()
    evidence = capture_clean_head()
    head = str(evidence["git_head"])
    output = require_external_head_path(args.out, head)
    log_directory = output.parent / "logs" / "checks"
    environment = dict(os.environ)
    environment.update({"PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"})

    backend, backend_stdout, _ = run_recorded_command(
        name="backend-pytest",
        command=[sys.executable, "-m", "pytest", "-q"],
        cwd=BACKEND_ROOT,
        log_directory=log_directory,
        expected_head=head,
        timeout_seconds=args.backend_timeout_seconds,
        environment=environment,
    )
    frontend, frontend_stdout, _ = run_recorded_command(
        name="frontend-check",
        command=npm_command(args.npm, "run", "check"),
        cwd=FRONTEND_ROOT,
        log_directory=log_directory,
        expected_head=head,
        timeout_seconds=args.frontend_timeout_seconds,
        environment=environment,
    )

    backend_match = re.search(r"(?m)^([0-9]+) passed", backend_stdout)
    frontend_match = re.search(r"(?m)^# pass ([0-9]+)$", frontend_stdout)
    if backend_match is None:
        raise RuntimeError("backend release output did not report a pytest pass count")
    if frontend_match is None:
        raise RuntimeError("frontend release output did not report a Node test pass count")
    assert_clean_head(head)
    report = {
        "schema_version": SCHEMA_VERSION,
        "recorded_at": utc_now(),
        "release_evidence": evidence,
        "passed": True,
        "counts": {
            "backend_pytest_passed": int(backend_match.group(1)),
            "frontend_node_tests_passed": int(frontend_match.group(1)),
        },
        "commands": [backend, frontend],
    }
    write_json(output, report)
    assert_clean_head(head)
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
