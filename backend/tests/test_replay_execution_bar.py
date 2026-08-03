from __future__ import annotations

from dataclasses import replace

import pytest

from app.replay.broker.models import (
    FillReason,
    LiquidityRole,
    OrderSide,
    OrderStatus,
    OrderType,
    WarningCode,
)
from app.replay.errors import ReplayDomainError, ReplayErrorCode
from tests.fixtures.replay.bar_builder_fakes import INTERVAL_MS, REPLAY_START_MS
from tests.fixtures.replay.broker_fakes import bar, make_broker, request


def test_market_fills_at_next_base_open_with_adverse_tick_slippage_and_fee() -> None:
    broker = make_broker()
    broker.place_order(
        request(client_order_id="market", quantity="1"),
        command_id="cmd-market",
    )
    result = broker.apply_bar(bar(0, 100))

    fill = result.fills[0]
    assert fill.reason is FillReason.MARKET_NEXT_OPEN
    assert fill.liquidity is LiquidityRole.TAKER
    assert fill.price == "100.1"
    assert fill.fee == "0.04004"
    assert broker.position.quantity == "1"
    assert broker.position.entry_price == "100.1"
    assert broker.account.cash_balance == "9999.95996"


def test_limit_touch_and_open_gap_use_distinct_fee_roles_but_never_improve_price() -> (
    None
):
    touched = make_broker()
    touched.place_order(
        request(
            client_order_id="touch",
            order_type=OrderType.LIMIT,
            limit_price="99",
        ),
        command_id="cmd-touch",
    )
    touch_fill = touched.apply_bar(bar(0, 100)).fills[0]
    assert touch_fill.price == "99"
    assert touch_fill.reason is FillReason.LIMIT_TOUCH
    assert touch_fill.liquidity is LiquidityRole.MAKER

    gapped = make_broker()
    gapped.place_order(
        request(
            client_order_id="gap",
            order_type=OrderType.LIMIT,
            limit_price="101",
        ),
        command_id="cmd-gap",
    )
    gap_fill = gapped.apply_bar(bar(0, 100)).fills[0]
    assert gap_fill.price == "101"
    assert gap_fill.reason is FillReason.LIMIT_GAP
    assert gap_fill.liquidity is LiquidityRole.TAKER


def test_stop_and_take_profit_same_bar_choose_adverse_exit_and_warn() -> None:
    broker = make_broker()
    broker.place_order(request(client_order_id="entry"), command_id="cmd-entry")
    broker.apply_bar(bar(0, 100))
    stop = broker.place_order(
        request(
            client_order_id="stop",
            side=OrderSide.SELL,
            order_type=OrderType.STOP_MARKET,
            quantity="1",
            reduce_only=True,
            stop_price="101",
        ),
        command_id="cmd-stop",
    )
    take_profit = broker.place_order(
        request(
            client_order_id="tp",
            side=OrderSide.SELL,
            order_type=OrderType.TAKE_PROFIT_MARKET,
            quantity="1",
            reduce_only=True,
            stop_price="104",
        ),
        command_id="cmd-tp",
    )

    result = broker.apply_bar(bar(1, 102))
    assert result.fills[0].order_id == stop.order_id
    assert result.fills[0].price == "100.9"
    assert result.fills[0].reason is FillReason.STOP_TRIGGER
    assert broker.position.quantity == "0"
    assert broker.order(take_profit.order_id).status is OrderStatus.CANCELED
    assert WarningCode.AMBIGUOUS_INTRABAR_WORST_CASE in {
        warning.code for warning in result.warnings
    }


def test_entry_then_adverse_exit_same_bar_is_explicitly_marked() -> None:
    broker = make_broker()
    broker.place_order(request(client_order_id="base"), command_id="cmd-base")
    broker.apply_bar(bar(0, 100))
    broker.place_order(
        request(
            client_order_id="add",
            order_type=OrderType.LIMIT,
            quantity="1",
            limit_price="103",
        ),
        command_id="cmd-add",
    )
    broker.place_order(
        request(
            client_order_id="exit",
            side=OrderSide.SELL,
            order_type=OrderType.STOP_MARKET,
            quantity="1",
            reduce_only=True,
            stop_price="101",
        ),
        command_id="cmd-exit",
    )

    result = broker.apply_bar(bar(1, 102))
    assert [fill.reason for fill in result.fills] == [
        FillReason.LIMIT_GAP,
        FillReason.STOP_TRIGGER,
    ]
    assert WarningCode.ENTRY_EXIT_SAME_BAR_WORST_CASE in {
        warning.code for warning in result.warnings
    }
    assert broker.position.quantity == "1"


def test_failed_source_event_rolls_back_broker_builder_and_ledger() -> None:
    broker = make_broker()
    broker.place_order(request(client_order_id="market"), command_id="cmd-market")
    malformed = replace(
        bar(0, 100),
        close_time_ms=REPLAY_START_MS + INTERVAL_MS - 2,
    )
    before = broker.state_hash
    with pytest.raises(ReplayDomainError) as failure:
        broker.apply_bar(malformed)
    assert failure.value.code is ReplayErrorCode.DATASET_INCOMPLETE
    assert broker.state_hash == before
    assert broker.fills == ()


@pytest.mark.parametrize(
    ("display_interval", "count"),
    (("1m", 1_440), ("15m", 90)),
)
def test_empty_account_final_state_bar_batch_matches_per_bar_state(
    display_interval: str,
    count: int,
) -> None:
    bars = tuple(bar(index, 100 + (index % 17)) for index in range(count))
    batched = make_broker(
        display_interval=display_interval,
        max_closed_bars=count,
    )
    reference = make_broker(
        display_interval=display_interval,
        max_closed_bars=count,
    )

    assert batched.apply_source_events_final_state(bars) == {}
    for source_bar in bars:
        reference.apply_bar(source_bar)

    assert batched.snapshot() == reference.snapshot()
