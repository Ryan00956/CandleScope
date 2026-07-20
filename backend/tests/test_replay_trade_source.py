from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import pytest

from app.replay.errors import ReplayDomainError
from app.replay.sources.trade_reader import PagedReplayTradeReader, ReplayTrade
from app.replay.sources.trade_source import TradeReplaySource
from tests.fixtures.replay.trade_fakes import (
    START_MS,
    FakeRawAggTradeArchive,
    make_trade_dataset,
    make_trade_row,
)


def test_trade_source_pages_lazily_and_exposes_public_trade_cursor() -> None:
    rows = [
        make_trade_row(0, trade_time_ms=START_MS),
        make_trade_row(1, trade_time_ms=START_MS),
        make_trade_row(2, trade_time_ms=START_MS + 5),
        make_trade_row(3, trade_time_ms=START_MS + 10),
    ]
    dataset = replace(make_trade_dataset(4), end_time_ms=START_MS + 10)
    reader = PagedReplayTradeReader(
        FakeRawAggTradeArchive(rows),  # type: ignore[arg-type]
        dataset,
        page_rows=2,
        validate_generation=False,
    )
    synthetic_origin = 946_684_800_000
    source = TradeReplaySource(
        reader,
        time_offset_ms=synthetic_origin - START_MS,
    )

    assert source.cursor().source_sequence == 0
    assert source.buffered_count == 0
    assert source.peek() is not None
    assert source.peek().trade_time_ms == synthetic_origin  # type: ignore[union-attr]
    assert source.buffered_count == 2
    first = source.next()
    assert first is not None and first.agg_trade_id == 100
    cursor = source.cursor()
    assert cursor.source_sequence == 1
    assert cursor.last_trade_time_ms == synthetic_origin
    assert cursor.last_agg_trade_id == 100
    assert not cursor.at_end

    consumed = source.advance_until(synthetic_origin + 5)
    assert [item.agg_trade_id for item in consumed] == [101, 102]
    assert source.actual_cursor is not None
    assert source.actual_cursor.agg_trade_id == 102
    assert source.next().agg_trade_id == 103  # type: ignore[union-attr]
    assert source.exhausted()
    assert source.cursor().at_end
    assert source.terminal_time_ms == synthetic_origin + 10


def test_trade_source_clone_has_identical_event_order_and_snapshot_ref() -> None:
    rows = [make_trade_row(index) for index in range(4)]
    dataset = make_trade_dataset(4)

    def build() -> TradeReplaySource:
        return TradeReplaySource(
            PagedReplayTradeReader(
                FakeRawAggTradeArchive(rows),  # type: ignore[arg-type]
                dataset,
                page_rows=1,
                validate_generation=False,
            )
        )

    left = build()
    right = build()
    assert left.snapshot_ref() == right.snapshot_ref()
    assert [left.next() for _ in rows] == [right.next() for _ in rows]
    assert left.cursor() == right.cursor()


def test_trade_source_positions_checkpoint_cursor_without_rescanning_prefix() -> None:
    rows = [make_trade_row(index) for index in range(4)]
    reader = PagedReplayTradeReader(
        FakeRawAggTradeArchive(rows),  # type: ignore[arg-type]
        make_trade_dataset(4),
        page_rows=1,
        validate_generation=False,
    )
    source = TradeReplaySource(reader, blind_mode=True)
    first = source.next()
    second = source.next()
    assert first is not None and second is not None

    positioned = source.fork_at_sequence(
        1,
        last_event_time_ms=first.trade_time_ms,
    )
    assert positioned.cursor().source_sequence == 1
    assert positioned.cursor().last_agg_trade_id == 1
    replayed_second = positioned.next()
    assert replayed_second is not None
    assert replayed_second.agg_trade_id == 2
    assert replayed_second.first_trade_id == 3
    assert replayed_second.last_trade_id == 4
    assert source.cursor().source_sequence == 2


def test_blind_trade_source_maps_all_public_ids_but_keeps_actual_archive_cursor() -> (
    None
):
    rows = [make_trade_row(index) for index in range(3)]
    dataset = make_trade_dataset(3)
    source = TradeReplaySource(
        PagedReplayTradeReader(
            FakeRawAggTradeArchive(rows),  # type: ignore[arg-type]
            dataset,
            page_rows=1,
            validate_generation=False,
        ),
        blind_mode=True,
    )

    public = [source.next() for _ in rows]
    assert [trade.agg_trade_id for trade in public if trade is not None] == [1, 2, 3]
    assert [trade.first_trade_id for trade in public if trade is not None] == [1, 3, 5]
    assert [trade.last_trade_id for trade in public if trade is not None] == [2, 4, 6]
    assert source.cursor().last_agg_trade_id == 3
    assert source.actual_cursor is not None
    assert source.actual_cursor.agg_trade_id == 102
    assert source.snapshot_ref()["expected_first_agg_trade_id"] == 1
    assert source.snapshot_ref()["expected_last_agg_trade_id"] == 3
    serialized = json.dumps([trade.to_dict() for trade in public if trade is not None])
    assert '"agg_trade_id": 100' not in serialized
    assert '"first_trade_id": 1000' not in serialized
    assert '"last_trade_id": 1001' not in serialized


def test_blind_trade_source_redacts_archive_cursor_error_details() -> None:
    rows = [make_trade_row(index) for index in range(2)]
    archive = FakeRawAggTradeArchive(rows)
    source = TradeReplaySource(
        PagedReplayTradeReader(
            archive,  # type: ignore[arg-type]
            make_trade_dataset(2),
            page_rows=1,
            validate_generation=False,
        ),
        blind_mode=True,
    )
    assert source.next() is not None
    archive.rows[1]["agg_trade_id"] = 999

    with pytest.raises(ReplayDomainError) as failure:
        source.peek()
    assert failure.value.message == "blind aggregate-trade source validation failed"
    assert failure.value.details == {"blind_redacted": True}


def test_committed_synthetic_trade_fixture_is_small_contiguous_and_path_free() -> None:
    fixture = (
        Path(__file__).parent / "fixtures" / "replay" / "agg_trades_synthetic.jsonl"
    )
    raw = fixture.read_text(encoding="utf-8")
    trades = [ReplayTrade(**json.loads(line)) for line in raw.splitlines()]

    assert len(trades) == 8
    assert [trade.agg_trade_id for trade in trades] == list(range(5_000, 5_008))
    assert [trade.trade_time_ms for trade in trades] == sorted(
        trade.trade_time_ms for trade in trades
    )
    assert all(trade.source == "synthetic_fixture" for trade in trades)
    assert ".parquet" not in raw
    assert "date=" not in raw
