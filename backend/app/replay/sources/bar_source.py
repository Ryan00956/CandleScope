"""Immutable BAR dataset reader implementing the shared source contract."""

from __future__ import annotations

from ..dataset import BarDatasetRef, BarDatasetSnapshot, ReplayBar
from .base import SourceCursor


class BarReplaySource:
    def __init__(self, snapshot: BarDatasetSnapshot) -> None:
        self._snapshot = snapshot
        self._rows = snapshot.replay_rows
        self._index = 0

    def snapshot_ref(self) -> BarDatasetRef:
        return self._snapshot.snapshot_ref()

    def peek(self) -> ReplayBar | None:
        if self._index >= len(self._rows):
            return None
        return self._rows[self._index]

    def next(self) -> ReplayBar | None:
        event = self.peek()
        if event is None:
            return None
        self._index += 1
        return event

    def advance_until(self, target_time_ms: int) -> tuple[ReplayBar, ...]:
        if isinstance(target_time_ms, bool) or not isinstance(target_time_ms, int):
            raise TypeError("target_time_ms must be an integer")
        if target_time_ms < 0:
            raise ValueError("target_time_ms cannot be negative")
        events: list[ReplayBar] = []
        while (event := self.peek()) is not None and event.close_time_ms <= target_time_ms:
            consumed = self.next()
            if consumed is not None:
                events.append(consumed)
        return tuple(events)

    def cursor(self) -> SourceCursor:
        previous = self._rows[self._index - 1] if self._index > 0 else None
        return SourceCursor(
            source_sequence=self._index,
            last_event_time_ms=(
                previous.close_time_ms if previous is not None else None
            ),
            last_base_bar_open_ms=(
                previous.open_time_ms if previous is not None else None
            ),
            at_end=self.exhausted(),
        )

    def exhausted(self) -> bool:
        return self._index >= len(self._rows)
