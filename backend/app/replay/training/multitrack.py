"""Deterministic replay.v2 multi-market coordination primitives."""

from __future__ import annotations

import asyncio
from collections.abc import Iterable, Mapping, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import AsyncIterator

from app.replay.canonical import canonical_sha256
from app.replay.models import validate_identifier, validate_timestamp_ms

from .models import AdvanceBasis, coerce_enum, validate_v2_counter


GLOBAL_ORDERING_VERSION = "replay.global-order.v1"
MARKET_EVENT_PHASE = 20


@dataclass(frozen=True, slots=True)
class StableMarketEvent:
    """The frozen total-order key for one source event in a TrainingRun."""

    actual_event_time_ms: int
    event_phase: int
    market_track_stable_id: str
    source_sequence: int

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "actual_event_time_ms",
            validate_timestamp_ms(
                self.actual_event_time_ms,
                field_name="actual_event_time_ms",
            ),
        )
        object.__setattr__(
            self,
            "event_phase",
            validate_v2_counter(self.event_phase, field_name="event_phase"),
        )
        object.__setattr__(
            self,
            "market_track_stable_id",
            validate_identifier(
                self.market_track_stable_id,
                field_name="market_track_stable_id",
            ),
        )
        sequence = validate_v2_counter(
            self.source_sequence,
            field_name="source_sequence",
        )
        if sequence < 1:
            raise ValueError("source_sequence must be positive")
        object.__setattr__(self, "source_sequence", sequence)

    @property
    def ordering_key(self) -> tuple[int, int, str, int]:
        return (
            self.actual_event_time_ms,
            self.event_phase,
            self.market_track_stable_id,
            self.source_sequence,
        )

    def to_dict(self) -> dict[str, object]:
        return {
            "actual_event_time_ms": self.actual_event_time_ms,
            "event_phase": self.event_phase,
            "market_track_stable_id": self.market_track_stable_id,
            "source_sequence": self.source_sequence,
        }


def stable_market_event_order(
    events: Iterable[StableMarketEvent],
) -> tuple[StableMarketEvent, ...]:
    materialized = tuple(events)
    if any(not isinstance(event, StableMarketEvent) for event in materialized):
        raise TypeError("events must contain StableMarketEvent values")
    ordered = tuple(sorted(materialized, key=lambda event: event.ordering_key))
    keys = [event.ordering_key for event in ordered]
    if len(keys) != len(set(keys)):
        raise ValueError("global market event ordering keys must be unique")
    return ordered


def global_ordering_hash(events: Sequence[StableMarketEvent]) -> str:
    ordered = stable_market_event_order(events)
    return canonical_sha256(
        {
            "schema_version": GLOBAL_ORDERING_VERSION,
            "events": [event.to_dict() for event in ordered],
        }
    )


class TrainingRunActor:
    """Serialize all domain mutations that share one TrainingRun clock."""

    def __init__(self, run_id: str) -> None:
        self.run_id = validate_identifier(run_id, field_name="run_id")
        self._lock = asyncio.Lock()
        self._playback_state = "PAUSED"
        self._playback_basis: AdvanceBasis | None = None
        self._playback_rate = 1
        self._playback_display_interval: str | None = None
        self._playback_viewer_revision: int | None = None
        self._playback_profile_revision = 0
        self._playback_client_id: str | None = None
        self._playback_reason: str | None = None
        self._playback_generation = 0
        self._playback_tick = 0
        self._playback_stop = asyncio.Event()
        self._playback_task: asyncio.Task[None] | None = None

    @asynccontextmanager
    async def serialized(self) -> AsyncIterator[None]:
        async with self._lock:
            yield

    def begin_ordered_playback(
        self,
        *,
        client_instance_id: str,
        basis: AdvanceBasis,
        rate: int,
        display_interval: str | None,
        viewer_revision: int | None,
    ) -> tuple[int, asyncio.Event]:
        """Start one server-owned playback generation while serialized."""

        if self._playback_state == "PLAYING":
            raise RuntimeError("ordered playback is already running")
        self._playback_generation += 1
        self._playback_tick = 0
        self._playback_state = "PLAYING"
        self._set_playback_profile(
            basis=basis,
            rate=rate,
            display_interval=display_interval,
            viewer_revision=viewer_revision,
        )
        self._playback_client_id = validate_identifier(
            client_instance_id,
            field_name="client_instance_id",
        )
        self._playback_reason = None
        self._playback_stop = asyncio.Event()
        self._playback_task = None
        return self._playback_generation, self._playback_stop

    def attach_ordered_playback_task(
        self,
        *,
        generation: int,
        task: asyncio.Task[None],
    ) -> None:
        if generation != self._playback_generation or self._playback_state != "PLAYING":
            task.cancel()
            raise RuntimeError("ordered playback generation is no longer active")
        self._playback_task = task

    def request_ordered_pause(
        self, *, reason: str = "PAUSED"
    ) -> asyncio.Task[None] | None:
        """Signal the loop without awaiting it while the actor lock is held."""

        if self._playback_state == "PLAYING":
            self._playback_state = "PAUSED"
            self._playback_reason = reason
            self._playback_stop.set()
        return self._playback_task

    def signal_ordered_stop(self) -> None:
        """Trip the pause barrier without changing state before serialization."""

        if self._playback_state == "PLAYING":
            self._playback_stop.set()

    def update_ordered_profile(
        self,
        *,
        basis: AdvanceBasis,
        rate: int,
        display_interval: str | None,
        viewer_revision: int | None,
    ) -> None:
        self._set_playback_profile(
            basis=basis,
            rate=rate,
            display_interval=display_interval,
            viewer_revision=viewer_revision,
        )

    def update_ordered_speed(self, speed: int | str) -> None:
        """Compatibility adapter for pre-Phase-13 callers."""

        if speed == "MAX":
            normalized = 10_000
        elif isinstance(speed, bool) or not isinstance(speed, int):
            raise ValueError("ordered playback speed is invalid")
        else:
            normalized = speed
        self._set_playback_profile(
            basis=self._playback_basis or AdvanceBasis.BASE_BAR,
            rate=normalized,
            display_interval=self._playback_display_interval,
            viewer_revision=self._playback_viewer_revision,
        )

    def next_playback_tick(self, generation: int) -> int:
        if generation != self._playback_generation or self._playback_state != "PLAYING":
            raise RuntimeError("ordered playback generation is no longer active")
        self._playback_tick += 1
        return self._playback_tick

    def playback_is_active(self, generation: int | None = None) -> bool:
        return self._playback_state == "PLAYING" and (
            generation is None or generation == self._playback_generation
        )

    def finish_ordered_playback(
        self,
        *,
        generation: int,
        state: str = "PAUSED",
        reason: str | None = None,
    ) -> None:
        if generation != self._playback_generation:
            return
        if state not in {"PAUSED", "ENDED", "ERROR"}:
            raise ValueError("ordered playback terminal state is invalid")
        self._playback_state = state
        self._playback_reason = reason
        self._playback_stop.set()
        self._playback_task = None

    def playback_snapshot(self) -> dict[str, object]:
        return {
            "contract": "replay.playback.v1",
            "mode": "ORDERED",
            "state": self._playback_state,
            "basis": (
                None if self._playback_basis is None else self._playback_basis.value
            ),
            "rate": self._playback_rate,
            "speed": self._playback_rate,
            "display_interval": self._playback_display_interval,
            "viewer_revision": self._playback_viewer_revision,
            "profile_revision": self._playback_profile_revision,
            "reason": self._playback_reason,
            "generation": self._playback_generation,
            "tick": self._playback_tick,
        }

    def _set_playback_profile(
        self,
        *,
        basis: AdvanceBasis,
        rate: int,
        display_interval: str | None,
        viewer_revision: int | None,
    ) -> None:
        normalized_basis = coerce_enum(
            AdvanceBasis,
            basis,
            field_name="playback basis",
        )
        normalized_rate = validate_v2_counter(rate, field_name="playback rate")
        if not 1 <= normalized_rate <= 10_000:
            raise ValueError("playback rate must be between 1 and 10000")
        if normalized_basis is AdvanceBasis.DISPLAY_BAR:
            if not isinstance(display_interval, str) or not display_interval:
                raise ValueError("display playback requires an interval")
            revision = validate_v2_counter(
                viewer_revision,
                field_name="viewer_revision",
            )
        else:
            if display_interval is not None or viewer_revision is not None:
                raise ValueError(
                    "non-display playback cannot carry a display binding"
                )
            revision = None
        self._playback_basis = normalized_basis
        self._playback_rate = normalized_rate
        self._playback_display_interval = display_interval
        self._playback_viewer_revision = revision
        self._playback_profile_revision += 1

    @property
    def playback_task(self) -> asyncio.Task[None] | None:
        return self._playback_task

    @property
    def playback_client_id(self) -> str | None:
        return self._playback_client_id

    @staticmethod
    def ordered_full_tracks(
        tracks: Iterable[Mapping[str, object]],
    ) -> tuple[Mapping[str, object], ...]:
        full = [track for track in tracks if track.get("subscription_tier") == "FULL"]
        return tuple(
            sorted(
                full,
                key=lambda track: (
                    validate_v2_counter(
                        track.get("stable_ordinal"),
                        field_name="stable_ordinal",
                    ),
                    validate_identifier(track.get("track_id"), field_name="track_id"),
                ),
            )
        )


__all__ = [
    "GLOBAL_ORDERING_VERSION",
    "MARKET_EVENT_PHASE",
    "StableMarketEvent",
    "TrainingRunActor",
    "global_ordering_hash",
    "stable_market_event_order",
]
