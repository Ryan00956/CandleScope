from __future__ import annotations

import pytest

from pyne_runtime.incremental import IncrementalLimits, PyneIncrementalSessionManager
from pyne_runtime.incremental.limits import _LimitTracker
from pyne_runtime.security import PyneSecurityError


class DummySession:
    def __init__(self) -> None:
        self.seed_calls = 0
        self.snapshot_calls = 0
        self.closed_calls = 0
        self.preview_calls = 0
        self.last_closed_time = None

    def seed(self, ohlcv, *, start_s=None, end_s=None):
        self.seed_calls += 1
        if ohlcv:
            self.last_closed_time = int(ohlcv[-1]["time"])
        return {"kind": "seed", "bars": len(ohlcv), "start_s": start_s, "end_s": end_s}

    def snapshot_result(self, *, start_s=None, end_s=None):
        self.snapshot_calls += 1
        return {"kind": "snapshot", "start_s": start_s, "end_s": end_s}

    def on_bar_closed(self, bar):
        self.closed_calls += 1
        self.last_closed_time = int(bar["time"])
        return {"kind": "closed", "time": bar["time"], "calls": self.closed_calls}

    def on_bar_updated(self, bar):
        self.preview_calls += 1
        return {"kind": "preview", "time": bar["time"], "calls": self.preview_calls}


def test_incremental_session_manager_reference_counts_and_releases() -> None:
    manager = PyneIncrementalSessionManager()
    created: list[DummySession] = []

    def factory() -> DummySession:
        session = DummySession()
        created.append(session)
        return session

    first = manager.acquire("chart-a", factory)
    second = manager.acquire("chart-a", factory)

    assert first is second
    assert first.ref_count == 2
    assert len(created) == 1
    assert manager.snapshot()["keys"]["chart-a"]["refCount"] == 2

    manager.release("chart-a")
    assert manager.snapshot()["keys"]["chart-a"]["refCount"] == 1

    manager.release("chart-a")
    assert manager.snapshot()["sessions"] == 0


def test_incremental_session_manager_retains_idle_and_does_not_drop_reacquired_session() -> None:
    manager = PyneIncrementalSessionManager()
    first = manager.acquire("chart-a", DummySession)

    manager.release("chart-a", retain=True)
    assert manager.snapshot()["keys"]["chart-a"]["refCount"] == 0

    resumed = manager.acquire("chart-a", DummySession)
    assert resumed is first
    assert manager.drop_if_idle("chart-a") is False

    manager.release("chart-a", retain=True)
    assert manager.drop_if_idle("chart-a") is True
    assert manager.snapshot()["sessions"] == 0


def test_incremental_session_manager_ignores_stale_idle_timer_generation() -> None:
    manager = PyneIncrementalSessionManager()
    manager.acquire("chart-a", DummySession)
    first_generation = manager.release("chart-a", retain=True)

    manager.acquire("chart-a", DummySession)
    second_generation = manager.release("chart-a", retain=True)

    assert first_generation != second_generation
    assert manager.drop_if_idle("chart-a", first_generation) is False
    assert manager.drop_if_idle("chart-a", second_generation) is True


def test_incremental_session_manager_seeds_once_then_snapshots() -> None:
    manager = PyneIncrementalSessionManager()
    shared = manager.acquire("chart-a", DummySession)
    session = shared.session

    seeded = manager.seed_or_snapshot(shared, [{"time": 1}], start_s=1, end_s=2)
    snapshot = manager.seed_or_snapshot(shared, [{"time": 2}], start_s=3, end_s=4)

    assert seeded == {"kind": "seed", "bars": 1, "start_s": 1, "end_s": 2}
    assert snapshot == {"kind": "snapshot", "start_s": 3, "end_s": 4}
    assert session.seed_calls == 1
    assert session.snapshot_calls == 1
    assert manager.snapshot()["keys"]["chart-a"]["seeded"] is True


def test_incremental_session_manager_catches_up_new_closed_bars_on_warm_resume() -> None:
    manager = PyneIncrementalSessionManager()
    shared = manager.acquire("chart-a", DummySession)
    manager.seed_or_snapshot(shared, [{"time": 1}])

    manager.release("chart-a", retain=True)
    resumed = manager.acquire("chart-a", DummySession)
    manager.seed_or_snapshot(resumed, [{"time": 1}, {"time": 2}, {"time": 3}])

    assert resumed is shared
    assert resumed.session.seed_calls == 1
    assert resumed.session.closed_calls == 2


def test_incremental_session_manager_full_reseeds_when_warm_checkpoint_was_truncated() -> None:
    manager = PyneIncrementalSessionManager()
    shared = manager.acquire("chart-a", DummySession)
    manager.seed_or_snapshot(shared, [{"time": 1}, {"time": 2}])

    result = manager.seed_or_snapshot(
        shared,
        [{"time": 4}, {"time": 5}],
        expected_step_s=1,
    )

    assert shared.session.seed_calls == 2
    assert shared.session.closed_calls == 0
    assert result["bars"] == 2


def test_incremental_session_manager_resets_once_for_historical_correction() -> None:
    manager = PyneIncrementalSessionManager()
    shared = manager.acquire("chart-a", DummySession)
    manager.seed_or_snapshot(shared, [{"time": 1}])

    first, changed = manager.reset_once("chart-a", "repair-1", DummySession)
    second, changed_again = manager.reset_once("chart-a", "repair-1", DummySession)

    assert first is shared
    assert second is shared
    assert changed is True
    assert changed_again is False
    assert shared.seeded is False


def test_incremental_session_manager_dedupes_repeated_bar_events() -> None:
    manager = PyneIncrementalSessionManager()
    shared = manager.acquire("chart-a", DummySession)
    session = shared.session
    bar = {"time": 1, "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": 100}

    first = manager.process_bar(shared, bar, preview=False)
    second = manager.process_bar(shared, dict(bar), preview=False)
    preview = manager.process_bar(shared, dict(bar), preview=True)

    assert first == second
    assert first is not second
    assert preview["kind"] == "preview"
    assert session.closed_calls == 1
    assert session.preview_calls == 1


def test_incremental_limits_reject_oversized_windows() -> None:
    tracker = _LimitTracker(
        IncrementalLimits(
            enabled=True,
            max_window_size=2,
            max_total_window_items=3,
        )
    )

    tracker.reserve_window(2, label="fast")

    with pytest.raises(PyneSecurityError, match="exceeds safe-mode limit"):
        tracker.reserve_window(3, label="slow")

    with pytest.raises(PyneSecurityError, match="exceeding safe-mode total"):
        tracker.reserve_window(2, label="extra")
