"""Shared replay source protocol used by BAR and future AGG_TRADE inputs."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable


@dataclass(frozen=True, slots=True)
class SourceCursor:
    source_sequence: int
    last_event_time_ms: int | None
    last_base_bar_open_ms: int | None
    at_end: bool


@runtime_checkable
class ReplayMarketSource(Protocol):
    def snapshot_ref(self) -> object: ...

    def peek(self) -> object | None: ...

    def next(self) -> object | None: ...

    def advance_until(self, target_time_ms: int) -> tuple[object, ...]: ...

    def cursor(self) -> SourceCursor: ...

    def exhausted(self) -> bool: ...
