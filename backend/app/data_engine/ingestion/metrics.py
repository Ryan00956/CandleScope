"""
Ingestion Metrics — lightweight observability for every layer.

Each layer owns a ``LayerMetrics`` instance.  All metrics are simple
counters / gauges / timestamps stored in plain dicts so they can be
serialized to JSON at any time (no external dependency like Prometheus).

Usage in a layer:
    self._metrics = LayerMetrics("L1_Transport")
    self._metrics.inc("requests_sent")
    self._metrics.set("active_endpoint", "api.binance.com")
    self._metrics.mark("last_request_at")
    snapshot = self._metrics.snapshot()
"""
from __future__ import annotations

import time
import threading
from typing import Any


class LayerMetrics:
    """Thread-safe metrics container for a single ingestion layer.

    Metric types:
      - **counter**: monotonically increasing integer (errors, messages, etc.)
      - **gauge**: arbitrary current value (active endpoint, queue depth, etc.)
      - **timestamp**: epoch-ms of last occurrence (last message, last error, etc.)
    """

    def __init__(self, layer_name: str) -> None:
        self.layer_name = layer_name
        self._lock = threading.Lock()
        self._counters: dict[str, int] = {}
        self._gauges: dict[str, Any] = {}
        self._timestamps: dict[str, int] = {}

    # ── Counter operations ──

    def inc(self, name: str, delta: int = 1) -> None:
        """Increment a counter."""
        with self._lock:
            self._counters[name] = self._counters.get(name, 0) + delta

    def get_counter(self, name: str) -> int:
        with self._lock:
            return self._counters.get(name, 0)

    # ── Gauge operations ──

    def set(self, name: str, value: Any) -> None:
        """Set a gauge to an arbitrary value."""
        with self._lock:
            self._gauges[name] = value

    def get_gauge(self, name: str) -> Any:
        with self._lock:
            return self._gauges.get(name)

    # ── Timestamp operations ──

    def mark(self, name: str, ts_ms: int | None = None) -> None:
        """Record the current time (or a specific timestamp) for an event."""
        with self._lock:
            self._timestamps[name] = ts_ms if ts_ms is not None else _now_ms()

    def get_timestamp(self, name: str) -> int | None:
        with self._lock:
            return self._timestamps.get(name)

    # ── Snapshot ──

    def snapshot(self) -> dict:
        """Return a JSON-serializable snapshot of all metrics."""
        with self._lock:
            return {
                "layer": self.layer_name,
                "counters": dict(self._counters),
                "gauges": {k: _safe_serialize(v) for k, v in self._gauges.items()},
                "timestamps": dict(self._timestamps),
            }

    def reset(self) -> None:
        """Reset all metrics (useful for tests)."""
        with self._lock:
            self._counters.clear()
            self._gauges.clear()
            self._timestamps.clear()


class PipelineMetrics:
    """Aggregates ``LayerMetrics`` from all layers into one view."""

    def __init__(self) -> None:
        self._layers: dict[str, LayerMetrics] = {}

    def register(self, layer_metrics: LayerMetrics) -> None:
        self._layers[layer_metrics.layer_name] = layer_metrics

    def snapshot(self) -> dict:
        """Full pipeline snapshot — one entry per layer."""
        return {
            name: lm.snapshot()
            for name, lm in self._layers.items()
        }

    def get_layer(self, name: str) -> LayerMetrics | None:
        return self._layers.get(name)


# ─── Helpers ─────────────────────────────────────────────────

def _now_ms() -> int:
    return int(time.time() * 1000)


def _safe_serialize(value: Any) -> Any:
    """Ensure gauge values are JSON-serializable."""
    if isinstance(value, (str, int, float, bool, type(None))):
        return value
    if isinstance(value, (list, tuple)):
        return [_safe_serialize(v) for v in value]
    if isinstance(value, dict):
        return {str(k): _safe_serialize(v) for k, v in value.items()}
    # Fallback: convert to string
    return str(value)
