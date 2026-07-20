"""Deterministic virtual-time scheduling primitives for replay actors."""

from __future__ import annotations

import math
import time
from dataclasses import dataclass
from typing import Callable

from .constants import PLAYBACK_SPEEDS
from .models import validate_timestamp_ms


CLOCK_SCHEMA_VERSION = "replay-clock.v1"
ReplaySpeed = int | str


def validate_speed(value: object) -> ReplaySpeed:
    if isinstance(value, bool) or value not in PLAYBACK_SPEEDS:
        allowed = ", ".join(str(item) for item in PLAYBACK_SPEEDS)
        raise ValueError(f"speed must be one of {allowed}")
    return value  # type: ignore[return-value]


@dataclass(frozen=True, slots=True)
class ClockSnapshot:
    schema_version: str
    virtual_time_ms: int
    speed: ReplaySpeed
    playing: bool

    def __post_init__(self) -> None:
        if self.schema_version != CLOCK_SCHEMA_VERSION:
            raise ValueError(f"clock schema must be {CLOCK_SCHEMA_VERSION}")
        object.__setattr__(
            self,
            "virtual_time_ms",
            validate_timestamp_ms(self.virtual_time_ms, field_name="virtual_time_ms"),
        )
        object.__setattr__(self, "speed", validate_speed(self.speed))
        if not isinstance(self.playing, bool):
            raise TypeError("playing must be a boolean")

    def to_dict(self) -> dict[str, object]:
        return {
            "schema_version": self.schema_version,
            "virtual_time_ms": self.virtual_time_ms,
            "speed": self.speed,
            "playing": self.playing,
        }


class VirtualClock:
    """Actor-owned virtual clock; wall time affects scheduling, never hashing."""

    def __init__(
        self,
        *,
        initial_time_ms: int,
        speed: ReplaySpeed = 1,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self._virtual_time_ms = validate_timestamp_ms(
            initial_time_ms,
            field_name="initial_time_ms",
        )
        self._speed = validate_speed(speed)
        self._monotonic = monotonic
        self._playing = False
        self._anchor_wall = self._read_wall()
        self._anchor_virtual_ms = self._virtual_time_ms

    @classmethod
    def from_snapshot(
        cls,
        snapshot: ClockSnapshot,
        *,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> "VirtualClock":
        if not isinstance(snapshot, ClockSnapshot):
            raise TypeError("snapshot must be ClockSnapshot")
        clock = cls(
            initial_time_ms=snapshot.virtual_time_ms,
            speed=snapshot.speed,
            monotonic=monotonic,
        )
        if snapshot.playing:
            clock.start()
        return clock

    @property
    def virtual_time_ms(self) -> int:
        return self._virtual_time_ms

    @property
    def speed(self) -> ReplaySpeed:
        return self._speed

    @property
    def playing(self) -> bool:
        return self._playing

    def start(self) -> None:
        if self._playing:
            return
        self._playing = True
        self._anchor_wall = self._read_wall()
        self._anchor_virtual_ms = self._virtual_time_ms

    def pause(self, *, cap_ms: int | None = None) -> int:
        if self._playing:
            self.materialize(cap_ms=cap_ms)
            self._playing = False
        return self._virtual_time_ms

    def materialize(self, *, cap_ms: int | None = None) -> int:
        cap = None
        if cap_ms is not None:
            cap = validate_timestamp_ms(cap_ms, field_name="cap_ms")
            if cap < self._virtual_time_ms:
                raise ValueError("cap_ms cannot move virtual time backward")
        if not self._playing or self._speed == "MAX":
            return self._virtual_time_ms
        now = self._read_wall()
        elapsed = now - self._anchor_wall
        if elapsed < 0:
            raise RuntimeError("monotonic clock moved backward")
        delta_ms = math.floor((elapsed * 1_000 * int(self._speed)) + 1e-7)
        candidate = self._anchor_virtual_ms + delta_ms
        if cap is not None:
            candidate = min(candidate, cap)
        self._virtual_time_ms = validate_timestamp_ms(
            candidate,
            field_name="virtual_time_ms",
        )
        self._anchor_wall = now
        self._anchor_virtual_ms = self._virtual_time_ms
        return self._virtual_time_ms

    def set_speed(self, speed: ReplaySpeed, *, cap_ms: int | None = None) -> None:
        normalized = validate_speed(speed)
        if self._playing:
            self.materialize(cap_ms=cap_ms)
        self._speed = normalized
        self._anchor_wall = self._read_wall()
        self._anchor_virtual_ms = self._virtual_time_ms

    def delay_until(self, target_time_ms: int) -> float:
        target = validate_timestamp_ms(target_time_ms, field_name="target_time_ms")
        if self._playing:
            self.materialize(cap_ms=max(self._virtual_time_ms, target))
        if target <= self._virtual_time_ms or self._speed == "MAX":
            return 0.0
        return (target - self._virtual_time_ms) / (int(self._speed) * 1_000)

    def advance_to(self, target_time_ms: int) -> int:
        target = validate_timestamp_ms(target_time_ms, field_name="target_time_ms")
        if self._playing:
            self.materialize(cap_ms=max(self._virtual_time_ms, target))
        if target < self._virtual_time_ms:
            raise ValueError("virtual clock cannot move backward")
        self._virtual_time_ms = target
        self._anchor_wall = self._read_wall()
        self._anchor_virtual_ms = target
        return target

    def snapshot(self) -> ClockSnapshot:
        if self._playing:
            self.materialize()
        return ClockSnapshot(
            schema_version=CLOCK_SCHEMA_VERSION,
            virtual_time_ms=self._virtual_time_ms,
            speed=self._speed,
            playing=self._playing,
        )

    def _read_wall(self) -> float:
        value = self._monotonic()
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise TypeError("monotonic clock must return a number")
        if not math.isfinite(float(value)):
            raise ValueError("monotonic clock must return a finite number")
        return float(value)
