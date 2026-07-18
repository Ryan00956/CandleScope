from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

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


def test_committed_synthetic_trade_fixture_is_small_contiguous_and_path_free() -> None:
    fixture = (
        Path(__file__).parent
        / "fixtures"
        / "replay"
        / "agg_trades_synthetic.jsonl"
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
