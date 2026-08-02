from __future__ import annotations

from dataclasses import replace

import pytest

from app.replay.errors import ReplayDomainError, ReplayErrorCode
from app.replay.market_halts import ReplayBarHalt
from app.replay.sources.bar_source import BarReplaySource, PagedBarReplaySource
from tests.fixtures.replay.bar_builder_fakes import (
    INTERVAL_MS,
    REPLAY_START_MS,
    make_bar_snapshot,
    make_replay_bar,
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


def test_bar_source_positions_checkpoint_cursor_without_scanning_prefix() -> None:
    snapshot = make_bar_snapshot(replay_count=4)
    source = BarReplaySource(snapshot)
    positioned = source.fork_at_sequence(
        2,
        last_event_time_ms=snapshot.replay_rows[1].close_time_ms,
    )

    assert positioned.cursor().source_sequence == 2
    assert positioned.peek() == snapshot.replay_rows[2]
    assert source.cursor().source_sequence == 0


def test_paged_bar_source_treats_initial_snapshot_as_cache_not_terminal() -> None:
    initial = make_bar_snapshot(warmup_count=1, replay_count=2)
    complete = make_bar_snapshot(warmup_count=1, replay_count=6)
    loaded: list[tuple[int, int, int]] = []

    def load_page(start_ms: int, end_ms: int, count: int):
        loaded.append((start_ms, end_ms, count))
        offset = (start_ms - REPLAY_START_MS) // INTERVAL_MS
        return complete.replay_rows[offset : offset + count]

    source = PagedBarReplaySource(
        initial,
        terminal_open_ms=REPLAY_START_MS + 5 * INTERVAL_MS,
        source_revision="sha256:" + "1" * 64,
        source_fingerprint="sha256:" + "2" * 64,
        page_rows=2,
        page_loader=load_page,
    )

    assert source.next() == initial.replay_rows[0]
    assert source.next() == initial.replay_rows[1]
    assert source.exhausted() is False
    assert source.cursor().at_end is False
    assert source.next() == complete.replay_rows[2]
    assert loaded == [
        (
            REPLAY_START_MS + 2 * INTERVAL_MS,
            REPLAY_START_MS + 3 * INTERVAL_MS,
            2,
        )
    ]
    assert source.advance_until(REPLAY_START_MS + 6 * INTERVAL_MS - 1) == (
        complete.replay_rows[3],
        complete.replay_rows[4],
        complete.replay_rows[5],
    )
    assert source.exhausted() is True
    assert source.cursor().source_sequence == 6


def test_paged_bar_source_restores_late_cursor_without_scanning_prefix() -> None:
    initial = make_bar_snapshot(replay_count=2)
    complete = make_bar_snapshot(replay_count=6)
    loaded: list[int] = []

    def load_page(start_ms: int, _end_ms: int, count: int):
        loaded.append(start_ms)
        offset = (start_ms - REPLAY_START_MS) // INTERVAL_MS
        return complete.replay_rows[offset : offset + count]

    source = PagedBarReplaySource(
        initial,
        terminal_open_ms=REPLAY_START_MS + 5 * INTERVAL_MS,
        source_revision="sha256:" + "3" * 64,
        source_fingerprint="sha256:" + "4" * 64,
        page_rows=2,
        page_loader=load_page,
    )
    positioned = source.fork_at_sequence(
        4,
        last_event_time_ms=REPLAY_START_MS + 4 * INTERVAL_MS - 1,
    )

    assert loaded == []
    assert positioned.peek() == complete.replay_rows[4]
    assert loaded == [REPLAY_START_MS + 4 * INTERVAL_MS]
    assert source.cursor().source_sequence == 0


def test_paged_bar_source_pages_across_only_an_explicit_verified_halt() -> None:
    initial = make_bar_snapshot(replay_count=2)
    halt = ReplayBarHalt(
        start_open_ms=REPLAY_START_MS + 2 * INTERVAL_MS,
        end_open_ms=REPLAY_START_MS + 4 * INTERVAL_MS,
        halt_id="fixture-reviewed-halt",
        resume_ms=REPLAY_START_MS + 5 * INTERVAL_MS,
        reason="exchange_scheduled_system_upgrade",
        evidence_url="https://example.com/reviewed-halt",
    )
    loaded: list[tuple[int, int, int]] = []

    def load_page(start_ms: int, end_ms: int, count: int):
        loaded.append((start_ms, end_ms, count))
        return tuple(
            make_replay_bar(start_ms + index * INTERVAL_MS, 200 + index)
            for index in range(count)
        )

    source = PagedBarReplaySource(
        initial,
        terminal_open_ms=REPLAY_START_MS + 7 * INTERVAL_MS,
        source_revision="sha256:" + "5" * 64,
        source_fingerprint="sha256:" + "6" * 64,
        page_rows=4,
        page_loader=load_page,
        verified_halts=(halt,),
    )

    assert source.remaining_count() == 5
    assert source.next() == initial.replay_rows[0]
    assert source.next() == initial.replay_rows[1]
    resumed = source.next()
    assert resumed is not None
    assert resumed.open_time_ms == REPLAY_START_MS + 5 * INTERVAL_MS
    assert loaded == [
        (
            REPLAY_START_MS + 5 * INTERVAL_MS,
            REPLAY_START_MS + 7 * INTERVAL_MS,
            3,
        )
    ]
    assert source.cursor().source_sequence == 3
    assert source.cursor().last_base_bar_open_ms == resumed.open_time_ms
    assert source.snapshot_ref()["schema_version"] == "replay-paged-bar-source.v2"
    assert (
        source.fork_at_sequence(
            3,
            last_event_time_ms=resumed.close_time_ms,
        ).peek()
        == source.peek()
    )


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
