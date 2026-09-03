from __future__ import annotations

from dataclasses import replace
from decimal import Decimal

import pytest

from app.replay.bars.trade_builder import TradeReplayBarBuilder
from app.replay.broker.execution import ConservativeBarBroker
from app.replay.broker.models import (
    AGG_TRADE_TAPE_MODEL_VERSION,
    FillReason,
    LiquidityRole,
    OrderSide,
    OrderStatus,
    OrderType,
)
from app.replay.errors import ReplayDomainError, ReplayErrorCode
from app.replay.sources.trade_reader import ReplayTrade
from tests.fixtures.replay.bar_builder_fakes import INTERVAL_MS, REPLAY_START_MS
from tests.fixtures.replay.broker_fakes import CONFIG, request


def _broker(*, minutes: int = 5) -> ConservativeBarBroker:
    return ConservativeBarBroker(
        config=CONFIG,
        bar_builder=TradeReplayBarBuilder(
            base_interval="1m",
            display_interval="1m",
            replay_start_ms=REPLAY_START_MS,
            replay_end_time_ms=REPLAY_START_MS + minutes * INTERVAL_MS - 1,
        ),
    )


def _trade(
    index: int,
    *,
    price: str = "100",
    quantity: str = "1",
    time_offset_ms: int | None = None,
) -> ReplayTrade:
    offset = index * 1_000 if time_offset_ms is None else time_offset_ms
    return ReplayTrade(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        agg_trade_id=1_000 + index,
        first_trade_id=10_000 + index,
        last_trade_id=10_000 + index,
        price=price,
        quantity=quantity,
        quote_quantity=format(Decimal(price) * Decimal(quantity), "f"),
        trade_time_ms=REPLAY_START_MS + offset,
        is_buyer_maker=False,
    )


def test_market_order_partially_fills_from_subsequent_tape_quantity() -> None:
    broker = _broker()
    order = broker.place_order(
        request(client_order_id="market-partial", quantity="2"),
        command_id="cmd-market",
    )

    first = broker.apply_trade(_trade(0, quantity="0.5"))
    after_first = broker.order(order.order_id)
    assert len(first.fills) == 1
    assert first.fills[0].quantity == "0.5"
    assert first.fills[0].reason is FillReason.MARKET_TAPE
    assert first.fills[0].model_version == AGG_TRADE_TAPE_MODEL_VERSION
    assert after_first.status is OrderStatus.PARTIALLY_FILLED
    assert after_first.remaining_quantity == "1.5"
    assert after_first.reserved_margin != "0"

    broker.apply_trade(_trade(1, quantity="0.75"))
    final = broker.apply_trade(_trade(2, quantity="1"))
    completed = broker.order(order.order_id)
    assert final.fills[0].quantity == "0.75"
    assert completed.status is OrderStatus.FILLED
    assert completed.filled_quantity == "2"
    assert completed.reserved_margin == "0"
    assert broker.position.quantity == "2"
    assert sum((Decimal(fill.quantity) for fill in broker.fills), Decimal(0)) == 2
    assert broker.model_version == AGG_TRADE_TAPE_MODEL_VERSION


def test_non_aligned_tape_fills_whole_lots_and_restores_its_checkpoint() -> None:
    broker = _broker()
    order = broker.place_order(
        request(client_order_id="whole-lots"), command_id="cmd-lots"
    )
    assert not broker.apply_trade(_trade(0, quantity="0.0004")).fills
    assert broker.order(order.order_id).status is OrderStatus.OPEN
    result = broker.apply_trade(_trade(1, quantity="0.1234"))
    assert result.fills[0].quantity == "0.123"
    assert broker.order(order.order_id).remaining_quantity == "0.877"
    restored = _broker()
    restored.restore(broker.snapshot())
    assert restored.snapshot() == broker.snapshot()


def test_one_tape_quantity_is_shared_once_by_order_priority() -> None:
    broker = _broker()
    first = broker.place_order(
        request(client_order_id="first", quantity="1"),
        command_id="cmd-first",
    )
    second = broker.place_order(
        request(client_order_id="second", quantity="1"),
        command_id="cmd-second",
    )

    result = broker.apply_trade(_trade(0, quantity="1.5"))

    assert [fill.quantity for fill in result.fills] == ["1", "0.5"]
    assert broker.order(first.order_id).status is OrderStatus.FILLED
    assert broker.order(second.order_id).status is OrderStatus.PARTIALLY_FILLED
    assert sum((Decimal(fill.quantity) for fill in result.fills), Decimal(0)) == Decimal(
        "1.5"
    )


def test_limit_requires_strict_cross_and_never_fills_on_equal_trade() -> None:
    broker = _broker()
    order = broker.place_order(
        request(
            client_order_id="strict-limit",
            order_type=OrderType.LIMIT,
            quantity="1",
            limit_price="100",
        ),
        command_id="cmd-limit",
    )

    equal = broker.apply_trade(_trade(0, price="100", quantity="1"))
    assert equal.fills == ()
    assert broker.order(order.order_id).status is OrderStatus.OPEN

    crossed = broker.apply_trade(_trade(1, price="99.9", quantity="0.4"))
    assert crossed.fills[0].price == "100"
    assert crossed.fills[0].quantity == "0.4"
    assert crossed.fills[0].liquidity is LiquidityRole.MAKER
    assert crossed.fills[0].reason is FillReason.LIMIT_STRICT_CROSS
    assert broker.order(order.order_id).status is OrderStatus.PARTIALLY_FILLED


def test_triggered_stop_continues_as_tape_market_until_quantity_is_filled() -> None:
    broker = _broker()
    broker.place_order(
        request(client_order_id="entry", quantity="2"),
        command_id="cmd-entry",
    )
    broker.apply_trade(_trade(0, price="100", quantity="2"))
    stop = broker.place_order(
        request(
            client_order_id="stop",
            side=OrderSide.SELL,
            order_type=OrderType.STOP_MARKET,
            quantity="2",
            reduce_only=True,
            stop_price="99",
        ),
        command_id="cmd-stop",
    )
    take_profit = broker.place_order(
        request(
            client_order_id="take-profit",
            side=OrderSide.SELL,
            order_type=OrderType.TAKE_PROFIT_MARKET,
            quantity="2",
            reduce_only=True,
            stop_price="101",
        ),
        command_id="cmd-profit",
    )

    first = broker.apply_trade(_trade(1, price="98", quantity="0.5"))
    assert first.fills[0].reason is FillReason.STOP_TAPE_TRIGGER
    assert broker.order(stop.order_id).status is OrderStatus.PARTIALLY_FILLED
    assert broker.order(stop.order_id).status_reason == "TAPE_TRIGGERED"

    second = broker.apply_trade(_trade(2, price="102", quantity="1.5"))
    assert second.fills[0].reason is FillReason.STOP_TAPE_TRIGGER
    assert broker.order(stop.order_id).status is OrderStatus.FILLED
    assert broker.order(take_profit.order_id).status is OrderStatus.CANCELED
    assert broker.position.quantity == "0"


def test_stop_trigger_persists_when_higher_priority_order_consumes_tape_quantity() -> None:
    broker = _broker()
    broker.place_order(
        request(client_order_id="entry-for-trigger", quantity="2"),
        command_id="cmd-entry-for-trigger",
    )
    broker.apply_trade(_trade(0, price="100", quantity="2"))
    stop = broker.place_order(
        request(
            client_order_id="deferred-stop",
            side=OrderSide.SELL,
            order_type=OrderType.STOP_MARKET,
            quantity="2",
            reduce_only=True,
            stop_price="99",
        ),
        command_id="cmd-deferred-stop",
    )
    broker.place_order(
        request(client_order_id="priority-market", quantity="1"),
        command_id="cmd-priority-market",
    )

    consumed = broker.apply_trade(_trade(1, price="98", quantity="1"))
    assert [fill.reason for fill in consumed.fills] == [FillReason.MARKET_TAPE]
    assert broker.order(stop.order_id).status is OrderStatus.OPEN
    assert broker.order(stop.order_id).status_reason == "TAPE_TRIGGERED"

    continued = broker.apply_trade(_trade(2, price="100", quantity="1"))
    assert continued.fills[0].order_id == stop.order_id
    assert continued.fills[0].reason is FillReason.STOP_TAPE_TRIGGER
    assert broker.order(stop.order_id).status is OrderStatus.PARTIALLY_FILLED


def test_trade_builder_failure_rolls_back_tape_fills_and_ledger() -> None:
    broker = _broker()
    broker.place_order(
        request(client_order_id="rollback", quantity="1"),
        command_id="cmd-rollback",
    )
    broker.apply_trade(_trade(0, quantity="0.5"))
    before = broker.state_hash
    gap = replace(_trade(1, quantity="0.5"), agg_trade_id=1_002)

    with pytest.raises(ReplayDomainError) as raised:
        broker.apply_trade(gap)

    assert raised.value.code is ReplayErrorCode.DATA_GAP
    assert broker.state_hash == before
    assert len(broker.fills) == 1


def test_empty_account_final_state_batch_matches_per_trade_broker_state() -> None:
    trades = tuple(
        _trade(
            index,
            price=str(100 + (index % 4)),
            quantity=str(1 + (index % 3)),
        )
        for index in range(20)
    )
    projected = _broker()
    final_state = _broker()

    for trade in trades:
        projected.apply_trade(trade)
    assert final_state.apply_source_events_final_state(trades) == {}

    assert final_state.snapshot() == projected.snapshot()


def test_position_final_state_batch_matches_mark_to_market_path() -> None:
    seed = _broker()
    seed.place_order(
        request(client_order_id="batch-position", quantity="1"),
        command_id="batch-position-order",
    )
    seed.apply_trade(_trade(0, price="100", quantity="1"))
    checkpoint = seed.snapshot()
    projected = _broker()
    projected.restore(checkpoint)
    final_state = _broker()
    final_state.restore(checkpoint)
    trades = tuple(
        _trade(
            index,
            price=str(96 + (index % 9)),
            quantity="1",
        )
        for index in range(1, 20)
    )

    for trade in trades:
        projected.apply_trade(trade)
    assert final_state.supports_final_state_batch()
    assert final_state.apply_source_events_final_state(trades) == {}

    assert final_state.snapshot() == projected.snapshot()


def test_resting_order_final_state_batch_matches_per_trade_path() -> None:
    seed = _broker()
    seed.place_order(
        request(
            client_order_id="batch-resting-limit",
            order_type=OrderType.LIMIT,
            quantity="1",
            limit_price="90",
        ),
        command_id="batch-resting-limit-order",
    )
    checkpoint = seed.snapshot()
    projected = _broker()
    projected.restore(checkpoint)
    final_state = _broker()
    final_state.restore(checkpoint)
    trades = tuple(
        _trade(index, price=str(100 + (index % 4)), quantity="1")
        for index in range(20)
    )

    for trade in trades:
        projected.apply_trade(trade)
    assert not final_state.supports_final_state_batch()
    assert final_state.can_apply_source_events_final_state(trades)
    assert final_state.apply_source_events_final_state(trades) == {}

    assert final_state.snapshot() == projected.snapshot()


def test_triggering_order_rejects_final_state_batch_without_mutation() -> None:
    broker = _broker()
    broker.place_order(
        request(
            client_order_id="batch-triggering-limit",
            order_type=OrderType.LIMIT,
            quantity="1",
            limit_price="100",
        ),
        command_id="batch-triggering-limit-order",
    )
    trades = (_trade(0, price="99.9", quantity="1"),)
    before = broker.snapshot()

    assert not broker.can_apply_source_events_final_state(trades)
    with pytest.raises(ReplayDomainError) as raised:
        broker.apply_source_events_final_state(trades)

    assert raised.value.code is ReplayErrorCode.INVALID_STATE_TRANSITION
    assert broker.snapshot() == before


def test_tape_report_and_checkpoint_preserve_model_version() -> None:
    broker = _broker(minutes=1)
    broker.place_order(
        request(client_order_id="report", quantity="1"),
        command_id="cmd-report",
    )
    broker.apply_trade(_trade(0, quantity="1"))
    snapshot = broker.snapshot()

    restored = _broker(minutes=1)
    restored.restore(snapshot)
    assert restored.state_hash == broker.state_hash
    restored.end_session(virtual_time_ms=REPLAY_START_MS + INTERVAL_MS - 1)
    report = restored.build_report()
    assert report.model_version == AGG_TRADE_TAPE_MODEL_VERSION
    assert report.verify()
