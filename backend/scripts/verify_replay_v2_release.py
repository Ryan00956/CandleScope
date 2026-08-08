"""Verify and bind all Phase 18 replay.v2 release gates to one clean HEAD."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Mapping

try:
    from scripts.verify_replay_hedge_acceptance import (
        MATRIX_PATH as HEDGE_MATRIX_PATH,
        validate_matrix as validate_hedge_matrix,
    )
except ModuleNotFoundError:
    from verify_replay_hedge_acceptance import (  # type: ignore[no-redef]
        MATRIX_PATH as HEDGE_MATRIX_PATH,
        validate_matrix as validate_hedge_matrix,
    )

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


SCHEMA_VERSION = "replay.v2.release-manifest.v4"
WALL_CLOCK_POLICY = "MEASURE_ONLY_NON_BLOCKING"
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
    if matrix.get("schema_version") != "replay.v2.release-acceptance.v2":
        raise ValueError("release acceptance matrix schema drifted")
    if matrix.get("expected_scenarios") != 40 or not isinstance(scenarios, list):
        raise ValueError("release acceptance matrix must contain 40 scenarios")
    if [item.get("id") for item in scenarios if isinstance(item, Mapping)] != list(
        range(1, 41)
    ):
        raise ValueError("release acceptance scenario ids must be exactly 1..40")
    if not isinstance(gates, list) or set(gates) != {
        "full_suite",
        "browser",
        "benchmark",
        "soak",
        "rollback",
        "storage",
        "real_source",
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
            raise ValueError(
                f"scenario {scenario.get('id')} escapes repository"
            ) from exc
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
        REPOSITORY_ROOT / "frontend/src/features/replay/useReplayEntryCapability.ts"
    ).read_text(encoding="utf-8")
    readme = (REPOSITORY_ROOT / "README.md").read_text(encoding="utf-8")
    flags = {
        "REPLAY_ENABLED": "1",
        "RAW_AGG_TRADE_ARCHIVE_ENABLED": "0",
        "REPLAY_HISTORICAL_BOOK_ENABLED": "1",
        "REPLAY_SEGMENT_DOWNLOAD_WORKER_ENABLED": "0",
        "REPLAY_SEGMENT_AUTO_GC_ENABLED": "0",
        "REPLAY_FAST_FORWARD_OPTIMIZATION_ENABLED": "0",
        "REPLAY_ACCOUNT_HISTORY_ENABLED": "1",
    }
    checks = {
        "backend_core_on": settings.enabled is True,
        "backend_book_on": settings.replay_historical_book_enabled is True,
        "backend_segment_worker_off": (
            settings.replay_segment_download_worker_enabled is False
        ),
        "backend_segment_gc_off": settings.replay_segment_auto_gc_enabled is False,
        "backend_fast_forward_off": (
            settings.replay_fast_forward_optimization_enabled is False
        ),
        "backend_account_history_on": (settings.replay_account_history_enabled is True),
        "backend_raw_agg_default_source": '"RAW_AGG_TRADE_ARCHIVE_ENABLED", "0"'
        in backend_source,
        "frontend_entry_has_no_vite_gate": "VITE_REPLAY_ENTRY_ENABLED"
        not in entry_source,
        "readme_freezes_all_defaults": all(
            f"{name}={value}" in readme for name, value in flags.items()
        ),
    }
    if not all(checks.values()):
        raise RuntimeError(f"repository replay-default contract failed: {checks}")
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
            worktree_matches_parent = (
                subprocess.run(
                    ["git", "diff", "--quiet", parent, "--"], cwd=worktree, check=False
                ).returncode
                == 0
            )
            index_matches_parent = (
                subprocess.run(
                    ["git", "diff", "--cached", "--quiet", parent, "--"],
                    cwd=worktree,
                    check=False,
                ).returncode
                == 0
            )
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
    if (
        not isinstance(checks, Mapping)
        or not checks
        or not all(value is True for value in checks.values())
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
        "benchmark": ("benchmark.json", "replay.v2.release-benchmark.v3"),
        "real_source": (
            "real-source-validation.json",
            "replay.v2.real-source-validation.v1",
        ),
        "v2_smoke": ("replay-v2-smoke.json", "replay-v2-browser-soak.v1"),
        "v2_soak": ("replay-v2-soak.json", "replay-v2-browser-soak.v1"),
        "rollback": ("replay-v2-rollback.json", "replay-v2-rollback-drill.v2"),
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
    real_source = payloads["real_source"]
    v2_smoke = payloads["v2_smoke"]
    v2_soak = payloads["v2_soak"]
    rollback = payloads["rollback"]
    smoke_config = v2_smoke.get("config")
    soak_config = v2_soak.get("config")
    soak_training_source = (
        soak_config.get("trainingSource") if isinstance(soak_config, Mapping) else None
    )
    soak_lifecycle = v2_soak.get("archiveLifecycle")
    rollback_config = rollback.get("configuration")
    benchmark_checks = benchmark.get("checks")
    real_source_checks = real_source.get("checks")
    real_source_support = real_source.get("production_support_effect")
    rollback_acceptance = rollback.get("acceptance")
    rollback_checks = (
        rollback_acceptance.get("checks")
        if isinstance(rollback_acceptance, Mapping)
        else None
    )
    gate_checks = {
        "backend_and_frontend_full": isinstance(checks.get("counts"), Mapping)
        and checks["counts"].get("backend_pytest_passed", 0) > 0
        and checks["counts"].get("frontend_node_tests_passed", 0) > 0,
        "formal_benchmark": benchmark.get("profile") == "formal-release",
        "benchmark_wall_clock_measure_only": (
            benchmark.get("wall_clock_policy") == WALL_CLOCK_POLICY
            and isinstance(benchmark_checks, Mapping)
            and benchmark_checks.get("wall_clock_measure_only_policy") is True
        ),
        "hedge_exchange_parity_benchmark": isinstance(benchmark_checks, Mapping)
        and benchmark_checks.get("hedge_exchange_parity_1_2_4_8") is True
        and benchmark_checks.get("hedge_exchange_parity_acceptance") is True,
        "storage_capacity_and_redaction": isinstance(benchmark_checks, Mapping)
        and benchmark_checks.get("storage_inventory_10000_bounded") is True
        and benchmark_checks.get("account_history_acceptance") is True,
        "real_bar_and_official_agg_sources": isinstance(
            real_source_checks,
            Mapping,
        )
        and all(value is True for value in real_source_checks.values())
        and isinstance(real_source_support, Mapping)
        and real_source_support.get("BAR") == "REAL_SOURCE_VALIDATED"
        and real_source_support.get("AGG_TRADE")
        == "OFFICIAL_CHECKSUM_SOURCE_VALIDATED",
        "v2_smoke_harness": v2_smoke.get("mode") == "harness-validation"
        and isinstance(smoke_config, Mapping)
        and smoke_config.get("product") == "replay.v2",
        "v2_soak_4h": v2_soak.get("mode") == "release-4h"
        and isinstance(soak_config, Mapping)
        and soak_config.get("product") == "replay.v2"
        and soak_config.get("durationMs", 0) >= 14_400_000
        and soak_config.get("cycles", 0) >= 100
        and soak_config.get("projectionEvents", 0) >= 1_000_000,
        "v2_soak_real_bar_evidence": isinstance(soak_config, Mapping)
        and soak_config.get("realSource") is True
        and soak_config.get("realSourceIdentityCount", 0) >= 2
        and isinstance(soak_training_source, Mapping)
        and soak_training_source.get("payloadBound") is True,
        "v2_soak_hedge_exact_source": isinstance(soak_config, Mapping)
        and soak_config.get("sourceProfile") == "HEDGE_EXACT_ARCHIVE_QA"
        and isinstance(soak_training_source, Mapping)
        and soak_training_source.get("payloadBound") is True
        and soak_training_source.get("exchange") == "binance"
        and soak_training_source.get("marketType") == "futures"
        and soak_training_source.get("interval") == "1m"
        and soak_training_source.get("forwardCacheMs") == 2_592_000_000
        and soak_training_source.get("requiredRows") == 43_400
        and soak_training_source.get("inputFidelity")
        == "PINNED_PUBLIC_EXACT_PRIVATE_DETERMINISTIC_SIMULATION"
        and soak_training_source.get("fallbackApplied") is False,
        "v2_100_archive_lifecycles": isinstance(soak_lifecycle, Mapping)
        and soak_lifecycle.get("completed", 0) >= 100,
        "v2_rollback": isinstance(rollback_config, Mapping)
        and rollback_config.get("product") == "replay.v2",
        "v2_rollback_storage_preserved": isinstance(rollback_checks, Mapping)
        and rollback_checks.get("phase18_storage_schema_present") is True
        and rollback_checks.get("disabled_restart_preserved_storage_semantics") is True
        and rollback_checks.get("old_build_preserved_storage_semantics") is True,
    }
    _acceptance_checks(v2_smoke)
    soak_acceptance = _acceptance_checks(v2_soak)
    gate_checks["keyboard_and_reduced_motion"] = (
        soak_acceptance.get("v2_keyboard_accessible") is True
        and soak_acceptance.get("v2_reduced_motion_effective") is True
    )
    gate_checks["hedge_browser_account_continuity"] = (
        soak_acceptance.get("hedge_account_continuity") is True
        and soak_acceptance.get("hedge_both_legs_active") is True
        and soak_acceptance.get("hedge_exact_training_bound") is True
    )
    if not all(gate_checks.values()):
        raise RuntimeError(f"Phase 18 release gate failed: {gate_checks}")

    matrix, scenarios = _validate_matrix()
    hedge_matrix = validate_hedge_matrix()
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
            "hedge_exchange_parity": {
                "scenario_count": hedge_matrix["scenario_count"],
                "matrix": artifact(HEDGE_MATRIX_PATH),
                "matrix_schema": hedge_matrix["schema_version"],
                "scenarios": hedge_matrix["scenarios"],
            },
        },
        "gate_checks": gate_checks,
        "artifacts": artifacts,
        "commit_revert_drill": revert,
        "repository_defaults": default_flags,
        "implementation_decision": "PASS",
        "production_enablement": "HARD_CUTOVER_DEFAULT_ON",
        "production_observation": (
            "PINNED_DATA_GAPS_FAIL_CLOSED_WITHOUT_DISABLING_THE_PRODUCT"
        ),
        "support_decision": real_source_support,
    }
    write_json(output, report)
    assert_clean_head(head)
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
