"""Phase 6 trust UX, runtime-bound grants, and per-kind Windows sandbox gate."""

from __future__ import annotations

import argparse
import asyncio
import ctypes
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Any, Callable, Sequence


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = REPOSITORY_ROOT / "backend"
SDK_SOURCE = REPOSITORY_ROOT / "packages" / "candlescope-plugin-sdk" / "src"
FIXTURE_ROOT = BACKEND_ROOT / "tests" / "fixtures" / "plugin_platform_multi_runtime"
CONTRACT_PATH = FIXTURE_ROOT / "phase6_contract_v2.json"
HISTORICAL_CONTRACT_PATH = FIXTURE_ROOT / "phase6_contract_v1.json"
HISTORICAL_CONTRACT_FILE_SHA256 = (
    "c9b5e173a6f7a2fc42741b5a39c9c64f4cd5ee23ffdb1807b857091bb165dc90"
)
PYTHON_PROBE = FIXTURE_ROOT / "phase6_python_sandbox_probe.py"
JAVA_PROBE = FIXTURE_ROOT / "Phase6JavaSandboxProbe.java"
NATIVE_PROBE = (
    BACKEND_ROOT
    / "tests"
    / "fixtures"
    / "plugin_platform_v2"
    / "windows_malicious_probe.c"
)
REAL_EVIDENCE_PATH = (
    REPOSITORY_ROOT
    / "docs"
    / "perf-baselines"
    / "plugin-platform-v2"
    / "multi-runtime-phase6-2026-08-03-windows-amd64.json"
)
CONTRACT_SCHEMA_VERSION = "candlescope.plugin-platform.multi-runtime.phase6-contract/2"
HISTORICAL_CONTRACT_SCHEMA_VERSION = (
    "candlescope.plugin-platform.multi-runtime.phase6-contract/1"
)
REAL_GATE_SCHEMA_VERSION = (
    "candlescope.plugin-platform.multi-runtime.phase6-real-gate/1"
)
GATE_SCHEMA_VERSION = "candlescope.plugin-platform.multi-runtime.phase6-gate/1"
JAVA_RUNTIME_ID = "temurin-26.0.2.10"
EXPECTED_ATTACK_RESULT = {
    "childProcessDenied": True,
    "externalDenied": True,
    "installationWrite": False,
    "loopbackDenied": True,
    "privateWrite": True,
    "secretRead": False,
    "sourceRead": False,
}


class Phase6GateError(RuntimeError):
    """The reviewed Phase 6 trust or sandbox boundary drifted."""


def _ensure_import_paths() -> None:
    scripts_dir = str(Path(__file__).resolve().parent)
    if scripts_dir not in sys.path:
        sys.path.insert(0, scripts_dir)
    from plugin_sdk_isolation import pin_in_repo_plugin_sdk

    pin_in_repo_plugin_sdk(BACKEND_ROOT)


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
        raise Phase6GateError(f"{path} must contain a strict JSON object")
    return value


def _canonical_sha256(value: Any) -> str:
    _ensure_import_paths()
    from candlescope_plugin_sdk.platform_v2 import canonical_sha256

    return canonical_sha256(value)


def capture_contract() -> dict[str, Any]:
    _ensure_import_paths()
    from app.plugin_core_v2.bootstrap import (
        PLUGIN_PLATFORM_V2_LIVE_ACCOUNT_READONLY_ENV,
        PLUGIN_PLATFORM_V2_LIVE_BROKER_FOUNDATION_ENV,
        PLUGIN_PLATFORM_V2_LIVE_NATIVE_CONTROL_ENV,
        PLUGIN_PLATFORM_V2_LIVE_RECONCILIATION_SHADOW_ENV,
        PLUGIN_PLATFORM_V2_LIVE_TESTNET_EXECUTION_ENV,
    )
    from app.plugin_core_v2.runtime_providers import default_runtime_provider_registry
    from app.plugin_installer_v2.installer import (
        JAVA_RUNTIME_ENABLED_ENV,
        MULTI_RUNTIME_ENABLED_ENV,
        NATIVE_RUNTIME_ENABLED_ENV,
        RUNTIME_PROVIDER_SEAM_ENABLED_ENV,
    )
    from app.plugin_runtime_registry_v3 import (
        OFFICIAL_REGISTRY_V2_PATH,
        OFFICIAL_REGISTRY_V3_PATH,
        OFFICIAL_ROOTS_V3_PATH,
        load_runtime_registry_roots_bytes,
        verify_runtime_registry_bytes,
    )
    from app.plugin_security_v2 import (
        CANONICAL_TRUST_MODES,
        TRUST_ALIASES,
        TRUST_UX_ENABLED_ENV,
        restricted_runtime_profiles_status,
    )
    from app.plugin_security_v2.grants import (
        GRANT_STORE_SCHEMA_VERSION,
        RUNTIME_BOUND_GRANT_STORE_SCHEMA_VERSION,
        UNAVAILABLE_HIGH_RISK_PERMISSIONS,
    )
    from app.plugin_security_v2.trust import (
        TRUST_PREVIEW_SCHEMA_VERSION,
        TRUST_STATE_SCHEMA_VERSION,
    )
    from scripts import plugin_platform_multi_runtime_phase5 as phase5

    phase5_contract = phase5.validate_contract()
    roots = load_runtime_registry_roots_bytes(OFFICIAL_ROOTS_V3_PATH.read_bytes())
    revision_2 = verify_runtime_registry_bytes(
        OFFICIAL_REGISTRY_V2_PATH.read_bytes(), roots
    )
    revision_3 = verify_runtime_registry_bytes(
        OFFICIAL_REGISTRY_V3_PATH.read_bytes(), roots
    )
    java_release = next(
        item for item in revision_3.runtimes if item.runtime_id == JAVA_RUNTIME_ID
    )
    ta4j_root = REPOSITORY_ROOT / "examples" / "plugins" / "ta4j-elliott-adapter"
    ta4j_manifest = _strict_json(ta4j_root / "manifest.json")
    ta4j_lock = _strict_json(ta4j_root / "supply-chain.lock.json")
    registry_shape = type(
        "RegistryShape", (), {"ensure": lambda *_args, **_kwargs: None}
    )()
    registered = default_runtime_provider_registry(
        native_enabled=True,
        java_enabled=True,
        managed_runtime_registry=registry_shape,
    ).kinds
    trust_source = (BACKEND_ROOT / "app" / "plugin_security_v2" / "trust.py").read_text(
        encoding="utf-8"
    )
    api_source = (BACKEND_ROOT / "app" / "plugin_core_v2" / "api.py").read_text(
        encoding="utf-8"
    )
    management_source = (
        BACKEND_ROOT / "app" / "plugin_security_v2" / "management.py"
    ).read_text(encoding="utf-8")
    runtime_source = (BACKEND_ROOT / "app" / "plugin_core_v2" / "runtime.py").read_text(
        encoding="utf-8"
    )
    supervisor_removal = runtime_source.find(
        "await self.manager.remove_plugin(plugin_id)"
    )
    grant_reconcile = runtime_source.find(
        "self.grant_store.reconcile", supervisor_removal
    )
    ui_path = REPOSITORY_ROOT / "frontend" / "src" / "features" / "plugins"
    surface_source = (ui_path / "PluginPlatformSurfaces.tsx").read_text(
        encoding="utf-8"
    )
    parser_source = (ui_path / "pluginPlatformParsers.ts").read_text(encoding="utf-8")
    english_catalog_source = (
        REPOSITORY_ROOT / "frontend" / "src" / "i18n" / "catalogs" / "en.ts"
    ).read_text(encoding="utf-8")
    chinese_catalog_source = (
        REPOSITORY_ROOT / "frontend" / "src" / "i18n" / "catalogs" / "zh-CN.ts"
    ).read_text(encoding="utf-8")
    return {
        "schemaVersion": CONTRACT_SCHEMA_VERSION,
        "implementedOn": "2026-08-03",
        "migratedOn": "2026-08-26",
        "previousContractSha256": "sha256:" + HISTORICAL_CONTRACT_FILE_SHA256,
        "phase5ContractSha256": _canonical_sha256(phase5_contract),
        # The recorded Windows AppContainer run predates the UI-only i18n
        # migration. Bind it to the immutable contract it actually exercised.
        "realGateEvidenceContractSha256": _canonical_sha256(
            _strict_json(HISTORICAL_CONTRACT_PATH)
        ),
        "trust": {
            "aliases": {key: TRUST_ALIASES[key] for key in sorted(TRUST_ALIASES)},
            "canonicalModes": sorted(CANONICAL_TRUST_MODES),
            "stateSchemaVersion": TRUST_STATE_SCHEMA_VERSION,
            "previewSchemaVersion": TRUST_PREVIEW_SCHEMA_VERSION,
            "localMode": "trusted-local",
            "marketplaceDefaultMode": "marketplace-sandboxed",
            "itemizedAcknowledgements": "requiredAcknowledgements" in trust_source,
            "distinctUserActions": "reviewUserActionId" in trust_source,
            "singleUseTokens": "tokenSha256" in trust_source,
            "immutableCandidateDigest": "bundleSha256" in trust_source,
            "auditWhoWhenWhy": all(
                value in trust_source
                for value in ('"actor"', '"reason"', '"updatedAt"')
            ),
        },
        "grantStore": {
            "legacySchemaVersion": GRANT_STORE_SCHEMA_VERSION,
            "runtimeBoundSchemaVersion": RUNTIME_BOUND_GRANT_STORE_SCHEMA_VERSION,
            "bindingInputs": [
                "bundleSha256",
                "manifestSha256",
                "publisherIdentity",
                "authorizationIdentity",
            ],
            "exactLegacyMigration": True,
            "runtimePublisherSignatureAndPathChangeRevokeInheritance": True,
            "unavailableHighRiskPermissions": sorted(UNAVAILABLE_HIGH_RISK_PERMISSIONS),
        },
        "runtimeRegistryMigration": {
            "activeRegistryPath": OFFICIAL_REGISTRY_V3_PATH.name,
            "revision": revision_3.revision,
            "previousRevision": revision_2.revision,
            "previousRegistrySha256": revision_3.previous_registry_sha256,
            "revision2Sha256": revision_2.sha256,
            "roots": len(roots),
            "runtimeId": java_release.runtime_id,
            "version": java_release.version,
            "archiveSha256": java_release.sha256,
            "archiveSize": java_release.size,
            "fileCount": java_release.file_count,
            "extractedSize": java_release.extracted_size,
            "legalFileCount": java_release.legal_file_count,
            "legalSize": java_release.legal_size,
            "retainsTemurin25ForRollback": any(
                item.runtime_id == "temurin-25.0.4.7" for item in revision_3.runtimes
            ),
            "appContainerCompatibilityIssue": "JDK-8352728",
        },
        "ta4jRuntimeMigration": {
            "pluginVersion": ta4j_manifest["plugin"]["version"],
            "adapterVersion": ta4j_lock["adapter"]["version"],
            "adapterJarSha256": ta4j_lock["adapter"]["releaseJarSha256"],
            "runtimeId": ta4j_manifest["backend"]["entrypoints"][0]["runtime"][
                "runtimeId"
            ],
            "runtimeLockMatchesManifest": (
                ta4j_lock["runtime"]["runtimeId"]
                == ta4j_manifest["backend"]["entrypoints"][0]["runtime"]["runtimeId"]
            ),
            "adapterJarReused": True,
        },
        "sandbox": {
            "windowsProfiles": list(
                restricted_runtime_profiles_status(platform_name="windows")
            ),
            "unsupportedPlatformProfiles": list(
                restricted_runtime_profiles_status(platform_name="linux")
            ),
            "providerExecutableKinds": list(registered),
            "phase6AttackKinds": [
                "java-jar",
                "native-executable",
                "python-module",
            ],
            "signedMarketplaceLifecycleKinds": ["python-module"],
            "multiRuntimeMarketplaceDistributionPhase": 10,
            "profileOnlyKinds": ["node-module"],
            "wasmProfileDeferredToPhase8": True,
            "windowsMode": "windows-appcontainer",
            "networkDefault": "denied",
            "declaredProcessModel": False,
        },
        "managementApi": {
            "localInstallPaths": [
                "/api/v2/plugins/manage/install/prepare",
                "/api/v2/plugins/manage/install/review",
                "/api/v2/plugins/manage/install/confirm",
            ],
            "trustChangePaths": [
                "/api/v2/plugins/manage/{plugin_id}/trust/review",
                "/api/v2/plugins/manage/{plugin_id}/trust/confirm",
            ],
            "exactOrigin": "management Origin denied" in management_source,
            "csrf": (
                "management CSRF denied" in management_source
                and "_guarded_platform(request)" in api_source
            ),
            "userAction": "plugin_user_action" in management_source,
            "marketplaceCannotUseUnsignedFlow": (
                "PLUGIN_MARKETPLACE_TRUST_DOWNGRADE_DENIED" in runtime_source
            ),
            "trustChangeStopsOldSupervisorFirst": (
                supervisor_removal >= 0 and grant_reconcile > supervisor_removal
            ),
        },
        "ui": {
            "surfaceSha256": _sha256_bytes(surface_source.encode("utf-8")),
            "parserSha256": _sha256_bytes(parser_source.encode("utf-8")),
            "englishCatalogSha256": _sha256_bytes(
                english_catalog_source.encode("utf-8")
            ),
            "chineseCatalogSha256": _sha256_bytes(
                chinese_catalog_source.encode("utf-8")
            ),
            "itemizedDoubleConfirmation": (
                'data-plugin-trust-flow="itemized-double-confirmation"'
                in surface_source
            ),
            "runtimeAndPermissionDiff": all(
                value in surface_source
                for value in (
                    't("plugin.host.runtimeDiff")',
                    't("plugin.host.permissionDiff")',
                )
            ) and all(
                value in english_catalog_source
                for value in (
                    '"plugin.host.runtimeDiff": "Runtime diff"',
                    '"plugin.host.permissionDiff": "Permission diff"',
                )
            ) and all(
                value in chinese_catalog_source
                for value in (
                    '"plugin.host.runtimeDiff": "运行时差异"',
                    '"plugin.host.permissionDiff": "权限差异"',
                )
            ),
            "tokenKeptInReactMemory": "useState<PluginTrustReview | null>"
            in surface_source,
            "verifiedPublisherNotSafeOrOfficial": (
                't("plugin.market.notCodeSafety")' in surface_source
                and "publisher verification is not code safety" in english_catalog_source
                and "not mean the plugin is official" in english_catalog_source
                and "发布者验证不等于代码安全" in chinese_catalog_source
                and "不表示插件是 CandleScope 官方提供" in chinese_catalog_source
            ),
            "strictTrustParsers": all(
                value in parser_source
                for value in (
                    "parsePluginLocalInstallCandidate",
                    "parsePluginTrustReview",
                    "parsePluginTrustChangeReview",
                )
            ),
        },
        "attackFixtures": {
            "python": {
                "path": PYTHON_PROBE.relative_to(REPOSITORY_ROOT).as_posix(),
                "sha256": _sha256_path(PYTHON_PROBE),
            },
            "java": {
                "path": JAVA_PROBE.relative_to(REPOSITORY_ROOT).as_posix(),
                "sha256": _sha256_path(JAVA_PROBE),
            },
            "native": {
                "path": NATIVE_PROBE.relative_to(REPOSITORY_ROOT).as_posix(),
                "sha256": _sha256_path(NATIVE_PROBE),
            },
            "expected": EXPECTED_ATTACK_RESULT,
        },
        "rollout": {
            "trustUxFlag": TRUST_UX_ENABLED_ENV,
            "trustUxDefault": False,
            "multiRuntimeFlag": MULTI_RUNTIME_ENABLED_ENV,
            "multiRuntimeDefault": False,
            "providerSeamFlag": RUNTIME_PROVIDER_SEAM_ENABLED_ENV,
            "nativeFlag": NATIVE_RUNTIME_ENABLED_ENV,
            "nativeDefault": False,
            "javaFlag": JAVA_RUNTIME_ENABLED_ENV,
            "javaDefault": False,
            "liveFlags": [
                PLUGIN_PLATFORM_V2_LIVE_BROKER_FOUNDATION_ENV,
                PLUGIN_PLATFORM_V2_LIVE_ACCOUNT_READONLY_ENV,
                PLUGIN_PLATFORM_V2_LIVE_RECONCILIATION_SHADOW_ENV,
                PLUGIN_PLATFORM_V2_LIVE_NATIVE_CONTROL_ENV,
                PLUGIN_PLATFORM_V2_LIVE_TESTNET_EXECUTION_ENV,
            ],
            "liveDefaults": [False, False, False, False, False],
            "rollbackPreservesLegacyTrustBehavior": True,
            "rollbackPreservesGrantRecords": True,
        },
    }


def validate_historical_contract_v1() -> dict[str, Any]:
    """Keep the original Phase 6 fixture byte-stable. Do not rewrite it."""

    raw = HISTORICAL_CONTRACT_PATH.read_bytes().replace(b"\r\n", b"\n")
    digest = hashlib.sha256(raw).hexdigest()
    if digest != HISTORICAL_CONTRACT_FILE_SHA256:
        raise Phase6GateError(
            "historical Phase 6 contract v1 was rewritten: "
            f"expected={HISTORICAL_CONTRACT_FILE_SHA256} current={digest}"
        )
    historical = _strict_json(HISTORICAL_CONTRACT_PATH)
    if historical.get("schemaVersion") != HISTORICAL_CONTRACT_SCHEMA_VERSION:
        raise Phase6GateError("historical Phase 6 contract lost schemaVersion /1")
    return historical


def validate_contract() -> dict[str, Any]:
    validate_historical_contract_v1()
    fixture = _strict_json(CONTRACT_PATH)
    current = capture_contract()
    if fixture != current:
        raise Phase6GateError(
            "multi-runtime Phase 6 contract drift: "
            f"fixture={_canonical_sha256(fixture)} current={_canonical_sha256(current)}"
        )
    return fixture


class _LocalEvidenceFetcher:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve(strict=True)
        self.calls: list[str] = []

    def fetch(self, url: str, destination: Path, *, maximum: int) -> None:
        self.calls.append(url)
        source = self.root / url.rsplit("/", 1)[-1]
        if source.is_symlink() or not source.is_file():
            raise Phase6GateError(f"missing frozen JRE evidence: {source.name}")
        if source.stat().st_size > maximum:
            raise Phase6GateError("frozen JRE evidence exceeds the signed maximum")
        shutil.copyfile(source, destination)


def _run_checked(
    command: Sequence[str],
    *,
    cwd: Path,
    timeout: float = 180.0,
) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(
        tuple(command),
        cwd=cwd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        shell=False,
        check=False,
    )
    if completed.returncode:
        raise Phase6GateError(
            f"command failed ({completed.returncode}): {' '.join(command)}\n"
            f"{completed.stdout[-2000:]}\n{completed.stderr[-4000:]}"
        )
    return completed


def _java_tool(jdk_home: Path, name: str) -> Path:
    path = jdk_home / "bin" / f"{name}.exe"
    if path.is_symlink() or not path.is_file():
        raise Phase6GateError(f"missing exact JDK tool: {path}")
    return path.resolve(strict=True)


def _process_exited(process_id: int) -> bool:
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
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


def _execute_attack(
    *,
    root: Path,
    runtime_kind: str,
    installation: Path,
    executable: Path,
    additional_read_only_paths: tuple[Path, ...],
    command_factory: Callable[[int, Path], tuple[str, ...]],
) -> dict[str, Any]:
    _ensure_import_paths()
    from candlescope_plugin_sdk.platform_v2 import loads_strict
    from app.plugin_security_v2 import (
        SandboxPolicy,
        delete_appcontainer_profile,
        prepare_sandbox_launch,
        restricted_runtime_profile,
    )

    profile = restricted_runtime_profile(runtime_kind)
    profile_name = f"CandleScope.Phase6.{uuid.uuid4().hex[:20]}"
    private = root / "private"
    runtime = root / "runtime"
    private_file = private / "data" / "allowed.txt"
    private_file.parent.mkdir(parents=True, exist_ok=True)
    installation_write = installation / "must-not-write.txt"
    secret = root / "outside-secret.txt"
    secret.write_text("must-not-be-readable", encoding="utf-8")
    policy = SandboxPolicy(
        profile_name=profile_name,
        installation_directory=installation,
        private_directory=private,
        runtime_directory=runtime,
        additional_read_only_paths=additional_read_only_paths,
        memory_limit_bytes=profile.memory_limit_bytes,
        cpu_rate_percent=profile.cpu_rate_percent,
        cpu_time_seconds=profile.probe_cpu_time_seconds,
        disk_limit_bytes=profile.disk_limit_bytes,
        max_processes=profile.max_processes,
        max_wall_seconds=profile.probe_wall_seconds,
    )
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
            server.bind(("127.0.0.1", 0))
            server.listen(1)
            port = server.getsockname()[1]
            command = command_factory(port, private_file)
            prepared = prepare_sandbox_launch(policy, command, installation)
            completed = _run_checked(
                prepared.command,
                cwd=prepared.working_directory,
                timeout=float(profile.probe_wall_seconds + 30),
            )
            result = loads_strict(completed.stdout.encode("utf-8"))
            if not isinstance(result, dict):
                raise Phase6GateError(f"{runtime_kind} attack result is not an object")
            observed = {key: result.get(key) for key in EXPECTED_ATTACK_RESULT}
            if observed != EXPECTED_ATTACK_RESULT:
                raise Phase6GateError(
                    f"{runtime_kind} sandbox attack escaped: {observed}"
                )
            server.setblocking(False)
            try:
                connection, _address = server.accept()
            except BlockingIOError:
                connection = None
            if connection is not None:
                connection.close()
                raise Phase6GateError(f"{runtime_kind} connected to loopback")
        if installation_write.exists():
            raise Phase6GateError(f"{runtime_kind} wrote into immutable installation")
        if private_file.read_text(encoding="utf-8") != "sandbox-probe":
            raise Phase6GateError(f"{runtime_kind} could not use private storage")
        config = _strict_json(prepared.config_path)
        status = _strict_json(prepared.status_path)
        if (
            config["limits"]["activeProcesses"] != 1
            or not config["appContainerSid"].startswith("S-1-15-2-")
            or status.get("status") != "exited"
            or status.get("exitCode") != 0
            or Path(config["command"][0]).resolve(strict=True)
            != executable.resolve(strict=True)
        ):
            raise Phase6GateError(f"{runtime_kind} launch evidence is incomplete")
        return {
            "runtimeKind": runtime_kind,
            "profileId": profile.profile_id,
            "sandboxMode": policy.mode,
            "runtimeExecutableName": executable.name,
            "runtimeExecutableSha256": _sha256_path(executable),
            "appContainerSidPresent": True,
            "activeProcessLimit": config["limits"]["activeProcesses"],
            "memoryLimitBytes": config["limits"]["memoryBytes"],
            "networkCapabilities": [],
            "result": observed,
            "exitCode": status["exitCode"],
        }
    finally:
        delete_appcontainer_profile(profile_name)


def _attack_matrix(
    root: Path,
    *,
    jdk_home: Path,
    java_runtime: Any,
) -> dict[str, Any]:
    _ensure_import_paths()
    from app.plugin_security_v2 import prepare_pinned_python_runtime

    python_installation = root / "python" / "installation"
    python_installation.mkdir(parents=True)
    python_script = python_installation / PYTHON_PROBE.name
    shutil.copyfile(PYTHON_PROBE, python_script)
    pinned = prepare_pinned_python_runtime(
        root / "python" / "pinned", Path(sys.executable)
    )

    def python_command(port: int, private_file: Path) -> tuple[str, ...]:
        return (
            str(pinned.executable),
            "-I",
            "-S",
            "-u",
            str(python_script),
            str(root / "python" / "outside-secret.txt"),
            str(BACKEND_ROOT / "app" / "main.py"),
            str(python_installation / "must-not-write.txt"),
            str(private_file),
            str(port),
        )

    python_result = _execute_attack(
        root=root / "python",
        runtime_kind="python-module",
        installation=python_installation,
        executable=pinned.executable,
        additional_read_only_paths=(pinned.root,),
        command_factory=python_command,
    )

    java_installation = root / "java" / "installation"
    java_installation.mkdir(parents=True)
    _run_checked(
        (
            str(_java_tool(jdk_home, "javac")),
            "-encoding",
            "UTF-8",
            "-g:none",
            "--release",
            "25",
            "-d",
            str(java_installation),
            str(JAVA_PROBE),
        ),
        cwd=REPOSITORY_ROOT,
    )
    java_executable = Path(java_runtime.executable).resolve(strict=True)

    def java_command(port: int, private_file: Path) -> tuple[str, ...]:
        return (
            str(java_executable),
            "-Xms16m",
            "-Xmx128m",
            "-XX:+UseSerialGC",
            f"-Djava.io.tmpdir={private_file.parent}",
            "-cp",
            str(java_installation),
            "Phase6JavaSandboxProbe",
            str(root / "java" / "outside-secret.txt"),
            str(BACKEND_ROOT / "app" / "main.py"),
            str(java_installation / "must-not-write.txt"),
            str(private_file),
            str(port),
            str(java_executable),
        )

    java_result = _execute_attack(
        root=root / "java",
        runtime_kind="java-jar",
        installation=java_installation,
        executable=java_executable,
        additional_read_only_paths=(Path(java_runtime.root).resolve(strict=True),),
        command_factory=java_command,
    )

    native_installation = root / "native" / "installation"
    native_installation.mkdir(parents=True)
    native_executable = native_installation / "phase6-native-sandbox-probe.exe"
    clang = shutil.which("clang-cl.exe")
    if clang is None:
        raise Phase6GateError("clang-cl.exe is required for the real native probe")
    _run_checked(
        (
            clang,
            "/O2",
            "/MT",
            str(NATIVE_PROBE),
            "/link",
            "/subsystem:console",
            "ws2_32.lib",
            "advapi32.lib",
            f"/out:{native_executable}",
        ),
        cwd=REPOSITORY_ROOT,
    )

    def native_command(port: int, private_file: Path) -> tuple[str, ...]:
        return (
            str(native_executable),
            "attack",
            str(root / "native" / "outside-secret.txt"),
            str(BACKEND_ROOT / "app" / "main.py"),
            str(native_installation / "must-not-write.txt"),
            str(private_file),
            str(port),
        )

    native_result = _execute_attack(
        root=root / "native",
        runtime_kind="native-executable",
        installation=native_installation,
        executable=native_executable,
        additional_read_only_paths=(),
        command_factory=native_command,
    )
    return {
        "python-module": python_result,
        "java-jar": java_result,
        "native-executable": native_result,
    }


async def _wait_for_exit(process_id: int) -> bool:
    for _attempt in range(150):
        if _process_exited(process_id):
            return True
        await asyncio.sleep(0.02)
    return _process_exited(process_id)


async def _signed_marketplace_lifecycle(root: Path, registry: Any) -> dict[str, Any]:
    _ensure_import_paths()
    from app.plugin_core_v2.runtime import CorePluginPlatform
    from app.plugin_security_v2 import delete_appcontainer_profile
    from tests.plugin_marketplace_testkit import (
        MARKETPLACE_ID,
        SignedMarketplaceBuilder,
        build_marketplace_bundle,
    )

    python_fixture = build_marketplace_bundle(root / "bundle-python")
    fixtures = (python_fixture,)
    builder = SignedMarketplaceBuilder.create()
    for fixture in fixtures:
        builder.add_release(fixture.bundle)
    platform = CorePluginPlatform(
        root=root / "product",
        host_name="CandleScope",
        host_version="0.4.0",
        marketplace_enabled=True,
        marketplace_roots=(builder.root,),
        trust_ux_enabled=True,
        multi_runtime_enabled=True,
        runtime_provider_seam_enabled=True,
        native_runtime_enabled=True,
        java_runtime_enabled=True,
        managed_runtime_registry=registry,
    )
    platform.marketplace.import_index(
        builder.index_bytes(), marketplace_id=MARKETPLACE_ID
    )
    profiles: list[str] = []
    process_ids: list[int] = []
    lifecycle: dict[str, Any] = {}
    await platform.start()
    try:
        for fixture in fixtures:
            bundle = fixture.bundle
            plugin_id = bundle.manifest.plugin.id
            platform.marketplace.prepare(
                plugin_id,
                version=bundle.manifest.plugin.version,
                artifact_bytes=bundle.path.read_bytes(),
            )
            platform.marketplace.apply(plugin_id)
            for permission in bundle.manifest.permissions.required:
                platform.installer.grant_permission(
                    plugin_id,
                    permission.id,
                    scope=permission.scope,
                    source="installer",
                    trace_id=f"phase6-real-grant-{plugin_id}",
                )
            platform.marketplace.begin_activation(plugin_id)
            await platform.reconcile_plugin(plugin_id)
            health = await platform.observe_plugin_health(plugin_id)
            platform.marketplace.finish_observation(
                plugin_id,
                healthy=True,
                detail="Phase 6 signed Marketplace AppContainer gate passed",
            )
            supervisor = await platform._ensure_active(plugin_id, "main")
            await supervisor.health_check()
            snapshot = supervisor.snapshot()
            policy = supervisor.spec.sandbox_policy
            transport = snapshot.get("transport")
            if (
                supervisor.spec.trust_level != "untrusted"
                or policy is None
                or snapshot["state"] != "active"
                or not isinstance(transport, dict)
                or not transport.get("processTreeControl")
            ):
                raise Phase6GateError(
                    "signed Marketplace runtime was not sandboxed: "
                    f"plugin={plugin_id} trust={supervisor.spec.trust_level} "
                    f"policy={policy is not None} snapshot={snapshot!r}"
                )
            profile = policy.profile_name
            profiles.append(profile)
            process_id = snapshot["transport"]["pid"]
            process_ids.append(process_id)
            configs = sorted(policy.runtime_directory.glob("launch-*/config.json"))
            if not configs:
                raise Phase6GateError(f"missing runtime sandbox config: {plugin_id}")
            config = _strict_json(configs[-1])
            detail = platform.management_detail(plugin_id)
            trust = detail.get("trust")
            runtime = detail["plugin"]["runtime"]["entrypoints"][0]
            authorization_entrypoint = (
                trust.get("authorization", {}).get("entrypoints", [{}])[0]
                if isinstance(trust, dict)
                else {}
            )
            if (
                not isinstance(trust, dict)
                or trust.get("mode") != "marketplace-sandboxed"
                or trust.get("authorization", {}).get("sandbox", {}).get("active")
                is not True
                or trust.get("authorization", {}).get("sandbox", {}).get("status")
                != "windows-appcontainer"
                or not config["appContainerSid"].startswith("S-1-15-2-")
                or config["limits"]["activeProcesses"] != 1
            ):
                raise Phase6GateError(
                    f"signed Marketplace trust evidence is incomplete: {plugin_id}"
                )
            lifecycle[runtime["runtimeKind"]] = {
                "pluginId": plugin_id,
                "trustMode": trust["mode"],
                "sandboxStatus": trust["authorization"]["sandbox"]["status"],
                "runtimeId": runtime["runtimeId"],
                "hostManaged": authorization_entrypoint.get("hostManaged"),
                "appContainerSidPresent": True,
                "activeProcessLimit": config["limits"]["activeProcesses"],
                "healthEntrypoints": len(health),
                "generation": snapshot["generation"],
                "processTreeControl": True,
            }
    finally:
        await platform.stop()
        for profile in profiles:
            delete_appcontainer_profile(profile)
    residual = [pid for pid in process_ids if not await _wait_for_exit(pid)]
    if residual or platform.manager.owner_keys():
        raise Phase6GateError(f"sandbox lifecycle left residual processes: {residual}")
    if set(lifecycle) != {"python-module"}:
        raise Phase6GateError(
            f"signed Marketplace lifecycle kinds drifted: {lifecycle}"
        )
    return {
        "kinds": lifecycle,
        "residualProcesses": 0,
        "residualSupervisors": 0,
    }


async def _real_gate_async(
    root: Path,
    *,
    jdk_home: Path,
    jre_evidence_directory: Path,
) -> dict[str, Any]:
    _ensure_import_paths()
    from app.plugin_core_v2.runtime import CorePluginPlatform
    from app.plugin_runtime_registry_v3 import build_official_runtime_registry
    from app.plugin_security_v2 import restricted_runtime_profile

    fetcher = _LocalEvidenceFetcher(jre_evidence_directory)
    registry = build_official_runtime_registry(
        root=root / "managed-runtimes",
        enabled=True,
        network_updates_enabled=False,
        fetcher=fetcher,
    )
    java_runtime = registry.ensure(JAVA_RUNTIME_ID, "java")
    repeat = registry.ensure(JAVA_RUNTIME_ID, "java", offline=True)
    if java_runtime.quick_repeat or not repeat.quick_repeat or len(fetcher.calls) != 5:
        raise Phase6GateError("managed JRE first/offline semantics changed")
    attacks = _attack_matrix(
        root / "attacks", jdk_home=jdk_home, java_runtime=java_runtime
    )
    lifecycle = await _signed_marketplace_lifecycle(root / "marketplace", registry)
    defaults = CorePluginPlatform(
        root=root / "defaults",
        host_name="CandleScope",
        host_version="0.4.0",
    )
    live_status = defaults.live_control_public_status()
    if defaults.trust_ux_enabled or any(
        (
            defaults.live_broker_foundation_enabled,
            defaults.live_account_readonly_enabled,
            defaults.live_reconciliation_shadow_enabled,
            defaults.live_native_control_enabled,
            defaults.live_testnet_execution_enabled,
        )
    ):
        raise Phase6GateError("trust or Live authority defaults were widened")
    node_profile = restricted_runtime_profile("node-module").to_wire(
        platform_name="windows"
    )
    return {
        "schemaVersion": REAL_GATE_SCHEMA_VERSION,
        "generatedAt": "2026-08-03T00:00:00Z",
        "result": "pass",
        "contractSha256": _canonical_sha256(capture_contract()),
        "managedJre": {
            "runtimeId": java_runtime.release.runtime_id,
            "version": java_runtime.release.version,
            "archiveSha256": java_runtime.release.sha256,
            "probeSha256": java_runtime.probe.sha256,
            "offlineQuick": repeat.quick_repeat,
            "downloadedEvidenceFiles": len(fetcher.calls),
        },
        "attacks": attacks,
        "signedMarketplaceLifecycle": lifecycle,
        "deferredKinds": {
            "node-module": {
                "profileDefined": True,
                "providerExecutable": False,
                "phase": 7,
                "profileId": node_profile["profileId"],
            },
            "wasm-component": {
                "profileDefined": False,
                "providerExecutable": False,
                "phase": 8,
            },
        },
        "defaults": {
            "trustUxEnabled": defaults.trust_ux_enabled,
            "liveBrokerFoundationEnabled": defaults.live_broker_foundation_enabled,
            "liveAccountReadonlyEnabled": defaults.live_account_readonly_enabled,
            "liveReconciliationShadowEnabled": (
                defaults.live_reconciliation_shadow_enabled
            ),
            "liveNativeControlEnabled": defaults.live_native_control_enabled,
            "liveTestnetExecutionEnabled": defaults.live_testnet_execution_enabled,
            "liveControl": live_status,
        },
    }


def run_real_gate(
    *,
    jdk_home: Path,
    jre_evidence_directory: Path,
) -> dict[str, Any]:
    if os.name != "nt":
        raise Phase6GateError("Phase 6 real sandbox gate requires Windows")
    with tempfile.TemporaryDirectory(prefix="candlescope-phase6-real-") as value:
        return asyncio.run(
            _real_gate_async(
                Path(value),
                jdk_home=jdk_home.resolve(strict=True),
                jre_evidence_directory=jre_evidence_directory.resolve(strict=True),
            )
        )


def validate_real_gate_evidence() -> dict[str, Any]:
    evidence = _strict_json(REAL_EVIDENCE_PATH)
    contract = capture_contract()
    if (
        evidence.get("schemaVersion") != REAL_GATE_SCHEMA_VERSION
        or evidence.get("result") != "pass"
        or evidence.get("contractSha256")
        != contract["realGateEvidenceContractSha256"]
    ):
        raise Phase6GateError("recorded Phase 6 real gate is missing, failed, or stale")
    attacks = evidence.get("attacks")
    attack_kinds = set(contract["sandbox"]["phase6AttackKinds"])
    if not isinstance(attacks, dict) or set(attacks) != attack_kinds:
        raise Phase6GateError(
            "recorded attack matrix does not cover every executable kind"
        )
    for kind in attack_kinds:
        if attacks[kind].get("result") != EXPECTED_ATTACK_RESULT:
            raise Phase6GateError(f"recorded {kind} attack result is incomplete")
    lifecycle = evidence.get("signedMarketplaceLifecycle")
    lifecycle_kinds = set(contract["sandbox"]["signedMarketplaceLifecycleKinds"])
    if (
        not isinstance(lifecycle, dict)
        or set(lifecycle.get("kinds", {})) != lifecycle_kinds
        or lifecycle.get("residualProcesses") != 0
        or lifecycle.get("residualSupervisors") != 0
    ):
        raise Phase6GateError("recorded signed Marketplace lifecycle is incomplete")
    if any(
        evidence.get("defaults", {}).get(key) is not False
        for key in (
            "trustUxEnabled",
            "liveBrokerFoundationEnabled",
            "liveAccountReadonlyEnabled",
            "liveReconciliationShadowEnabled",
            "liveNativeControlEnabled",
            "liveTestnetExecutionEnabled",
        )
    ):
        raise Phase6GateError("recorded rollback or Live defaults were widened")
    deferred = evidence.get("deferredKinds", {})
    if (
        deferred.get("node-module", {}).get("providerExecutable") is not False
        or deferred.get("wasm-component", {}).get("providerExecutable") is not False
    ):
        raise Phase6GateError("future runtime support was overstated")
    return evidence


def run_gate() -> dict[str, Any]:
    contract = validate_contract()
    evidence = validate_real_gate_evidence()
    return {
        "schemaVersion": GATE_SCHEMA_VERSION,
        "result": "pass",
        "contractSha256": _canonical_sha256(contract),
        "realEvidenceSha256": _sha256_path(REAL_EVIDENCE_PATH),
        "attackKinds": sorted(evidence["attacks"]),
        "signedMarketplaceKinds": sorted(
            evidence["signedMarketplaceLifecycle"]["kinds"]
        ),
        "residualProcesses": evidence["signedMarketplaceLifecycle"][
            "residualProcesses"
        ],
        "trustUxDefault": evidence["defaults"]["trustUxEnabled"],
        "liveDefaultsRemainOff": True,
    }


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


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--print-contract", action="store_true")
    parser.add_argument("--run-real", action="store_true")
    parser.add_argument("--jdk-home", type=Path)
    parser.add_argument("--jre-evidence-directory", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    if args.print_contract and args.run_real:
        parser.error("choose either --print-contract or --run-real")
    if args.print_contract:
        value = capture_contract()
    elif args.run_real:
        if args.jdk_home is None or args.jre_evidence_directory is None:
            parser.error("--run-real requires exact JDK and JRE evidence directories")
        value = run_real_gate(
            jdk_home=args.jdk_home,
            jre_evidence_directory=args.jre_evidence_directory,
        )
    else:
        value = run_gate()
    if args.output is not None:
        _atomic_json(args.output, value)
    print(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
