from __future__ import annotations

from dataclasses import replace

import pytest

from app.replay.broker.models import (
    BrokerConfig,
    OrderCapacityRequest,
    OrderSide,
    OrderType,
)
from app.replay.errors import ReplayDomainError, ReplayErrorCode
from tests.fixtures.replay.broker_fakes import CONFIG, bar, make_broker, request


def _limited(**changes) -> BrokerConfig:
    return replace(CONFIG, limits=replace(CONFIG.limits, **changes))


@pytest.mark.parametrize(
    ("request_kwargs", "limit_changes"),
    [
        ({"quantity": "10.001"}, {}),
        ({"quantity": "2"}, {"max_position_notional": "150"}),
        ({"quantity": "10"}, {"max_leverage": "0.05"}),
    ],
)
def test_order_quantity_position_notional_and_available_equity_fail_closed(
    request_kwargs,
    limit_changes,
) -> None:
    broker = make_broker(config=_limited(**limit_changes))
    before = broker.state_hash
    with pytest.raises(ReplayDomainError) as rejected:
        broker.place_order(
            request(client_order_id="risk", **request_kwargs),
            command_id="cmd-risk",
        )
    assert rejected.value.code is ReplayErrorCode.RISK_LIMIT_EXCEEDED
    assert broker.state_hash == before


def test_open_order_reservations_are_bounded_and_released_on_fill() -> None:
    broker = make_broker()
    order = broker.place_order(
        request(
            client_order_id="reserved",
            order_type=OrderType.LIMIT,
            quantity="2",
            limit_price="95",
        ),
        command_id="cmd-reserved",
    )
    assert order.reserved_margin == "38"
    assert broker.account.available_equity == "9962"

    broker.apply_bar(bar(0, 94))
    assert broker.account.reserved_margin == "0"
    assert broker.account.margin_used == "38"


def test_trigger_time_gap_cannot_bypass_hard_position_notional_limit() -> None:
    broker = make_broker(config=_limited(max_position_notional="150"))
    order = broker.place_order(
        request(client_order_id="market", quantity="1"),
        command_id="cmd-market",
    )
    result = broker.apply_bar(bar(0, 200))
    assert result.fills == ()
    assert broker.order(order.order_id).status.value == "REJECTED"
    assert broker.position.quantity == "0"


def test_reduce_only_can_close_position_below_minimum_notional() -> None:
    broker = make_broker()
    broker.place_order(
        request(client_order_id="dust-entry", quantity="0.05"),
        command_id="cmd-dust-entry",
    )
    broker.apply_bar(bar(0, 101))
    broker.apply_bar(bar(1, 81))

    assert broker.position.quantity == "0.05"
    assert broker.position.notional == "4.1"
    assert broker.order_capacity(
        OrderCapacityRequest(
            side=OrderSide.SELL,
            order_type=OrderType.MARKET,
            reduce_only=True,
        )
    )["max_quantity"] == "0.05"

    order = broker.close_position(command_id="cmd-dust-close")
    assert order.reduce_only is True
    broker.apply_bar(bar(2, 81))
    assert broker.position.quantity == "0"
