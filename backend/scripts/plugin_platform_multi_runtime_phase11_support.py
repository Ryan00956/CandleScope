"""Shared real-process setup for the Plugin Platform Phase 11 GA gates."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import platform
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = REPOSITORY_ROOT / "backend"
SDK_SOURCE = REPOSITORY_ROOT / "packages" / "candlescope-plugin-sdk" / "src"


def ensure_import_paths() -> None:
    for path in (BACKEND_ROOT, SDK_SOURCE):
        value = str(path)
        if value not in sys.path:
            sys.path.insert(0, value)


def canonical_sha256(value: Any) -> str:
    payload = json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def sha256_path(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


class MultiRuntimeEvidenceFetcher:
    """Route signed Registry URLs to the already-audited local evidence sets."""

    def __init__(self, *, jre: Path, node: Path, wasmtime: Path) -> None:
        ensure_import_paths()
        from scripts.plugin_platform_multi_runtime_phase5 import _LocalEvidenceFetcher
        from scripts.plugin_platform_multi_runtime_phase7 import (
            _LocalNodeEvidenceFetcher,
        )
        from scripts.plugin_platform_multi_runtime_phase8 import (
            _LocalWasmEvidenceFetcher,
        )

        self.java = _LocalEvidenceFetcher(jre)
        self.node = _LocalNodeEvidenceFetcher(node)
        self.wasmtime = _LocalWasmEvidenceFetcher(wasmtime)
        self.calls: list[str] = []

    def fetch(self, url: str, destination: Path, *, maximum: int) -> None:
        self.calls.append(url)
        if "adoptium" in url or "temurin" in url:
            self.java.fetch(url, destination, maximum=maximum)
            return
        if "nodejs.org" in url or "githubusercontent.com/nodejs/node/" in url:
            self.node.fetch(url, destination, maximum=maximum)
            return
        if "bytecodealliance/wasmtime" in url:
            self.wasmtime.fetch(url, destination, maximum=maximum)
            return
        raise RuntimeError(f"unmapped Phase 11 runtime evidence URL: {url}")


@dataclass(frozen=True, slots=True)
class RuntimeFixtureSet:
    python: Any
    native: Any
    java: Any
    node: Any
    wasm: Any

    def values(self) -> tuple[Any, ...]:
        return (self.python, self.native, self.java, self.node, self.wasm)


@dataclass(slots=True)
class RunningMultiRuntimePlatform:
    platform: Any
    fixtures: RuntimeFixtureSet
    registry: Any
    fetcher: MultiRuntimeEvidenceFetcher
    process_ids: tuple[int, ...]
    installation: list[dict[str, Any]]
    first_results: dict[str, Any]
    first_latencies_ms: dict[str, float]

    async def close(self) -> dict[str, Any]:
        before = tuple(self.process_ids)
        await self.platform.stop()
        deadline = time.monotonic() + 10.0
        while time.monotonic() < deadline and any(
            process_exists(pid) for pid in before
        ):
            await asyncio.sleep(0.05)
        residual = [pid for pid in before if process_exists(pid)]
        owners = list(self.platform.manager.owner_keys())
        return {
            "observedProcessCount": len(before),
            "residualProcesses": len(residual),
            "residualSupervisors": len(owners),
        }


def process_exists(process_id: int) -> bool:
    try:
        import psutil

        process = psutil.Process(process_id)
        return process.is_running() and process.status() != psutil.STATUS_ZOMBIE
    except (ImportError, OSError):
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            open_process = ctypes.WINFUNCTYPE(
                wintypes.HANDLE,
                wintypes.DWORD,
                wintypes.BOOL,
                wintypes.DWORD,
                use_last_error=True,
            )(("OpenProcess", kernel32))
            wait_for_single_object = ctypes.WINFUNCTYPE(
                wintypes.DWORD,
                wintypes.HANDLE,
                wintypes.DWORD,
                use_last_error=True,
            )(("WaitForSingleObject", kernel32))
            close_handle = ctypes.WINFUNCTYPE(
                wintypes.BOOL,
                wintypes.HANDLE,
                use_last_error=True,
            )(("CloseHandle", kernel32))
            handle = open_process(0x00100000, False, process_id)
            if not handle:
                return False
            try:
                return wait_for_single_object(handle, 0) != 0
            finally:
                close_handle(handle)
        try:
            os.kill(process_id, 0)
        except (ProcessLookupError, PermissionError):
            return False
        return True


def build_registry(
    root: Path,
    *,
    jre_evidence: Path,
    node_evidence: Path,
    wasmtime_evidence: Path,
) -> tuple[Any, MultiRuntimeEvidenceFetcher, dict[str, Any]]:
    ensure_import_paths()
    from app.plugin_runtime_registry_v3 import build_official_runtime_registry

    fetcher = MultiRuntimeEvidenceFetcher(
        jre=jre_evidence.resolve(strict=True),
        node=node_evidence.resolve(strict=True),
        wasmtime=wasmtime_evidence.resolve(strict=True),
    )
    registry = build_official_runtime_registry(
        root=root,
        enabled=True,
        network_updates_enabled=False,
        fetcher=fetcher,
    )
    ensured: list[dict[str, Any]] = []
    for runtime_id, kind in (
        ("temurin-25.0.4.7", "java"),
        ("node-24.19.0", "node"),
        ("wasmtime-47.0.3", "wasm"),
    ):
        first = registry.ensure(runtime_id, kind)
        repeat = registry.ensure(runtime_id, kind)
        offline = registry.ensure(runtime_id, kind, offline=True)
        if first.quick_repeat or not repeat.quick_repeat or not offline.quick_repeat:
            raise RuntimeError(f"{runtime_id} fresh/repeat/offline semantics changed")
        ensured.append(
            {
                "runtimeId": runtime_id,
                "kind": kind,
                "artifactSha256": first.release.sha256,
                "probeSha256": first.probe.sha256,
                "firstQuickRepeat": first.quick_repeat,
                "repeatQuickRepeat": repeat.quick_repeat,
                "offlineQuickRepeat": offline.quick_repeat,
            }
        )
    return registry, fetcher, {"runtimes": ensured, "fetchCalls": len(fetcher.calls)}


def build_fixtures(root: Path) -> tuple[RuntimeFixtureSet, dict[str, Any]]:
    ensure_import_paths()
    from tests.plugin_platform_bundle_testkit import build_hello_platform_bundle
    from tests.plugin_platform_java_testkit import build_java_reference_bundle
    from tests.plugin_platform_native_testkit import (
        build_native_reference_bundle,
        compile_native_reference,
    )
    from tests.plugin_platform_node_testkit import build_node_reference_bundle
    from tests.plugin_platform_wasm_testkit import build_wasm_reference_bundle

    native_build = compile_native_reference(root / "native-build")
    fixtures = RuntimeFixtureSet(
        python=build_hello_platform_bundle(root / "python"),
        native=build_native_reference_bundle(root / "native", native_build),
        java=build_java_reference_bundle(root / "java"),
        node=build_node_reference_bundle(root / "node"),
        wasm=build_wasm_reference_bundle(root / "wasm"),
    )
    return fixtures, {
        "nativeCompiler": {
            "rustc": native_build.rustc_version,
            "cargo": native_build.cargo_version,
            "artifactSha256": native_build.sha256,
        },
        "bundles": [
            {
                "pluginId": fixture.bundle.manifest.plugin.id,
                "version": fixture.bundle.manifest.plugin.version,
                "runtimeKinds": sorted(
                    {
                        item.runtime.kind
                        for item in fixture.bundle.manifest.normalized_entrypoints
                    }
                ),
                "bundleSha256": fixture.bundle.sha256,
                "bundleSize": fixture.bundle.size,
            }
            for fixture in fixtures.values()
        ],
    }


def _install_all(platform: Any, fixtures: RuntimeFixtureSet) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for fixture in fixtures.values():
        bundle = fixture.bundle
        installed = platform.installer.install(
            bundle.path,
            expected_sha256=bundle.sha256,
            enabled=True,
        )
        for permission in bundle.manifest.permissions.required:
            platform.installer.grant_permission(
                installed.plugin_id,
                permission.id,
                scope=permission.scope,
            )
        enabled = platform.installer.enable(installed.plugin_id)
        repeated = platform.installer.install(
            bundle.path,
            expected_sha256=bundle.sha256,
            enabled=True,
        )
        if enabled.state != "active" or not repeated.reused_installation:
            raise RuntimeError(
                f"{installed.plugin_id} install/quick-repeat did not converge"
            )
        results.append(
            {
                "pluginId": installed.plugin_id,
                "runtimeKinds": sorted(
                    {
                        item.runtime.kind
                        for item in bundle.manifest.normalized_entrypoints
                    }
                ),
                "bundleSha256": bundle.sha256,
                "freshState": installed.state,
                "enabledState": enabled.state,
                "quickRepeat": repeated.reused_installation,
            }
        )
    return results


def invocation_specs() -> tuple[tuple[str, str, dict[str, Any]], ...]:
    ensure_import_paths()
    from scripts.plugin_platform_multi_runtime_phase5 import _input

    return (
        ("python-module", "candlescope.hello-command.hello", {"name": "Phase 11"}),
        (
            "native-executable",
            "candlescope.native-reference.hello",
            {"name": "Phase 11"},
        ),
        (
            "java-jar",
            "candlescope.ta4j-elliott.analyze-ta4j-elliott",
            _input("phase11"),
        ),
        ("node-module", "candlescope.node-hello.node-hello", {"name": "Phase 11"}),
        (
            "wasm-component",
            "candlescope.wasm-reference.wasm-hello",
            {"name": "Phase 11", "numbers": [2, 3, 5]},
        ),
    )


async def invoke_all(
    platform: Any, *, trace_prefix: str
) -> tuple[dict[str, Any], dict[str, float]]:
    outputs: dict[str, Any] = {}
    latencies: dict[str, float] = {}
    for kind, contribution, request in invocation_specs():
        started = time.perf_counter()
        result = await platform.invoke_command(
            contribution,
            request,
            user_action=True,
            trace_id=f"{trace_prefix}-{kind}",
        )
        latencies[kind] = round((time.perf_counter() - started) * 1000, 3)
        outputs[kind] = {
            "resultSha256": canonical_sha256(result),
            "schemaVersion": result.get("schemaVersion")
            if isinstance(result, dict)
            else None,
        }
    return outputs, latencies


def active_processes(platform: Any) -> tuple[int, ...]:
    values: list[int] = []
    for owner in platform.manager.owner_keys():
        snapshot = platform.manager.supervisor(*owner).snapshot()
        process_id = snapshot.get("transport", {}).get("pid")
        if isinstance(process_id, int) and process_id > 0:
            values.append(process_id)
    return tuple(sorted(set(values)))


async def start_multi_runtime_platform(
    root: Path,
    *,
    jre_evidence: Path,
    node_evidence: Path,
    wasmtime_evidence: Path,
) -> tuple[RunningMultiRuntimePlatform, dict[str, Any]]:
    if os.name != "nt":
        raise RuntimeError("Phase 11 multi-runtime real-process gate requires Windows")
    ensure_import_paths()
    from app.plugin_core_v2.runtime import CorePluginPlatform
    from scripts.plugin_platform_multi_runtime_phase5 import _MarketPort

    registry, fetcher, registry_evidence = build_registry(
        root / "managed-runtimes",
        jre_evidence=jre_evidence,
        node_evidence=node_evidence,
        wasmtime_evidence=wasmtime_evidence,
    )
    fixtures, build_evidence = build_fixtures(root / "fixtures")
    platform_instance = CorePluginPlatform(
        root=root / "product",
        host_name="CandleScope",
        host_version="0.4.0",
        multi_runtime_enabled=True,
        runtime_provider_seam_enabled=True,
        native_runtime_enabled=True,
        java_runtime_enabled=True,
        node_runtime_enabled=True,
        wasm_runtime_enabled=True,
        runtime_registry_enabled=True,
        runtime_registry_network_updates_enabled=False,
        managed_runtime_registry=registry,
    )
    platform_instance.bind_market_data(_MarketPort())
    installation = _install_all(platform_instance, fixtures)
    await platform_instance.start()
    try:
        outputs, latencies = await invoke_all(
            platform_instance, trace_prefix="phase11-first"
        )
        processes = active_processes(platform_instance)
        if len(platform_instance.manager.owner_keys()) != 5 or len(processes) != 5:
            raise RuntimeError(
                "multi-runtime startup did not retain five isolated supervisors"
            )
        runtime_kinds = {
            item["runtimeKinds"][0]
            for item in installation
            if len(item["runtimeKinds"]) == 1
        }
        if runtime_kinds != {
            "python-module",
            "native-executable",
            "java-jar",
            "node-module",
            "wasm-component",
        }:
            raise RuntimeError("multi-runtime startup kind matrix is incomplete")
    except BaseException:
        await platform_instance.stop()
        raise
    running = RunningMultiRuntimePlatform(
        platform=platform_instance,
        fixtures=fixtures,
        registry=registry,
        fetcher=fetcher,
        process_ids=processes,
        installation=installation,
        first_results=outputs,
        first_latencies_ms=latencies,
    )
    return running, {
        "environment": {
            "os": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
            "python": platform.python_version(),
        },
        "registry": registry_evidence,
        "build": build_evidence,
        "installation": installation,
        "firstResults": outputs,
        "firstLatenciesMs": latencies,
        "activeProcesses": len(processes),
        "activeSupervisors": len(platform_instance.manager.owner_keys()),
    }


def _windows_thread_count(process_id: int) -> int:
    import ctypes
    from ctypes import wintypes

    class ThreadEntry32(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD),
            ("cntUsage", wintypes.DWORD),
            ("th32ThreadID", wintypes.DWORD),
            ("th32OwnerProcessID", wintypes.DWORD),
            ("tpBasePri", wintypes.LONG),
            ("tpDeltaPri", wintypes.LONG),
            ("dwFlags", wintypes.DWORD),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    create_snapshot = ctypes.WINFUNCTYPE(
        wintypes.HANDLE,
        wintypes.DWORD,
        wintypes.DWORD,
        use_last_error=True,
    )(("CreateToolhelp32Snapshot", kernel32))
    thread_first = ctypes.WINFUNCTYPE(
        wintypes.BOOL,
        wintypes.HANDLE,
        ctypes.POINTER(ThreadEntry32),
        use_last_error=True,
    )(("Thread32First", kernel32))
    thread_next = ctypes.WINFUNCTYPE(
        wintypes.BOOL,
        wintypes.HANDLE,
        ctypes.POINTER(ThreadEntry32),
        use_last_error=True,
    )(("Thread32Next", kernel32))
    close_handle = ctypes.WINFUNCTYPE(
        wintypes.BOOL,
        wintypes.HANDLE,
        use_last_error=True,
    )(("CloseHandle", kernel32))
    snapshot = create_snapshot(0x00000004, 0)
    if snapshot == wintypes.HANDLE(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        entry = ThreadEntry32()
        entry.dwSize = ctypes.sizeof(entry)
        if not thread_first(snapshot, ctypes.byref(entry)):
            raise ctypes.WinError(ctypes.get_last_error())
        count = 0
        while True:
            if entry.th32OwnerProcessID == process_id:
                count += 1
            if not thread_next(snapshot, ctypes.byref(entry)):
                error = ctypes.get_last_error()
                if error != 18:  # ERROR_NO_MORE_FILES
                    raise ctypes.WinError(error)
                break
        return count
    finally:
        close_handle(snapshot)


def _windows_process_metrics(process_id: int) -> dict[str, int]:
    import ctypes
    from ctypes import wintypes

    class ProcessMemoryCountersEx(ctypes.Structure):
        _fields_ = [
            ("cb", wintypes.DWORD),
            ("PageFaultCount", wintypes.DWORD),
            ("PeakWorkingSetSize", ctypes.c_size_t),
            ("WorkingSetSize", ctypes.c_size_t),
            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
            ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
            ("PagefileUsage", ctypes.c_size_t),
            ("PeakPagefileUsage", ctypes.c_size_t),
            ("PrivateUsage", ctypes.c_size_t),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    psapi = ctypes.WinDLL("psapi", use_last_error=True)
    open_process = ctypes.WINFUNCTYPE(
        wintypes.HANDLE,
        wintypes.DWORD,
        wintypes.BOOL,
        wintypes.DWORD,
        use_last_error=True,
    )(("OpenProcess", kernel32))
    get_process_handle_count = ctypes.WINFUNCTYPE(
        wintypes.BOOL,
        wintypes.HANDLE,
        ctypes.POINTER(wintypes.DWORD),
        use_last_error=True,
    )(("GetProcessHandleCount", kernel32))
    get_process_memory_info = ctypes.WINFUNCTYPE(
        wintypes.BOOL,
        wintypes.HANDLE,
        ctypes.POINTER(ProcessMemoryCountersEx),
        wintypes.DWORD,
        use_last_error=True,
    )(("GetProcessMemoryInfo", psapi))
    close_handle = ctypes.WINFUNCTYPE(
        wintypes.BOOL,
        wintypes.HANDLE,
        use_last_error=True,
    )(("CloseHandle", kernel32))
    handle = open_process(0x0400 | 0x0010, False, process_id)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        memory = ProcessMemoryCountersEx()
        memory.cb = ctypes.sizeof(memory)
        if not get_process_memory_info(
            handle,
            ctypes.byref(memory),
            memory.cb,
        ):
            raise ctypes.WinError(ctypes.get_last_error())
        handles = wintypes.DWORD()
        if not get_process_handle_count(handle, ctypes.byref(handles)):
            raise ctypes.WinError(ctypes.get_last_error())
        return {
            "pid": process_id,
            "rssBytes": int(memory.WorkingSetSize),
            "vmsBytes": int(memory.PrivateUsage),
            "handles": int(handles.value),
            "threads": _windows_thread_count(process_id),
        }
    finally:
        close_handle(handle)


def process_metrics(process_ids: Iterable[int]) -> dict[str, Any]:
    try:
        import psutil
    except ImportError:
        psutil = None
    if psutil is None and os.name != "nt":
        raise RuntimeError("Phase 11 soak requires psutil outside Windows")
    rows: list[dict[str, Any]] = []
    for process_id in sorted(set(process_ids)):
        if psutil is None:
            rows.append(_windows_process_metrics(process_id))
        else:
            process = psutil.Process(process_id)
            memory = process.memory_info()
            rows.append(
                {
                    "pid": process_id,
                    "rssBytes": memory.rss,
                    "vmsBytes": memory.vms,
                    "handles": process.num_handles()
                    if os.name == "nt"
                    else process.num_fds(),
                    "threads": process.num_threads(),
                }
            )
    return {
        "processes": rows,
        "totalRssBytes": sum(item["rssBytes"] for item in rows),
        "totalHandles": sum(item["handles"] for item in rows),
    }


__all__ = [
    "REPOSITORY_ROOT",
    "RunningMultiRuntimePlatform",
    "active_processes",
    "canonical_sha256",
    "ensure_import_paths",
    "invoke_all",
    "process_metrics",
    "sha256_path",
    "start_multi_runtime_platform",
]
