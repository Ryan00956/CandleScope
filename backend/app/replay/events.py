"""Bounded replay domain-event retention independent of transport batching."""

from __future__ import annotations

from collections import deque

from .models import ReplayEvent, validate_counter


class ReplayEventBuffer:
    def __init__(self, *, max_events: int, initial_sequence: int = 0) -> None:
        if isinstance(max_events, bool) or not isinstance(max_events, int) or max_events < 1:
            raise ValueError("max_events must be a positive integer")
        self._max_events = max_events
        self._events: deque[ReplayEvent] = deque(maxlen=max_events)
        self._last_sequence = validate_counter(
            initial_sequence,
            field_name="initial_sequence",
        )
        self._evicted = 0

    @property
    def last_sequence(self) -> int:
        return self._last_sequence

    def append(self, event: ReplayEvent) -> None:
        if not isinstance(event, ReplayEvent):
            raise TypeError("event must be ReplayEvent")
        expected = self._last_sequence + 1
        if event.sequence != expected:
            raise ValueError(
                f"domain event sequence must be {expected}, got {event.sequence}"
            )
        if len(self._events) == self._max_events:
            self._evicted += 1
        self._events.append(event)
        self._last_sequence = event.sequence

    def after(self, after_sequence: int) -> tuple[ReplayEvent, ...] | None:
        after = validate_counter(after_sequence, field_name="after_sequence")
        if after == self._last_sequence:
            return ()
        if after > self._last_sequence:
            return None
        if not self._events:
            return None
        required = after + 1
        if required < self._events[0].sequence:
            return None
        return tuple(event for event in self._events if event.sequence > after)

    def diagnostics(self) -> dict[str, int]:
        return {
            "retained": len(self._events),
            "max_events": self._max_events,
            "last_sequence": self._last_sequence,
            "oldest_sequence": self._events[0].sequence if self._events else 0,
            "evicted": self._evicted,
        }
