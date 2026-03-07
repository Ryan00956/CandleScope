"""
Indicator Events — event types for the indicator engine.

These events flow from the IndicatorEngine to consumers (WebSocket
dispatcher, strategy engine, alert system, etc.).

The indicator engine *consumes* DataManager events (BAR_UPDATED,
BAR_CLOSED, etc.) and *produces* IndicatorEvents.
"""
from __future__ import annotations

import enum
import time
from dataclasses import dataclass, field
from typing import Any

from .types import IndicatorKey


class IndicatorEventType(str, enum.Enum):
    """Types of events produced by the indicator engine."""

    # ── Instance lifecycle ───────────────────────────────────
    INSTANCE_CREATED = "indicator.instance.created"
    INSTANCE_INITIALIZED = "indicator.instance.initialized"
    INSTANCE_DESTROYED = "indicator.instance.destroyed"

    # ── Computation results ──────────────────────────────────
    INDICATOR_UPDATED = "indicator.updated"          # new committed values (bar closed)
    INDICATOR_PREVIEW = "indicator.preview"          # preview values (bar forming)
    INDICATOR_RECOMPUTED = "indicator.recomputed"    # full recomputation done
    INDICATOR_ERROR = "indicator.error"              # computation error

    # ── Engine lifecycle ─────────────────────────────────────
    ENGINE_STARTED = "indicator.engine.started"
    ENGINE_STOPPED = "indicator.engine.stopped"


@dataclass(slots=True)
class IndicatorEvent:
    """Unified event wrapper for indicator engine events.

    Attributes:
        event_type:    What happened.
        key:           Which indicator instance this event relates to.
        values:        The computed values (for UPDATED / PREVIEW events).
                       Dict mapping output name → value.
        full_result:   Complete IndicatorResult (for INITIALIZED / RECOMPUTED).
                       Only populated for events that carry full series data.
        detail:        Arbitrary extra info (error messages, etc.).
        timestamp_ms:  When this event was created.
    """
    event_type: IndicatorEventType
    key: IndicatorKey
    values: dict[str, float | None] = field(default_factory=dict)
    full_result: Any = None  # IndicatorResult — avoid circular import
    detail: dict[str, Any] = field(default_factory=dict)
    timestamp_ms: int = field(default_factory=lambda: int(time.time() * 1000))
    bar_timestamp: int = 0  # the bar's timestamp (Unix seconds)

    def to_dict(self) -> dict:
        d: dict[str, Any] = {
            "event_type": self.event_type.value,
            "indicator_id": self.key.uid,
            "indicator_name": self.key.indicator_name,
            "symbol": self.key.symbol,
            "interval": self.key.interval,
            "timestamp_ms": self.timestamp_ms,
            "bar_timestamp": self.bar_timestamp,
        }
        if self.values:
            d["values"] = self.values
        if self.full_result is not None:
            d["full_result"] = (
                self.full_result.to_dict()
                if hasattr(self.full_result, "to_dict")
                else self.full_result
            )
        if self.detail:
            d["detail"] = self.detail
        return d
