#!/usr/bin/env python3
"""Run ta4j and the current Python Elliott engine on identical point-in-time bars."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


REPOSITORY_ROOT = Path(__file__).resolve().parents[4]


def canonical(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def sha256(value: object) -> str:
    return "sha256:" + hashlib.sha256(canonical(value)).hexdigest()


def bar(
    index: int, open_: float, close: float, high: float, low: float, volume: float
) -> dict[str, object]:
    return {
        "time": 1_704_067_200 + index * 3600,
        "open": open_,
        "high": high,
        "low": low,
        "close": close,
        "volume": volume,
        "is_closed": True,
    }


def sine_trend(count: int) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    previous = 100.0
    for index in range(count):
        close = (
            100.0
            + index * 0.025
            + math.sin(index / 17.0) * 8.0
            + math.sin(index / 5.0) * 3.0
        )
        rows.append(
            bar(
                index,
                previous,
                close,
                max(previous, close) + 0.8,
                min(previous, close) - 0.8,
                1000.0 + (index % 23) * 17.0,
            )
        )
        previous = close
    return rows


def impulse_profile(count: int) -> list[dict[str, object]]:
    anchors = (100.0, 122.0, 109.0, 145.0, 118.0, 162.0, 132.0, 174.0, 146.0)
    rows: list[dict[str, object]] = []
    previous = anchors[0]
    for index in range(count):
        position = index * (len(anchors) - 1.0) / max(1, count - 1)
        left = min(len(anchors) - 2, math.floor(position))
        fraction = position - left
        close = (
            anchors[left]
            + (anchors[left + 1] - anchors[left]) * fraction
            + math.sin(index * 0.73) * 0.25
        )
        rows.append(
            bar(
                index,
                previous,
                close,
                max(previous, close) + 0.6,
                min(previous, close) - 0.6,
                800.0 + index * 2.0,
            )
        )
        previous = close
    return rows


def page(rows: list[dict[str, object]], *, all_final: bool = True) -> dict[str, object]:
    return {
        "schemaVersion": "candlescope.market-bars-page/1",
        "context": {"mode": "replay", "exchange": "binance", "marketType": "spot"},
        "series": {"symbol": "BTCUSDT", "interval": "1h"},
        "data": rows,
        "coverage": {
            "requestedStartMs": None,
            "requestedEndMs": None,
            "requestedLimit": 500,
            "returnedStartMs": rows[0]["time"] * 1000 if rows else None,
            "returnedEndMs": rows[-1]["time"] * 1000 if rows else None,
            "returnedCount": len(rows),
            "verifiedContiguous": True,
            "allRowsFinal": all_final,
            "missingRanges": [],
            "excludedRanges": [],
        },
        "sourceQuality": {
            "source": "phase5-golden-corpus",
            "barSources": ["synthetic-frozen"],
            "qualities": ["verified"],
            "trustedFinal": all_final,
            "cacheHit": True,
            "backfillTriggered": False,
            "hasTailGap": False,
        },
        "pagination": {
            "hasMore": False,
            "historyState": "ready",
            "complete": True,
            "retryable": False,
            "terminalReason": None,
            "earliestAvailableMs": None,
            "nextBeforeMs": None,
            "availabilityRevision": "phase5-golden-v1",
        },
    }


class JavaAdapter:
    def __init__(self, java: Path, jar: Path) -> None:
        self.process = subprocess.Popen(
            [str(java), "-Xms32m", "-Xmx256m", "-XX:+UseSerialGC", "-jar", str(jar)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
        )
        self.generation = 1
        self.counter = 0
        self._request(
            "handshake",
            {
                "protocols": ["candlescope.plugin/2"],
                "host": {"name": "CandleScope", "version": "0.4.0"},
                "entrypointId": "main",
                "hostApis": ["candlescope.host-api/1"],
                "transports": ["jsonl/1"],
            },
            generation=0,
        )
        self._request(
            "activate",
            {
                "instanceId": "phase5-comparison",
                "generation": 1,
                "capabilities": [
                    {
                        "handle": "comparison-bars",
                        "permissionId": "market.bars.read",
                        "scope": {"maxBars": 5000, "pointInTimeRequired": True},
                    }
                ],
            },
        )

    def _write(self, value: dict[str, object]) -> None:
        assert self.process.stdin is not None
        self.process.stdin.write(canonical(value).decode("utf-8") + "\n")
        self.process.stdin.flush()

    def _read(self) -> dict[str, Any]:
        assert self.process.stdout is not None
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError("Java adapter exited before returning a JSONL frame")
        value = json.loads(line)
        if not isinstance(value, dict):
            raise RuntimeError("Java adapter returned a non-object frame")
        return value

    def _request(
        self, method: str, params: dict[str, object], *, generation: int | None = None
    ) -> dict[str, Any]:
        self.counter += 1
        request_id = f"compare-{self.counter}"
        self._write(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": method,
                "params": params,
                "generation": self.generation if generation is None else generation,
            }
        )
        result = self._read()
        if result.get("id") != request_id or "error" in result:
            raise RuntimeError(f"Java adapter request failed: {result}")
        return result

    def analyze(
        self, case_id: str, market_page: dict[str, object]
    ) -> tuple[dict[str, Any], float]:
        self.counter += 1
        request_id = f"compare-{self.counter}"
        started = time.perf_counter()
        self._write(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "invoke",
                "params": {
                    "contributionId": "analyze-ta4j-elliott",
                    "input": {
                        "market": {
                            "context": market_page["context"],
                            "series": market_page["series"],
                            "limit": 500,
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
                    },
                    "requestContext": {
                        "contributionId": "analyze-ta4j-elliott",
                        "userAction": True,
                        "generation": 1,
                        "traceId": f"trace-{case_id}",
                    },
                },
                "generation": 1,
            }
        )
        host_call = self._read()
        if host_call.get("method") != "host.call":
            raise RuntimeError(f"expected host.call, got {host_call}")
        self._write(
            {
                "jsonrpc": "2.0",
                "id": host_call["id"],
                "result": market_page,
                "generation": 1,
            }
        )
        response = self._read()
        elapsed_ms = (time.perf_counter() - started) * 1000
        if response.get("id") != request_id or "error" in response:
            raise RuntimeError(f"Java adapter analysis failed: {response}")
        return response["result"], elapsed_ms

    def close(self) -> tuple[int, str]:
        self._request("deactivate", {"reason": "comparison complete"})
        self._request("shutdown", {}, generation=0)
        assert self.process.stdin is not None
        self.process.stdin.close()
        code = self.process.wait(timeout=5)
        assert self.process.stderr is not None
        return code, self.process.stderr.read()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--java", type=Path, required=True)
    parser.add_argument("--jar", type=Path, required=True)
    parser.add_argument("--python-plugin-root", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    plugin_root = args.python_plugin_root.resolve()
    sys.path.insert(
        0, str(REPOSITORY_ROOT / "packages" / "candlescope-plugin-sdk" / "src")
    )
    sys.path.insert(0, str(plugin_root / "src"))
    from candlescope_elliott_wave.analysis import analyze_wave_structure
    from candlescope_elliott_wave.models import AnalyzerSettings, Bar

    source_head = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=plugin_root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    cases: list[tuple[str, list[dict[str, object]], bool]] = [
        ("empty", [], True),
        ("sine-trend-120", sine_trend(120), True),
        ("sine-trend-240-prefix", sine_trend(240), True),
        ("impulse-profile-180", impulse_profile(180), True),
    ]
    non_final = sine_trend(120)
    non_final[-1] = {**non_final[-1], "is_closed": False}
    cases.append(("non-final-last-120", non_final, False))
    java = JavaAdapter(args.java.resolve(), args.jar.resolve())
    records: list[dict[str, object]] = []
    try:
        for case_id, rows, all_final in cases:
            market_page = page(rows, all_final=all_final)
            java_result, java_ms = java.analyze(case_id, market_page)
            bars = tuple(Bar.from_wire(item) for item in rows)
            settings = AnalyzerSettings(
                atr_period=14,
                atr_multiplier=2.0,
                lookback_bars=max(100, len(rows)),
                minimum_bars_between_pivots=2,
                degree_count=3,
                degree_scale=1.8,
                candidate_limit=5,
                minimum_score=0.0,
            )
            started = time.perf_counter()
            python_result = analyze_wave_structure(bars, settings)
            python_ms = (time.perf_counter() - started) * 1000
            java_scenarios = java_result["scenarios"]
            java_pivots = sorted(
                {
                    pivot["time"]
                    for scenario in java_scenarios
                    for pivot in scenario["pivots"]
                }
            )
            python_pivots = sorted(
                {
                    pivot.time
                    for candidate in python_result.candidates
                    for pivot in candidate.points
                }
            )
            intersection = sorted(set(java_pivots) & set(python_pivots))
            union = set(java_pivots) | set(python_pivots)
            last_time = rows[-1]["time"] if rows else 0
            if any(value > last_time for value in java_pivots + python_pivots):
                raise RuntimeError(f"{case_id} emitted a future pivot")
            records.append(
                {
                    "id": case_id,
                    "barCount": len(rows),
                    "inputSha256": sha256(market_page),
                    "ta4j": {
                        "scenarioCount": len(java_scenarios),
                        "patterns": [item["pattern"] for item in java_scenarios],
                        "uniquePivotCount": len(java_pivots),
                        "invalidation": java_scenarios[0]["invalidation"]
                        if java_scenarios
                        else None,
                        "warnings": java_result["warnings"],
                        "elapsedMs": round(java_ms, 3),
                        "outputSha256": sha256(java_result),
                    },
                    "python": {
                        "candidateCount": len(python_result.candidates),
                        "patterns": [item.pattern for item in python_result.candidates],
                        "uniquePivotCount": len(python_pivots),
                        "invalidation": python_result.primary.invalidation_price
                        if python_result.primary
                        else None,
                        "elapsedMs": round(python_ms, 3),
                    },
                    "comparison": {
                        "sharedPivotCount": len(intersection),
                        "pivotJaccard": round(len(intersection) / len(union), 6)
                        if union
                        else 1.0,
                        "bothPointInTime": True,
                        "futurePivotCount": 0,
                    },
                }
            )
    finally:
        exit_code, stderr = java.close()
    if exit_code != 0:
        raise RuntimeError(
            f"Java adapter did not stop cleanly: {exit_code}: {stderr[-1000:]}"
        )
    stable = [
        {key: value for key, value in item.items() if key != "ta4j" and key != "python"}
        | {
            "ta4j": {
                key: value for key, value in item["ta4j"].items() if key != "elapsedMs"
            },
            "python": {
                key: value
                for key, value in item["python"].items()
                if key != "elapsedMs"
            },
        }
        for item in records
    ]
    report = {
        "schemaVersion": "candlescope.elliott-engine-comparison/1",
        "generatedAt": "2026-08-03T00:00:00Z",
        "policy": {
            "automaticReplacement": False,
            "samePointInTimeInput": True,
            "hindsightCalibration": False,
            "migrationDecision": "not-approved",
        },
        "engines": {
            "ta4j": {"version": "0.23.0", "adapterVersion": "0.1.0"},
            "python": {
                "source": "local-sibling-worktree",
                "name": args.python_plugin_root.name,
                "commit": source_head,
            },
        },
        "cases": records,
        "stableCasesSha256": sha256(stable),
        "conclusion": (
            "The engines expose different scenario vocabularies and pivot semantics. "
            "This report proves parallel point-in-time execution only; it does not authorize replacement."
        ),
    }
    payload = (
        json.dumps(report, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        + "\n"
    )
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(payload, encoding="utf-8", newline="\n")
    print(payload, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
