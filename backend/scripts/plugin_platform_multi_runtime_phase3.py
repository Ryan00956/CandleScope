"""Phase 3 native executable Provider contract, lifecycle, sandbox, and budget gate."""

from __future__ import annotations

import argparse
import asyncio
import ctypes
import hashlib
import json
import os
import platform
import statistics
import sys
import tempfile
import time
import uuid
from dataclasses import fields
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
    / "phase3_contract_v1.json"
)
TRANSCRIPT_PATH = (
    BACKEND_ROOT
    / "tests"
    / "fixtures"
    / "plugin_platform_multi_runtime"
    / "native_reference_transcript_v1.json"
)
PHASE2_PERFORMANCE_PATH = (
    REPOSITORY_ROOT
    / "docs"
    / "perf-baselines"
    / "plugin-platform-v2"
    / "multi-runtime-phase2-2026-08-03-windows-amd64.json"
)
RUST_REFERENCE = REPOSITORY_ROOT / "examples" / "plugin-platform-native-rust"
CONTRACT_SCHEMA_VERSION = "candlescope.plugin-platform.multi-runtime.phase3-contract/1"
GATE_SCHEMA_VERSION = "candlescope.plugin-platform.multi-runtime.phase3-gate/1"
INSTALL_REGRESSION_FACTOR = 1.25
STARTUP_RELATIVE_FACTOR = 1.20
STARTUP_ADDITIVE_BUDGET_MS = 25.0
MEMORY_RELATIVE_FACTOR = 1.10
MEMORY_ADDITIVE_BUDGET_BYTES = 8 * 1024 * 1024


class Phase3GateError(RuntimeError):
    """The reviewed native Provider contract, lifecycle, or budget drifted."""


def _ensure_import_paths() -> None:
    for path in (SDK_SOURCE, BACKEND_ROOT):
        value = str(path)
        if value not in sys.path:
            sys.path.insert(0, value)


def _strict_json(path: Path) -> dict[str, Any]:
    _ensure_import_paths()
    from candlescope_plugin_sdk.platform_v2 import loads_strict

    value = loads_strict(path.read_bytes())
    if not isinstance(value, dict):
        raise Phase3GateError(f"{path} must contain a JSON object")
    return value


def _sha256_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def _sha256_path(path: Path) -> str:
    return _sha256_bytes(path.read_bytes())


def capture_contract() -> dict[str, Any]:
    _ensure_import_paths()
    from app.plugin_core_v2.runtime_providers import (
        NATIVE_EXECUTABLE_PROVIDER_VERSION,
        RUNTIME_PROVIDER_API_VERSION,
        PreparedLaunch,
        RuntimeArtifact,
        default_runtime_provider_registry,
    )
    from app.plugin_host import EntrypointProcessSpec
    from scripts import plugin_platform_multi_runtime_phase2 as phase2

    phase2_contract = phase2.validate_contract()
    transcript = _strict_json(TRANSCRIPT_PATH)
    windows_job_source = (
        BACKEND_ROOT / "app" / "plugin_host" / "windows_job.py"
    ).read_text(encoding="utf-8")
    process_source = (BACKEND_ROOT / "app" / "plugin_host" / "process.py").read_text(
        encoding="utf-8"
    )
    phase2_performance = _strict_json(PHASE2_PERFORMANCE_PATH)
    return {
        "schemaVersion": CONTRACT_SCHEMA_VERSION,
        "implementedOn": "2026-08-03",
        "phase2ContractSha256": _sha256_bytes(
            json.dumps(
                phase2_contract,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        ),
        "providerApi": {
            "apiVersion": RUNTIME_PROVIDER_API_VERSION,
            "nativeProviderVersion": NATIVE_EXECUTABLE_PROVIDER_VERSION,
            "registeredKindsWhenDisabled": list(
                default_runtime_provider_registry(native_enabled=False).kinds
            ),
            "registeredKindsWhenEnabled": list(
                default_runtime_provider_registry(native_enabled=True).kinds
            ),
            "runtimeArtifactFields": [item.name for item in fields(RuntimeArtifact)],
            "preparedLaunchFields": [item.name for item in fields(PreparedLaunch)],
        },
        "artifactPolicy": {
            "role": "native-executable",
            "runtimeId": "native-host",
            "inventoryDigestAndSizeRequired": True,
            "postInstallBinaryInspection": [
                "elf64-executable",
                "macho64-executable",
                "pe32+-executable",
            ],
            "declaredArtifactOnly": True,
            "scriptAndShellRejected": True,
            "operatingSystemAndArchitectureRequired": True,
        },
        "launchPolicy": {
            "argumentArrayOnly": True,
            "isolatedSearchPath": True,
            "maxProcesses": 1,
            "wholeTreeControl": True,
            "windowsCreateSuspended": "CREATE_SUSPENDED" in windows_job_source,
            "windowsKillOnJobClose": (
                "JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE" in windows_job_source
            ),
            "windowsActiveProcessLimit": (
                "JOB_OBJECT_LIMIT_ACTIVE_PROCESS" in windows_job_source
            ),
            "windowsAtomicResume": "NtResumeProcess" in windows_job_source,
            "windowsExplicitApplicationName": (
                'process_kwargs["executable"] = command[0]' in process_source
            ),
            "supervisorFields": [
                item.name
                for item in fields(EntrypointProcessSpec)
                if item.name
                in {
                    "arguments",
                    "executable",
                    "isolated_search_path",
                    "manage_process_tree",
                    "max_processes",
                    "working_directory",
                }
            ],
        },
        "referencePlugin": {
            "language": "rust",
            "package": "candlescope-native-reference",
            "pluginId": "candlescope.native-reference",
            "version": "0.1.0",
            "protocol": "candlescope.plugin/2",
            "transport": "jsonl/1",
            "controlMethods": [
                "activate",
                "cancel",
                "deactivate",
                "describe",
                "handshake",
                "healthCheck",
                "invoke",
                "shutdown",
            ],
            "transcriptPath": TRANSCRIPT_PATH.relative_to(REPOSITORY_ROOT).as_posix(),
            "responseCount": len(transcript["expected"]["responseSha256"]),
            "transcriptSha256": transcript["expected"]["transcriptSha256"],
            "sourceSha256": _sha256_path(RUST_REFERENCE / "src" / "main.rs"),
            "cargoLockSha256": _sha256_path(RUST_REFERENCE / "Cargo.lock"),
            "faultModes": [
                "crash-invoke",
                "crash-start",
                "hang-invoke",
                "hang-start",
                "invalid-utf8",
                "sandbox-probe",
                "spawn-child",
                "stderr-flood",
                "stdout-pollution",
            ],
        },
        "rollout": {
            "multiRuntimeFlag": "CANDLESCOPE_PLUGIN_MULTI_RUNTIME_ENABLED",
            "multiRuntimeDefault": False,
            "providerSeamFlag": "CANDLESCOPE_PLUGIN_RUNTIME_PROVIDER_SEAM_ENABLED",
            "providerSeamDefault": True,
            "nativeFlag": "CANDLESCOPE_PLUGIN_RUNTIME_NATIVE_ENABLED",
            "nativeDefault": False,
            "rollbackValue": False,
            "disabledActivationReason": "PLUGIN_RUNTIME_PROVIDER_UNAVAILABLE",
            "automaticExecutableFallback": False,
        },
        "failClosedErrors": [
            "PLUGIN_MULTI_RUNTIME_FEATURE_DISABLED",
            "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_INVALID",
            "PLUGIN_RUNTIME_PROVIDER_ARTIFACT_MISMATCH",
            "PLUGIN_RUNTIME_PROVIDER_DESCRIPTOR_INVALID",
            "PLUGIN_RUNTIME_PROVIDER_LAUNCH_INVALID",
            "PLUGIN_RUNTIME_PROVIDER_PLATFORM_MISMATCH",
            "PLUGIN_RUNTIME_PROVIDER_RECEIPT_MISMATCH",
            "PLUGIN_RUNTIME_PROVIDER_UNAVAILABLE",
            "PLUGIN_RUNTIME_PROVIDER_VERSION_INCOMPATIBLE",
        ],
        "phase2PerformanceReference": {
            "path": PHASE2_PERFORMANCE_PATH.relative_to(REPOSITORY_ROOT).as_posix(),
            "schemaVersion": phase2_performance["schemaVersion"],
            "phase0FirstInstallMs": phase2_performance["phase0Reference"][
                "firstInstallMs"
            ],
            "pythonProviderStartupMs": phase2_performance["providerPath"][
                "startupMedianMs"
            ],
            "pythonProviderWorkingSetBytes": phase2_performance["providerPath"][
                "workingSetMedianBytes"
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

        raise Phase3GateError(
            "multi-runtime Phase 3 contract drift: "
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
        raise Phase3GateError("unable to open native process for memory evidence")
    try:
        counters = ProcessMemoryCounters()
        counters.cb = ctypes.sizeof(counters)
        if not ctypes.windll.psapi.GetProcessMemoryInfo(
            process,
            ctypes.byref(counters),
            counters.cb,
        ):
            raise Phase3GateError("unable to read native process memory evidence")
        return int(counters.WorkingSetSize)
    finally:
        ctypes.windll.kernel32.CloseHandle(process)


def _process_has_exited(process_id: int) -> bool:
    if os.name != "nt":
        try:
            os.kill(process_id, 0)
        except ProcessLookupError:
            return True
        except PermissionError:
            return False
        return False
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [
        ctypes.c_ulong,
        ctypes.c_int,
        ctypes.c_ulong,
    ]
    kernel32.OpenProcess.restype = ctypes.c_void_p
    kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    kernel32.WaitForSingleObject.restype = ctypes.c_ulong
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel32.OpenProcess(0x00100000, False, process_id)
    if not handle:
        return True
    try:
        return kernel32.WaitForSingleObject(handle, 0) == 0
    finally:
        kernel32.CloseHandle(handle)


async def _wait_for_exit(process_id: int) -> bool:
    for _ in range(100):
        if _process_has_exited(process_id):
            return True
        await asyncio.sleep(0.02)
    return _process_has_exited(process_id)


async def _trusted_runtime_samples(
    *,
    root: Path,
    plugin_id: str,
) -> dict[str, Any]:
    from app.plugin_core_v2.runtime import CorePluginPlatform

    platform = CorePluginPlatform(
        root=root,
        host_name="CandleScope",
        host_version="0.4.0",
        multi_runtime_enabled=True,
        runtime_provider_seam_enabled=True,
        native_runtime_enabled=True,
    )
    await platform.start()
    latencies: list[float] = []
    working_sets: list[int] = []
    process_ids: list[int] = []
    process_tree_control = False
    try:
        supervisor = platform.manager.supervisor(plugin_id, "main")
        for index in range(3):
            started = time.perf_counter()
            result = await platform.invoke_command(
                f"{plugin_id}.hello",
                {"name": f"Native sample {index}"},
                user_action=True,
                trace_id=f"multi-runtime-phase3-sample-{index}",
            )
            latencies.append((time.perf_counter() - started) * 1000)
            if result["message"] != f"Hello, Native sample {index}!":
                raise Phase3GateError("native Core result changed")
            if await supervisor.health_check() != {"pending": 0, "status": "ready"}:
                raise Phase3GateError("native health response changed")
            snapshot = supervisor.snapshot()
            transport = snapshot["transport"]
            process_id = transport["pid"]
            if not isinstance(process_id, int):
                raise Phase3GateError("native process has no PID evidence")
            process_ids.append(process_id)
            process_tree_control = process_tree_control or bool(
                transport["processTreeControl"]
            )
            working_set = _working_set_bytes(process_id)
            if working_set is not None:
                working_sets.append(working_set)
            await supervisor.stop()
            if not await _wait_for_exit(process_id):
                raise Phase3GateError("native process survived Supervisor stop")
    finally:
        await platform.stop()
    if platform.manager.owner_keys():
        raise Phase3GateError("Host stop retained a native supervisor")
    return {
        "startupMedianMs": round(statistics.median(latencies), 3),
        "startupSamplesMs": [round(item, 3) for item in latencies],
        "workingSetMedianBytes": (
            int(statistics.median(working_sets)) if working_sets else None
        ),
        "workingSetSamplesBytes": working_sets,
        "processTreeControl": process_tree_control,
        "processSamples": len(process_ids),
        "residualProcesses": 0,
        "residualSupervisors": 0,
    }


async def _disabled_activation_evidence(root: Path, plugin_id: str) -> dict[str, Any]:
    from app.plugin_core_v2.runtime import CorePluginPlatform

    platform = CorePluginPlatform(
        root=root,
        host_name="CandleScope",
        host_version="0.4.0",
        multi_runtime_enabled=True,
        runtime_provider_seam_enabled=True,
        native_runtime_enabled=False,
    )
    await platform.start()
    try:
        plugin = next(
            item for item in platform.catalog()["plugins"] if item["id"] == plugin_id
        )
        if (
            plugin["available"]
            or plugin["contributions"]
            or plugin["runtime"]["entrypoints"]
            or platform.manager.owner_keys()
        ):
            raise Phase3GateError(
                "disabled native activation found an executable fallback"
            )
        return {
            "state": plugin["state"],
            "enabled": plugin["enabled"],
            "available": plugin["available"],
            "reason": plugin["unavailableReason"],
            "supervisors": 0,
            "automaticFallback": False,
        }
    finally:
        await platform.stop()


async def _fault_matrix(build: Any) -> dict[str, str]:
    from candlescope_plugin_sdk.platform_v2 import PluginManifest

    from app.plugin_host import (
        EntrypointProcessSpec,
        EntrypointSupervisor,
        PlatformHostTransportError,
    )
    from tests.plugin_platform_native_testkit import (
        NATIVE_PLUGIN_ID,
        native_reference_manifest,
    )

    expected = {
        "crash-start": "PLUGIN_PLATFORM_EXITED",
        "hang-start": "PLUGIN_PLATFORM_TIMEOUT",
        "invalid-utf8": "PLUGIN_PLATFORM_RESPONSE_INVALID_JSON",
        "stderr-flood": "PLUGIN_PLATFORM_STDERR_LIMIT_EXCEEDED",
        "stdout-pollution": "PLUGIN_PLATFORM_RESPONSE_INVALID_JSON",
    }
    observed: dict[str, str] = {}
    for mode, code in expected.items():
        manifest = PluginManifest.from_wire(
            native_reference_manifest(mode=mode, include_probe=False)
        )
        supervisor = EntrypointSupervisor(
            EntrypointProcessSpec(
                plugin_id=NATIVE_PLUGIN_ID,
                entrypoint_id="main",
                executable=build.executable,
                arguments=("--jsonl", "--mode", mode),
                working_directory=build.executable.parent,
                startup_timeout_seconds=0.4,
                request_timeout_seconds=0.25,
                shutdown_timeout_seconds=0.25,
                max_restart_attempts=0,
                max_stderr_bytes=4 * 1024,
                manage_process_tree=True,
                isolated_search_path=True,
                max_processes=1,
            ),
            manifest,
            host_name="CandleScope",
            host_version="0.4.0",
        )
        try:
            try:
                await supervisor.start()
            except PlatformHostTransportError as exc:
                observed[mode] = exc.code
            else:
                raise Phase3GateError(f"{mode} unexpectedly started")
        finally:
            await supervisor.stop()
        if observed[mode] != code:
            raise Phase3GateError(
                f"{mode} changed diagnostic code: {observed[mode]} != {code}"
            )

    for mode, code in {
        "crash-invoke": "PLUGIN_PLATFORM_EXITED",
        "hang-invoke": "PLUGIN_PLATFORM_TIMEOUT",
    }.items():
        manifest = PluginManifest.from_wire(
            native_reference_manifest(mode=mode, include_probe=False)
        )
        supervisor = EntrypointSupervisor(
            EntrypointProcessSpec(
                plugin_id=NATIVE_PLUGIN_ID,
                entrypoint_id="main",
                executable=build.executable,
                arguments=("--jsonl", "--mode", mode),
                working_directory=build.executable.parent,
                startup_timeout_seconds=0.4,
                request_timeout_seconds=0.25,
                shutdown_timeout_seconds=0.25,
                max_restart_attempts=0,
                manage_process_tree=True,
                isolated_search_path=True,
                max_processes=1,
            ),
            manifest,
            host_name="CandleScope",
            host_version="0.4.0",
        )
        try:
            await supervisor.start()
            await supervisor.activate(())
            try:
                await supervisor.invoke(
                    "hello",
                    {"name": "must not publish"},
                    user_action=True,
                    trace_id=f"phase3-gate-{mode}",
                )
            except PlatformHostTransportError as exc:
                observed[mode] = exc.code
            else:
                raise Phase3GateError(f"{mode} unexpectedly returned a result")
        finally:
            await supervisor.stop()
        if observed[mode] != code:
            raise Phase3GateError(
                f"{mode} changed diagnostic code: {observed[mode]} != {code}"
            )
    return dict(sorted(observed.items()))


async def _rollback_evidence(
    *,
    root: Path,
    native_fixture: Any,
) -> dict[str, Any]:
    from app.plugin_core_v2.runtime import CorePluginPlatform
    from app.plugin_installer_v2.installer import PlatformPluginInstaller
    from app.plugin_installer_v2.registry import load_activation_registry
    from tests.plugin_platform_native_testkit import (
        NATIVE_PLUGIN_ID,
        build_python_fallback_bundle,
    )

    python = build_python_fallback_bundle(root / "python")
    installer = PlatformPluginInstaller(
        root=root / "product",
        multi_runtime_enabled=True,
        native_runtime_enabled=True,
    )
    python_result = installer.install(
        python.bundle.path,
        expected_sha256=python.bundle.sha256,
        enabled=True,
    )
    native_result = installer.install(
        native_fixture.bundle.path,
        expected_sha256=native_fixture.bundle.sha256,
        enabled=True,
    )
    disabled = PlatformPluginInstaller(
        root=installer.root,
        multi_runtime_enabled=True,
        native_runtime_enabled=False,
    )
    rollback = disabled.rollback(NATIVE_PLUGIN_ID)
    record = load_activation_registry(disabled.registry_path).by_id()[NATIVE_PLUGIN_ID]
    if (
        rollback.removed
        or record.installation_id != python_result.installation_id
        or record.entrypoints[0].runtime_kind != "python-module"
        or record.entrypoints[0].artifact is not None
    ):
        raise Phase3GateError(
            "native rollback did not restore the exact Python activation"
        )
    platform = CorePluginPlatform(
        root=installer.root,
        host_name="CandleScope",
        host_version="0.4.0",
        multi_runtime_enabled=True,
        runtime_provider_seam_enabled=True,
        native_runtime_enabled=False,
    )
    await platform.start()
    try:
        result = await platform.invoke_command(
            f"{NATIVE_PLUGIN_ID}.hello",
            {"name": "rollback gate"},
            user_action=True,
            trace_id="phase3-gate-rollback",
        )
        if result["message"] != "Hello, rollback gate!":
            raise Phase3GateError("Python rollback invocation changed")
    finally:
        await platform.stop()
    return {
        "fromInstallationId": native_result.installation_id,
        "toInstallationId": record.installation_id,
        "restoredRuntimeKind": record.entrypoints[0].runtime_kind,
        "restoredArtifact": None,
        "nativeFlag": False,
        "invoke": "pass",
        "residualSupervisors": len(platform.manager.owner_keys()),
    }


async def _appcontainer_evidence(
    *,
    root: Path,
    build: Any,
) -> dict[str, Any]:
    if os.name != "nt":
        raise Phase3GateError("Phase 3 restricted evidence requires Windows")
    from app.plugin_core_v2.runtime import CorePluginPlatform
    from app.plugin_installer_v2.installer import PlatformPluginInstaller
    from app.plugin_installer_v2.registry import load_activation_registry
    from app.plugin_security_v2 import SandboxPolicy, delete_appcontainer_profile
    from tests.plugin_platform_native_testkit import (
        NATIVE_PLUGIN_ID,
        build_native_reference_bundle,
    )

    root.mkdir(parents=True, exist_ok=True)
    outside_file = root / "outside-secret.txt"
    outside_file.write_text("must remain outside the sandbox", encoding="utf-8")
    fixture = build_native_reference_bundle(
        root / "bundle",
        build,
        mode="sandbox-probe",
        include_probe=False,
        extra_args=(
            "--outside-executable",
            str(build.executable),
            "--outside-file",
            str(outside_file),
        ),
    )
    profile_name = f"CandleScope.Phase3Gate.{uuid.uuid4().hex[:16]}"

    def probe_policy(
        _bundle: object,
        installation: Path,
        _entrypoint: str,
    ) -> SandboxPolicy:
        return SandboxPolicy(
            profile_name,
            installation,
            root / "probe-private",
            root / "probe-runtime",
            memory_limit_bytes=256 * 1024 * 1024,
            cpu_rate_percent=50,
            cpu_time_seconds=30,
            disk_limit_bytes=8 * 1024 * 1024,
            max_processes=1,
            max_wall_seconds=45,
        )

    def runtime_policy(
        record: Any,
        _bundle: object,
        entrypoint_id: str,
    ) -> SandboxPolicy:
        entrypoint = next(
            item for item in record.entrypoints if item.id == entrypoint_id
        )
        return SandboxPolicy(
            profile_name,
            entrypoint.working_directory,
            root / "runtime-private",
            root / "runtime-state",
            memory_limit_bytes=256 * 1024 * 1024,
            cpu_rate_percent=50,
            cpu_time_seconds=30,
            disk_limit_bytes=8 * 1024 * 1024,
            max_processes=1,
            max_wall_seconds=45,
        )

    try:
        installer = PlatformPluginInstaller(
            root=root / "product",
            multi_runtime_enabled=True,
            native_runtime_enabled=True,
            execution_trust_resolver=lambda _bundle: "untrusted",
            probe_sandbox_factory=probe_policy,
        )
        installed = installer.install(
            fixture.bundle.path,
            expected_sha256=fixture.bundle.sha256,
            enabled=True,
        )
        platform = CorePluginPlatform(
            root=installer.root,
            host_name="CandleScope",
            host_version="0.4.0",
            trust_level="untrusted",
            sandbox_factory=runtime_policy,
            multi_runtime_enabled=True,
            runtime_provider_seam_enabled=True,
            native_runtime_enabled=True,
        )
        process_id = 0
        process_tree_control = False
        await platform.start()
        try:
            result = await platform.invoke_command(
                f"{NATIVE_PLUGIN_ID}.hello",
                {"name": "AppContainer gate"},
                user_action=True,
                trace_id="phase3-gate-appcontainer",
            )
            supervisor = platform.manager.supervisor(installed.plugin_id, "main")
            snapshot = supervisor.snapshot()
            process_id = snapshot["transport"]["pid"]
            process_tree_control = snapshot["transport"]["processTreeControl"]
            if (
                result.get("externalExecutableStarted") is not False
                or result.get("externalFileRead") is not False
                or not process_tree_control
            ):
                raise Phase3GateError("AppContainer native boundary was bypassed")
        finally:
            await platform.stop()
        if not await _wait_for_exit(process_id):
            raise Phase3GateError("AppContainer native process survived Host stop")
        config_paths = list((root / "runtime-state").glob("launch-*/config.json"))
        if len(config_paths) != 1:
            raise Phase3GateError("AppContainer runtime launch evidence is missing")
        config = _strict_json(config_paths[0])
        record = load_activation_registry(installer.registry_path).by_id()[
            installed.plugin_id
        ]
        artifact = record.entrypoints[0].artifact
        if (
            artifact is None
            or Path(config["command"][0]).resolve(strict=True) != artifact
            or config["limits"]["activeProcesses"] != 1
        ):
            raise Phase3GateError("AppContainer launched a non-declared artifact")
        return {
            "trust": "untrusted-appcontainer",
            "appContainerSid": str(config["appContainerSid"]).startswith("S-1-15-2-"),
            "declaredArtifactOnly": True,
            "outsideExecutableStarted": False,
            "outsideFileRead": False,
            "activeProcesses": config["limits"]["activeProcesses"],
            "processTreeControl": process_tree_control,
            "residualProcesses": 0,
            "residualSupervisors": len(platform.manager.owner_keys()),
        }
    finally:
        delete_appcontainer_profile(profile_name)


def exercise_phase3_boundary() -> dict[str, Any]:
    if os.name != "nt":
        raise Phase3GateError("Phase 3 release gate requires Windows")
    _ensure_import_paths()
    from candlescope_plugin_sdk.platform_v2 import NativeExecutableRuntime

    from app.plugin_core_v2.runtime_providers import (
        NativeExecutableProvider,
        RuntimeProviderError,
    )
    from app.plugin_installer_v2.errors import (
        MultiRuntimeFeatureDisabledError,
        PlatformInstallerBaseError,
        RuntimeProviderUnavailableError,
    )
    from app.plugin_installer_v2.installer import PlatformPluginInstaller
    from app.plugin_installer_v2.registry import load_activation_registry
    from tests.plugin_platform_native_testkit import (
        NATIVE_PLUGIN_ID,
        build_native_reference_bundle,
        compile_native_reference,
        host_platform,
    )

    phase2_performance = _strict_json(PHASE2_PERFORMANCE_PATH)
    phase0_install_ms = phase2_performance["phase0Reference"]["firstInstallMs"]
    python_startup_ms = phase2_performance["providerPath"]["startupMedianMs"]
    python_memory_bytes = phase2_performance["providerPath"]["workingSetMedianBytes"]
    with tempfile.TemporaryDirectory(
        prefix="candlescope-multi-runtime-phase3-gate-"
    ) as raw:
        root = Path(raw)
        compiled_at = time.perf_counter()
        build = compile_native_reference(root / "build")
        compilation_ms = (time.perf_counter() - compiled_at) * 1000
        fixture = build_native_reference_bundle(root / "native", build)
        installer = PlatformPluginInstaller(
            root=root / "product",
            multi_runtime_enabled=True,
            runtime_provider_seam_enabled=True,
            native_runtime_enabled=True,
        )
        started = time.perf_counter()
        installed = installer.install(
            fixture.bundle.path,
            expected_sha256=fixture.bundle.sha256,
            enabled=True,
        )
        install_ms = (time.perf_counter() - started) * 1000
        repeated = installer.install(
            fixture.bundle.path,
            expected_sha256=fixture.bundle.sha256,
            enabled=True,
        )
        if repeated.changed or not repeated.reused_installation:
            raise Phase3GateError("native quick repeat changed activation state")
        checked = installer.check(installed.plugin_id)
        if checked.state != "active":
            raise Phase3GateError("native check did not preserve active state")
        receipt = _strict_json(installed.installation_path / "receipt.json")
        record = load_activation_registry(installer.registry_path).by_id()[
            installed.plugin_id
        ]
        entrypoint = record.entrypoints[0]
        if (
            entrypoint.runtime_kind != "native-executable"
            or entrypoint.runtime_id != "native-host"
            or entrypoint.module is not None
            or entrypoint.artifact != entrypoint.executable
            or entrypoint.artifact_sha256 != build.sha256
            or (installed.installation_path / "venv").exists()
        ):
            raise Phase3GateError("native activation identity is not exact")
        if (
            receipt["runtimeProviders"][0]["providerVersion"] != "1.0.0"
            or receipt["probe"]["semanticProbes"][0]["sha256"]
            != _strict_json(TRANSCRIPT_PATH)["expected"]["transcriptSha256"]
        ):
            raise Phase3GateError("native receipt or transcript binding changed")

        trusted = asyncio.run(
            _trusted_runtime_samples(root=installer.root, plugin_id=NATIVE_PLUGIN_ID)
        )
        disabled_activation = asyncio.run(
            _disabled_activation_evidence(installer.root, NATIVE_PLUGIN_ID)
        )
        faults = asyncio.run(_fault_matrix(build))
        sandbox = asyncio.run(
            _appcontainer_evidence(root=root / "sandbox", build=build)
        )
        rollback = asyncio.run(
            _rollback_evidence(
                root=root / "rollback",
                native_fixture=fixture,
            )
        )

        errors: dict[str, str] = {}
        try:
            PlatformPluginInstaller(
                root=root / "native-disabled",
                multi_runtime_enabled=True,
                runtime_provider_seam_enabled=True,
                native_runtime_enabled=False,
            ).install(
                fixture.bundle.path,
                expected_sha256=fixture.bundle.sha256,
            )
        except RuntimeProviderUnavailableError as exc:
            errors["nativeFlagOff"] = exc.code
        else:
            raise Phase3GateError("native flag off unexpectedly executed the artifact")
        try:
            PlatformPluginInstaller(
                root=root / "multi-disabled",
                multi_runtime_enabled=False,
                runtime_provider_seam_enabled=True,
                native_runtime_enabled=True,
            ).install(
                fixture.bundle.path,
                expected_sha256=fixture.bundle.sha256,
            )
        except MultiRuntimeFeatureDisabledError as exc:
            errors["multiRuntimeOff"] = exc.code
        else:
            raise Phase3GateError("multi-runtime flag off unexpectedly executed native")

        operating_system, architecture = host_platform()
        other_operating_system = "linux" if operating_system != "linux" else "windows"
        try:
            NativeExecutableProvider().validate_runtime(
                NativeExecutableRuntime(
                    artifact="runtime/reference.exe",
                    operating_systems=(other_operating_system,),
                    architectures=(architecture,),
                )
            )
        except RuntimeProviderError as exc:
            errors["platformMismatch"] = exc.code
        else:
            raise Phase3GateError("native Provider accepted an OS mismatch")

        artifact = entrypoint.artifact
        assert artifact is not None
        artifact.write_bytes(artifact.read_bytes() + b"phase3-gate-tamper")
        try:
            installer._verify_installation(installed.installation_path)
        except PlatformInstallerBaseError as exc:
            errors["artifactTamper"] = exc.code
        else:
            raise Phase3GateError("tampered native artifact unexpectedly verified")

        install_limit = phase0_install_ms * INSTALL_REGRESSION_FACTOR
        startup_limit = max(
            python_startup_ms * STARTUP_RELATIVE_FACTOR,
            python_startup_ms + STARTUP_ADDITIVE_BUDGET_MS,
        )
        memory_limit = max(
            python_memory_bytes * MEMORY_RELATIVE_FACTOR,
            python_memory_bytes + MEMORY_ADDITIVE_BUDGET_BYTES,
        )
        if install_ms > install_limit:
            raise Phase3GateError("native first install exceeded the Phase 0 budget")
        if trusted["startupMedianMs"] > startup_limit:
            raise Phase3GateError("native startup exceeded the Phase 2 budget")
        native_memory = trusted["workingSetMedianBytes"]
        if native_memory is not None and native_memory > memory_limit:
            raise Phase3GateError("native working set exceeded the Phase 2 budget")

        return {
            "toolchain": {
                "rustc": build.rustc_version,
                "cargo": build.cargo_version,
                "compileReleaseLockedOffline": True,
                "compilationMsInformational": round(compilation_ms, 3),
                "artifactSha256": build.sha256,
            },
            "installation": {
                "pluginId": installed.plugin_id,
                "runtimeKind": entrypoint.runtime_kind,
                "runtimeId": entrypoint.runtime_id,
                "providerVersion": receipt["runtimeProviders"][0]["providerVersion"],
                "receiptSchema": receipt["schemaVersion"],
                "transcriptSha256": receipt["probe"]["semanticProbes"][0]["sha256"],
                "quickRepeat": True,
                "check": "active",
                "venvCreated": False,
                "declaredArtifactOnly": True,
            },
            "errors": dict(sorted(errors.items())),
            "faults": faults,
            "disabledActivation": disabled_activation,
            "rollback": rollback,
            "trustedLocal": {
                "trust": "local-trusted",
                **trusted,
            },
            "restrictedWindows": sandbox,
            "performance": {
                "phase0FirstInstallMs": phase0_install_ms,
                "nativeInstallMs": round(install_ms, 3),
                "installMaximumMs": round(install_limit, 3),
                "phase2PythonStartupMs": python_startup_ms,
                "nativeStartupMedianMs": trusted["startupMedianMs"],
                "startupMaximumMs": round(startup_limit, 3),
                "phase2PythonWorkingSetBytes": python_memory_bytes,
                "nativeWorkingSetMedianBytes": native_memory,
                "workingSetMaximumBytes": int(memory_limit),
                "result": "within-budget",
            },
        }


def run_gate() -> dict[str, Any]:
    contract = validate_contract()
    boundary = exercise_phase3_boundary()
    return {
        "schemaVersion": GATE_SCHEMA_VERSION,
        "result": "pass",
        "contractSha256": _sha256_bytes(
            json.dumps(contract, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ),
        "environment": {
            "system": platform.system(),
            "machine": platform.machine(),
            "python": platform.python_version(),
            "pythonImplementation": platform.python_implementation(),
        },
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
