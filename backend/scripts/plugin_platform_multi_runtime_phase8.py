"""Phase 8 WASM Provider, Rust SDK, and real Windows/WSL release gate."""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import ctypes
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any, Sequence


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = REPOSITORY_ROOT / "backend"
SDK_SOURCE = REPOSITORY_ROOT / "packages" / "candlescope-plugin-sdk" / "src"
WASM_SDK = REPOSITORY_ROOT / "packages" / "candlescope-plugin-sdk-rust-wasm"
WASM_REFERENCE = REPOSITORY_ROOT / "examples" / "plugin-platform-wasm-rust"
FIXTURE_ROOT = BACKEND_ROOT / "tests" / "fixtures" / "plugin_platform_multi_runtime"
CONTRACT_PATH = FIXTURE_ROOT / "phase8_contract_v1.json"
REAL_EVIDENCE_PATH = (
    REPOSITORY_ROOT
    / "docs"
    / "perf-baselines"
    / "plugin-platform-v2"
    / "multi-runtime-phase8-2026-08-03-windows-wsl2-amd64.json"
)
CONTRACT_SCHEMA_VERSION = "candlescope.plugin-platform.multi-runtime.phase8-contract/1"
REAL_GATE_SCHEMA_VERSION = (
    "candlescope.plugin-platform.multi-runtime.phase8-real-gate/1"
)
GATE_SCHEMA_VERSION = "candlescope.plugin-platform.multi-runtime.phase8-gate/1"
WASM_RUNTIME_ID = "wasmtime-47.0.3"
WASM_PLUGIN_ID = "candlescope.wasm-reference"
WASM_CONTRIBUTION_ID = "wasm-hello"
WASMTIME_COMMIT = "5554cc1a651da536af2cc46c7324bdc085b162e3"
WINDOWS_ARCHIVE = "wasmtime-v47.0.3-x86_64-windows.zip"
LINUX_ARCHIVE = "wasmtime-v47.0.3-x86_64-linux.tar.xz"


class Phase8GateError(RuntimeError):
    """The reviewed WASM contract or a real release gate failed."""


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


def _tree_sha256(root: Path, suffixes: frozenset[str]) -> str:
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*"), key=lambda item: item.as_posix()):
        if not path.is_file() or path.is_symlink() or path.suffix not in suffixes:
            continue
        relative = path.relative_to(root).as_posix().encode("utf-8")
        payload = path.read_bytes()
        digest.update(len(relative).to_bytes(4, "big"))
        digest.update(relative)
        digest.update(len(payload).to_bytes(8, "big"))
        digest.update(payload)
    return "sha256:" + digest.hexdigest()


def _strict_json(path: Path) -> dict[str, Any]:
    _ensure_import_paths()
    from candlescope_plugin_sdk.platform_v2 import loads_strict

    value = loads_strict(path.read_bytes())
    if not isinstance(value, dict):
        raise Phase8GateError(f"{path} must contain a strict JSON object")
    return value


def _canonical_sha256(value: Any) -> str:
    _ensure_import_paths()
    from candlescope_plugin_sdk.platform_v2 import canonical_sha256

    return canonical_sha256(value)


def _canonical_lines(values: Sequence[dict[str, Any]]) -> bytes:
    return b"".join(
        json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        + b"\n"
        for value in values
    )


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
        raise Phase8GateError(
            f"command failed ({completed.returncode}): {tuple(command)!r}\n"
            + completed.stderr[-6000:].decode("utf-8", errors="replace")
        )
    return completed


def capture_contract() -> dict[str, Any]:
    _ensure_import_paths()
    import tomllib

    from app.plugin_core_v2.runtime_providers import (
        WASM_COMPONENT_PROVIDER_VERSION,
        WASM_LINEAR_MEMORY_BYTES,
        WASM_PROCESS_FUEL,
        WASM_RUNTIME_ENABLED_ENV,
        WASMTIME_FIXED_ARGUMENTS,
        default_runtime_provider_registry,
    )
    from app.plugin_installer_v2.installer import (
        MULTI_RUNTIME_ENABLED_ENV,
        RUNTIME_PROVIDER_SEAM_ENABLED_ENV,
    )
    from app.plugin_runtime_registry_v3 import (
        OFFICIAL_REGISTRY_V4_PATH,
        OFFICIAL_REGISTRY_V5_PATH,
        OFFICIAL_ROOTS_PATH,
        OFFICIAL_ROOTS_V4_PATH,
        load_runtime_registry_roots_bytes,
        verify_runtime_registry_bytes,
    )
    from app.plugin_security_v2 import (
        restricted_runtime_profile,
        restricted_runtime_profiles_status,
    )
    from scripts import plugin_platform_multi_runtime_phase7 as phase7

    roots4 = load_runtime_registry_roots_bytes(OFFICIAL_ROOTS_V4_PATH.read_bytes())
    roots5 = load_runtime_registry_roots_bytes(OFFICIAL_ROOTS_PATH.read_bytes())
    revision4 = verify_runtime_registry_bytes(
        OFFICIAL_REGISTRY_V4_PATH.read_bytes(), roots4
    )
    revision5 = verify_runtime_registry_bytes(
        OFFICIAL_REGISTRY_V5_PATH.read_bytes(), roots5
    )
    releases = sorted(
        (item for item in revision5.runtimes if item.runtime_id == WASM_RUNTIME_ID),
        key=lambda item: item.operating_system,
    )
    if len(releases) != 2:
        raise Phase8GateError(
            "Runtime Registry v5 must contain Windows and Linux Wasmtime"
        )
    shape = type("RegistryShape", (), {"ensure": lambda *_args, **_kwargs: None})()
    registered = default_runtime_provider_registry(
        wasm_enabled=True, managed_runtime_registry=shape
    ).kinds
    sdk_cargo = tomllib.loads((WASM_SDK / "Cargo.toml").read_text(encoding="utf-8"))
    reference_manifest = _strict_json(WASM_REFERENCE / "manifest.json")
    reference_lock = _strict_json(WASM_REFERENCE / "supply-chain.lock.json")
    reference_runtime = reference_manifest["backend"]["entrypoints"][0]["runtime"]
    profile = restricted_runtime_profile("wasm-component")
    profile_status = restricted_runtime_profiles_status(
        platform_name="windows", include_wasm=True
    )
    wasm_status = next(
        item for item in profile_status if item["runtimeKind"] == "wasm-component"
    )
    return {
        "schemaVersion": CONTRACT_SCHEMA_VERSION,
        "implementedOn": "2026-08-03",
        "phase7ContractSha256": _canonical_sha256(phase7.validate_contract()),
        "runtimeRegistry": {
            "activeRegistryPath": OFFICIAL_REGISTRY_V5_PATH.name,
            "revision": revision5.revision,
            "previousRevision": revision4.revision,
            "previousRegistrySha256": revision5.previous_registry_sha256,
            "revision4Sha256": revision4.sha256,
            "registrySha256": revision5.sha256,
            "roots": len(roots5),
            "releases": [
                {
                    "os": item.operating_system,
                    "arch": item.architecture,
                    "version": item.version,
                    "archive": item.archive_format,
                    "archiveSha256": item.sha256,
                    "archiveSize": item.size,
                    "extractedSize": item.extracted_size,
                    "fileCount": item.file_count,
                    "executable": item.executable,
                    "licenseSpdx": item.license_spdx,
                    "legalDirectory": item.legal_directory,
                    "legalFileCount": item.legal_file_count,
                    "legalSize": item.legal_size,
                    "evidence": [
                        {
                            "role": evidence.role,
                            "projection": evidence.projection,
                            "sha256": evidence.sha256,
                            "size": evidence.size,
                        }
                        for evidence in item.evidence
                    ],
                    "scmRef": item.upstream_scm_ref,
                }
                for item in releases
            ],
            "githubEvidenceProjection": True,
            "verifiedPgpCommitRequired": True,
            "tarXzFailClosedExtraction": True,
        },
        "provider": {
            "kind": "wasm-component",
            "version": WASM_COMPONENT_PROVIDER_VERSION,
            "enabledKinds": list(registered),
            "enabledDefault": False,
            "managedRuntimeOnly": True,
            "runtimeId": WASM_RUNTIME_ID,
            "componentModel": "wasm32-wasip2-command-v1",
            "descriptorExport": "wasi:cli.run",
            "componentExport": "wasi:cli/run",
            "wasiProfile": "wasi-preview2-minimal-v1",
            "bridge": "stdin-stdout-jsonl-v1",
            "network": False,
            "environmentInheritance": False,
            "preopenedDirectories": [],
            "subprocess": False,
            "linearMemoryBytes": WASM_LINEAR_MEMORY_BYTES,
            "processFuel": WASM_PROCESS_FUEL,
            "requestWallSeconds": 10,
            "maxProcesses": 1,
            "fixedArguments": list(WASMTIME_FIXED_ARGUMENTS),
            "failureClassifier": "wasmtime-v1",
            "cancelTerminatesProcess": True,
            "pathFallback": False,
        },
        "rustSdk": {
            "package": sdk_cargo["package"]["name"],
            "version": sdk_cargo["package"]["version"],
            "rustVersion": sdk_cargo["package"]["rust-version"],
            "dependencies": sorted(sdk_cargo.get("dependencies", {})),
            "cargoLockSha256": _sha256_path(WASM_SDK / "Cargo.lock"),
            "sourceSha256": _tree_sha256(WASM_SDK / "src", frozenset({".rs"})),
            "target": "wasm32-wasip2",
            "strictJsonl": True,
            "duplicateKeyRejection": True,
            "safeIntegerBound": True,
            "stdoutIsolation": True,
        },
        "referencePlugin": {
            "pluginId": reference_manifest["plugin"]["id"],
            "version": reference_manifest["plugin"]["version"],
            "runtimeKind": reference_runtime["kind"],
            "runtimeId": reference_runtime["runtimeId"],
            "descriptorExport": reference_runtime["export"],
            "wasiProfile": reference_runtime["wasiProfile"],
            "componentSha256": reference_lock["artifacts"]["main.wasm"]["sha256"],
            "componentSize": reference_lock["artifacts"]["main.wasm"]["size"],
            "componentHeader": reference_lock["toolchain"]["componentHeader"],
            "componentExport": reference_lock["toolchain"]["componentExport"],
            "rust": reference_lock["toolchain"]["rust"],
            "target": reference_lock["toolchain"]["target"],
            "transcriptSha256": reference_lock["transcriptSha256"],
            "transcriptResponses": reference_lock["transcriptResponses"],
            "reproducibleBuilds": reference_lock["reproducibleBuilds"],
            "offline": reference_lock["offline"],
            "dependencies": reference_lock["dependencies"],
        },
        "sandbox": {
            "profileId": profile.profile_id,
            "maxProcesses": profile.max_processes,
            "memoryLimitBytes": profile.memory_limit_bytes,
            "networkDefault": "denied",
            "windowsMode": wasm_status["sandboxMode"],
            "windowsAndWasiBoundary": True,
            "linuxClaim": "wasi-boundary-only",
            "signedMarketplaceLifecycle": True,
        },
        "rollout": {
            "providerSeamFlag": RUNTIME_PROVIDER_SEAM_ENABLED_ENV,
            "multiRuntimeFlag": MULTI_RUNTIME_ENABLED_ENV,
            "wasmFlag": WASM_RUNTIME_ENABLED_ENV,
            "providerSeamDefault": False,
            "multiRuntimeDefault": False,
            "wasmDefault": False,
            "disablePreservesInstallations": True,
            "systemWasmtimeFallback": False,
        },
    }


def validate_contract() -> dict[str, Any]:
    expected = _strict_json(CONTRACT_PATH)
    actual = capture_contract()
    if actual != expected:
        raise Phase8GateError("Phase 8 frozen contract differs from the implementation")
    return actual


class _LocalWasmEvidenceFetcher:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve(strict=True)
        self.calls: list[str] = []
        self.gh = shutil.which("gh")
        if self.gh is None:
            raise Phase8GateError("GitHub CLI is required for projected evidence")
        self.files = {
            (
                "https://github.com/bytecodealliance/wasmtime/releases/download/"
                f"v47.0.3/{WINDOWS_ARCHIVE}"
            ): WINDOWS_ARCHIVE,
            (
                "https://raw.githubusercontent.com/bytecodealliance/wasmtime/"
                f"{WASMTIME_COMMIT}/RELEASES.md"
            ): "RELEASES.md",
            (
                "https://raw.githubusercontent.com/bytecodealliance/wasmtime/"
                f"{WASMTIME_COMMIT}/Cargo.lock"
            ): "Cargo.lock",
        }

    def fetch(self, url: str, destination: Path, *, maximum: int) -> None:
        self.calls.append(url)
        if url.startswith("https://api.github.com/"):
            endpoint = url.removeprefix("https://api.github.com/")
            payload = _run_checked((self.gh, "api", endpoint), timeout=60).stdout
        else:
            name = self.files.get(url)
            if name is None:
                raise Phase8GateError(f"unexpected Wasmtime evidence URL: {url}")
            source = self.root / name
            if not source.is_file() or source.is_symlink():
                raise Phase8GateError(f"missing frozen Wasmtime evidence: {name}")
            payload = source.read_bytes()
        if len(payload) > maximum:
            raise Phase8GateError("Wasmtime evidence exceeds its signed bound")
        destination.write_bytes(payload)


def _build_checks(cargo: Path, wasmtime: Path) -> dict[str, Any]:
    cargo = cargo.resolve(strict=True)
    wasmtime = wasmtime.resolve(strict=True)
    tests = _run_checked(
        (str(cargo), "+1.97.1", "test", "--locked"),
        cwd=WASM_SDK,
        timeout=180,
    )
    build = _run_checked(
        (
            sys.executable,
            str(WASM_REFERENCE / "scripts" / "build_release.py"),
            "--cargo",
            str(cargo),
            "--wasmtime",
            str(wasmtime),
        ),
        timeout=180,
    )
    result = json.loads(build.stdout.decode("utf-8"))
    lock = _strict_json(WASM_REFERENCE / "supply-chain.lock.json")
    if (
        result.get("result") != "pass"
        or result.get("artifactSha256") != lock["artifacts"]["main.wasm"]["sha256"]
        or result.get("transcriptSha256") != lock["transcriptSha256"]
        or b"3 passed" not in tests.stdout + tests.stderr
    ):
        raise Phase8GateError("Rust SDK or deterministic reference build did not pass")
    rustc_executable = cargo.with_name("rustc.exe" if os.name == "nt" else "rustc")
    rustc = _run_checked((str(rustc_executable), "+1.97.1", "--version"))
    return {
        "sdkTests": 3,
        "rustc": rustc.stdout.decode("utf-8").strip(),
        "target": lock["toolchain"]["target"],
        "componentSha256": result["artifactSha256"],
        "componentSize": result["artifactSize"],
        "transcriptSha256": result["transcriptSha256"],
        "transcriptResponses": result["transcriptResponses"],
        "reproducibleBuilds": 2,
        "offline": True,
    }


def _attestation(path: Path) -> dict[str, Any]:
    gh = shutil.which("gh")
    if gh is None:
        raise Phase8GateError("GitHub CLI is required for attestation verification")
    completed = _run_checked(
        (
            gh,
            "attestation",
            "verify",
            str(path.resolve(strict=True)),
            "--repo",
            "bytecodealliance/wasmtime",
            "--format",
            "json",
        ),
        timeout=120,
    )
    values = json.loads(completed.stdout)
    if not isinstance(values, list) or len(values) != 1:
        raise Phase8GateError("Wasmtime archive has no unique GitHub attestation")
    statement = values[0]["verificationResult"]["statement"]
    certificate = values[0]["verificationResult"]["signature"]["certificate"]
    subject = statement["subject"][0]
    if (
        statement["predicateType"] != "https://slsa.dev/provenance/v1"
        or certificate["sourceRepositoryDigest"] != WASMTIME_COMMIT
        or certificate["sourceRepositoryRef"] != "refs/tags/v47.0.3"
        or subject["name"] != path.name
        or "sha256:" + subject["digest"]["sha256"] != _sha256_path(path)
    ):
        raise Phase8GateError("Wasmtime SLSA attestation identity changed")
    return {
        "subject": subject["name"],
        "sha256": "sha256:" + subject["digest"]["sha256"],
        "predicateType": statement["predicateType"],
        "sourceRepository": certificate["sourceRepositoryURI"],
        "sourceCommit": certificate["sourceRepositoryDigest"],
        "sourceRef": certificate["sourceRepositoryRef"],
        "workflow": certificate["githubWorkflowName"],
        "runnerEnvironment": certificate["runnerEnvironment"],
    }


def _extract_linux_runtime(archive: Path, destination: Path) -> Path:
    _ensure_import_paths()
    from app.plugin_runtime_registry_v3 import (
        OFFICIAL_REGISTRY_V5_PATH,
        OFFICIAL_ROOTS_PATH,
        load_runtime_registry_roots_bytes,
        verify_runtime_registry_bytes,
    )

    roots = load_runtime_registry_roots_bytes(OFFICIAL_ROOTS_PATH.read_bytes())
    registry = verify_runtime_registry_bytes(
        OFFICIAL_REGISTRY_V5_PATH.read_bytes(), roots
    )
    release = next(
        item
        for item in registry.runtimes
        if item.runtime_id == WASM_RUNTIME_ID and item.operating_system == "linux"
    )
    if (
        archive.stat().st_size != release.size
        or _sha256_path(archive) != release.sha256
    ):
        raise Phase8GateError("Linux Wasmtime archive differs from Registry v5")
    destination.mkdir(parents=True)
    expected = {"LICENSE", "README.md", "wasmtime", "wasmtime-min"}
    extracted: set[str] = set()
    with tarfile.open(archive, "r:xz") as package:
        for member in package.getmembers():
            if member.isdir():
                continue
            parts = PurePosixPath(member.name).parts
            if (
                not member.isfile()
                or member.issym()
                or member.islnk()
                or not parts
                or parts[0] != release.strip_prefix
                or len(parts) != 2
                or parts[1] not in expected
                or parts[1] in extracted
            ):
                raise Phase8GateError(f"unsafe Linux Wasmtime member: {member.name}")
            source = package.extractfile(member)
            if source is None:
                raise Phase8GateError("Linux Wasmtime member could not be read")
            (destination / parts[1]).write_bytes(source.read())
            extracted.add(parts[1])
    if extracted != expected:
        raise Phase8GateError("Linux Wasmtime archive inventory changed")
    executable = destination / "wasmtime"
    if (
        sum(path.stat().st_size for path in destination.iterdir())
        != release.extracted_size
    ):
        raise Phase8GateError("Linux Wasmtime extracted size changed")
    return executable


def _wsl_path(distro: str, path: Path) -> str:
    source = path.resolve(strict=True).as_posix()
    if len(source) < 4 or source[1:3] != ":/" or not source[0].isalpha():
        raise Phase8GateError(f"WSL gate requires a local drive path: {source}")
    converted = f"/mnt/{source[0].lower()}/{source[3:]}"
    _run_checked(("wsl.exe", "-d", distro, "--", "test", "-e", converted), timeout=30)
    return converted


def _wasi_probe_requests() -> list[dict[str, Any]]:
    context = {
        "contributionId": WASM_CONTRIBUTION_ID,
        "generation": 1,
        "traceId": "phase8-cross-host",
        "userAction": True,
    }
    return [
        {
            "jsonrpc": "2.0",
            "id": "handshake",
            "method": "handshake",
            "generation": 0,
            "params": {
                "protocols": ["candlescope.plugin/2"],
                "host": {"name": "CandleScope", "version": "0.4.0"},
                "entrypointId": "main",
                "hostApis": [],
                "transports": ["jsonl/1"],
            },
        },
        {
            "jsonrpc": "2.0",
            "id": "describe",
            "method": "describe",
            "generation": 0,
            "params": {},
        },
        {
            "jsonrpc": "2.0",
            "id": "activate",
            "method": "activate",
            "generation": 1,
            "params": {
                "capabilities": [],
                "generation": 1,
                "instanceId": "phase8-cross-host",
            },
        },
        {
            "jsonrpc": "2.0",
            "id": "normal",
            "method": "invoke",
            "generation": 1,
            "params": {
                "contributionId": WASM_CONTRIBUTION_ID,
                "input": {"name": "CandleScope 波浪", "numbers": [1, 2, 3]},
                "requestContext": context,
            },
        },
        {
            "jsonrpc": "2.0",
            "id": "sandbox",
            "method": "invoke",
            "generation": 1,
            "params": {
                "contributionId": WASM_CONTRIBUTION_ID,
                "input": {"sandboxProbe": True},
                "requestContext": {**context, "traceId": "phase8-wsl-sandbox"},
            },
        },
    ]


def _wsl_gate(
    *,
    distro: str,
    evidence_directory: Path,
    extraction_root: Path,
    windows_build: dict[str, Any],
) -> dict[str, Any]:
    from app.plugin_core_v2.runtime_providers.wasmtime_policy import (
        wasmtime_fixed_arguments,
    )
    from candlescope_plugin_sdk.platform_v2 import loads_strict

    available = _run_checked(("wsl.exe", "-l", "-q"), timeout=30).stdout.decode(
        "utf-16-le", errors="ignore"
    )
    if distro not in available:
        raise Phase8GateError(f"required WSL distro is unavailable: {distro}")
    linux_executable = _extract_linux_runtime(
        evidence_directory / LINUX_ARCHIVE,
        extraction_root / "linux-wasmtime",
    )
    script = _wsl_path(distro, WASM_REFERENCE / "scripts" / "build_release.py")
    executable = _wsl_path(distro, linux_executable)
    component = _wsl_path(distro, WASM_REFERENCE / "runtime" / "main.wasm")
    cargo = (
        _run_checked(
            ("wsl.exe", "-d", distro, "--", "bash", "-lc", "command -v cargo"),
            timeout=30,
        )
        .stdout.decode("utf-8")
        .strip()
    )
    python = (
        _run_checked(
            ("wsl.exe", "-d", distro, "--", "bash", "-lc", "command -v python3"),
            timeout=30,
        )
        .stdout.decode("utf-8")
        .strip()
    )
    if not cargo.startswith("/") or not python.startswith("/"):
        raise Phase8GateError("WSL Rust/Python tools are unavailable")
    version = (
        _run_checked(
            ("wsl.exe", "-d", distro, "--", executable, "--version"), timeout=30
        )
        .stdout.decode("utf-8")
        .strip()
    )
    build = _run_checked(
        (
            "wsl.exe",
            "-d",
            distro,
            "--",
            python,
            script,
            "--cargo",
            cargo,
            "--wasmtime",
            executable,
        ),
        timeout=240,
    )
    build_value = json.loads(build.stdout.decode("utf-8"))
    if (
        build_value.get("artifactSha256") != windows_build["componentSha256"]
        or build_value.get("artifactSize") != windows_build["componentSize"]
        or build_value.get("transcriptSha256") != windows_build["transcriptSha256"]
    ):
        raise Phase8GateError("Windows and WSL builds or canonical transcripts differ")
    probe = _run_checked(
        (
            "wsl.exe",
            "-d",
            distro,
            "--",
            executable,
            *wasmtime_fixed_arguments("linux"),
            "--",
            component,
        ),
        input_bytes=_canonical_lines(_wasi_probe_requests()),
        timeout=60,
    )
    responses = [loads_strict(line) for line in probe.stdout.splitlines()]
    if len(responses) != 5 or probe.stderr:
        raise Phase8GateError("WSL WASI boundary probe returned an invalid transcript")
    normal = responses[3].get("result")
    sandbox = responses[4].get("result")
    expected_sandbox = {
        "environmentCount": 0,
        "externalFileRead": False,
        "networkConnected": False,
        "processStarted": False,
    }
    if sandbox != expected_sandbox:
        raise Phase8GateError(f"WSL WASI ambient capability widened: {sandbox}")
    return {
        "distro": distro,
        "architecture": "x86_64",
        "wasmtimeVersion": version,
        "componentSha256": build_value["artifactSha256"],
        "componentSize": build_value["artifactSize"],
        "transcriptSha256": build_value["transcriptSha256"],
        "canonicalOutputSha256": _canonical_sha256(normal),
        "sandboxProbe": sandbox,
        "sandboxClaim": "wasi-boundary-only",
    }


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
        wasm_runtime_enabled=True,
        managed_runtime_registry=registry,
    )
    await platform.start()
    process_ids: list[int] = []
    try:
        contribution = f"{WASM_PLUGIN_ID}.{WASM_CONTRIBUTION_ID}"
        expected = {
            "message": "Hello from WASM, CandleScope 波浪!",
            "sum": 6,
        }
        first = await platform.invoke_command(
            contribution,
            {"name": "CandleScope 波浪", "numbers": [1, 2, 3]},
            user_action=True,
            trace_id="phase8-cold",
        )
        if first != expected:
            raise Phase8GateError(
                f"real WASM reference returned another result: {first}"
            )
        result_sha256 = _canonical_sha256(first)
        for index in range(50):
            result = await platform.invoke_command(
                contribution,
                {"name": "CandleScope 波浪", "numbers": [1, 2, 3]},
                user_action=True,
                trace_id=f"phase8-hot-{index}",
            )
            if _canonical_sha256(result) != result_sha256:
                raise Phase8GateError("50-call WASM canonical output changed")
        boundary = await platform.invoke_command(
            contribution,
            {"sandboxProbe": True},
            user_action=True,
            trace_id="phase8-wasi-boundary",
        )
        expected_boundary = {
            "environmentCount": 0,
            "externalFileRead": False,
            "networkConnected": False,
            "processStarted": False,
        }
        if boundary != expected_boundary:
            raise Phase8GateError(
                f"Windows WASI ambient capability widened: {boundary}"
            )
        supervisor = platform.manager.supervisor(WASM_PLUGIN_ID, "main")
        before = supervisor.snapshot()
        process_ids.append(before["transport"]["pid"])
        pending = asyncio.create_task(
            platform.invoke_command(
                contribution,
                {"fault": "cancel"},
                user_action=True,
                trace_id="phase8-cancel",
            )
        )
        await asyncio.sleep(0.1)
        pending.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await pending
        for _attempt in range(100):
            cancelled = supervisor.snapshot()
            failure = cancelled.get("lastFailure")
            if isinstance(failure, dict):
                break
            await asyncio.sleep(0.02)
        else:
            raise Phase8GateError("WASM cancellation did not record a diagnostic")
        if failure.get("code") != "PLUGIN_WASM_CANCELLED":
            raise Phase8GateError(f"WASM cancel diagnostic changed: {failure}")
        if not await _wait_exited(process_ids[-1]):
            raise Phase8GateError("cancelled Wasmtime process remained alive")
        restarted = await platform.invoke_command(
            contribution,
            {"name": "CandleScope 波浪", "numbers": [1, 2, 3]},
            user_action=True,
            trace_id="phase8-after-cancel",
        )
        if restarted != expected:
            raise Phase8GateError("WASM did not recover after process cancellation")
        after = supervisor.snapshot()
        process_ids.append(after["transport"]["pid"])
        catalog = next(
            item
            for item in platform.catalog()["plugins"]
            if item["id"] == WASM_PLUGIN_ID
        )
        runtime = catalog["runtime"]["entrypoints"][0]
        if (
            runtime["runtimeKind"] != "wasm-component"
            or runtime["runtimeId"] != WASM_RUNTIME_ID
            or runtime["runtimeSupply"]["version"] != "47.0.3"
            or runtime["runtimeSupply"]["verificationStatus"] != "verified"
            or not after["transport"]["processTreeControl"]
        ):
            raise Phase8GateError("Plugin Manager WASM provenance is incomplete")
    finally:
        await platform.stop()
    residual = [
        process_id for process_id in process_ids if not await _wait_exited(process_id)
    ]
    if residual or platform.manager.owner_keys():
        raise Phase8GateError(f"WASM lifecycle left residual processes: {residual}")
    return {
        "calls": 53,
        "canonicalOutputSha256": result_sha256,
        "sandboxProbe": boundary,
        "cancelCode": failure["code"],
        "cancelTerminatedProcess": True,
        "recoveredAfterCancel": True,
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
    from candlescope_plugin_sdk.platform_v2 import PluginManifest, WasmComponentRuntime
    from app.plugin_core_v2.runtime_providers import WasmComponentProvider
    from app.plugin_host import (
        EntrypointProcessSpec,
        EntrypointSupervisor,
        PlatformHostTransportError,
    )

    expected = {
        "fuel": "PLUGIN_WASM_FUEL_EXHAUSTED",
        "trap": "PLUGIN_WASM_TRAP",
        "memory": "PLUGIN_WASM_MEMORY_LIMIT_EXCEEDED",
        "wall": "PLUGIN_PLATFORM_TIMEOUT",
        "stderr": "PLUGIN_PLATFORM_STDERR_LIMIT_EXCEEDED",
        "cancel": "PLUGIN_WASM_CANCELLED",
    }
    observed: dict[str, str] = {}
    manifest = PluginManifest.from_wire(
        json.loads((WASM_REFERENCE / "manifest.json").read_bytes())
    )
    provider = WasmComponentProvider(registry)
    for mode in expected:
        installation = root / mode
        component = installation / "content" / "runtime" / "main.wasm"
        component.parent.mkdir(parents=True)
        shutil.copyfile(WASM_REFERENCE / "runtime" / "main.wasm", component)
        runtime = WasmComponentRuntime(
            artifact="runtime/main.wasm",
            runtime_id=WASM_RUNTIME_ID,
            export="wasi:cli.run",
            wasi_profile="wasi-preview2",
        )
        prepared = provider.prepare_runtime(
            runtime=runtime,
            executable=component,
            working_directory=installation,
            artifact_sha256=_sha256_path(component),
        )
        launch = provider.build_runtime_launch(prepared)
        supervisor = EntrypointSupervisor(
            EntrypointProcessSpec(
                plugin_id=WASM_PLUGIN_ID,
                entrypoint_id="main",
                executable=launch.executable,
                arguments=launch.arguments,
                working_directory=launch.working_directory,
                startup_timeout_seconds=5,
                request_timeout_seconds=0.2 if mode == "wall" else 15,
                shutdown_timeout_seconds=1,
                max_restart_attempts=0,
                max_stderr_bytes=4096 if mode == "stderr" else 64 * 1024,
                manage_process_tree=launch.manage_process_tree,
                isolated_search_path=launch.isolated_search_path,
                max_processes=launch.max_processes,
                failure_classifier=getattr(launch, "failure_classifier", "generic"),
                terminate_on_cancel=getattr(launch, "terminate_on_cancel", False),
            ),
            manifest,
            host_name="CandleScope",
            host_version="0.4.0",
        )
        try:
            await supervisor.start()
            await supervisor.activate()
            if mode == "cancel":
                pending = asyncio.create_task(
                    supervisor.invoke(
                        WASM_CONTRIBUTION_ID,
                        {"fault": "cancel"},
                        user_action=True,
                        trace_id="phase8-fault-cancel",
                    )
                )
                await asyncio.sleep(0.1)
                pending.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await pending
                for _attempt in range(100):
                    failure = supervisor.snapshot().get("lastFailure")
                    if isinstance(failure, dict):
                        observed[mode] = failure["code"]
                        break
                    await asyncio.sleep(0.02)
            else:
                fault = "cancel" if mode == "wall" else mode
                try:
                    await supervisor.invoke(
                        WASM_CONTRIBUTION_ID,
                        {"fault": fault},
                        user_action=True,
                        trace_id=f"phase8-fault-{mode}",
                    )
                except PlatformHostTransportError as exc:
                    observed[mode] = exc.code
                else:
                    raise Phase8GateError(f"WASM fault {mode} unexpectedly succeeded")
        finally:
            await supervisor.stop()
        if observed.get(mode) != expected[mode]:
            raise Phase8GateError(
                f"WASM fault {mode} diagnostic changed: "
                f"{observed.get(mode)} != {expected[mode]}"
            )
    return observed


async def _signed_marketplace_lifecycle(root: Path, registry: Any) -> dict[str, Any]:
    _ensure_import_paths()
    from app.plugin_core_v2.runtime import CorePluginPlatform
    from app.plugin_security_v2 import delete_appcontainer_profile
    from tests.plugin_marketplace_testkit import (
        MARKETPLACE_ID,
        SignedMarketplaceBuilder,
    )
    from tests.plugin_platform_wasm_testkit import build_wasm_reference_bundle

    fixture = build_wasm_reference_bundle(root / "bundle")
    builder = SignedMarketplaceBuilder.create()
    builder.add_release(
        fixture.bundle,
        dependencies=(
            {
                "name": "candlescope-plugin-sdk-wasm",
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
        wasm_runtime_enabled=True,
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
            WASM_PLUGIN_ID,
            version=bundle.manifest.plugin.version,
            artifact_bytes=bundle.path.read_bytes(),
        )
        platform.marketplace.apply(WASM_PLUGIN_ID)
        platform.marketplace.begin_activation(WASM_PLUGIN_ID)
        await platform.reconcile_plugin(WASM_PLUGIN_ID)
        health = await platform.observe_plugin_health(WASM_PLUGIN_ID)
        invoke = await platform.invoke_command(
            f"{WASM_PLUGIN_ID}.{WASM_CONTRIBUTION_ID}",
            {"name": "Marketplace", "numbers": [2, 3]},
            user_action=True,
            trace_id="phase8-marketplace",
        )
        boundary = await platform.invoke_command(
            f"{WASM_PLUGIN_ID}.{WASM_CONTRIBUTION_ID}",
            {"sandboxProbe": True},
            user_action=True,
            trace_id="phase8-marketplace-boundary",
        )
        platform.marketplace.finish_observation(
            WASM_PLUGIN_ID,
            healthy=True,
            detail="Phase 8 signed WASM AppContainer gate passed",
        )
        supervisor = await platform._ensure_active(WASM_PLUGIN_ID, "main")
        snapshot = supervisor.snapshot()
        policy = supervisor.spec.sandbox_policy
        if policy is None:
            raise Phase8GateError(
                "signed WASM Marketplace runtime has no sandbox policy"
            )
        profiles.append(policy.profile_name)
        process_ids.append(snapshot["transport"]["pid"])
        configs = sorted(policy.runtime_directory.glob("launch-*/config.json"))
        if not configs:
            raise Phase8GateError(
                "signed WASM Marketplace runtime has no launch evidence"
            )
        config = _strict_json(configs[-1])
        detail = platform.management_detail(WASM_PLUGIN_ID)
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
            or runtime["runtimeKind"] != "wasm-component"
            or invoke != {"message": "Hello from WASM, Marketplace!", "sum": 5}
            or boundary
            != {
                "environmentCount": 0,
                "externalFileRead": False,
                "networkConnected": False,
                "processStarted": False,
            }
        ):
            raise Phase8GateError("signed WASM Marketplace evidence is incomplete")
        result = {
            "pluginId": WASM_PLUGIN_ID,
            "trustMode": trust["mode"],
            "sandboxStatus": trust["authorization"]["sandbox"]["status"],
            "runtimeKind": runtime["runtimeKind"],
            "runtimeId": runtime["runtimeId"],
            "appContainerSidPresent": True,
            "activeProcessLimit": config["limits"]["activeProcesses"],
            "healthEntrypoints": len(health),
            "processTreeControl": True,
            "invokeSha256": _canonical_sha256(invoke),
            "wasiBoundary": boundary,
        }
    finally:
        await platform.stop()
        for profile in profiles:
            delete_appcontainer_profile(profile)
    residual = [
        process_id for process_id in process_ids if not await _wait_exited(process_id)
    ]
    if residual or platform.manager.owner_keys():
        raise Phase8GateError(
            f"signed WASM lifecycle left residual processes: {residual}"
        )
    return {**result, "residualProcesses": 0, "residualSupervisors": 0}


def _fresh_runtime_probe(runtime_root: Path) -> dict[str, Any]:
    _ensure_import_paths()
    from app.plugin_runtime_registry_v3 import build_official_runtime_registry

    registry = build_official_runtime_registry(
        root=runtime_root, enabled=True, network_updates_enabled=False
    )
    ensured = registry.ensure(WASM_RUNTIME_ID, "wasm", offline=True)
    return {
        "runtimeId": ensured.release.runtime_id,
        "quickRepeat": ensured.quick_repeat,
        "probeSha256": ensured.probe.sha256,
        "executableSha256": _sha256_path(ensured.executable),
    }


async def _real_gate_async(
    root: Path,
    evidence_directory: Path,
    cargo: Path,
    wsl_distro: str,
) -> dict[str, Any]:
    _ensure_import_paths()
    from app.plugin_core_v2.runtime import CorePluginPlatform
    from app.plugin_installer_v2.installer import PlatformPluginInstaller
    from app.plugin_installer_v2.registry import load_activation_registry
    from app.plugin_runtime_registry_v3 import (
        OFFICIAL_REGISTRY_V5_PATH,
        RuntimeRegistryError,
        build_official_runtime_registry,
    )
    from tests.plugin_platform_wasm_testkit import build_wasm_reference_bundle

    fetcher = _LocalWasmEvidenceFetcher(evidence_directory)
    runtime_root = root / "managed-runtimes"
    registry = build_official_runtime_registry(
        root=runtime_root,
        enabled=True,
        network_updates_enabled=False,
        fetcher=fetcher,
    )
    first = registry.ensure(WASM_RUNTIME_ID, "wasm")
    repeat = registry.ensure(WASM_RUNTIME_ID, "wasm")
    offline = registry.ensure(WASM_RUNTIME_ID, "wasm", offline=True)
    if (
        first.quick_repeat
        or not repeat.quick_repeat
        or not offline.quick_repeat
        or len(fetcher.calls) != 5
    ):
        raise Phase8GateError("real Wasmtime first/repeat/offline semantics changed")
    missing = build_official_runtime_registry(
        root=root / "offline-missing", enabled=True, network_updates_enabled=False
    )
    try:
        missing.ensure(WASM_RUNTIME_ID, "wasm", offline=True)
    except RuntimeRegistryError as exc:
        offline_missing_code = exc.code
    else:
        raise Phase8GateError("offline missing Wasmtime cache used a fallback")
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
        raise Phase8GateError("fresh process did not reuse verified Wasmtime cache")
    build = _build_checks(cargo, first.executable)
    attestations = [
        _attestation(evidence_directory / name)
        for name in (WINDOWS_ARCHIVE, LINUX_ARCHIVE)
    ]
    wsl = _wsl_gate(
        distro=wsl_distro,
        evidence_directory=evidence_directory,
        extraction_root=root,
        windows_build=build,
    )

    initial = build_wasm_reference_bundle(root / "bundle-initial")
    product = root / "product"
    installer = PlatformPluginInstaller(
        root=product,
        multi_runtime_enabled=True,
        runtime_provider_seam_enabled=True,
        wasm_runtime_enabled=True,
        managed_runtime_registry=registry,
    )
    installed = installer.install(
        initial.bundle.path, expected_sha256=initial.bundle.sha256, enabled=True
    )
    enabled = installer.enable(WASM_PLUGIN_ID)
    repeated = installer.install(
        initial.bundle.path, expected_sha256=initial.bundle.sha256, enabled=True
    )
    checked = installer.check(WASM_PLUGIN_ID)
    if (
        enabled.state != "active"
        or not repeated.reused_installation
        or checked.state != "active"
    ):
        raise Phase8GateError("WASM fresh install/quick repeat/check did not converge")
    updated = build_wasm_reference_bundle(
        root / "bundle-update", update_marker="phase8-update-1"
    )
    update_result = installer.install(
        updated.bundle.path, expected_sha256=updated.bundle.sha256, enabled=True
    )
    rollback = installer.rollback(WASM_PLUGIN_ID)
    record = load_activation_registry(installer.registry_path).by_id()[WASM_PLUGIN_ID]
    if (
        update_result.state != "active"
        or record.bundle_sha256 != initial.bundle.sha256
        or record.installation_id != installed.installation_id
    ):
        raise Phase8GateError("WASM update/rollback did not restore initial activation")

    lifecycle = await _runtime_lifecycle(product, registry)
    if lifecycle["canonicalOutputSha256"] != wsl["canonicalOutputSha256"]:
        raise Phase8GateError("Windows and WSL canonical invocation output differs")
    faults = await _fault_matrix(root / "faults", registry)
    marketplace = await _signed_marketplace_lifecycle(root / "marketplace", registry)

    disabled_platform = CorePluginPlatform(
        root=product,
        host_name="CandleScope",
        host_version="0.4.0",
        multi_runtime_enabled=True,
        runtime_provider_seam_enabled=True,
        wasm_runtime_enabled=False,
        managed_runtime_registry=registry,
    )
    await disabled_platform.start()
    try:
        catalog = next(
            item
            for item in disabled_platform.catalog()["plugins"]
            if item["id"] == WASM_PLUGIN_ID
        )
        if catalog["available"] or disabled_platform.manager.owner_keys():
            raise Phase8GateError("disabled WASM Provider found a system fallback")
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
        registry.ensure(WASM_RUNTIME_ID, "wasm", offline=True)
    except RuntimeRegistryError as exc:
        rollback_unavailable_code = exc.code
    else:
        raise Phase8GateError("Registry rollback unexpectedly retained Wasmtime")
    restored = registry.activate_registry(OFFICIAL_REGISTRY_V5_PATH.read_bytes())
    registry.ensure(WASM_RUNTIME_ID, "wasm", offline=True)

    contract = capture_contract()
    runtime_supply = record.entrypoints[0].runtime_supply.to_wire()
    runtime_supply["executable"] = "<managed-runtime-cache>/wasmtime.exe"
    return {
        "schemaVersion": REAL_GATE_SCHEMA_VERSION,
        "generatedAt": "2026-08-03T21:30:00Z",
        "result": "pass",
        "contractSha256": _canonical_sha256(contract),
        "build": build,
        "wasmtime": {
            "runtimeId": first.release.runtime_id,
            "version": first.release.version,
            "archiveSha256": first.release.sha256,
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
            "attestations": attestations,
        },
        "crossHost": wsl,
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
            "sourceCompilation": False,
            "systemRuntimeFallback": False,
        },
        "runtime": lifecycle,
        "faults": faults,
        "marketplace": marketplace,
        "disabled": disabled,
        "registryRollback": {
            "toRevision": rolled["toRevision"],
            "wasmtimeUnavailableCode": rollback_unavailable_code,
            "restoredRevision": restored["revision"],
        },
        "defaults": {
            "providerSeamEnabled": False,
            "multiRuntimeEnabled": False,
            "wasmRuntimeEnabled": False,
            "registryNetworkUpdatesEnabled": False,
        },
    }


def run_real_gate(
    evidence_directory: Path,
    *,
    cargo: Path,
    wsl_distro: str,
) -> dict[str, Any]:
    if os.name != "nt":
        raise Phase8GateError("Phase 8 real WASM release gate requires Windows + WSL2")
    with tempfile.TemporaryDirectory(prefix="candlescope-phase8-real-") as value:
        return asyncio.run(
            _real_gate_async(
                Path(value),
                evidence_directory.resolve(strict=True),
                cargo.resolve(strict=True),
                wsl_distro,
            )
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
            "cancel": "PLUGIN_WASM_CANCELLED",
            "fuel": "PLUGIN_WASM_FUEL_EXHAUSTED",
            "memory": "PLUGIN_WASM_MEMORY_LIMIT_EXCEEDED",
            "stderr": "PLUGIN_PLATFORM_STDERR_LIMIT_EXCEEDED",
            "trap": "PLUGIN_WASM_TRAP",
            "wall": "PLUGIN_PLATFORM_TIMEOUT",
        }
        or evidence.get("runtime", {}).get("sandboxProbe")
        != evidence.get("crossHost", {}).get("sandboxProbe")
        or evidence.get("runtime", {}).get("canonicalOutputSha256")
        != evidence.get("crossHost", {}).get("canonicalOutputSha256")
        or evidence.get("crossHost", {}).get("sandboxClaim") != "wasi-boundary-only"
        or evidence.get("marketplace", {}).get("sandboxStatus")
        != "windows-appcontainer"
        or evidence.get("runtime", {}).get("residualProcesses") != 0
        or evidence.get("defaults")
        != {
            "providerSeamEnabled": False,
            "multiRuntimeEnabled": False,
            "wasmRuntimeEnabled": False,
            "registryNetworkUpdatesEnabled": False,
        }
    ):
        raise Phase8GateError(
            "recorded Phase 8 real WASM gate is missing, failed, or stale"
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
        "runtimeId": evidence["wasmtime"]["runtimeId"],
        "componentSha256": evidence["build"]["componentSha256"],
        "transcriptSha256": evidence["build"]["transcriptSha256"],
        "faults": evidence["faults"],
        "windowsMarketplaceSandbox": evidence["marketplace"]["sandboxStatus"],
        "linuxSandboxClaim": evidence["crossHost"]["sandboxClaim"],
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
    parser.add_argument("--wasmtime-evidence", type=Path)
    parser.add_argument("--cargo", type=Path)
    parser.add_argument("--wsl-distro", default="Ubuntu-22.04")
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
        if args.wasmtime_evidence is None or args.cargo is None:
            parser.error("--run-real requires --wasmtime-evidence and --cargo")
        value = run_real_gate(
            args.wasmtime_evidence,
            cargo=args.cargo,
            wsl_distro=args.wsl_distro,
        )
    elif args.fresh_runtime_probe is not None:
        value = _fresh_runtime_probe(args.fresh_runtime_probe.resolve(strict=True))
    else:
        value = run_gate()
    if args.output is not None:
        _atomic_json(args.output.resolve(), value)
    else:
        print(
            json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
