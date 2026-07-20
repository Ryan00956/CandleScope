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
        data={
            "source_sequence": sequence,
            "value": sequence,
            "projection": {
                "bar_update": None,
                "orders": [],
                "fills": [],
                "warnings": [],
                "position": {},
                "account": {},
            },
        },
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


def test_projection_pending_frame_flushes_on_deadline_without_another_offer() -> None:
    coalescer = ProjectionCoalescer(max_fps=30)
    assert coalescer.offer(_event(1), wall_time=20.0)
    assert coalescer.offer(_event(2), wall_time=20.001) == ()
    assert coalescer.flush_due(wall_time=20.02) == ()
    flushed = coalescer.flush_due(wall_time=20.034)
    assert [(batch.sequence_from, batch.sequence_to) for batch in flushed] == [
        (2, 2)
    ]


def test_projection_never_claims_a_range_for_unmergeable_ordinary_payloads() -> None:
    coalescer = ProjectionCoalescer(max_fps=30)
    assert coalescer.offer(_event(1), wall_time=25.0)
    assert coalescer.offer(_event(2), wall_time=25.001) == ()
    unmergeable = ReplayEvent(
        type=ReplayEventType.DELTA,
        protocol=REPLAY_PROTOCOL,
        session_id="session-events",
        sequence=3,
        revision=1,
        virtual_time_ms=1_003,
        state_hash=DIGEST,
        data_epoch=DIGEST,
        data={"value": 3},
    )
    emitted = coalescer.offer(unmergeable, wall_time=25.002)
    assert [(batch.sequence_from, batch.sequence_to) for batch in emitted] == [
        (2, 2),
        (3, 3),
    ]
    assert [batch.latest_event.data["value"] for batch in emitted] == [2, 3]


def test_projection_malformed_bar_update_cannot_hide_inside_a_valid_range() -> None:
    coalescer = ProjectionCoalescer(max_fps=30)
    assert coalescer.offer(_event(1), wall_time=27.0)
    malformed = ReplayEvent(
        type=ReplayEventType.DELTA,
        protocol=REPLAY_PROTOCOL,
        session_id="session-events",
        sequence=2,
        revision=1,
        virtual_time_ms=1_002,
        state_hash=DIGEST,
        data_epoch=DIGEST,
        data={
            "source_sequence": 2,
            "projection": {
                "bar_update": {"action": "batch", "updates": [42]},
                "orders": [],
                "fills": [],
                "warnings": [],
                "position": {},
                "account": {},
            },
        },
    )
    assert coalescer.offer(malformed, wall_time=27.001) == ()
    emitted = coalescer.offer(_event(3), wall_time=27.002)
    assert [(batch.sequence_from, batch.sequence_to) for batch in emitted] == [
        (2, 2),
        (3, 3),
    ]
    malformed_update = emitted[0].latest_event.data["projection"]["bar_update"]
    assert malformed_update["action"] == "batch"
    assert tuple(malformed_update["updates"]) == (42,)


def test_projection_batch_wire_range_and_bar_updates_preserve_structural_appends() -> None:
    def delta(sequence: int, action: str, open_time_ms: int, close: str) -> ReplayEvent:
        return ReplayEvent(
            type=ReplayEventType.DELTA,
            protocol=REPLAY_PROTOCOL,
            session_id="session-events",
            sequence=sequence,
            revision=1,
            virtual_time_ms=1_000 + sequence,
            state_hash=DIGEST,
            data_epoch=DIGEST,
            data={
                "source_sequence": sequence,
                "source_event": {"event_time_ms": 1_000 + sequence},
                "projection": {
                    "bar_update": {
                        "action": action,
                        "bar": {"open_time_ms": open_time_ms, "close": close},
                        "source_sequence": sequence,
                    },
                    "orders": [],
                    "fills": [],
                    "warnings": [],
                    "position": {},
                    "account": {},
                },
            },
        )

    coalescer = ProjectionCoalescer(max_fps=30)
    coalescer.offer(_event(1), wall_time=30.0)
    assert coalescer.offer(delta(2, "append", 2_000, "1"), wall_time=30.001) == ()
    assert coalescer.offer(delta(3, "tick", 2_000, "2"), wall_time=30.002) == ()
    assert coalescer.offer(delta(4, "tick", 2_000, "3"), wall_time=30.003) == ()
    assert coalescer.offer(delta(5, "append", 3_000, "4"), wall_time=30.004) == ()
    emitted = coalescer.offer(
        _event(6, event_type=ReplayEventType.STATUS),
        wall_time=30.005,
        mandatory=True,
    )
    batch = emitted[0]
    assert (batch.sequence_from, batch.sequence_to) == (2, 5)
    wire = batch.to_wire_dict()
    assert wire["sequence"] == wire["sequence_to"] == 5
    assert wire["sequence_from"] == 2
    projection = wire["data"]["projection"]  # type: ignore[index]
    update = projection["bar_update"]  # type: ignore[index]
    assert update["action"] == "batch"  # type: ignore[index]
    assert [
        (item["action"], item["bar"]["open_time_ms"], item["bar"]["close"])
        for item in update["updates"]  # type: ignore[index]
    ] == [
        ("append", 2_000, "1"),
        ("tick", 2_000, "3"),
        ("append", 3_000, "4"),
    ]


def test_projection_pending_merge_defers_event_materialization_until_flush(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events = [_event(sequence) for sequence in (1, 2, 3)]
    original_post_init = ReplayEvent.__post_init__
    materializations = 0

    def counted_post_init(event: ReplayEvent) -> None:
        nonlocal materializations
        materializations += 1
        original_post_init(event)

    monkeypatch.setattr(ReplayEvent, "__post_init__", counted_post_init)
    coalescer = ProjectionCoalescer(max_fps=30)
    assert coalescer.offer(events[0], wall_time=40.0)
    assert coalescer.offer(events[1], wall_time=40.001) == ()
    assert coalescer.offer(events[2], wall_time=40.002) == ()
    assert materializations == 0

    flushed = coalescer.flush()
    assert [(batch.sequence_from, batch.sequence_to) for batch in flushed] == [
        (2, 3)
    ]
    assert materializations == 1


def test_projection_rejects_malformed_batch_without_partially_mutating_pending() -> None:
    def delta(sequence: int, bar_update: object) -> ReplayEvent:
        return ReplayEvent(
            type=ReplayEventType.DELTA,
            protocol=REPLAY_PROTOCOL,
            session_id="session-events",
            sequence=sequence,
            revision=1,
            virtual_time_ms=2_000 + sequence,
            state_hash=DIGEST,
            data_epoch=DIGEST,
            data={
                "projection": {
                    "bar_update": bar_update,
                    "orders": [],
                    "fills": [],
                    "warnings": [],
                    "position": {},
                    "account": {},
                }
            },
        )

    def append(open_time_ms: int) -> dict[str, object]:
        return {"action": "append", "bar": {"open_time_ms": open_time_ms}}

    coalescer = ProjectionCoalescer(max_fps=30)
    assert coalescer.offer(_event(1), wall_time=50.0)
    assert coalescer.offer(delta(2, append(2_000)), wall_time=50.001) == ()
    assert coalescer.offer(delta(3, append(3_000)), wall_time=50.002) == ()
    malformed = {"action": "batch", "updates": [append(4_000), 42]}
    emitted = coalescer.offer(delta(4, malformed), wall_time=50.003)

    assert [(batch.sequence_from, batch.sequence_to) for batch in emitted] == [
        (2, 3),
        (4, 4),
    ]
    prior = emitted[0].latest_event.data["projection"]["bar_update"]
    assert [
        update["bar"]["open_time_ms"] for update in prior["updates"]
    ] == [2_000, 3_000]


def test_projection_frozen_wall_forces_lossless_bounded_frames() -> None:
    coalescer = ProjectionCoalescer(max_fps=30, max_pending_events=2)
    emitted = list(coalescer.offer(_event(1), wall_time=60.0))
    for sequence in range(2, 8):
        emitted.extend(coalescer.offer(_event(sequence), wall_time=60.0))
        assert coalescer.diagnostics()["pending_events"] <= 2
    emitted.extend(coalescer.flush())

    assert [(batch.sequence_from, batch.sequence_to) for batch in emitted] == [
        (1, 1),
        (2, 3),
        (4, 5),
        (6, 7),
    ]
    assert sum(batch.event_count for batch in emitted) == 7
    diagnostics = coalescer.diagnostics()
    assert diagnostics["capacity_forced_flushes"] == 3
    assert diagnostics["pending_events"] == 0
    assert diagnostics["max_pending_events"] == 2
