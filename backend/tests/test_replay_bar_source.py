from __future__ import annotations

from dataclasses import replace

import pytest

from app.replay.errors import ReplayDomainError, ReplayErrorCode
from app.replay.sources.bar_source import BarReplaySource
from tests.fixtures.replay.bar_builder_fakes import (
    INTERVAL_MS,
    REPLAY_START_MS,
    make_bar_snapshot,
)


def test_bar_source_keeps_warmup_outside_cursor_and_exposes_only_revealed_prefix() -> (
    None
):
    snapshot = make_bar_snapshot(warmup_count=3, replay_count=5)
    source = BarReplaySource(snapshot)

    assert source.warmup_rows() == snapshot.warmup_rows
    assert source.revealed_replay_rows() == ()
    assert source.revealed_rows() == snapshot.warmup_rows
    assert source.remaining_count() == 5
    assert source.cursor().source_sequence == 0
    assert source.cursor().last_event_time_ms is None

    first = source.next()
    assert first == snapshot.replay_rows[0]
    assert source.cursor().source_sequence == 1
    assert source.cursor().last_base_bar_open_ms == REPLAY_START_MS
    assert source.revealed_replay_rows() == (first,)
    assert source.revealed_rows() == snapshot.warmup_rows + (first,)
    assert snapshot.replay_rows[1] not in source.revealed_rows()
    assert source.remaining_count() == 4


def test_bar_source_next_and_advance_until_consume_exact_base_bar_units() -> None:
    snapshot = make_bar_snapshot(replay_count=4)
    source = BarReplaySource(snapshot)

    first = source.next()
    assert first is not None
    consumed = source.advance_until(REPLAY_START_MS + 3 * INTERVAL_MS - 1)
    assert consumed == snapshot.replay_rows[1:3]
    assert source.cursor().source_sequence == 3
    assert source.peek() == snapshot.replay_rows[3]
    assert source.exhausted() is False
    assert source.next() == snapshot.replay_rows[3]
    assert source.exhausted() is True
    assert source.cursor().at_end is True


@pytest.mark.parametrize("fault", ["duplicate", "gap", "forming", "boundary"])
def test_bar_source_revalidates_snapshot_order_close_and_replay_boundary(
    fault: str,
) -> None:
    snapshot = make_bar_snapshot(warmup_count=1, replay_count=3)
    rows = list(snapshot.rows)
    if fault == "duplicate":
        rows[2] = rows[1]
        broken = replace(snapshot, rows=tuple(rows))
    elif fault == "gap":
        rows[2] = replace(
            rows[2],
            open_time_ms=rows[2].open_time_ms + INTERVAL_MS,
            close_time_ms=rows[2].close_time_ms + INTERVAL_MS,
        )
        broken = replace(snapshot, rows=tuple(rows))
    elif fault == "forming":
        rows[2] = replace(rows[2], close_time_ms=rows[2].close_time_ms - 1)
        broken = replace(snapshot, rows=tuple(rows))
    else:
        broken = replace(snapshot, replay_start_index=0)

    with pytest.raises(ReplayDomainError) as error:
        BarReplaySource(broken)
    assert error.value.code in {
        ReplayErrorCode.DATA_GAP,
        ReplayErrorCode.DATASET_INCOMPLETE,
        ReplayErrorCode.DATASET_MISMATCH,
    }
