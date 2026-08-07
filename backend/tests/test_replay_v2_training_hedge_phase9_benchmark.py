from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts.benchmark_replay_hedge_exchange_parity import run_benchmark


pytestmark = pytest.mark.anyio


async def test_hedge_release_benchmark_covers_normal_and_liquidation_matrix(
    tmp_path: Path,
) -> None:
    report = await run_benchmark(
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
