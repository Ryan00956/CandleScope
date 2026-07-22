from scripts.benchmark_replay_multitrack import run_benchmark


def test_multitrack_coordination_benchmark_covers_the_1_2_4_8_matrix() -> None:
    report = run_benchmark(iterations=20)
    cases = report["cases"]
    assert isinstance(cases, list)
    assert [case["track_count"] for case in cases] == [1, 2, 4, 8]
    for case in cases:
        assert case["projections"] == case["track_count"] * 20
        assert case["ordered_queue_high_water"] == case["track_count"]
        assert case["checkpoint_bytes"] > 0
        assert case["projection_rate_per_second"] > 0
        assert str(case["tail_ordering_hash"]).startswith("sha256:")
    assert report["evidence_hash"].startswith("sha256:")
