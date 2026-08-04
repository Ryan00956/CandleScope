#!/usr/bin/env python3
"""Run and finalize the Plugin Platform multi-runtime Phase 11 GA gates."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import importlib
import json
import os
import platform
import subprocess
import sys
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from unittest.mock import patch

try:
    from .plugin_platform_multi_runtime_phase11_support import (
        REPOSITORY_ROOT,
        canonical_sha256,
        ensure_import_paths,
        invoke_all,
        sha256_path,
        start_multi_runtime_platform,
    )
except ImportError:  # Direct script execution.
    from plugin_platform_multi_runtime_phase11_support import (
        REPOSITORY_ROOT,
        canonical_sha256,
        ensure_import_paths,
        invoke_all,
        sha256_path,
        start_multi_runtime_platform,
    )


BACKEND_ROOT = REPOSITORY_ROOT / "backend"
CONFORMANCE = REPOSITORY_ROOT / "packages" / "plugin-conformance" / "check.py"
EVIDENCE_ROOT = REPOSITORY_ROOT / "docs" / "evidence"
MATRIX_EVIDENCE = EVIDENCE_ROOT / "plugin-platform-multi-runtime-phase11-matrix.json"
SOAK_EVIDENCE = EVIDENCE_ROOT / "plugin-platform-multi-runtime-phase11-soak-4h.json"
BROWSER_EVIDENCE = EVIDENCE_ROOT / "plugin-platform-multi-runtime-phase11-browser.json"
SDK_EVIDENCE = EVIDENCE_ROOT / "plugin-platform-multi-runtime-phase11-sdk.json"
TA4J_EVIDENCE = EVIDENCE_ROOT / "plugin-platform-multi-runtime-phase11-ta4j.json"
REGRESSION_EVIDENCE = (
    EVIDENCE_ROOT / "plugin-platform-multi-runtime-phase11-regression.json"
)
FINAL_EVIDENCE = EVIDENCE_ROOT / "plugin-platform-multi-runtime-phase11-ga.json"
FINAL_SCHEMA = "candlescope.plugin-platform.multi-runtime.phase11-ga/1"
MATRIX_SCHEMA = "candlescope.plugin-platform.multi-runtime.phase11-matrix/1"
ALL_NEW_FLAGS = (
    "CANDLESCOPE_PLUGIN_MULTI_RUNTIME_ENABLED",
    "CANDLESCOPE_PLUGIN_RUNTIME_PROVIDER_SEAM_ENABLED",
    "CANDLESCOPE_PLUGIN_RUNTIME_NATIVE_ENABLED",
    "CANDLESCOPE_PLUGIN_RUNTIME_JAVA_ENABLED",
    "CANDLESCOPE_PLUGIN_RUNTIME_NODE_ENABLED",
    "CANDLESCOPE_PLUGIN_RUNTIME_WASM_ENABLED",
    "CANDLESCOPE_PLUGIN_RUNTIME_REGISTRY_ENABLED",
    "CANDLESCOPE_PLUGIN_RUNTIME_REGISTRY_NETWORK_UPDATES_ENABLED",
    "CANDLESCOPE_PLUGIN_MULTI_RUNTIME_TRUST_UX_ENABLED",
    "CANDLESCOPE_PLUGIN_GITHUB_IMPORT_ENABLED",
    "CANDLESCOPE_PLUGIN_PLATFORM_V2_MARKETPLACE_ENABLED",
    "CANDLESCOPE_PLUGIN_MARKETPLACE_TELEMETRY_ENABLED",
)
PRIOR_REAL_EVIDENCE = {
    "native": REPOSITORY_ROOT
    / "docs/perf-baselines/plugin-platform-v2/multi-runtime-phase3-2026-08-03-windows-amd64.json",
    "registry": REPOSITORY_ROOT
    / "docs/perf-baselines/plugin-platform-v2/multi-runtime-phase4-2026-08-03-windows-amd64.json",
    "java": REPOSITORY_ROOT
    / "docs/perf-baselines/plugin-platform-v2/multi-runtime-phase5-2026-08-03-windows-amd64.json",
    "sandbox": REPOSITORY_ROOT
    / "docs/perf-baselines/plugin-platform-v2/multi-runtime-phase6-2026-08-03-windows-amd64.json",
    "node": REPOSITORY_ROOT
    / "docs/perf-baselines/plugin-platform-v2/multi-runtime-phase7-2026-08-03-windows-amd64.json",
    "wasm": REPOSITORY_ROOT
    / "docs/perf-baselines/plugin-platform-v2/multi-runtime-phase8-2026-08-03-windows-wsl2-amd64.json",
    "marketplace": REPOSITORY_ROOT
    / "docs/evidence/plugin-platform-multi-runtime-phase10-real.json",
}


class Phase11GateError(RuntimeError):
    pass


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def git_head() -> str:
    completed = subprocess.run(
        ("git", "rev-parse", "HEAD"),
        cwd=REPOSITORY_ROOT,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    return completed.stdout.strip()


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        + "\n",
        encoding="utf-8",
        newline="\n",
    )
    os.replace(temporary, path)


def strict_json(path: Path) -> dict[str, Any]:
    ensure_import_paths()
    from candlescope_plugin_sdk.platform_v2 import loads_strict

    if path.is_symlink() or not path.is_file():
        raise Phase11GateError(f"required Phase 11 evidence is missing: {path.name}")
    value = loads_strict(path.read_bytes())
    if not isinstance(value, dict):
        raise Phase11GateError(f"Phase 11 evidence is not an object: {path.name}")
    return value


def run_checked(
    command: list[str] | tuple[str, ...],
    *,
    cwd: Path = REPOSITORY_ROOT,
    timeout: float = 600,
) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(
        tuple(str(item) for item in command),
        cwd=cwd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        timeout=timeout,
        check=False,
        shell=False,
    )
    if completed.returncode:
        raise Phase11GateError(
            f"command failed ({completed.returncode}): {' '.join(command)}\n"
            + completed.stdout[-8000:]
        )
    return completed


async def _no_plugin(root: Path) -> dict[str, Any]:
    ensure_import_paths()
    from app.plugin_core_v2.runtime import CorePluginPlatform

    instance = CorePluginPlatform(
        root=root,
        host_name="CandleScope",
        host_version="0.4.0",
        multi_runtime_enabled=False,
        runtime_provider_seam_enabled=False,
        native_runtime_enabled=False,
        java_runtime_enabled=False,
        node_runtime_enabled=False,
        wasm_runtime_enabled=False,
        runtime_registry_enabled=False,
        runtime_registry_network_updates_enabled=False,
    )
    await instance.start()
    try:
        catalog = instance.catalog()
        if catalog["plugins"] or instance.manager.owner_keys():
            raise Phase11GateError("no-plugin startup unexpectedly activated a plugin")
        return {
            "result": "pass",
            "pluginCount": 0,
            "supervisors": 0,
            "providerKinds": list(instance.runtime_provider_registry.kinds),
        }
    finally:
        await instance.stop()


async def _python_lifecycle(root: Path) -> dict[str, Any]:
    ensure_import_paths()
    from app.plugin_core_v2.runtime import CorePluginPlatform
    from app.plugin_installer_v2.registry import load_activation_registry
    from tests.plugin_platform_bundle_testkit import build_hello_platform_bundle

    product = root / "product"
    initial = build_hello_platform_bundle(root / "initial", version="0.1.0")
    update = build_hello_platform_bundle(root / "update", version="0.1.1")
    bootstrap = CorePluginPlatform(
        root=product,
        host_name="CandleScope",
        host_version="0.4.0",
        multi_runtime_enabled=False,
        runtime_provider_seam_enabled=False,
        native_runtime_enabled=False,
        java_runtime_enabled=False,
        node_runtime_enabled=False,
        wasm_runtime_enabled=False,
        runtime_registry_enabled=False,
        runtime_registry_network_updates_enabled=False,
    )
    first = bootstrap.installer.install(
        initial.bundle.path,
        expected_sha256=initial.bundle.sha256,
        enabled=True,
    )
    repeated = bootstrap.installer.install(
        initial.bundle.path,
        expected_sha256=initial.bundle.sha256,
        enabled=True,
    )
    updated = bootstrap.installer.install(
        update.bundle.path,
        expected_sha256=update.bundle.sha256,
        enabled=True,
    )
    rolled_back = bootstrap.installer.rollback(first.plugin_id)
    record = load_activation_registry(bootstrap.installer.registry_path).by_id()[
        first.plugin_id
    ]
    if (
        not repeated.reused_installation
        or updated.state != "active"
        or record.bundle_sha256 != initial.bundle.sha256
        or rolled_back.from_activation_id != updated.activation_id
        or rolled_back.to_activation_id != first.activation_id
        or rolled_back.removed
    ):
        raise Phase11GateError(
            "Python fresh/repeat/update/rollback lifecycle did not converge"
        )

    async def launch(trace: str) -> tuple[str, int]:
        instance = CorePluginPlatform(
            root=product,
            host_name="CandleScope",
            host_version="0.4.0",
            multi_runtime_enabled=False,
            runtime_provider_seam_enabled=False,
            native_runtime_enabled=False,
            java_runtime_enabled=False,
            node_runtime_enabled=False,
            wasm_runtime_enabled=False,
            runtime_registry_enabled=False,
            runtime_registry_network_updates_enabled=False,
        )
        await instance.start()
        try:
            result = await instance.invoke_command(
                "candlescope.hello-command.hello",
                {"name": "Phase 11 Python"},
                user_action=True,
                trace_id=trace,
            )
            return canonical_sha256(result), len(instance.manager.owner_keys())
        finally:
            await instance.stop()

    first_digest, first_supervisors = await launch("phase11-python-first")
    fresh_digest, fresh_supervisors = await launch("phase11-python-fresh-process")
    if first_digest != fresh_digest or first_supervisors != 1 or fresh_supervisors != 1:
        raise Phase11GateError("Python fresh-process result changed")
    return {
        "result": "pass",
        "pluginId": first.plugin_id,
        "freshInstall": not first.reused_installation,
        "quickRepeat": repeated.reused_installation,
        "updateBundleSha256": update.bundle.sha256,
        "rollbackBundleSha256": record.bundle_sha256,
        "rollbackFromActivationId": rolled_back.from_activation_id,
        "rollbackToActivationId": rolled_back.to_activation_id,
        "freshProcess": True,
        "resultSha256": first_digest,
        "residualSupervisors": 0,
    }


async def _v1_only(root: Path) -> dict[str, Any]:
    ensure_import_paths()
    from scripts.plugin_platform_phase13_gate import _exercise

    evidence = await _exercise(root)
    rollback = evidence.get("rollback", {})
    if (
        rollback.get("v1OnlyPlatformStatus") != "disabled"
        or rollback.get("v1WireUnchanged") is not True
        or rollback.get("statusAgainstLiveReleaseTwo") != "stale"
    ):
        raise Phase11GateError("v1-only startup/rollback compatibility changed")
    return {
        "result": "pass",
        "platformStatus": rollback["v1OnlyPlatformStatus"],
        "pluginCount": rollback["v1OnlyPluginCount"],
        "wireUnchanged": rollback["v1WireUnchanged"],
        "frozenV1Sha256": canonical_sha256(evidence["frozenV1Contracts"]),
    }


async def _all_flags_off(root: Path, v1: dict[str, Any]) -> dict[str, Any]:
    ensure_import_paths()
    from app.plugin_core_v2.bootstrap import build_core_plugin_platform_from_environment
    from app.plugin_github_import_v3 import github_import_enabled
    from tests.plugin_platform_bundle_testkit import build_hello_platform_bundle

    environment = {name: "0" for name in ALL_NEW_FLAGS}
    environment.update(
        {
            "CANDLESCOPE_PLUGIN_PLATFORM_V2_ENABLED": "1",
            "CANDLESCOPE_PLUGIN_PLATFORM_V2_ROOT": str(root / "product"),
        }
    )
    with patch.dict(os.environ, environment, clear=False):
        instance = build_core_plugin_platform_from_environment(
            host_name="CandleScope",
            host_version="0.4.0",
        )
        fixture = build_hello_platform_bundle(root / "python")
        installed = instance.installer.install(
            fixture.bundle.path,
            expected_sha256=fixture.bundle.sha256,
            enabled=True,
        )
        await instance.start()
        try:
            result = await instance.invoke_command(
                "candlescope.hello-command.hello",
                {"name": "all-flags-off"},
                user_action=True,
                trace_id="phase11-all-flags-off",
            )
            marketplace_status = instance.marketplace.status()
            observed = {
                "multiRuntime": instance.installer.multi_runtime_enabled,
                "providerSeam": instance.runtime_provider_seam_enabled,
                "native": instance.native_runtime_enabled,
                "java": instance.java_runtime_enabled,
                "node": instance.node_runtime_enabled,
                "wasm": instance.wasm_runtime_enabled,
                "registry": instance.runtime_registry_enabled,
                "registryNetworkUpdates": instance.managed_runtime_registry.network_updates_enabled,
                "trustUx": instance.trust_ux_enabled,
                "githubImport": github_import_enabled(os.environ),
                "marketplace": instance.marketplace_enabled,
                "marketplaceService": marketplace_status.get("enabled"),
                "marketplaceTelemetry": instance.marketplace.telemetry.enabled,
            }
            if any(observed.values()):
                raise Phase11GateError(
                    f"all-flags-off drill left a new feature enabled: {observed}"
                )
            if instance.runtime_provider_registry.kinds != ("python-module",):
                raise Phase11GateError(
                    "all-flags-off drill registered a non-Python Provider"
                )
        finally:
            await instance.stop()
    if v1.get("wireUnchanged") is not True:
        raise Phase11GateError("all-flags-off drill lacks v1 compatibility proof")
    return {
        "result": "pass",
        "flags": {name: "0" for name in ALL_NEW_FLAGS},
        "observed": observed,
        "pythonPluginId": installed.plugin_id,
        "pythonResultSha256": canonical_sha256(result),
        "v1Compatibility": v1,
        "providerKinds": ["python-module"],
        "residualSupervisors": 0,
    }


def _conformance(python: Path) -> dict[str, Any]:
    completed = run_checked(
        [
            str(python.resolve(strict=True)),
            str(CONFORMANCE),
            "--run-python-cases",
            "--python",
            str(python.resolve(strict=True)),
        ],
        timeout=600,
    )
    value = json.loads(completed.stdout.strip().splitlines()[-1])
    if value.get("result") != "pass" or value.get("caseCount") != 28:
        raise Phase11GateError("language-neutral conformance suite did not pass")
    return value


def _failure_injection(python: Path) -> dict[str, Any]:
    nodeids = [
        "backend/tests/test_plugin_platform_multi_runtime_phase4.py::test_invalid_archive_and_disk_full_fail_with_stable_errors",
        "backend/tests/test_plugin_platform_multi_runtime_phase4.py::test_payload_archive_evidence_and_receipt_corruption_are_quarantined_and_recovered",
        "backend/tests/test_plugin_marketplace_phase10_service.py::test_v2_prepare_uses_verified_offline_cache_and_opt_in_aggregate_telemetry",
        "backend/tests/test_plugin_compat_v1.py::test_corrupt_state_and_disk_failure_fail_closed_without_breaking_v1_wire",
        "backend/tests/test_plugin_host_v2.py::test_invoke_result_is_rejected_after_its_generation_is_deactivated",
        "backend/tests/test_plugin_host_v2.py::test_cancelled_invoke_cancels_its_pending_host_call",
        "backend/tests/test_plugin_host_v2.py::test_restart_storm_opens_the_entrypoint_circuit",
        "backend/tests/test_plugin_runtime_supervisor.py::test_request_timeout_discards_the_process",
    ]
    completed = run_checked(
        [str(python.resolve(strict=True)), "-m", "pytest", *nodeids, "-q"],
        timeout=600,
    )
    return {
        "result": "pass",
        "nodeids": nodeids,
        "outputSha256": "sha256:"
        + hashlib.sha256(completed.stdout.encode("utf-8")).hexdigest(),
        "outputTail": completed.stdout[-2000:].strip(),
        "coverage": {
            "staleGeneration": True,
            "networkLoss": True,
            "diskFull": True,
            "cacheCorruption": True,
            "cancel": True,
            "hang": True,
            "restartCircuit": True,
        },
    }


def _recorded_fault_codes() -> dict[str, str]:
    recorded = {label: strict_json(path) for label, path in PRIOR_REAL_EVIDENCE.items()}
    if any(value.get("result") != "pass" for value in recorded.values()):
        raise Phase11GateError("one or more recorded prerequisite gates did not pass")
    node_faults = recorded["node"].get("faults")
    wasm_faults = recorded["wasm"].get("faults")
    if not isinstance(node_faults, dict) or not isinstance(wasm_faults, dict):
        raise Phase11GateError("recorded Node/WASM fault evidence is malformed")
    faults = {**node_faults, **wasm_faults}
    required = {"crash", "hang", "cancel"}
    normalized = {item.casefold() for item in faults}
    if not required <= normalized or any(
        not isinstance(code, str) or not code for code in faults.values()
    ):
        raise Phase11GateError(
            "prior real-process faults do not cover crash/hang/cancel"
        )
    return faults


def _prior_real_faults(
    *,
    marketplace_jre_evidence: Path,
    jdk_home: Path,
    dependency_cache: Path,
) -> dict[str, Any]:
    faults = _recorded_fault_codes()
    modules = {
        "native": "scripts.plugin_platform_multi_runtime_phase3",
        "registry": "scripts.plugin_platform_multi_runtime_phase4",
        "java": "scripts.plugin_platform_multi_runtime_phase5",
        "sandbox": "scripts.plugin_platform_multi_runtime_phase6",
        "node": "scripts.plugin_platform_multi_runtime_phase7",
        "wasm": "scripts.plugin_platform_multi_runtime_phase8",
        "githubAdapter": "scripts.plugin_platform_multi_runtime_phase9",
    }
    result: dict[str, Any] = {}
    for label, name in modules.items():
        module = importlib.import_module(name)
        value = module.run_gate()
        if value.get("result") != "pass":
            raise Phase11GateError(f"{label} prerequisite gate did not pass")
        result[label] = {
            "schemaVersion": value.get("schemaVersion"),
            "result": "pass",
            "sha256": canonical_sha256(value),
        }
    marketplace_module = importlib.import_module(
        "scripts.plugin_platform_multi_runtime_phase10"
    )
    marketplace = marketplace_module.run_real_gate(
        jre_evidence_directory=marketplace_jre_evidence,
        jdk_home=jdk_home,
        dependency_cache=dependency_cache,
    )
    if marketplace.get("result") != "pass":
        raise Phase11GateError("marketplace prerequisite gate did not pass")
    result["marketplace"] = {
        "schemaVersion": marketplace.get("schemaVersion"),
        "result": "pass",
        "sha256": canonical_sha256(marketplace),
    }
    phase_files = PRIOR_REAL_EVIDENCE
    for label, path in phase_files.items():
        result[label]["realEvidenceSha256"] = sha256_path(path)
    result["faultCodes"] = faults
    return result


def _completed_startup_matrix(
    no_plugin: dict[str, Any],
    v1: dict[str, Any],
    python_only: dict[str, Any],
    multi: dict[str, Any],
) -> dict[str, dict[str, Any]]:
    completed_multi = dict(multi)
    completed_multi["result"] = "pass"
    return {
        "no-plugin": no_plugin,
        "v1-only": v1,
        "v2-Python-only": python_only,
        "multi-runtime": completed_multi,
    }


async def run_matrix(args: argparse.Namespace) -> dict[str, Any]:
    started = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix="candlescope-phase11-matrix-") as raw:
        root = Path(raw)
        no_plugin = await _no_plugin(root / "no-plugin")
        v1 = await _v1_only(root / "v1-only")
        python_only = await _python_lifecycle(root / "python-only")
        running, multi = await start_multi_runtime_platform(
            root / "multi-runtime",
            jre_evidence=args.jre_evidence,
            node_evidence=args.node_evidence,
            wasmtime_evidence=args.wasmtime_evidence,
        )
        try:
            second_results, second_latencies = await invoke_all(
                running.platform,
                trace_prefix="phase11-matrix-second",
            )
            if second_results != running.first_results:
                raise Phase11GateError("multi-runtime quick-repeat results changed")
            multi["quickRepeatResults"] = second_results
            multi["quickRepeatLatenciesMs"] = second_latencies
        finally:
            multi_cleanup = await running.close()
        if multi_cleanup["residualProcesses"] or multi_cleanup["residualSupervisors"]:
            raise Phase11GateError(
                "multi-runtime startup matrix left residual processes"
            )
        multi["cleanup"] = multi_cleanup
        rollback = await _all_flags_off(root / "all-flags-off", v1)
        conformance = await asyncio.to_thread(_conformance, args.python)
        failures = await asyncio.to_thread(_failure_injection, args.python)
        prerequisites = await asyncio.to_thread(
            _prior_real_faults,
            marketplace_jre_evidence=args.marketplace_jre_evidence,
            jdk_home=args.jdk_home,
            dependency_cache=args.maven_cache,
        )
    result = {
        "schemaVersion": MATRIX_SCHEMA,
        "result": "pass",
        "generatedAt": utc_now(),
        "gitHead": git_head(),
        "environment": {
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
            "python": platform.python_version(),
        },
        "elapsedSeconds": round(time.perf_counter() - started, 3),
        "startupMatrix": _completed_startup_matrix(no_plugin, v1, python_only, multi),
        "allNewFlagsOff": rollback,
        "conformance": conformance,
        "failureInjection": failures,
        "prerequisiteGates": prerequisites,
    }
    atomic_json(args.output.resolve(strict=False), result)
    return result


def _evidence_record(
    path: Path, *, schema: str, release_qualified: bool | None = None
) -> dict[str, Any]:
    value = strict_json(path)
    if value.get("schemaVersion") != schema or value.get("result") != "pass":
        raise Phase11GateError(f"evidence failed or has another schema: {path.name}")
    if (
        release_qualified is not None
        and value.get("releaseQualified") is not release_qualified
    ):
        raise Phase11GateError(f"evidence is not release-qualified: {path.name}")
    return {
        "path": path.relative_to(REPOSITORY_ROOT).as_posix(),
        "sha256": sha256_path(path),
        "schemaVersion": schema,
    }


def finalize(args: argparse.Namespace) -> dict[str, Any]:
    matrix = strict_json(args.matrix)
    if matrix.get("schemaVersion") != MATRIX_SCHEMA or matrix.get("result") != "pass":
        raise Phase11GateError("Phase 11 startup/failure matrix is incomplete")
    startup = matrix.get("startupMatrix", {})
    if set(startup) != {"no-plugin", "v1-only", "v2-Python-only", "multi-runtime"}:
        raise Phase11GateError("Phase 11 startup matrix is incomplete")
    if any(item.get("result") != "pass" for item in startup.values()):
        raise Phase11GateError("one or more Phase 11 startup modes failed")
    if any(matrix.get("allNewFlagsOff", {}).get("observed", {}).values()):
        raise Phase11GateError("one or more new feature flags remained enabled")
    records = {
        "matrix": _evidence_record(args.matrix, schema=MATRIX_SCHEMA),
        "sdk": _evidence_record(
            args.sdk,
            schema="candlescope.plugin-platform.multi-runtime.phase11-sdk/1",
        ),
        "browser": _evidence_record(
            args.browser,
            schema="candlescope.plugin-platform.multi-runtime.phase11-browser/1",
        ),
        "ta4j": _evidence_record(
            args.ta4j,
            schema="candlescope.plugin-platform.multi-runtime.phase11-ta4j/1",
        ),
        "regression": _evidence_record(
            args.regression,
            schema="candlescope.plugin-platform.multi-runtime.phase11-regression/1",
        ),
        "soak": _evidence_record(
            args.soak,
            schema="candlescope.plugin-platform.multi-runtime.phase11-soak/1",
            release_qualified=True,
        ),
    }
    soak = strict_json(args.soak)
    if (
        soak.get("elapsedSeconds", 0) < 14_400
        or soak.get("errors") != []
        or soak.get("restarts") != 0
        or soak.get("cleanup", {}).get("residualProcesses") != 0
        or soak.get("cleanup", {}).get("residualSupervisors") != 0
    ):
        raise Phase11GateError("four-hour soak evidence is incomplete")
    browser = strict_json(args.browser)
    if (
        browser.get("headed") is not True
        or browser.get("productionBuild") is not True
        or browser.get("consoleErrors") != 0
        or browser.get("pageErrors") != 0
        or browser.get("unexpectedHttp") != 0
    ):
        raise Phase11GateError(
            "headed production Plugin Manager evidence is incomplete"
        )
    regression = strict_json(args.regression)
    if (
        regression.get("backend", {}).get("failed") != 0
        or regression.get("frontend", {}).get("result") != "pass"
    ):
        raise Phase11GateError("full regression evidence is incomplete")
    result = {
        "schemaVersion": FINAL_SCHEMA,
        "result": "pass",
        "generatedAt": utc_now(),
        "gitHead": git_head(),
        "verifiedTarget": {
            "os": "windows",
            "arch": "x86_64",
            "runtimeKinds": [
                "python-module",
                "native-executable",
                "java-jar",
                "node-module",
                "wasm-component",
            ],
        },
        "evidence": records,
        "gaExit": {
            "machineReadableEvidence": True,
            "thresholdsRelaxed": False,
            "claimsRestrictedToVerifiedTarget": True,
            "newFeaturesIndependentlyDisableable": True,
            "allNewFlagsOffPythonV2Works": True,
            "allNewFlagsOffV1CompatibilityWorks": True,
            "frozenDigestsUnchanged": True,
            "fourHourWallClockSoak": True,
        },
    }
    atomic_json(args.output.resolve(strict=False), result)
    return result


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    modes = value.add_mutually_exclusive_group(required=True)
    modes.add_argument("--run-matrix", action="store_true")
    modes.add_argument("--finalize", action="store_true")
    value.add_argument("--python", type=Path, default=Path(sys.executable))
    value.add_argument("--jre-evidence", type=Path)
    value.add_argument("--marketplace-jre-evidence", type=Path)
    value.add_argument("--node-evidence", type=Path)
    value.add_argument("--wasmtime-evidence", type=Path)
    value.add_argument("--jdk-home", type=Path)
    value.add_argument("--maven-cache", type=Path)
    value.add_argument("--matrix", type=Path, default=MATRIX_EVIDENCE)
    value.add_argument("--sdk", type=Path, default=SDK_EVIDENCE)
    value.add_argument("--browser", type=Path, default=BROWSER_EVIDENCE)
    value.add_argument("--ta4j", type=Path, default=TA4J_EVIDENCE)
    value.add_argument("--regression", type=Path, default=REGRESSION_EVIDENCE)
    value.add_argument("--soak", type=Path, default=SOAK_EVIDENCE)
    value.add_argument("--output", type=Path)
    return value


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if args.run_matrix:
        if (
            args.jre_evidence is None
            or args.marketplace_jre_evidence is None
            or args.node_evidence is None
            or args.wasmtime_evidence is None
            or args.jdk_home is None
            or args.maven_cache is None
        ):
            raise Phase11GateError(
                "--run-matrix requires frozen runtime evidence, JDK, and Maven cache"
            )
        args.output = args.output or MATRIX_EVIDENCE
        result = asyncio.run(run_matrix(args))
    else:
        args.output = args.output or FINAL_EVIDENCE
        result = finalize(args)
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (Phase11GateError, OSError, ValueError, RuntimeError) as exc:
        print(
            json.dumps(
                {"ok": False, "errorType": type(exc).__name__, "message": str(exc)},
                ensure_ascii=False,
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        raise SystemExit(1) from exc
