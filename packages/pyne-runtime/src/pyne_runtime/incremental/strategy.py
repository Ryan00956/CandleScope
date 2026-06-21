"""Incremental strategy namespace and scalar replay helpers."""
from __future__ import annotations

import math
from typing import TYPE_CHECKING, Any, Callable

from ..strategy.constants import (
    StrategyCommission,
    StrategyDirection,
    StrategyIntrabarPath,
    StrategyOca,
    StrategyRiskMode,
    StrategySameBarPriority,
)
from ..strategy.costs import (
    _commission_amount,
    _is_exposure_reduction,
    _margin_required,
    _normalize_commission_type,
)
from ..strategy.ledger import _trade_float, _trade_open_profit
from ..strategy.orders import (
    _exit_trigger,
    _normalize_intrabar_path,
    _normalize_oca_type,
    _normalize_same_bar_fill_priority,
    _pending_trigger,
)
from ..strategy.risk import (
    _entry_qty_for_max_position_size,
    _entry_rejection_reason,
    _intraday_filled_orders_hit,
    _max_drawdown_hit,
    _normalize_allowed_entry_direction,
    _normalize_risk_mode,
)

if TYPE_CHECKING:
    from .context import IncrementalContext


IncrementalStrategyDirection = StrategyDirection
IncrementalStrategyCommission = StrategyCommission
IncrementalStrategyRiskMode = StrategyRiskMode


class IncrementalStrategyRiskNamespace:
    all = IncrementalStrategyDirection.all
    both = IncrementalStrategyDirection.both
    long = IncrementalStrategyDirection.long
    short = IncrementalStrategyDirection.short
    none = IncrementalStrategyDirection.none
    percent_of_equity = IncrementalStrategyRiskMode.percent_of_equity
    cash = IncrementalStrategyRiskMode.cash

    def __init__(self, strategy: "IncrementalStrategyNamespace") -> None:
        self._strategy = strategy

    def allow_entry_in(self, direction: str = IncrementalStrategyDirection.all) -> None:
        self._strategy._allow_entry_in = _normalize_allowed_entry_direction(direction)

    def max_drawdown(
        self,
        value: float,
        type: str = IncrementalStrategyRiskMode.percent_of_equity,
    ) -> None:
        self._strategy._max_drawdown_value = max(float(value), 0.0)
        self._strategy._max_drawdown_type = _normalize_risk_mode(type)

    def max_intraday_loss(
        self,
        value: float,
        type: str = IncrementalStrategyRiskMode.percent_of_equity,
    ) -> None:
        self._strategy._max_intraday_loss_value = max(float(value), 0.0)
        self._strategy._max_intraday_loss_type = _normalize_risk_mode(type)

    def max_position_size(self, contracts: float) -> None:
        self._strategy._max_position_size = max(float(contracts), 0.0)

    def max_intraday_filled_orders(self, count: int) -> None:
        self._strategy._max_intraday_filled_orders = max(int(count), 0)


class IncrementalStrategyTradesNamespace:
    """Scalar trade-ledger accessor namespace for incremental callbacks."""

    def __init__(self, strategy: "IncrementalStrategyNamespace", kind: str) -> None:
        self._strategy = strategy
        self._kind = kind

    @property
    def count(self) -> int:
        return len(self._trades())

    def __int__(self) -> int:
        return self.count

    def __float__(self) -> float:
        return float(self.count)

    def __bool__(self) -> bool:
        return self.count > 0

    def size(self, trade_num: int = -1) -> float:
        return self.qty(trade_num)

    def qty(self, trade_num: int = -1) -> float:
        return _trade_float(self._trade(trade_num), "qty")

    def profit(self, trade_num: int = -1) -> float:
        trade = self._trade(trade_num)
        if self._kind == "opentrades" and trade:
            return _round8(_trade_open_profit(trade, self._strategy._current_price()))
        return _trade_float(trade, "profit")

    def profit_percent(self, trade_num: int = -1) -> float:
        trade = self._trade(trade_num)
        profit = self.profit(trade_num) if self._kind == "opentrades" and trade else None
        return _trade_profit_percent(trade, profit=profit)

    def net_profit(self, trade_num: int = -1) -> float:
        trade = self._trade(trade_num)
        if self._kind == "opentrades" and trade:
            profit = _trade_open_profit(trade, self._strategy._current_price())
            return _round8(profit - float(trade.get("commission", 0.0)))
        return _trade_float(trade, "net_profit")

    def commission(self, trade_num: int = -1) -> float:
        return _trade_float(self._trade(trade_num), "commission")

    def entry_price(self, trade_num: int = -1) -> float:
        return _trade_float(self._trade(trade_num), "entry_price")

    def exit_price(self, trade_num: int = -1) -> float:
        return _trade_float(self._trade(trade_num), "exit_price")

    def entry_time(self, trade_num: int = -1) -> float:
        return _trade_float(self._trade(trade_num), "entry_time")

    def exit_time(self, trade_num: int = -1) -> float:
        return _trade_float(self._trade(trade_num), "exit_time")

    def entry_id(self, trade_num: int = -1) -> str:
        return str(self._trade(trade_num).get("entry_id", ""))

    def exit_id(self, trade_num: int = -1) -> str:
        return str(self._trade(trade_num).get("exit_id", ""))

    def entry_comment(self, trade_num: int = -1) -> str:
        return str(self._trade(trade_num).get("entry_comment", ""))

    def exit_comment(self, trade_num: int = -1) -> str:
        return str(self._trade(trade_num).get("exit_comment", ""))

    def side(self, trade_num: int = -1) -> str:
        return str(self._trade(trade_num).get("side", ""))

    def _trades(self) -> list[dict[str, Any]]:
        if self._kind == "closedtrades":
            return self._strategy._closed_trades
        return self._strategy._open_trades

    def _trade(self, trade_num: int) -> dict[str, Any]:
        trades = self._trades()
        if not trades:
            return {"_empty_ledger": True} if int(trade_num) in {-1, 0} else {}
        index = int(trade_num)
        if index < 0:
            index = len(trades) + index
        if index < 0 or index >= len(trades):
            return {}
        return trades[index]


class IncrementalStrategyNamespace:
    """Pine-like strategy helper for one-bar-at-a-time callbacks."""

    long = "long"
    short = "short"
    commission = IncrementalStrategyCommission
    direction = IncrementalStrategyDirection
    percent_of_equity = IncrementalStrategyRiskMode.percent_of_equity
    cash = IncrementalStrategyRiskMode.cash
    oca = StrategyOca
    same_bar = StrategySameBarPriority
    intrabar = StrategyIntrabarPath

    def __init__(self, context: "IncrementalContext") -> None:
        self._context = context
        self._initial_capital = 100000.0
        self._currency = ""
        self._orders: list[dict[str, Any]] = []
        self._pending_orders: list[dict[str, Any]] = []
        self._pending_exit_orders: list[dict[str, Any]] = []
        self._open_trades: list[dict[str, Any]] = []
        self._closed_trades: list[dict[str, Any]] = []
        self._closedtrades_namespace = IncrementalStrategyTradesNamespace(self, "closedtrades")
        self._opentrades_namespace = IncrementalStrategyTradesNamespace(self, "opentrades")
        self._grossprofit = 0.0
        self._grossloss = 0.0
        self._commission = 0.0
        self._commission_type: str | None = None
        self._commission_value = 0.0
        self._slippage_ticks = 0
        self._event_seq = 0
        self._touched = False
        self._pyramiding = 0
        self._same_direction_entry_count = 0
        self._allow_entry_in = IncrementalStrategyDirection.all
        self._max_drawdown_value: float | None = None
        self._max_drawdown_type = IncrementalStrategyRiskMode.percent_of_equity
        self._max_intraday_loss_value: float | None = None
        self._max_intraday_loss_type = IncrementalStrategyRiskMode.percent_of_equity
        self._max_position_size: float | None = None
        self._max_intraday_filled_orders: int | None = None
        self._risk_locked = False
        self._drawdown_locked = False
        self._intraday_locked = False
        self._filled_orders_locked = False
        self._risk_liquidating = False
        self._peak_equity = self._initial_capital
        self._intraday_peak_equity = self._initial_capital
        self._intraday_filled_orders = 0
        self.risk = IncrementalStrategyRiskNamespace(self)
        self._mintick = max(float(getattr(context.syminfo, "mintick", 0.0)), 0.0)
        self._backtest_fill_limits_assumption = 0
        self._same_bar_fill_priority = self.same_bar.stop_first
        self._intrabar_path = self.intrabar.same_bar_priority
        self._margin_long = 0.0
        self._margin_short = 0.0

    def configure(self, **kwargs: Any) -> None:
        if "pyramiding" in kwargs:
            self._pyramiding = max(int(kwargs["pyramiding"]), 0)
        if "initial_capital" in kwargs:
            self._initial_capital = float(kwargs["initial_capital"])
            self._peak_equity = self._initial_capital
            self._intraday_peak_equity = self._initial_capital
        if "currency" in kwargs:
            self._currency = str(kwargs["currency"] or "")
        if "slippage" in kwargs:
            self._slippage_ticks = max(int(kwargs["slippage"]), 0)
        if "commission_type" in kwargs:
            self._commission_type = _normalize_commission_type(str(kwargs["commission_type"]))
        if "commission_value" in kwargs:
            self._commission_value = max(float(kwargs["commission_value"]), 0.0)
        if "mintick" in kwargs or "min_tick" in kwargs:
            self._mintick = max(float(kwargs.get("mintick", kwargs.get("min_tick", 0.0))), 0.0)
        if "backtest_fill_limits_assumption" in kwargs:
            self._backtest_fill_limits_assumption = max(
                int(kwargs["backtest_fill_limits_assumption"]),
                0,
            )
        if "same_bar_fill_priority" in kwargs:
            self._same_bar_fill_priority = _normalize_same_bar_fill_priority(
                str(kwargs["same_bar_fill_priority"])
            )
        if "intrabar_path" in kwargs:
            self._intrabar_path = _normalize_intrabar_path(str(kwargs["intrabar_path"]))
        if "margin_long" in kwargs:
            self._margin_long = max(float(kwargs["margin_long"]), 0.0)
        if "margin_short" in kwargs:
            self._margin_short = max(float(kwargs["margin_short"]), 0.0)

    @property
    def touched(self) -> bool:
        return self._touched

    @property
    def position_size(self) -> float:
        self._sync_risk_liquidation()
        return self._raw_position_size()

    @property
    def position_avg_price(self) -> float | None:
        size = abs(self.position_size)
        if size <= 0:
            return None
        weighted = sum(
            abs(float(trade["qty"])) * float(trade["entry_price"])
            for trade in self._open_trades
        )
        return _round8(weighted / size)

    @property
    def grossprofit(self) -> float:
        return _round8(self._grossprofit)

    @property
    def grossloss(self) -> float:
        return _round8(self._grossloss)

    @property
    def netprofit(self) -> float:
        self._sync_risk_liquidation()
        return _round8(self._grossprofit + self._grossloss - self._commission)

    @property
    def openprofit(self) -> float:
        self._sync_risk_liquidation()
        return _round8(
            sum(_trade_open_profit(trade, self._current_price()) for trade in self._open_trades)
        )

    @property
    def equity(self) -> float:
        self._sync_risk_liquidation()
        return _round8(self._initial_capital + self.netprofit + self.openprofit)

    @property
    def closedtrades(self) -> IncrementalStrategyTradesNamespace:
        return self._closedtrades_namespace

    @property
    def opentrades(self) -> IncrementalStrategyTradesNamespace:
        return self._opentrades_namespace

    def begin_bar(self) -> None:
        if getattr(self._context.session, "isfirstbar", False):
            self._intraday_locked = False
            self._intraday_filled_orders = 0
            self._filled_orders_locked = _intraday_filled_orders_hit(
                filled_orders=self._intraday_filled_orders,
                threshold=self._max_intraday_filled_orders,
            )
            self._intraday_peak_equity = self.equity
            self._sync_risk_locked()
        if self._pending_orders:
            still_pending = []
            for order in self._pending_orders:
                if not self._try_fill_pending_order(order):
                    still_pending.append(order)
            self._pending_orders = still_pending
        still_pending_exits = []
        for order in self._pending_exit_orders:
            if not self._try_fill_pending_exit_order(order):
                still_pending_exits.append(order)
        self._pending_exit_orders = still_pending_exits

    def end_bar(self) -> None:
        self._sync_risk_liquidation()
        equity = self.equity
        self._peak_equity = max(self._peak_equity, equity)
        self._intraday_peak_equity = max(self._intraday_peak_equity, equity)
        if self._max_drawdown_value is not None and _max_drawdown_hit(
            equity=equity,
            peak_equity=self._peak_equity,
            threshold=self._max_drawdown_value,
            risk_type=self._max_drawdown_type,
        ):
            self._drawdown_locked = True
        if self._max_intraday_loss_value is not None and _max_drawdown_hit(
            equity=equity,
            peak_equity=self._intraday_peak_equity,
            threshold=self._max_intraday_loss_value,
            risk_type=self._max_intraday_loss_type,
        ):
            self._intraday_locked = True
        self._sync_risk_locked()

    def entry(
        self,
        id: str,
        direction: str = long,
        *,
        qty: float = 1.0,
        price: float | None = None,
        limit: float | None = None,
        stop: float | None = None,
        oca_name: str = "",
        oca_type: str | None = None,
        when: bool = True,
        comment: str = "",
    ) -> None:
        self._submit_position_order(
            "entry",
            id,
            direction,
            qty=qty,
            price=price,
            limit=limit,
            stop=stop,
            oca_name=oca_name,
            oca_type=oca_type,
            when=when,
            comment=comment,
        )

    def order(
        self,
        id: str,
        direction: str = long,
        *,
        qty: float = 1.0,
        price: float | None = None,
        limit: float | None = None,
        stop: float | None = None,
        oca_name: str = "",
        oca_type: str | None = None,
        when: bool = True,
        comment: str = "",
    ) -> None:
        self._submit_position_order(
            "order",
            id,
            direction,
            qty=qty,
            price=price,
            limit=limit,
            stop=stop,
            oca_name=oca_name,
            oca_type=oca_type,
            when=when,
            comment=comment,
        )

    def _submit_position_order(
        self,
        order_type: str,
        id: str,
        direction: str,
        *,
        qty: float,
        price: float | None,
        limit: float | None,
        stop: float | None,
        oca_name: str,
        oca_type: str | None,
        when: bool,
        comment: str,
    ) -> None:
        if not when:
            return
        qty_abs = abs(float(qty))
        if qty_abs <= 0:
            return
        side = self._normalize_direction(direction)
        base_price = self._price_or_current(price)
        order = {
            "time": self._current_time(),
            "id": str(id),
            "type": order_type,
            "side": side,
            "qty": _round8(qty_abs),
            "price": _round8(base_price),
            "position_after": self.position_size,
            "comment": comment,
            "_seq": self._next_seq(),
            "_base_price": float(base_price),
            "_limit": _optional_float(limit),
            "_stop": _optional_float(stop),
            "_submit_time": self._current_time(),
            "_requested_fill_qty": qty_abs,
            "_oca_name": str(oca_name or ""),
            "_oca_type": _normalize_oca_type(oca_type),
        }
        self._orders.append(order)
        self._touched = True
        if self._risk_locked:
            self._reject_order(order, reason="risk_locked")
            return
        if limit is not None or stop is not None:
            order["_pending_submission"] = True
            order["_active"] = False
            if not self._try_fill_pending_order(order):
                self._pending_orders.append(order)
            return
        if order_type == "entry":
            rejection_reason = _entry_rejection_reason(
                side=side,
                previous_size=self.position_size,
                same_direction_entry_count=self._same_direction_entry_count,
                pyramiding=self._pyramiding,
                allow_entry_in=self._allow_entry_in,
            )
            if rejection_reason is not None:
                self._reject_order(order, reason=rejection_reason)
                return
            requested_qty = qty_abs
            qty_abs = _entry_qty_for_max_position_size(
                side=side,
                previous_size=self.position_size,
                requested_qty=requested_qty,
                max_position_size=self._max_position_size,
            )
            order["_requested_fill_qty"] = _round8(requested_qty)
            if qty_abs <= 0:
                self._reject_order(order, reason="max_position_size")
                return
            order["qty"] = _round8(qty_abs)
            order["_requested_fill_qty"] = _round8(requested_qty)
        next_size = self._position_after_fill(
            order_type=order_type,
            side=side,
            qty=qty_abs,
            previous_size=self.position_size,
        )
        if not self._margin_allows_position(
            previous_size=self.position_size,
            next_size=next_size,
            price=self._fill_price(base_price, "buy" if side == self.long else "sell"),
            equity=self.equity,
        ):
            self._reject_order(order, reason="margin")
            return
        self._fill_entry_order(order, fill_price=base_price, reason=None)

    def _fill_entry_order(
        self,
        order: dict[str, Any],
        *,
        fill_price: float,
        reason: str | None,
    ) -> None:
        side = self._normalize_direction(str(order.get("side", self.long)))
        fill_side = "buy" if side == self.long else "sell"
        fill_price = self._fill_price(fill_price, fill_side)
        previous_size = self.position_size
        qty_abs = abs(float(order.get("qty", 0.0)))
        signed_qty = qty_abs if side == self.long else -qty_abs
        if order.get("type") == "entry":
            next_size = (
                signed_qty
                if previous_size == 0 or (previous_size > 0) != (signed_qty > 0)
                else previous_size + signed_qty
            )
            transaction_qty = abs(next_size - previous_size)
            close_qty = (
                abs(previous_size)
                if previous_size and (previous_size > 0) != (signed_qty > 0)
                else 0.0
            )
            open_qty = qty_abs
        else:
            next_size = previous_size + signed_qty
            transaction_qty = qty_abs
            close_qty = (
                min(abs(previous_size), qty_abs)
                if previous_size and (previous_size > 0) != (signed_qty > 0)
                else 0.0
            )
            open_qty = max(qty_abs - close_qty, 0.0)
        commission_qty = transaction_qty if order.get("type") == "entry" else qty_abs
        commission = self._apply_commission(order, qty=commission_qty, price=fill_price)
        used_commission = 0.0
        if close_qty > 0:
            _, used_commission = self._close_lots(
                id="",
                exit_id=str(order.get("id", "")),
                exit_comment=str(order.get("comment", "")),
                target_qty=close_qty,
                fill_price=fill_price,
                order_commission=commission,
                order_fill_qty=transaction_qty,
            )
        remaining_commission = max(commission - used_commission, 0.0)
        if open_qty > 0 and next_size != 0:
            open_side = self.long if next_size > 0 else self.short
            open_trade = {
                "entry_id": str(order.get("id", "")),
                "entry_time": self._current_time(),
                "side": open_side,
                "qty": _round8(open_qty),
                "entry_price": _round8(fill_price),
            }
            if order.get("comment"):
                open_trade["entry_comment"] = str(order.get("comment", ""))
            if remaining_commission > 0:
                open_trade["commission"] = _round8(remaining_commission)
            self._open_trades.append(open_trade)
        order["time"] = self._current_time()
        order["price"] = _round8(fill_price)
        order["position_after"] = self.position_size
        order["_active"] = True
        order["_filled_qty"] = qty_abs
        if order.get("type") == "entry" and abs(transaction_qty - qty_abs) > 1e-9:
            order["_transaction_qty"] = _round8(transaction_qty)
        if order.get("_oca_name"):
            order["oca_name"] = order.get("_oca_name")
            order["oca_type"] = order.get("_oca_type") or self.oca.none
        if reason is not None:
            order["reason"] = reason
        self._apply_oca_after_fill(order)
        next_size = self.position_size
        if order.get("type") == "entry":
            if previous_size == 0 or (previous_size > 0) != (next_size > 0):
                self._same_direction_entry_count = 1
            else:
                self._same_direction_entry_count += 1
        elif order.get("type") == "order":
            if next_size == 0:
                self._same_direction_entry_count = 0
            elif previous_size == 0 or (previous_size > 0) != (next_size > 0):
                self._same_direction_entry_count = 1
        if order.get("type") in {"entry", "order"}:
            self._intraday_filled_orders += 1
            if _intraday_filled_orders_hit(
                filled_orders=self._intraday_filled_orders,
                threshold=self._max_intraday_filled_orders,
            ):
                self._filled_orders_locked = True
                self._sync_risk_locked()

    def _try_fill_pending_order(self, order: dict[str, Any]) -> bool:
        if order.get("_active"):
            return True
        if order.get("_canceled"):
            return True
        if self._risk_locked and order.get("type") in {"entry", "order"}:
            return False
        bar = self._context.current_bar
        if bar is None:
            return False
        trigger = _pending_trigger(
            side=self._normalize_direction(str(order.get("side", self.long))),
            open_price=float(bar.open),
            high=float(bar.high),
            low=float(bar.low),
            limit=order.get("_limit"),
            stop=order.get("_stop"),
            tick_verify=self._limit_fill_verification_amount(),
            same_bar_fill_priority=self._same_bar_fill_priority,
            intrabar_path=self._intrabar_path,
        )
        if trigger is None:
            return False
        reason, fill_price = trigger
        order["reason"] = reason
        if order.get("type") == "entry":
            side = self._normalize_direction(str(order.get("side", self.long)))
            rejection_reason = _entry_rejection_reason(
                side=side,
                previous_size=self.position_size,
                same_direction_entry_count=self._same_direction_entry_count,
                pyramiding=self._pyramiding,
                allow_entry_in=self._allow_entry_in,
            )
            if rejection_reason is not None:
                self._reject_order(order, reason=rejection_reason)
                return True
            requested_qty = float(order.get("_requested_fill_qty", order.get("qty", 0.0)))
            qty_abs = _entry_qty_for_max_position_size(
                side=side,
                previous_size=self.position_size,
                requested_qty=requested_qty,
                max_position_size=self._max_position_size,
            )
            order["_requested_fill_qty"] = _round8(requested_qty)
            if qty_abs <= 0:
                self._reject_order(order, reason="max_position_size")
                return True
            order["qty"] = _round8(qty_abs)
        else:
            side = self._normalize_direction(str(order.get("side", self.long)))
            qty_abs = abs(float(order.get("qty", 0.0)))
        next_size = self._position_after_fill(
            order_type=str(order.get("type", "")),
            side=side,
            qty=qty_abs,
            previous_size=self.position_size,
        )
        fill_side = "buy" if side == self.long else "sell"
        margin_fill_price = self._fill_price(fill_price, fill_side)
        if not self._margin_allows_position(
            previous_size=self.position_size,
            next_size=next_size,
            price=margin_fill_price,
            equity=self.equity,
        ):
            return False
        self._fill_entry_order(order, fill_price=fill_price, reason=reason)
        return True

    def close(
        self,
        id: str = "",
        *,
        qty: float | None = None,
        qty_percent: float | None = None,
        price: float | None = None,
        when: bool = True,
        comment: str = "",
    ) -> None:
        if not when or not self._open_trades:
            return
        base_price = self._price_or_current(price)
        target_qty = self._target_open_qty(str(id))
        requested_qty = _requested_exit_qty(target_qty=target_qty, qty=qty, qty_percent=qty_percent)
        fill_qty = min(target_qty, abs(self.position_size), requested_qty)
        if fill_qty <= 0:
            return
        fill_side = "sell" if self.position_size > 0 else "buy"
        fill_price = self._fill_price(base_price, fill_side)
        order_commission = self._commission_amount(qty=fill_qty, price=fill_price)
        if order_commission > 0:
            self._commission += order_commission
        closed_qty, _ = self._close_lots(
            id=str(id),
            exit_id=str(id),
            exit_comment=str(comment),
            target_qty=fill_qty,
            fill_price=fill_price,
            order_commission=order_commission,
            order_fill_qty=fill_qty,
        )
        if abs(closed_qty) <= 0:
            return
        self._touched = True
        order = {
            "time": self._current_time(),
            "id": str(id),
            "type": "close",
            "side": "flat",
            "qty": _round8(abs(closed_qty)),
            "price": _round8(fill_price),
            "position_after": self.position_size,
            "comment": comment,
            "_seq": self._next_seq(),
            "_target_qty": _round8(target_qty),
            "_requested_fill_qty": _round8(requested_qty),
            "_filled_qty": _round8(abs(closed_qty)),
        }
        if order_commission > 0:
            order["commission"] = _round8(order_commission)
        self._orders.append(order)

    def close_all(
        self,
        *,
        price: float | None = None,
        when: bool = True,
        comment: str = "",
    ) -> None:
        if not when or not self._open_trades:
            return
        self.close("", qty=abs(self.position_size), price=price, when=True, comment=comment)
        if self._orders:
            self._orders[-1]["type"] = "close_all"
            self._orders[-1]["id"] = "close_all"
            self._orders[-1]["_target_qty"] = self._orders[-1]["qty"]
            self._orders[-1]["_requested_fill_qty"] = self._orders[-1]["qty"]
            self._orders[-1]["_filled_qty"] = self._orders[-1]["qty"]
            for trade in self._closed_trades:
                if trade.get("exit_id") == "" and trade.get("exit_time") == self._current_time():
                    trade["exit_id"] = "close_all"

    def exit(
        self,
        id: str,
        *,
        from_entry: str = "",
        qty: float | None = None,
        qty_percent: float | None = None,
        stop: float | None = None,
        limit: float | None = None,
        when: bool = True,
        comment: str = "",
    ) -> None:
        if not when or (stop is None and limit is None):
            return
        self._touched = True
        pending = self._upsert_pending_exit_order({
            "id": str(id),
            "from_entry": str(from_entry),
            "type": "exit",
            "side": "flat",
            "qty": 0.0,
            "price": self._current_price(),
            "position_after": 0.0,
            "comment": comment,
            "_limit": _optional_float(limit),
            "_stop": _optional_float(stop),
            "_requested_qty": _optional_float(qty),
            "_qty_percent": _optional_float(qty_percent),
            "_submit_time": self._current_time(),
        })
        if self._try_fill_pending_exit_order(pending):
            self._pending_exit_orders = [
                order
                for order in self._pending_exit_orders
                if not (
                    order.get("id") == pending.get("id")
                    and order.get("from_entry") == pending.get("from_entry")
                )
            ]

    def cancel(self, id: str, *, when: bool = True, comment: str = "") -> None:
        if not when:
            return
        canceled = self._cancel_pending(
            lambda order: str(order.get("id", "")) == str(id),
            canceled_by=str(id),
        )
        if canceled <= 0:
            return
        self._touched = True
        self._orders.append({
            "time": self._current_time(),
            "id": str(id),
            "type": "cancel",
            "side": "flat",
            "qty": 0.0,
            "price": None,
            "position_after": self.position_size,
            "comment": comment,
            "canceled": canceled,
            "_seq": self._next_seq(),
            "_submit_time": self._current_time(),
        })

    def cancel_all(self, *, when: bool = True, comment: str = "") -> None:
        if not when:
            return
        canceled = self._cancel_pending(lambda order: True, canceled_by="cancel_all")
        if canceled <= 0:
            return
        self._touched = True
        self._orders.append({
            "time": self._current_time(),
            "id": "cancel_all",
            "type": "cancel_all",
            "side": "flat",
            "qty": 0.0,
            "price": None,
            "position_after": self.position_size,
            "comment": comment,
            "canceled": canceled,
            "_seq": self._next_seq(),
            "_submit_time": self._current_time(),
        })

    def to_report(self) -> dict[str, Any]:
        final_size = self.position_size
        final_avg = self.position_avg_price
        return {
            "orders": [
                {key: value for key, value in order.items() if not str(key).startswith("_")}
                for order in sorted(
                    self._orders,
                    key=lambda item: (item.get("time", 0), item.get("_seq", 0)),
                )
                if order.get("_active", True)
            ],
            "position": {
                "size": final_size,
                "side": "long" if final_size > 0 else "short" if final_size < 0 else "flat",
                "avg_price": final_avg,
            },
            "summary": {
                "initial_capital": _round8(self._initial_capital),
                "currency": self._currency,
                "equity": self.equity,
                "netprofit": self.netprofit,
                "openprofit": self.openprofit,
                "grossprofit": self.grossprofit,
                "grossloss": self.grossloss,
                "commission": _round8(self._commission),
                "backtest_fill_limits_assumption": self._backtest_fill_limits_assumption,
                "same_bar_fill_priority": self._same_bar_fill_priority,
                "intrabar_path": self._intrabar_path,
                "margin_long": _round8(self._margin_long),
                "margin_short": _round8(self._margin_short),
            },
            "risk": {
                "locked": self._risk_locked,
                "max_drawdown": (
                    _round8(self._max_drawdown_value)
                    if self._max_drawdown_value is not None
                    else None
                ),
                "max_drawdown_type": self._max_drawdown_type,
                "max_intraday_loss": (
                    _round8(self._max_intraday_loss_value)
                    if self._max_intraday_loss_value is not None
                    else None
                ),
                "max_intraday_loss_type": self._max_intraday_loss_type,
                "max_position_size": (
                    _round8(self._max_position_size)
                    if self._max_position_size is not None
                    else None
                ),
                "max_intraday_filled_orders": self._max_intraday_filled_orders,
            },
            "closedtrades": list(self._closed_trades),
            "opentrades": [
                {**trade, "profit": _round8(_trade_open_profit(trade, self._current_price()))}
                for trade in self._open_trades
            ],
            "lifecycle": _incremental_strategy_lifecycle_events(self._orders),
        }

    def _requested_close_qty(self, *, qty: float | None, qty_percent: float | None) -> float:
        position_qty = abs(self.position_size)
        if qty is not None:
            return min(position_qty, abs(float(qty)))
        if qty_percent is not None:
            return min(position_qty, position_qty * max(float(qty_percent), 0.0) / 100.0)
        return position_qty

    def _target_open_qty(self, from_entry: str) -> float:
        return _round8(sum(
            abs(float(trade.get("qty", 0.0)))
            for trade in self._open_trades
            if not from_entry or str(trade.get("entry_id", "")) == from_entry
        ))

    def _cancel_pending(
        self,
        predicate: Callable[[dict[str, Any]], bool],
        *,
        canceled_by: str,
    ) -> int:
        canceled = 0
        still_pending = []
        for order in self._pending_orders:
            if predicate(order):
                order["_canceled"] = True
                order["_canceled_time"] = self._current_time()
                order["_canceled_by"] = canceled_by
                canceled += 1
            else:
                still_pending.append(order)
        self._pending_orders = still_pending
        return canceled

    def _upsert_pending_exit_order(self, next_order: dict[str, Any]) -> dict[str, Any]:
        for order in self._pending_exit_orders:
            if (
                order.get("id") == next_order.get("id")
                and order.get("from_entry") == next_order.get("from_entry")
            ):
                order.update(next_order)
                return order
        next_order["_seq"] = self._next_seq()
        self._pending_exit_orders.append(next_order)
        return next_order

    def _try_fill_pending_exit_order(self, order: dict[str, Any]) -> bool:
        if not self._open_trades:
            return False
        current_position = self.position_size
        if current_position == 0:
            return False
        bar = self._context.current_bar
        if bar is None:
            return False
        trigger = _exit_trigger(
            current_position=current_position,
            open_price=float(bar.open),
            high=float(bar.high),
            low=float(bar.low),
            stop=order.get("_stop"),
            limit=order.get("_limit"),
            tick_verify=self._limit_fill_verification_amount(),
            same_bar_fill_priority=self._same_bar_fill_priority,
            intrabar_path=self._intrabar_path,
        )
        if trigger is None:
            return False
        reason, event_price = trigger
        target_qty = self._target_open_qty(str(order.get("from_entry", "")))
        requested_qty = _requested_exit_qty(
            target_qty=target_qty,
            qty=order.get("_requested_qty"),
            qty_percent=order.get("_qty_percent"),
        )
        fill_qty = min(target_qty, abs(current_position), requested_qty)
        if fill_qty <= 0:
            return False
        fill_side = "sell" if current_position > 0 else "buy"
        fill_price = self._fill_price(event_price, fill_side)
        order_commission = self._commission_amount(qty=fill_qty, price=fill_price)
        if order_commission > 0:
            self._commission += order_commission
        closed_qty, _ = self._close_lots(
            id=str(order.get("from_entry", "")),
            exit_id=str(order.get("id", "")),
            exit_comment=str(order.get("comment", "")),
            target_qty=fill_qty,
            fill_price=fill_price,
            order_commission=order_commission,
            order_fill_qty=fill_qty,
        )
        if abs(closed_qty) <= 0:
            return False
        public_order = {
            "time": self._current_time(),
            "id": str(order.get("id", "")),
            "from_entry": str(order.get("from_entry", "")),
            "type": "exit",
            "side": "flat",
            "qty": _round8(abs(closed_qty)),
            "price": _round8(fill_price),
            "position_after": self.position_size,
            "reason": reason,
            "comment": str(order.get("comment", "")),
            "_base_price": float(fill_price),
            "_target_qty": _round8(target_qty),
            "_requested_fill_qty": _round8(requested_qty),
            "_filled_qty": _round8(abs(closed_qty)),
            "_requested_qty": order.get("_requested_qty"),
            "_qty_percent": order.get("_qty_percent"),
            "_seq": order.get("_seq", self._next_seq()),
            "_submit_time": self._current_time(),
        }
        if order_commission > 0:
            public_order["commission"] = _round8(order_commission)
        self._orders.append(public_order)
        return True

    def _reject_order(self, order: dict[str, Any], *, reason: str) -> None:
        order["_active"] = False
        order["position_after"] = 0.0
        order["_rejected_reason"] = reason
        order["_rejected_time"] = self._current_time()
        order.setdefault(
            "_requested_fill_qty",
            float(order.get("_requested_fill_qty", order.get("qty", 0.0))),
        )
        order["_filled_qty"] = 0.0

    def _sync_risk_locked(self) -> None:
        self._risk_locked = (
            self._drawdown_locked or self._intraday_locked or self._filled_orders_locked
        )

    def _raw_position_size(self) -> float:
        return _round8(sum(_signed_trade_qty(trade) for trade in self._open_trades))

    def _sync_risk_liquidation(self) -> None:
        if self._risk_liquidating:
            return
        self._risk_liquidating = True
        try:
            risk_liquidation = self._risk_liquidation_reason()
            if risk_liquidation is None:
                return
            self._intraday_locked = True
            self._cancel_pending(lambda order: True, canceled_by=risk_liquidation)
            self._pending_exit_orders = []
            self._force_close_for_risk(risk_liquidation)
            self._sync_risk_locked()
        finally:
            self._risk_liquidating = False

    def _risk_liquidation_reason(self) -> str | None:
        position_size = self._raw_position_size()
        if position_size == 0 or self._context.current_bar is None:
            return None
        risk_price = (
            float(self._context.current_bar.low)
            if position_size > 0
            else float(self._context.current_bar.high)
        )
        equity = _round8(
            self._initial_capital
            + self._grossprofit
            + self._grossloss
            - self._commission
            + sum(_trade_open_profit(trade, risk_price) for trade in self._open_trades)
        )
        if self._max_intraday_loss_value is not None and _max_drawdown_hit(
            equity=equity,
            peak_equity=self._intraday_peak_equity,
            threshold=self._max_intraday_loss_value,
            risk_type=self._max_intraday_loss_type,
        ):
            return "risk.max_intraday_loss"
        return None

    def _force_close_for_risk(self, reason: str) -> None:
        if not self._open_trades or self._context.current_bar is None:
            return
        current_size = self._raw_position_size()
        fill_qty = abs(current_size)
        fill_side = "sell" if current_size > 0 else "buy"
        risk_price = (
            float(self._context.current_bar.low)
            if current_size > 0
            else float(self._context.current_bar.high)
        )
        fill_price = self._fill_price(risk_price, fill_side)
        order_commission = self._commission_amount(qty=fill_qty, price=fill_price)
        if order_commission > 0:
            self._commission += order_commission
        closed_qty, _ = self._close_lots(
            id="",
            exit_id=reason,
            exit_comment="",
            target_qty=fill_qty,
            fill_price=fill_price,
            order_commission=order_commission,
            order_fill_qty=fill_qty,
        )
        if abs(closed_qty) <= 0:
            return
        order = {
            "time": self._current_time(),
            "id": reason,
            "type": "close_all",
            "side": "flat",
            "qty": _round8(abs(closed_qty)),
            "price": _round8(fill_price),
            "position_after": self._raw_position_size(),
            "comment": "",
            "_seq": self._next_seq(),
            "_target_qty": _round8(fill_qty),
            "_requested_fill_qty": _round8(fill_qty),
            "_filled_qty": _round8(abs(closed_qty)),
            "_risk_liquidation": True,
        }
        if order_commission > 0:
            order["commission"] = _round8(order_commission)
        self._orders.append(order)

    def _position_after_fill(
        self,
        *,
        order_type: str,
        side: str,
        qty: float,
        previous_size: float,
    ) -> float:
        signed_qty = abs(float(qty)) if side == self.long else -abs(float(qty))
        if order_type == "entry" and (
            previous_size == 0 or (previous_size > 0) != (signed_qty > 0)
        ):
            return _round8(signed_qty)
        return _round8(previous_size + signed_qty)

    def _margin_allows_position(
        self,
        *,
        previous_size: float,
        next_size: float,
        price: float,
        equity: float,
    ) -> bool:
        if next_size == 0:
            return True
        if _is_exposure_reduction(previous_size, next_size):
            return True
        margin_percent = self._margin_long if next_size > 0 else self._margin_short
        required = _margin_required(
            position_size=next_size,
            price=price,
            margin_percent=margin_percent,
            pointvalue=float(getattr(self._context.syminfo, "pointvalue", 1.0)),
        )
        return required <= max(float(equity), 0.0)

    def _apply_oca_after_fill(self, filled_order: dict[str, Any]) -> None:
        oca_name = str(filled_order.get("_oca_name") or "")
        oca_type = str(filled_order.get("_oca_type") or self.oca.none)
        if not oca_name or oca_type == self.oca.none:
            return
        filled_qty = abs(float(filled_order.get("qty", 0.0)))
        for order in self._pending_orders:
            if order is filled_order:
                continue
            if order.get("_oca_name") != oca_name or order.get("_oca_type") != oca_type:
                continue
            if oca_type == self.oca.cancel:
                order["_canceled"] = True
                order["_canceled_time"] = self._current_time()
                order["_canceled_by"] = filled_order.get("id")
            elif oca_type == self.oca.reduce:
                remaining = max(float(order.get("qty", 0.0)) - filled_qty, 0.0)
                order["qty"] = _round8(remaining)
                if remaining <= 0:
                    order["_canceled"] = True
                    order["_canceled_time"] = self._current_time()
                    order["_canceled_by"] = filled_order.get("id")

    def _close_lots(
        self,
        *,
        id: str,
        exit_id: str,
        exit_comment: str,
        target_qty: float,
        fill_price: float,
        order_commission: float = 0.0,
        order_fill_qty: float | None = None,
    ) -> tuple[float, float]:
        remaining = abs(float(target_qty))
        closed_signed_qty = 0.0
        used_order_commission = 0.0
        fill_qty_total = max(
            float(order_fill_qty if order_fill_qty is not None else target_qty),
            1e-12,
        )
        kept: list[dict[str, Any]] = []
        for trade in self._open_trades:
            matches_id = not id or str(trade.get("entry_id", "")) == id
            if not matches_id or remaining <= 0:
                kept.append(trade)
                continue
            trade_qty = abs(float(trade["qty"]))
            closing_qty = min(trade_qty, remaining)
            remaining -= closing_qty
            side = str(trade["side"])
            profit = _realized_profit(
                side=side,
                qty=closing_qty,
                entry_price=float(trade["entry_price"]),
                exit_price=fill_price,
            )
            entry_commission = float(trade.get("commission", 0.0))
            reported_profit = profit
            if entry_commission > 0 and closing_qty < trade_qty:
                reported_profit -= entry_commission
            entry_commission_share = entry_commission * closing_qty / max(trade_qty, 1e-12)
            exit_commission_share = float(order_commission) * closing_qty / fill_qty_total
            used_order_commission += exit_commission_share
            if profit >= 0:
                self._grossprofit += profit
            else:
                self._grossloss += profit
            closed_trade = {
                "entry_id": trade.get("entry_id", ""),
                "exit_id": exit_id,
                "side": side,
                "qty": _round8(closing_qty),
                "entry_price": trade.get("entry_price"),
                "exit_price": _round8(fill_price),
                "entry_time": trade.get("entry_time"),
                "exit_time": self._current_time(),
                "profit": _round8(reported_profit),
                "commission": _round8(entry_commission_share + exit_commission_share),
                "net_profit": _round8(
                    reported_profit - entry_commission_share - exit_commission_share
                ),
            }
            if trade.get("entry_comment"):
                closed_trade["entry_comment"] = str(trade.get("entry_comment", ""))
            if exit_comment:
                closed_trade["exit_comment"] = str(exit_comment)
            self._closed_trades.append(closed_trade)
            closed_signed_qty += closing_qty if side == self.long else -closing_qty
            leftover_qty = trade_qty - closing_qty
            if leftover_qty > 1e-9:
                kept_trade = {**trade, "qty": _round8(leftover_qty)}
                remaining_entry_commission = entry_commission - entry_commission_share
                if remaining_entry_commission > 0:
                    kept_trade["commission"] = _round8(remaining_entry_commission)
                else:
                    kept_trade.pop("commission", None)
                kept.append(kept_trade)
        self._open_trades = kept
        if self.position_size == 0:
            self._same_direction_entry_count = 0
        return _round8(closed_signed_qty), _round8(used_order_commission)

    def _normalize_direction(self, direction: str) -> str:
        normalized = str(direction or "").lower()
        if normalized in {self.short, "strategy.short", "-1"}:
            return self.short
        return self.long

    def _price_or_current(self, price: float | None) -> float:
        return float(self._current_price() if price is None else price)

    def _current_price(self) -> float:
        if self._context.current_bar is None:
            return math.nan
        return float(self._context.current_bar.close)

    def _current_time(self) -> int:
        if self._context.current_bar is None:
            return 0
        return int(self._context.current_bar.time)

    def _next_seq(self) -> int:
        self._event_seq += 1
        return self._event_seq

    def _fill_price(self, price: float, side: str) -> float:
        slippage = self._slippage_ticks * self._mintick
        if side == "buy":
            return float(price) + slippage
        return float(price) - slippage

    def _commission_amount(self, *, qty: float, price: float) -> float:
        return _commission_amount(
            commission_type=self._commission_type,
            commission_value=self._commission_value,
            qty=qty,
            price=price,
        )

    def _apply_commission(self, order: dict[str, Any], *, qty: float, price: float) -> float:
        commission = self._commission_amount(qty=qty, price=price)
        if commission > 0:
            order["commission"] = _round8(commission)
            self._commission += commission
        return commission

    def _limit_fill_verification_amount(self) -> float:
        return self._backtest_fill_limits_assumption * self._mintick

def _round8(value: float) -> float:
    return round(float(value), 8)

def _signed_trade_qty(trade: dict[str, Any]) -> float:
    qty = abs(float(trade.get("qty", 0.0)))
    return qty if trade.get("side") == IncrementalStrategyNamespace.long else -qty

def _realized_profit(*, side: str, qty: float, entry_price: float, exit_price: float) -> float:
    if side == IncrementalStrategyNamespace.long:
        return (float(exit_price) - float(entry_price)) * abs(float(qty))
    return (float(entry_price) - float(exit_price)) * abs(float(qty))

def _trade_profit_percent(trade: dict[str, Any], *, profit: float | None = None) -> float:
    if trade.get("_empty_ledger"):
        return 0.0
    qty = abs(_trade_float(trade, "qty"))
    entry_price = abs(_trade_float(trade, "entry_price"))
    denominator = qty * entry_price
    if math.isnan(denominator) or denominator <= 0:
        return math.nan
    trade_profit = _trade_float(trade, "profit") if profit is None else float(profit)
    if math.isnan(trade_profit):
        return math.nan
    return _round8(trade_profit / denominator * 100.0)

def _requested_exit_qty(
    *,
    target_qty: float,
    qty: float | None,
    qty_percent: float | None,
) -> float:
    target = max(float(target_qty), 0.0)
    if qty is not None:
        return max(float(qty), 0.0)
    if qty_percent is not None:
        return target * max(float(qty_percent), 0.0) / 100.0
    return target

def _optional_float(value: Any) -> float | None:
    if value is None:
        return None
    return float(value)

def _incremental_strategy_lifecycle_events(orders: list[dict[str, Any]]) -> list[dict[str, Any]]:
    events = []
    for order in sorted(
        orders,
        key=lambda item: (item.get("_submit_time", item.get("time", 0)), item.get("_seq", 0)),
    ):
        order_type = str(order.get("type", ""))
        pending = bool(order.get("_pending_submission"))
        active = bool(order.get("_active", True))
        canceled = bool(order.get("_canceled")) or order_type in {"cancel", "cancel_all"}
        rejected = bool(order.get("_rejected_reason"))
        if canceled:
            status = "canceled"
            phase = "pending_canceled" if pending else "cancel"
        elif rejected:
            status = "rejected"
            phase = "pending_rejected" if pending else "rejected"
        elif active:
            status = "filled"
            phase = (
                "pending_fill"
                if pending
                else "exit_fill"
                if order_type == "exit"
                else "close_fill"
                if order_type == "close"
                else "close_all_fill"
                if order_type == "close_all"
                else "market_fill"
            )
        elif pending:
            status = "pending"
            phase = "pending"
        else:
            status = "submitted"
            phase = order_type
        event: dict[str, Any] = {
            "id": order.get("id"),
            "from_entry": order.get("from_entry"),
            "type": order_type,
            "status": status,
            "phase": phase,
            "submitted_time": order.get("_submit_time", order.get("time")),
            "filled_time": order.get("time") if active and not canceled else None,
            "canceled_time": order.get("_canceled_time", order.get("time")) if canceled else None,
            "rejected_time": order.get("_rejected_time") if rejected else None,
            "side": order.get("side"),
            "qty": order.get("qty"),
            "price": order.get("price"),
            "position_after": order.get("position_after"),
        }
        if order.get("reason") is not None:
            event["reason"] = order.get("reason")
        if order.get("comment") is not None:
            event["comment"] = order.get("comment")
        if order.get("commission") is not None:
            event["commission"] = order.get("commission")
        if order.get("oca_name") is not None:
            event["oca_name"] = order.get("oca_name")
        if order.get("oca_type") is not None:
            event["oca_type"] = order.get("oca_type")
        if order.get("_limit") is not None:
            event["limit"] = order.get("_limit")
        if order.get("_stop") is not None:
            event["stop"] = order.get("_stop")
        if order.get("_requested_fill_qty") is not None and (
            active or rejected or (pending and order.get("reason"))
        ):
            event["requested_qty"] = _round8(float(order.get("_requested_fill_qty", 0.0)))
        if order.get("_filled_qty") is not None and (active or rejected):
            event["filled_qty"] = _round8(float(order.get("_filled_qty", 0.0)))
        if order.get("_target_qty") is not None:
            event["target_qty"] = _round8(float(order.get("_target_qty", 0.0)))
        if order.get("_qty_percent") is not None:
            event["qty_percent"] = _round8(float(order.get("_qty_percent", 0.0)))
        if order.get("_transaction_qty") is not None:
            event["transaction_qty"] = _round8(float(order.get("_transaction_qty", 0.0)))
        if order.get("_canceled_by") is not None:
            event["canceled_by"] = order.get("_canceled_by")
        if order.get("_rejected_reason") is not None:
            event["rejected_reason"] = order.get("_rejected_reason")
        if order.get("canceled") is not None:
            event["canceled"] = order.get("canceled")
        returnable = {
            key: value
            for key, value in event.items()
            if value is not None
            or key in {"price", "filled_time", "canceled_time", "rejected_time"}
        }
        events.append(returnable)
    return events
