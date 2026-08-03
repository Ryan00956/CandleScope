"""Phase 7 Node Provider, TypeScript SDK, and real managed-Node gate."""

from __future__ import annotations

import argparse
import asyncio
import base64
import contextlib
import ctypes
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Sequence


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = REPOSITORY_ROOT / "backend"
SDK_SOURCE = REPOSITORY_ROOT / "packages" / "candlescope-plugin-sdk" / "src"
NODE_SDK = REPOSITORY_ROOT / "packages" / "candlescope-plugin-sdk-typescript"
NODE_REFERENCE = REPOSITORY_ROOT / "examples" / "plugin-platform-node-typescript"
FIXTURE_ROOT = BACKEND_ROOT / "tests" / "fixtures" / "plugin_platform_multi_runtime"
CONTRACT_PATH = FIXTURE_ROOT / "phase7_contract_v1.json"
SANDBOX_PROBE = FIXTURE_ROOT / "phase7_node_sandbox_probe.mjs"
REAL_EVIDENCE_PATH = (
    REPOSITORY_ROOT
    / "docs"
    / "perf-baselines"
    / "plugin-platform-v2"
    / "multi-runtime-phase7-2026-08-03-windows-amd64.json"
)
CONTRACT_SCHEMA_VERSION = "candlescope.plugin-platform.multi-runtime.phase7-contract/1"
REAL_GATE_SCHEMA_VERSION = (
    "candlescope.plugin-platform.multi-runtime.phase7-real-gate/1"
)
GATE_SCHEMA_VERSION = "candlescope.plugin-platform.multi-runtime.phase7-gate/1"
NODE_RUNTIME_ID = "node-24.19.0"
NODE_PLUGIN_ID = "candlescope.node-hello"
NODE_CONTRIBUTION_ID = "node-hello"


class Phase7GateError(RuntimeError):
    """The reviewed Node contract or a real release gate failed."""


def _ensure_import_paths() -> None:
    for path in (SDK_SOURCE, BACKEND_ROOT):
        value = str(path)
        if value not in sys.path:
            sys.path.insert(0, value)


def _sha256_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def _sha256_path(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def _strict_json(path: Path) -> dict[str, Any]:
    _ensure_import_paths()
    from candlescope_plugin_sdk.platform_v2 import loads_strict

    value = loads_strict(path.read_bytes())
    if not isinstance(value, dict):
        raise Phase7GateError(f"{path} must contain a strict JSON object")
    return value


def _canonical_sha256(value: Any) -> str:
    _ensure_import_paths()
    from candlescope_plugin_sdk.platform_v2 import canonical_sha256

    return canonical_sha256(value)


def _run_checked(
    command: Sequence[str],
    *,
    cwd: Path = REPOSITORY_ROOT,
    timeout: float = 180,
    input_bytes: bytes | None = None,
) -> subprocess.CompletedProcess[bytes]:
    completed = subprocess.run(
        tuple(command),
        cwd=cwd,
        input=input_bytes,
        stdin=None if input_bytes is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        shell=False,
        timeout=timeout,
    )
    if completed.returncode:
        raise Phase7GateError(
            f"command failed ({completed.returncode}): {tuple(command)!r}\n"
            + completed.stderr[-6000:].decode("utf-8", errors="replace")
        )
    return completed


def capture_contract() -> dict[str, Any]:
    _ensure_import_paths()
    from app.plugin_core_v2.runtime_providers import (
        NODE_MODULE_PROVIDER_VERSION,
        default_runtime_provider_registry,
    )
    from app.plugin_installer_v2.installer import (
        MULTI_RUNTIME_ENABLED_ENV,
        NODE_RUNTIME_ENABLED_ENV,
        RUNTIME_PROVIDER_SEAM_ENABLED_ENV,
    )
    from app.plugin_runtime_registry_v3 import (
        OFFICIAL_REGISTRY_V3_PATH,
        OFFICIAL_REGISTRY_V4_PATH,
        OFFICIAL_ROOTS_V3_PATH,
        OFFICIAL_ROOTS_V4_PATH,
        load_runtime_registry_roots_bytes,
        verify_runtime_registry_bytes,
    )
    from app.plugin_security_v2 import restricted_runtime_profile
    from scripts import plugin_platform_multi_runtime_phase6 as phase6

    roots3 = load_runtime_registry_roots_bytes(OFFICIAL_ROOTS_V3_PATH.read_bytes())
    roots4 = load_runtime_registry_roots_bytes(OFFICIAL_ROOTS_V4_PATH.read_bytes())
    revision3 = verify_runtime_registry_bytes(
        OFFICIAL_REGISTRY_V3_PATH.read_bytes(), roots3
    )
    revision4 = verify_runtime_registry_bytes(
        OFFICIAL_REGISTRY_V4_PATH.read_bytes(), roots4
    )
    node = next(
        item for item in revision4.runtimes if item.runtime_id == NODE_RUNTIME_ID
    )
    shape = type("RegistryShape", (), {"ensure": lambda *_args, **_kwargs: None})()
    registered = default_runtime_provider_registry(
        node_enabled=True, managed_runtime_registry=shape
    ).kinds
    sdk_package = _strict_json(NODE_SDK / "package.json")
    sdk_lock = _strict_json(NODE_SDK / "supply-chain.lock.json")
    reference_manifest = _strict_json(NODE_REFERENCE / "manifest.json")
    reference_lock = _strict_json(NODE_REFERENCE / "supply-chain.lock.json")
    runtime = reference_manifest["backend"]["entrypoints"][0]["runtime"]
    profile = restricted_runtime_profile("node-module")
    provider_source = (
        BACKEND_ROOT / "app" / "plugin_core_v2" / "runtime_providers" / "node.py"
    ).read_text(encoding="utf-8")
    installer_source = (
        BACKEND_ROOT / "app" / "plugin_installer_v2" / "installer.py"
    ).read_text(encoding="utf-8")
    return {
        "schemaVersion": CONTRACT_SCHEMA_VERSION,
        "implementedOn": "2026-08-03",
        "phase6ContractSha256": _canonical_sha256(phase6.validate_contract()),
        "runtimeRegistry": {
            "activeRegistryPath": OFFICIAL_REGISTRY_V4_PATH.name,
            "revision": revision4.revision,
            "previousRevision": revision3.revision,
            "previousRegistrySha256": revision4.previous_registry_sha256,
            "revision3Sha256": revision3.sha256,
            "registrySha256": revision4.sha256,
            "roots": len(roots4),
            "runtimeId": node.runtime_id,
            "kind": node.kind,
            "version": node.version,
            "archiveSha256": node.sha256,
            "archiveSize": node.size,
            "fileCount": node.file_count,
            "extractedSize": node.extracted_size,
            "legalFileCount": node.legal_file_count,
            "legalSize": node.legal_size,
            "licenseSpdx": node.license_spdx,
            "evidenceRoles": [item.role for item in node.evidence],
            "evidenceFiles": [item.file_name for item in node.evidence],
            "vendorSbomCompatibilitySlotIsLicenseInventory": True,
            "authenticodePublisher": "OpenJS Foundation",
        },
        "provider": {
            "kind": "node-module",
            "version": NODE_MODULE_PROVIDER_VERSION,
            "enabledKinds": list(registered),
            "enabledDefault": False,
            "managedRuntimeOnly": True,
            "esmOnly": True,
            "cjsSupported": False,
            "staticRelativeGraphOnly": True,
            "dynamicImport": False,
            "barePackageResolution": False,
            "packageManagerAtInstallOrRuntime": False,
            "lifecycleScripts": False,
            "globalSearchPaths": False,
            "permissionModel": True,
            "childProcesses": False,
            "workers": False,
            "maxProcesses": 1,
            "sourceMapPathsScrubbed": True,
            "fixedLaunchArguments": [
                "--permission",
                "--allow-fs-read=<installation>",
                "--no-addons",
                "--no-global-search-paths",
                "--disallow-code-generation-from-strings",
                "--preserve-symlinks",
                "--preserve-symlinks-main",
                "--disable-proto=throw",
                "--unhandled-rejections=strict",
            ],
            "sourceContainsNoPackageManagerInvocation": not any(
                value in provider_source
                for value in ("npm.exe", "npx.exe", "corepack.exe")
            ),
            "installerDelegatesNodeToProvider": "node_runtime_enabled"
            in installer_source,
        },
        "typescriptSdk": {
            "package": sdk_package["name"],
            "version": sdk_package["version"],
            "nodeEngine": sdk_package["engines"]["node"],
            "dependencies": [],
            "scripts": [],
            "tarballSha256": sdk_lock["tarball"]["sha256"],
            "tarballSize": sdk_lock["tarball"]["size"],
            "compiler": sdk_lock["compiler"],
            "pythonParityTranscriptSha256": sdk_lock["pythonParityTranscriptSha256"],
            "strictJsonl": True,
            "fullLifecycle": [
                "handshake",
                "describe",
                "activate",
                "invoke",
                "eventBatch",
                "healthCheck",
                "cancel",
                "prepareUpgrade",
                "deactivate",
                "shutdown",
            ],
            "stdoutIsolation": True,
        },
        "referencePlugin": {
            "pluginId": reference_manifest["plugin"]["id"],
            "version": reference_manifest["plugin"]["version"],
            "runtimeKind": runtime["kind"],
            "runtimeId": runtime["runtimeId"],
            "artifact": runtime["artifact"],
            "nodeArgs": runtime["nodeArgs"],
            "mainSha256": reference_lock["artifacts"]["main.mjs"]["sha256"],
            "sdkSha256": reference_lock["artifacts"]["sdk.mjs"]["sha256"],
            "sourceMapSha256": reference_lock["artifacts"]["main.mjs.map"]["sha256"],
            "transcriptSha256": reference_lock["transcriptSha256"],
            "packageManagerInvoked": reference_lock["packageManagerInvoked"],
            "lifecycleScripts": reference_lock["lifecycleScripts"],
            "offlineBundle": True,
        },
        "sandbox": {
            "profileId": profile.profile_id,
            "maxProcesses": profile.max_processes,
            "memoryLimitBytes": profile.memory_limit_bytes,
            "networkDefault": "denied",
            "nodePermissionModelAndAppContainer": True,
            "signedMarketplaceLifecycle": True,
        },
        "rollout": {
            "providerSeamFlag": RUNTIME_PROVIDER_SEAM_ENABLED_ENV,
            "multiRuntimeFlag": MULTI_RUNTIME_ENABLED_ENV,
            "nodeFlag": NODE_RUNTIME_ENABLED_ENV,
            "providerSeamDefault": False,
            "multiRuntimeDefault": False,
            "nodeDefault": False,
            "disablePreservesInstallations": True,
            "systemNodeFallback": False,
        },
    }


def validate_contract() -> dict[str, Any]:
    expected = _strict_json(CONTRACT_PATH)
    actual = capture_contract()
    if actual != expected:
        raise Phase7GateError("Phase 7 frozen contract differs from the implementation")
    return actual


class _LocalNodeEvidenceFetcher:
    def __init__(self, root: Path) -> None:
        _ensure_import_paths()
        from app.plugin_runtime_registry_v3 import (
            OFFICIAL_REGISTRY_V4_PATH,
            OFFICIAL_ROOTS_PATH,
            load_runtime_registry_roots_bytes,
            verify_runtime_registry_bytes,
        )

        self.root = root.resolve(strict=True)
        roots = load_runtime_registry_roots_bytes(OFFICIAL_ROOTS_PATH.read_bytes())
        registry = verify_runtime_registry_bytes(
            OFFICIAL_REGISTRY_V4_PATH.read_bytes(), roots
        )
        release = next(
            item for item in registry.runtimes if item.runtime_id == NODE_RUNTIME_ID
        )
        self.files = {release.url: release.url.rsplit("/", 1)[-1]}
        self.files.update({item.url: item.file_name for item in release.evidence})
        self.calls: list[str] = []

    def fetch(self, url: str, destination: Path, *, maximum: int) -> None:
        self.calls.append(url)
        name = self.files.get(url)
        if name is None:
            raise Phase7GateError(f"unexpected Node evidence URL: {url}")
        source = self.root / name
        if not source.is_file() or source.is_symlink():
            raise Phase7GateError(f"missing frozen Node evidence: {name}")
        payload = source.read_bytes()
        if len(payload) > maximum:
            raise Phase7GateError(f"frozen Node evidence exceeds signed size: {name}")
        destination.write_bytes(payload)


def _build_checks(node: Path) -> dict[str, Any]:
    tsc = REPOSITORY_ROOT / "frontend" / "node_modules" / "typescript" / "bin" / "tsc"
    type_roots = REPOSITORY_ROOT / "frontend" / "node_modules" / "@types"
    transcript = (
        REPOSITORY_ROOT
        / "packages"
        / "candlescope-plugin-sdk"
        / "tests"
        / "fixtures"
        / "hello_command_transcript_v2.json"
    )
    for path in (tsc, type_roots, transcript):
        path.resolve(strict=True)
    sdk = _run_checked(
        (
            sys.executable,
            str(NODE_SDK / "scripts" / "check.py"),
            "--node",
            str(node),
            "--tsc",
            str(tsc),
            "--type-roots",
            str(type_roots),
            "--python-transcript",
            str(transcript),
        ),
        timeout=180,
    )
    reference = _run_checked(
        (
            sys.executable,
            str(NODE_REFERENCE / "scripts" / "build_release.py"),
            "--node",
            str(node),
            "--tsc",
            str(tsc),
            "--type-roots",
            str(type_roots),
        ),
        timeout=180,
    )
    sdk_result = json.loads(sdk.stdout.decode("utf-8"))
    reference_result = json.loads(reference.stdout.decode("utf-8"))
    if sdk_result.get("result") != "pass":
        raise Phase7GateError("Node SDK package smoke did not pass")
    return {"sdk": sdk_result, "reference": reference_result}


def _authenticode(executable: Path) -> dict[str, str]:
    source = executable.resolve(strict=True)
    source_sha256 = _sha256_path(source)
    with tempfile.TemporaryDirectory(prefix="cs-node-sign-") as raw:
        signed_copy = Path(raw) / "node.exe"
        shutil.copyfile(source, signed_copy)
        if _sha256_path(signed_copy) != source_sha256:
            raise Phase7GateError("short-path Authenticode copy changed node.exe bytes")
        literal = str(signed_copy).replace("'", "''")
        script = (
            "Import-Module (Join-Path $PSHOME "
            "'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1') "
            "-ErrorAction Stop; "
            f"$s=Get-AuthenticodeSignature -LiteralPath '{literal}'; "
            "[ordered]@{status=[string]$s.Status; subject=[string]$s.SignerCertificate.Subject; "
            "thumbprint=[string]$s.SignerCertificate.Thumbprint} | ConvertTo-Json -Compress"
        )
        encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
        command = (
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            encoded,
        )
        completed = _run_checked(command, timeout=30)
        result = json.loads(completed.stdout.decode("utf-8-sig"))
    expected_thumbprint = "8EA1D142EA3F46023BACA38C23A7E7AE6AFCE30C"
    if (
        result.get("status") != "Valid"
        or "OpenJS Foundation" not in result.get("subject", "")
        or result.get("thumbprint") != expected_thumbprint
    ):
        raise Phase7GateError(
            "managed node.exe Authenticode identity changed: "
            f"{result}; stderr={completed.stderr[-2000:]!r}; script={script!r}"
        )
    return {**result, "sha256": source_sha256, "shortPathCopy": True}


def _process_exited(process_id: int) -> bool:
    if not process_id:
        return True
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    handle = kernel32.OpenProcess(0x00100000, False, process_id)
    if not handle:
        return True
    try:
        return kernel32.WaitForSingleObject(handle, 0) == 0
    finally:
        kernel32.CloseHandle(handle)


async def _wait_exited(process_id: int) -> bool:
    for _attempt in range(150):
        if _process_exited(process_id):
            return True
        await asyncio.sleep(0.02)
    return _process_exited(process_id)


async def _runtime_lifecycle(product_root: Path, registry: Any) -> dict[str, Any]:
    _ensure_import_paths()
    from app.plugin_core_v2.runtime import CorePluginPlatform

    platform = CorePluginPlatform(
        root=product_root,
        host_name="CandleScope",
        host_version="0.4.0",
        multi_runtime_enabled=True,
        runtime_provider_seam_enabled=True,
        node_runtime_enabled=True,
        managed_runtime_registry=registry,
    )
    await platform.start()
    process_id = 0
    result_digest = ""
    try:
        contribution = f"{NODE_PLUGIN_ID}.{NODE_CONTRIBUTION_ID}"
        first = await platform.invoke_command(
            contribution,
            {"name": "CandleScope"},
            user_action=True,
            trace_id="phase7-cold",
        )
        expected = {
            "message": "Hello from Node.js, CandleScope!",
            "contributionId": NODE_CONTRIBUTION_ID,
            "generation": 1,
        }
        if first != expected:
            raise Phase7GateError(
                f"real Node reference returned another result: {first}"
            )
        result_digest = _canonical_sha256(first)
        for index in range(50):
            result = await platform.invoke_command(
                contribution,
                {"name": "CandleScope"},
                user_action=True,
                trace_id=f"phase7-hot-{index}",
            )
            if _canonical_sha256(result) != result_digest:
                raise Phase7GateError("50-call Node result digest changed")
        supervisor = platform.manager.supervisor(NODE_PLUGIN_ID, "main")
        pending = asyncio.create_task(
            platform.invoke_command(
                contribution,
                {"name": "later", "defer": True},
                user_action=True,
                trace_id="phase7-cancel",
            )
        )
        for _attempt in range(100):
            health = await supervisor.health_check()
            if health.get("pending") == 1:
                break
            await asyncio.sleep(0.02)
        else:
            pending.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await pending
            raise Phase7GateError("Node deferred invocation did not become pending")
        pending.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await pending
        for _attempt in range(100):
            health = await supervisor.health_check()
            if health.get("pending") == 0:
                break
            await asyncio.sleep(0.02)
        else:
            raise Phase7GateError("Node cancellation left a pending SDK operation")
        snapshot = supervisor.snapshot()
        process_id = snapshot["transport"]["pid"]
        catalog = next(
            item
            for item in platform.catalog()["plugins"]
            if item["id"] == NODE_PLUGIN_ID
        )
        runtime = catalog["runtime"]["entrypoints"][0]
        if (
            runtime["runtimeKind"] != "node-module"
            or runtime["runtimeId"] != NODE_RUNTIME_ID
            or runtime["runtimeSupply"]["version"] != "24.19.0+LTS-Krypton"
            or runtime["runtimeSupply"]["verificationStatus"] != "verified"
            or not snapshot["transport"]["processTreeControl"]
        ):
            raise Phase7GateError(
                "Plugin Manager Node provenance or process control is incomplete"
            )
    finally:
        await platform.stop()
    if process_id and not await _wait_exited(process_id):
        raise Phase7GateError("Host stop left node.exe alive")
    if platform.manager.owner_keys():
        raise Phase7GateError("Host stop retained a Node supervisor")
    return {
        "calls": 51,
        "resultSha256": result_digest,
        "cancelled": True,
        "healthPending": 0,
        "runtimeKind": runtime["runtimeKind"],
        "runtimeId": runtime["runtimeId"],
        "runtimeVersion": runtime["runtimeSupply"]["version"],
        "verificationStatus": runtime["runtimeSupply"]["verificationStatus"],
        "processTreeControl": True,
        "residualProcesses": 0,
        "residualSupervisors": 0,
    }


async def _fault_matrix(root: Path, registry: Any) -> dict[str, str]:
    _ensure_import_paths()
    from candlescope_plugin_sdk.platform_v2 import NodeModuleRuntime, PluginManifest
    from app.plugin_core_v2.runtime_providers import NodeModuleProvider
    from app.plugin_host import (
        EntrypointProcessSpec,
        EntrypointSupervisor,
        PlatformHostTransportError,
    )

    expected = {
        "crash": "PLUGIN_PLATFORM_EXITED",
        "hang": "PLUGIN_PLATFORM_TIMEOUT",
        "oom": "PLUGIN_PLATFORM_EXITED",
        "stderr": "PLUGIN_PLATFORM_STDERR_LIMIT_EXCEEDED",
    }
    sources = {
        "crash": "process.exit(41);\n",
        "hang": "setInterval(() => {}, 1000); await new Promise(() => {});\n",
        "oom": "const values=[]; while(true){ values.push(new Array(1000000).fill('oom')); }\n",
        "stderr": "process.stderr.write('x'.repeat(16384)); await new Promise(() => {});\n",
    }
    base_manifest = _strict_json(NODE_REFERENCE / "manifest.json")
    observed: dict[str, str] = {}
    provider = NodeModuleProvider(registry)
    for mode, source in sources.items():
        installation = root / mode
        main = installation / "content" / "runtime" / "fault.mjs"
        main.parent.mkdir(parents=True)
        main.write_text(source, encoding="utf-8", newline="\n")
        runtime = NodeModuleRuntime(
            artifact="runtime/fault.mjs",
            runtime_id=NODE_RUNTIME_ID,
            node_args=("--max-old-space-size=64",),
        )
        prepared = provider.prepare_runtime(
            runtime=runtime,
            executable=main,
            working_directory=installation,
            artifact_sha256=_sha256_path(main),
        )
        launch = provider.build_runtime_launch(prepared)
        manifest_value = json.loads(json.dumps(base_manifest))
        manifest_value["backend"]["entrypoints"][0]["runtime"] = runtime.to_wire()
        manifest_value["probes"] = []
        manifest = PluginManifest.from_wire(manifest_value)
        supervisor = EntrypointSupervisor(
            EntrypointProcessSpec(
                plugin_id=NODE_PLUGIN_ID,
                entrypoint_id="main",
                executable=launch.executable,
                arguments=launch.arguments,
                working_directory=launch.working_directory,
                startup_timeout_seconds=0.5,
                request_timeout_seconds=0.3,
                shutdown_timeout_seconds=0.3,
                max_restart_attempts=0,
                max_stderr_bytes=4096,
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
                raise Phase7GateError(f"Node fault {mode} unexpectedly handshook")
        finally:
            await supervisor.stop()
        if observed.get(mode) != expected[mode]:
            raise Phase7GateError(
                f"Node fault {mode} diagnostic changed: {observed.get(mode)} != {expected[mode]}"
            )
    return observed


def _permission_model_probe(root: Path, registry: Any) -> dict[str, Any]:
    _ensure_import_paths()
    from candlescope_plugin_sdk.platform_v2 import NodeModuleRuntime, loads_strict
    from app.plugin_core_v2.runtime_providers import NodeModuleProvider

    installation = root / "installation"
    main = installation / "content" / "runtime" / "permission.mjs"
    main.parent.mkdir(parents=True)
    main.write_text(
        'import { spawnSync } from "node:child_process";\n'
        'import { Worker } from "node:worker_threads";\n'
        "let childDenied=false; try { const r=spawnSync(process.execPath,['--version']); "
        "childDenied=r.error?.code==='ERR_ACCESS_DENIED'||r.status===null; } "
        "catch(e){childDenied=e?.code==='ERR_ACCESS_DENIED';}\n"
        "let workerDenied=false; try { const w=new Worker('process.exit(0)',{eval:true}); "
        "await w.terminate(); } catch(e){workerDenied=e?.code==='ERR_ACCESS_DENIED';}\n"
        "process.stdout.write(JSON.stringify({childDenied,workerDenied})+'\\n');\n",
        encoding="utf-8",
        newline="\n",
    )
    provider = NodeModuleProvider(registry)
    runtime = NodeModuleRuntime(
        artifact="runtime/permission.mjs", runtime_id=NODE_RUNTIME_ID
    )
    prepared = provider.prepare_runtime(
        runtime=runtime,
        executable=main,
        working_directory=installation,
        artifact_sha256=_sha256_path(main),
    )
    launch = provider.build_runtime_launch(prepared)
    completed = _run_checked(
        (str(launch.executable), *launch.arguments),
        cwd=launch.working_directory,
        timeout=30,
    )
    result = loads_strict(completed.stdout)
    if result != {"childDenied": True, "workerDenied": True}:
        raise Phase7GateError(f"Node Permission Model widened: {result}")
    return {
        **result,
        "maxProcesses": launch.max_processes,
        "isolatedSearchPath": launch.isolated_search_path,
        "stderrBytes": len(completed.stderr),
    }


def _sandbox_attack(root: Path, ensured: Any) -> dict[str, Any]:
    _ensure_import_paths()
    from scripts import plugin_platform_multi_runtime_phase6 as phase6

    installation = root / "installation"
    installation.mkdir(parents=True)
    script = installation / SANDBOX_PROBE.name
    shutil.copyfile(SANDBOX_PROBE, script)
    executable = Path(ensured.executable).resolve(strict=True)

    def command(port: int, private_file: Path) -> tuple[str, ...]:
        return (
            str(executable),
            "--permission",
            f"--allow-fs-read={installation}",
            f"--allow-fs-write={private_file.parent}",
            "--no-addons",
            "--no-global-search-paths",
            "--disallow-code-generation-from-strings",
            "--preserve-symlinks",
            "--preserve-symlinks-main",
            "--disable-proto=throw",
            "--unhandled-rejections=strict",
            "--max-old-space-size=128",
            str(script),
            str(root / "outside-secret.txt"),
            str(BACKEND_ROOT / "app" / "main.py"),
            str(installation / "must-not-write.txt"),
            str(private_file),
            str(port),
        )

    return phase6._execute_attack(
        root=root,
        runtime_kind="node-module",
        installation=installation,
        executable=executable,
        additional_read_only_paths=(Path(ensured.root).resolve(strict=True),),
        command_factory=command,
    )


async def _signed_marketplace_lifecycle(root: Path, registry: Any) -> dict[str, Any]:
    _ensure_import_paths()
    from app.plugin_core_v2.runtime import CorePluginPlatform
    from app.plugin_security_v2 import delete_appcontainer_profile
    from tests.plugin_marketplace_testkit import (
        MARKETPLACE_ID,
        SignedMarketplaceBuilder,
    )
    from tests.plugin_platform_node_testkit import build_node_reference_bundle

    fixture = build_node_reference_bundle(root / "bundle")
    builder = SignedMarketplaceBuilder.create()
    builder.add_release(
        fixture.bundle,
        dependencies=(
            {
                "name": "plugin-sdk-node",
                "version": "0.1.0",
                "licenseExpression": "GPL-3.0-only",
            },
        ),
    )
    platform = CorePluginPlatform(
        root=root / "product",
        host_name="CandleScope",
        host_version="0.4.0",
        marketplace_enabled=True,
        marketplace_roots=(builder.root,),
        trust_ux_enabled=True,
        multi_runtime_enabled=True,
        runtime_provider_seam_enabled=True,
        node_runtime_enabled=True,
        managed_runtime_registry=registry,
    )
    platform.marketplace.import_index(
        builder.index_bytes(), marketplace_id=MARKETPLACE_ID
    )
    profiles: list[str] = []
    process_ids: list[int] = []
    result: dict[str, Any] = {}
    await platform.start()
    try:
        bundle = fixture.bundle
        platform.marketplace.prepare(
            NODE_PLUGIN_ID,
            version=bundle.manifest.plugin.version,
            artifact_bytes=bundle.path.read_bytes(),
        )
        platform.marketplace.apply(NODE_PLUGIN_ID)
        platform.marketplace.begin_activation(NODE_PLUGIN_ID)
        await platform.reconcile_plugin(NODE_PLUGIN_ID)
        health = await platform.observe_plugin_health(NODE_PLUGIN_ID)
        invoke = await platform.invoke_command(
            f"{NODE_PLUGIN_ID}.{NODE_CONTRIBUTION_ID}",
            {"name": "Marketplace"},
            user_action=True,
            trace_id="phase7-marketplace",
        )
        platform.marketplace.finish_observation(
            NODE_PLUGIN_ID,
            healthy=True,
            detail="Phase 7 signed Node AppContainer gate passed",
        )
        supervisor = await platform._ensure_active(NODE_PLUGIN_ID, "main")
        snapshot = supervisor.snapshot()
        policy = supervisor.spec.sandbox_policy
        if policy is None:
            raise Phase7GateError(
                "signed Node Marketplace runtime has no sandbox policy"
            )
        profiles.append(policy.profile_name)
        process_ids.append(snapshot["transport"]["pid"])
        configs = sorted(policy.runtime_directory.glob("launch-*/config.json"))
        if not configs:
            raise Phase7GateError(
                "signed Node Marketplace runtime has no launch evidence"
            )
        config = _strict_json(configs[-1])
        detail = platform.management_detail(NODE_PLUGIN_ID)
        trust = detail.get("trust")
        runtime = detail["plugin"]["runtime"]["entrypoints"][0]
        if (
            supervisor.spec.trust_level != "untrusted"
            or snapshot["state"] != "active"
            or not snapshot["transport"]["processTreeControl"]
            or not isinstance(trust, dict)
            or trust.get("mode") != "marketplace-sandboxed"
            or trust.get("authorization", {}).get("sandbox", {}).get("status")
            != "windows-appcontainer"
            or not config["appContainerSid"].startswith("S-1-15-2-")
            or config["limits"]["activeProcesses"] != 1
            or runtime["runtimeKind"] != "node-module"
            or invoke.get("message") != "Hello from Node.js, Marketplace!"
        ):
            raise Phase7GateError(
                "signed Node Marketplace lifecycle evidence is incomplete"
            )
        result = {
            "pluginId": NODE_PLUGIN_ID,
            "trustMode": trust["mode"],
            "sandboxStatus": trust["authorization"]["sandbox"]["status"],
            "runtimeKind": runtime["runtimeKind"],
            "runtimeId": runtime["runtimeId"],
            "appContainerSidPresent": True,
            "activeProcessLimit": config["limits"]["activeProcesses"],
            "healthEntrypoints": len(health),
            "processTreeControl": True,
            "invokeSha256": _canonical_sha256(invoke),
        }
    finally:
        await platform.stop()
        for profile in profiles:
            delete_appcontainer_profile(profile)
    residual = [pid for pid in process_ids if not await _wait_exited(pid)]
    if residual or platform.manager.owner_keys():
        raise Phase7GateError(
            f"signed Node lifecycle left residual processes: {residual}"
        )
    return {**result, "residualProcesses": 0, "residualSupervisors": 0}


def _fresh_runtime_probe(runtime_root: Path) -> dict[str, Any]:
    _ensure_import_paths()
    from app.plugin_runtime_registry_v3 import build_official_runtime_registry

    registry = build_official_runtime_registry(
        root=runtime_root, enabled=True, network_updates_enabled=False
    )
    ensured = registry.ensure(NODE_RUNTIME_ID, "node", offline=True)
    return {
        "runtimeId": ensured.release.runtime_id,
        "quickRepeat": ensured.quick_repeat,
        "probeSha256": ensured.probe.sha256,
        "executableSha256": _sha256_path(ensured.executable),
    }


async def _real_gate_async(root: Path, evidence_directory: Path) -> dict[str, Any]:
    _ensure_import_paths()
    from app.plugin_core_v2.runtime import CorePluginPlatform
    from app.plugin_installer_v2.installer import PlatformPluginInstaller
    from app.plugin_installer_v2.registry import load_activation_registry
    from app.plugin_runtime_registry_v3 import (
        OFFICIAL_REGISTRY_V4_PATH,
        RuntimeRegistryError,
        build_official_runtime_registry,
    )
    from tests.plugin_platform_node_testkit import build_node_reference_bundle

    fetcher = _LocalNodeEvidenceFetcher(evidence_directory)
    runtime_root = root / "managed-runtimes"
    registry = build_official_runtime_registry(
        root=runtime_root,
        enabled=True,
        network_updates_enabled=False,
        fetcher=fetcher,
    )
    first = registry.ensure(NODE_RUNTIME_ID, "node")
    repeat = registry.ensure(NODE_RUNTIME_ID, "node")
    offline = registry.ensure(NODE_RUNTIME_ID, "node", offline=True)
    if (
        first.quick_repeat
        or not repeat.quick_repeat
        or not offline.quick_repeat
        or len(fetcher.calls) != 5
    ):
        raise Phase7GateError("real Node first/repeat/offline semantics changed")
    authenticode = _authenticode(first.executable)
    missing = build_official_runtime_registry(
        root=root / "offline-missing", enabled=True, network_updates_enabled=False
    )
    try:
        missing.ensure(NODE_RUNTIME_ID, "node", offline=True)
    except RuntimeRegistryError as exc:
        offline_missing_code = exc.code
    else:
        raise Phase7GateError("offline missing Node cache unexpectedly used a fallback")
    fresh = _run_checked(
        (
            sys.executable,
            str(Path(__file__).resolve()),
            "--fresh-runtime-probe",
            str(runtime_root),
        ),
        timeout=120,
    )
    fresh_result = json.loads(fresh.stdout.decode("utf-8"))
    if not fresh_result.get("quickRepeat"):
        raise Phase7GateError("fresh process did not reuse the verified Node cache")
    build = _build_checks(first.executable)
    npm_sentinel = root / "npm-global-cache" / "must-remain.txt"
    npm_sentinel.parent.mkdir()
    npm_sentinel.write_text("untouched\n", encoding="utf-8", newline="\n")
    sentinel_before = _sha256_path(npm_sentinel)

    initial = build_node_reference_bundle(root / "bundle-initial")
    product = root / "product"
    installer = PlatformPluginInstaller(
        root=product,
        multi_runtime_enabled=True,
        runtime_provider_seam_enabled=True,
        node_runtime_enabled=True,
        managed_runtime_registry=registry,
    )
    installed = installer.install(
        initial.bundle.path, expected_sha256=initial.bundle.sha256, enabled=True
    )
    enabled = installer.enable(NODE_PLUGIN_ID)
    repeated = installer.install(
        initial.bundle.path, expected_sha256=initial.bundle.sha256, enabled=True
    )
    checked = installer.check(NODE_PLUGIN_ID)
    if (
        enabled.state != "active"
        or not repeated.reused_installation
        or checked.state != "active"
    ):
        raise Phase7GateError("Node fresh install/quick repeat/check did not converge")
    updated = build_node_reference_bundle(
        root / "bundle-update", update_marker="phase7-update-1"
    )
    update_result = installer.install(
        updated.bundle.path, expected_sha256=updated.bundle.sha256, enabled=True
    )
    rollback = installer.rollback(NODE_PLUGIN_ID)
    record = load_activation_registry(installer.registry_path).by_id()[NODE_PLUGIN_ID]
    if (
        update_result.state != "active"
        or record.bundle_sha256 != initial.bundle.sha256
        or record.installation_id != installed.installation_id
    ):
        raise Phase7GateError(
            "Node update/rollback did not restore the initial activation"
        )

    lifecycle = await _runtime_lifecycle(product, registry)
    permission_model = _permission_model_probe(root / "permission-model", registry)
    faults = await _fault_matrix(root / "faults", registry)
    sandbox = _sandbox_attack(root / "sandbox", first)
    marketplace = await _signed_marketplace_lifecycle(root / "marketplace", registry)

    disabled_platform = CorePluginPlatform(
        root=product,
        host_name="CandleScope",
        host_version="0.4.0",
        multi_runtime_enabled=True,
        runtime_provider_seam_enabled=True,
        node_runtime_enabled=False,
        managed_runtime_registry=registry,
    )
    await disabled_platform.start()
    try:
        catalog = next(
            item
            for item in disabled_platform.catalog()["plugins"]
            if item["id"] == NODE_PLUGIN_ID
        )
        if catalog["available"] or disabled_platform.manager.owner_keys():
            raise Phase7GateError("disabled Node Provider found a system fallback")
        disabled = {
            "available": False,
            "reason": catalog["unavailableReason"],
            "supervisors": 0,
            "installationPreserved": True,
        }
    finally:
        await disabled_platform.stop()

    rolled = registry.rollback_registry()
    try:
        registry.ensure(NODE_RUNTIME_ID, "node", offline=True)
    except RuntimeRegistryError as exc:
        rollback_unavailable_code = exc.code
    else:
        raise Phase7GateError("Registry rollback unexpectedly retained Node 24")
    restored = registry.activate_registry(OFFICIAL_REGISTRY_V4_PATH.read_bytes())
    registry.ensure(NODE_RUNTIME_ID, "node", offline=True)
    sentinel_after = _sha256_path(npm_sentinel)
    if sentinel_after != sentinel_before or tuple(npm_sentinel.parent.iterdir()) != (
        npm_sentinel,
    ):
        raise Phase7GateError(
            "Node install or runtime touched the global npm cache sentinel"
        )

    contract = capture_contract()
    runtime_supply = record.entrypoints[0].runtime_supply.to_wire()
    runtime_supply["executable"] = "<managed-runtime-cache>/node.exe"
    return {
        "schemaVersion": REAL_GATE_SCHEMA_VERSION,
        "generatedAt": "2026-08-03T18:00:00Z",
        "result": "pass",
        "contractSha256": _canonical_sha256(contract),
        "build": build,
        "node": {
            "runtimeId": first.release.runtime_id,
            "version": first.release.version,
            "archiveSha256": first.release.sha256,
            "authenticode": authenticode,
            "firstDownloadedFiles": first.downloaded_files,
            "repeatQuick": repeat.quick_repeat,
            "offlineQuick": offline.quick_repeat,
            "offlineMissingCode": offline_missing_code,
            "freshProcess": fresh_result,
            "downloadUrls": fetcher.calls,
            "probeSha256": first.probe.sha256,
            "fileCount": first.release.file_count,
            "extractedSize": first.release.extracted_size,
            "legalFileCount": first.release.legal_file_count,
            "legalSize": first.release.legal_size,
            "evidence": [item.to_wire() for item in first.release.evidence],
        },
        "installation": {
            "bundleSha256": initial.bundle.sha256,
            "receiptSchema": 4,
            "state": checked.state,
            "freshProcessProbe": checked.probe["semanticProbes"][0]["sha256"],
            "quickRepeat": repeated.reused_installation,
            "runtimeSupply": runtime_supply,
            "updateBundleSha256": updated.bundle.sha256,
            "updateState": update_result.state,
            "rollbackBundleSha256": record.bundle_sha256,
            "rollbackRemoved": rollback.removed,
            "packageManagerInvoked": False,
            "lifecycleScripts": False,
            "globalNpmCacheUntouched": True,
        },
        "runtime": lifecycle,
        "faults": faults,
        "permissionModel": permission_model,
        "sandbox": sandbox,
        "marketplace": marketplace,
        "disabled": disabled,
        "registryRollback": {
            "toRevision": rolled["toRevision"],
            "nodeUnavailableCode": rollback_unavailable_code,
            "restoredRevision": restored["revision"],
        },
        "defaults": {
            "providerSeamEnabled": False,
            "multiRuntimeEnabled": False,
            "nodeRuntimeEnabled": False,
        },
    }


def run_real_gate(evidence_directory: Path) -> dict[str, Any]:
    if os.name != "nt":
        raise Phase7GateError("Phase 7 real Node release gate requires Windows")
    with tempfile.TemporaryDirectory(prefix="candlescope-phase7-real-") as value:
        return asyncio.run(
            _real_gate_async(Path(value), evidence_directory.resolve(strict=True))
        )


def validate_real_gate_evidence() -> dict[str, Any]:
    evidence = _strict_json(REAL_EVIDENCE_PATH)
    contract = validate_contract()
    if (
        evidence.get("schemaVersion") != REAL_GATE_SCHEMA_VERSION
        or evidence.get("result") != "pass"
        or evidence.get("contractSha256") != _canonical_sha256(contract)
        or evidence.get("faults")
        != {
            "crash": "PLUGIN_PLATFORM_EXITED",
            "hang": "PLUGIN_PLATFORM_TIMEOUT",
            "oom": "PLUGIN_PLATFORM_EXITED",
            "stderr": "PLUGIN_PLATFORM_STDERR_LIMIT_EXCEEDED",
        }
        or evidence.get("permissionModel", {}).get("childDenied") is not True
        or evidence.get("permissionModel", {}).get("workerDenied") is not True
        or evidence.get("installation", {}).get("globalNpmCacheUntouched") is not True
        or evidence.get("marketplace", {}).get("sandboxStatus")
        != "windows-appcontainer"
        or evidence.get("runtime", {}).get("residualProcesses") != 0
        or evidence.get("defaults")
        != {
            "providerSeamEnabled": False,
            "multiRuntimeEnabled": False,
            "nodeRuntimeEnabled": False,
        }
    ):
        raise Phase7GateError(
            "recorded Phase 7 real Node gate is missing, failed, or stale"
        )
    return evidence


def run_gate() -> dict[str, Any]:
    contract = validate_contract()
    evidence = validate_real_gate_evidence()
    return {
        "schemaVersion": GATE_SCHEMA_VERSION,
        "result": "pass",
        "contractSha256": _canonical_sha256(contract),
        "realEvidenceSha256": _sha256_path(REAL_EVIDENCE_PATH),
        "runtimeId": evidence["node"]["runtimeId"],
        "sdkTarballSha256": evidence["build"]["sdk"]["tarballSha256"],
        "referenceTranscriptSha256": evidence["build"]["reference"]["transcriptSha256"],
        "faults": evidence["faults"],
        "signedMarketplaceSandbox": evidence["marketplace"]["sandboxStatus"],
        "defaultsRemainOff": True,
    }


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        + "\n",
        encoding="utf-8",
        newline="\n",
    )
    os.replace(temporary, path)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--print-contract", action="store_true")
    parser.add_argument("--run-real", action="store_true")
    parser.add_argument("--node-evidence", type=Path)
    parser.add_argument("--fresh-runtime-probe", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    modes = sum(
        bool(item)
        for item in (args.print_contract, args.run_real, args.fresh_runtime_probe)
    )
    if modes > 1:
        parser.error("choose one execution mode")
    if args.print_contract:
        value = capture_contract()
    elif args.run_real:
        if args.node_evidence is None:
            parser.error("--run-real requires --node-evidence")
        value = run_real_gate(args.node_evidence)
    elif args.fresh_runtime_probe is not None:
        value = _fresh_runtime_probe(args.fresh_runtime_probe.resolve(strict=True))
    else:
        value = run_gate()
    if args.output is not None:
        _atomic_json(args.output, value)
    print(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
