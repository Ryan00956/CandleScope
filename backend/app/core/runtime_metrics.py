"""Runtime observability helpers for async scheduling and WebSocket health."""
from __future__ import annotations

import asyncio
from array import array
from dataclasses import dataclass, field
from threading import Lock
from typing import Any


@dataclass(slots=True)
class _RollingLatency:
    history_limit: int = 120
    output_limit: int = 120
    samples: int = 0
    total_ms: float = 0.0
    max_ms: float = 0.0
    last_ms: float = 0.0
    _values: array = field(init=False, repr=False)
    _stored: int = field(init=False, default=0, repr=False)

    def __post_init__(self) -> None:
        self.history_limit = max(1, int(self.history_limit))
        self.output_limit = max(1, int(self.output_limit))
        # A one-hour 10 ms event-loop window contains roughly 360,000
        # samples. Python ``(sequence, float)`` tuples cost tens of megabytes
        # and copying that deque for every capacity snapshot caused apparent
        # process-memory growth during the release soak. Sequence numbers are
        # monotonic, so retain only packed doubles in a fixed-size ring and
        # derive their sequence from the slot position.
        self._values = array("d", [0.0]) * self.history_limit

    def add(self, value_ms: float) -> None:
        value = max(0.0, float(value_ms))
        self.samples += 1
        self.total_ms += value
        self.max_ms = max(self.max_ms, value)
        self.last_ms = value
        self._values[(self.samples - 1) % self.history_limit] = value
        self._stored = min(self.history_limit, self._stored + 1)

    def _sample(self, sequence: int) -> tuple[int, float]:
        return sequence, self._values[(sequence - 1) % self.history_limit]

    def _samples_from(self, first_sequence: int) -> list[tuple[int, float]]:
        oldest_sequence = self.samples - self._stored + 1
        start = max(oldest_sequence, int(first_sequence))
        if self._stored == 0 or start > self.samples:
            return []
        return [self._sample(sequence) for sequence in range(start, self.samples + 1)]

    def snapshot(self, *, after_sequence: int | None = None) -> dict[str, Any]:
        oldest_sequence = self.samples - self._stored + 1
        if after_sequence is None:
            # Ordinary health/capacity polling needs a recent percentile and
            # the bounded output tail, not a copy of the entire one-hour ring.
            selected = self._samples_from(self.samples - self.output_limit + 1)
        else:
            selected = self._samples_from(max(0, int(after_sequence)) + 1)
        sorted_recent = sorted(value for _, value in selected)
        avg = self.total_ms / self.samples if self.samples else 0.0
        payload = {
            "samples": self.samples,
            "avg_ms": round(avg, 2),
            "p95_ms": _percentile(sorted_recent, 95),
            "p99_ms": _percentile(sorted_recent, 99),
            "max_ms": round(self.max_ms, 2),
            "last_ms": round(self.last_ms, 2),
            # Bounded raw samples let release harnesses calculate a percentile
            # for their own observation window instead of inheriting a spike
            # from a previous scenario in this sidecar process.
            "sample_sequence": self.samples,
            "recent_samples": [
                {"sequence": sequence, "value_ms": round(value, 2)}
                for sequence, value in selected[-self.output_limit:]
            ],
        }
        if after_sequence is not None:
            normalized_after = max(0, int(after_sequence))
            payload.update({
                "window_after_sequence": normalized_after,
                "window_complete": normalized_after >= oldest_sequence - 1,
                "window_sample_count": len(selected),
                "window_p95_ms": _percentile(sorted_recent, 95),
                "window_p99_ms": _percentile(sorted_recent, 99),
            })
        return payload


class EventLoopLagMonitor:
    """Samples event-loop scheduling lag with a lightweight background task."""

    def __init__(self, *, interval_seconds: float = 1.0) -> None:
        self._interval = max(0.01, float(interval_seconds))
        # 10 ms release sampling for one hour needs 360,000 points. Retain a
        # bounded margin so a caller can request an exact sequence window while
        # ordinary snapshots still emit only the newest 120 raw samples.
        self._latency = _RollingLatency(history_limit=400_000)
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

    def snapshot(self, *, after_sequence: int | None = None) -> dict[str, Any]:
        payload = self._latency.snapshot(after_sequence=after_sequence)
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
