"""BAR and aggregate-trade tape execution with one atomic replay reducer."""

from __future__ import annotations

from dataclasses import dataclass, replace
from decimal import Decimal, localcontext
from typing import Mapping

from ..bars.builder import ReplayBarBuilder
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
    build_account,
    decimal_multiple,
    fee_for_fill,
    mark_position,
    validate_order_risk,
    validate_trigger_position_notional,
)


BROKER_STATE_SCHEMA_VERSION = "replay-conservative-broker-state.v1"
BROKER_STATE_HASH_SCHEMA_VERSION = "replay-conservative-broker-hash.v1"


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

    def order(self, order_id: str) -> ReplayOrder:
        order = self._orders.get(order_id)
        if order is None:
            raise ReplayDomainError(
                ReplayErrorCode.ORDER_REJECTED,
                "order does not exist",
                details={"order_id": order_id},
            )
        return order

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
            self._fill_working(
                working,
                order,
                source_sequence=sequence,
                event_time_ms=event_time_ms,
                trigger=immediate,
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
        if normalized is CommandType.PLACE_ORDER:
            try:
                request = OrderRequest.from_mapping(values)
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
            except (TypeError, ValueError) as exc:
                raise ReplayDomainError(
                    ReplayErrorCode.ORDER_REJECTED,
                    "close_position quantity violates the order contract",
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
            orders=(order,),
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
        from .report import build_broker_report

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
            state_hash=self.state_hash,
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
