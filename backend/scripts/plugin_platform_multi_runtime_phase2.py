"""Phase 2 Runtime Provider seam contract, lifecycle, and performance gate."""

from __future__ import annotations

import argparse
import asyncio
import ctypes
import hashlib
import json
import os
import statistics
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = REPOSITORY_ROOT / "backend"
SDK_SOURCE = REPOSITORY_ROOT / "packages" / "candlescope-plugin-sdk" / "src"
CONTRACT_PATH = (
    BACKEND_ROOT
    / "tests"
    / "fixtures"
    / "plugin_platform_multi_runtime"
    / "phase2_contract_v1.json"
)
PHASE0_PERFORMANCE_PATH = (
    REPOSITORY_ROOT
    / "docs"
    / "perf-baselines"
    / "plugin-platform-v2"
    / "phase0-2026-07-22-windows-amd64.json"
)
CONTRACT_SCHEMA_VERSION = "candlescope.plugin-platform.multi-runtime.phase2-contract/1"
GATE_SCHEMA_VERSION = "candlescope.plugin-platform.multi-runtime.phase2-gate/1"
INSTALL_REGRESSION_FACTOR = 1.25
STARTUP_RELATIVE_FACTOR = 1.20
STARTUP_ADDITIVE_BUDGET_MS = 25.0
MEMORY_RELATIVE_FACTOR = 1.10
MEMORY_ADDITIVE_BUDGET_BYTES = 8 * 1024 * 1024


class Phase2GateError(RuntimeError):
    """The reviewed Provider contract, lifecycle, or budget drifted."""


def _ensure_import_paths() -> None:
    scripts_dir = str(Path(__file__).resolve().parent)
    if scripts_dir not in sys.path:
        sys.path.insert(0, scripts_dir)
    from plugin_sdk_isolation import pin_in_repo_plugin_sdk

    pin_in_repo_plugin_sdk(BACKEND_ROOT)


def _strict_json(path: Path) -> dict[str, Any]:
    _ensure_import_paths()
    from candlescope_plugin_sdk.platform_v2 import loads_strict

    value = loads_strict(path.read_bytes())
    if not isinstance(value, dict):
        raise Phase2GateError(f"{path} must contain a JSON object")
    return value


def _sha256_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def capture_contract() -> dict[str, Any]:
    _ensure_import_paths()
    from candlescope_plugin_sdk.platform_v2 import PluginManifest

    from app.plugin_core_v2.runtime_providers import (
        PYTHON_MODULE_PROVIDER_VERSION,
        RUNTIME_PROVIDER_API_VERSION,
        PythonModuleProvider,
        default_runtime_provider_registry,
    )
    from app.plugin_installer_v2.installer import (
        LEGACY_RECEIPT_SCHEMA_VERSION,
        RECEIPT_SCHEMA_VERSION,
        RUNTIME_PROVIDER_SEAM_ENABLED_ENV,
    )
    from scripts import plugin_platform_multi_runtime_phase1 as phase1

    # Phase 2 was reviewed against the immutable Phase 1 /1 generation. Later
    # Phase 1 migrations must not silently rewrite this historical dependency.
    phase1_contract = phase1.validate_historical_contract_v1()
    manifest = PluginManifest.from_wire(
        _strict_json(
            REPOSITORY_ROOT
            / "packages"
            / "candlescope-plugin-sdk"
            / "examples"
            / "platform-v2"
            / "hello-command.manifest.json"
        )
    )
    provider = PythonModuleProvider()
    normalized = manifest.normalized_entrypoints[0]
    prepared = provider.prepare_runtime(
        runtime=normalized.runtime,
        executable=Path(sys.executable),
        working_directory=REPOSITORY_ROOT,
        artifact_sha256="sha256:" + "0" * 64,
    )
    launch = provider.build_runtime_launch(prepared)
    supervisor_source = (
        BACKEND_ROOT / "app" / "plugin_host" / "supervisor.py"
    ).read_text(encoding="utf-8")
    phase0_performance = _strict_json(PHASE0_PERFORMANCE_PATH)
    return {
        "schemaVersion": CONTRACT_SCHEMA_VERSION,
        "implementedOn": "2026-08-03",
        "phase1ContractSha256": _sha256_bytes(
            json.dumps(
                phase1_contract,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        ),
        "providerApi": {
            "apiVersion": RUNTIME_PROVIDER_API_VERSION,
            "registeredKinds": list(default_runtime_provider_registry().kinds),
            "pythonProviderVersion": PYTHON_MODULE_PROVIDER_VERSION,
            "contracts": [
                "PreparedRuntime",
                "PreparedLaunch",
                "RuntimeProviderBinding",
            ],
            "methods": [
                "validate_runtime",
                "prepare_installation",
                "verify_installation",
                "prepare_runtime",
                "build_probe_launch",
                "build_runtime_launch",
            ],
        },
        "pythonV2Launch": {
            "runtimeKind": launch.runtime_kind,
            "runtimeId": launch.runtime_id,
            "executableRole": "managed-python",
            "arguments": list(launch.arguments),
            "workingDirectoryRole": "immutable-installation",
        },
        "receipt": {
            "readSchemaVersions": [
                LEGACY_RECEIPT_SCHEMA_VERSION,
                RECEIPT_SCHEMA_VERSION,
            ],
            "writeSchemaVersion": RECEIPT_SCHEMA_VERSION,
            "providerBindingFields": [
                "providerVersion",
                "runtimeId",
                "runtimeIdentity",
                "runtimeKind",
            ],
        },
        "rollout": {
            "multiRuntimeFlag": "CANDLESCOPE_PLUGIN_MULTI_RUNTIME_ENABLED",
            "multiRuntimeDefault": False,
            "providerSeamFlag": RUNTIME_PROVIDER_SEAM_ENABLED_ENV,
            "providerSeamDefault": True,
            "rollbackValue": False,
        },
        "failClosedErrors": [
            "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID",
            "PLUGIN_RUNTIME_PROVIDER_DUPLICATE",
            "PLUGIN_RUNTIME_PROVIDER_RECEIPT_MISMATCH",
            "PLUGIN_RUNTIME_PROVIDER_UNAVAILABLE",
            "PLUGIN_RUNTIME_PROVIDER_VERSION_INCOMPATIBLE",
        ],
        "supervisorBoundary": {
            "consumes": ["arguments", "executable", "working_directory"],
            "importsRuntimeProvider": "runtime_providers" in supervisor_source,
            "importsPythonProvider": "PythonModuleProvider" in supervisor_source,
        },
        "phase0PerformanceReference": {
            "path": PHASE0_PERFORMANCE_PATH.relative_to(REPOSITORY_ROOT).as_posix(),
            "schemaVersion": phase0_performance["schemaVersion"],
            "firstInstallMs": phase0_performance["baselines"]["installerLifecycle"][
                "firstInstall"
            ]["elapsedMs"],
            "runtimeStartupMs": phase0_performance["baselines"]["controlAndIndicator"][
                "startupMs"
            ],
            "installRegressionFactor": INSTALL_REGRESSION_FACTOR,
            "startupRelativeFactor": STARTUP_RELATIVE_FACTOR,
            "startupAdditiveBudgetMs": STARTUP_ADDITIVE_BUDGET_MS,
            "memoryRelativeFactor": MEMORY_RELATIVE_FACTOR,
            "memoryAdditiveBudgetBytes": MEMORY_ADDITIVE_BUDGET_BYTES,
        },
    }


def validate_contract() -> dict[str, Any]:
    fixture = _strict_json(CONTRACT_PATH)
    current = capture_contract()
    if fixture != current:
        _ensure_import_paths()
        from candlescope_plugin_sdk.platform_v2 import canonical_sha256

        raise Phase2GateError(
            "multi-runtime Phase 2 contract drift: "
            f"fixture={canonical_sha256(fixture)} current={canonical_sha256(current)}"
        )
    return fixture


def _working_set_bytes(pid: int) -> int | None:
    if os.name != "nt":
        return None

    class ProcessMemoryCounters(ctypes.Structure):
        _fields_ = [
            ("cb", ctypes.c_ulong),
            ("PageFaultCount", ctypes.c_ulong),
            ("PeakWorkingSetSize", ctypes.c_size_t),
            ("WorkingSetSize", ctypes.c_size_t),
            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
            ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
            ("PagefileUsage", ctypes.c_size_t),
            ("PeakPagefileUsage", ctypes.c_size_t),
        ]

    process = ctypes.windll.kernel32.OpenProcess(0x0400 | 0x0010, False, pid)
    if not process:
        raise Phase2GateError("unable to open plugin process for memory evidence")
    try:
        counters = ProcessMemoryCounters()
        counters.cb = ctypes.sizeof(counters)
        if not ctypes.windll.psapi.GetProcessMemoryInfo(
            process,
            ctypes.byref(counters),
            counters.cb,
        ):
            raise Phase2GateError("unable to read plugin process memory evidence")
        return int(counters.WorkingSetSize)
    finally:
        ctypes.windll.kernel32.CloseHandle(process)


async def _core_samples(
    *,
    root: Path,
    plugin_id: str,
    contribution_id: str,
    seam_enabled: bool,
    multi_runtime_enabled: bool,
) -> dict[str, Any]:
    from app.plugin_core_v2.runtime import CorePluginPlatform

    platform = CorePluginPlatform(
        root=root,
        host_name="CandleScope",
        host_version="0.4.0",
        multi_runtime_enabled=multi_runtime_enabled,
        runtime_provider_seam_enabled=seam_enabled,
    )
    await platform.start()
    latencies: list[float] = []
    working_sets: list[int] = []
    arguments: tuple[str, ...] | None = None
    executable_name: str | None = None
    try:
        supervisor = platform.manager.supervisor(plugin_id, "main")
        arguments = supervisor.spec.arguments
        executable_name = supervisor.spec.executable.name
        for index in range(3):
            started = time.perf_counter()
            result = await platform.invoke_command(
                contribution_id,
                {"name": f"Phase 2 sample {index}"},
                user_action=True,
                trace_id=f"multi-runtime-phase2-sample-{index}",
            )
            latencies.append((time.perf_counter() - started) * 1000)
            if result["message"] != f"Hello, Phase 2 sample {index}!":
                raise Phase2GateError(
                    "Core command result changed across Provider paths"
                )
            snapshot = supervisor.snapshot()
            pid = snapshot["transport"]["pid"]
            if not isinstance(pid, int):
                raise Phase2GateError("active plugin process has no PID evidence")
            working_set = _working_set_bytes(pid)
            if working_set is not None:
                working_sets.append(working_set)
            await supervisor.stop()
            if supervisor.snapshot()["transport"] is not None:
                raise Phase2GateError("Host stop retained a plugin transport")
    finally:
        await platform.stop()
    if platform.manager.owner_keys():
        raise Phase2GateError("Host stop retained a plugin supervisor")
    return {
        "startupMedianMs": round(statistics.median(latencies), 3),
        "startupSamplesMs": [round(item, 3) for item in latencies],
        "workingSetMedianBytes": (
            int(statistics.median(working_sets)) if working_sets else None
        ),
        "workingSetSamplesBytes": working_sets,
        "arguments": list(arguments or ()),
        "executableName": executable_name,
        "residualSupervisors": 0,
    }


def exercise_phase2_boundary() -> dict[str, Any]:
    _ensure_import_paths()
    from app.plugin_installer_v2.errors import (
        PlatformInstallerBaseError,
        RuntimeProviderUnavailableError,
    )
    from app.plugin_installer_v2.installer import PlatformPluginInstaller
    from app.plugin_installer_v2.registry import load_activation_registry
    from tests.plugin_platform_bundle_testkit import build_hello_platform_bundle
    from tests.plugin_platform_multi_runtime_testkit import (
        build_v3_runtime_bundle,
        read_v3_manifest,
    )

    phase0 = _strict_json(PHASE0_PERFORMANCE_PATH)
    baseline_install_ms = phase0["baselines"]["installerLifecycle"]["firstInstall"][
        "elapsedMs"
    ]
    with tempfile.TemporaryDirectory(
        prefix="candlescope-multi-runtime-phase2-gate-"
    ) as raw:
        root = Path(raw)
        v2_v1 = build_hello_platform_bundle(root / "v2-v1")
        v2_v2 = build_hello_platform_bundle(root / "v2-v2", version="0.2.0")
        provider_installer = PlatformPluginInstaller(
            root=root / "provider-product",
            runtime_provider_seam_enabled=True,
        )
        legacy_installer = PlatformPluginInstaller(
            root=root / "legacy-product",
            runtime_provider_seam_enabled=False,
        )

        started = time.perf_counter()
        provider_first = provider_installer.install(
            v2_v1.bundle.path,
            expected_sha256=v2_v1.bundle.sha256,
            enabled=True,
        )
        provider_install_ms = (time.perf_counter() - started) * 1000
        started = time.perf_counter()
        legacy_first = legacy_installer.install(
            v2_v1.bundle.path,
            expected_sha256=v2_v1.bundle.sha256,
            enabled=True,
        )
        legacy_install_ms = (time.perf_counter() - started) * 1000
        baseline_install_limit_ms = baseline_install_ms * INSTALL_REGRESSION_FACTOR
        relative_install_limit_ms = legacy_install_ms * INSTALL_REGRESSION_FACTOR
        # The frozen Phase 0 number comes from a controlled 2026-07 host. Local
        # antivirus/filesystem load can slow both installer paths equally, so
        # fail only when the Provider path exceeds both the frozen ceiling and
        # its same-run legacy control.
        install_limit_ms = max(
            baseline_install_limit_ms,
            relative_install_limit_ms,
        )
        if provider_install_ms > install_limit_ms:
            raise Phase2GateError(
                "Provider first install exceeded the Phase 0 regression budget: "
                f"provider={provider_install_ms:.3f}ms "
                f"legacy={legacy_install_ms:.3f}ms limit={install_limit_ms:.3f}ms"
            )
        provider_repeat = provider_installer.install(
            v2_v1.bundle.path,
            expected_sha256=v2_v1.bundle.sha256,
            enabled=True,
        )
        if provider_repeat.changed or not provider_repeat.reused_installation:
            raise Phase2GateError("Provider quick repeat changed activation state")

        provider_receipt = _strict_json(
            provider_first.installation_path / "receipt.json"
        )
        legacy_receipt = _strict_json(legacy_first.installation_path / "receipt.json")
        if provider_receipt["probe"] != legacy_receipt["probe"]:
            raise Phase2GateError("Provider and rollback fresh-process probes differ")
        provider_record = load_activation_registry(
            provider_installer.registry_path
        ).by_id()[provider_first.plugin_id]
        legacy_record = load_activation_registry(
            legacy_installer.registry_path
        ).by_id()[legacy_first.plugin_id]
        provider_entrypoint = provider_record.entrypoints[0]
        legacy_entrypoint = legacy_record.entrypoints[0]
        semantic_provider = (
            provider_entrypoint.id,
            provider_entrypoint.module,
            provider_entrypoint.runtime_kind,
            provider_entrypoint.runtime_id,
            provider_entrypoint.arguments,
        )
        semantic_legacy = (
            legacy_entrypoint.id,
            legacy_entrypoint.module,
            legacy_entrypoint.runtime_kind,
            legacy_entrypoint.runtime_id,
            legacy_entrypoint.arguments,
        )
        if semantic_provider != semantic_legacy:
            raise Phase2GateError("Provider and rollback activations differ")

        provider_runtime = asyncio.run(
            _core_samples(
                root=provider_installer.root,
                plugin_id=provider_first.plugin_id,
                contribution_id="candlescope.hello-command.hello",
                seam_enabled=True,
                multi_runtime_enabled=False,
            )
        )
        legacy_runtime = asyncio.run(
            _core_samples(
                root=legacy_installer.root,
                plugin_id=legacy_first.plugin_id,
                contribution_id="candlescope.hello-command.hello",
                seam_enabled=False,
                multi_runtime_enabled=False,
            )
        )
        if (
            provider_runtime["arguments"] != legacy_runtime["arguments"]
            or provider_runtime["executableName"] != legacy_runtime["executableName"]
        ):
            raise Phase2GateError(
                "Provider changed the Supervisor process specification"
            )
        startup_limit = max(
            legacy_runtime["startupMedianMs"] * STARTUP_RELATIVE_FACTOR,
            legacy_runtime["startupMedianMs"] + STARTUP_ADDITIVE_BUDGET_MS,
        )
        if provider_runtime["startupMedianMs"] > startup_limit:
            raise Phase2GateError(
                "Provider startup exceeded the relative Phase 2 budget"
            )
        provider_memory = provider_runtime["workingSetMedianBytes"]
        legacy_memory = legacy_runtime["workingSetMedianBytes"]
        if provider_memory is not None and legacy_memory is not None:
            memory_limit = max(
                legacy_memory * MEMORY_RELATIVE_FACTOR,
                legacy_memory + MEMORY_ADDITIVE_BUDGET_BYTES,
            )
            if provider_memory > memory_limit:
                raise Phase2GateError(
                    "Provider memory exceeded the relative Phase 2 budget"
                )

        upgraded = provider_installer.install(
            v2_v2.bundle.path,
            expected_sha256=v2_v2.bundle.sha256,
            enabled=True,
        )
        rolled_back = provider_installer.rollback(upgraded.plugin_id)
        restored = load_activation_registry(provider_installer.registry_path).by_id()[
            provider_first.plugin_id
        ]
        if (
            rolled_back.removed
            or rolled_back.to_activation_id != provider_record.activation_id
            or restored.installation_id != provider_record.installation_id
        ):
            raise Phase2GateError("Provider activation rollback was not exact")

        native = build_v3_runtime_bundle(root / "native", "native-executable")
        try:
            PlatformPluginInstaller(
                root=root / "native-product",
                multi_runtime_enabled=True,
                runtime_provider_seam_enabled=True,
            ).install(native.bundle.path, expected_sha256=native.bundle.sha256)
        except RuntimeProviderUnavailableError as exc:
            native_error = exc.code
        else:
            raise Phase2GateError("Phase 2 unexpectedly launched a native bundle")

        v3_manifest = read_v3_manifest("python-module")
        v3_manifest["backend"]["entrypoints"][0]["runtime"]["module"] = (
            "candlescope_plugin_sdk.platform_v2.examples.hello_command"
        )
        v3_manifest["contributions"] = [
            {
                "id": "hello",
                "kind": "command/1",
                "title": "Say hello",
                "entrypoint": "main",
                "configuration": {},
            }
        ]
        v3 = build_v3_runtime_bundle(
            root / "v3-python",
            "python-module",
            manifest=v3_manifest,
        )
        v3_installer = PlatformPluginInstaller(
            root=root / "v3-product",
            multi_runtime_enabled=True,
            runtime_provider_seam_enabled=True,
        )
        v3_result = v3_installer.install(
            v3.bundle.path,
            expected_sha256=v3.bundle.sha256,
            enabled=True,
        )
        v3_runtime = asyncio.run(
            _core_samples(
                root=v3_installer.root,
                plugin_id=v3_result.plugin_id,
                contribution_id="candlescope.fixture-python.hello",
                seam_enabled=True,
                multi_runtime_enabled=True,
            )
        )

        tampered = dict(provider_receipt)
        tampered["runtimeProviders"] = [
            dict(item) for item in provider_receipt["runtimeProviders"]
        ]
        tampered["runtimeProviders"][0]["runtimeIdentity"] = "sha256:" + "0" * 64
        (provider_first.installation_path / "receipt.json").write_text(
            json.dumps(tampered),
            encoding="utf-8",
        )
        try:
            provider_installer._verify_installation(provider_first.installation_path)
        except PlatformInstallerBaseError as exc:
            tamper_error = exc.code
        else:
            raise Phase2GateError("tampered Provider receipt unexpectedly verified")

        return {
            "schemaV2": {
                "providerReceiptSchema": provider_receipt["schemaVersion"],
                "rollbackReceiptSchema": legacy_receipt["schemaVersion"],
                "probeEquivalent": True,
                "activationEquivalent": True,
                "quickRepeat": True,
                "exactRollback": True,
                "tamperError": tamper_error,
            },
            "schemaV3Python": {
                "pluginId": v3_result.plugin_id,
                "runtimeKind": "python-module",
                "runtimeId": "python-3-13",
                "arguments": v3_runtime["arguments"],
                "lifecycle": "invoke-and-stop",
                "residualSupervisors": v3_runtime["residualSupervisors"],
            },
            "nonPython": {"nativeError": native_error},
            "performance": {
                "phase0FirstInstallMs": baseline_install_ms,
                "phase0InstallLimitMs": round(baseline_install_limit_ms, 3),
                "sameRunLegacyInstallLimitMs": round(relative_install_limit_ms, 3),
                "effectiveInstallLimitMs": round(install_limit_ms, 3),
                "providerInstallMs": round(provider_install_ms, 3),
                "rollbackInstallMs": round(legacy_install_ms, 3),
                "providerRuntime": provider_runtime,
                "rollbackRuntime": legacy_runtime,
                "result": "within-budget",
            },
        }


def run_gate() -> dict[str, Any]:
    contract = validate_contract()
    boundary = exercise_phase2_boundary()
    return {
        "schemaVersion": GATE_SCHEMA_VERSION,
        "result": "pass",
        "contractSha256": _sha256_bytes(
            json.dumps(contract, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ),
        "boundary": boundary,
    }


def _atomic_write(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.parent / f".{path.name}.{uuid.uuid4().hex}.tmp"
    try:
        temporary.write_text(
            json.dumps(value, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--print-contract", action="store_true")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--run-gate", action="store_true")
    args = parser.parse_args(argv)
    if args.run_gate:
        value = run_gate()
    else:
        value = capture_contract()
    if args.output is not None:
        _atomic_write(args.output, value)
    if args.print_contract or args.run_gate or args.output is None:
        print(json.dumps(value, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
