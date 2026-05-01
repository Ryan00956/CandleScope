"""
L5: Continuity Layer — ensures data stream integrity.

Responsibilities:
  * Deduplicate events using ``MarketEvent.dedup_key``
  * Detect gaps using ``MarketEvent.continuity_key``
  * Emit gap markers for downstream repair orchestration
  * Forward events to L6 Delivery

Dedup & gap strategies vary by stream type:
  * **Kline**: dedup closed bars by open_time, gap detect by interval
  * **AggTrade / Trade**: dedup by trade ID, gap detect by ID sequence
  * **Ticker / Depth**: no dedup, no gap detection (stateless snapshots)
"""
from __future__ import annotations

import logging
from collections import OrderedDict
from typing import Callable, Awaitable

from .config import IngestionConfig
from .metrics import LayerMetrics
from .models import (
    StreamDescriptor,
    StreamType,
    MarketEvent,
    GapMarker,
)
from .transport import TransportLayer
from app.data_engine.interval_policy import STANDARD_INTERVAL_MS, is_monthly_interval

logger = logging.getLogger("ingestion.L5_Continuity")

# ─── Fixed interval mapping for kline gap detection ───────────
#
# Monthly intervals have variable duration, so ContinuityLayer intentionally
# excludes them from fixed-step stream gap detection.
_FIXED_INTERVAL_MS: dict[str, int] = {
    interval: value
    for interval, value in STANDARD_INTERVAL_MS.items()
    if not is_monthly_interval(interval)
}


class ContinuityLayer:
    """Dedup, gap-detect, and forward MarketEvents in order."""

    def __init__(
        self,
        config: IngestionConfig,
        transport: TransportLayer,
        descriptor: StreamDescriptor,
    ) -> None:
        self._cfg = config
        self._transport = transport
        self._descriptor = descriptor

        self._metrics = LayerMetrics("L5_Continuity")

        # Seen dedup keys (bounded LRU)
        self._seen: OrderedDict[int | str, bool] = OrderedDict()

        # Last emitted continuity key (for gap detection)
        self._last_continuity_key: int | None = None

        # Kline interval in ms (only for kline streams)
        self._interval_ms: int | None = None
        if descriptor.stream_type == StreamType.KLINE and descriptor.interval:
            self._interval_ms = _FIXED_INTERVAL_MS.get(descriptor.interval)

        # Upstream callbacks
        self._on_event: Callable[[MarketEvent], Awaitable[None]] | None = None
        self._on_gap: Callable[[GapMarker], Awaitable[None]] | None = None

    # ── Public: Metrics / Snapshot ───────────────────────────

    @property
    def metrics(self) -> LayerMetrics:
        return self._metrics

    def snapshot(self) -> dict:
        return {
            "layer": "L5_Continuity",
            "stream_key": self._descriptor.key,
            "last_continuity_key": self._last_continuity_key,
            "seen_cache_size": len(self._seen),
            "metrics": self._metrics.snapshot(),
        }

    # ── Public: Register callbacks ───────────────────────────

    def on_event(self, callback: Callable[[MarketEvent], Awaitable[None]]) -> None:
        """Register callback for each event emitted (→ L6)."""
        self._on_event = callback

    def on_gap(self, callback: Callable[[GapMarker], Awaitable[None]]) -> None:
        """Register callback for gap markers (→ L6)."""
        self._on_gap = callback

    # ── Public: Ingest (called by L4) ────────────────────────

    async def ingest(self, event: MarketEvent) -> None:
        """Process an incoming MarketEvent: dedup → gap check → emit."""
        self._metrics.inc("events_received")
        st = event.event_type

        # ── Dedup ──
        dedup_key = event.dedup_key
        if dedup_key is not None:
            if dedup_key in self._seen:
                self._metrics.inc("events_deduplicated")
                return
            self._seen[dedup_key] = True
            if len(self._seen) > self._cfg.continuity_buffer_size:
                self._seen.popitem(last=False)

        # ── Gap detection (only for ordered stream types) ──
        continuity_key = event.continuity_key
        if continuity_key is not None and self._last_continuity_key is not None:
            expected_next = self._compute_expected_next(st)
            if expected_next is not None and continuity_key > expected_next:
                gap_count = self._estimate_gap_count(st, expected_next, continuity_key)
                self._metrics.inc("gaps_detected")
                logger.warning(
                    "Gap detected (%s): expected %s, got %s (missing ~%d)",
                    self._descriptor.key, expected_next, continuity_key, gap_count,
                )
                gap = GapMarker(
                    stream_key=self._descriptor.key,
                    symbol=self._descriptor.symbol,
                    stream_type=st,
                    gap_start=self._last_continuity_key,
                    gap_end=continuity_key,
                    expected_count=gap_count,
                    filled=False,
                )
                if self._on_gap:
                    await self._on_gap(gap)

            elif continuity_key < (expected_next or continuity_key):
                self._metrics.inc("events_out_of_order")

        # ── Emit ──
        await self._emit(event)

    # ── Internal: Emit ───────────────────────────────────────

    async def _emit(self, event: MarketEvent) -> None:
        ck = event.continuity_key
        if ck is not None:
            if self._last_continuity_key is None or ck >= self._last_continuity_key:
                self._last_continuity_key = ck

        self._metrics.inc("events_emitted")
        self._metrics.mark("last_emit_at")

        if self._on_event:
            await self._on_event(event)

    # ── Internal: Gap helpers ────────────────────────────────

    def _compute_expected_next(self, st: StreamType) -> int | None:
        if self._last_continuity_key is None:
            return None
        if st == StreamType.KLINE and self._interval_ms:
            return self._last_continuity_key + self._interval_ms
        if st in (StreamType.AGG_TRADE, StreamType.TRADE):
            return self._last_continuity_key + 1
        return None

    def _estimate_gap_count(self, st: StreamType, expected: int, actual: int) -> int:
        if st == StreamType.KLINE and self._interval_ms:
            return (actual - expected) // self._interval_ms
        if st in (StreamType.AGG_TRADE, StreamType.TRADE):
            return actual - expected
        return 0
