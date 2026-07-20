from __future__ import annotations

import enum
from dataclasses import dataclass

from app.data_engine.interval_policy import (
    interval_tiles,
    intervals_equivalent,
    parse_interval_spec,
)


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
        if intervals_equivalent(interval, self.base_interval):
            return False
        target = parse_interval_spec(interval)
        base = parse_interval_spec(self.base_interval)
        return bool(
            target is not None
            and base is not None
            and base.nominal_ms < target.nominal_ms
            and interval_tiles(base, target)
        )

    def should_fanout_realtime_base(self, source_interval: str, target_interval: str) -> bool:
        if self.update_mode != RealtimeUpdateMode.BASE_INTERVAL_FANOUT:
            return False
        if not intervals_equivalent(source_interval, self.base_interval):
            return False
        target = parse_interval_spec(target_interval)
        base = parse_interval_spec(self.base_interval)
        return bool(
            target is not None
            and base is not None
            and base.nominal_ms < target.nominal_ms
            and interval_tiles(base, target)
        )
