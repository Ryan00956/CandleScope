from __future__ import annotations

from dataclasses import replace

import pytest

from app.replay.broker.models import OrderSide, OrderStatus, OrderType
from app.replay.errors import ReplayDomainError, ReplayErrorCode
from tests.fixtures.replay.broker_fakes import bar, make_broker, request


def test_order_inputs_are_canonical_and_instrument_aligned() -> None:
    broker = make_broker()
    before = broker.state_hash
    with pytest.raises(ReplayDomainError) as step_error:
        broker.place_order(
            request(client_order_id="bad-step", quantity="0.0005"),
            command_id="cmd-bad-step",
        )
    assert step_error.value.code is ReplayErrorCode.ORDER_REJECTED
    assert broker.state_hash == before

    with pytest.raises(ReplayDomainError) as tick_error:
        broker.place_order(
            request(
                client_order_id="bad-tick",
                order_type=OrderType.LIMIT,
                quantity="1",
                limit_price="100.05",
            ),
            command_id="cmd-bad-tick",
        )
    assert tick_error.value.code is ReplayErrorCode.ORDER_REJECTED
    assert broker.state_hash == before


def test_order_state_machine_place_cancel_and_no_partial_failure_state() -> None:
    broker = make_broker()
    order = broker.place_order(
        request(
            client_order_id="limit-1",
            order_type=OrderType.LIMIT,
            quantity="1",
            limit_price="95",
        ),
        command_id="cmd-place",
    )
    assert order.status is OrderStatus.OPEN
    assert order.accepted_source_sequence == 0
    assert order.status_history == (OrderStatus.NEW, OrderStatus.OPEN)
    assert broker.account.reserved_margin == "19"

    canceled = broker.cancel_order(order.order_id, command_id="cmd-cancel")
    assert canceled.status is OrderStatus.CANCELED
    assert broker.open_orders == ()
    assert broker.account.reserved_margin == "0"

    before = broker.state_hash
    with pytest.raises(ReplayDomainError) as duplicate:
        broker.cancel_order(order.order_id, command_id="cmd-cancel-again")
    assert duplicate.value.code is ReplayErrorCode.ORDER_REJECTED
    assert broker.state_hash == before


def test_order_state_history_rejects_terminal_reentry_and_inconsistent_fill_state() -> (
    None
):
    broker = make_broker()
    order = broker.place_order(
        request(
            client_order_id="state-machine",
            order_type=OrderType.LIMIT,
            limit_price="95",
        ),
        command_id="cmd-state-machine",
    )

    with pytest.raises(ValueError, match="invalid order transition"):
        replace(
            order,
            status=OrderStatus.FILLED,
            filled_quantity="1",
            remaining_quantity="0",
            average_fill_price="95",
            reserved_margin="0",
            status_history=(
                OrderStatus.NEW,
                OrderStatus.OPEN,
                OrderStatus.CANCELED,
                OrderStatus.FILLED,
            ),
        )

    with pytest.raises(ValueError, match="PARTIALLY_FILLED"):
        replace(
            order,
            status=OrderStatus.PARTIALLY_FILLED,
            status_history=(
                OrderStatus.NEW,
                OrderStatus.OPEN,
                OrderStatus.PARTIALLY_FILLED,
            ),
        )


def test_new_order_cannot_fill_from_an_already_revealed_bar() -> None:
    broker = make_broker()
    broker.apply_bar(bar(0, 100))
    order = broker.place_order(
        request(client_order_id="market-after-one"),
        command_id="cmd-market",
    )
    assert order.accepted_source_sequence == 1
    assert broker.fills == ()

    result = broker.apply_bar(bar(1, 105))
    assert len(result.fills) == 1
    assert result.fills[0].source_sequence == 2
    assert result.fills[0].price == "105.1"


def test_reduce_only_rejects_wrong_side_and_individual_overage() -> None:
    broker = make_broker()
    broker.place_order(
        request(client_order_id="entry", quantity="2"),
        command_id="cmd-entry",
    )
    broker.apply_bar(bar(0, 100))
    assert broker.position.quantity == "2"

    for client_id, side, quantity in (
        ("wrong-side", OrderSide.BUY, "1"),
        ("too-large", OrderSide.SELL, "2.001"),
    ):
        before = broker.state_hash
        with pytest.raises(ReplayDomainError) as rejected:
            broker.place_order(
                request(
                    client_order_id=client_id,
                    side=side,
                    quantity=quantity,
                    reduce_only=True,
                ),
                command_id=f"cmd-{client_id}",
            )
        assert rejected.value.code is ReplayErrorCode.ORDER_REJECTED
        assert broker.state_hash == before
