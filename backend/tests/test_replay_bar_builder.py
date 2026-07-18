from __future__ import annotations

from copy import deepcopy

import pytest

from app.replay.bars.builder import (
    BAR_BUILDER_STATE_SCHEMA_VERSION,
    BarProjectionAction,
    ReplayBarBuilder,
)
from app.replay.errors import ReplayDomainError, ReplayErrorCode
from app.replay.sources.bar_source import BarReplaySource
from tests.fixtures.replay.bar_builder_fakes import (
    INTERVAL_MS,
    REPLAY_START_MS,
    make_bar_snapshot,
    make_replay_bar,
)


def _builder(
    *,
    display_interval: str = "5m",
    replay_start_ms: int = REPLAY_START_MS,
    warmup=(),
    max_closed_bars: int = 32,
) -> ReplayBarBuilder:
    return ReplayBarBuilder(
        base_interval="1m",
        display_interval=display_interval,
        replay_start_ms=replay_start_ms,
        warmup_bars=warmup,
        max_closed_bars=max_closed_bars,
    )


def test_warmup_builds_display_history_without_advancing_source_cursor() -> None:
    snapshot = make_bar_snapshot(warmup_count=7, replay_count=5)
    source = BarReplaySource(snapshot)
    builder = _builder(warmup=source.warmup_rows())

    assert source.cursor().source_sequence == 0
    assert builder.replay_events_applied == 0
    assert builder.active_bar is None
    assert len(builder.closed_bars) == 1
    assert builder.closed_bars[0].open_time_ms == REPLAY_START_MS - 5 * INTERVAL_MS
    assert builder.closed_bars[0].is_closed is True
    assert builder.closed_bars[0].synthetic is False
    replacement = builder.replace_projection()
    assert replacement["action"] == "replace"
    assert len(replacement["bars"]) == 1
    assert (
        max(bar["last_base_open_ms"] for bar in replacement["bars"]) < REPLAY_START_MS
    )


def test_warmup_prefix_can_seed_an_active_display_bar_without_future_components() -> (
    None
):
    replay_start_ms = REPLAY_START_MS + 2 * INTERVAL_MS
    snapshot = make_bar_snapshot(
        warmup_count=2,
        replay_count=5,
        replay_start_ms=replay_start_ms,
    )
    source = BarReplaySource(snapshot)
    builder = _builder(
        replay_start_ms=replay_start_ms,
        warmup=source.warmup_rows(),
    )

    active = builder.active_bar
    assert active is not None
    assert active.open_time_ms == REPLAY_START_MS
    assert active.last_base_open_ms == replay_start_ms - INTERVAL_MS
    assert active.component_count == 2
    assert active.is_closed is False
    assert source.cursor().source_sequence == 0

    with pytest.raises(ReplayDomainError) as incomplete:
        _builder(replay_start_ms=replay_start_ms)
    assert incomplete.value.code is ReplayErrorCode.DATASET_INCOMPLETE


def test_base_equals_display_appends_one_closed_bar_per_source_event() -> None:
    builder = _builder(display_interval="1m")
    bar = make_replay_bar(REPLAY_START_MS, 100, volume=0, quote_volume=0, trades=0)

    update = builder.apply_bar(bar)

    assert update.action is BarProjectionAction.APPEND
    assert update.bar.is_closed is True
    assert update.bar.open_time_ms == REPLAY_START_MS
    assert update.bar.volume == "0"
    assert update.bar.synthetic is False
    assert builder.active_bar is None
    assert builder.closed_bars == (update.bar,)
    assert builder.replay_events_applied == 1


def test_one_source_step_consumes_exactly_one_base_bar() -> None:
    snapshot = make_bar_snapshot(warmup_count=5, replay_count=3)
    source = BarReplaySource(snapshot)
    builder = _builder(warmup=source.warmup_rows())
    before_remaining = source.remaining_count()

    event = source.next()
    assert event is not None
    update = builder.apply_bar(event)

    assert source.remaining_count() == before_remaining - 1
    assert source.cursor().source_sequence == 1
    assert builder.replay_events_applied == 1
    assert update.source_sequence == 1
    assert update.base_open_time_ms == event.open_time_ms


def test_larger_display_uses_append_then_stable_time_ticks_and_closes_on_last_component() -> (
    None
):
    builder = _builder()
    updates = [
        builder.apply_bar(
            make_replay_bar(
                REPLAY_START_MS + index * INTERVAL_MS,
                100 + index,
                volume=index + 1,
            )
        )
        for index in range(5)
    ]

    assert [update.action for update in updates] == [
        BarProjectionAction.APPEND,
        BarProjectionAction.TICK,
        BarProjectionAction.TICK,
        BarProjectionAction.TICK,
        BarProjectionAction.TICK,
    ]
    assert {update.bar.open_time_ms for update in updates} == {REPLAY_START_MS}
    assert [update.bar.is_closed for update in updates] == [
        False,
        False,
        False,
        False,
        True,
    ]
    assert [update.bar.component_count for update in updates] == [1, 2, 3, 4, 5]
    closed = updates[-1].bar
    assert closed.open == "100"
    assert closed.high == "106"
    assert closed.low == "99"
    assert closed.close == "105"
    assert closed.volume == "15"
    assert closed.expected_components == 5
    assert closed.synthetic is False
    assert builder.active_bar is None
    assert builder.closed_bars == (closed,)
    assert updates[-1].to_dict()["bar"]["synthetic"] is False
    assert updates[-1].to_dict()["gap_policy"] == "reject"


def test_duplicate_out_of_order_gap_and_malformed_bar_fail_without_partial_state() -> (
    None
):
    first = make_replay_bar(REPLAY_START_MS, 100)
    cases = (
        (first, ReplayErrorCode.DATASET_MISMATCH),
        (
            make_replay_bar(REPLAY_START_MS - INTERVAL_MS, 99),
            ReplayErrorCode.DATASET_MISMATCH,
        ),
        (
            make_replay_bar(REPLAY_START_MS + 2 * INTERVAL_MS, 102),
            ReplayErrorCode.DATA_GAP,
        ),
        (
            make_replay_bar(REPLAY_START_MS + INTERVAL_MS, 101).__class__(
                **{
                    **make_replay_bar(
                        REPLAY_START_MS + INTERVAL_MS,
                        101,
                    ).to_dict(),
                    "close_time_ms": REPLAY_START_MS + 2 * INTERVAL_MS - 2,
                }
            ),
            ReplayErrorCode.DATASET_INCOMPLETE,
        ),
    )
    for invalid, expected_code in cases:
        builder = _builder()
        builder.apply_bar(first)
        before = builder.state_hash
        with pytest.raises(ReplayDomainError) as error:
            builder.apply_bar(invalid)
        assert error.value.code is expected_code
        assert builder.state_hash == before
        assert builder.replay_events_applied == 1

    builder = _builder()
    before = builder.state_hash
    with pytest.raises(ReplayDomainError) as forming:
        builder.apply_source_event(
            {
                "open_time_ms": REPLAY_START_MS,
                "close_time_ms": REPLAY_START_MS + INTERVAL_MS - 1,
                "is_closed": False,
            }
        )
    assert forming.value.code is ReplayErrorCode.DATASET_INCOMPLETE
    assert builder.state_hash == before


@pytest.mark.parametrize("component_position", [1, 2, 3, 4])
def test_snapshot_restore_preserves_active_bar_at_every_subperiod_position(
    component_position: int,
) -> None:
    bars = tuple(
        make_replay_bar(REPLAY_START_MS + index * INTERVAL_MS, 100 + index)
        for index in range(5)
    )
    builder = _builder()
    for bar in bars[:component_position]:
        builder.apply_bar(bar)

    snapshot = builder.snapshot()
    restored = _builder()
    restored.restore(snapshot)

    assert snapshot["schema_version"] == BAR_BUILDER_STATE_SCHEMA_VERSION
    assert restored.snapshot() == snapshot
    assert restored.state_hash == builder.state_hash
    assert restored.active_bar == builder.active_bar
    assert restored.apply_bar(bars[component_position]) == builder.apply_bar(
        bars[component_position]
    )
    assert restored.state_hash == builder.state_hash


def test_snapshot_restore_validates_hash_and_bounded_closed_chain() -> None:
    builder = _builder(display_interval="1m", max_closed_bars=2)
    for index in range(5):
        builder.apply_bar(
            make_replay_bar(REPLAY_START_MS + index * INTERVAL_MS, 100 + index)
        )

    assert builder.closed_count == 5
    assert len(builder.closed_bars) == 2
    snapshot = builder.snapshot()
    assert snapshot["closed_prefix_count"] == 3
    restored = _builder(display_interval="1m", max_closed_bars=2)
    restored.restore(snapshot)
    assert restored.snapshot() == snapshot

    corrupted = deepcopy(snapshot)
    corrupted["closed_bars"][-1]["close"] = "999"
    with pytest.raises(ReplayDomainError) as mismatch:
        _builder(display_interval="1m", max_closed_bars=2).restore(corrupted)
    assert mismatch.value.code is ReplayErrorCode.DATASET_MISMATCH


def test_snapshot_restore_binds_the_exact_warmup_prefix() -> None:
    snapshot = make_bar_snapshot(warmup_count=7, replay_count=5)
    source = BarReplaySource(snapshot)
    builder = _builder(warmup=source.warmup_rows())
    for _ in range(3):
        event = source.next()
        assert event is not None
        builder.apply_bar(event)

    checkpoint = builder.snapshot()
    restored = _builder(warmup=source.warmup_rows())
    restored.restore(checkpoint)
    assert restored.snapshot() == checkpoint

    wrong_warmup = source.warmup_rows()[1:]
    with pytest.raises(ReplayDomainError) as mismatch:
        _builder(warmup=wrong_warmup).restore(checkpoint)
    assert mismatch.value.code is ReplayErrorCode.DATASET_MISMATCH
