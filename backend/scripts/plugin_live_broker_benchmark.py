"""Measure the local zero-network Live Broker foundation."""

from __future__ import annotations

import argparse
import asyncio
import json
import platform
import statistics
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

from app.plugin_live_v2 import LiveBrokerController


def _percentile(values: list[float], percentile: float) -> float:
    if not values:
        raise ValueError("values must not be empty")
    ordered = sorted(values)
    index = max(
        0,
        min(
            len(ordered) - 1,
            int((len(ordered) - 1) * percentile + 0.999999),
        ),
    )
    return ordered[index]


def _summary(values: list[float]) -> dict[str, float]:
    return {
        "min": round(min(values), 3),
        "p50": round(statistics.median(values), 3),
        "p95": round(_percentile(values, 0.95), 3),
        "p99": round(_percentile(values, 0.99), 3),
        "max": round(max(values), 3),
    }


def _rss_bytes(pid: int) -> int | None:
    try:
        import psutil
    except ImportError:
        return None
    return int(psutil.Process(pid).memory_info().rss)


async def _run(starts: int, requests: int) -> dict[str, Any]:
    startup_ms: list[float] = []
    round_trip_ms: list[float] = []
    idle_rss_bytes: int | None = None
    post_request_rss_bytes: int | None = None
    with tempfile.TemporaryDirectory(prefix="candlescope-live-broker-benchmark-") as root:
        benchmark_root = Path(root)
        for index in range(starts):
            controller = LiveBrokerController(
                enabled=True,
                root=benchmark_root / f"start-{index}",
                vault_backend="fake",
                allow_test_backend=True,
            )
            started = time.perf_counter()
            await controller.start()
            startup_ms.append((time.perf_counter() - started) * 1_000)
            process = controller.process
            if process is None:
                raise RuntimeError("Broker process was not started")
            idle_rss_bytes = _rss_bytes(process.pid)
            if index == starts - 1:
                for _ in range(requests):
                    before = time.perf_counter()
                    health = await controller.health()
                    round_trip_ms.append((time.perf_counter() - before) * 1_000)
                    if health["networkMethods"] != 0:
                        raise RuntimeError("Broker unexpectedly exposed a network method")
                post_request_rss_bytes = _rss_bytes(process.pid)
            await controller.stop()
    return {
        "schemaVersion": "candlescope.live-broker-benchmark/1",
        "platform": platform.platform(),
        "python": sys.version.split()[0],
        "starts": starts,
        "requests": requests,
        "startupMilliseconds": _summary(startup_ms),
        "roundTripMilliseconds": _summary(round_trip_ms),
        "idleRssBytes": idle_rss_bytes,
        "postRequestRssBytes": post_request_rss_bytes,
        "rssGrowthBytes": (
            post_request_rss_bytes - idle_rss_bytes
            if post_request_rss_bytes is not None and idle_rss_bytes is not None
            else None
        ),
        "budgets": {
            "startupP95Milliseconds": 500,
            "roundTripP95Milliseconds": 10,
            "roundTripP99Milliseconds": 25,
            "idleRssBytes": 64 * 1024 * 1024,
            "postRequestRssBytes": 64 * 1024 * 1024,
            "rssGrowthBytes": 16 * 1024 * 1024,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--starts", type=int, default=10)
    parser.add_argument("--requests", type=int, default=1000)
    arguments = parser.parse_args()
    if not 1 <= arguments.starts <= 100:
        parser.error("--starts must be between 1 and 100")
    if not 1 <= arguments.requests <= 100_000:
        parser.error("--requests must be between 1 and 100000")
    result = asyncio.run(_run(arguments.starts, arguments.requests))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    budgets = result["budgets"]
    startup = result["startupMilliseconds"]
    round_trip = result["roundTripMilliseconds"]
    rss = result["idleRssBytes"]
    post_rss = result["postRequestRssBytes"]
    growth = result["rssGrowthBytes"]
    passed = (
        startup["p95"] <= budgets["startupP95Milliseconds"]
        and round_trip["p95"] <= budgets["roundTripP95Milliseconds"]
        and round_trip["p99"] <= budgets["roundTripP99Milliseconds"]
        and (rss is None or rss <= budgets["idleRssBytes"])
        and (
            post_rss is None
            or post_rss <= budgets["postRequestRssBytes"]
        )
        and (growth is None or growth <= budgets["rssGrowthBytes"])
    )
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
