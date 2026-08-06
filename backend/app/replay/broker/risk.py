"""Deterministic instrument and paper-account risk calculations."""

from __future__ import annotations

from decimal import Decimal, ROUND_CEILING, ROUND_FLOOR, localcontext
from typing import Iterable, Protocol

from ..errors import ReplayDomainError, ReplayErrorCode
from .models import (
    Account,
    BrokerConfig,
    OrderCapacityRequest,
    OrderRequest,
    OrderSide,
    Position,
    PositionBook,
    PositionMode,
    PositionSide,
    PositionState,
    ReplayOrder,
    canonical_decimal,
    decimal_to_string,
)


class OrderRiskContext(Protocol):
    side: OrderSide
    reduce_only: bool
    limit_price: str | None
    stop_price: str | None
    leverage: str | None
    position_side: PositionSide | None


def position_for_order(
    *,
    config: BrokerConfig,
    request: OrderRiskContext,
    position: PositionState,
) -> Position:
    if config.position_mode is PositionMode.ONE_WAY:
        if request.position_side is not None:
            _order_rejected("position_side is only valid in HEDGE mode")
        if not isinstance(position, Position):
            raise TypeError("ONE_WAY broker requires a net position")
        return position
    if request.position_side is None:
        _order_rejected("position_side is required in HEDGE mode")
    if not isinstance(position, PositionBook):
        raise TypeError("HEDGE broker requires a position book")
    expected_side = (
        request.position_side.closing_order_side
        if request.reduce_only
        else request.position_side.opening_order_side
    )
    if request.side is not expected_side:
        _order_rejected("order side does not match the selected hedge leg")
    return position.leg(request.position_side)


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


def order_reference_price(request: OrderRiskContext, mark_price: str) -> Decimal:
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


def position_leverage(position: Position, config: BrokerConfig) -> Decimal:
    """Return the persisted leg leverage, with ONE_WAY legacy fallback."""

    if position.leverage is None:
        value = Decimal(config.limits.max_leverage)
        if value <= 0:
            _risk_rejected("session leverage limit must be positive")
        return value
    value = Decimal(position.leverage)
    if value < 1 or value > Decimal(config.limits.max_leverage):
        _risk_rejected("position leverage is outside the session leverage limit")
    return value


def effective_order_leverage(
    request: OrderRiskContext,
    config: BrokerConfig,
    position: Position | None = None,
) -> Decimal:
    """Resolve request leverage against the target leg's active setting."""

    maximum = Decimal(config.limits.max_leverage)
    if request.leverage is None:
        return maximum if position is None else position_leverage(position, config)
    leverage = Decimal(request.leverage)
    if leverage < 1:
        _order_rejected("leverage must be at least 1")
    if leverage > maximum:
        _risk_rejected("leverage exceeds session max_leverage")
    return leverage


def validate_order_risk(
    *,
    config: BrokerConfig,
    request: OrderRequest,
    position: PositionState,
    account: Account,
    open_orders: Iterable[ReplayOrder],
) -> str:
    """Validate one request and return its conservative margin reservation."""

    target_position = position_for_order(
        config=config,
        request=request,
        position=position,
    )
    leverage = effective_order_leverage(request, config, target_position)
    if (
        not request.reduce_only
        and Decimal(target_position.quantity) != 0
        and request.leverage is not None
        and leverage != position_leverage(target_position, config)
    ):
        _risk_rejected(
            "opening order leverage differs from the active hedge leg; "
            "set position leverage first"
        )
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
        position_quantity = Decimal(target_position.quantity)
        if position_quantity == 0:
            _order_rejected("reduce-only order requires an open position")
        expected_side = OrderSide.SELL if position_quantity > 0 else OrderSide.BUY
        if request.side is not expected_side:
            _order_rejected("reduce-only side would increase the position")
        if quantity > abs(position_quantity):
            _order_rejected("reduce-only quantity exceeds the position")
        return "0"

    existing_exposure = Decimal(position.notional)
    for order in open_orders:
        if order.reduce_only or order.status.terminal:
            continue
        existing_exposure += Decimal(order.remaining_quantity) * (
            order_reference_price_for_existing(order, position.mark_price)
        )
    projected_exposure = existing_exposure + notional
    if projected_exposure > Decimal(limits.max_position_notional):
        _risk_rejected("order would exceed max_position_notional")

    reservation = quote_round_up(notional / leverage, config)
    if reservation > Decimal(account.available_equity):
        _risk_rejected("insufficient available equity for margin reservation")
    return decimal_to_string(reservation, field_name="reserved_margin")


def build_order_capacity(
    *,
    config: BrokerConfig,
    request: OrderCapacityRequest,
    position: PositionState,
    account: Account,
    orders: Iterable[ReplayOrder],
) -> dict[str, object]:
    """Calculate order capacity without depending on a draft quantity."""

    all_orders = tuple(orders)
    open_orders = tuple(
        order
        for order in all_orders
        if order.status.value in {"OPEN", "PARTIALLY_FILLED"}
    )
    if len(all_orders) >= config.limits.max_orders:
        raise ReplayDomainError(
            ReplayErrorCode.SCAN_LIMIT_EXCEEDED,
            "broker order capacity exceeded",
        )
    if len(open_orders) >= config.limits.max_open_orders:
        _risk_rejected("open order limit exceeded")

    filters = config.instrument
    for field_name, value in (
        ("limit_price", request.limit_price),
        ("stop_price", request.stop_price),
    ):
        if value is not None and not decimal_multiple(
            Decimal(value),
            Decimal(filters.price_tick),
        ):
            _order_rejected(f"{field_name} is not aligned to instrument tick")

    target_position = position_for_order(
        config=config,
        request=request,
        position=position,
    )
    reference = order_reference_price(request, position.mark_price)
    leverage = effective_order_leverage(request, config, target_position)
    if request.reduce_only:
        position_quantity = Decimal(target_position.quantity)
        if position_quantity == 0:
            _order_rejected("reduce-only order requires an open position")
        expected_side = OrderSide.SELL if position_quantity > 0 else OrderSide.BUY
        if request.side is not expected_side:
            _order_rejected("reduce-only side would increase the position")
        maximum = abs(position_quantity)
    else:
        existing_exposure = Decimal(position.notional)
        for order in open_orders:
            if order.reduce_only:
                continue
            existing_exposure += Decimal(order.remaining_quantity) * (
                order_reference_price_for_existing(order, position.mark_price)
            )
        notional_capacity = max(
            Decimal(0),
            Decimal(config.limits.max_position_notional) - existing_exposure,
        )
        margin_capacity = max(Decimal(0), Decimal(account.available_equity)) * leverage
        maximum = min(
            Decimal(filters.max_quantity),
            Decimal(config.limits.max_order_quantity),
            Decimal(filters.max_notional) / reference,
            notional_capacity / reference,
            margin_capacity / reference,
        )
    maximum = round_to_step(
        max(Decimal(0), maximum),
        Decimal(filters.quantity_step),
        upward=False,
    )
    minimum_for_notional = round_to_step(
        Decimal(filters.min_notional) / reference,
        Decimal(filters.quantity_step),
        upward=True,
    )
    if maximum < max(Decimal(filters.min_quantity), minimum_for_notional):
        maximum = Decimal(0)
    return {
        "schema_version": "replay.order-capacity.v1",
        "context": request.to_dict(),
        "reference_price": decimal_to_string(reference, field_name="reference_price"),
        "max_quantity": decimal_to_string(maximum, field_name="max_quantity"),
        "quote_asset": account.quote_asset,
        "max_leverage": config.limits.max_leverage,
    }


def build_order_preview(
    *,
    config: BrokerConfig,
    request: OrderRequest,
    position: PositionState,
    account: Account,
    orders: Iterable[ReplayOrder],
) -> dict[str, object]:
    """Build an exact, read-only preview from the same risk inputs as placement."""

    all_orders = tuple(orders)
    open_orders = tuple(
        order
        for order in all_orders
        if order.status.value in {"OPEN", "PARTIALLY_FILLED"}
    )
    if request.client_order_id in {order.client_order_id for order in all_orders}:
        _order_rejected("client_order_id already exists")
    if len(all_orders) >= config.limits.max_orders:
        raise ReplayDomainError(
            ReplayErrorCode.SCAN_LIMIT_EXCEEDED,
            "broker order capacity exceeded",
        )
    if len(open_orders) >= config.limits.max_open_orders:
        _risk_rejected("open order limit exceeded")

    capacity = build_order_capacity(
        config=config,
        request=OrderCapacityRequest(
            side=request.side,
            order_type=request.order_type,
            reduce_only=request.reduce_only,
            limit_price=request.limit_price,
            stop_price=request.stop_price,
            leverage=request.leverage,
            position_side=request.position_side,
        ),
        position=position,
        account=account,
        orders=all_orders,
    )
    reservation = validate_order_risk(
        config=config,
        request=request,
        position=position,
        account=account,
        open_orders=open_orders,
    )
    reference = order_reference_price(request, position.mark_price)
    estimated_fill = (
        Decimal(adverse_market_price(position.mark_price, request.side, config))
        if request.limit_price is None and request.stop_price is None
        else reference
    )
    estimated_notional = estimated_fill * Decimal(request.quantity)
    fee = fee_for_fill(notional=estimated_notional, maker=False, config=config)
    available_after = Decimal(account.available_equity) - Decimal(reservation)

    return {
        "schema_version": "replay.order-preview.v1",
        "order": request.to_dict(),
        "reference_price": decimal_to_string(reference, field_name="reference_price"),
        "estimated_fill_price": decimal_to_string(
            estimated_fill,
            field_name="estimated_fill_price",
        ),
        "estimated_notional": decimal_to_string(
            estimated_notional,
            field_name="estimated_notional",
        ),
        "reserved_margin": reservation,
        "estimated_fee": fee,
        "fee_basis": "TAKER_WORST_CASE",
        "available_equity_after": decimal_to_string(
            available_after,
            field_name="available_equity_after",
        ),
        "max_quantity": capacity["max_quantity"],
        "quote_asset": account.quote_asset,
        "max_leverage": config.limits.max_leverage,
    }


def mark_position(position: PositionState, mark_price: str) -> PositionState:
    if isinstance(position, PositionBook):
        long = mark_position(position.long, mark_price)
        short = mark_position(position.short, mark_price)
        assert isinstance(long, Position) and isinstance(short, Position)
        return PositionBook(long=long, short=short)
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
        leverage=position.leverage,
    )


def build_account(
    *,
    config: BrokerConfig,
    position: PositionState,
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
        unrealized_pnl = position.unrealized_pnl
        cash = (
            Decimal(config.initial_equity) + realized - fees
            if cash_balance is None
            else Decimal(cash_balance)
        )
        equity = cash + Decimal(unrealized_pnl)
        legs = (
            (position.long, position.short)
            if isinstance(position, PositionBook)
            else (position,)
        )
        margin_used = sum(
            (
                quote_round_up(
                    Decimal(leg.notional) / position_leverage(leg, config),
                    config,
                )
                for leg in legs
            ),
            Decimal(0),
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
        unrealized_pnl=unrealized_pnl,
        fees_paid=decimal_to_string(fees, field_name="fees_paid"),
        quote_asset=config.quote_asset,
    )


def validate_trigger_position_notional(
    *,
    config: BrokerConfig,
    position: PositionState,
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
