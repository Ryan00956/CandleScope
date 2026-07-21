"""Deterministic instrument and paper-account risk calculations."""

from __future__ import annotations

from decimal import Decimal, ROUND_CEILING, ROUND_FLOOR, localcontext
from typing import Iterable

from ..errors import ReplayDomainError, ReplayErrorCode
from .models import (
    Account,
    BrokerConfig,
    OrderRequest,
    OrderSide,
    Position,
    ReplayOrder,
    canonical_decimal,
    decimal_to_string,
)


def decimal_multiple(value: Decimal, step: Decimal) -> bool:
    return value % step == 0


def round_to_step(value: Decimal, step: Decimal, *, upward: bool) -> Decimal:
    if value < 0 or step <= 0:
        raise ValueError("round_to_step requires non-negative value and positive step")
    rounding = ROUND_CEILING if upward else ROUND_FLOOR
    with localcontext() as context:
        context.prec = 60
        units = (value / step).to_integral_value(rounding=rounding)
        return units * step


def quote_round_up(value: Decimal, config: BrokerConfig) -> Decimal:
    return round_to_step(
        value,
        Decimal(config.instrument.quote_step),
        upward=True,
    )


def adverse_market_price(
    reference_price: str,
    side: OrderSide,
    config: BrokerConfig,
) -> str:
    price = Decimal(reference_price)
    bps = Decimal(config.market_slippage_bps) / Decimal(10_000)
    slipped = price * (Decimal(1) + bps * side.sign)
    rounded = round_to_step(
        slipped,
        Decimal(config.instrument.price_tick),
        upward=side is OrderSide.BUY,
    )
    return decimal_to_string(rounded, field_name="fill_price")


def fee_for_fill(
    *,
    notional: Decimal,
    maker: bool,
    config: BrokerConfig,
) -> str:
    bps = Decimal(config.maker_bps if maker else config.taker_bps)
    fee = quote_round_up(notional * bps / Decimal(10_000), config)
    return decimal_to_string(fee, field_name="fee")


def order_reference_price(request: OrderRequest, mark_price: str) -> Decimal:
    if request.limit_price is not None:
        return Decimal(request.limit_price)
    if request.stop_price is not None:
        return Decimal(request.stop_price)
    return Decimal(mark_price)


def order_reference_price_for_existing(order: ReplayOrder, mark_price: str) -> Decimal:
    if order.limit_price is not None:
        return Decimal(order.limit_price)
    if order.stop_price is not None:
        return Decimal(order.stop_price)
    return Decimal(mark_price)


def validate_order_risk(
    *,
    config: BrokerConfig,
    request: OrderRequest,
    position: Position,
    account: Account,
    open_orders: Iterable[ReplayOrder],
) -> str:
    """Validate one request and return its conservative margin reservation."""

    quantity = Decimal(request.quantity)
    filters = config.instrument
    limits = config.limits
    if not decimal_multiple(quantity, Decimal(filters.quantity_step)):
        _order_rejected("quantity is not aligned to instrument step")
    if quantity < Decimal(filters.min_quantity) or quantity > Decimal(
        filters.max_quantity
    ):
        _order_rejected("quantity is outside instrument bounds")
    if quantity > Decimal(limits.max_order_quantity):
        _risk_rejected("quantity exceeds max_order_quantity")

    for field_name, value in (
        ("limit_price", request.limit_price),
        ("stop_price", request.stop_price),
    ):
        if value is not None and not decimal_multiple(
            Decimal(value),
            Decimal(filters.price_tick),
        ):
            _order_rejected(f"{field_name} is not aligned to instrument tick")

    reference = order_reference_price(request, position.mark_price)
    notional = reference * quantity
    if notional < Decimal(filters.min_notional) or notional > Decimal(
        filters.max_notional
    ):
        _order_rejected("order notional is outside instrument bounds")

    if request.reduce_only:
        position_quantity = Decimal(position.quantity)
        if position_quantity == 0:
            _order_rejected("reduce-only order requires an open position")
        expected_side = OrderSide.SELL if position_quantity > 0 else OrderSide.BUY
        if request.side is not expected_side:
            _order_rejected("reduce-only side would increase the position")
        if quantity > abs(position_quantity):
            _order_rejected("reduce-only quantity exceeds the position")
        return "0"

    existing_exposure = abs(Decimal(position.quantity)) * Decimal(position.mark_price)
    for order in open_orders:
        if order.reduce_only or order.status.terminal:
            continue
        existing_exposure += Decimal(order.remaining_quantity) * (
            order_reference_price_for_existing(order, position.mark_price)
        )
    projected_exposure = existing_exposure + notional
    if projected_exposure > Decimal(limits.max_position_notional):
        _risk_rejected("order would exceed max_position_notional")

    reservation = quote_round_up(notional / Decimal(limits.max_leverage), config)
    if reservation > Decimal(account.available_equity):
        _risk_rejected("insufficient available equity for margin reservation")
    return decimal_to_string(reservation, field_name="reserved_margin")


def mark_position(position: Position, mark_price: str) -> Position:
    mark = Decimal(
        canonical_decimal(mark_price, field_name="mark_price", positive=True)
    )
    quantity = Decimal(position.quantity)
    with localcontext() as context:
        context.prec = 60
        notional = abs(quantity) * mark
        if quantity == 0:
            unrealized = Decimal(0)
        else:
            assert position.entry_price is not None
            unrealized = (mark - Decimal(position.entry_price)) * quantity
    return Position(
        quantity=position.quantity,
        entry_price=position.entry_price,
        mark_price=decimal_to_string(mark, field_name="mark_price"),
        notional=decimal_to_string(notional, field_name="notional"),
        realized_pnl=position.realized_pnl,
        unrealized_pnl=decimal_to_string(
            unrealized,
            field_name="unrealized_pnl",
        ),
    )


def build_account(
    *,
    config: BrokerConfig,
    position: Position,
    realized_pnl: str,
    fees_paid: str,
    reserved_margin: str,
    cash_balance: str | None = None,
) -> Account:
    realized = Decimal(realized_pnl)
    fees = Decimal(fees_paid)
    reserved = Decimal(reserved_margin)
    with localcontext() as context:
        context.prec = 60
        cash = (
            Decimal(config.initial_equity) + realized - fees
            if cash_balance is None
            else Decimal(cash_balance)
        )
        equity = cash + Decimal(position.unrealized_pnl)
        margin_used = quote_round_up(
            Decimal(position.notional) / Decimal(config.limits.max_leverage),
            config,
        )
        available = equity - margin_used - reserved
    return Account(
        cash_balance=decimal_to_string(cash, field_name="cash_balance"),
        equity=decimal_to_string(equity, field_name="equity"),
        available_equity=decimal_to_string(
            available,
            field_name="available_equity",
        ),
        margin_used=decimal_to_string(margin_used, field_name="margin_used"),
        reserved_margin=decimal_to_string(
            reserved,
            field_name="reserved_margin",
        ),
        realized_pnl=decimal_to_string(realized, field_name="realized_pnl"),
        unrealized_pnl=position.unrealized_pnl,
        fees_paid=decimal_to_string(fees, field_name="fees_paid"),
        quote_asset=config.quote_asset,
    )


def validate_trigger_position_notional(
    *,
    config: BrokerConfig,
    position: Position,
) -> None:
    notional = Decimal(position.notional)
    if notional > Decimal(config.instrument.max_notional) or notional > Decimal(
        config.limits.max_position_notional
    ):
        _risk_rejected("trigger fill would exceed hard position notional limit")


def _order_rejected(message: str) -> None:
    raise ReplayDomainError(ReplayErrorCode.ORDER_REJECTED, message)


def _risk_rejected(message: str) -> None:
    raise ReplayDomainError(ReplayErrorCode.RISK_LIMIT_EXCEEDED, message)
