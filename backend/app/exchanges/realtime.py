from __future__ import annotations

import enum
from dataclasses import dataclass

from app.data_engine.interval_policy import is_standard_interval, parse_interval_ms


class RealtimeUpdateMode(str, enum.Enum):
    """How realtime bars should update higher intervals for an exchange."""

    NATIVE_INTERVAL = "native_interval"
    BASE_INTERVAL_FANOUT = "base_interval_fanout"
    POLLING = "polling"


@dataclass(frozen=True, slots=True)
class RealtimePolicy:
    """Exchange-owned realtime aggregation behavior."""

    update_mode: RealtimeUpdateMode = RealtimeUpdateMode.NATIVE_INTERVAL
    base_interval: str = "1m"

    def needs_base_stream(self, interval: str) -> bool:
        if self.update_mode != RealtimeUpdateMode.BASE_INTERVAL_FANOUT:
            return False
        if interval == self.base_interval:
            return False
        if not is_standard_interval(interval):
            return False
        requested_ms = parse_interval_ms(interval) or 0
        base_ms = parse_interval_ms(self.base_interval) or 0
        return requested_ms > base_ms

    def should_fanout_realtime_base(self, source_interval: str, target_interval: str) -> bool:
        if self.update_mode != RealtimeUpdateMode.BASE_INTERVAL_FANOUT:
            return False
        if source_interval != self.base_interval:
            return False
        target_ms = parse_interval_ms(target_interval) or 0
        base_ms = parse_interval_ms(self.base_interval) or 0
        return target_ms > base_ms
