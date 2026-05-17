from __future__ import annotations

import asyncio

from app.core.executors import executors_snapshot, run_storage
from app.core.runtime_metrics import EventLoopLagMonitor, ws_runtime_metrics


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

    asyncio.run(_run())


def test_event_loop_lag_monitor_reports_samples() -> None:
    async def _run() -> None:
        monitor = EventLoopLagMonitor(interval_seconds=0.01)
        monitor.start()
        await asyncio.sleep(0.12)
        await monitor.stop()
        snapshot = monitor.snapshot()

        assert snapshot["samples"] >= 1
        assert snapshot["interval_seconds"] == 0.05
        assert snapshot["running"] is False

    asyncio.run(_run())


def test_ws_runtime_metrics_records_timeouts_and_heartbeat_delay() -> None:
    before = ws_runtime_metrics.snapshot()

    ws_runtime_metrics.record_heartbeat_delay("indicators", 12.5)
    ws_runtime_metrics.record_send_timeout("json")
    ws_runtime_metrics.record_send_error("text")

    after = ws_runtime_metrics.snapshot()

    assert after["heartbeat_delay"]["samples"] == before["heartbeat_delay"]["samples"] + 1
    assert after["send_timeouts"]["json"] >= 1
    assert after["send_errors"]["text"] >= 1
