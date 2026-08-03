"""Phase 5 Java Provider, Java SDK, ta4j adapter and real-JRE release gate."""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import ctypes
import hashlib
import json
import os
import stat
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path
from typing import Any, Sequence


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = REPOSITORY_ROOT / "backend"
SDK_SOURCE = REPOSITORY_ROOT / "packages" / "candlescope-plugin-sdk" / "src"
JAVA_SDK = REPOSITORY_ROOT / "packages" / "candlescope-plugin-sdk-java"
REFERENCE = REPOSITORY_ROOT / "examples" / "plugins" / "ta4j-elliott-adapter"
CONTRACT_PATH = (
    BACKEND_ROOT
    / "tests"
    / "fixtures"
    / "plugin_platform_multi_runtime"
    / "phase5_contract_v1.json"
)
REAL_EVIDENCE_PATH = (
    REPOSITORY_ROOT
    / "docs"
    / "perf-baselines"
    / "plugin-platform-v2"
    / "multi-runtime-phase5-2026-08-03-windows-amd64.json"
)
CONTRACT_SCHEMA_VERSION = "candlescope.plugin-platform.multi-runtime.phase5-contract/1"
GATE_SCHEMA_VERSION = "candlescope.plugin-platform.multi-runtime.phase5-gate/1"
REAL_GATE_SCHEMA_VERSION = (
    "candlescope.plugin-platform.multi-runtime.phase5-real-gate/1"
)
JAVA_RUNTIME_ID = "temurin-25.0.4.7"
JAVA_PLUGIN_ID = "candlescope.ta4j-elliott"
JAVA_CONTRIBUTION_ID = "analyze-ta4j-elliott"
ADAPTER_LEGAL_ARTIFACTS = (
    "META-INF/licenses/Apache-2.0.txt",
    "META-INF/licenses/Apache-Commons-Math-NOTICE.txt",
    "META-INF/licenses/GPL-3.0-only.txt",
    "META-INF/licenses/MIT.txt",
    "META-INF/licenses/THIRD_PARTY_NOTICES.txt",
    "META-INF/licenses/upstream/commons-math3-3.6.1.jar/LICENSE.txt",
    "META-INF/licenses/upstream/commons-math3-3.6.1.jar/NOTICE.txt",
    "META-INF/licenses/upstream/slf4j-api-2.0.18.jar/LICENSE.txt",
)


class Phase5GateError(RuntimeError):
    """The reviewed Java/ta4j contract or a real release gate failed."""


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
        raise Phase5GateError(f"{path} must contain a strict JSON object")
    return value


def _sha256_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def _sha256_path(path: Path) -> str:
    return _sha256_bytes(path.read_bytes())


def capture_contract() -> dict[str, Any]:
    _ensure_import_paths()
    from app.plugin_core_v2.runtime_providers import (
        JAVA_JAR_PROVIDER_VERSION,
        JAVA_RUNTIME_ENABLED_ENV,
        default_runtime_provider_registry,
    )
    from app.plugin_runtime_registry_v3 import (
        EVIDENCE_ROLES,
        OFFICIAL_REGISTRY_V1_PATH,
        OFFICIAL_REGISTRY_V2_PATH,
        OFFICIAL_ROOTS_PATH,
        load_runtime_registry_roots_bytes,
        verify_runtime_registry_bytes,
    )
    from scripts import plugin_platform_multi_runtime_phase4 as phase4

    phase4_contract = phase4.validate_contract()
    roots = load_runtime_registry_roots_bytes(OFFICIAL_ROOTS_PATH.read_bytes())
    revision_1 = verify_runtime_registry_bytes(
        OFFICIAL_REGISTRY_V1_PATH.read_bytes(), roots
    )
    revision_2 = verify_runtime_registry_bytes(
        OFFICIAL_REGISTRY_V2_PATH.read_bytes(), roots
    )
    release = next(
        item for item in revision_2.runtimes if item.runtime_id == JAVA_RUNTIME_ID
    )
    manifest = _strict_json(REFERENCE / "manifest.json")
    lock = _strict_json(REFERENCE / "supply-chain.lock.json")
    transcript = _strict_json(REFERENCE / "probes" / "ta4j-control.json")
    golden = _strict_json(REFERENCE / "evidence" / "golden-corpus.json")
    comparison = _strict_json(REFERENCE / "evidence" / "python-comparison.json")
    adapter_source = (
        REFERENCE
        / "src"
        / "main"
        / "java"
        / "io"
        / "candlescope"
        / "plugins"
        / "ta4j"
        / "elliott"
        / "Ta4jElliottPlugin.java"
    ).read_text(encoding="utf-8")
    if "ElliottWaveAnalysisRunner.builder()" not in adapter_source:
        raise Phase5GateError(
            "ta4j adapter no longer calls the frozen public Elliott API"
        )
    if "package org.ta4j" in adapter_source:
        raise Phase5GateError(
            "ta4j adapter copied an upstream implementation namespace"
        )
    return {
        "schemaVersion": CONTRACT_SCHEMA_VERSION,
        "implementedOn": "2026-08-03",
        "phase4ContractSha256": _sha256_bytes(
            json.dumps(phase4_contract, sort_keys=True, separators=(",", ":")).encode()
        ),
        "provider": {
            "kind": "java-jar",
            "version": JAVA_JAR_PROVIDER_VERSION,
            "enabledFlag": JAVA_RUNTIME_ENABLED_ENV,
            "enabledDefault": False,
            "registeredWhenDisabled": list(
                default_runtime_provider_registry(java_enabled=False).kinds
            ),
            "registeredWhenEnabled": list(
                default_runtime_provider_registry(
                    java_enabled=True,
                    managed_runtime_registry=type(
                        "RegistryShape",
                        (),
                        {"ensure": lambda *_args, **_kwargs: None},
                    )(),
                ).kinds
            ),
            "policy": {
                "strictJar": True,
                "manifestAndDescriptorMainClass": True,
                "classFileJreCompatibility": True,
                "jvmArgumentAllowlist": True,
                "immutableArtifactDigest": True,
                "managedJreOnly": True,
                "sourceCompilation": False,
                "isolatedSearchPath": True,
                "wholeProcessTree": True,
                "maxProcesses": 1,
            },
        },
        "javaSdk": {
            "minimumSourceRelease": 17,
            "limits": {
                "messageBytes": 1_048_576,
                "depth": 32,
                "containerItems": 10_000,
                "stringBytes": 262_144,
                "safeInteger": 9_007_199_254_740_991,
            },
            "methods": [
                "activate",
                "cancel",
                "deactivate",
                "describe",
                "eventBatch",
                "handshake",
                "healthCheck",
                "invoke",
                "prepareUpgrade",
                "shutdown",
            ],
            "pythonParityTranscriptSha256": "sha256:d98ebd2fc9f5b0695925caf47ecf961eae47a56b5e8ec110f28acc9365afdd38",
            "stdoutProtocolIsolation": True,
            "stderrLogging": True,
            "hostCallCorrelation": True,
        },
        "runtimeRegistry": {
            "roots": len(roots),
            "revision": revision_2.revision,
            "revision1Sha256": revision_1.sha256,
            "previousRegistrySha256": revision_2.previous_registry_sha256,
            "registrySha256": revision_2.sha256,
            "runtimeId": release.runtime_id,
            "version": release.version,
            "archiveSha256": release.sha256,
            "archiveSize": release.size,
            "fileCount": release.file_count,
            "extractedSize": release.extracted_size,
            "legalFileCount": release.legal_file_count,
            "legalSize": release.legal_size,
            "evidenceRoles": sorted(EVIDENCE_ROLES),
            "rollbackToRevision1": True,
        },
        "referenceAdapter": {
            "pluginId": manifest["plugin"]["id"],
            "version": manifest["plugin"]["version"],
            "runtimeId": manifest["backend"]["entrypoints"][0]["runtime"]["runtimeId"],
            "mainClass": lock["adapter"]["mainClass"],
            "jarSha256": lock["adapter"]["releaseJarSha256"],
            "jarSize": lock["adapter"]["releaseJarSize"],
            "upstream": lock["upstream"],
            "dependencies": [
                {
                    key: item[key]
                    for key in ("name", "version", "sha256", "size", "license")
                }
                for item in lock["dependencies"]
            ],
            "legalArtifacts": list(ADAPTER_LEGAL_ARTIFACTS),
            "transcriptSha256": transcript["expected"]["transcriptSha256"],
            "transcriptResponses": len(transcript["expected"]["responseSha256"]),
            "goldenCasesSha256": golden["casesSha256"],
            "goldenCases": len(golden["cases"]),
            "pythonComparisonSha256": comparison["stableCasesSha256"],
            "automaticReplacement": comparison["policy"]["automaticReplacement"],
            "hindsightCalibration": comparison["policy"]["hindsightCalibration"],
            "hostOwnedMarketData": True,
            "directNetwork": False,
            "directDatabase": False,
            "upstreamAlgorithmCopied": False,
            "managerTrustMode": "local-trusted",
        },
        "validation": {
            "sdkIndependent": True,
            "adapterIndependent": True,
            "jarNegatives": True,
            "unicodeDecimalTimestampEmptyLong": True,
            "coldHot100Cancel": True,
            "crashOomHangStderr": True,
            "freshQuickFreshProcessUpdateRollback": True,
            "hostExitNoJavaResidue": True,
        },
        "rollback": {
            "flag": JAVA_RUNTIME_ENABLED_ENV,
            "value": False,
            "pythonRuntimeUnaffected": True,
            "platformV2Unaffected": True,
        },
    }


def validate_contract() -> dict[str, Any]:
    fixture = _strict_json(CONTRACT_PATH)
    current = capture_contract()
    if fixture != current:
        _ensure_import_paths()
        from candlescope_plugin_sdk.platform_v2 import canonical_sha256

        raise Phase5GateError(
            "multi-runtime Phase 5 contract drift: "
            f"fixture={canonical_sha256(fixture)} current={canonical_sha256(current)}"
        )
    return fixture


def validate_real_gate_evidence() -> dict[str, Any]:
    evidence = _strict_json(REAL_EVIDENCE_PATH)
    if (
        evidence.get("schemaVersion") != REAL_GATE_SCHEMA_VERSION
        or evidence.get("result") != "pass"
    ):
        raise Phase5GateError("recorded Phase 5 real-JRE gate is missing or failed")
    contract = capture_contract()
    if evidence.get("contractSha256") != _sha256_bytes(
        json.dumps(contract, sort_keys=True, separators=(",", ":")).encode()
    ):
        raise Phase5GateError("recorded Phase 5 real-JRE gate targets another contract")
    stable = evidence.get("stable")
    if (
        not isinstance(stable, dict)
        or stable.get("adapterJarSha256") != contract["referenceAdapter"]["jarSha256"]
    ):
        raise Phase5GateError("recorded Phase 5 artifact identity drifted")
    if stable.get("registrySha256") != contract["runtimeRegistry"]["registrySha256"]:
        raise Phase5GateError("recorded Phase 5 JRE registry identity drifted")
    if (
        stable.get("transcriptSha256")
        != contract["referenceAdapter"]["transcriptSha256"]
    ):
        raise Phase5GateError("recorded Phase 5 transcript identity drifted")
    build = evidence.get("build")
    if (
        not isinstance(build, dict)
        or build.get("adapterCasesSha256")
        != contract["referenceAdapter"]["goldenCasesSha256"]
        or build.get("adapterBoundaries")
        != {
            "maxBarsAnalyzed": 5000,
            "maxTimestampSeconds": 253_402_297_199,
            "numericType": "DecimalNum",
            "overMaxBarsRejected": True,
        }
        or build.get("adapterLegalArtifacts")
        != contract["referenceAdapter"]["legalArtifacts"]
    ):
        raise Phase5GateError("recorded Phase 5 independent Adapter gate is incomplete")
    return evidence


class _LocalEvidenceFetcher:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve(strict=True)
        self.calls: list[str] = []

    def fetch(self, url: str, destination: Path, *, maximum: int) -> None:
        self.calls.append(url)
        source = self.root / url.rsplit("/", 1)[-1]
        if not source.is_file() or source.is_symlink():
            raise Phase5GateError(f"missing frozen JRE evidence: {source.name}")
        payload = source.read_bytes()
        if len(payload) > maximum:
            raise Phase5GateError("frozen JRE evidence exceeds signed maximum")
        destination.write_bytes(payload)


def _run_checked(
    command: Sequence[str], *, cwd: Path = REPOSITORY_ROOT, timeout: float = 120
) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(
        tuple(command),
        cwd=cwd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        timeout=timeout,
        check=False,
    )
    if completed.returncode:
        raise Phase5GateError(
            f"command failed ({completed.returncode}): {' '.join(command)}\n{completed.stderr[-4000:]}"
        )
    return completed


def _java_tool(jdk_home: Path, name: str) -> Path:
    path = jdk_home / "bin" / (name + (".exe" if os.name == "nt" else ""))
    if not path.is_file() or path.is_symlink():
        raise Phase5GateError(f"missing exact JDK tool: {path}")
    return path.resolve()


def _build_checks(jdk_home: Path, dependency_cache: Path, root: Path) -> dict[str, Any]:
    sdk = _run_checked(
        (
            sys.executable,
            str(JAVA_SDK / "scripts" / "check.py"),
            "--jdk-home",
            str(jdk_home),
            "--python-transcript",
            str(
                REPOSITORY_ROOT
                / "packages"
                / "candlescope-plugin-sdk"
                / "tests"
                / "fixtures"
                / "hello_command_transcript_v2.json"
            ),
        )
    )
    adapter = _run_checked(
        (
            sys.executable,
            str(REFERENCE / "scripts" / "check.py"),
            "--jdk-home",
            str(jdk_home),
            "--dependency-cache",
            str(dependency_cache),
        ),
        timeout=120,
    )
    adapter_report = json.loads(adapter.stdout)
    outputs = []
    for index in range(2):
        output = root / f"repro-{index}.jar"
        completed = _run_checked(
            (
                sys.executable,
                str(REFERENCE / "scripts" / "build_release.py"),
                "--jdk-home",
                str(jdk_home),
                "--dependency-cache",
                str(dependency_cache),
                "--output",
                str(output),
            )
        )
        report = json.loads(completed.stdout)
        outputs.append((report["output"]["sha256"], report["output"]["size"]))
    if len(set(outputs)) != 1:
        raise Phase5GateError("two clean adapter builds are not byte reproducible")
    expected = _strict_json(REFERENCE / "supply-chain.lock.json")["adapter"]
    if outputs[0] != (expected["releaseJarSha256"], expected["releaseJarSize"]):
        raise Phase5GateError(
            "reproducible adapter build differs from the fixed Release JAR"
        )
    return {
        "sdk": sdk.stdout.strip(),
        "adapterCasesSha256": adapter_report["casesSha256"],
        "adapterBoundaries": adapter_report["boundaries"],
        "adapterLegalArtifacts": adapter_report["legalArtifacts"],
        "reproducibleBuilds": 2,
        "outputSha256": outputs[0][0],
        "outputSize": outputs[0][1],
    }


def _bar_data(count: int) -> list[Any]:
    _ensure_import_paths()
    import math
    from app.data_engine.data_manager.models import BarData

    rows = []
    previous = 100.0
    for index in range(count):
        close = (
            100.0
            + index * 0.025
            + math.sin(index / 17.0) * 8.0
            + math.sin(index / 5.0) * 3.0
        )
        rows.append(
            BarData(
                time=1_704_067_200 + index * 3600,
                open=previous,
                high=max(previous, close) + 0.8,
                low=min(previous, close) - 0.8,
                close=close,
                volume=1000.0 + (index % 23) * 17.0,
                quote_volume=(1000.0 + (index % 23) * 17.0) * close,
                trades=10,
                taker_buy_base=500.0,
                taker_buy_quote=500.0 * close,
                is_closed=True,
                source="phase5-golden",
            )
        )
        previous = close
    return rows


class _MarketPort:
    def __init__(self) -> None:
        self.read_calls = 0
        self.started = asyncio.Event()
        self.block: asyncio.Event | None = None

    async def list_symbols(self, _request: Any) -> tuple[list[dict[str, str]], float]:
        return ([{"symbol": "BTCUSDT", "baseAsset": "BTC", "quoteAsset": "USDT"}], 0.0)

    async def read_bars(self, request: Any) -> Any:
        from app.data_engine.data_manager.models import QueryResult, QuerySource

        self.read_calls += 1
        self.started.set()
        if self.block is not None:
            await self.block.wait()
        rows = _bar_data(min(request.limit, 120))
        return QueryResult(
            bars=rows,
            symbol=request.series.symbol,
            interval=request.series.interval,
            source=QuerySource.CACHE,
            total=len(rows),
            metadata={"all_rows_final": True, "verified_contiguous": True},
            complete=True,
        )

    async def subscribe_bars(self, *_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("reference adapter must not subscribe to bars")

    async def unsubscribe_bars(self, *_args: Any, **_kwargs: Any) -> None:
        return None

    async def read_trades(self, *_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("reference adapter must not read trades")

    async def read_order_book(self, *_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("reference adapter must not read the order book")


def _process_exited(process_id: int) -> bool:
    if os.name != "nt":
        try:
            os.kill(process_id, 0)
        except ProcessLookupError:
            return True
        except PermissionError:
            return False
        return False
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    handle = kernel32.OpenProcess(0x00100000, False, process_id)
    if not handle:
        return True
    try:
        return kernel32.WaitForSingleObject(handle, 0) == 0
    finally:
        kernel32.CloseHandle(handle)


async def _wait_exited(process_id: int) -> bool:
    for _ in range(150):
        if _process_exited(process_id):
            return True
        await asyncio.sleep(0.02)
    return _process_exited(process_id)


def _input(trace: int | str) -> dict[str, Any]:
    return {
        "market": {
            "context": {"mode": "live", "exchange": "binance", "marketType": "spot"},
            "series": {"symbol": "BTCUSDT", "interval": "1h"},
            "limit": 120,
        },
        "settings": {
            "degree": "MINUTE",
            "logicProfile": "ORTHODOX_CLASSICAL",
            "higherDegrees": 0,
            "lowerDegrees": 0,
            "minConfidence": 0.0,
            "maxScenarios": 5,
            "scenarioSwingWindow": 0,
        },
    }


async def _runtime_lifecycle(product_root: Path, registry: Any) -> dict[str, Any]:
    from app.plugin_core_v2.runtime import CorePluginPlatform

    port = _MarketPort()
    platform = CorePluginPlatform(
        root=product_root,
        host_name="CandleScope",
        host_version="0.4.0",
        multi_runtime_enabled=True,
        runtime_provider_seam_enabled=True,
        java_runtime_enabled=True,
        managed_runtime_registry=registry,
    )
    platform.bind_market_data(port)
    await platform.start()
    process_id = 0
    first_ms = 0.0
    hot_samples: list[float] = []
    digest = None
    try:
        started = time.perf_counter()
        first = await platform.invoke_command(
            f"{JAVA_PLUGIN_ID}.{JAVA_CONTRIBUTION_ID}",
            _input("cold"),
            user_action=True,
            trace_id="phase5-cold",
        )
        first_ms = (time.perf_counter() - started) * 1000
        if first.get("schemaVersion") != "candlescope.elliott-wave-analysis/1":
            raise Phase5GateError("real Java adapter returned another result schema")
        _ensure_import_paths()
        from candlescope_plugin_sdk.platform_v2 import canonical_sha256

        digest = canonical_sha256(first)
        for index in range(100):
            started = time.perf_counter()
            result = await platform.invoke_command(
                f"{JAVA_PLUGIN_ID}.{JAVA_CONTRIBUTION_ID}",
                _input(index),
                user_action=True,
                trace_id=f"phase5-hot-{index}",
            )
            hot_samples.append((time.perf_counter() - started) * 1000)
            if canonical_sha256(result) != digest:
                raise Phase5GateError("100-call Java result digest changed")
        port.started.clear()
        port.block = asyncio.Event()
        cancel_input = _input("cancel")
        # Use a distinct Host read key so the short-lived market coordinator
        # cache cannot turn the cancellation probe into an immediate success.
        cancel_input["market"]["limit"] = 119
        invocation = asyncio.create_task(
            platform.invoke_command(
                f"{JAVA_PLUGIN_ID}.{JAVA_CONTRIBUTION_ID}",
                cancel_input,
                user_action=True,
                trace_id="phase5-cancel",
            )
        )
        started_wait = asyncio.create_task(port.started.wait())
        done, _pending = await asyncio.wait(
            {invocation, started_wait},
            timeout=5,
            return_when=asyncio.FIRST_COMPLETED,
        )
        if started_wait not in done:
            started_wait.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await started_wait
            if invocation in done:
                await invocation
                raise Phase5GateError(
                    "cancellation probe returned before its Host market call"
                )
            invocation.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await invocation
            raise Phase5GateError(
                "cancellation probe did not reach its Host market call"
            )
        invocation.cancel()
        try:
            await invocation
        except asyncio.CancelledError:
            pass
        else:
            raise Phase5GateError("cancelled Java invocation returned a result")
        port.block.set()
        port.block = None
        await asyncio.sleep(0.1)
        supervisor = platform.manager.supervisor(JAVA_PLUGIN_ID, "main")
        health = await supervisor.health_check()
        snapshot = supervisor.snapshot()
        process_id = snapshot["transport"]["pid"]
        if health.get("pending") != 0 or not isinstance(process_id, int):
            raise Phase5GateError("Java cancellation left a pending operation")
        catalog = next(
            item
            for item in platform.catalog()["plugins"]
            if item["id"] == JAVA_PLUGIN_ID
        )
        runtime = catalog["runtime"]["entrypoints"][0]
        if (
            runtime["runtimeKind"] != "java-jar"
            or runtime["runtimeId"] != JAVA_RUNTIME_ID
            or runtime["runtimeSupply"]["version"] != "25.0.4+7-LTS"
            or runtime["runtimeSupply"]["verificationStatus"] != "verified"
            or catalog["trustLevel"] != "local-trusted"
        ):
            raise Phase5GateError("Plugin Manager runtime provenance is incomplete")
    finally:
        await platform.stop()
    if process_id and not await _wait_exited(process_id):
        raise Phase5GateError("Host stop left the adapter java.exe alive")
    if platform.manager.owner_keys():
        raise Phase5GateError("Host stop retained a Java supervisor")
    ordered = sorted(hot_samples)
    return {
        "coldInvokeMs": round(first_ms, 3),
        "hotCalls": len(hot_samples),
        "hotMedianMs": round(ordered[len(ordered) // 2], 3),
        "hotP95Ms": round(ordered[int(len(ordered) * 0.95) - 1], 3),
        "resultSha256": digest,
        "cancelled": True,
        "healthPending": 0,
        "marketReadCalls": port.read_calls,
        "processTreeControl": bool(snapshot["transport"]["processTreeControl"]),
        "residualProcesses": 0,
        "residualSupervisors": 0,
        "manager": {
            "runtimeKind": runtime["runtimeKind"],
            "runtimeId": runtime["runtimeId"],
            "jreVersion": runtime["runtimeSupply"]["version"],
            "trustMode": catalog["trustLevel"],
            "verificationStatus": runtime["runtimeSupply"]["verificationStatus"],
            "upstreamSourceUrl": runtime["runtimeSupply"]["sourceUrl"],
            "artifactSha256": runtime["artifactSha256"],
        },
    }


def _fault_jar(path: Path, classes: Path, main_class: str) -> None:
    manifest = f"Manifest-Version: 1.0\r\nMain-Class: {main_class}\r\n\r\n".encode()
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        values = {"META-INF/MANIFEST.MF": manifest}
        for source in classes.rglob("JvmFaultFixtures*.class"):
            values[source.relative_to(classes).as_posix()] = source.read_bytes()
        for name, payload in sorted(values.items()):
            info = zipfile.ZipInfo(name, (2026, 8, 3, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, payload)


async def _fault_matrix(root: Path, jdk_home: Path, registry: Any) -> dict[str, str]:
    _ensure_import_paths()
    from candlescope_plugin_sdk.platform_v2 import JavaJarRuntime, PluginManifest
    from app.plugin_core_v2.runtime_providers import JavaJarProvider
    from app.plugin_host import (
        EntrypointProcessSpec,
        EntrypointSupervisor,
        PlatformHostTransportError,
    )
    from tests.plugin_platform_java_testkit import build_java_reference_bundle

    classes = root / "fault-classes"
    classes.mkdir(parents=True)
    _run_checked(
        (
            str(_java_tool(jdk_home, "javac")),
            "-encoding",
            "UTF-8",
            "-g:none",
            "--release",
            "25",
            "-d",
            str(classes),
            str(
                JAVA_SDK
                / "src"
                / "test"
                / "java"
                / "io"
                / "candlescope"
                / "plugin"
                / "sdk"
                / "v2"
                / "JvmFaultFixtures.java"
            ),
        )
    )
    expected = {
        "Crash": "PLUGIN_PLATFORM_EXITED",
        "Hang": "PLUGIN_PLATFORM_TIMEOUT",
        # Temurin 25's ExitOnOutOfMemoryError banner is emitted on stdout on
        # Windows.  The Host therefore fail-closes it as protocol pollution
        # before the EOF observer wins the race.
        "OutOfMemory": "PLUGIN_PLATFORM_RESPONSE_INVALID_JSON",
        "StderrFlood": "PLUGIN_PLATFORM_STDERR_LIMIT_EXCEEDED",
    }
    observed: dict[str, str] = {}
    provider = JavaJarProvider(registry)
    for mode, expected_code in expected.items():
        installation = root / f"fault-{mode}"
        jar = installation / "content" / "runtime" / "fault.jar"
        main_class = f"io.candlescope.plugin.sdk.v2.JvmFaultFixtures${mode}"
        _fault_jar(jar, classes, main_class)
        digest = _sha256_path(jar)
        runtime = JavaJarRuntime(
            artifact="runtime/fault.jar",
            runtime_id=JAVA_RUNTIME_ID,
            main_class=main_class,
            jvm_args=("-Xms16m", "-Xmx64m", "-XX:+UseSerialGC"),
        )
        prepared = provider.prepare_runtime(
            runtime=runtime,
            executable=jar,
            working_directory=installation,
            artifact_sha256=digest,
        )
        launch = provider.build_runtime_launch(prepared)
        manifest_value = build_java_reference_bundle(root / f"manifest-{mode}").manifest
        manifest_value["backend"]["entrypoints"][0]["runtime"] = runtime.to_wire()
        manifest_value["probes"] = []
        manifest = PluginManifest.from_wire(manifest_value)
        supervisor = EntrypointSupervisor(
            EntrypointProcessSpec(
                plugin_id=JAVA_PLUGIN_ID,
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
                raise Phase5GateError(f"JVM fault {mode} unexpectedly handshook")
        finally:
            await supervisor.stop()
        if observed.get(mode) != expected_code:
            raise Phase5GateError(
                f"JVM fault {mode} diagnostic changed: {observed.get(mode)} != {expected_code}"
            )
    return observed


async def _real_gate_async(
    *,
    root: Path,
    jdk_home: Path,
    dependency_cache: Path,
    jre_evidence_directory: Path,
) -> dict[str, Any]:
    _ensure_import_paths()
    from app.plugin_installer_v2.installer import PlatformPluginInstaller
    from app.plugin_installer_v2.registry import load_activation_registry
    from app.plugin_runtime_registry_v3 import (
        OFFICIAL_REGISTRY_V2_PATH,
        RuntimeRegistryError,
        build_official_runtime_registry,
    )
    from tests.plugin_platform_java_testkit import build_java_reference_bundle

    build = _build_checks(jdk_home, dependency_cache, root / "build")
    fetcher = _LocalEvidenceFetcher(jre_evidence_directory)
    runtime_root = root / "managed-runtimes"
    registry = build_official_runtime_registry(
        root=runtime_root,
        enabled=True,
        network_updates_enabled=False,
        fetcher=fetcher,
    )
    first = registry.ensure(JAVA_RUNTIME_ID, "java")
    repeat = registry.ensure(JAVA_RUNTIME_ID, "java")
    offline = registry.ensure(JAVA_RUNTIME_ID, "java", offline=True)
    if (
        first.quick_repeat
        or not repeat.quick_repeat
        or not offline.quick_repeat
        or len(fetcher.calls) != 5
    ):
        raise Phase5GateError("real JRE first/repeat/offline semantics changed")
    initial = build_java_reference_bundle(root / "bundle-initial")
    product = root / "product"
    installer = PlatformPluginInstaller(
        root=product,
        multi_runtime_enabled=True,
        runtime_provider_seam_enabled=True,
        java_runtime_enabled=True,
        managed_runtime_registry=registry,
    )
    installed = installer.install(
        initial.bundle.path, expected_sha256=initial.bundle.sha256, enabled=True
    )
    for permission in initial.bundle.manifest.permissions.required:
        installer.grant_permission(
            installed.plugin_id, permission.id, scope=permission.scope
        )
    enabled = installer.enable(installed.plugin_id)
    repeated = installer.install(
        initial.bundle.path, expected_sha256=initial.bundle.sha256, enabled=True
    )
    checked = installer.check(installed.plugin_id)
    if (
        enabled.state != "active"
        or not repeated.reused_installation
        or checked.state != "active"
    ):
        raise Phase5GateError("Java fresh install/quick repeat/check did not converge")
    updated = build_java_reference_bundle(
        root / "bundle-update", update_marker="phase5-update-1"
    )
    update_result = installer.install(
        updated.bundle.path,
        expected_sha256=updated.bundle.sha256,
        enabled=True,
    )
    if update_result.state != "active":
        raise Phase5GateError("Java update did not preserve active state")
    rollback = installer.rollback(JAVA_PLUGIN_ID)
    record = load_activation_registry(installer.registry_path).by_id()[JAVA_PLUGIN_ID]
    if (
        record.bundle_sha256 != initial.bundle.sha256
        or record.installation_id != installed.installation_id
    ):
        raise Phase5GateError(
            "Java activation rollback did not restore the initial bundle"
        )
    lifecycle = await _runtime_lifecycle(product, registry)
    disabled_platform = __import__(
        "app.plugin_core_v2.runtime", fromlist=["CorePluginPlatform"]
    ).CorePluginPlatform(
        root=product,
        host_name="CandleScope",
        host_version="0.4.0",
        multi_runtime_enabled=True,
        runtime_provider_seam_enabled=True,
        java_runtime_enabled=False,
        managed_runtime_registry=registry,
    )
    await disabled_platform.start()
    try:
        catalog = next(
            item
            for item in disabled_platform.catalog()["plugins"]
            if item["id"] == JAVA_PLUGIN_ID
        )
        if catalog["available"] or disabled_platform.manager.owner_keys():
            raise Phase5GateError("Java rollback flag found a launch fallback")
        disabled = {
            "available": False,
            "reason": catalog["unavailableReason"],
            "supervisors": 0,
        }
    finally:
        await disabled_platform.stop()
    faults = await _fault_matrix(root / "faults", jdk_home, registry)
    rolled_registry = registry.rollback_registry()
    try:
        registry.ensure(JAVA_RUNTIME_ID, "java", offline=True)
    except RuntimeRegistryError as exc:
        unavailable_code = exc.code
    else:
        raise Phase5GateError(
            "registry rollback unexpectedly retained the JRE 25 release"
        )
    restored_registry = registry.activate_registry(
        OFFICIAL_REGISTRY_V2_PATH.read_bytes()
    )
    registry.ensure(JAVA_RUNTIME_ID, "java", offline=True)
    return {
        "schemaVersion": REAL_GATE_SCHEMA_VERSION,
        "generatedAt": "2026-08-03T00:00:00Z",
        "result": "pass",
        "contractSha256": _sha256_bytes(
            json.dumps(
                capture_contract(), sort_keys=True, separators=(",", ":")
            ).encode()
        ),
        "stable": {
            "adapterJarSha256": capture_contract()["referenceAdapter"]["jarSha256"],
            "registrySha256": capture_contract()["runtimeRegistry"]["registrySha256"],
            "transcriptSha256": capture_contract()["referenceAdapter"][
                "transcriptSha256"
            ],
            "goldenCasesSha256": capture_contract()["referenceAdapter"][
                "goldenCasesSha256"
            ],
            "comparisonSha256": capture_contract()["referenceAdapter"][
                "pythonComparisonSha256"
            ],
        },
        "build": build,
        "jre": {
            "runtimeId": first.release.runtime_id,
            "version": first.release.version,
            "archiveSha256": first.release.sha256,
            "firstDownloadedFiles": first.downloaded_files,
            "repeatQuick": repeat.quick_repeat,
            "offlineQuick": offline.quick_repeat,
            "downloadUrls": fetcher.calls,
            "probeSha256": first.probe.sha256,
            "fileCount": first.release.file_count,
            "extractedSize": first.release.extracted_size,
            "legalFileCount": first.release.legal_file_count,
            "evidence": [item.to_wire() for item in first.release.evidence],
        },
        "installation": {
            "bundleSha256": initial.bundle.sha256,
            "receiptSchema": 4,
            "state": checked.state,
            "freshProcessProbe": checked.probe["semanticProbes"][0]["sha256"],
            "quickRepeat": repeated.reused_installation,
            "runtimeSupply": record.entrypoints[0].runtime_supply.to_wire(),
            "updateBundleSha256": updated.bundle.sha256,
            "updateState": update_result.state,
            "rollbackBundleSha256": record.bundle_sha256,
            "rollbackRemoved": rollback.removed,
        },
        "runtime": lifecycle,
        "faults": faults,
        "disabled": disabled,
        "registryRollback": {
            "toRevision": rolled_registry["toRevision"],
            "java25UnavailableCode": unavailable_code,
            "restoredRevision": restored_registry["revision"],
        },
    }


def run_real_gate(
    *,
    jdk_home: Path,
    dependency_cache: Path,
    jre_evidence_directory: Path,
) -> dict[str, Any]:
    if os.name != "nt":
        raise Phase5GateError("Phase 5 real release gate requires Windows")
    with tempfile.TemporaryDirectory(prefix="candlescope-phase5-real-") as value:
        return asyncio.run(
            _real_gate_async(
                root=Path(value),
                jdk_home=jdk_home.resolve(strict=True),
                dependency_cache=dependency_cache.resolve(strict=True),
                jre_evidence_directory=jre_evidence_directory.resolve(strict=True),
            )
        )


def run_gate() -> dict[str, Any]:
    contract = validate_contract()
    real = validate_real_gate_evidence()
    return {
        "schemaVersion": GATE_SCHEMA_VERSION,
        "result": "pass",
        "contractSha256": _sha256_bytes(
            json.dumps(contract, sort_keys=True, separators=(",", ":")).encode()
        ),
        "realEvidenceSha256": _sha256_path(REAL_EVIDENCE_PATH),
        "real": {
            "runtimeId": real["jre"]["runtimeId"],
            "hotCalls": real["runtime"]["hotCalls"],
            "faults": real["faults"],
            "residualProcesses": real["runtime"]["residualProcesses"],
        },
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
    parser.add_argument("--dependency-cache", type=Path)
    parser.add_argument("--jre-evidence-directory", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    if args.print_contract and args.run_real:
        parser.error("choose either --print-contract or --run-real")
    if args.print_contract:
        value = capture_contract()
    elif args.run_real:
        if (
            args.jdk_home is None
            or args.dependency_cache is None
            or args.jre_evidence_directory is None
        ):
            parser.error("--run-real requires JDK, dependency cache and JRE evidence")
        value = run_real_gate(
            jdk_home=args.jdk_home,
            dependency_cache=args.dependency_cache,
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
