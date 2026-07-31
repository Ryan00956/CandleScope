from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timezone
from decimal import Decimal

import pytest

from app.data_engine.interval_policy import aggregate_kline_rows
from app.replay.bars.trade_builder import (
    TRADE_BAR_BUILDER_STATE_HASH_SCHEMA_VERSION,
    TradeReplayBarBuilder,
)
from app.replay.bars.trade_parity import (
    assert_trade_bar_parity,
    audit_trade_bar_parity,
)
from app.replay.errors import ReplayDomainError, ReplayErrorCode
from app.replay.canonical import canonical_sha256
from app.replay.sources.trade_reader import ReplayTrade


MINUTE_MS = 60_000
START_MS = int(
    datetime(2026, 6, 1, tzinfo=timezone.utc).timestamp() * 1_000
)


def _trade(
    index: int,
    *,
    minute: int,
    price: str | None = None,
    quantity: str = "1",
    raw_count: int = 1,
    buyer_maker: bool = False,
    offset_ms: int = 1_000,
) -> ReplayTrade:
    value = price or str(100 + minute)
    return ReplayTrade(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        agg_trade_id=1_000 + index,
        first_trade_id=10_000 + index * 10,
        last_trade_id=10_000 + index * 10 + raw_count - 1,
        price=value,
        quantity=quantity,
        quote_quantity=format(Decimal(value) * Decimal(quantity), "f"),
        trade_time_ms=START_MS + minute * MINUTE_MS + offset_ms,
        is_buyer_maker=buyer_maker,
    )


def _base_reference(trades: list[ReplayTrade]) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for trade in trades:
        open_ms = START_MS + (trade.trade_time_ms - START_MS) // MINUTE_MS * MINUTE_MS
        rows.append(
            {
                "open_time_ms": open_ms,
                "close_time_ms": open_ms + MINUTE_MS - 1,
                "open": trade.price,
                "high": trade.price,
                "low": trade.price,
                "close": trade.price,
                "volume": trade.quantity,
                "quote_volume": trade.quote_quantity,
                "trades": trade.raw_trade_count,
                "taker_buy_base": "0" if trade.is_buyer_maker else trade.quantity,
                "taker_buy_quote": (
                    "0" if trade.is_buyer_maker else trade.quote_quantity
                ),
                "is_closed": True,
                "source": "fixture",
            }
        )
    return rows


@pytest.mark.parametrize("display_interval", ["1m", "5m", "15m"])
def test_every_trade_builds_exchange_parity_bars(display_interval: str) -> None:
    trades = [_trade(index, minute=index) for index in range(15)]
    builder = TradeReplayBarBuilder(
        base_interval="1m",
        display_interval=display_interval,
        replay_start_ms=START_MS,
        replay_end_time_ms=START_MS + 15 * MINUTE_MS - 1,
    )
    for trade in trades:
        builder.apply_trade(trade)
    builder.finalize_bars(virtual_time_ms=START_MS + 15 * MINUTE_MS - 1)

    reference = _base_reference(trades)
    if display_interval != "1m":
        reference = aggregate_kline_rows(
            [
                {
                    **row,
                    "open_time": row["open_time_ms"],
                    "close_time": row["close_time_ms"],
                }
                for row in reference
            ],
            target_interval=display_interval,
            source_interval="1m",
            now_ms=START_MS + 16 * MINUTE_MS,
        )
    report = assert_trade_bar_parity(builder.closed_bars, reference)
    assert report.checked_bars == len(reference)


def test_empty_minutes_use_previous_close_without_execution_volume() -> None:
    first = _trade(0, minute=0, price="100")
    second = _trade(1, minute=3, price="103", raw_count=4)
    builder = TradeReplayBarBuilder(
        base_interval="1m",
        display_interval="1m",
        replay_start_ms=START_MS,
        replay_end_time_ms=START_MS + 5 * MINUTE_MS - 1,
    )
    builder.apply_trade(first)
    update = builder.apply_trade(second)
    assert update["action"] == "batch"
    builder.finalize_bars(virtual_time_ms=START_MS + 5 * MINUTE_MS - 1)

    bars = builder.closed_bars
    assert len(bars) == 5
    assert [bar.synthetic for bar in bars] == [False, True, True, False, True]
    assert [(bar.open, bar.volume, bar.trades) for bar in bars[1:3]] == [
        ("100", "0", 0),
        ("100", "0", 0),
    ]
    assert (bars[3].close, bars[3].trades) == ("103", 4)
    assert (bars[4].open, bars[4].volume) == ("103", "0")


def test_utc_boundary_and_final_forming_display_bar_are_deterministic() -> None:
    builder = TradeReplayBarBuilder(
        base_interval="1m",
        display_interval="5m",
        replay_start_ms=START_MS,
        replay_end_time_ms=START_MS + 3 * MINUTE_MS - 1,
    )
    for index in range(3):
        builder.apply_trade(_trade(index, minute=index))
    snapshot = builder.snapshot()
    builder.finalize_bars(virtual_time_ms=START_MS + 3 * MINUTE_MS - 1)

    projection = builder.replace_projection()
    assert builder.closed_bars == ()
    assert projection["bars"][-1]["component_count"] == 3
    assert projection["bars"][-1]["is_closed"] is False
    assert projection["bars"][-1]["open_time_ms"] == START_MS

    restored = TradeReplayBarBuilder(
        base_interval="1m",
        display_interval="5m",
        replay_start_ms=START_MS,
        replay_end_time_ms=START_MS + 3 * MINUTE_MS - 1,
    )
    restored.restore(snapshot)
    restored.finalize_bars(virtual_time_ms=START_MS + 3 * MINUTE_MS - 1)
    assert restored.state_hash == builder.state_hash
    assert restored.replace_projection() == projection


def test_final_state_trade_updates_match_full_tick_projection_state() -> None:
    trades = [
        _trade(
            index,
            minute=index // 4,
            price=str(100 + (index % 5)),
            quantity=str(1 + (index % 3)),
            offset_ms=1_000 + index,
        )
        for index in range(12)
    ]

    def build() -> TradeReplayBarBuilder:
        return TradeReplayBarBuilder(
            base_interval="1m",
            display_interval="5m",
            replay_start_ms=START_MS,
            replay_end_time_ms=START_MS + 5 * MINUTE_MS - 1,
        )

    projected = build()
    final_state = build()
    batched = build()
    for trade in trades:
        projected.apply_trade(trade)
        final_state.apply_trade_final_state(trade)
    batched.apply_trades_final_state(trades)

    assert final_state.snapshot() == projected.snapshot()
    assert batched.snapshot() == projected.snapshot()
    projected.finalize_bars(virtual_time_ms=START_MS + 5 * MINUTE_MS - 1)
    final_state.finalize_bars(virtual_time_ms=START_MS + 5 * MINUTE_MS - 1)
    batched.finalize_bars(virtual_time_ms=START_MS + 5 * MINUTE_MS - 1)
    assert final_state.snapshot() == projected.snapshot()
    assert batched.snapshot() == projected.snapshot()


def test_parity_tolerance_is_frozen_and_release_fails_closed() -> None:
    builder = TradeReplayBarBuilder(
        base_interval="1m",
        display_interval="1m",
        replay_start_ms=START_MS,
        replay_end_time_ms=START_MS + MINUTE_MS - 1,
    )
    trade = _trade(0, minute=0, price="100")
    builder.apply_trade(trade)
    builder.finalize_bars(virtual_time_ms=START_MS + MINUTE_MS - 1)
    reference = _base_reference([trade])

    within = [{**reference[0], "close": "100.00000001"}]
    assert audit_trade_bar_parity(builder.closed_bars, within).exact_enough

    outside = [{**reference[0], "close": "100.00000002"}]
    report = audit_trade_bar_parity(builder.closed_bars, outside)
    assert not report.exact_enough
    with pytest.raises(ReplayDomainError) as raised:
        assert_trade_bar_parity(builder.closed_bars, outside)
    assert raised.value.code is ReplayErrorCode.DATASET_MISMATCH

    wrong_count = [{**reference[0], "trades": 2}]
    assert not audit_trade_bar_parity(builder.closed_bars, wrong_count).exact_enough


def test_trade_bar_builder_rejects_duplicate_id_and_checkpoint_tamper() -> None:
    builder = TradeReplayBarBuilder(
        base_interval="1m",
        display_interval="1m",
        replay_start_ms=START_MS,
        replay_end_time_ms=START_MS + MINUTE_MS - 1,
    )
    trade = _trade(0, minute=0)
    builder.apply_trade(trade)
    with pytest.raises(ReplayDomainError) as duplicate:
        builder.apply_trade(replace(trade, trade_time_ms=trade.trade_time_ms + 1))
    assert duplicate.value.code is ReplayErrorCode.DATA_GAP

    tampered = builder.snapshot()
    tampered["replay_events_applied"] = 99
    with pytest.raises(ReplayDomainError) as checkpoint:
        builder.restore(tampered)
    assert checkpoint.value.code is ReplayErrorCode.DATASET_MISMATCH

    coherent_hash_tamper = builder.snapshot()
    projection = dict(coherent_hash_tamper["public_projection"])
    projection["bars"] = []
    coherent_hash_tamper["public_projection"] = projection
    state = dict(coherent_hash_tamper)
    state.pop("state_hash")
    coherent_hash_tamper["state_hash"] = canonical_sha256(
        {
            "schema_version": TRADE_BAR_BUILDER_STATE_HASH_SCHEMA_VERSION,
            "state": state,
        }
    )
    before = builder.state_hash
    with pytest.raises(ReplayDomainError, match="public projection"):
        builder.restore(coherent_hash_tamper)
    assert builder.state_hash == before
