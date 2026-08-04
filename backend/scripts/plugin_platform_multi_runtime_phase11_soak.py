#!/usr/bin/env python3
"""Run the real five-plugin Phase 11 soak; release mode requires four wall-clock hours."""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import statistics
import sys
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

try:
    from .plugin_platform_multi_runtime_phase11_support import (
        active_processes,
        canonical_sha256,
        invoke_all,
        process_metrics,
        start_multi_runtime_platform,
    )
except ImportError:  # Direct script execution.
    from plugin_platform_multi_runtime_phase11_support import (
        active_processes,
        canonical_sha256,
        invoke_all,
        process_metrics,
        start_multi_runtime_platform,
    )


RELEASE_MINIMUM_SECONDS = 14_400
MAX_PROCESS_RSS_BYTES = 768 * 1024 * 1024
MAX_PROCESS_HANDLES = 1_024
MAX_FINAL_RSS_GROWTH_BYTES = 256 * 1024 * 1024
MAX_FINAL_RSS_GROWTH_RATIO = 1.25
MAX_REQUEST_MS = 10_000.0


class SoakError(RuntimeError):
    pass


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def percentile(values: list[float], value: float) -> float:
    if not values:
        raise SoakError("latency series is empty")
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, math.ceil(len(ordered) * value) - 1))
    return round(ordered[index], 3)


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


async def run_soak(args: argparse.Namespace) -> dict[str, Any]:
    release_qualified = not args.allow_short
    if release_qualified and args.duration_seconds < RELEASE_MINIMUM_SECONDS:
        raise SoakError("release soak duration must be at least 14400 real seconds")
    if (
        args.duration_seconds <= 0
        or args.invoke_seconds <= 0
        or args.sample_seconds <= 0
    ):
        raise SoakError("soak durations must be positive")
    if args.invoke_seconds > args.sample_seconds:
        raise SoakError("invoke interval must not exceed the metrics sample interval")
    output = args.output.resolve(strict=False)
    progress = (
        args.progress.resolve(strict=False)
        if args.progress
        else output.with_suffix(".progress.json")
    )
    run_started_at = utc_now()
    run_started = time.monotonic()
    latencies: dict[str, list[float]] = {
        kind: []
        for kind in (
            "python-module",
            "native-executable",
            "java-jar",
            "node-module",
            "wasm-component",
        )
    }
    errors: list[dict[str, Any]] = []
    samples: list[dict[str, Any]] = []
    calls = 0
    restarts = 0
    result_digests: dict[str, str] = {}
    cleanup: dict[str, Any] | None = None
    with tempfile.TemporaryDirectory(prefix="candlescope-phase11-soak-") as raw:
        running, startup = await start_multi_runtime_platform(
            Path(raw),
            jre_evidence=args.jre_evidence,
            node_evidence=args.node_evidence,
            wasmtime_evidence=args.wasmtime_evidence,
        )
        try:
            for warmup in range(3):
                outputs, values = await invoke_all(
                    running.platform,
                    trace_prefix=f"phase11-soak-warmup-{warmup}",
                )
                for kind, item in outputs.items():
                    result_digests.setdefault(kind, item["resultSha256"])
                    if result_digests[kind] != item["resultSha256"]:
                        raise SoakError(f"{kind} warmup result is nondeterministic")
                for kind, latency in values.items():
                    latencies[kind].append(latency)
                calls += len(values)
            baseline_metrics = process_metrics(running.process_ids)
            observed_process_ids = set(running.process_ids)
            soak_started_at = utc_now()
            soak_started = time.monotonic()
            next_invoke = soak_started
            next_sample = soak_started
            iteration = 0
            while True:
                now = time.monotonic()
                elapsed = now - soak_started
                if elapsed >= args.duration_seconds:
                    break
                if now >= next_invoke:
                    iteration += 1
                    try:
                        outputs, values = await invoke_all(
                            running.platform,
                            trace_prefix=f"phase11-soak-{iteration}",
                        )
                    except BaseException as exc:
                        errors.append(
                            {
                                "elapsedSeconds": round(elapsed, 3),
                                "errorType": type(exc).__name__,
                                "message": str(exc)[:500],
                            }
                        )
                        raise
                    after = active_processes(running.platform)
                    new_processes = set(after) - observed_process_ids
                    restarts += len(new_processes)
                    observed_process_ids.update(after)
                    if len(after) != 5:
                        raise SoakError("soak lost one or more runtime processes")
                    for kind, item in outputs.items():
                        if result_digests.get(kind) != item["resultSha256"]:
                            raise SoakError(f"{kind} result digest changed during soak")
                    for kind, latency in values.items():
                        latencies[kind].append(latency)
                        if latency > MAX_REQUEST_MS:
                            raise SoakError(
                                f"{kind} exceeded the frozen request wall budget"
                            )
                    calls += len(values)
                    next_invoke += args.invoke_seconds
                if now >= next_sample:
                    current_processes = active_processes(running.platform)
                    new_processes = set(current_processes) - observed_process_ids
                    restarts += len(new_processes)
                    observed_process_ids.update(current_processes)
                    metrics = process_metrics(current_processes)
                    if any(
                        item["rssBytes"] > MAX_PROCESS_RSS_BYTES
                        or item["handles"] > MAX_PROCESS_HANDLES
                        for item in metrics["processes"]
                    ):
                        raise SoakError(
                            "soak process exceeded the frozen RSS/handle budget"
                        )
                    sample = {
                        "elapsedSeconds": round(elapsed, 3),
                        **metrics,
                    }
                    samples.append(sample)
                    atomic_json(
                        progress,
                        {
                            "schemaVersion": "candlescope.plugin-platform.multi-runtime.phase11-soak-progress/1",
                            "result": "running",
                            "runStartedAt": run_started_at,
                            "startedAt": soak_started_at,
                            "elapsedSeconds": round(elapsed, 3),
                            "targetSeconds": args.duration_seconds,
                            "calls": calls,
                            "errors": len(errors),
                            "restarts": restarts,
                            "latest": sample,
                        },
                    )
                    next_sample += args.sample_seconds
                delay = (
                    min(
                        next_invoke,
                        next_sample,
                        soak_started + args.duration_seconds,
                    )
                    - time.monotonic()
                )
                await asyncio.sleep(max(0.01, min(delay, 1.0)))
            final_processes = active_processes(running.platform)
            new_processes = set(final_processes) - observed_process_ids
            restarts += len(new_processes)
            if len(final_processes) != 5:
                raise SoakError("soak ended without all five runtime processes")
            final_metrics = process_metrics(final_processes)
            soak_ended = time.monotonic()
        finally:
            cleanup = await running.close()
    run_ended = time.monotonic()
    elapsed_seconds = soak_ended - soak_started
    if release_qualified and elapsed_seconds < RELEASE_MINIMUM_SECONDS:
        raise SoakError("wall-clock soak ended before 14400 seconds")
    allowed_final_rss = max(
        int(baseline_metrics["totalRssBytes"] * MAX_FINAL_RSS_GROWTH_RATIO),
        baseline_metrics["totalRssBytes"] + MAX_FINAL_RSS_GROWTH_BYTES,
    )
    if final_metrics["totalRssBytes"] > allowed_final_rss:
        raise SoakError("final aggregate RSS exceeded the frozen growth budget")
    if (
        errors
        or restarts
        or cleanup
        != {
            "observedProcessCount": 5,
            "residualProcesses": 0,
            "residualSupervisors": 0,
        }
    ):
        raise SoakError("soak did not end with zero errors, restarts, and residuals")
    latency_summary = {
        kind: {
            "count": len(values),
            "medianMs": round(statistics.median(values), 3),
            "p95Ms": percentile(values, 0.95),
            "p99Ms": percentile(values, 0.99),
            "maxMs": round(max(values), 3),
        }
        for kind, values in sorted(latencies.items())
    }
    result = {
        "schemaVersion": "candlescope.plugin-platform.multi-runtime.phase11-soak/1",
        "result": "pass",
        "releaseQualified": release_qualified,
        "shortRunExplicitlyAllowed": args.allow_short,
        "runStartedAt": run_started_at,
        "startedAt": soak_started_at,
        "endedAt": utc_now(),
        "startupAndWarmupSeconds": round(soak_started - run_started, 3),
        "totalElapsedSeconds": round(run_ended - run_started, 3),
        "requestedDurationSeconds": args.duration_seconds,
        "elapsedSeconds": round(elapsed_seconds, 3),
        "minimumReleaseSeconds": RELEASE_MINIMUM_SECONDS,
        "thresholds": {
            "maxRequestMs": MAX_REQUEST_MS,
            "maxProcessRssBytes": MAX_PROCESS_RSS_BYTES,
            "maxProcessHandles": MAX_PROCESS_HANDLES,
            "maxFinalRssGrowthBytes": MAX_FINAL_RSS_GROWTH_BYTES,
            "maxFinalRssGrowthRatio": MAX_FINAL_RSS_GROWTH_RATIO,
            "allowedErrors": 0,
            "allowedRestarts": 0,
        },
        "startupSha256": canonical_sha256(startup),
        "plugins": sorted(result_digests),
        "resultDigests": dict(sorted(result_digests.items())),
        "calls": calls,
        "errors": errors,
        "restarts": restarts,
        "latencies": latency_summary,
        "metrics": {
            "baseline": baseline_metrics,
            "final": final_metrics,
            "sampleCount": len(samples),
            "peakTotalRssBytes": max(
                [baseline_metrics["totalRssBytes"], final_metrics["totalRssBytes"]]
                + [item["totalRssBytes"] for item in samples]
            ),
            "peakTotalHandles": max(
                [baseline_metrics["totalHandles"], final_metrics["totalHandles"]]
                + [item["totalHandles"] for item in samples]
            ),
        },
        "cleanup": cleanup,
    }
    atomic_json(output, result)
    progress.unlink(missing_ok=True)
    return result


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    value.add_argument("--jre-evidence", type=Path, required=True)
    value.add_argument("--node-evidence", type=Path, required=True)
    value.add_argument("--wasmtime-evidence", type=Path, required=True)
    value.add_argument(
        "--duration-seconds", type=float, default=float(RELEASE_MINIMUM_SECONDS)
    )
    value.add_argument("--invoke-seconds", type=float, default=10.0)
    value.add_argument("--sample-seconds", type=float, default=60.0)
    value.add_argument("--allow-short", action="store_true")
    value.add_argument("--output", type=Path, required=True)
    value.add_argument("--progress", type=Path)
    return value


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        result = asyncio.run(run_soak(args))
    except BaseException as exc:
        failure = {
            "schemaVersion": "candlescope.plugin-platform.multi-runtime.phase11-soak/1",
            "result": "fail",
            "releaseQualified": not args.allow_short,
            "shortRunExplicitlyAllowed": args.allow_short,
            "endedAt": utc_now(),
            "errorType": type(exc).__name__,
            "message": str(exc)[:2000],
        }
        atomic_json(args.output.resolve(strict=False), failure)
        print(json.dumps(failure, ensure_ascii=False, sort_keys=True), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
