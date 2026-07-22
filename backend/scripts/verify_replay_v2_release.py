"""Verify and bind all Phase 10 replay.v2 release gates to one clean HEAD."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Mapping

try:
    from scripts.replay_v2_release_common import (
        BACKEND_ROOT,
        REPOSITORY_ROOT,
        artifact,
        assert_clean_head,
        capture_clean_head,
        load_bound_json,
        require_external_head_path,
        run_git,
        utc_now,
        write_json,
    )
except ModuleNotFoundError:
    from replay_v2_release_common import (  # type: ignore[no-redef]
        BACKEND_ROOT,
        REPOSITORY_ROOT,
        artifact,
        assert_clean_head,
        capture_clean_head,
        load_bound_json,
        require_external_head_path,
        run_git,
        utc_now,
        write_json,
    )


SCHEMA_VERSION = "replay.v2.release-manifest.v1"
MATRIX_PATH = REPOSITORY_ROOT / "docs" / "replay-v2-release-acceptance.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence-dir", type=Path, required=True)
    parser.add_argument("--out", type=Path)
    return parser.parse_args()


def _validate_matrix() -> tuple[Mapping[str, object], list[dict[str, object]]]:
    matrix = json.loads(MATRIX_PATH.read_text(encoding="utf-8"))
    if not isinstance(matrix, Mapping):
        raise ValueError("release acceptance matrix must be an object")
    scenarios = matrix.get("scenarios")
    gates = matrix.get("release_gates")
    if matrix.get("schema_version") != "replay.v2.release-acceptance.v1":
        raise ValueError("release acceptance matrix schema drifted")
    if matrix.get("expected_scenarios") != 28 or not isinstance(scenarios, list):
        raise ValueError("release acceptance matrix must contain 28 scenarios")
    if [item.get("id") for item in scenarios if isinstance(item, Mapping)] != list(
        range(1, 29)
    ):
        raise ValueError("release acceptance scenario ids must be exactly 1..28")
    if not isinstance(gates, list) or set(gates) != {
        "full_suite",
        "browser",
        "benchmark",
        "soak",
        "rollback",
    }:
        raise ValueError("release acceptance gate registry drifted")
    validated: list[dict[str, object]] = []
    for scenario in scenarios:
        if not isinstance(scenario, Mapping):
            raise ValueError("release acceptance scenario must be an object")
        automated = scenario.get("automated")
        if not isinstance(automated, Mapping):
            raise ValueError(f"scenario {scenario.get('id')} has no automated evidence")
        relative = automated.get("path")
        needle = automated.get("needle")
        if not isinstance(relative, str) or not isinstance(needle, str) or not needle:
            raise ValueError(f"scenario {scenario.get('id')} has malformed evidence")
        source = (REPOSITORY_ROOT / relative).resolve()
        try:
            source.relative_to(REPOSITORY_ROOT.resolve())
        except ValueError as exc:
            raise ValueError(f"scenario {scenario.get('id')} escapes repository") from exc
        if not source.is_file() or needle not in source.read_text(encoding="utf-8"):
            raise ValueError(
                f"scenario {scenario.get('id')} evidence is missing: {relative} :: {needle}"
            )
        gate = scenario.get("release_gate")
        if gate not in gates:
            raise ValueError(f"scenario {scenario.get('id')} has unknown gate {gate}")
        validated.append(
            {
                "id": scenario["id"],
                "title": scenario.get("title"),
                "automated": automated,
                "release_gate": gate,
                "validated": True,
            }
        )
    return matrix, validated


def _validate_default_flags() -> dict[str, str]:
    if str(BACKEND_ROOT) not in sys.path:
        sys.path.insert(0, str(BACKEND_ROOT))
    from app.core.config import load_replay_settings

    with tempfile.TemporaryDirectory(prefix="replay-v2-default-flags-") as directory:
        root = Path(directory)
        settings = load_replay_settings(
            {}, data_dir=root, klines_db_path=root / "candlescope.db"
        )
    backend_source = (REPOSITORY_ROOT / "backend/app/core/config.py").read_text(
        encoding="utf-8"
    )
    entry_source = (
        REPOSITORY_ROOT
        / "frontend/src/features/replay/useReplayEntryCapability.ts"
    ).read_text(encoding="utf-8")
    product_source = (
        REPOSITORY_ROOT / "frontend/src/features/replay/replayV2Types.ts"
    ).read_text(encoding="utf-8")
    readme = (REPOSITORY_ROOT / "README.md").read_text(encoding="utf-8")
    flags = {
        "REPLAY_ENABLED": "0",
        "REPLAY_PRODUCT_V2_ENABLED": "0",
        "VITE_REPLAY_ENTRY_ENABLED": "0",
        "VITE_REPLAY_PRODUCT_V2_ENABLED": "0",
        "RAW_AGG_TRADE_ARCHIVE_ENABLED": "0",
        "REPLAY_HISTORICAL_BOOK_ENABLED": "0",
    }
    checks = {
        "backend_core_off": settings.enabled is False,
        "backend_product_off": settings.product_v2_enabled is False,
        "backend_book_off": settings.replay_historical_book_enabled is False,
        "backend_raw_agg_default_source": '"RAW_AGG_TRADE_ARCHIVE_ENABLED", "0"' in backend_source,
        "frontend_entry_strict_default_off": "return value === true || value === \"1\" || value === \"true\";" in entry_source,
        "frontend_product_strict_default_off": "return value === true || value === \"1\" || value === \"true\";" in product_source,
        "readme_freezes_all_defaults": all(f"{name}={value}" in readme for name, value in flags.items()),
    }
    if not all(checks.values()):
        raise RuntimeError(f"repository default-off contract failed: {checks}")
    return flags


def _resolve_phase_parent(head: str) -> str:
    return run_git("rev-parse", "--verify", f"{head}^").strip().lower()


def _run_revert_drill(head: str) -> dict[str, object]:
    parent = _resolve_phase_parent(head)
    with tempfile.TemporaryDirectory(prefix="replay-v2-revert-drill-") as directory:
        worktree = Path(directory) / "worktree"
        added = False
        try:
            run_git("worktree", "add", "--detach", str(worktree), head)
            added = True
            completed = subprocess.run(
                ["git", "revert", "--no-commit", head],
                cwd=worktree,
                check=False,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=300,
            )
            if completed.returncode != 0:
                raise RuntimeError(
                    f"git revert --no-commit failed: {completed.stderr or completed.stdout}"
                )
            worktree_matches_parent = subprocess.run(
                ["git", "diff", "--quiet", parent, "--"], cwd=worktree, check=False
            ).returncode == 0
            index_matches_parent = subprocess.run(
                ["git", "diff", "--cached", "--quiet", parent, "--"],
                cwd=worktree,
                check=False,
            ).returncode == 0
            untracked = run_git(
                "ls-files", "--others", "--exclude-standard", cwd=worktree
            ).splitlines()
            if not worktree_matches_parent or not index_matches_parent or untracked:
                raise RuntimeError(
                    "commit revert did not reproduce the exact Phase parent: "
                    f"worktree={worktree_matches_parent}, index={index_matches_parent}, "
                    f"untracked={untracked}"
                )
            return {
                "command": ["git", "revert", "--no-commit", head],
                "head": head,
                "parent": parent,
                "worktree_matches_parent": True,
                "index_matches_parent": True,
                "untracked_count": 0,
                "passed": True,
            }
        finally:
            if added:
                run_git("worktree", "remove", "--force", str(worktree))
                run_git("worktree", "prune")


def _acceptance_checks(payload: Mapping[str, object]) -> Mapping[str, object]:
    acceptance = payload.get("acceptance")
    if not isinstance(acceptance, Mapping) or acceptance.get("passed") is not True:
        raise ValueError("browser artifact acceptance did not pass")
    checks = acceptance.get("checks")
    if not isinstance(checks, Mapping) or not checks or not all(
        value is True for value in checks.values()
    ):
        raise ValueError("browser artifact did not pass every acceptance check")
    return checks


def main() -> int:
    args = parse_args()
    evidence = capture_clean_head()
    head = str(evidence["git_head"])
    evidence_directory = require_external_head_path(args.evidence_dir, head)
    output = require_external_head_path(
        args.out or (evidence_directory / "release-manifest.json"), head
    )
    expected = {
        "checks": ("checks.json", "replay.v2.release-checks.v1"),
        "benchmark": ("benchmark.json", "replay.v2.release-benchmark.v1"),
        "v1_smoke": ("replay-v1-smoke.json", "replay-v1-browser-smoke.v1"),
        "v2_smoke": ("replay-v2-smoke.json", "replay-v2-browser-soak.v1"),
        "v2_soak": ("replay-v2-soak.json", "replay-v2-browser-soak.v1"),
        "rollback": ("replay-v2-rollback.json", "replay-v2-rollback-drill.v1"),
    }
    payloads: dict[str, Mapping[str, object]] = {}
    artifacts: dict[str, dict[str, object]] = {}
    for name, (filename, schema) in expected.items():
        payload, bound_artifact = load_bound_json(
            evidence_directory / filename,
            expected_head=head,
            expected_schema=schema,
        )
        payloads[name] = payload
        artifacts[name] = bound_artifact

    checks = payloads["checks"]
    benchmark = payloads["benchmark"]
    v2_smoke = payloads["v2_smoke"]
    v2_soak = payloads["v2_soak"]
    rollback = payloads["rollback"]
    smoke_config = v2_smoke.get("config")
    soak_config = v2_soak.get("config")
    soak_lifecycle = v2_soak.get("archiveLifecycle")
    rollback_config = rollback.get("configuration")
    gate_checks = {
        "backend_and_frontend_full": isinstance(checks.get("counts"), Mapping)
        and checks["counts"].get("backend_pytest_passed", 0) > 0
        and checks["counts"].get("frontend_node_tests_passed", 0) > 0,
        "formal_benchmark": benchmark.get("profile") == "formal-release",
        "v2_smoke_harness": v2_smoke.get("mode") == "harness-validation"
        and isinstance(smoke_config, Mapping)
        and smoke_config.get("product") == "replay.v2",
        "v2_soak_4h": v2_soak.get("mode") == "release-4h"
        and isinstance(soak_config, Mapping)
        and soak_config.get("product") == "replay.v2"
        and soak_config.get("durationMs", 0) >= 14_400_000
        and soak_config.get("cycles", 0) >= 100
        and soak_config.get("projectionEvents", 0) >= 1_000_000,
        "v2_100_archive_lifecycles": isinstance(soak_lifecycle, Mapping)
        and soak_lifecycle.get("completed", 0) >= 100,
        "v2_rollback": isinstance(rollback_config, Mapping)
        and rollback_config.get("product") == "replay.v2",
    }
    _acceptance_checks(v2_smoke)
    soak_acceptance = _acceptance_checks(v2_soak)
    gate_checks["keyboard_and_reduced_motion"] = (
        soak_acceptance.get("v2_keyboard_accessible") is True
        and soak_acceptance.get("v2_reduced_motion_effective") is True
    )
    if not all(gate_checks.values()):
        raise RuntimeError(f"Phase 10 release gate failed: {gate_checks}")

    matrix, scenarios = _validate_matrix()
    default_flags = _validate_default_flags()
    revert = _run_revert_drill(head)
    assert_clean_head(head)
    report = {
        "schema_version": SCHEMA_VERSION,
        "recorded_at": utc_now(),
        "release_evidence": evidence,
        "passed": True,
        "product_contract": {
            "scenario_count": len(scenarios),
            "matrix": artifact(MATRIX_PATH),
            "matrix_schema": matrix["schema_version"],
            "scenarios": scenarios,
        },
        "gate_checks": gate_checks,
        "artifacts": artifacts,
        "commit_revert_drill": revert,
        "repository_defaults": default_flags,
        "production_enablement": "NOT_AUTHORIZED_DEFAULTS_REMAIN_OFF",
        "production_observation": "REQUIRED_BEFORE_ANY_ENABLEMENT_DECISION",
    }
    write_json(output, report)
    assert_clean_head(head)
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
