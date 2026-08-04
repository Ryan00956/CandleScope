#!/usr/bin/env python3
"""Produce fresh ta4j point-in-time comparison and performance evidence."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import statistics
import subprocess
import sys
import tempfile
import threading
import time
from datetime import UTC, datetime
from pathlib import Path
from types import ModuleType
from typing import Any


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
REFERENCE = REPOSITORY_ROOT / "examples/plugins/ta4j-elliott-adapter"
COMPARE_SCRIPT = REFERENCE / "scripts/compare_python_plugin.py"
FROZEN_COMPARISON = REFERENCE / "evidence/python-comparison.json"
GOLDEN_CORPUS = REFERENCE / "evidence/golden-corpus.json"
SUPPLY_LOCK = REFERENCE / "supply-chain.lock.json"
PHASE5_CONTRACT = (
    REPOSITORY_ROOT
    / "backend/tests/fixtures/plugin_platform_multi_runtime/phase5_contract_v1.json"
)
DEFAULT_JAR = REFERENCE / "runtime/ta4j-elliott-adapter-0.1.0.jar"
DEFAULT_OUTPUT = (
    REPOSITORY_ROOT / "docs/evidence/plugin-platform-multi-runtime-phase11-ta4j.json"
)
SCHEMA = "candlescope.plugin-platform.multi-runtime.phase11-ta4j/1"
MAX_COLD_MS = 10_000.0
MAX_HOT_P95_MS = 2_000.0
MAX_LONG_MS = 10_000.0
MAX_PEAK_RSS_BYTES = 768 * 1024 * 1024


class Ta4jEvidenceError(RuntimeError):
    pass


def _strict_json(path: Path) -> dict[str, Any]:
    def reject_constant(value: str) -> None:
        raise ValueError(f"invalid JSON number: {value}")

    if path.is_symlink() or not path.is_file():
        raise Ta4jEvidenceError(f"required ta4j artifact is missing: {path}")
    value = json.loads(path.read_text(encoding="utf-8"), parse_constant=reject_constant)
    if not isinstance(value, dict):
        raise Ta4jEvidenceError(f"ta4j evidence is not an object: {path}")
    return value


def _sha256_path(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def _canonical_sha256(value: Any) -> str:
    payload = json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(payload).hexdigest()


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


def _load_compare_module() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "candlescope_phase11_ta4j_compare", COMPARE_SCRIPT
    )
    if spec is None or spec.loader is None:
        raise Ta4jEvidenceError("cannot load ta4j comparison module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_comparison(
    *, python: Path, java: Path, jar: Path, plugin_root: Path, output: Path
) -> dict[str, Any]:
    completed = subprocess.run(
        (
            str(python),
            str(COMPARE_SCRIPT),
            "--java",
            str(java),
            "--jar",
            str(jar),
            "--python-plugin-root",
            str(plugin_root),
            "--output",
            str(output),
        ),
        cwd=REPOSITORY_ROOT,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        timeout=300,
        check=False,
        shell=False,
    )
    if completed.returncode:
        raise Ta4jEvidenceError(
            "fresh ta4j comparison failed:\n" + completed.stdout[-8000:]
        )
    return _strict_json(output)


def _git_state(plugin_root: Path) -> dict[str, Any]:
    head = subprocess.run(
        ("git", "rev-parse", "HEAD"),
        cwd=plugin_root,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    ).stdout.strip()
    dirty = subprocess.run(
        ("git", "status", "--porcelain"),
        cwd=plugin_root,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    ).stdout.strip()
    if dirty:
        raise Ta4jEvidenceError(
            "Python Elliott comparison source worktree is not clean"
        )
    return {"commit": head, "clean": True}


def _percentile(values: list[float], percentile: float) -> float:
    ordered = sorted(values)
    index = max(
        0, min(len(ordered) - 1, int((len(ordered) - 1) * percentile + 0.999999))
    )
    return round(ordered[index], 3)


def _performance(java: Path, jar: Path) -> dict[str, Any]:
    try:
        import psutil
    except ImportError as exc:
        raise Ta4jEvidenceError("ta4j performance evidence requires psutil") from exc
    module = _load_compare_module()
    adapter_started = time.perf_counter()
    adapter = module.JavaAdapter(java, jar)
    startup_ms = (time.perf_counter() - adapter_started) * 1000
    process = psutil.Process(adapter.process.pid)
    peak_rss = process.memory_info().rss
    stop_monitor = threading.Event()

    def monitor() -> None:
        nonlocal peak_rss
        while not stop_monitor.wait(0.01):
            try:
                peak_rss = max(peak_rss, process.memory_info().rss)
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                return

    monitor_thread = threading.Thread(
        target=monitor, name="phase11-ta4j-rss", daemon=True
    )
    monitor_thread.start()
    exit_code = -1
    stderr = ""
    try:
        medium_page = module.page(module.sine_trend(240))
        cold_result, cold_ms = adapter.analyze("phase11-cold-240", medium_page)
        hot_ms: list[float] = []
        hot_hashes: set[str] = set()
        for index in range(20):
            result, elapsed = adapter.analyze(f"phase11-hot-{index}", medium_page)
            hot_ms.append(elapsed)
            hot_hashes.add(_canonical_sha256(result))
        long_page = module.page(module.sine_trend(5_000))
        long_result, long_ms = adapter.analyze("phase11-long-5000", long_page)
    finally:
        stop_monitor.set()
        monitor_thread.join(timeout=2)
        exit_code, stderr = adapter.close()
    stderr_lines = [line for line in stderr.splitlines() if line]
    stderr_safe = (
        len(stderr.encode("utf-8")) <= 4_096
        and all(line.startswith("SLF4J(W):") for line in stderr_lines)
        and not any(
            marker in stderr.upper()
            for marker in ("PASSWORD=", "TOKEN=", "SECRET=", "API_KEY=")
        )
    )
    checks = {
        "cleanExit": exit_code == 0,
        "stderrBoundedAndKnown": stderr_safe,
        "hotDeterministic": len(hot_hashes) == 1,
        "coldMatchesHot": _canonical_sha256(cold_result) in hot_hashes,
        "startupBudget": startup_ms <= MAX_COLD_MS,
        "hotP95Budget": _percentile(hot_ms, 0.95) <= MAX_HOT_P95_MS,
        "longBudget": long_ms <= MAX_LONG_MS,
        "rssBudget": peak_rss <= MAX_PEAK_RSS_BYTES,
        "longResult": isinstance(long_result.get("scenarios"), list),
    }
    failed = sorted(key for key, passed in checks.items() if not passed)
    if failed:
        observed = {
            "exitCode": exit_code,
            "stderrTail": stderr[-500:],
            "startupMs": round(startup_ms, 3),
            "hotP95Ms": _percentile(hot_ms, 0.95),
            "longMs": round(long_ms, 3),
            "peakRssBytes": peak_rss,
            "hotHashCount": len(hot_hashes),
        }
        raise Ta4jEvidenceError(
            f"ta4j performance gate failed: {failed}; observed={observed}"
        )
    return {
        "processExitCode": exit_code,
        "stderrBytes": len(stderr.encode("utf-8")),
        "stderrLines": len(stderr_lines),
        "stderrSha256": "sha256:" + hashlib.sha256(stderr.encode("utf-8")).hexdigest(),
        "stderrProtocolPollution": False,
        "startupMs": round(startup_ms, 3),
        "coldInvoke240Ms": round(cold_ms, 3),
        "hotCalls": len(hot_ms),
        "hotMedianMs": round(statistics.median(hot_ms), 3),
        "hotP95Ms": _percentile(hot_ms, 0.95),
        "hotMaxMs": round(max(hot_ms), 3),
        "hotOutputSha256": next(iter(hot_hashes)),
        "longBars": 5_000,
        "longInvokeMs": round(long_ms, 3),
        "longOutputSha256": _canonical_sha256(long_result),
        "longScenarioCount": len(long_result["scenarios"]),
        "peakRssBytes": peak_rss,
        "thresholds": {
            "maxStartupMs": MAX_COLD_MS,
            "maxHotP95Ms": MAX_HOT_P95_MS,
            "maxLongMs": MAX_LONG_MS,
            "maxPeakRssBytes": MAX_PEAK_RSS_BYTES,
        },
    }


def run(args: argparse.Namespace) -> dict[str, Any]:
    java = args.java.resolve(strict=True)
    jar = args.jar.resolve(strict=True)
    plugin_root = args.python_plugin_root.resolve(strict=True)
    frozen = _strict_json(FROZEN_COMPARISON)
    golden = _strict_json(GOLDEN_CORPUS)
    supply = _strict_json(SUPPLY_LOCK)
    contract = _strict_json(PHASE5_CONTRACT)
    git = _git_state(plugin_root)
    with tempfile.TemporaryDirectory(prefix="candlescope-phase11-ta4j-") as raw:
        fresh_path = Path(raw) / "comparison.json"
        fresh = _run_comparison(
            python=args.python.resolve(strict=True),
            java=java,
            jar=jar,
            plugin_root=plugin_root,
            output=fresh_path,
        )
        fresh_receipt_sha256 = _sha256_path(fresh_path)
    cases = fresh.get("cases", [])
    if (
        fresh.get("schemaVersion") != "candlescope.elliott-engine-comparison/1"
        or fresh.get("stableCasesSha256") != frozen.get("stableCasesSha256")
        or fresh.get("engines", {}).get("python", {}).get("commit") != git["commit"]
        or len(cases) != 5
        or any(
            case.get("comparison", {}).get("bothPointInTime") is not True
            or case.get("comparison", {}).get("futurePivotCount") != 0
            for case in cases
        )
        or fresh.get("policy", {}).get("automaticReplacement") is not False
        or fresh.get("policy", {}).get("hindsightCalibration") is not False
    ):
        raise Ta4jEvidenceError("fresh ta4j point-in-time comparison changed")
    if golden.get("casesSha256") != contract.get("referenceAdapter", {}).get(
        "goldenCasesSha256"
    ):
        raise Ta4jEvidenceError(
            "ta4j golden corpus is not bound by the frozen Phase 5 contract"
        )
    artifact_digest = _sha256_path(jar)
    if artifact_digest != supply.get("adapter", {}).get("releaseJarSha256"):
        raise Ta4jEvidenceError("ta4j adapter JAR differs from the frozen supply lock")
    performance = _performance(java, jar)
    result = {
        "schemaVersion": SCHEMA,
        "result": "pass",
        "generatedAt": datetime.now(UTC)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z"),
        "target": {"os": "windows", "arch": "x86_64", "java": java.name},
        "upstream": {
            "repository": supply["upstream"]["repository"],
            "tag": supply["upstream"]["tag"],
            "tagObject": supply["upstream"]["tagObject"],
            "commit": supply["upstream"]["commit"],
            "version": supply["upstream"]["tag"],
            "jarSha256": artifact_digest,
        },
        "pythonReference": git,
        "pointInTime": {
            "caseCount": len(cases),
            "caseIds": [case["id"] for case in cases],
            "futurePivotCount": sum(
                case["comparison"]["futurePivotCount"] for case in cases
            ),
            "samePointInTimeInput": fresh["policy"]["samePointInTimeInput"],
            "hindsightCalibration": fresh["policy"]["hindsightCalibration"],
            "automaticReplacement": fresh["policy"]["automaticReplacement"],
            "stableCasesSha256": fresh["stableCasesSha256"],
            "goldenCasesSha256": golden["casesSha256"],
            "freshReceiptSha256": fresh_receipt_sha256,
            "rawOutputSha256": {
                case["id"]: case["ta4j"]["outputSha256"] for case in cases
            },
        },
        "performance": performance,
        "conclusion": fresh["conclusion"],
    }
    _atomic_json(args.output.resolve(strict=False), result)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python", type=Path, default=Path(sys.executable))
    parser.add_argument("--java", type=Path, required=True)
    parser.add_argument("--jar", type=Path, default=DEFAULT_JAR)
    parser.add_argument("--python-plugin-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    result = run(parser.parse_args())
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (Ta4jEvidenceError, OSError, ValueError, json.JSONDecodeError) as exc:
        print(
            json.dumps(
                {"ok": False, "errorType": type(exc).__name__, "message": str(exc)},
                ensure_ascii=False,
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        raise SystemExit(1) from exc
