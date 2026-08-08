from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts import benchmark_replay_hedge_exchange_parity as benchmark


pytestmark = pytest.mark.anyio


async def test_hedge_release_benchmark_covers_normal_and_liquidation_matrix(
    tmp_path: Path,
) -> None:
    report = await benchmark.run_benchmark(
        temp_root=tmp_path,
        normal_iterations=1,
        liquidation_samples=1,
    )
    assert report["acceptance"]["passed"] is True, json.dumps(
        report,
        sort_keys=True,
    )
    assert [case["track_count"] for case in report["normal_cases"]] == [1, 2, 4, 8]
    assert [case["track_count"] for case in report["liquidation_cases"]] == [
        1,
        2,
        4,
        8,
    ]
    assert all(case["passed"] for case in report["normal_cases"])
    assert all(case["passed"] for case in report["liquidation_cases"])
    assert report["schema_version"] == "replay.hedge-exchange-parity.performance.v2"
    assert report["wall_clock_policy"] == "MEASURE_ONLY_NON_BLOCKING"
    assert "normal_p95_ms" not in report["resource_limits"]


async def test_hedge_release_wall_clock_measurements_do_not_gate_acceptance(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    real_distribution = benchmark._distribution

    def deliberately_slow_distribution(values: list[float]) -> dict[str, object]:
        measured = real_distribution(values)
        return {
            **measured,
            "p50": 999_998.0,
            "p95": 999_999.0,
            "max": 1_000_000.0,
        }

    monkeypatch.setattr(benchmark, "_distribution", deliberately_slow_distribution)
    report = await benchmark.run_benchmark(
        temp_root=tmp_path,
        normal_iterations=1,
        liquidation_samples=1,
    )

    assert report["acceptance"]["passed"] is True
    assert report["normal_cases"][0]["normal_wave_ms"]["p95"] == 999_999.0
    assert (
        report["liquidation_cases"][0]["liquidation_wave_ms"]["p95"]
        == 999_999.0
    )
    assert "p95_within_frozen_limit" not in report["normal_cases"][0]["checks"]
    assert "p95_within_frozen_limit" not in report["liquidation_cases"][0]["checks"]
