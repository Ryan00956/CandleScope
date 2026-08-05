from __future__ import annotations

import pytest

from app.replay.broker.models import (
    OrderCapacityRequest,
    OrderSide,
    OrderStatus,
    OrderType,
    TOUCH_OR_TAPE_EXECUTION_MODE,
)
from app.replay.errors import ReplayDomainError, ReplayErrorCode
from tests.fixtures.replay.broker_fakes import bar, make_broker, request


def _long_broker(*, touch: bool = False):
    broker = make_broker(
        execution_mode=(
            TOUCH_OR_TAPE_EXECUTION_MODE if touch else "paper_linear_v1"
        )
    )
    broker.place_order(request(client_order_id="entry"), command_id="entry")
    broker.apply_bar(bar(0, 100))
    assert broker.position.quantity == "1"
    return broker


def test_order_preview_reuses_risk_math_without_mutating_broker() -> None:
    broker = make_broker()
    before = broker.state_hash

    preview = broker.preview_order(
        request(client_order_id="preview", quantity="1")
    )

    assert broker.state_hash == before
    assert preview == {
        "schema_version": "replay.order-preview.v1",
        "order": {
            "client_order_id": "preview",
            "side": "BUY",
            "order_type": "MARKET",
            "quantity": "1",
            "reduce_only": False,
            "limit_price": None,
            "stop_price": None,
        },
        "reference_price": "100",
        "estimated_fill_price": "100.1",
        "estimated_notional": "100.1",
        "reserved_margin": "20",
        "estimated_fee": "0.04004",
        "fee_basis": "TAKER_WORST_CASE",
        "available_equity_after": "9980",
        "max_quantity": "10",
        "quote_asset": "USDT",
        "max_leverage": "5",
    }


def test_order_capacity_survives_an_oversized_draft_rejection() -> None:
    broker = make_broker()
    before = broker.state_hash
    context = OrderCapacityRequest(
        side=OrderSide.BUY,
        order_type=OrderType.MARKET,
        reduce_only=False,
    )

    first = broker.order_capacity(context)
    with pytest.raises(ReplayDomainError) as rejected:
        broker.preview_order(request(client_order_id="oversized", quantity="999999999"))
    second = broker.order_capacity(context)

    assert rejected.value.code is ReplayErrorCode.ORDER_REJECTED
    assert first == second
    assert first["schema_version"] == "replay.order-capacity.v1"
    assert first["max_quantity"] == "10"
    assert broker.state_hash == before


def test_position_protection_replace_clear_and_failure_are_atomic() -> None:
    broker = _long_broker()
    created = broker.set_position_protection(
        quantity=None,
        stop_loss_price="100",
        take_profit_price="102",
        command_id="protect-create",
    )
    assert [order.order_type for order in created] == [
        OrderType.STOP_MARKET,
        OrderType.TAKE_PROFIT_MARKET,
    ]
    assert all(order.status is OrderStatus.OPEN for order in created)

    before_failure = broker.state_hash
    with pytest.raises(ReplayDomainError) as failure:
        broker.set_position_protection(
            quantity=None,
            stop_loss_price="102",
            take_profit_price="103",
            command_id="protect-invalid",
        )
    assert failure.value.code is ReplayErrorCode.ORDER_REJECTED
    assert broker.state_hash == before_failure

    replaced = broker.set_position_protection(
        quantity="0.5",
        stop_loss_price="99",
        take_profit_price=None,
        command_id="protect-replace",
    )
    assert [order.status for order in replaced[:2]] == [
        OrderStatus.CANCELED,
        OrderStatus.CANCELED,
    ]
    assert replaced[-1].order_type is OrderType.STOP_MARKET
    assert replaced[-1].quantity == "0.5"
    assert [order.client_order_id for order in broker.open_orders] == [
        replaced[-1].client_order_id
    ]

    cleared = broker.set_position_protection(
        quantity=None,
        stop_loss_price=None,
        take_profit_price=None,
        command_id="protect-clear",
    )
    assert len(cleared) == 1
    assert cleared[0].status is OrderStatus.CANCELED
    assert broker.open_orders == ()


def test_market_position_intents_reject_ambiguous_open_and_reverse_atomically() -> None:
    broker = _long_broker(touch=True)
    before_open = broker.state_hash
    with pytest.raises(ReplayDomainError, match="cannot reduce or reverse"):
        broker.execute_position_intent(
            intent="OPEN",
            side="SELL",
            quantity="1",
            command_id="ambiguous-open",
        )
    assert broker.state_hash == before_open

    before_failed_reverse = broker.state_hash
    with pytest.raises(ReplayDomainError):
        broker.execute_position_intent(
            intent="REVERSE",
            side="SELL",
            quantity="11",
            command_id="failed-reverse",
        )
    assert broker.state_hash == before_failed_reverse
    assert broker.position.quantity == "1"

    reversed_orders = broker.execute_position_intent(
        intent="REVERSE",
        side="SELL",
        quantity="2",
        command_id="reverse",
    )
    assert len(reversed_orders) == 2
    assert all(order.status is OrderStatus.FILLED for order in reversed_orders)
    assert broker.position.quantity == "-2"
    assert reversed_orders[0].side is OrderSide.SELL
    assert reversed_orders[0].reduce_only is True
    assert reversed_orders[1].side is OrderSide.SELL
    assert reversed_orders[1].reduce_only is False


def test_replace_order_is_atomic_and_preserves_execution_semantics() -> None:
    broker = make_broker()
    original = broker.place_order(
        request(
            client_order_id="replace-original",
            order_type=OrderType.LIMIT,
            quantity="1",
            limit_price="90",
        ),
        command_id="place-original",
    )

    changed = broker.replace_order(
        original.order_id,
        request(
            client_order_id="replace-success",
            order_type=OrderType.LIMIT,
            quantity="2",
            limit_price="89",
        ),
        command_id="replace-success",
    )

    assert changed[0].status is OrderStatus.CANCELED
    assert changed[1].status is OrderStatus.OPEN
    assert changed[1].quantity == "2"
    assert changed[1].limit_price == "89"
    assert changed[1].side is original.side
    assert changed[1].reduce_only is original.reduce_only

    before_failure = broker.state_hash
    with pytest.raises(ReplayDomainError):
        broker.replace_order(
            changed[1].order_id,
            request(
                client_order_id="replace-invalid",
                order_type=OrderType.LIMIT,
                quantity="11",
                limit_price="88",
            ),
            command_id="replace-invalid",
        )
    assert broker.state_hash == before_failure
    assert broker.order(changed[1].order_id).status is OrderStatus.OPEN


def test_batch_cancel_is_atomic_for_selected_ids_and_track_scope() -> None:
    broker = make_broker()
    first = broker.place_order(
        request(
            client_order_id="batch-first",
            order_type=OrderType.LIMIT,
            limit_price="90",
        ),
        command_id="batch-first",
    )
    second = broker.place_order(
        request(
            client_order_id="batch-second",
            order_type=OrderType.LIMIT,
            limit_price="89",
        ),
        command_id="batch-second",
    )

    before_failure = broker.state_hash
    with pytest.raises(ReplayDomainError):
        broker.cancel_orders(
            scope="ORDER_IDS",
            order_ids=(first.order_id, "ord-missing"),
            command_id="batch-invalid",
        )
    assert broker.state_hash == before_failure
    assert {order.order_id for order in broker.open_orders} == {
        first.order_id,
        second.order_id,
    }

    canceled = broker.cancel_orders(
        scope="SELECTED_TRACK",
        order_ids=(),
        command_id="batch-track",
    )
    assert {order.order_id for order in canceled} == {
        first.order_id,
        second.order_id,
    }
    assert all(order.status is OrderStatus.CANCELED for order in canceled)
    assert broker.open_orders == ()
