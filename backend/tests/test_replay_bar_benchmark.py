from __future__ import annotations

from app.replay.constants import REPLAY_PROTOCOL, ReplayEventType
from app.replay.models import ReplayEvent
from app.replay.projection import ProjectionCoalescer
from scripts.benchmark_replay_actor import (
    BenchmarkReducer,
    _fixture,
)


DIGEST = "sha256:" + ("a" * 64)


def _event(sequence: int, projection: object) -> ReplayEvent:
    return ReplayEvent(
        type=ReplayEventType.DELTA,
        protocol=REPLAY_PROTOCOL,
        session_id="bar-benchmark-contract",
        sequence=sequence,
        revision=1,
        virtual_time_ms=1_000 + sequence,
        state_hash=DIGEST,
        data_epoch=DIGEST,
        data={"projection": projection},
    )


def test_bar_benchmark_reducer_uses_the_mergeable_projection_envelope() -> None:
    bars = _fixture(3).rows
    reducer = BenchmarkReducer()
    projections = [reducer.apply_source_event(bar) for bar in bars]

    assert set(projections[-1]) == {
        "count",
        "last_close_time_ms",
        "bar_update",
        "orders",
        "fills",
        "warnings",
        "position",
        "account",
    }
    assert projections[-1]["bar_update"] is None
    assert projections[-1]["orders"] == ()
    assert projections[-1]["fills"] == ()
    assert projections[-1]["warnings"] == ()
    assert projections[-1]["position"] == {}
    assert projections[-1]["account"] == {}

    coalescer = ProjectionCoalescer(max_fps=30)
    assert coalescer.offer(_event(1, projections[0]), wall_time=10.0)
    assert coalescer.offer(_event(2, projections[1]), wall_time=10.001) == ()
    assert coalescer.offer(_event(3, projections[2]), wall_time=10.002) == ()
    pending = coalescer.flush()
    assert [(batch.sequence_from, batch.sequence_to) for batch in pending] == [
        (2, 3)
    ]
    assert pending[0].latest_event.data["projection"]["count"] == 3
    assert coalescer.diagnostics()["ordinary_coalesced"] == 1
    assert reducer.snapshot() == {
        "count": 3,
        "last_close_time_ms": bars[-1].close_time_ms,
    }
