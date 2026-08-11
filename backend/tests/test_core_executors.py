from __future__ import annotations

import asyncio

from app.core.executors import executors_snapshot, run_storage
from app.core.runtime_metrics import EventLoopLagMonitor, _RollingLatency, ws_runtime_metrics


def test_executor_snapshot_tracks_storage_work() -> None:
    async def _run() -> None:
        before = executors_snapshot()["storage"]["submitted"]
        result = await run_storage(lambda value: value + 1, 41)
        after = executors_snapshot()["storage"]

        assert result == 42
        assert after["submitted"] == before + 1
        assert after["completed"] >= 1
        assert after["pending"] >= 0
        assert after["max_workers"] >= 1
        slow = after["recent_slow_operations"]
        assert isinstance(slow, list)

    asyncio.run(_run())


def test_event_loop_lag_monitor_reports_samples() -> None:
    async def _run() -> None:
        monitor = EventLoopLagMonitor(interval_seconds=0.01)
        monitor.start()
        await asyncio.sleep(0.12)
        await monitor.stop()
        snapshot = monitor.snapshot()

        assert snapshot["samples"] >= 1
        assert snapshot["sample_sequence"] == snapshot["samples"]
        assert snapshot["recent_samples"]
        assert snapshot["recent_samples"][-1]["sequence"] == snapshot["samples"]
        assert len(snapshot["recent_samples"]) <= 120
        assert snapshot["interval_seconds"] == 0.01
        assert snapshot["running"] is False

        window = monitor.snapshot(after_sequence=0)
        assert window["window_complete"] is True
        assert window["window_sample_count"] == snapshot["samples"]
        assert window["window_p99_ms"] >= 0

    asyncio.run(_run())


def test_rolling_latency_uses_a_fixed_packed_ring_and_preserves_sequences() -> None:
    latency = _RollingLatency(history_limit=4, output_limit=2)
    for value in (10, 20, 30, 40, 50, 60):
        latency.add(value)

    recent = latency.snapshot()
    assert recent["recent_samples"] == [
        {"sequence": 5, "value_ms": 50.0},
        {"sequence": 6, "value_ms": 60.0},
    ]
    assert recent["p99_ms"] == 60.0
    assert sum(recent["histogram"]["counts"]) == 6
    assert recent["histogram"]["counts"][60] == 1

    complete = latency.snapshot(after_sequence=2)
    assert complete["window_complete"] is True
    assert complete["window_sample_count"] == 4
    assert complete["recent_samples"] == [
        {"sequence": 5, "value_ms": 50.0},
        {"sequence": 6, "value_ms": 60.0},
    ]

    truncated = latency.snapshot(after_sequence=1)
    assert truncated["window_complete"] is False
    assert truncated["window_sample_count"] == 4


def test_rolling_latency_histogram_is_cumulative_and_bounds_overflow() -> None:
    latency = _RollingLatency(history_limit=2, output_limit=1)
    for value in (0, 0.1, 99.1, 100, 1_500):
        latency.add(value)

    histogram = latency.snapshot()["histogram"]
    assert histogram["bucket_width_ms"] == 1
    assert histogram["max_ms"] == 1_000
    assert sum(histogram["counts"]) == 5
    assert histogram["counts"][0] == 1
    assert histogram["counts"][1] == 1
    assert histogram["counts"][100] == 2
    assert histogram["counts"][1_001] == 1


def test_ws_runtime_metrics_records_timeouts_and_heartbeat_delay() -> None:
    before = ws_runtime_metrics.snapshot()

    ws_runtime_metrics.record_heartbeat_delay("indicators", 12.5)
    ws_runtime_metrics.record_send_timeout("json")
    ws_runtime_metrics.record_send_error("text")

    after = ws_runtime_metrics.snapshot()

    assert after["heartbeat_delay"]["samples"] == before["heartbeat_delay"]["samples"] + 1
    assert after["send_timeouts"]["json"] >= 1
    assert after["send_errors"]["text"] >= 1
