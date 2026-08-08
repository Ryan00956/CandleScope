import pytest

from scripts.benchmark_replay_segments import run_benchmark


pytestmark = pytest.mark.anyio


async def test_segment_gc_benchmark_has_exact_deterministic_candidate_set() -> None:
    report = await run_benchmark(
        segment_count=20,
        iterations=2,
        byte_size=1_024,
    )

    assert report["schema_version"] == "replay.phase7.segment-gc-benchmark.v2"
    assert report["wall_clock_policy"] == "MEASURE_ONLY_NON_BLOCKING"
    assert report["acceptance"]["passed"] is True
    assert all(report["checks"].values())
    assert report["p95_ms"] >= 0
    assert report["inventory_p95_ms"] >= 0
    assert report["evidence"] == {
        "segment_count": 20,
        "candidate_count": 20,
        "protected_count": 0,
        "target_reclaim_bytes": 20_480,
        "estimated_reclaim_bytes": 20_480,
        "plan_hash": report["evidence"]["plan_hash"],
    }
    assert str(report["evidence_hash"]).startswith("sha256:")
