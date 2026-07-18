from __future__ import annotations

import pytest

from app.replay.constants import REPLAY_PROTOCOL, ReplayEventType
from app.replay.events import ReplayEventBuffer
from app.replay.models import ReplayEvent
from app.replay.projection import ProjectionCoalescer


DIGEST = "sha256:" + ("a" * 64)


def _event(sequence: int, *, event_type: ReplayEventType = ReplayEventType.DELTA) -> ReplayEvent:
    return ReplayEvent(
        type=event_type,
        protocol=REPLAY_PROTOCOL,
        session_id="session-events",
        sequence=sequence,
        revision=1,
        virtual_time_ms=1_000 + sequence,
        state_hash=DIGEST,
        data_epoch=DIGEST,
        data={"value": sequence},
    )


def test_domain_event_buffer_is_bounded_and_resume_fails_closed_on_missing_sequence() -> None:
    buffer = ReplayEventBuffer(max_events=3)
    for sequence in (1, 2, 3):
        buffer.append(_event(sequence))
    assert [event.sequence for event in buffer.after(1) or ()] == [2, 3]
    assert buffer.after(3) == ()

    buffer.append(_event(4))
    assert buffer.after(0) is None
    assert [event.sequence for event in buffer.after(1) or ()] == [2, 3, 4]
    assert buffer.diagnostics()["evicted"] == 1
    with pytest.raises(ValueError, match="sequence"):
        buffer.append(_event(6))


def test_projection_coalescing_preserves_domain_sequence_ranges_and_mandatory_events() -> None:
    coalescer = ProjectionCoalescer(max_fps=30)
    first = coalescer.offer(_event(1), wall_time=10.0)
    assert [(item.sequence_from, item.sequence_to) for item in first] == [(1, 1)]

    assert coalescer.offer(_event(2), wall_time=10.001) == ()
    assert coalescer.offer(_event(3), wall_time=10.002) == ()
    emitted = coalescer.offer(
        _event(4, event_type=ReplayEventType.STATUS),
        wall_time=10.003,
        mandatory=True,
    )
    assert [(item.sequence_from, item.sequence_to) for item in emitted] == [
        (2, 3),
        (4, 4),
    ]
    assert emitted[0].latest_event.sequence == 3
    assert emitted[0].mandatory is False
    assert emitted[1].mandatory is True
    assert coalescer.diagnostics()["domain_events"] == 4
    assert coalescer.diagnostics()["ordinary_coalesced"] == 1

    later = coalescer.offer(_event(5), wall_time=10.04)
    assert [(item.sequence_from, item.sequence_to) for item in later] == [(5, 5)]
    assert coalescer.flush() == ()
