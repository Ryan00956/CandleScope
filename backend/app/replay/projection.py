"""Rate-bounded projection batching that never rewrites domain sequence."""

from __future__ import annotations

import math
from dataclasses import dataclass

from .models import ReplayEvent


@dataclass(frozen=True, slots=True)
class ProjectionBatch:
    sequence_from: int
    sequence_to: int
    latest_event: ReplayEvent
    mandatory: bool

    @property
    def event_count(self) -> int:
        return self.sequence_to - self.sequence_from + 1


class ProjectionCoalescer:
    def __init__(self, *, max_fps: int) -> None:
        if isinstance(max_fps, bool) or not isinstance(max_fps, int) or max_fps < 1:
            raise ValueError("max_fps must be a positive integer")
        self._max_fps = max_fps
        self._minimum_interval = 1.0 / max_fps
        self._last_ordinary_emit_wall: float | None = None
        self._last_offer_wall: float | None = None
        self._pending: ProjectionBatch | None = None
        self._metrics = {
            "domain_events": 0,
            "ordinary_emitted": 0,
            "ordinary_coalesced": 0,
            "mandatory_emitted": 0,
            "flushes": 0,
        }

    def offer(
        self,
        event: ReplayEvent,
        *,
        wall_time: float,
        mandatory: bool = False,
    ) -> tuple[ProjectionBatch, ...]:
        if not isinstance(event, ReplayEvent):
            raise TypeError("event must be ReplayEvent")
        wall = self._validate_wall_time(wall_time)
        if self._last_offer_wall is not None and wall < self._last_offer_wall:
            raise ValueError("projection wall_time cannot move backward")
        self._last_offer_wall = wall
        self._metrics["domain_events"] += 1
        emitted: list[ProjectionBatch] = []
        if mandatory:
            emitted.extend(self.flush())
            emitted.append(
                ProjectionBatch(
                    sequence_from=event.sequence,
                    sequence_to=event.sequence,
                    latest_event=event,
                    mandatory=True,
                )
            )
            self._metrics["mandatory_emitted"] += 1
            return tuple(emitted)

        can_emit = (
            self._pending is None
            and (
                self._last_ordinary_emit_wall is None
                or wall - self._last_ordinary_emit_wall >= self._minimum_interval
            )
        )
        if can_emit:
            emitted.append(
                ProjectionBatch(
                    sequence_from=event.sequence,
                    sequence_to=event.sequence,
                    latest_event=event,
                    mandatory=False,
                )
            )
            self._last_ordinary_emit_wall = wall
            self._metrics["ordinary_emitted"] += 1
            return tuple(emitted)

        if self._pending is None:
            self._pending = ProjectionBatch(
                sequence_from=event.sequence,
                sequence_to=event.sequence,
                latest_event=event,
                mandatory=False,
            )
        else:
            self._pending = ProjectionBatch(
                sequence_from=self._pending.sequence_from,
                sequence_to=event.sequence,
                latest_event=event,
                mandatory=False,
            )
            self._metrics["ordinary_coalesced"] += 1
        return ()

    def flush(self) -> tuple[ProjectionBatch, ...]:
        if self._pending is None:
            return ()
        pending = self._pending
        self._pending = None
        self._metrics["ordinary_emitted"] += 1
        self._metrics["flushes"] += 1
        return (pending,)

    def diagnostics(self) -> dict[str, int]:
        return {
            **self._metrics,
            "max_fps": self._max_fps,
            "pending": int(self._pending is not None),
        }

    @staticmethod
    def _validate_wall_time(value: float) -> float:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise TypeError("wall_time must be a number")
        wall = float(value)
        if not math.isfinite(wall):
            raise ValueError("wall_time must be finite")
        return wall
