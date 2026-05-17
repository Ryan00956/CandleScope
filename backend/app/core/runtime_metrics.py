"""Runtime observability helpers for async scheduling and WebSocket health."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from threading import Lock
from typing import Any


@dataclass(slots=True)
class _RollingLatency:
    samples: int = 0
    total_ms: float = 0.0
    max_ms: float = 0.0
    last_ms: float = 0.0
    recent_ms: list[float] = field(default_factory=list)

    def add(self, value_ms: float) -> None:
        value = max(0.0, float(value_ms))
        self.samples += 1
        self.total_ms += value
        self.max_ms = max(self.max_ms, value)
        self.last_ms = value
        self.recent_ms.append(value)
        if len(self.recent_ms) > 120:
            self.recent_ms.pop(0)

    def snapshot(self) -> dict[str, Any]:
        sorted_recent = sorted(self.recent_ms)
        avg = self.total_ms / self.samples if self.samples else 0.0
        return {
            "samples": self.samples,
            "avg_ms": round(avg, 2),
            "p95_ms": _percentile(sorted_recent, 95),
            "p99_ms": _percentile(sorted_recent, 99),
            "max_ms": round(self.max_ms, 2),
            "last_ms": round(self.last_ms, 2),
        }


class EventLoopLagMonitor:
    """Samples event-loop scheduling lag with a lightweight background task."""

    def __init__(self, *, interval_seconds: float = 1.0) -> None:
        self._interval = max(0.05, float(interval_seconds))
        self._latency = _RollingLatency()
        self._task: asyncio.Task | None = None
        self._running = False

    def start(self) -> None:
        if self._task is not None and not self._task.done():
            return
        self._running = True
        self._task = asyncio.create_task(self._run(), name="event-loop-lag-monitor")

    async def stop(self) -> None:
        self._running = False
        if self._task is None:
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        self._task = None

    async def _run(self) -> None:
        loop = asyncio.get_running_loop()
        next_tick = loop.time() + self._interval
        while self._running:
            await asyncio.sleep(max(0.0, next_tick - loop.time()))
            now = loop.time()
            self._latency.add((now - next_tick) * 1000)
            next_tick += self._interval
            if next_tick < now:
                next_tick = now + self._interval

    def snapshot(self) -> dict[str, Any]:
        payload = self._latency.snapshot()
        payload["interval_seconds"] = self._interval
        payload["running"] = self._task is not None and not self._task.done()
        return payload


class WsRuntimeMetrics:
    """Aggregated WebSocket send and heartbeat timing metrics."""

    def __init__(self) -> None:
        self._lock = Lock()
        self._heartbeat_delay = _RollingLatency()
        self._send_timeouts: dict[str, int] = {}
        self._send_errors: dict[str, int] = {}

    def record_heartbeat_delay(self, stream: str, delay_ms: float) -> None:
        with self._lock:
            self._heartbeat_delay.add(delay_ms)

    def record_send_timeout(self, kind: str) -> None:
        with self._lock:
            self._send_timeouts[kind] = self._send_timeouts.get(kind, 0) + 1

    def record_send_error(self, kind: str) -> None:
        with self._lock:
            self._send_errors[kind] = self._send_errors.get(kind, 0) + 1

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "heartbeat_delay": self._heartbeat_delay.snapshot(),
                "send_timeouts": dict(sorted(self._send_timeouts.items())),
                "send_errors": dict(sorted(self._send_errors.items())),
            }


def _percentile(values: list[float], pct: int) -> float:
    if not values:
        return 0.0
    if len(values) == 1:
        return round(values[0], 2)
    index = min(len(values) - 1, max(0, int(round((pct / 100) * (len(values) - 1)))))
    return round(values[index], 2)


ws_runtime_metrics = WsRuntimeMetrics()
