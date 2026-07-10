"""Shared incremental session manager."""
from __future__ import annotations

import copy
import threading
from dataclasses import dataclass, field
from typing import Any, Callable

from .result import IncrementalPyneResult
from .session import PyneIncrementalSession


@dataclass
class SharedPyneIncrementalSession:
    key: str
    session: PyneIncrementalSession
    ref_count: int = 0
    seeded: bool = False
    lock: threading.RLock = field(default_factory=threading.RLock)
    last_event_key: tuple[Any, ...] | None = None
    last_event_result: IncrementalPyneResult | None = None
    last_reset_key: Any = None
    idle_generation: int = 0


class PyneIncrementalSessionManager:
    """Reference-counted in-process session cache for incremental Pyne."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._sessions: dict[str, SharedPyneIncrementalSession] = {}

    def acquire(
        self,
        key: str,
        factory: Callable[[], PyneIncrementalSession],
    ) -> SharedPyneIncrementalSession:
        with self._lock:
            shared = self._sessions.get(key)
            if shared is None:
                shared = SharedPyneIncrementalSession(key=key, session=factory(), ref_count=0)
                self._sessions[key] = shared
            shared.ref_count += 1
            return shared

    def release(self, key: str, *, retain: bool = False) -> int | None:
        with self._lock:
            shared = self._sessions.get(key)
            if shared is None:
                return None
            shared.ref_count = max(0, shared.ref_count - 1)
            if shared.ref_count <= 0:
                if retain:
                    shared.ref_count = 0
                    shared.idle_generation += 1
                    return shared.idle_generation
                else:
                    self._sessions.pop(key, None)
            return None

    def drop_if_idle(self, key: str, idle_generation: int | None = None) -> bool:
        """Drop a retained zero-ref session without touching a reacquired one."""
        with self._lock:
            shared = self._sessions.get(key)
            if shared is None or shared.ref_count > 0:
                return False
            if idle_generation is not None and shared.idle_generation != idle_generation:
                return False
            self._sessions.pop(key, None)
            return True

    def invalidate(self, key: str) -> bool:
        """Forget one shared session after a historical data correction."""
        with self._lock:
            return self._sessions.pop(key, None) is not None

    def reset_once(
        self,
        key: str,
        reset_key: Any,
        factory: Callable[[], PyneIncrementalSession],
    ) -> tuple[SharedPyneIncrementalSession | None, bool]:
        """Reset a shared session once for one historical correction event."""
        with self._lock:
            shared = self._sessions.get(key)
            if shared is None:
                return None, False
            with shared.lock:
                if shared.last_reset_key == reset_key:
                    return shared, False
                shared.session = factory()
                shared.seeded = False
                shared.last_event_key = None
                shared.last_event_result = None
                shared.last_reset_key = reset_key
                return shared, True

    def seed_or_snapshot(
        self,
        shared: SharedPyneIncrementalSession,
        ohlcv: list[dict[str, Any]],
        *,
        start_s: int | None = None,
        end_s: int | None = None,
        expected_step_s: int | None = None,
    ) -> IncrementalPyneResult:
        with shared.lock:
            if not shared.seeded:
                result = shared.session.seed(ohlcv, start_s=start_s, end_s=end_s)
                shared.seeded = True
                return copy.deepcopy(result)
            catch_up = [
                bar for bar in ohlcv
                if int(bar.get("time") or 0) > int(shared.session.last_closed_time or 0)
            ]
            input_times = {int(bar.get("time") or 0) for bar in ohlcv}
            last_closed_time = int(shared.session.last_closed_time or 0)
            if (
                catch_up
                and last_closed_time
                and input_times
                and expected_step_s is not None
                and (
                    (
                        int(expected_step_s) <= 0
                        and min(input_times) > last_closed_time
                    )
                    or (
                        int(expected_step_s) > 0
                        and min(input_times) > last_closed_time + int(expected_step_s)
                    )
                )
                and last_closed_time not in input_times
            ):
                result = shared.session.seed(ohlcv, start_s=start_s, end_s=end_s)
                shared.last_event_key = None
                shared.last_event_result = None
                return copy.deepcopy(result)
            latest_result = None
            for bar in catch_up:
                latest_result = shared.session.on_bar_closed(bar)
            if catch_up and latest_result is not None:
                last_bar = catch_up[-1]
                shared.last_event_key = (
                    "closed",
                    int(last_bar.get("time") or 0),
                    float(last_bar.get("open", 0)),
                    float(last_bar.get("high", 0)),
                    float(last_bar.get("low", 0)),
                    float(last_bar.get("close", 0)),
                    float(last_bar.get("volume", 0)),
                )
                shared.last_event_result = copy.deepcopy(latest_result)
            return copy.deepcopy(shared.session.snapshot_result(start_s=start_s, end_s=end_s))

    def process_bar(
        self,
        shared: SharedPyneIncrementalSession,
        bar: dict[str, Any],
        *,
        preview: bool,
    ) -> IncrementalPyneResult:
        event_key = (
            "preview" if preview else "closed",
            int(bar.get("time") or 0),
            float(bar.get("open", 0)),
            float(bar.get("high", 0)),
            float(bar.get("low", 0)),
            float(bar.get("close", 0)),
            float(bar.get("volume", 0)),
        )
        with shared.lock:
            if shared.last_event_key == event_key and shared.last_event_result is not None:
                return copy.deepcopy(shared.last_event_result)
            result = (
                shared.session.on_bar_updated(bar)
                if preview
                else shared.session.on_bar_closed(bar)
            )
            shared.last_event_key = event_key
            shared.last_event_result = copy.deepcopy(result)
            return result

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "sessions": len(self._sessions),
                "keys": {
                    key: {"refCount": shared.ref_count, "seeded": shared.seeded}
                    for key, shared in self._sessions.items()
                },
            }
