from __future__ import annotations

from app.indicator.pyne import PyneIncrementalSession, PyneIncrementalSessionManager


SCRIPT = """
def init(ctx):
    ctx.state("count", 0)

def on_bar(ctx, bar):
    counter = ctx.state("count")
    counter.value += 1
    ctx.plot("Count", counter.value)
"""


def _bars(count: int) -> list[dict]:
    return [
        {
            "time": 1_700_000_000 + index * 60,
            "open": 100 + index,
            "high": 101 + index,
            "low": 99 + index,
            "close": 100 + index,
            "volume": 10 + index,
        }
        for index in range(count)
    ]


def _factory() -> PyneIncrementalSession:
    return PyneIncrementalSession(script=SCRIPT, params={}, security_mode="safe")


def test_pyne_warm_resume_catches_up_and_matches_fresh_seed_and_next_update():
    bars = _bars(5)
    warm_manager = PyneIncrementalSessionManager()
    warm = warm_manager.acquire("shared", _factory)
    warm_manager.seed_or_snapshot(warm, bars[:2])
    warm_manager.release("shared", retain=True)

    resumed = warm_manager.acquire("shared", _factory)
    resumed_result = warm_manager.seed_or_snapshot(resumed, bars[:4])

    fresh_manager = PyneIncrementalSessionManager()
    fresh = fresh_manager.acquire("fresh", _factory)
    fresh_result = fresh_manager.seed_or_snapshot(fresh, bars[:4])

    assert resumed_result.lines == fresh_result.lines
    resumed_next = warm_manager.process_bar(resumed, bars[4], preview=False)
    fresh_next = fresh_manager.process_bar(fresh, bars[4], preview=False)
    assert resumed_next.lines == fresh_next.lines
