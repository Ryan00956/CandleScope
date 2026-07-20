from __future__ import annotations

import pytest

from app.replay.clock import ClockSnapshot, VirtualClock


class ManualMonotonic:
    def __init__(self, value: float = 10.0) -> None:
        self.value = value

    def __call__(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds


def test_virtual_clock_materializes_elapsed_time_and_preserves_speed_switch_boundary() -> None:
    wall = ManualMonotonic()
    clock = VirtualClock(initial_time_ms=1_000, monotonic=wall)

    clock.start()
    wall.advance(0.25)
    assert clock.materialize() == 1_250
    clock.set_speed(5)
    wall.advance(0.2)
    assert clock.materialize() == 2_250
    assert clock.pause() == 2_250
    wall.advance(5)
    assert clock.materialize() == 2_250


def test_pause_and_speed_switch_can_be_capped_at_the_next_source_boundary() -> None:
    wall = ManualMonotonic()
    clock = VirtualClock(initial_time_ms=1_000, monotonic=wall)

    clock.start()
    wall.advance(5)
    assert clock.pause(cap_ms=1_100) == 1_100

    clock.start()
    wall.advance(5)
    clock.set_speed(60, cap_ms=1_200)
    assert clock.virtual_time_ms == 1_200
    assert clock.speed == 60


def test_virtual_clock_deadlines_cover_same_time_long_gap_and_max_without_reordering() -> None:
    wall = ManualMonotonic()
    clock = VirtualClock(initial_time_ms=50_000, speed=60, monotonic=wall)
    clock.start()

    assert clock.delay_until(50_000) == 0
    assert clock.delay_until(110_000) == pytest.approx(1.0)
    clock.advance_to(110_000)
    assert clock.virtual_time_ms == 110_000
    with pytest.raises(ValueError, match="backward"):
        clock.advance_to(109_999)

    clock.set_speed("MAX")
    assert clock.delay_until(10_000_000) == 0


def test_clock_snapshot_round_trip_is_wall_clock_independent() -> None:
    wall = ManualMonotonic()
    clock = VirtualClock(initial_time_ms=1_710_000_000_000, speed=15, monotonic=wall)
    clock.start()
    wall.advance(0.1)
    snapshot = clock.snapshot()

    assert snapshot == ClockSnapshot(
        schema_version="replay-clock.v1",
        virtual_time_ms=1_710_000_001_500,
        speed=15,
        playing=True,
    )
    restored = VirtualClock.from_snapshot(snapshot, monotonic=ManualMonotonic(999.0))
    assert restored.snapshot() == snapshot


@pytest.mark.parametrize("speed", [0, -1, 2, 601, True, "FAST"])
def test_virtual_clock_rejects_speeds_outside_frozen_protocol(speed: object) -> None:
    with pytest.raises((TypeError, ValueError), match="speed"):
        VirtualClock(initial_time_ms=0, speed=speed)  # type: ignore[arg-type]
