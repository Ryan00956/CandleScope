"""BAR and aggregate-trade tape execution with one atomic replay reducer."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, replace
from decimal import Decimal, InvalidOperation, localcontext
from typing import Mapping, Sequence

from ..bars.builder import ReplayBarBuilder, ReplayDisplayBar
from ..bars.trade_builder import TradeReplayBarBuilder
from ..canonical import canonical_sha256
from ..constants import CommandType
from ..internal_commands import InternalCommandType
from ..dataset import ReplayBar
from ..errors import ReplayDomainError, ReplayErrorCode
from ..models import validate_counter, validate_identifier
from ..sources.trade_reader import ReplayTrade
from .ledger import LedgerBook, LedgerEntry
from .models import (
    AGG_TRADE_TOUCH_OR_TAPE_MODEL_VERSION,
    AGG_TRADE_TAPE_MODEL_VERSION,
    BAR_TOUCH_OR_TAPE_MODEL_VERSION,
    BROKER_MODEL_VERSION,
    PAPER_LINEAR_EXECUTION_MODE,
    TOUCH_OR_TAPE_EXECUTION_MODE,
    Account,
    BrokerConfig,
    BrokerEventResult,
    BrokerWarning,
    ClosedTrade,
    FillReason,
    LedgerAccount,
    LedgerKind,
    LiquidityRole,
    OrderCapacityRequest,
    OrderRequest,
    OrderSide,
    OrderStatus,
    OrderType,
    Position,
    PositionFillResult,
    ReplayFill,
    ReplayOrder,
    WarningCode,
    canonical_decimal,
    decimal_to_string,
    exact_keys,
)
from .risk import (
    adverse_market_price,
    build_order_capacity,
    build_order_preview,
    build_account,
    decimal_multiple,
    fee_for_fill,
    mark_position,
    validate_order_risk,
    validate_trigger_position_notional,
)


BROKER_STATE_SCHEMA_VERSION = "replay-conservative-broker-state.v1"
BROKER_STATE_HASH_SCHEMA_VERSION = "replay-conservative-broker-hash.v1"
FINAL_STATE_PROJECTION_SCHEMA_VERSION = "replay-final-state-projection.v1"
FINAL_STATE_SERIES_PATCH_SCHEMA_VERSION = "replay-series-tail-patch.v1"

_BASE36_DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz"


def _base36(value: int) -> str:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError("base36 value must be an integer")
    if value == 0:
        return "0"
    sign = "-" if value < 0 else ""
    remaining = abs(value)
    encoded: list[str] = []
    while remaining:
        remaining, digit = divmod(remaining, 36)
        encoded.append(_BASE36_DIGITS[digit])
    return sign + "".join(reversed(encoded))


def _decimal_scale(values: Sequence[str | None]) -> int:
    return max(
        (
            max(0, -Decimal(value).as_tuple().exponent)
            for value in values
            if value is not None
        ),
        default=0,
    )


def _scaled_decimal(value: str, scale: int) -> int:
    scaled = Decimal(value).scaleb(scale)
    integral = scaled.to_integral_value()
    if scaled != integral:
        raise ValueError("display bar decimal cannot be represented at its declared scale")
    return int(integral)


def _pack_final_state_bars(
    bars: Sequence[ReplayDisplayBar],
) -> tuple[dict[str, int], int, int | None, str]:
    """Pack exact decimals and monotone times without repeated JSON field names."""

    price_scale = _decimal_scale(
        tuple(value for bar in bars for value in (bar.open, bar.high, bar.low, bar.close))
    )
    volume_scale = _decimal_scale(tuple(bar.volume for bar in bars))
    quote_volume_scale = _decimal_scale(tuple(bar.quote_volume for bar in bars))
    taker_buy_base_scale = _decimal_scale(tuple(bar.taker_buy_base for bar in bars))
    taker_buy_quote_scale = _decimal_scale(tuple(bar.taker_buy_quote for bar in bars))
    scales = {
        "price": price_scale,
        "volume": volume_scale,
        "quote_volume": quote_volume_scale,
        "taker_buy_base": taker_buy_base_scale,
        "taker_buy_quote": taker_buy_quote_scale,
    }
    spans = [bar.close_time_ms - bar.open_time_ms + 1 for bar in bars]
    default_close_span_ms = None if not spans else Counter(spans).most_common(1)[0][0]
    previous_open_ms: int | None = None
    previous_close = 0
    records: list[str] = []
    for bar in bars:
        open_value = _scaled_decimal(bar.open, price_scale)
        high_value = _scaled_decimal(bar.high, price_scale)
        low_value = _scaled_decimal(bar.low, price_scale)
        close_value = _scaled_decimal(bar.close, price_scale)
        span = bar.close_time_ms - bar.open_time_ms + 1
        flags = int(bar.is_closed) | (int(bar.synthetic) << 1)
        fields = (
            "" if previous_open_ms is None else _base36(bar.open_time_ms - previous_open_ms),
            "" if span == default_close_span_ms else _base36(span),
            _base36(open_value - previous_close),
            _base36(high_value - previous_close),
            _base36(low_value - previous_close),
            _base36(close_value - previous_close),
            _base36(_scaled_decimal(bar.volume, volume_scale)),
            "~" if bar.quote_volume is None else _base36(_scaled_decimal(bar.quote_volume, quote_volume_scale)),
            "~" if bar.trades is None else _base36(bar.trades),
            "~" if bar.taker_buy_base is None else _base36(_scaled_decimal(bar.taker_buy_base, taker_buy_base_scale)),
            "~" if bar.taker_buy_quote is None else _base36(_scaled_decimal(bar.taker_buy_quote, taker_buy_quote_scale)),
            _base36(bar.first_base_open_ms - bar.open_time_ms),
            _base36(bar.last_base_open_ms - bar.open_time_ms),
            _base36(bar.component_count),
            _base36(bar.expected_components),
            _base36(flags),
        )
        records.append(",".join(fields))
        previous_open_ms = bar.open_time_ms
        previous_close = close_value
    return scales, (0 if not bars else bars[0].open_time_ms), default_close_span_ms, ";".join(records)


@dataclass(slots=True)
class _WorkingState:
    orders: dict[str, ReplayOrder]
    ledger: LedgerBook | None
    position: Position
    fills: list[ReplayFill]
    closed_trades: list[ClosedTrade]
    warnings: list[BrokerWarning]
    next_fill: int
    next_trade: int
    next_warning: int
    changed_orders: list[ReplayOrder]
    new_fills: list[ReplayFill]
    new_warnings: list[BrokerWarning]


def apply_position_fill(
    position: Position,
    side: OrderSide | str,
    quantity: str,
    price: str,
    mark_price: str,
) -> PositionFillResult:
    """Apply one fill to a one-way net position without binary floats."""

    normalized_side = side if isinstance(side, OrderSide) else OrderSide(side)
    fill_quantity = Decimal(quantity)
    fill_price = Decimal(price)
    if fill_quantity <= 0 or fill_price <= 0:
        raise ValueError("fill quantity and price must be positive")
    old_quantity = Decimal(position.quantity)
    old_entry = None if position.entry_price is None else Decimal(position.entry_price)
    delta = fill_quantity * normalized_side.sign
    new_quantity = old_quantity + delta
    realized_delta = Decimal(0)
    closed_quantity = Decimal(0)
    closed_entry: Decimal | None = None

    with localcontext() as context:
        context.prec = 60
        if old_quantity == 0:
            new_entry = fill_price
        elif old_quantity * delta > 0:
            assert old_entry is not None
            new_entry = (abs(old_quantity) * old_entry + abs(delta) * fill_price) / abs(
                new_quantity
            )
        else:
            assert old_entry is not None
            closed_quantity = min(abs(old_quantity), abs(delta))
            closed_entry = old_entry
            realized_delta = (
                (fill_price - old_entry)
                * closed_quantity
                * (Decimal(1) if old_quantity > 0 else Decimal(-1))
            )
            if new_quantity == 0:
                new_entry = None
            elif old_quantity * new_quantity > 0:
                new_entry = old_entry
            else:
                new_entry = fill_price

        cumulative_realized = Decimal(position.realized_pnl) + realized_delta
        mark = Decimal(mark_price)
        notional = abs(new_quantity) * mark
        if new_quantity == 0:
            unrealized = Decimal(0)
        else:
            assert new_entry is not None
            unrealized = (mark - new_entry) * new_quantity

    updated = Position(
        quantity=decimal_to_string(new_quantity, field_name="position.quantity"),
        entry_price=(
            None
            if new_entry is None
            else decimal_to_string(new_entry, field_name="position.entry_price")
        ),
        mark_price=decimal_to_string(mark, field_name="position.mark_price"),
        notional=decimal_to_string(notional, field_name="position.notional"),
        realized_pnl=decimal_to_string(
            cumulative_realized,
            field_name="position.realized_pnl",
        ),
        unrealized_pnl=decimal_to_string(
            unrealized,
            field_name="position.unrealized_pnl",
        ),
    )
    return PositionFillResult(
        position=updated,
        realized_pnl=decimal_to_string(
            realized_delta,
            field_name="fill.realized_pnl",
        ),
        closed_quantity=decimal_to_string(
            closed_quantity,
            field_name="fill.closed_quantity",
        ),
        closed_entry_price=(
            None
            if closed_entry is None
            else decimal_to_string(
                closed_entry,
                field_name="fill.closed_entry_price",
            )
        ),
    )


class ConservativeBarBroker:
    """Atomic paper broker over either closed BARs or revealed aggTrades."""

    def __init__(
        self,
        *,
        config: BrokerConfig,
        bar_builder: ReplayBarBuilder | TradeReplayBarBuilder,
        execution_mode: str = PAPER_LINEAR_EXECUTION_MODE,
    ) -> None:
        if not isinstance(config, BrokerConfig):
            raise TypeError("config must be BrokerConfig")
        if not isinstance(bar_builder, (ReplayBarBuilder, TradeReplayBarBuilder)):
            raise TypeError("bar_builder must be a supported replay bar reducer")
        self.config = config
        self._bar_builder = bar_builder
        if execution_mode not in {
            PAPER_LINEAR_EXECUTION_MODE,
            TOUCH_OR_TAPE_EXECUTION_MODE,
        }:
            raise ValueError("execution_mode is unsupported")
        self._execution_mode = execution_mode
        if execution_mode == TOUCH_OR_TAPE_EXECUTION_MODE:
            self._model_version = (
                AGG_TRADE_TOUCH_OR_TAPE_MODEL_VERSION
                if isinstance(bar_builder, TradeReplayBarBuilder)
                else BAR_TOUCH_OR_TAPE_MODEL_VERSION
            )
        else:
            self._model_version = (
                AGG_TRADE_TAPE_MODEL_VERSION
                if isinstance(bar_builder, TradeReplayBarBuilder)
                else BROKER_MODEL_VERSION
            )
        self._config_hash = canonical_sha256(config.to_dict())
        self.reset()

    @property
    def bar_builder(self) -> ReplayBarBuilder | TradeReplayBarBuilder:
        return self._bar_builder

    @property
    def model_version(self) -> str:
        return self._model_version

    @property
    def orders(self) -> tuple[ReplayOrder, ...]:
        return tuple(sorted(self._orders.values(), key=lambda order: order.ordinal))

    @property
    def open_orders(self) -> tuple[ReplayOrder, ...]:
        return tuple(
            order
            for order in self.orders
            if order.status in {OrderStatus.OPEN, OrderStatus.PARTIALLY_FILLED}
        )

    @property
    def fills(self) -> tuple[ReplayFill, ...]:
        return tuple(self._fills)

    @property
    def closed_trades(self) -> tuple[ClosedTrade, ...]:
        return tuple(self._closed_trades)

    @property
    def warnings(self) -> tuple[BrokerWarning, ...]:
        return tuple(self._warnings)

    @property
    def ledger_entries(self) -> tuple[LedgerEntry, ...]:
        return self._ledger.entries

    @property
    def position(self) -> Position:
        return self._position

    @property
    def account(self) -> Account:
        return self._account

    @property
    def state_hash(self) -> str:
        return str(self.snapshot()["state_hash"])

    def final_state_transport_anchor(self) -> int | None:
        """Return the mutable public tail that a later suffix must replace."""

        active = self._bar_builder.active_bar
        if active is not None:
            return active.open_time_ms
        closed = self._bar_builder.closed_bars
        return None if not closed else closed[-1].open_time_ms

    def final_state_transport_projection(
        self,
        replace_from_open_ms: int | None,
    ) -> dict[str, object]:
        """Build an exact compact public-state replacement after a hidden scan.

        Broker checkpoints retain 2,048 rich display-bar objects. Repeating
        their JSON field names on every one-day step dominated the wire frame.
        The stream only needs the changed retained suffix plus the complete
        small interaction state. Decimal values stay exact; the browser
        reconstructs and validates the final retained boundary fail-closed.
        """

        bars = [*self._bar_builder.closed_bars]
        active = self._bar_builder.active_bar
        if active is not None:
            bars.append(active)
        retained_start = None if not bars else bars[0].open_time_ms
        retained_end = None if not bars else bars[-1].open_time_ms
        if replace_from_open_ms is None or retained_start is None:
            suffix = bars
        else:
            suffix = [
                bar
                for bar in bars
                if bar.open_time_ms >= max(replace_from_open_ms, retained_start)
            ]
        effective_replace_from = None if not suffix else suffix[0].open_time_ms
        scales, first_open_ms, default_span_ms, packed = _pack_final_state_bars(
            suffix
        )
        return {
            "schema_version": FINAL_STATE_PROJECTION_SCHEMA_VERSION,
            "series": {
                "schema_version": FINAL_STATE_SERIES_PATCH_SCHEMA_VERSION,
                "encoding": "delta-base36-decimal-columns.v1",
                "replace_from_open_ms": effective_replace_from,
                "retained_start_open_ms": retained_start,
                "retained_end_open_ms": retained_end,
                "retained_count": len(bars),
                "bar_count": len(suffix),
                "first_open_ms": first_open_ms,
                "default_close_span_ms": default_span_ms,
                "decimal_scales": scales,
                "packed_bars": packed,
            },
            # Interaction collections are deliberately replacements, not
            # deltas. A fill/order boundary is mandatory and cannot leave a
            # client that subscribed during a hidden prefix with stale state.
            "orders": [order.to_dict() for order in self.orders],
            "fills": [fill.to_dict() for fill in self.fills],
            "closed_trades": [trade.to_dict() for trade in self.closed_trades],
            "warnings": [warning.to_dict() for warning in self.warnings],
            "position": self.position.to_dict(),
            "account": self.account.to_dict(),
        }

    def order(self, order_id: str) -> ReplayOrder:
        order = self._orders.get(order_id)
        if order is None:
            raise ReplayDomainError(
                ReplayErrorCode.ORDER_REJECTED,
                "order does not exist",
                details={"order_id": order_id},
            )
        return order

    def preview_order(self, request: OrderRequest) -> Mapping[str, object]:
        if not isinstance(request, OrderRequest):
            raise TypeError("request must be OrderRequest")
        return build_order_preview(
            config=self.config,
            request=request,
            position=self._position,
            account=self._account,
            orders=self.orders,
        )

    def order_capacity(self, request: OrderCapacityRequest) -> Mapping[str, object]:
        if not isinstance(request, OrderCapacityRequest):
            raise TypeError("request must be OrderCapacityRequest")
        return build_order_capacity(
            config=self.config,
            request=request,
            position=self._position,
            account=self._account,
            orders=self.orders,
        )

    def place_order(
        self,
        request: OrderRequest,
        *,
        command_id: str,
        accepted_source_sequence: int | None = None,
        created_time_ms: int | None = None,
    ) -> ReplayOrder:
        del command_id
        if self._ended:
            raise ReplayDomainError(
                ReplayErrorCode.SESSION_ENDED,
                "broker session has ended",
            )
        if not isinstance(request, OrderRequest):
            raise TypeError("request must be OrderRequest")
        sequence = self._resolve_command_sequence(accepted_source_sequence)
        event_time_ms = 0 if created_time_ms is None else created_time_ms
        if request.client_order_id in self._client_order_ids:
            raise ReplayDomainError(
                ReplayErrorCode.ORDER_REJECTED,
                "client_order_id already exists",
            )
        if len(self._orders) >= self.config.limits.max_orders:
            raise ReplayDomainError(
                ReplayErrorCode.SCAN_LIMIT_EXCEEDED,
                "broker order capacity exceeded",
            )
        if len(self.open_orders) >= self.config.limits.max_open_orders:
            raise ReplayDomainError(
                ReplayErrorCode.RISK_LIMIT_EXCEEDED,
                "open order limit exceeded",
            )
        reservation = validate_order_risk(
            config=self.config,
            request=request,
            position=self._position,
            account=self._account,
            open_orders=self.open_orders,
        )
        ledger = self._ledger.clone()
        if Decimal(reservation) > 0:
            ledger.post(
                kind=LedgerKind.RESERVE_MARGIN,
                source_sequence=sequence,
                event_time_ms=event_time_ms,
                postings=(
                    (LedgerAccount.AVAILABLE_MARGIN, f"-{reservation}"),
                    (LedgerAccount.RESERVED_MARGIN, reservation),
                ),
                order_id=f"ord-{self._next_order:010d}",
            )
        order = ReplayOrder(
            order_id=f"ord-{self._next_order:010d}",
            client_order_id=request.client_order_id,
            side=request.side,
            order_type=request.order_type,
            quantity=request.quantity,
            reduce_only=request.reduce_only,
            limit_price=request.limit_price,
            stop_price=request.stop_price,
            status=OrderStatus.OPEN,
            filled_quantity="0",
            remaining_quantity=request.quantity,
            average_fill_price=None,
            accepted_source_sequence=sequence,
            created_time_ms=event_time_ms,
            ordinal=self._next_order,
            reserved_margin=reservation,
            status_reason=None,
            status_history=(OrderStatus.NEW, OrderStatus.OPEN),
            model_version=self._model_version,
        )
        orders = dict(self._orders)
        orders[order.order_id] = order
        client_ids = set(self._client_order_ids)
        client_ids.add(order.client_order_id)
        working = self._working_state()
        working.orders = orders
        working.ledger = ledger
        immediate = self._revealed_reference_trigger(order)
        if immediate is not None:
            filled = self._fill_working(
                working,
                order,
                source_sequence=sequence,
                event_time_ms=event_time_ms,
                trigger=immediate,
            )
            if filled and Decimal(working.position.quantity) == 0:
                self._cancel_orphan_reduce_orders(
                    working,
                    source_sequence=sequence,
                    event_time_ms=event_time_ms,
                )
        account = self._account_from(
            working.ledger or ledger,
            working.position,
        )
        self._commit_working(working, account=account)
        self._client_order_ids = client_ids
        self._next_order += 1
        self._has_trading_activity = True
        return self._orders[order.order_id]

    def cancel_order(
        self,
        order_id: str,
        *,
        command_id: str,
        accepted_source_sequence: int | None = None,
        created_time_ms: int | None = None,
    ) -> ReplayOrder:
        del command_id
        sequence = self._resolve_command_sequence(accepted_source_sequence)
        event_time_ms = 0 if created_time_ms is None else created_time_ms
        order = self.order(order_id)
        if order.status not in {OrderStatus.OPEN, OrderStatus.PARTIALLY_FILLED}:
            raise ReplayDomainError(
                ReplayErrorCode.ORDER_REJECTED,
                "only open orders can be canceled",
            )
        working = self._working_state()
        canceled = self._terminal_order(
            working,
            order,
            OrderStatus.CANCELED,
            reason="USER_CANCELED",
            source_sequence=sequence,
            event_time_ms=event_time_ms,
        )
        self._commit_working(working)
        self._has_trading_activity = True
        return canceled

    def replace_order(
        self,
        order_id: str,
        request: OrderRequest,
        *,
        command_id: str,
        accepted_source_sequence: int | None = None,
        created_time_ms: int | None = None,
    ) -> tuple[ReplayOrder, ReplayOrder]:
        """Atomically cancel an open order and place its constrained replacement."""

        checkpoint = self.snapshot()
        try:
            existing = self.order(order_id)
            if existing.status not in {
                OrderStatus.OPEN,
                OrderStatus.PARTIALLY_FILLED,
            }:
                raise ReplayDomainError(
                    ReplayErrorCode.ORDER_REJECTED,
                    "only open orders can be replaced",
                )
            if (
                request.side is not existing.side
                or request.order_type is not existing.order_type
                or request.reduce_only is not existing.reduce_only
            ):
                raise ReplayDomainError(
                    ReplayErrorCode.ORDER_REJECTED,
                    "replacement must preserve side, order_type, and reduce_only",
                )
            canceled = self.cancel_order(
                order_id,
                command_id=command_id,
                accepted_source_sequence=accepted_source_sequence,
                created_time_ms=created_time_ms,
            )
            replacement = self.place_order(
                request,
                command_id=command_id,
                accepted_source_sequence=accepted_source_sequence,
                created_time_ms=created_time_ms,
            )
            return canceled, replacement
        except (ReplayDomainError, InvalidOperation, TypeError, ValueError):
            self.restore(checkpoint)
            raise

    def cancel_orders(
        self,
        *,
        scope: str,
        order_ids: Sequence[str],
        command_id: str,
        accepted_source_sequence: int | None = None,
        created_time_ms: int | None = None,
    ) -> tuple[ReplayOrder, ...]:
        """Atomically cancel selected orders or every open order in this broker track."""

        if scope not in {"ORDER_IDS", "SELECTED_TRACK"}:
            raise ReplayDomainError(
                ReplayErrorCode.ORDER_REJECTED,
                "cancel_orders scope is invalid",
            )
        normalized_ids = tuple(order_ids)
        if any(not isinstance(order_id, str) for order_id in normalized_ids):
            raise ReplayDomainError(
                ReplayErrorCode.ORDER_REJECTED,
                "cancel_orders order_ids are invalid",
            )
        if len(normalized_ids) != len(set(normalized_ids)):
            raise ReplayDomainError(
                ReplayErrorCode.ORDER_REJECTED,
                "cancel_orders order_ids must be unique",
            )
        if scope == "ORDER_IDS" and not 1 <= len(normalized_ids) <= 64:
            raise ReplayDomainError(
                ReplayErrorCode.ORDER_REJECTED,
                "ORDER_IDS requires between 1 and 64 order_ids",
            )
        if scope == "SELECTED_TRACK":
            if normalized_ids:
                raise ReplayDomainError(
                    ReplayErrorCode.ORDER_REJECTED,
                    "SELECTED_TRACK requires an empty order_ids array",
                )
            normalized_ids = tuple(order.order_id for order in self.open_orders)
        checkpoint = self.snapshot()
        try:
            return tuple(
                self.cancel_order(
                    order_id,
                    command_id=command_id,
                    accepted_source_sequence=accepted_source_sequence,
                    created_time_ms=created_time_ms,
                )
                for order_id in normalized_ids
            )
        except (ReplayDomainError, InvalidOperation, TypeError, ValueError):
            self.restore(checkpoint)
            raise

    def close_position(
        self,
        quantity: str | None = None,
        *,
        command_id: str,
        accepted_source_sequence: int | None = None,
        created_time_ms: int | None = None,
    ) -> ReplayOrder:
        if Decimal(self._position.quantity) == 0:
            raise ReplayDomainError(
                ReplayErrorCode.ORDER_REJECTED,
                "close_position requires an open position",
            )
        close_quantity = quantity or decimal_to_string(
            abs(Decimal(self._position.quantity)),
            field_name="close quantity",
        )
        side = OrderSide.SELL if Decimal(self._position.quantity) > 0 else OrderSide.BUY
        return self.place_order(
            OrderRequest(
                client_order_id=f"close-{self._next_order:010d}",
                side=side,
                order_type=OrderType.MARKET,
                quantity=close_quantity,
                reduce_only=True,
            ),
            command_id=command_id,
            accepted_source_sequence=accepted_source_sequence,
            created_time_ms=created_time_ms,
        )

    def execute_position_intent(
        self,
        *,
        intent: str,
        side: str | None,
        quantity: str | None,
        command_id: str,
        accepted_source_sequence: int | None = None,
        created_time_ms: int | None = None,
        leverage: str | None = None,
    ) -> tuple[ReplayOrder, ...]:
        """Execute an unambiguous market OPEN, CLOSE, or REVERSE action."""

        checkpoint = self.snapshot()
        try:
            position_quantity = Decimal(self._position.quantity)
            if intent == "OPEN":
                if side is None or quantity is None:
                    raise ReplayDomainError(
                        ReplayErrorCode.ORDER_REJECTED,
                        "OPEN requires side and quantity",
                    )
                normalized_side = OrderSide(side)
                if position_quantity != 0 and (
                    position_quantity > 0
                ) != (normalized_side is OrderSide.BUY):
                    raise ReplayDomainError(
                        ReplayErrorCode.ORDER_REJECTED,
                        "OPEN cannot reduce or reverse the current position",
                    )
                order = self.place_order(
                    OrderRequest(
                        client_order_id=f"intent-open-{self._next_order:010d}",
                        side=normalized_side,
                        order_type=OrderType.MARKET,
                        quantity=quantity,
                        reduce_only=False,
                        leverage=leverage,
                    ),
                    command_id=command_id,
                    accepted_source_sequence=accepted_source_sequence,
                    created_time_ms=created_time_ms,
                )
                return (order,)
            if intent == "CLOSE":
                if side is not None:
                    raise ReplayDomainError(
                        ReplayErrorCode.ORDER_REJECTED,
                        "CLOSE side must be null",
                    )
                return (
                    self.close_position(
                        quantity,
                        command_id=command_id,
                        accepted_source_sequence=accepted_source_sequence,
                        created_time_ms=created_time_ms,
                    ),
                )
            if intent != "REVERSE":
                raise ReplayDomainError(
                    ReplayErrorCode.ORDER_REJECTED,
                    "position intent must be OPEN, CLOSE, or REVERSE",
                )
            if self._execution_mode != TOUCH_OR_TAPE_EXECUTION_MODE:
                raise ReplayDomainError(
                    ReplayErrorCode.UNSUPPORTED_EXECUTION_MODEL,
                    "REVERSE requires revealed-reference execution",
                )
            if position_quantity == 0:
                raise ReplayDomainError(
                    ReplayErrorCode.ORDER_REJECTED,
                    "REVERSE requires an open position",
                )
            if side is None or quantity is None:
                raise ReplayDomainError(
                    ReplayErrorCode.ORDER_REJECTED,
                    "REVERSE requires target side and quantity",
                )
            normalized_side = OrderSide(side)
            if (position_quantity > 0) == (normalized_side is OrderSide.BUY):
                raise ReplayDomainError(
                    ReplayErrorCode.ORDER_REJECTED,
                    "REVERSE target side must oppose the current position",
                )
            closed = self.close_position(
                command_id=command_id,
                accepted_source_sequence=accepted_source_sequence,
                created_time_ms=created_time_ms,
            )
            opened = self.place_order(
                OrderRequest(
                    client_order_id=f"intent-reverse-{self._next_order:010d}",
                    side=normalized_side,
                    order_type=OrderType.MARKET,
                    quantity=quantity,
                    reduce_only=False,
                    leverage=leverage,
                ),
                command_id=command_id,
                accepted_source_sequence=accepted_source_sequence,
                created_time_ms=created_time_ms,
            )
            return (closed, opened)
        except (ReplayDomainError, InvalidOperation, TypeError, ValueError):
            self.restore(checkpoint)
            raise

    def set_position_protection(
        self,
        *,
        quantity: str | None,
        stop_loss_price: str | None,
        take_profit_price: str | None,
        command_id: str,
        accepted_source_sequence: int | None = None,
        created_time_ms: int | None = None,
    ) -> tuple[ReplayOrder, ...]:
        """Atomically replace this workflow's stop-loss/take-profit orders."""

        checkpoint = self.snapshot()
        changed: list[ReplayOrder] = []
        try:
            for existing in self.open_orders:
                if (
                    existing.client_order_id.startswith("protection-")
                    and existing.reduce_only
                    and existing.order_type
                    in {OrderType.STOP_MARKET, OrderType.TAKE_PROFIT_MARKET}
                ):
                    changed.append(
                        self.cancel_order(
                            existing.order_id,
                            command_id=command_id,
                            accepted_source_sequence=accepted_source_sequence,
                            created_time_ms=created_time_ms,
                        )
                    )
            if stop_loss_price is None and take_profit_price is None:
                if quantity is not None:
                    raise ReplayDomainError(
                        ReplayErrorCode.ORDER_REJECTED,
                        "clearing protection requires quantity to be null",
                    )
                return tuple(changed)

            position_quantity = Decimal(self._position.quantity)
            if position_quantity == 0:
                raise ReplayDomainError(
                    ReplayErrorCode.ORDER_REJECTED,
                    "position protection requires an open position",
                )
            protected_quantity = quantity or decimal_to_string(
                abs(position_quantity),
                field_name="protection quantity",
            )
            normalized_quantity = canonical_decimal(
                protected_quantity,
                field_name="protection quantity",
                positive=True,
            )
            if Decimal(normalized_quantity) > abs(position_quantity):
                raise ReplayDomainError(
                    ReplayErrorCode.ORDER_REJECTED,
                    "protection quantity exceeds the position",
                )
            mark = Decimal(self._position.mark_price)
            stop = None if stop_loss_price is None else Decimal(stop_loss_price)
            take_profit = (
                None if take_profit_price is None else Decimal(take_profit_price)
            )
            if position_quantity > 0:
                valid_stop = stop is None or stop < mark
                valid_take_profit = take_profit is None or take_profit > mark
                close_side = OrderSide.SELL
            else:
                valid_stop = stop is None or stop > mark
                valid_take_profit = take_profit is None or take_profit < mark
                close_side = OrderSide.BUY
            if not valid_stop or not valid_take_profit:
                raise ReplayDomainError(
                    ReplayErrorCode.ORDER_REJECTED,
                    "protection prices are on the wrong side of the current mark",
                    details={"mark_price": self._position.mark_price},
                )
            for label, order_type, price in (
                ("stop", OrderType.STOP_MARKET, stop_loss_price),
                ("take", OrderType.TAKE_PROFIT_MARKET, take_profit_price),
            ):
                if price is None:
                    continue
                changed.append(
                    self.place_order(
                        OrderRequest(
                            client_order_id=(
                                f"protection-{label}-{self._next_order:010d}"
                            ),
                            side=close_side,
                            order_type=order_type,
                            quantity=normalized_quantity,
                            reduce_only=True,
                            stop_price=price,
                        ),
                        command_id=command_id,
                        accepted_source_sequence=accepted_source_sequence,
                        created_time_ms=created_time_ms,
                    )
                )
            return tuple(changed)
        except (ReplayDomainError, InvalidOperation, TypeError, ValueError):
            self.restore(checkpoint)
            raise

    def adjust_capital(
        self,
        *,
        kind: str,
        amount: str,
        source_sequence: int,
        event_time_ms: int,
    ) -> BrokerEventResult:
        """Atomically post an audited external-capital ledger transaction."""

        if bool(getattr(self, "_ended", False)):
            raise ReplayDomainError(
                ReplayErrorCode.SESSION_ENDED,
                "broker session has ended",
            )
        normalized_amount = canonical_decimal(
            amount,
            field_name="capital adjustment amount",
            positive=True,
        )
        if kind not in {"deposit", "withdraw"}:
            raise ReplayDomainError(
                ReplayErrorCode.INVALID_STATE_TRANSITION,
                "capital adjustment kind is unsupported",
            )
        working = self._working_state()
        ledger = self._ledger_for_write(working)
        current_account = self._account_from(ledger, working.position)
        if kind == "withdraw" and Decimal(normalized_amount) > Decimal(
            current_account.available_equity
        ):
            raise ReplayDomainError(
                ReplayErrorCode.RISK_LIMIT_EXCEEDED,
                "withdrawal exceeds available equity",
            )
        signed = normalized_amount if kind == "deposit" else f"-{normalized_amount}"
        counter = f"-{normalized_amount}" if kind == "deposit" else normalized_amount
        ledger.post(
            kind=LedgerKind.DEPOSIT if kind == "deposit" else LedgerKind.WITHDRAW,
            source_sequence=source_sequence,
            event_time_ms=event_time_ms,
            postings=(
                (LedgerAccount.CASH, signed),
                (LedgerAccount.EXTERNAL_CAPITAL, counter),
            ),
        )
        account = self._account_from(ledger, working.position)
        self._commit_working(working, account=account)
        self._has_trading_activity = True
        self._record_equity(account)
        return BrokerEventResult(
            bar_update=None,
            orders=(),
            fills=(),
            warnings=(),
            position=working.position,
            account=account,
        )

    def apply_bar(self, bar: ReplayBar) -> BrokerEventResult:
        if self._ended:
            raise ReplayDomainError(
                ReplayErrorCode.SESSION_ENDED,
                "broker session has ended",
            )
        if not isinstance(bar, ReplayBar):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "broker source event must be ReplayBar",
            )
        source_sequence = self._bar_builder.replay_events_applied + 1
        working = self._working_state()
        eligible = [
            order
            for order in self.open_orders
            if order.accepted_source_sequence < source_sequence
        ]
        eligible.sort(key=lambda order: order.ordinal)
        entry_filled = False

        for order in (order for order in eligible if not order.reduce_only):
            trigger = self._trigger(order, bar)
            if trigger is None:
                continue
            if self._fill_working(
                working,
                order,
                source_sequence=source_sequence,
                event_time_ms=bar.open_time_ms,
                trigger=trigger,
            ):
                entry_filled = True

        reduce_triggers = [
            (order, trigger)
            for order in eligible
            if order.reduce_only and (trigger := self._trigger(order, bar)) is not None
        ]
        stop_ids = {
            order.order_id
            for order, _ in reduce_triggers
            if order.order_type is OrderType.STOP_MARKET
        }
        profit_ids = {
            order.order_id
            for order, _ in reduce_triggers
            if order.order_type in {OrderType.LIMIT, OrderType.TAKE_PROFIT_MARKET}
        }
        if stop_ids and profit_ids:
            self._warn(
                working,
                WarningCode.AMBIGUOUS_INTRABAR_WORST_CASE,
                source_sequence,
                tuple(sorted(stop_ids | profit_ids)),
                "stop and favorable exit touched in one BAR; adverse stop executed first",
            )
        reduce_triggers.sort(
            key=lambda item: (self._reduce_priority(item[0]), item[0].ordinal)
        )
        entry_exit_warned = False
        for order, trigger in reduce_triggers:
            current_order = working.orders[order.order_id]
            if current_order.status.terminal:
                continue
            if Decimal(working.position.quantity) == 0 or not self._reduces_position(
                current_order,
                working.position,
            ):
                self._terminal_order(
                    working,
                    current_order,
                    OrderStatus.CANCELED,
                    reason="REDUCE_ONLY_NO_POSITION",
                    source_sequence=source_sequence,
                    event_time_ms=bar.close_time_ms,
                )
                continue
            if (
                entry_filled
                and current_order.order_type
                in {OrderType.LIMIT, OrderType.TAKE_PROFIT_MARKET}
                and not stop_ids
            ):
                continue
            filled = self._fill_working(
                working,
                current_order,
                source_sequence=source_sequence,
                event_time_ms=bar.close_time_ms,
                trigger=trigger,
            )
            if filled and entry_filled and not entry_exit_warned:
                self._warn(
                    working,
                    WarningCode.ENTRY_EXIT_SAME_BAR_WORST_CASE,
                    source_sequence,
                    tuple(fill.order_id for fill in working.new_fills),
                    "entry and adverse exit executed in the same ambiguous BAR",
                )
                entry_exit_warned = True
            if Decimal(working.position.quantity) == 0:
                self._cancel_orphan_reduce_orders(
                    working,
                    source_sequence=source_sequence,
                    event_time_ms=bar.close_time_ms,
                )

        working.position = mark_position(working.position, bar.close)
        ledger = working.ledger or self._ledger
        account = self._account_from(ledger, working.position)
        self._assert_candidate_invariants(working, ledger, account)
        bar_update = self._bar_builder.apply_bar(bar)

        self._commit_working(working, account=account)
        self._record_equity(account)
        return BrokerEventResult(
            bar_update=bar_update.to_dict(),
            orders=tuple(working.changed_orders),
            fills=tuple(working.new_fills),
            warnings=tuple(working.new_warnings),
            position=self._position,
            account=self._account,
        )

    def apply_trade(self, trade: ReplayTrade) -> BrokerEventResult:
        """Allocate one revealed tape quantity once across deterministic orders."""

        if self._ended:
            raise ReplayDomainError(
                ReplayErrorCode.SESSION_ENDED,
                "broker session has ended",
            )
        if not isinstance(self._bar_builder, TradeReplayBarBuilder):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "aggregate trade cannot be applied to a BAR broker",
            )
        if not isinstance(trade, ReplayTrade):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "tape broker source event must be ReplayTrade",
            )
        source_sequence = self._bar_builder.replay_events_applied + 1
        working = self._working_state()
        available = Decimal(trade.quantity)
        eligible = [
            order
            for order in self.open_orders
            if order.accepted_source_sequence < source_sequence
        ]
        eligible.sort(key=lambda order: (self._tape_priority(order), order.ordinal))

        for eligible_order in eligible:
            order = working.orders[eligible_order.order_id]
            if order.status not in {
                OrderStatus.OPEN,
                OrderStatus.PARTIALLY_FILLED,
            }:
                continue
            if order.reduce_only and (
                Decimal(working.position.quantity) == 0
                or not self._reduces_position(order, working.position)
            ):
                self._terminal_order(
                    working,
                    order,
                    OrderStatus.CANCELED,
                    reason="REDUCE_ONLY_NO_POSITION",
                    source_sequence=source_sequence,
                    event_time_ms=trade.trade_time_ms,
                )
                continue
            triggered = self._trade_trigger(order, trade)
            if triggered is None:
                continue
            trigger, partial_reason = triggered
            if available <= 0:
                if (
                    partial_reason == "TAPE_TRIGGERED"
                    and order.status_reason != "TAPE_TRIGGERED"
                ):
                    triggered_order = replace(
                        order,
                        status_reason="TAPE_TRIGGERED",
                    )
                    working.orders[order.order_id] = triggered_order
                    working.changed_orders.append(triggered_order)
                continue
            fill_count = len(working.new_fills)
            filled = self._fill_working(
                working,
                order,
                source_sequence=source_sequence,
                event_time_ms=trade.trade_time_ms,
                trigger=trigger,
                max_fill_quantity=available,
                allow_partial=True,
                partial_status_reason=partial_reason,
            )
            if filled and len(working.new_fills) == fill_count + 1:
                available -= Decimal(working.new_fills[-1].quantity)
            if Decimal(working.position.quantity) == 0:
                self._cancel_orphan_reduce_orders(
                    working,
                    source_sequence=source_sequence,
                    event_time_ms=trade.trade_time_ms,
                )

        working.position = mark_position(working.position, trade.price)
        ledger = working.ledger or self._ledger
        account = self._account_from(ledger, working.position)
        self._assert_candidate_invariants(working, ledger, account)
        bar_update = self._bar_builder.apply_trade(trade)

        self._commit_working(working, account=account)
        self._record_equity(account)
        return BrokerEventResult(
            bar_update=bar_update,
            orders=tuple(working.changed_orders),
            fills=tuple(working.new_fills),
            warnings=tuple(working.new_warnings),
            position=self._position,
            account=self._account,
        )

    def apply_source_event(self, event: object) -> Mapping[str, object]:
        if isinstance(event, ReplayBar):
            return self.apply_bar(event).to_dict()
        if isinstance(event, ReplayTrade):
            return self.apply_trade(event).to_dict()
        raise ReplayDomainError(
            ReplayErrorCode.DATASET_MISMATCH,
            "broker source event is neither ReplayBar nor ReplayTrade",
        )

    def apply_source_events_final_state(
        self,
        events: Sequence[object],
    ) -> Mapping[str, object]:
        """Apply an interaction-free block without constructing projections."""

        if self._ended:
            raise ReplayDomainError(
                ReplayErrorCode.SESSION_ENDED,
                "broker session has ended",
            )
        if not self.can_apply_source_events_final_state(events):
            raise ReplayDomainError(
                ReplayErrorCode.INVALID_STATE_TRANSITION,
                "final-state broker batch may contain an order interaction",
            )
        if not events:
            return {}
        final_mark: str | None = None
        if all(isinstance(event, ReplayTrade) for event in events):
            if not isinstance(self._bar_builder, TradeReplayBarBuilder):
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "aggregate trade cannot be applied to a BAR broker",
                )
            trades = tuple(
                event for event in events if isinstance(event, ReplayTrade)
            )
            self._bar_builder.apply_trades_final_state(trades)
            final_mark = trades[-1].price
        else:
            if not isinstance(self._bar_builder, ReplayBarBuilder):
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "BAR event cannot be applied to a trade broker",
                )
            bars: list[ReplayBar] = []
            for event in events:
                if not isinstance(event, ReplayBar):
                    raise ReplayDomainError(
                        ReplayErrorCode.DATASET_MISMATCH,
                        "broker final-state batch cannot mix source event kinds",
                    )
                bars.append(event)
            self._bar_builder.apply_bars_final_state(bars)
            final_mark = bars[-1].close
        if self._position.quantity == "0":
            if final_mark is None:
                return {}
            self._position = mark_position(self._position, final_mark)
            self._account = self._account_from(self._ledger, self._position)
            self._record_equity(self._account)
        else:
            for event in events:
                if isinstance(event, ReplayBar):
                    mark = event.close
                elif isinstance(event, ReplayTrade):
                    mark = event.price
                else:  # pragma: no cover - validated before reducer mutation
                    raise ReplayDomainError(
                        ReplayErrorCode.DATASET_MISMATCH,
                        "broker final-state batch contains an invalid source event",
                    )
                self._position = mark_position(self._position, mark)
                self._account = self._account_from(self._ledger, self._position)
                self._record_equity(self._account)
        self._assert_invariants()
        return {}

    def supports_final_state_batch(self) -> bool:
        return not any(
            not order.status.terminal for order in self._orders.values()
        )

    def can_apply_source_events_final_state(
        self,
        events: Sequence[object],
    ) -> bool:
        """Return whether a source block cannot mutate any currently open order."""

        return self.final_state_safe_prefix_length(events) == len(events)

    def final_state_safe_prefix_length(
        self,
        events: Sequence[object],
    ) -> int:
        """Return the exact prefix ending before the first possible interaction."""

        if not events:
            return 0
        trade_source = isinstance(self._bar_builder, TradeReplayBarBuilder)
        if trade_source:
            if any(not isinstance(event, ReplayTrade) for event in events):
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "aggregate-trade broker batch contains a non-trade event",
                )
        elif any(not isinstance(event, ReplayBar) for event in events):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "BAR broker batch contains a non-BAR event",
            )

        open_orders = self.open_orders
        if not open_orders:
            return len(events)
        first_sequence = self._bar_builder.replay_events_applied + 1
        position_quantity = Decimal(self._position.quantity)
        for offset, event in enumerate(events):
            source_sequence = first_sequence + offset
            for order in open_orders:
                if order.accepted_source_sequence >= source_sequence:
                    continue
                if trade_source:
                    assert isinstance(event, ReplayTrade)
                    if order.reduce_only and (
                        position_quantity == 0
                        or not self._reduces_position(order, self._position)
                    ):
                        # Tape execution cancels an invalid reduce-only order
                        # as soon as it becomes eligible, even without a price
                        # trigger.
                        return offset
                    if self._trade_trigger(order, event) is not None:
                        return offset
                else:
                    assert isinstance(event, ReplayBar)
                    if self._trigger(order, event) is not None:
                        return offset
        return len(events)

    def apply_command(
        self,
        command_type: CommandType | InternalCommandType | str,
        values: Mapping[str, object],
        *,
        command_id: str,
        source_sequence: int,
        virtual_time_ms: int,
    ) -> Mapping[str, object]:
        if isinstance(command_type, (CommandType, InternalCommandType)):
            normalized = command_type
        else:
            try:
                normalized = CommandType(command_type)
            except ValueError:
                normalized = InternalCommandType(command_type)
        fills_before = len(self._fills)
        warnings_before = len(self._warnings)
        if normalized is InternalCommandType.ADJUST_CAPITAL:
            if set(values) != {"kind", "amount", "reason"}:
                raise ReplayDomainError(
                    ReplayErrorCode.INVALID_STATE_TRANSITION,
                    "capital adjustment payload is invalid",
                )
            del command_id
            return self.adjust_capital(
                kind=str(values["kind"]),
                amount=str(values["amount"]),
                source_sequence=source_sequence,
                event_time_ms=virtual_time_ms,
            ).to_dict()
        orders: tuple[ReplayOrder, ...]
        if normalized is CommandType.PLACE_ORDER:
            try:
                order_values = dict(values)
                order_values.pop("trade_plan", None)
                request = OrderRequest.from_mapping(order_values)
            except (TypeError, ValueError) as exc:
                raise ReplayDomainError(
                    ReplayErrorCode.ORDER_REJECTED,
                    "place_order payload violates the order contract",
                ) from exc
            order = self.place_order(
                request,
                command_id=command_id,
                accepted_source_sequence=source_sequence,
                created_time_ms=virtual_time_ms,
            )
            orders = (order,)
        elif normalized is CommandType.REPLACE_ORDER:
            if set(values) != {
                "order_id",
                "client_order_id",
                "quantity",
                "limit_price",
                "stop_price",
            }:
                raise ReplayDomainError(
                    ReplayErrorCode.ORDER_REJECTED,
                    "replace_order payload is invalid",
                )
            try:
                existing = self.order(str(values["order_id"]))
                request = OrderRequest(
                    client_order_id=str(values["client_order_id"]),
                    side=existing.side,
                    order_type=existing.order_type,
                    quantity=str(values["quantity"]),
                    reduce_only=existing.reduce_only,
                    limit_price=(
                        None
                        if values["limit_price"] is None
                        else str(values["limit_price"])
                    ),
                    stop_price=(
                        None
                        if values["stop_price"] is None
                        else str(values["stop_price"])
                    ),
                )
                orders = self.replace_order(
                    str(values["order_id"]),
                    request,
                    command_id=command_id,
                    accepted_source_sequence=source_sequence,
                    created_time_ms=virtual_time_ms,
                )
            except (TypeError, ValueError) as exc:
                raise ReplayDomainError(
                    ReplayErrorCode.ORDER_REJECTED,
                    "replace_order payload violates the order contract",
                ) from exc
        elif normalized is CommandType.CANCEL_ORDER:
            if set(values) != {"order_id"} or not isinstance(values["order_id"], str):
                raise ReplayDomainError(
                    ReplayErrorCode.ORDER_REJECTED,
                    "cancel_order payload is invalid",
                )
            order = self.cancel_order(
                values["order_id"],
                command_id=command_id,
                accepted_source_sequence=source_sequence,
                created_time_ms=virtual_time_ms,
            )
            orders = (order,)
        elif normalized is CommandType.CANCEL_ORDERS:
            if set(values) != {"scope", "order_ids"}:
                raise ReplayDomainError(
                    ReplayErrorCode.ORDER_REJECTED,
                    "cancel_orders payload is invalid",
                )
            raw_order_ids = values["order_ids"]
            if not isinstance(raw_order_ids, (list, tuple)):
                raise ReplayDomainError(
                    ReplayErrorCode.ORDER_REJECTED,
                    "cancel_orders order_ids are invalid",
                )
            orders = self.cancel_orders(
                scope=str(values["scope"]),
                order_ids=raw_order_ids,
                command_id=command_id,
                accepted_source_sequence=source_sequence,
                created_time_ms=virtual_time_ms,
            )
        elif normalized is CommandType.CLOSE_POSITION:
            if set(values) != {"quantity"}:
                raise ReplayDomainError(
                    ReplayErrorCode.ORDER_REJECTED,
                    "close_position payload is invalid",
                )
            quantity = values["quantity"]
            if quantity is not None and not isinstance(quantity, str):
                raise ReplayDomainError(
                    ReplayErrorCode.ORDER_REJECTED,
                    "close_position quantity must be a Decimal string or null",
                )
            try:
                order = self.close_position(
                    quantity,
                    command_id=command_id,
                    accepted_source_sequence=source_sequence,
                    created_time_ms=virtual_time_ms,
                )
                orders = (order,)
            except (TypeError, ValueError) as exc:
                raise ReplayDomainError(
                    ReplayErrorCode.ORDER_REJECTED,
                    "close_position quantity violates the order contract",
                ) from exc
        elif normalized is CommandType.EXECUTE_POSITION_INTENT:
            intent_values = dict(values)
            leverage_value = intent_values.pop("leverage", None)
            if set(intent_values) != {"intent", "side", "quantity"}:
                raise ReplayDomainError(
                    ReplayErrorCode.ORDER_REJECTED,
                    "execute_position_intent payload is invalid",
                )
            if leverage_value is not None and not isinstance(leverage_value, str):
                raise ReplayDomainError(
                    ReplayErrorCode.ORDER_REJECTED,
                    "execute_position_intent leverage must be a Decimal string or null",
                )
            try:
                orders = self.execute_position_intent(
                    intent=str(intent_values["intent"]),
                    side=(
                        None
                        if intent_values["side"] is None
                        else str(intent_values["side"])
                    ),
                    quantity=(
                        None
                        if intent_values["quantity"] is None
                        else str(intent_values["quantity"])
                    ),
                    command_id=command_id,
                    accepted_source_sequence=source_sequence,
                    created_time_ms=virtual_time_ms,
                    leverage=leverage_value,
                )
            except (TypeError, ValueError) as exc:
                raise ReplayDomainError(
                    ReplayErrorCode.ORDER_REJECTED,
                    "position intent violates the order contract",
                ) from exc
        elif normalized is CommandType.SET_POSITION_PROTECTION:
            if set(values) != {
                "quantity",
                "stop_loss_price",
                "take_profit_price",
            }:
                raise ReplayDomainError(
                    ReplayErrorCode.ORDER_REJECTED,
                    "set_position_protection payload is invalid",
                )
            try:
                orders = self.set_position_protection(
                    quantity=(
                        None
                        if values["quantity"] is None
                        else str(values["quantity"])
                    ),
                    stop_loss_price=(
                        None
                        if values["stop_loss_price"] is None
                        else str(values["stop_loss_price"])
                    ),
                    take_profit_price=(
                        None
                        if values["take_profit_price"] is None
                        else str(values["take_profit_price"])
                    ),
                    command_id=command_id,
                    accepted_source_sequence=source_sequence,
                    created_time_ms=virtual_time_ms,
                )
            except (TypeError, ValueError) as exc:
                raise ReplayDomainError(
                    ReplayErrorCode.ORDER_REJECTED,
                    "position protection violates the order contract",
                ) from exc
        else:
            raise ReplayDomainError(
                ReplayErrorCode.INVALID_STATE_TRANSITION,
                f"broker does not support command {normalized.value}",
            )
        # TOUCH_OR_TAPE_V2 can fill against the currently revealed reference
        # during the command itself. PAPER_LINEAR_V1 retains its historical
        # next-source-event behavior.
        return BrokerEventResult(
            bar_update=None,
            orders=orders,
            fills=tuple(self._fills[fills_before:]),
            warnings=tuple(self._warnings[warnings_before:]),
            position=self._position,
            account=self._account,
        ).to_dict()

    def end_session(
        self,
        *,
        open_order_disposition: str = "expire",
        position_disposition: str = "keep",
        virtual_time_ms: int = 0,
    ) -> BrokerEventResult:
        if self._ended:
            return BrokerEventResult(
                None,
                (),
                (),
                (),
                self._position,
                self._account,
            )
        if open_order_disposition not in {"expire", "cancel", "preserve"}:
            raise ReplayDomainError(
                ReplayErrorCode.INVALID_STATE_TRANSITION,
                "unsupported open order disposition",
            )
        if position_disposition not in {"keep", "mark_close"}:
            raise ReplayDomainError(
                ReplayErrorCode.INVALID_STATE_TRANSITION,
                "unsupported position disposition",
            )
        bar_update: Mapping[str, object] | None = None
        if isinstance(self._bar_builder, TradeReplayBarBuilder):
            finalized = self._bar_builder.finalize_bars(
                virtual_time_ms=virtual_time_ms,
            )
            if finalized:
                bar_update = finalized
        sequence = self._bar_builder.replay_events_applied
        working = self._working_state()
        if open_order_disposition != "preserve":
            status = (
                OrderStatus.EXPIRED
                if open_order_disposition == "expire"
                else OrderStatus.CANCELED
            )
            for order in self.open_orders:
                self._terminal_order(
                    working,
                    working.orders[order.order_id],
                    status,
                    reason="SESSION_ENDED",
                    source_sequence=sequence,
                    event_time_ms=virtual_time_ms,
                )
        session_close_client_id: str | None = None
        if (
            position_disposition == "mark_close"
            and Decimal(working.position.quantity) != 0
        ):
            quantity = decimal_to_string(
                abs(Decimal(working.position.quantity)),
                field_name="session close quantity",
            )
            side = (
                OrderSide.SELL
                if Decimal(working.position.quantity) > 0
                else OrderSide.BUY
            )
            order = ReplayOrder(
                order_id=f"ord-{self._next_order:010d}",
                client_order_id=f"session-close-{self._next_order:010d}",
                side=side,
                order_type=OrderType.MARKET,
                quantity=quantity,
                reduce_only=True,
                limit_price=None,
                stop_price=None,
                status=OrderStatus.OPEN,
                filled_quantity="0",
                remaining_quantity=quantity,
                average_fill_price=None,
                accepted_source_sequence=sequence,
                created_time_ms=virtual_time_ms,
                ordinal=self._next_order,
                reserved_margin="0",
                status_reason=None,
                status_history=(OrderStatus.NEW, OrderStatus.OPEN),
                model_version=self._model_version,
            )
            working.orders[order.order_id] = order
            working.changed_orders.append(order)
            session_close_client_id = order.client_order_id
            self._fill_working(
                working,
                order,
                source_sequence=sequence,
                event_time_ms=virtual_time_ms,
                trigger=(
                    working.position.mark_price,
                    LiquidityRole.SYNTHETIC,
                    FillReason.SESSION_END_MARK_CLOSE,
                ),
                synthetic=True,
                historical_execution=False,
                skip_trigger_risk=True,
            )
        ledger = working.ledger or self._ledger
        account = self._account_from(ledger, working.position)
        self._assert_candidate_invariants(working, ledger, account)
        self._commit_working(working, account=account)
        if session_close_client_id is not None:
            client_ids = set(self._client_order_ids)
            client_ids.add(session_close_client_id)
            self._client_order_ids = client_ids
            self._next_order += 1
        self._ended = True
        self._record_equity(account)
        return BrokerEventResult(
            bar_update,
            tuple(working.changed_orders),
            tuple(working.new_fills),
            tuple(working.new_warnings),
            self._position,
            self._account,
        )

    def finalize_session(
        self,
        *,
        open_order_disposition: str,
        position_disposition: str,
        virtual_time_ms: int,
    ) -> Mapping[str, object]:
        return self.end_session(
            open_order_disposition=open_order_disposition,
            position_disposition=position_disposition,
            virtual_time_ms=virtual_time_ms,
        ).to_dict()

    def build_report(self):
        return self.build_report_from_snapshot(self.snapshot())

    def build_report_from_snapshot(self, snapshot: Mapping[str, object]):
        from .report import build_broker_report

        state_hash = snapshot.get("state_hash")
        if not isinstance(state_hash, str):
            raise TypeError("broker report snapshot is missing state_hash")
        return build_broker_report(
            config_hash=self._config_hash,
            initial_equity=self.config.initial_equity,
            account=self._account,
            orders=self.orders,
            fills=self.fills,
            closed_trades=self.closed_trades,
            warnings=self.warnings,
            ledger_entries=self.ledger_entries,
            ledger_tail_hash=self._ledger.tail_hash,
            max_drawdown=self._max_drawdown,
            ended=self._ended,
            state_hash=state_hash,
            model_version=self._model_version,
        )

    def reset(self) -> None:
        self._bar_builder.reset()
        self._ledger = LedgerBook(
            initial_equity=self.config.initial_equity,
            currency=self.config.quote_asset,
            max_entries=self.config.limits.max_ledger_entries,
        )
        self._orders: dict[str, ReplayOrder] = {}
        self._client_order_ids: set[str] = set()
        self._fills: list[ReplayFill] = []
        self._closed_trades: list[ClosedTrade] = []
        self._warnings: list[BrokerWarning] = []
        self._position = Position.flat(mark_price=self.config.initial_mark_price)
        self._account = self._account_from(self._ledger, self._position)
        self._next_order = 1
        self._next_fill = 1
        self._next_trade = 1
        self._next_warning = 1
        self._has_trading_activity = False
        self._ended = False
        self._equity_peak = self.config.initial_equity
        self._max_drawdown = "0"
        self._assert_invariants()

    def has_trading_state(self) -> bool:
        return self._has_trading_activity

    def snapshot(self) -> dict[str, object]:
        payload = {
            "schema_version": BROKER_STATE_SCHEMA_VERSION,
            "model_version": self._model_version,
            "config_hash": self._config_hash,
            "bar_builder": self._bar_builder.snapshot(),
            "orders": [order.to_dict() for order in self.orders],
            "client_order_ids": sorted(self._client_order_ids),
            "fills": [fill.to_dict() for fill in self._fills],
            "closed_trades": [trade.to_dict() for trade in self._closed_trades],
            "warnings": [warning.to_dict() for warning in self._warnings],
            "ledger": self._ledger.snapshot(),
            "position": self._position.to_dict(),
            "account": self._account.to_dict(),
            "next_order": self._next_order,
            "next_fill": self._next_fill,
            "next_trade": self._next_trade,
            "next_warning": self._next_warning,
            "has_trading_activity": self._has_trading_activity,
            "ended": self._ended,
            "equity_peak": self._equity_peak,
            "max_drawdown": self._max_drawdown,
        }
        payload["state_hash"] = canonical_sha256(
            {
                "schema_version": BROKER_STATE_HASH_SCHEMA_VERSION,
                "state": payload,
            }
        )
        return payload

    def restore(self, state: Mapping[str, object]) -> None:
        old_builder = self._bar_builder.snapshot()
        old_model_version = self._model_version
        old_execution_mode = self._execution_mode
        try:
            payload = dict(state)
            state_hash = payload.pop("state_hash", None)
            if state_hash != canonical_sha256(
                {
                    "schema_version": BROKER_STATE_HASH_SCHEMA_VERSION,
                    "state": payload,
                }
            ):
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "broker state hash does not match",
                )
            exact_keys(
                payload,
                {
                    "schema_version",
                    "model_version",
                    "config_hash",
                    "bar_builder",
                    "orders",
                    "client_order_ids",
                    "fills",
                    "closed_trades",
                    "warnings",
                    "ledger",
                    "position",
                    "account",
                    "next_order",
                    "next_fill",
                    "next_trade",
                    "next_warning",
                    "has_trading_activity",
                    "ended",
                    "equity_peak",
                    "max_drawdown",
                },
            )
            checkpoint_model = payload["model_version"]
            compatible_models = (
                {
                    AGG_TRADE_TAPE_MODEL_VERSION: PAPER_LINEAR_EXECUTION_MODE,
                    AGG_TRADE_TOUCH_OR_TAPE_MODEL_VERSION: (
                        TOUCH_OR_TAPE_EXECUTION_MODE
                    ),
                }
                if isinstance(self._bar_builder, TradeReplayBarBuilder)
                else {
                    BROKER_MODEL_VERSION: PAPER_LINEAR_EXECUTION_MODE,
                    BAR_TOUCH_OR_TAPE_MODEL_VERSION: TOUCH_OR_TAPE_EXECUTION_MODE,
                }
            )
            restored_mode = compatible_models.get(checkpoint_model)
            if restored_mode is not None:
                self._model_version = str(checkpoint_model)
                self._execution_mode = restored_mode
            if (
                payload["schema_version"] != BROKER_STATE_SCHEMA_VERSION
                or payload["model_version"] != self._model_version
                or payload["config_hash"] != self._config_hash
            ):
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "broker checkpoint identity is incompatible",
                )

            collection_fields = (
                "orders",
                "client_order_ids",
                "fills",
                "closed_trades",
                "warnings",
            )
            for field_name in collection_fields:
                if not isinstance(payload[field_name], list):
                    raise TypeError(f"broker {field_name} must be a list")

            order_list = [
                ReplayOrder.from_dict(raw)
                for raw in payload["orders"]  # type: ignore[arg-type]
            ]
            orders = {order.order_id: order for order in order_list}
            if len(orders) != len(order_list):
                raise ValueError("broker checkpoint contains duplicate order ids")
            for ordinal, order in enumerate(order_list, start=1):
                if order.ordinal != ordinal or order.order_id != f"ord-{ordinal:010d}":
                    raise ValueError("broker order identifiers are not contiguous")
                if order.model_version != self._model_version:
                    raise ValueError("broker order model version is incompatible")
                if any(
                    not decimal_multiple(
                        Decimal(value),
                        Decimal(self.config.instrument.quantity_step),
                    )
                    for value in (
                        order.quantity,
                        order.filled_quantity,
                        order.remaining_quantity,
                    )
                ):
                    raise ValueError("broker order quantity is not instrument aligned")
                if any(
                    value is not None
                    and not decimal_multiple(
                        Decimal(value),
                        Decimal(self.config.instrument.price_tick),
                    )
                    for value in (order.limit_price, order.stop_price)
                ):
                    raise ValueError("broker order price is not instrument aligned")

            client_order_ids = [
                validate_identifier(value, field_name="client_order_id")
                for value in payload["client_order_ids"]  # type: ignore[union-attr]
            ]
            if len(set(client_order_ids)) != len(client_order_ids):
                raise ValueError(
                    "broker checkpoint contains duplicate client order ids"
                )
            if client_order_ids != sorted(client_order_ids):
                raise ValueError("broker client order id index is not canonical")
            if set(client_order_ids) != {order.client_order_id for order in order_list}:
                raise ValueError("broker client order id index drifted")

            fills = [
                ReplayFill.from_dict(raw)
                for raw in payload["fills"]  # type: ignore[arg-type]
            ]
            trades = [
                ClosedTrade.from_dict(raw)
                for raw in payload["closed_trades"]  # type: ignore[arg-type]
            ]
            warnings = [
                BrokerWarning.from_dict(raw)
                for raw in payload["warnings"]  # type: ignore[arg-type]
            ]
            for ordinal, fill in enumerate(fills, start=1):
                if fill.fill_id != f"fill-{ordinal:010d}":
                    raise ValueError("broker fill identifiers are not contiguous")
                if fill.model_version != self._model_version:
                    raise ValueError("broker fill model version is incompatible")
                order = orders.get(fill.order_id)
                causal = (
                    fill.source_sequence > order.accepted_source_sequence
                    if order
                    else False
                )
                if (
                    order is not None
                    and fill.synthetic
                    and fill.reason is FillReason.SESSION_END_MARK_CLOSE
                ):
                    causal = fill.source_sequence == order.accepted_source_sequence
                if (
                    order is not None
                    and self._execution_mode == TOUCH_OR_TAPE_EXECUTION_MODE
                    and fill.reason
                    in {
                        FillReason.MARKET_REVEALED_REFERENCE,
                        FillReason.LIMIT_MARKETABLE_REVEALED,
                        FillReason.STOP_REVEALED_TRIGGER,
                        FillReason.TAKE_PROFIT_REVEALED_TRIGGER,
                    }
                ):
                    causal = fill.source_sequence == order.accepted_source_sequence
                if order is None or not causal:
                    raise ValueError("broker fill violates order source causality")
                if fill.fee_asset != self.config.quote_asset:
                    raise ValueError("broker fill fee asset is incompatible")
                if not decimal_multiple(
                    Decimal(fill.quantity),
                    Decimal(self.config.instrument.quantity_step),
                ) or not decimal_multiple(
                    Decimal(fill.price),
                    Decimal(self.config.instrument.price_tick),
                ):
                    raise ValueError("broker fill is not instrument aligned")
                if not decimal_multiple(
                    Decimal(fill.fee),
                    Decimal(self.config.instrument.quote_step),
                ):
                    raise ValueError("broker fill fee is not quote aligned")
                if (fill.reason is FillReason.SESSION_END_MARK_CLOSE) != fill.synthetic:
                    raise ValueError("broker synthetic fill marker is inconsistent")
                if fill.historical_execution == fill.synthetic:
                    raise ValueError(
                        "broker historical execution marker is inconsistent"
                    )
            for ordinal, trade in enumerate(trades, start=1):
                if trade.trade_id != f"trade-{ordinal:010d}":
                    raise ValueError("broker trade identifiers are not contiguous")
                if trade.order_id not in orders or trade.fill_id not in {
                    fill.fill_id for fill in fills
                }:
                    raise ValueError("broker closed trade references missing execution")
            for ordinal, warning in enumerate(warnings, start=1):
                if warning.warning_id != f"warn-{ordinal:010d}":
                    raise ValueError("broker warning identifiers are not contiguous")
                if any(order_id not in orders for order_id in warning.order_ids):
                    raise ValueError("broker warning references a missing order")

            position = Position.from_dict(payload["position"])  # type: ignore[arg-type]
            ledger = LedgerBook(
                initial_equity=self.config.initial_equity,
                currency=self.config.quote_asset,
                max_entries=self.config.limits.max_ledger_entries,
            )
            ledger.restore(payload["ledger"])  # type: ignore[arg-type]
            account = self._account_from(ledger, position)
            if account.to_dict() != payload["account"]:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "broker account projection does not match ledger state",
                )

            self._bar_builder.restore(payload["bar_builder"])  # type: ignore[arg-type]
            revealed_sequence = self._bar_builder.replay_events_applied
            if any(
                order.accepted_source_sequence > revealed_sequence
                for order in order_list
            ) or any(fill.source_sequence > revealed_sequence for fill in fills):
                raise ValueError(
                    "broker execution is ahead of the revealed market cursor"
                )

            next_order = validate_counter(
                payload["next_order"], field_name="next_order"
            )
            next_fill = validate_counter(payload["next_fill"], field_name="next_fill")
            next_trade = validate_counter(
                payload["next_trade"], field_name="next_trade"
            )
            next_warning = validate_counter(
                payload["next_warning"],
                field_name="next_warning",
            )
            expected_counters = (
                (next_order, len(order_list) + 1, "next_order"),
                (next_fill, len(fills) + 1, "next_fill"),
                (next_trade, len(trades) + 1, "next_trade"),
                (next_warning, len(warnings) + 1, "next_warning"),
            )
            for actual, expected, field_name in expected_counters:
                if actual != expected:
                    raise ValueError(f"broker {field_name} is inconsistent")

            has_trading_activity = payload["has_trading_activity"]
            ended = payload["ended"]
            if not isinstance(has_trading_activity, bool) or not isinstance(
                ended, bool
            ):
                raise TypeError("broker state flags must be booleans")
            has_capital_activity = any(
                entry.kind in {LedgerKind.DEPOSIT, LedgerKind.WITHDRAW}
                for entry in ledger.entries
            )
            if has_trading_activity != bool(order_list or has_capital_activity):
                raise ValueError("broker trading activity flag is inconsistent")
            equity_peak = canonical_decimal(
                payload["equity_peak"],
                field_name="equity_peak",
                positive=True,
            )
            max_drawdown = canonical_decimal(
                payload["max_drawdown"],
                field_name="max_drawdown",
                nonnegative=True,
            )
            candidate = _WorkingState(
                orders=orders,
                ledger=ledger,
                position=position,
                fills=fills,
                closed_trades=trades,
                warnings=warnings,
                next_fill=int(payload["next_fill"]),
                next_trade=int(payload["next_trade"]),
                next_warning=int(payload["next_warning"]),
                changed_orders=[],
                new_fills=[],
                new_warnings=[],
            )
            self._assert_candidate_invariants(candidate, ledger, account)
        except ReplayDomainError:
            self._bar_builder.restore(old_builder)
            self._model_version = old_model_version
            self._execution_mode = old_execution_mode
            raise
        except (AssertionError, KeyError, TypeError, ValueError) as exc:
            self._bar_builder.restore(old_builder)
            self._model_version = old_model_version
            self._execution_mode = old_execution_mode
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "broker checkpoint domain state is invalid",
            ) from exc
        self._orders = orders
        self._client_order_ids = set(client_order_ids)
        self._fills = fills
        self._closed_trades = trades
        self._warnings = warnings
        self._ledger = ledger
        self._position = position
        self._account = account
        self._next_order = next_order
        self._next_fill = next_fill
        self._next_trade = next_trade
        self._next_warning = next_warning
        self._has_trading_activity = has_trading_activity
        self._ended = ended
        self._equity_peak = equity_peak
        self._max_drawdown = max_drawdown

    def _working_state(self) -> _WorkingState:
        return _WorkingState(
            orders=dict(self._orders),
            ledger=None,
            position=self._position,
            fills=list(self._fills),
            closed_trades=list(self._closed_trades),
            warnings=list(self._warnings),
            next_fill=self._next_fill,
            next_trade=self._next_trade,
            next_warning=self._next_warning,
            changed_orders=[],
            new_fills=[],
            new_warnings=[],
        )

    def _commit_working(
        self,
        working: _WorkingState,
        *,
        account: Account | None = None,
    ) -> None:
        ledger = working.ledger or self._ledger
        candidate_account = account or self._account_from(ledger, working.position)
        self._assert_candidate_invariants(working, ledger, candidate_account)
        self._orders = working.orders
        if working.ledger is not None:
            self._ledger = working.ledger
        self._position = working.position
        self._fills = working.fills
        self._closed_trades = working.closed_trades
        self._warnings = working.warnings
        self._next_fill = working.next_fill
        self._next_trade = working.next_trade
        self._next_warning = working.next_warning
        self._account = candidate_account

    def _fill_working(
        self,
        working: _WorkingState,
        order: ReplayOrder,
        *,
        source_sequence: int,
        event_time_ms: int,
        trigger: tuple[str, LiquidityRole, FillReason],
        synthetic: bool = False,
        historical_execution: bool = True,
        skip_trigger_risk: bool = False,
        max_fill_quantity: Decimal | None = None,
        allow_partial: bool = False,
        partial_status_reason: str | None = None,
    ) -> bool:
        price, liquidity, reason = trigger
        requested_quantity = Decimal(order.remaining_quantity)
        if order.reduce_only:
            fill_quantity = min(
                requested_quantity, abs(Decimal(working.position.quantity))
            )
        else:
            fill_quantity = requested_quantity
        if max_fill_quantity is not None:
            if max_fill_quantity <= 0:
                return False
            fill_quantity = min(fill_quantity, max_fill_quantity)
        if fill_quantity <= 0:
            self._terminal_order(
                working,
                order,
                OrderStatus.CANCELED,
                reason="REDUCE_ONLY_NO_POSITION",
                source_sequence=source_sequence,
                event_time_ms=event_time_ms,
            )
            return False
        quantity = decimal_to_string(fill_quantity, field_name="fill quantity")
        position_result = apply_position_fill(
            working.position,
            order.side,
            quantity,
            price,
            price,
        )
        if not order.reduce_only and not skip_trigger_risk:
            try:
                validate_trigger_position_notional(
                    config=self.config,
                    position=position_result.position,
                )
            except ReplayDomainError:
                rejection_status = (
                    OrderStatus.CANCELED
                    if order.status is OrderStatus.PARTIALLY_FILLED
                    else OrderStatus.REJECTED
                )
                self._terminal_order(
                    working,
                    order,
                    rejection_status,
                    reason="TRIGGER_RISK_REJECTED",
                    source_sequence=source_sequence,
                    event_time_ms=event_time_ms,
                )
                return False
        if len(working.fills) >= self.config.limits.max_fills:
            raise ReplayDomainError(
                ReplayErrorCode.SCAN_LIMIT_EXCEEDED,
                "broker fill capacity exceeded",
            )
        fill_id = f"fill-{working.next_fill:010d}"
        notional_decimal = Decimal(price) * fill_quantity
        notional = decimal_to_string(notional_decimal, field_name="fill notional")
        fee = fee_for_fill(
            notional=notional_decimal,
            maker=liquidity is LiquidityRole.MAKER,
            config=self.config,
        )
        fill = ReplayFill(
            fill_id=fill_id,
            order_id=order.order_id,
            side=order.side,
            quantity=quantity,
            price=price,
            notional=notional,
            fee=fee,
            fee_asset=self.config.quote_asset,
            liquidity=liquidity,
            reason=reason,
            source_sequence=source_sequence,
            event_time_ms=event_time_ms,
            synthetic=synthetic,
            historical_execution=historical_execution,
            model_version=self._model_version,
        )
        ledger = self._ledger_for_write(working)
        reserved_margin = Decimal(order.reserved_margin)
        released_margin = Decimal(0)
        if reserved_margin > 0:
            with localcontext() as context:
                context.prec = 60
                released_margin = (
                    reserved_margin
                    if fill_quantity == requested_quantity
                    else reserved_margin * fill_quantity / requested_quantity
                )
            released = decimal_to_string(
                released_margin,
                field_name="released margin",
            )
            ledger.post(
                kind=LedgerKind.RELEASE_MARGIN,
                source_sequence=source_sequence,
                event_time_ms=event_time_ms,
                postings=(
                    (LedgerAccount.AVAILABLE_MARGIN, released),
                    (LedgerAccount.RESERVED_MARGIN, f"-{released}"),
                ),
                order_id=order.order_id,
                fill_id=fill_id,
            )
        if Decimal(position_result.realized_pnl) != 0:
            realized = position_result.realized_pnl
            ledger.post(
                kind=LedgerKind.REALIZED_PNL,
                source_sequence=source_sequence,
                event_time_ms=event_time_ms,
                postings=(
                    (LedgerAccount.CASH, realized),
                    (LedgerAccount.REALIZED_PNL, self._negate(realized)),
                ),
                order_id=order.order_id,
                fill_id=fill_id,
            )
        if Decimal(fee) > 0:
            ledger.post(
                kind=LedgerKind.FEE,
                source_sequence=source_sequence,
                event_time_ms=event_time_ms,
                postings=(
                    (LedgerAccount.CASH, f"-{fee}"),
                    (LedgerAccount.FEE_EXPENSE, fee),
                ),
                order_id=order.order_id,
                fill_id=fill_id,
            )
        filled_total = Decimal(order.filled_quantity) + fill_quantity
        remaining = Decimal(order.quantity) - filled_total
        if remaining == 0:
            status = OrderStatus.FILLED
            status_reason = None
        elif allow_partial:
            status = OrderStatus.PARTIALLY_FILLED
            status_reason = partial_status_reason
        else:
            status = OrderStatus.CANCELED
            status_reason = "REDUCE_ONLY_CLAMPED"
        with localcontext() as context:
            context.prec = 60
            average_fill = (
                Decimal(price)
                if Decimal(order.filled_quantity) == 0
                else (
                    Decimal(order.average_fill_price or "0")
                    * Decimal(order.filled_quantity)
                    + Decimal(price) * fill_quantity
                )
                / filled_total
            )
            remaining_reservation = reserved_margin - released_margin
        updated_order = replace(
            order,
            status=status,
            filled_quantity=decimal_to_string(
                filled_total,
                field_name="filled quantity",
            ),
            remaining_quantity=decimal_to_string(
                remaining,
                field_name="remaining quantity",
            ),
            average_fill_price=decimal_to_string(
                average_fill,
                field_name="average fill price",
            ),
            reserved_margin=decimal_to_string(
                remaining_reservation,
                field_name="remaining reserved margin",
            ),
            status_reason=status_reason,
            status_history=order.status_history + (status,),
        )
        working.orders[order.order_id] = updated_order
        working.changed_orders.append(updated_order)
        working.fills.append(fill)
        working.new_fills.append(fill)
        working.next_fill += 1
        if Decimal(position_result.closed_quantity) > 0:
            assert position_result.closed_entry_price is not None
            trade = ClosedTrade(
                trade_id=f"trade-{working.next_trade:010d}",
                order_id=order.order_id,
                fill_id=fill_id,
                side=order.side,
                quantity=position_result.closed_quantity,
                entry_price=position_result.closed_entry_price,
                exit_price=price,
                realized_pnl=position_result.realized_pnl,
                source_sequence=source_sequence,
            )
            working.closed_trades.append(trade)
            working.next_trade += 1
        working.position = position_result.position
        return True

    def _terminal_order(
        self,
        working: _WorkingState,
        order: ReplayOrder,
        status: OrderStatus,
        *,
        reason: str,
        source_sequence: int,
        event_time_ms: int,
    ) -> ReplayOrder:
        if not status.terminal:
            raise ValueError("terminal order helper requires terminal status")
        ledger = self._ledger_for_write(working)
        if Decimal(order.reserved_margin) > 0:
            ledger.post(
                kind=LedgerKind.RELEASE_MARGIN,
                source_sequence=source_sequence,
                event_time_ms=event_time_ms,
                postings=(
                    (LedgerAccount.AVAILABLE_MARGIN, order.reserved_margin),
                    (LedgerAccount.RESERVED_MARGIN, f"-{order.reserved_margin}"),
                ),
                order_id=order.order_id,
            )
        updated = replace(
            order,
            status=status,
            reserved_margin="0",
            status_reason=reason,
            status_history=order.status_history + (status,),
        )
        working.orders[order.order_id] = updated
        working.changed_orders.append(updated)
        return updated

    def _trigger(
        self,
        order: ReplayOrder,
        bar: ReplayBar,
    ) -> tuple[str, LiquidityRole, FillReason] | None:
        open_price = Decimal(bar.open)
        high = Decimal(bar.high)
        low = Decimal(bar.low)
        if order.order_type is OrderType.MARKET:
            return (
                adverse_market_price(bar.open, order.side, self.config),
                LiquidityRole.TAKER,
                FillReason.MARKET_NEXT_OPEN,
            )
        if order.order_type is OrderType.LIMIT:
            assert order.limit_price is not None
            limit = Decimal(order.limit_price)
            touched = low <= limit if order.side is OrderSide.BUY else high >= limit
            if not touched:
                return None
            gapped = (
                open_price <= limit
                if order.side is OrderSide.BUY
                else open_price >= limit
            )
            return (
                order.limit_price,
                (
                    LiquidityRole.MAKER
                    if self._execution_mode == TOUCH_OR_TAPE_EXECUTION_MODE
                    else LiquidityRole.TAKER if gapped else LiquidityRole.MAKER
                ),
                FillReason.LIMIT_GAP if gapped else FillReason.LIMIT_TOUCH,
            )
        assert order.stop_price is not None
        stop = Decimal(order.stop_price)
        if order.order_type is OrderType.STOP_MARKET:
            touched = high >= stop if order.side is OrderSide.BUY else low <= stop
            reason = FillReason.STOP_TRIGGER
        else:
            touched = low <= stop if order.side is OrderSide.BUY else high >= stop
            reason = FillReason.TAKE_PROFIT_TRIGGER
        if not touched:
            return None
        conservative_reference = (
            max(open_price, stop)
            if order.side is OrderSide.BUY
            else min(open_price, stop)
        )
        return (
            adverse_market_price(
                decimal_to_string(
                    conservative_reference,
                    field_name="trigger reference",
                ),
                order.side,
                self.config,
            ),
            LiquidityRole.TAKER,
            reason,
        )

    def _revealed_reference_trigger(
        self,
        order: ReplayOrder,
    ) -> tuple[str, LiquidityRole, FillReason] | None:
        """Resolve only against state already revealed when the command arrives."""

        if self._execution_mode != TOUCH_OR_TAPE_EXECUTION_MODE:
            return None
        reference = Decimal(self._position.mark_price)
        if order.order_type is OrderType.MARKET:
            return (
                adverse_market_price(
                    self._position.mark_price,
                    order.side,
                    self.config,
                ),
                LiquidityRole.TAKER,
                FillReason.MARKET_REVEALED_REFERENCE,
            )
        if order.order_type is OrderType.LIMIT:
            assert order.limit_price is not None
            limit = Decimal(order.limit_price)
            marketable = (
                limit >= reference
                if order.side is OrderSide.BUY
                else limit <= reference
            )
            if not marketable:
                return None
            slipped = Decimal(
                adverse_market_price(
                    self._position.mark_price,
                    order.side,
                    self.config,
                )
            )
            bounded = (
                min(slipped, limit)
                if order.side is OrderSide.BUY
                else max(slipped, limit)
            )
            return (
                decimal_to_string(bounded, field_name="marketable limit fill"),
                LiquidityRole.TAKER,
                FillReason.LIMIT_MARKETABLE_REVEALED,
            )
        assert order.stop_price is not None
        stop = Decimal(order.stop_price)
        if order.order_type is OrderType.STOP_MARKET:
            triggered = (
                reference >= stop
                if order.side is OrderSide.BUY
                else reference <= stop
            )
            reason = FillReason.STOP_REVEALED_TRIGGER
        else:
            triggered = (
                reference <= stop
                if order.side is OrderSide.BUY
                else reference >= stop
            )
            reason = FillReason.TAKE_PROFIT_REVEALED_TRIGGER
        if not triggered:
            return None
        return (
            adverse_market_price(
                self._position.mark_price,
                order.side,
                self.config,
            ),
            LiquidityRole.TAKER,
            reason,
        )

    def _trade_trigger(
        self,
        order: ReplayOrder,
        trade: ReplayTrade,
    ) -> tuple[tuple[str, LiquidityRole, FillReason], str | None] | None:
        tape_price = Decimal(trade.price)
        if order.order_type is OrderType.MARKET:
            return (
                (
                    adverse_market_price(trade.price, order.side, self.config),
                    LiquidityRole.TAKER,
                    FillReason.MARKET_TAPE,
                ),
                None,
            )
        if order.order_type is OrderType.LIMIT:
            assert order.limit_price is not None
            limit = Decimal(order.limit_price)
            crossed = (
                tape_price < limit
                if order.side is OrderSide.BUY
                else tape_price > limit
            )
            if not crossed:
                return None
            return (
                (
                    order.limit_price,
                    LiquidityRole.MAKER,
                    FillReason.LIMIT_STRICT_CROSS,
                ),
                None,
            )

        assert order.stop_price is not None
        stop = Decimal(order.stop_price)
        already_triggered = order.status_reason == "TAPE_TRIGGERED"
        if order.order_type is OrderType.STOP_MARKET:
            touched = (
                tape_price >= stop
                if order.side is OrderSide.BUY
                else tape_price <= stop
            )
            reason = FillReason.STOP_TAPE_TRIGGER
        else:
            touched = (
                tape_price <= stop
                if order.side is OrderSide.BUY
                else tape_price >= stop
            )
            reason = FillReason.TAKE_PROFIT_TAPE_TRIGGER
        if not (already_triggered or touched):
            return None
        return (
            (
                adverse_market_price(trade.price, order.side, self.config),
                LiquidityRole.TAKER,
                reason,
            ),
            "TAPE_TRIGGERED",
        )

    @staticmethod
    def _tape_priority(order: ReplayOrder) -> int:
        return {
            OrderType.MARKET: 0,
            OrderType.STOP_MARKET: 1,
            OrderType.TAKE_PROFIT_MARKET: 1,
            OrderType.LIMIT: 2,
        }[order.order_type]

    @staticmethod
    def _reduce_priority(order: ReplayOrder) -> int:
        return {
            OrderType.MARKET: 0,
            OrderType.STOP_MARKET: 1,
            OrderType.LIMIT: 2,
            OrderType.TAKE_PROFIT_MARKET: 3,
        }[order.order_type]

    @staticmethod
    def _reduces_position(order: ReplayOrder, position: Position) -> bool:
        quantity = Decimal(position.quantity)
        return (quantity > 0 and order.side is OrderSide.SELL) or (
            quantity < 0 and order.side is OrderSide.BUY
        )

    def _cancel_orphan_reduce_orders(
        self,
        working: _WorkingState,
        *,
        source_sequence: int,
        event_time_ms: int,
    ) -> None:
        for order in sorted(working.orders.values(), key=lambda item: item.ordinal):
            if order.reduce_only and order.status in {
                OrderStatus.OPEN,
                OrderStatus.PARTIALLY_FILLED,
            }:
                self._terminal_order(
                    working,
                    order,
                    OrderStatus.CANCELED,
                    reason="REDUCE_ONLY_NO_POSITION",
                    source_sequence=source_sequence,
                    event_time_ms=event_time_ms,
                )

    def _warn(
        self,
        working: _WorkingState,
        code: WarningCode,
        source_sequence: int,
        order_ids: tuple[str, ...],
        message: str,
    ) -> None:
        if len(working.warnings) >= self.config.limits.max_warnings:
            raise ReplayDomainError(
                ReplayErrorCode.SCAN_LIMIT_EXCEEDED,
                "broker warning capacity exceeded",
            )
        warning = BrokerWarning(
            warning_id=f"warn-{working.next_warning:010d}",
            code=code,
            source_sequence=source_sequence,
            order_ids=order_ids,
            message=message,
        )
        working.warnings.append(warning)
        working.new_warnings.append(warning)
        working.next_warning += 1

    def _ledger_for_write(self, working: _WorkingState) -> LedgerBook:
        if working.ledger is None:
            working.ledger = self._ledger.clone()
        return working.ledger

    def _account_from(self, ledger: LedgerBook, position: Position) -> Account:
        realized = self._negate(ledger.account_total(LedgerAccount.REALIZED_PNL))
        fees = ledger.account_total(LedgerAccount.FEE_EXPENSE)
        reserved = ledger.account_total(LedgerAccount.RESERVED_MARGIN)
        return build_account(
            config=self.config,
            position=position,
            realized_pnl=realized,
            fees_paid=fees,
            reserved_margin=reserved,
            cash_balance=ledger.account_total(LedgerAccount.CASH),
        )

    def _resolve_command_sequence(self, value: int | None) -> int:
        actual = self._bar_builder.replay_events_applied
        if value is None:
            return actual
        if isinstance(value, bool) or not isinstance(value, int) or value != actual:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "broker command source sequence does not match revealed data",
            )
        return value

    def _assert_candidate_invariants(
        self,
        working: _WorkingState,
        ledger: LedgerBook,
        account: Account,
    ) -> None:
        LedgerBook.assert_entries_balanced(ledger.entries)
        if len(working.fills) > self.config.limits.max_fills:
            raise AssertionError("fill capacity invariant failed")
        if len(working.warnings) > self.config.limits.max_warnings:
            raise AssertionError("warning capacity invariant failed")
        if len(working.orders) > self.config.limits.max_orders:
            raise AssertionError("order capacity invariant failed")
        with localcontext() as context:
            context.prec = 60
            reserved_orders = sum(
                (
                    Decimal(order.reserved_margin)
                    for order in working.orders.values()
                    if order.status in {OrderStatus.OPEN, OrderStatus.PARTIALLY_FILLED}
                ),
                Decimal(0),
            )
            expected_cash = Decimal(ledger.account_total(LedgerAccount.CASH))
        if reserved_orders != Decimal(account.reserved_margin):
            raise AssertionError("reserved margin does not match open orders")
        if Decimal(account.cash_balance) != expected_cash:
            raise AssertionError("cash balance does not reconcile")
        if Decimal(working.position.quantity) == 0:
            if working.position.entry_price is not None:
                raise AssertionError("flat position retained an entry price")
        elif working.position.entry_price is None:
            raise AssertionError("open position lacks an entry price")

    def _assert_invariants(self) -> None:
        working = self._working_state()
        self._assert_candidate_invariants(working, self._ledger, self._account)
        if set(self._client_order_ids) != {
            order.client_order_id for order in self._orders.values()
        }:
            raise AssertionError("client order id index drifted")

    def _record_equity(self, account: Account) -> None:
        with localcontext() as context:
            context.prec = 60
            equity = Decimal(account.equity)
            peak = max(Decimal(self._equity_peak), equity)
            drawdown = peak - equity
        self._equity_peak = decimal_to_string(peak, field_name="equity peak")
        self._max_drawdown = decimal_to_string(
            max(Decimal(self._max_drawdown), drawdown),
            field_name="max drawdown",
        )

    @staticmethod
    def _negate(value: str) -> str:
        with localcontext() as context:
            context.prec = 60
            negated = Decimal(0) - Decimal(value)
        return decimal_to_string(negated, field_name="negated amount")
