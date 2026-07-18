from __future__ import annotations

from dataclasses import replace

import pytest

from app.data_engine.storage.raw_trade_archive import RawAggTradeCursor
from app.replay.errors import ReplayDomainError, ReplayErrorCode
from app.replay.sources.trade_reader import PagedReplayTradeReader
from tests.fixtures.replay.trade_fakes import (
    START_MS,
    FakeRawAggTradeArchive,
    make_trade_dataset,
    make_trade_row,
)


@pytest.mark.parametrize("page_rows", [1, 2, 50_000])
def test_paged_reader_handles_same_millisecond_ids_and_final_page(
    page_rows: int,
) -> None:
    rows = [
        make_trade_row(0, trade_time_ms=START_MS),
        make_trade_row(1, trade_time_ms=START_MS),
        make_trade_row(2, trade_time_ms=START_MS),
        make_trade_row(3, trade_time_ms=START_MS + 1),
    ]
    reader = PagedReplayTradeReader(
        FakeRawAggTradeArchive(rows),  # type: ignore[arg-type]
        make_trade_dataset(len(rows)),
        page_rows=page_rows,
        validate_generation=False,
    )

    trades = list(reader.iter_trades())

    assert [item.agg_trade_id for item in trades] == [100, 101, 102, 103]
    assert [item.trade_time_ms for item in trades[:3]] == [START_MS] * 3
    assert trades[-1].cursor == RawAggTradeCursor(START_MS + 1, 103)


def test_paged_reader_rejects_gap_overlap_and_epoch_change() -> None:
    rows = [make_trade_row(index) for index in range(4)]
    gap_rows = [*rows[:2], {**rows[2], "agg_trade_id": 103}, rows[3]]
    reader = PagedReplayTradeReader(
        FakeRawAggTradeArchive(gap_rows),  # type: ignore[arg-type]
        make_trade_dataset(4),
        page_rows=4,
        validate_generation=False,
    )
    with pytest.raises(ReplayDomainError) as gap:
        reader.read_page()
    assert gap.value.code is ReplayErrorCode.DATA_GAP

    overlap_archive = FakeRawAggTradeArchive(rows)
    overlap_archive.inject_overlap = True
    overlap_reader = PagedReplayTradeReader(
        overlap_archive,  # type: ignore[arg-type]
        make_trade_dataset(4),
        page_rows=2,
        validate_generation=False,
    )
    first = overlap_reader.read_page()
    with pytest.raises(ReplayDomainError) as overlap:
        overlap_reader.read_page(first.next_cursor)
    assert overlap.value.code is ReplayErrorCode.DATA_GAP

    epoch_archive = FakeRawAggTradeArchive(rows)
    epoch_archive.epoch_override = "sha256:" + "f" * 64
    epoch_reader = PagedReplayTradeReader(
        epoch_archive,  # type: ignore[arg-type]
        make_trade_dataset(4),
        page_rows=2,
        validate_generation=False,
    )
    with pytest.raises(ReplayDomainError) as epoch:
        epoch_reader.read_page()
    assert epoch.value.code is ReplayErrorCode.DATASET_MISMATCH


def test_paged_reader_rejects_unknown_or_inconsistent_expected_bounds() -> None:
    rows = [make_trade_row(index) for index in range(2)]
    reference = make_trade_dataset(2)
    bad = replace(
        reference,
        expected_last_agg_trade_id=102,
        row_count=3,
    )
    reader = PagedReplayTradeReader(
        FakeRawAggTradeArchive(rows),  # type: ignore[arg-type]
        bad,
        page_rows=2,
        validate_generation=False,
    )
    with pytest.raises(ReplayDomainError) as raised:
        reader.read_page()
    assert raised.value.code is ReplayErrorCode.DATA_GAP
