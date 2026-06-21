"""Pine-like strategy event helpers."""
from __future__ import annotations

from typing import Any

import numpy as np

from ..context import PyneContext
from ..plot import OutputCollector
from ..series import PyneSeries
from ..values import is_na_value
from .constants import (
    StrategyCommission,
    StrategyDirection,
    StrategyIntrabarPath,
    StrategyOca,
    StrategyRiskMode,
    StrategySameBarPriority,
)
from .costs import (
    _commission_amount,
    _is_exposure_reduction,
    _margin_required,
    _normalize_commission_type,
)
from .ledger import StrategyTradesNamespace, _trade_open_profit
from .orders import (
    _exit_trigger,
    _normalize_intrabar_path,
    _normalize_oca_type,
    _normalize_same_bar_fill_priority,
    _strategy_lifecycle_events,
)
from .risk import StrategyRiskNamespace
from .replay import (
    _condition_values,
    _normalize_direction,
    _optional_numeric_values,
    _optional_price_values,
    _price_values,
    _requested_close_qty,
    replay_strategy_orders,
)


class StrategyModule:
    """Lightweight Pine-like ``strategy`` namespace.

    This module emits deterministic strategy events and maintains a simple
    position timeline. It is not a broker simulator.
    """

    long = "long"
    short = "short"
    commission = StrategyCommission
    oca = StrategyOca
    direction = StrategyDirection
    same_bar = StrategySameBarPriority
    intrabar = StrategyIntrabarPath
    percent_of_equity = StrategyRiskMode.percent_of_equity
    cash = StrategyRiskMode.cash

    def __init__(self, context: PyneContext, collector: OutputCollector) -> None:
        self._context = context
        self._collector = collector
        self._position_size = np.zeros(context.bar_count, dtype=np.float64)
        self._position_avg_price = np.full(context.bar_count, np.nan, dtype=np.float64)
        self._equity = np.zeros(context.bar_count, dtype=np.float64)
        self._netprofit = np.zeros(context.bar_count, dtype=np.float64)
        self._openprofit = np.zeros(context.bar_count, dtype=np.float64)
        self._grossprofit = np.zeros(context.bar_count, dtype=np.float64)
        self._grossloss = np.zeros(context.bar_count, dtype=np.float64)
        self._closedtrades_count = np.zeros(context.bar_count, dtype=np.float64)
        self._opentrades_count = np.zeros(context.bar_count, dtype=np.float64)
        self._closed_trades: list[dict[str, Any]] = []
        self._open_trades: list[dict[str, Any]] = []
        self._closed_trades_by_bar: list[list[dict[str, Any]]] = []
        self._open_trades_by_bar: list[list[dict[str, Any]]] = []
        self._closedtrades_namespace = StrategyTradesNamespace(self, "closedtrades")
        self._opentrades_namespace = StrategyTradesNamespace(self, "opentrades")
        self._touched = False
        self._event_seq = 0
        self._pyramiding = 0
        self._allow_entry_in = StrategyDirection.all
        self._max_drawdown_value: float | None = None
        self._max_drawdown_type = StrategyRiskMode.percent_of_equity
        self._max_intraday_loss_value: float | None = None
        self._max_intraday_loss_type = StrategyRiskMode.percent_of_equity
        self._max_position_size: float | None = None
        self._max_intraday_filled_orders: int | None = None
        self._risk_locked = False
        self.risk = StrategyRiskNamespace(self)
        self._initial_capital = 100000.0
        self._currency = str(context.syminfo.currency or "")
        self._slippage_ticks = 0
        self._mintick = max(float(context.syminfo.mintick), 0.0)
        self._commission_type: str | None = None
        self._commission_value = 0.0
        self._backtest_fill_limits_assumption = 0
        self._process_orders_on_close = False
        self._same_bar_fill_priority = StrategySameBarPriority.stop_first
        self._intrabar_path = StrategyIntrabarPath.same_bar_priority
        self._margin_long = 0.0
        self._margin_short = 0.0

    def __call__(self, title: str = "", overlay: bool = True, **kwargs: Any) -> None:
        """Declare strategy metadata and Pine-like replay settings."""
        config = {
            key: kwargs.get(key)
            for key in (
                "pyramiding",
                "slippage",
                "mintick",
                "min_tick",
                "commission_type",
                "commission_value",
                "initial_capital",
                "currency",
                "backtest_fill_limits_assumption",
                "process_orders_on_close",
                "same_bar_fill_priority",
                "intrabar_path",
                "margin_long",
                "margin_short",
            )
            if key in kwargs
        }
        self.configure(**config)
        self._collector.set_indicator_meta(
            title=title,
            overlay=overlay,
            script_type="strategy",
            **kwargs,
        )

    def configure(
        self,
        *,
        pyramiding: int | None = None,
        slippage: int | None = None,
        mintick: float | None = None,
        min_tick: float | None = None,
        commission_type: str | None = None,
        commission_value: float | None = None,
        initial_capital: float | None = None,
        currency: str | None = None,
        backtest_fill_limits_assumption: int | None = None,
        process_orders_on_close: bool | None = None,
        same_bar_fill_priority: str | None = None,
        intrabar_path: str | None = None,
        margin_long: float | None = None,
        margin_short: float | None = None,
    ) -> None:
        """Configure lightweight strategy replay options.

        ``pyramiding`` follows Pine's mental model: ``0`` allows the first
        same-direction entry and blocks additional same-direction entries.
        Positive values allow that many additional same-direction entries.
        """
        if pyramiding is not None:
            self._pyramiding = max(int(pyramiding), 0)
        if slippage is not None:
            self._slippage_ticks = max(int(slippage), 0)
        tick_value = mintick if mintick is not None else min_tick
        if tick_value is not None:
            self._mintick = max(float(tick_value), 0.0)
        if commission_type is not None:
            self._commission_type = _normalize_commission_type(commission_type)
        if commission_value is not None:
            self._commission_value = max(float(commission_value), 0.0)
        if initial_capital is not None:
            self._initial_capital = max(float(initial_capital), 0.0)
        if currency is not None:
            self._currency = str(currency)
        if backtest_fill_limits_assumption is not None:
            self._backtest_fill_limits_assumption = max(
                int(backtest_fill_limits_assumption),
                0,
            )
        if process_orders_on_close is not None:
            self._process_orders_on_close = bool(process_orders_on_close)
        if same_bar_fill_priority is not None:
            self._same_bar_fill_priority = _normalize_same_bar_fill_priority(
                same_bar_fill_priority
            )
        if intrabar_path is not None:
            self._intrabar_path = _normalize_intrabar_path(intrabar_path)
        if margin_long is not None:
            self._margin_long = max(float(margin_long), 0.0)
        if margin_short is not None:
            self._margin_short = max(float(margin_short), 0.0)

    @property
    def position_size(self) -> PyneSeries:
        return PyneSeries(self._position_size.copy(), name="strategy.position_size")

    @property
    def position_avg_price(self) -> PyneSeries:
        return PyneSeries(
            self._position_avg_price.copy(),
            name="strategy.position_avg_price",
        )

    @property
    def equity(self) -> PyneSeries:
        return PyneSeries(self._equity.copy(), name="strategy.equity")

    @property
    def netprofit(self) -> PyneSeries:
        return PyneSeries(self._netprofit.copy(), name="strategy.netprofit")

    @property
    def openprofit(self) -> PyneSeries:
        return PyneSeries(self._openprofit.copy(), name="strategy.openprofit")

    @property
    def grossprofit(self) -> PyneSeries:
        return PyneSeries(self._grossprofit.copy(), name="strategy.grossprofit")

    @property
    def grossloss(self) -> PyneSeries:
        return PyneSeries(self._grossloss.copy(), name="strategy.grossloss")

    @property
    def closedtrades(self) -> StrategyTradesNamespace:
        return self._closedtrades_namespace

    @property
    def opentrades(self) -> StrategyTradesNamespace:
        return self._opentrades_namespace

    def entry(
        self,
        id: str,
        direction: str = long,
        *,
        qty: float = 1.0,
        when: PyneSeries | np.ndarray | list | bool = True,
        price: PyneSeries | np.ndarray | list | float | None = None,
        limit: PyneSeries | np.ndarray | list | float | None = None,
        stop: PyneSeries | np.ndarray | list | float | None = None,
        oca_name: str = "",
        oca_type: str | None = None,
        comment: str = "",
    ) -> None:
        """Emit entry events when ``when`` is true."""
        self.entry_when(
            when,
            id=id,
            direction=direction,
            qty=qty,
            price=price,
            limit=limit,
            stop=stop,
            oca_name=oca_name,
            oca_type=oca_type,
            comment=comment,
        )

    def entry_when(
        self,
        condition: PyneSeries | np.ndarray | list | bool,
        id: str,
        direction: str = long,
        *,
        qty: float = 1.0,
        price: PyneSeries | np.ndarray | list | float | None = None,
        limit: PyneSeries | np.ndarray | list | float | None = None,
        stop: PyneSeries | np.ndarray | list | float | None = None,
        oca_name: str = "",
        oca_type: str | None = None,
        comment: str = "",
    ) -> None:
        flags = _condition_values(condition, self._context.bar_count)
        prices = _price_values(price, self._context.close, self._context.bar_count)
        limits = _optional_price_values(limit, self._context.bar_count)
        stops = _optional_price_values(stop, self._context.bar_count)
        side = _normalize_direction(direction)
        qty_abs = abs(float(qty))

        for idx, flag in enumerate(flags):
            if not flag:
                continue
            event_price = prices[idx]
            self._collector.strategy_orders.append({
                "time": self._context.times[idx],
                "id": str(id),
                "type": "entry",
                "side": side,
                "qty": qty_abs,
                "price": round(float(event_price), 8),
                "position_after": 0.0,
                "comment": comment,
                "_base_price": float(event_price),
                "_limit": limits[idx],
                "_stop": stops[idx],
                "_original_qty": qty_abs,
                "_oca_name": str(oca_name or ""),
                "_oca_type": _normalize_oca_type(oca_type),
                "_submit_time": self._context.times[idx],
                "_seq": self._next_event_seq(),
            })
            self._touched = True

        self._replay_position()
        self._sync_position_snapshot()

    def order(
        self,
        id: str,
        direction: str = long,
        *,
        qty: float = 1.0,
        when: PyneSeries | np.ndarray | list | bool = True,
        price: PyneSeries | np.ndarray | list | float | None = None,
        limit: PyneSeries | np.ndarray | list | float | None = None,
        stop: PyneSeries | np.ndarray | list | float | None = None,
        oca_name: str = "",
        oca_type: str | None = None,
        comment: str = "",
    ) -> None:
        """Emit lower-level strategy order events when ``when`` is true."""
        self.order_when(
            when,
            id=id,
            direction=direction,
            qty=qty,
            price=price,
            limit=limit,
            stop=stop,
            oca_name=oca_name,
            oca_type=oca_type,
            comment=comment,
        )

    def order_when(
        self,
        condition: PyneSeries | np.ndarray | list | bool,
        id: str,
        direction: str = long,
        *,
        qty: float = 1.0,
        price: PyneSeries | np.ndarray | list | float | None = None,
        limit: PyneSeries | np.ndarray | list | float | None = None,
        stop: PyneSeries | np.ndarray | list | float | None = None,
        oca_name: str = "",
        oca_type: str | None = None,
        comment: str = "",
    ) -> None:
        """Emit lower-level order events when ``condition`` is true.

        Unlike ``entry_when()``, these events are not limited by pyramiding.
        They add, reduce, or reverse the replayed net position.
        """
        flags = _condition_values(condition, self._context.bar_count)
        prices = _price_values(price, self._context.close, self._context.bar_count)
        limits = _optional_price_values(limit, self._context.bar_count)
        stops = _optional_price_values(stop, self._context.bar_count)
        side = _normalize_direction(direction)
        qty_abs = abs(float(qty))

        for idx, flag in enumerate(flags):
            if not flag:
                continue
            event_price = prices[idx]
            self._collector.strategy_orders.append({
                "time": self._context.times[idx],
                "id": str(id),
                "type": "order",
                "side": side,
                "qty": qty_abs,
                "price": round(float(event_price), 8),
                "position_after": 0.0,
                "comment": comment,
                "_base_price": float(event_price),
                "_limit": limits[idx],
                "_stop": stops[idx],
                "_original_qty": qty_abs,
                "_oca_name": str(oca_name or ""),
                "_oca_type": _normalize_oca_type(oca_type),
                "_submit_time": self._context.times[idx],
                "_seq": self._next_event_seq(),
            })
            self._touched = True

        self._replay_position()
        self._sync_position_snapshot()

    def cancel(
        self,
        id: str,
        *,
        when: PyneSeries | np.ndarray | list | bool = True,
        comment: str = "",
    ) -> None:
        """Cancel pending orders with a matching id."""
        flags = _condition_values(when, self._context.bar_count)
        for idx, flag in enumerate(flags):
            if not flag:
                continue
            self._collector.strategy_orders.append({
                "time": self._context.times[idx],
                "id": str(id),
                "type": "cancel",
                "side": "flat",
                "qty": 0.0,
                "price": None,
                "position_after": 0.0,
                "comment": comment,
                "_seq": self._next_event_seq(),
            })
            self._touched = True

        self._replay_position()
        self._sync_position_snapshot()

    def cancel_all(
        self,
        *,
        when: PyneSeries | np.ndarray | list | bool = True,
        comment: str = "",
    ) -> None:
        """Cancel all pending strategy entry/order events."""
        flags = _condition_values(when, self._context.bar_count)
        for idx, flag in enumerate(flags):
            if not flag:
                continue
            self._collector.strategy_orders.append({
                "time": self._context.times[idx],
                "id": "cancel_all",
                "type": "cancel_all",
                "side": "flat",
                "qty": 0.0,
                "price": None,
                "position_after": 0.0,
                "comment": comment,
                "_seq": self._next_event_seq(),
            })
            self._touched = True

        self._replay_position()
        self._sync_position_snapshot()

    def close(
        self,
        id: str = "",
        *,
        when: PyneSeries | np.ndarray | list | bool = True,
        qty: PyneSeries | np.ndarray | list | float | None = None,
        qty_percent: PyneSeries | np.ndarray | list | float | None = None,
        price: PyneSeries | np.ndarray | list | float | None = None,
        comment: str = "",
    ) -> None:
        """Emit close events when ``when`` is true."""
        self.close_when(
            when,
            id=id,
            qty=qty,
            qty_percent=qty_percent,
            price=price,
            comment=comment,
        )

    def close_when(
        self,
        condition: PyneSeries | np.ndarray | list | bool,
        id: str = "",
        *,
        qty: PyneSeries | np.ndarray | list | float | None = None,
        qty_percent: PyneSeries | np.ndarray | list | float | None = None,
        price: PyneSeries | np.ndarray | list | float | None = None,
        comment: str = "",
    ) -> None:
        flags = _condition_values(condition, self._context.bar_count)
        prices = _price_values(price, self._context.close, self._context.bar_count)
        qty_values = _optional_numeric_values(qty, self._context.bar_count)
        qty_percent_values = _optional_numeric_values(qty_percent, self._context.bar_count)

        for idx, flag in enumerate(flags):
            if not flag:
                continue
            current_position = float(self._position_size[idx])
            if current_position == 0:
                continue
            event_price = prices[idx]
            target_qty = min(
                abs(current_position),
                _requested_close_qty(
                    target_qty=abs(current_position),
                    qty=qty_values[idx],
                    qty_percent=qty_percent_values[idx],
                ),
            )
            if target_qty <= 0:
                continue
            self._collector.strategy_orders.append({
                "time": self._context.times[idx],
                "id": str(id),
                "type": "close",
                "side": "flat",
                "qty": round(float(target_qty), 8),
                "price": round(float(event_price), 8),
                "position_after": 0.0,
                "comment": comment,
                "_base_price": float(event_price),
                "_requested_qty": qty_values[idx],
                "_qty_percent": qty_percent_values[idx],
                "_seq": self._next_event_seq(),
            })
            self._touched = True
            self._replay_position()

        self._sync_position_snapshot()

    def close_all(
        self,
        *,
        when: PyneSeries | np.ndarray | list | bool = True,
        price: PyneSeries | np.ndarray | list | float | None = None,
        comment: str = "",
    ) -> None:
        """Emit close-all events when ``when`` is true."""
        flags = _condition_values(when, self._context.bar_count)
        prices = _price_values(price, self._context.close, self._context.bar_count)

        for idx, flag in enumerate(flags):
            if not flag:
                continue
            event_price = prices[idx]
            self._collector.strategy_orders.append({
                "time": self._context.times[idx],
                "id": "close_all",
                "type": "close_all",
                "side": "flat",
                "qty": 0.0,
                "price": round(float(event_price), 8),
                "position_after": 0.0,
                "comment": comment,
                "_base_price": float(event_price),
                "_seq": self._next_event_seq(),
            })
            self._touched = True

        self._replay_position()
        self._sync_position_snapshot()

    def exit(
        self,
        id: str,
        *,
        from_entry: str = "",
        qty: PyneSeries | np.ndarray | list | float | None = None,
        qty_percent: PyneSeries | np.ndarray | list | float | None = None,
        stop: PyneSeries | np.ndarray | list | float | None = None,
        limit: PyneSeries | np.ndarray | list | float | None = None,
        when: PyneSeries | np.ndarray | list | bool = True,
        comment: str = "",
    ) -> None:
        """Emit stop/limit exit events for an open position.

        This is a deterministic event layer, not an intrabar fill simulator.
        When stop and limit are both touched on the same bar, stop wins.
        """
        if stop is None and limit is None:
            return

        flags = _condition_values(when, self._context.bar_count)
        qty_values = _optional_numeric_values(qty, self._context.bar_count)
        qty_percent_values = _optional_numeric_values(qty_percent, self._context.bar_count)
        stops = _optional_price_values(stop, self._context.bar_count)
        limits = _optional_price_values(limit, self._context.bar_count)
        high_values = _price_values(self._context.high, self._context.high, self._context.bar_count)
        low_values = _price_values(self._context.low, self._context.low, self._context.bar_count)
        open_values = _price_values(self._context.open, self._context.open, self._context.bar_count)
        close_values = _price_values(self._context.close, self._context.close, self._context.bar_count)

        for idx, flag in enumerate(flags):
            if not flag:
                continue
            current_position = float(self._position_size[idx])
            if current_position == 0:
                continue
            process_on_close_new_exit = self._process_orders_on_close and (
                idx == 0 or not flags[idx - 1]
            )
            process_on_close_carry_exit = (
                self._process_orders_on_close and idx > 0 and flags[idx - 1]
            )
            trigger_open_price = open_values[idx]
            if process_on_close_new_exit:
                trigger_open_price = close_values[idx]
            elif process_on_close_carry_exit:
                trigger_open_price = close_values[idx - 1]
            trigger = _exit_trigger(
                current_position=current_position,
                open_price=trigger_open_price,
                high=high_values[idx],
                low=low_values[idx],
                stop=stops[idx],
                limit=limits[idx],
                tick_verify=self._limit_fill_verification_amount(),
                same_bar_fill_priority=self._same_bar_fill_priority,
                intrabar_path=self._intrabar_path,
            )
            if trigger is None:
                continue

            reason, event_price = trigger
            event_qty = min(
                abs(current_position),
                _requested_close_qty(
                    target_qty=abs(current_position),
                    qty=qty_values[idx],
                    qty_percent=qty_percent_values[idx],
                ),
            )
            if event_qty <= 0:
                continue
            self._collector.strategy_orders.append({
                "time": self._context.times[idx],
                "id": str(id),
                "from_entry": str(from_entry),
                "type": "exit",
                "side": "flat",
                "qty": round(float(event_qty), 8),
                "price": round(float(event_price), 8),
                "position_after": 0.0,
                "reason": reason,
                "comment": comment,
                "_base_price": float(event_price),
                "_requested_qty": qty_values[idx],
                "_qty_percent": qty_percent_values[idx],
                "_fifo_close": process_on_close_new_exit,
                "_process_on_close_new_exit": process_on_close_new_exit,
                "_seq": self._next_event_seq(),
            })
            self._touched = True
            self._replay_position()

        self._sync_position_snapshot()

    def _replay_position(self) -> None:
        replay_strategy_orders(self)

    def _sync_position_snapshot(self) -> None:
        if not self._touched:
            return
        final_size = float(self._position_size[-1]) if len(self._position_size) else 0.0
        final_avg = (
            float(self._position_avg_price[-1])
            if len(self._position_avg_price) and not is_na_value(self._position_avg_price[-1])
            else None
        )
        self._collector.strategy_position = {
            "size": round(final_size, 8),
            "side": "long" if final_size > 0 else "short" if final_size < 0 else "flat",
            "avg_price": round(final_avg, 8) if final_avg is not None else None,
        }

    def _sync_strategy_report(
        self,
        *,
        closed_trades: list[dict[str, Any]],
        open_trades: list[dict[str, Any]],
        gross_profit: float,
        gross_loss: float,
        total_commission: float,
    ) -> None:
        if not self._touched:
            return
        final_openprofit = float(self._openprofit[-1]) if len(self._openprofit) else 0.0
        final_netprofit = float(self._netprofit[-1]) if len(self._netprofit) else 0.0
        final_equity = float(self._equity[-1]) if len(self._equity) else self._initial_capital
        final_close = float(self._context.close.values[-1]) if self._context.bar_count else np.nan
        internal_open_trades = [
            {
                **trade,
                "profit": round(_trade_open_profit(trade, final_close), 8),
            }
            for trade in open_trades
            if float(trade.get("qty", 0.0)) > 0
        ]
        serialized_open_trades = [_public_trade(trade) for trade in internal_open_trades]
        serialized_closed_trades = [_public_trade(trade) for trade in closed_trades]
        self._closed_trades = list(closed_trades)
        self._open_trades = list(internal_open_trades)
        self._collector.strategy_report = {
            "summary": {
                "initial_capital": round(self._initial_capital, 8),
                "currency": self._currency,
                "equity": round(final_equity, 8),
                "netprofit": round(final_netprofit, 8),
                "openprofit": round(final_openprofit, 8),
                "grossprofit": round(gross_profit, 8),
                "grossloss": round(gross_loss, 8),
                "commission": round(total_commission, 8),
                "backtest_fill_limits_assumption": self._backtest_fill_limits_assumption,
                "same_bar_fill_priority": self._same_bar_fill_priority,
                "intrabar_path": self._intrabar_path,
                "margin_long": round(self._margin_long, 8),
                "margin_short": round(self._margin_short, 8),
            },
            "risk": {
                "locked": self._risk_locked,
                "max_drawdown": (
                    round(self._max_drawdown_value, 8)
                    if self._max_drawdown_value is not None
                    else None
                ),
                "max_drawdown_type": self._max_drawdown_type,
                "max_intraday_loss": (
                    round(self._max_intraday_loss_value, 8)
                    if self._max_intraday_loss_value is not None
                    else None
                ),
                "max_intraday_loss_type": self._max_intraday_loss_type,
                "max_position_size": (
                    round(self._max_position_size, 8)
                    if self._max_position_size is not None
                    else None
                ),
                "max_intraday_filled_orders": self._max_intraday_filled_orders,
            },
            "closedtrades": serialized_closed_trades,
            "opentrades": serialized_open_trades,
            "lifecycle": _strategy_lifecycle_events(self._collector.strategy_orders),
        }

    def _next_event_seq(self) -> int:
        self._event_seq += 1
        return self._event_seq

    def _fill_price(self, price: float, side: str) -> float:
        slippage = self._slippage_ticks * self._mintick
        if side == "buy":
            return float(price) + slippage
        return float(price) - slippage

    def _apply_commission(self, order: dict[str, Any], *, qty: float, price: float) -> float:
        commission = _commission_amount(
            commission_type=self._commission_type,
            commission_value=self._commission_value,
            qty=qty,
            price=price,
        )
        if commission > 0:
            order["commission"] = round(commission, 8)
        return commission

    def _limit_fill_verification_amount(self) -> float:
        return self._backtest_fill_limits_assumption * self._mintick

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
            pointvalue=self._context.syminfo.pointvalue,
        )
        return required <= max(float(equity), 0.0)


def _public_trade(trade: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in trade.items() if not str(key).startswith("_")}
