"""Run the frozen replay.v1/v2 formal benchmark matrix on a clean Git HEAD."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Mapping

try:
    from scripts.replay_v2_release_common import (
        BACKEND_ROOT,
        artifact,
        assert_clean_head,
        capture_clean_head,
        parse_json_output,
        require_external_head_path,
        run_recorded_command,
        utc_now,
        write_json,
    )
except ModuleNotFoundError:
    from replay_v2_release_common import (  # type: ignore[no-redef]
        BACKEND_ROOT,
        artifact,
        assert_clean_head,
        capture_clean_head,
        parse_json_output,
        require_external_head_path,
        run_recorded_command,
        utc_now,
        write_json,
    )


SCHEMA_VERSION = "replay.v2.release-benchmark.v2"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--timeout-seconds", type=int, default=14_400)
    args = parser.parse_args()
    if args.timeout_seconds < 300:
        parser.error("--timeout-seconds must be at least 300 for the formal profile")
    return args


def _accepted(payload: Mapping[str, object]) -> bool:
    acceptance = payload.get("acceptance")
    return isinstance(acceptance, Mapping) and acceptance.get("passed") is True


def main() -> int:
    args = parse_args()
    evidence = capture_clean_head()
    head = str(evidence["git_head"])
    output = require_external_head_path(args.out, head)
    component_directory = output.parent / "benchmarks"
    log_directory = output.parent / "logs" / "benchmarks"
    environment = dict(os.environ)
    environment.update({"PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"})
    specifications = (
        (
            "core-v1",
            [
                sys.executable,
                "scripts/benchmark_replay.py",
                "--baseline",
                str(BACKEND_ROOT.parent / "docs" / "perf-baselines" / "replay-v1-backend-20260718.json"),
            ],
        ),
        (
            "multitrack-v2",
            [sys.executable, "scripts/benchmark_replay_multitrack.py", "--iterations", "10000"],
        ),
        (
            "segments-v2",
            [
                sys.executable,
                "scripts/benchmark_replay_segments.py",
                "--segments",
                "10000",
                "--iterations",
                "20",
            ],
        ),
        (
            "fast-forward-v2",
            [
                sys.executable,
                "scripts/benchmark_replay_fast_forward.py",
                "--trades",
                "1000000",
                "--span-days",
                "7",
            ],
        ),
        (
            "historical-book-v2",
            [
                sys.executable,
                "scripts/benchmark_replay_historical_book.py",
                "--frames",
                "100000",
            ],
        ),
        (
            "account-history-v2",
            [
                sys.executable,
                "scripts/benchmark_replay_account_history.py",
                "--iterations",
                "8",
            ],
        ),
    )
    commands: list[dict[str, object]] = []
    payloads: dict[str, Mapping[str, object]] = {}
    artifacts: dict[str, dict[str, object]] = {}
    for name, command in specifications:
        record, stdout, _ = run_recorded_command(
            name=name,
            command=command,
            cwd=BACKEND_ROOT,
            log_directory=log_directory,
            expected_head=head,
            timeout_seconds=args.timeout_seconds,
            environment=environment,
        )
        payload = parse_json_output(stdout)
        component_path = component_directory / f"{name}.json"
        write_json(component_path, payload)
        commands.append(record)
        payloads[name] = payload
        artifacts[name] = artifact(component_path)

    core = payloads["core-v1"]
    multitrack = payloads["multitrack-v2"]
    segments = payloads["segments-v2"]
    fast_forward = payloads["fast-forward-v2"]
    historical_book = payloads["historical-book-v2"]
    account_history = payloads["account-history-v2"]
    cases = multitrack.get("cases")
    if not isinstance(cases, list):
        raise RuntimeError("multi-track benchmark did not emit cases")
    checks = {
        "core_v1_acceptance": _accepted(core),
        "multitrack_1_2_4_8": [case.get("track_count") for case in cases if isinstance(case, Mapping)] == [1, 2, 4, 8],
        "multitrack_10000_iterations": all(
            isinstance(case, Mapping) and case.get("iterations") == 10_000
            for case in cases
        ),
        "segment_10000_budget": segments.get("segment_count") == 10_000 and segments.get("budget_pass") is True,
        "storage_inventory_10000_bounded": (
            isinstance(segments.get("inventory_evidence"), Mapping)
            and segments["inventory_evidence"].get("item_count") == 200
            and segments["inventory_evidence"].get("truncated") is True
            and segments.get("inventory_budget_pass") is True
        ),
        "fast_forward_runtime": _accepted(fast_forward),
        "fast_forward_reference_equivalence": isinstance(fast_forward.get("equivalence"), Mapping)
        and fast_forward["equivalence"].get("passed") is True,
        "historical_book_100000": isinstance(historical_book.get("parameters"), Mapping)
        and historical_book["parameters"].get("frames") == 100_000,
        "historical_book_acceptance": _accepted(historical_book),
        "account_history_1_2_4_8": isinstance(
            account_history.get("cases"),
            list,
        )
        and [
            case.get("track_count")
            for case in account_history["cases"]
            if isinstance(case, Mapping)
        ]
        == [1, 2, 4, 8],
        "account_history_acceptance": _accepted(account_history),
    }
    if not all(checks.values()):
        raise RuntimeError(f"formal replay benchmark acceptance failed: {checks}")
    assert_clean_head(head)
    report = {
        "schema_version": SCHEMA_VERSION,
        "recorded_at": utc_now(),
        "release_evidence": evidence,
        "profile": "formal-release",
        "passed": True,
        "checks": checks,
        "components": artifacts,
        "commands": commands,
    }
    write_json(output, report)
    assert_clean_head(head)
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
