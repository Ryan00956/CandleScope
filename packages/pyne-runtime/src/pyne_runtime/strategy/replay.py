"""Strategy order replay engine."""
from __future__ import annotations

from typing import Any

import numpy as np

from ..series import PyneSeries
from ..state import PyneVar
from ..values import is_na_value
from .constants import StrategyOca
from .costs import _strategy_equity
from .ledger import _open_profit, _record_fill, _target_open_qty
from .orders import (
    _apply_oca_after_fill,
    _is_pending_submission,
    _pending_trigger,
    _reject_order,
)
from .risk import (
    _entry_qty_for_max_position_size,
    _entry_rejection_reason,
    _intraday_filled_orders_hit,
    _max_drawdown_hit,
)


def replay_strategy_orders(strategy: Any) -> None:
    self = strategy
    current_size = 0.0
    current_avg = np.nan
    same_direction_entry_count = 0
    gross_profit = 0.0
    gross_loss = 0.0
    total_commission = 0.0
    closed_trades: list[dict[str, Any]] = []
    open_trades: list[dict[str, Any]] = []
    pending_orders: list[dict[str, Any]] = []
    orders_by_time: dict[int, list[dict[str, Any]]] = {}
    drawdown_locked = False
    intraday_locked = False
    filled_orders_locked = False
    risk_locked = False
    peak_equity = self._initial_capital
    intraday_peak_equity = self._initial_capital
    intraday_filled_orders = 0
    filled_orders_locked = _intraday_filled_orders_hit(
        filled_orders=intraday_filled_orders,
        threshold=self._max_intraday_filled_orders,
    )
    self._closed_trades_by_bar = [[] for _ in range(self._context.bar_count)]
    self._open_trades_by_bar = [[] for _ in range(self._context.bar_count)]
    session_first = _condition_values(
        self._context.session.isfirstbar,
        self._context.bar_count,
    )
    for order in sorted(
        self._collector.strategy_orders,
        key=lambda item: (item.get("time", 0), item.get("_seq", 0)),
    ):
        order["_active"] = False
        order.pop("_filled_qty", None)
        order.pop("_requested_fill_qty", None)
        order.pop("_target_qty", None)
        order.pop("_transaction_qty", None)
        if order.get("type") in {"entry", "order"}:
            order.pop("_canceled", None)
            order.pop("_canceled_time", None)
            order.pop("_canceled_by", None)
            order.pop("_rejected_reason", None)
            order.pop("_rejected_time", None)
            order["time"] = int(order.get("_submit_time", order.get("time", 0)))
            order["qty"] = float(order.get("_original_qty", order.get("qty", 0.0)))
            order["position_after"] = 0.0
            order["price"] = round(
                float(order.get("_base_price", order.get("price", np.nan))),
                8,
            )
            order.pop("commission", None)
            order.pop("oca_name", None)
            order.pop("oca_type", None)
            if _is_pending_submission(order):
                order.pop("reason", None)
        elif order.get("type") in {"cancel", "cancel_all"}:
            order.pop("canceled", None)
        orders_by_time.setdefault(int(order.get("time", 0)), []).append(order)

    for idx, timestamp in enumerate(self._context.times):
        if session_first[idx]:
            intraday_locked = False
            intraday_filled_orders = 0
            filled_orders_locked = _intraday_filled_orders_hit(
                filled_orders=intraday_filled_orders,
                threshold=self._max_intraday_filled_orders,
            )
            intraday_peak_equity = (
                float(self._equity[idx - 1])
                if idx > 0
                else self._initial_capital
            )
        risk_locked = drawdown_locked or intraday_locked or filled_orders_locked
        same_bar_visible_fill = False
        bar_open_size = current_size
        if self._process_orders_on_close:
            _write_strategy_snapshot(
                self,
                idx=idx,
                current_size=current_size,
                current_avg=current_avg,
                gross_profit=gross_profit,
                gross_loss=gross_loss,
                total_commission=total_commission,
                closed_trades=closed_trades,
                open_trades=open_trades,
            )
        for order in orders_by_time.get(timestamp, []):
            if order.get("type") == "entry":
                if risk_locked:
                    _reject_order(order, timestamp=timestamp, reason="risk_locked")
                    continue
                if _is_pending_submission(order):
                    pending_orders.append(order)
                    continue
                side = _normalize_direction(str(order.get("side", self.long)))
                rejection_reason = _entry_rejection_reason(
                    side=side,
                    previous_size=current_size,
                    same_direction_entry_count=same_direction_entry_count,
                    pyramiding=self._pyramiding,
                    allow_entry_in=self._allow_entry_in,
                )
                if rejection_reason is not None:
                    _reject_order(order, timestamp=timestamp, reason=rejection_reason)
                    continue
                fill_side = "buy" if side == self.long else "sell"
                fill_price = self._fill_price(
                    float(order.get("_base_price", order.get("price", np.nan))),
                    fill_side,
                )
                qty = _entry_qty_for_max_position_size(
                    side=side,
                    previous_size=current_size,
                    requested_qty=float(order.get("qty", 0.0)),
                    max_position_size=self._max_position_size,
                )
                order["_requested_fill_qty"] = float(
                    order.get("_original_qty", order.get("qty", 0.0))
                )
                if qty <= 0:
                    order["_filled_qty"] = 0.0
                    _reject_order(order, timestamp=timestamp, reason="max_position_size")
                    continue
                position_after, avg_after = _entry_position_after(
                    previous_size=current_size,
                    previous_avg=current_avg,
                    side=side,
                    qty=qty,
                    price=fill_price,
                )
                pre_fill_equity = _strategy_equity(
                    initial_capital=self._initial_capital,
                    gross_profit=gross_profit,
                    gross_loss=gross_loss,
                    total_commission=total_commission,
                    position_size=current_size,
                    position_avg=current_avg,
                    close_price=float(self._context.close.values[idx]),
                )
                if not self._margin_allows_position(
                    previous_size=current_size,
                    next_size=position_after,
                    price=fill_price,
                    equity=pre_fill_equity,
                ):
                    order["_filled_qty"] = 0.0
                    _reject_order(order, timestamp=timestamp, reason="margin")
                    continue
                if current_size == 0 or (current_size > 0) != (position_after > 0):
                    same_direction_entry_count = 1
                else:
                    same_direction_entry_count += 1
                previous_size = current_size
                current_size = position_after
                current_avg = avg_after
                order["qty"] = round(qty, 8)
                order["_filled_qty"] = round(qty, 8)
                order["price"] = round(float(fill_price), 8)
                order["position_after"] = round(float(position_after), 8)
                transaction_qty = abs(position_after - previous_size)
                if abs(transaction_qty - qty) > 1e-9:
                    order["_transaction_qty"] = round(transaction_qty, 8)
                commission = self._apply_commission(
                    order,
                    qty=transaction_qty,
                    price=fill_price,
                )
                order["_fill_bar_index"] = idx
                gross_profit, gross_loss, total_commission, open_trades = _record_fill(
                    order=order,
                    signed_qty=position_after - previous_size,
                    previous_size=previous_size,
                    fill_price=fill_price,
                    next_size=position_after,
                    commission=commission,
                    open_trades=open_trades,
                    closed_trades=closed_trades,
                    gross_profit=gross_profit,
                    gross_loss=gross_loss,
                    total_commission=total_commission,
                )
                order["_avg_price_after"] = (
                    round(float(avg_after), 8) if not is_na_value(avg_after) else None
                )
                order["_active"] = True
                intraday_filled_orders += 1
                if _intraday_filled_orders_hit(
                    filled_orders=intraday_filled_orders,
                    threshold=self._max_intraday_filled_orders,
                ):
                    filled_orders_locked = True
                    risk_locked = True
            elif order.get("type") == "order":
                if risk_locked:
                    _reject_order(order, timestamp=timestamp, reason="risk_locked")
                    continue
                if _is_pending_submission(order):
                    pending_orders.append(order)
                    continue
                side = _normalize_direction(str(order.get("side", self.long)))
                fill_side = "buy" if side == self.long else "sell"
                fill_price = self._fill_price(
                    float(order.get("_base_price", order.get("price", np.nan))),
                    fill_side,
                )
                qty = float(order.get("qty", 0.0))
                order["_requested_fill_qty"] = float(order.get("_original_qty", qty))
                position_after, avg_after = _order_position_after(
                    previous_size=current_size,
                    previous_avg=current_avg,
                    side=side,
                    qty=qty,
                    price=fill_price,
                )
                pre_fill_equity = _strategy_equity(
                    initial_capital=self._initial_capital,
                    gross_profit=gross_profit,
                    gross_loss=gross_loss,
                    total_commission=total_commission,
                    position_size=current_size,
                    position_avg=current_avg,
                    close_price=float(self._context.close.values[idx]),
                )
                if not self._margin_allows_position(
                    previous_size=current_size,
                    next_size=position_after,
                    price=fill_price,
                    equity=pre_fill_equity,
                ):
                    order["_filled_qty"] = 0.0
                    _reject_order(order, timestamp=timestamp, reason="margin")
                    continue
                if position_after == 0:
                    same_direction_entry_count = 0
                elif current_size == 0 or (current_size > 0) != (position_after > 0):
                    same_direction_entry_count = 1
                previous_size = current_size
                current_size = position_after
                current_avg = avg_after
                order["price"] = round(float(fill_price), 8)
                order["_filled_qty"] = round(qty, 8)
                order["position_after"] = round(float(position_after), 8)
                commission = self._apply_commission(order, qty=qty, price=fill_price)
                signed_qty = qty if side == self.long else -qty
                order["_fill_bar_index"] = idx
                gross_profit, gross_loss, total_commission, open_trades = _record_fill(
                    order=order,
                    signed_qty=signed_qty,
                    previous_size=previous_size,
                    fill_price=fill_price,
                    next_size=position_after,
                    commission=commission,
                    open_trades=open_trades,
                    closed_trades=closed_trades,
                    gross_profit=gross_profit,
                    gross_loss=gross_loss,
                    total_commission=total_commission,
                )
                order["_avg_price_after"] = (
                    round(float(avg_after), 8) if not is_na_value(avg_after) else None
                )
                order["_active"] = True
                intraday_filled_orders += 1
                if _intraday_filled_orders_hit(
                    filled_orders=intraday_filled_orders,
                    threshold=self._max_intraday_filled_orders,
                ):
                    filled_orders_locked = True
                    risk_locked = True
            elif order.get("type") in {"close", "close_all", "exit"} and current_size != 0:
                previous_size = current_size
                if order.get("type") == "exit":
                    target_qty = _target_open_qty(order, open_trades, current_size)
                    requested_qty = _requested_close_qty(
                        target_qty=target_qty,
                        qty=order.get("_requested_qty"),
                        qty_percent=order.get("_qty_percent"),
                    )
                    fill_qty = min(requested_qty, target_qty)
                elif order.get("type") == "close":
                    target_qty = _target_open_qty(order, open_trades, current_size)
                    requested_qty = _requested_close_qty(
                        target_qty=target_qty,
                        qty=order.get("_requested_qty"),
                        qty_percent=order.get("_qty_percent"),
                    )
                    fill_qty = min(target_qty, abs(current_size), requested_qty)
                else:
                    target_qty = abs(current_size)
                    requested_qty = target_qty
                    fill_qty = abs(current_size)
                order["_target_qty"] = round(float(target_qty), 8)
                order["_requested_fill_qty"] = round(float(requested_qty), 8)
                if fill_qty <= 0:
                    continue
                remaining = abs(current_size) - fill_qty
                next_size = 0.0
                if remaining > 0:
                    next_size = remaining if current_size > 0 else -remaining
                fill_side = "sell" if current_size > 0 else "buy"
                fill_price = self._fill_price(
                    float(order.get("_base_price", order.get("price", np.nan))),
                    fill_side,
                )
                order["qty"] = round(fill_qty, 8)
                order["_filled_qty"] = round(fill_qty, 8)
                order["price"] = round(float(fill_price), 8)
                order["position_after"] = round(next_size, 8)
                commission = self._apply_commission(order, qty=fill_qty, price=fill_price)
                signed_qty = -fill_qty if previous_size > 0 else fill_qty
                order["_fill_bar_index"] = idx
                gross_profit, gross_loss, total_commission, open_trades = _record_fill(
                    order=order,
                    signed_qty=signed_qty,
                    previous_size=previous_size,
                    fill_price=fill_price,
                    next_size=next_size,
                    commission=commission,
                    open_trades=open_trades,
                    closed_trades=closed_trades,
                    gross_profit=gross_profit,
                    gross_loss=gross_loss,
                    total_commission=total_commission,
                )
                order["_active"] = True
                if order.get("_fifo_close") and next_size != 0:
                    current_avg = _position_avg_from_open_trades(open_trades, next_size)
                if (
                    order.get("type") == "exit"
                    and self._process_orders_on_close
                    and not order.get("_process_on_close_new_exit")
                ):
                    same_bar_visible_fill = True
                if self._process_orders_on_close and order.get("_risk_liquidation"):
                    same_bar_visible_fill = True
                current_size = next_size
                if current_size == 0:
                    current_avg = np.nan
                    same_direction_entry_count = 0
            elif order.get("type") == "cancel":
                canceled = [item for item in pending_orders if item.get("id") == order.get("id")]
                if canceled:
                    for item in canceled:
                        item["_canceled"] = True
                        item["_canceled_time"] = timestamp
                        item["_canceled_by"] = order.get("id")
                    order["canceled"] = len(canceled)
                    order["_active"] = True
                pending_orders = [item for item in pending_orders if not item.get("_canceled")]
            elif order.get("type") == "cancel_all":
                if pending_orders:
                    for item in pending_orders:
                        item["_canceled"] = True
                        item["_canceled_time"] = timestamp
                        item["_canceled_by"] = "cancel_all"
                    order["canceled"] = len(pending_orders)
                    order["_active"] = True
                pending_orders = []

        if pending_orders:
            open_price = float(self._context.open.values[idx])
            high = float(self._context.high.values[idx])
            low = float(self._context.low.values[idx])
            remaining_pending = []
            for order in sorted(pending_orders, key=lambda item: item.get("_seq", 0)):
                if order.get("_canceled"):
                    continue
                if risk_locked and order.get("type") in {"entry", "order"}:
                    remaining_pending.append(order)
                    continue
                trigger_reference_price = open_price
                if (
                    self._process_orders_on_close
                    and int(order.get("_submit_time", order.get("time", 0))) == timestamp
                ):
                    trigger_reference_price = float(self._context.close.values[idx])
                trigger = _pending_trigger(
                    side=_normalize_direction(str(order.get("side", self.long))),
                    open_price=trigger_reference_price,
                    high=high,
                    low=low,
                    limit=order.get("_limit"),
                    stop=order.get("_stop"),
                    tick_verify=self._limit_fill_verification_amount(),
                    same_bar_fill_priority=self._same_bar_fill_priority,
                    intrabar_path=self._intrabar_path,
                )
                if trigger is None:
                    remaining_pending.append(order)
                    continue
                reason, trigger_price = trigger
                order["time"] = timestamp
                order["reason"] = reason
                order["_base_price"] = float(trigger_price)
                if order.get("type") == "entry":
                    side = _normalize_direction(str(order.get("side", self.long)))
                    rejection_reason = _entry_rejection_reason(
                        side=side,
                        previous_size=current_size,
                        same_direction_entry_count=same_direction_entry_count,
                        pyramiding=self._pyramiding,
                        allow_entry_in=self._allow_entry_in,
                    )
                    if rejection_reason is not None:
                        _reject_order(order, timestamp=timestamp, reason=rejection_reason)
                        continue
                    fill_side = "buy" if side == self.long else "sell"
                    fill_price = self._fill_price(float(trigger_price), fill_side)
                    qty = _entry_qty_for_max_position_size(
                        side=side,
                        previous_size=current_size,
                        requested_qty=float(order.get("qty", 0.0)),
                        max_position_size=self._max_position_size,
                    )
                    order["_requested_fill_qty"] = float(
                        order.get("_original_qty", order.get("qty", 0.0))
                    )
                    if qty <= 0:
                        order["_filled_qty"] = 0.0
                        _reject_order(order, timestamp=timestamp, reason="max_position_size")
                        continue
                    position_after, avg_after = _entry_position_after(
                        previous_size=current_size,
                        previous_avg=current_avg,
                        side=side,
                        qty=qty,
                        price=fill_price,
                    )
                    pre_fill_equity = _strategy_equity(
                        initial_capital=self._initial_capital,
                        gross_profit=gross_profit,
                        gross_loss=gross_loss,
                        total_commission=total_commission,
                        position_size=current_size,
                        position_avg=current_avg,
                        close_price=float(self._context.close.values[idx]),
                    )
                    if not self._margin_allows_position(
                        previous_size=current_size,
                        next_size=position_after,
                        price=fill_price,
                        equity=pre_fill_equity,
                    ):
                        remaining_pending.append(order)
                        continue
                    if current_size == 0 or (current_size > 0) != (position_after > 0):
                        same_direction_entry_count = 1
                    else:
                        same_direction_entry_count += 1
                else:
                    side = _normalize_direction(str(order.get("side", self.long)))
                    fill_side = "buy" if side == self.long else "sell"
                    fill_price = self._fill_price(float(trigger_price), fill_side)
                    qty = float(order.get("qty", 0.0))
                    order["_requested_fill_qty"] = float(order.get("_original_qty", qty))
                    position_after, avg_after = _order_position_after(
                        previous_size=current_size,
                        previous_avg=current_avg,
                        side=side,
                        qty=qty,
                        price=fill_price,
                    )
                    pre_fill_equity = _strategy_equity(
                        initial_capital=self._initial_capital,
                        gross_profit=gross_profit,
                        gross_loss=gross_loss,
                        total_commission=total_commission,
                        position_size=current_size,
                        position_avg=current_avg,
                        close_price=float(self._context.close.values[idx]),
                    )
                    if not self._margin_allows_position(
                        previous_size=current_size,
                        next_size=position_after,
                        price=fill_price,
                        equity=pre_fill_equity,
                    ):
                        remaining_pending.append(order)
                        continue
                    if position_after == 0:
                        same_direction_entry_count = 0
                    elif current_size == 0 or (current_size > 0) != (position_after > 0):
                        same_direction_entry_count = 1
                previous_size = current_size
                current_size = position_after
                current_avg = avg_after
                if order.get("type") == "entry":
                    order["qty"] = round(qty, 8)
                order["_filled_qty"] = round(float(qty), 8)
                order["price"] = round(float(fill_price), 8)
                order["position_after"] = round(float(position_after), 8)
                if order.get("_oca_name"):
                    order["oca_name"] = order.get("_oca_name")
                    order["oca_type"] = order.get("_oca_type") or StrategyOca.none
                fill_qty = float(order.get("qty", 0.0))
                signed_qty = fill_qty if side == self.long else -fill_qty
                transaction_qty = abs(position_after - previous_size)
                commission_qty = transaction_qty if order.get("type") == "entry" else fill_qty
                if order.get("type") == "entry" and abs(transaction_qty - fill_qty) > 1e-9:
                    order["_transaction_qty"] = round(transaction_qty, 8)
                commission = self._apply_commission(
                    order,
                    qty=commission_qty,
                    price=fill_price,
                )
                order["_fill_bar_index"] = idx
                gross_profit, gross_loss, total_commission, open_trades = _record_fill(
                    order=order,
                    signed_qty=(
                        position_after - previous_size
                        if order.get("type") == "entry"
                        else signed_qty
                    ),
                    previous_size=previous_size,
                    fill_price=fill_price,
                    next_size=position_after,
                    commission=commission,
                    open_trades=open_trades,
                    closed_trades=closed_trades,
                    gross_profit=gross_profit,
                    gross_loss=gross_loss,
                    total_commission=total_commission,
                )
                order["_avg_price_after"] = (
                    round(float(avg_after), 8) if not is_na_value(avg_after) else None
                )
                order["_active"] = True
                if order.get("type") in {"entry", "order"}:
                    intraday_filled_orders += 1
                    if _intraday_filled_orders_hit(
                        filled_orders=intraday_filled_orders,
                        threshold=self._max_intraday_filled_orders,
                    ):
                        filled_orders_locked = True
                        risk_locked = True
                _apply_oca_after_fill(order, pending_orders)
            pending_orders = [item for item in remaining_pending if not item.get("_canceled")]
        risk_liquidation = _risk_liquidation_reason(
            self,
            idx=idx,
            current_size=current_size,
            current_avg=current_avg,
            bar_open_size=bar_open_size,
            gross_profit=gross_profit,
            gross_loss=gross_loss,
            total_commission=total_commission,
            peak_equity=peak_equity,
            intraday_peak_equity=intraday_peak_equity,
        )
        if risk_liquidation is not None:
            intraday_locked = True
            risk_locked = True
            if pending_orders:
                for pending in pending_orders:
                    pending["_canceled"] = True
                    pending["_canceled_time"] = timestamp
                    pending["_canceled_by"] = risk_liquidation
                pending_orders = []
            if current_size != 0:
                (
                    current_size,
                    current_avg,
                    gross_profit,
                    gross_loss,
                    total_commission,
                    open_trades,
                ) = _force_close_for_risk(
                    self,
                    idx=idx,
                    timestamp=timestamp,
                    reason=risk_liquidation,
                    current_size=current_size,
                    gross_profit=gross_profit,
                    gross_loss=gross_loss,
                    total_commission=total_commission,
                    open_trades=open_trades,
                    closed_trades=closed_trades,
                )
                same_direction_entry_count = 0
                same_bar_visible_fill = True
        if not self._process_orders_on_close or same_bar_visible_fill:
            _write_strategy_snapshot(
                self,
                idx=idx,
                current_size=current_size,
                current_avg=current_avg,
                gross_profit=gross_profit,
                gross_loss=gross_loss,
                total_commission=total_commission,
                closed_trades=closed_trades,
                open_trades=open_trades,
            )
        net_profit = gross_profit + gross_loss - total_commission
        open_profit = _open_profit(
            current_size,
            current_avg,
            float(self._context.close.values[idx]),
        )
        equity = self._initial_capital + net_profit + open_profit
        peak_equity = max(peak_equity, float(equity))
        intraday_peak_equity = max(intraday_peak_equity, float(equity))
        if self._max_drawdown_value is not None and _max_drawdown_hit(
            equity=float(equity),
            peak_equity=peak_equity,
            threshold=self._max_drawdown_value,
            risk_type=self._max_drawdown_type,
        ):
            drawdown_locked = True
        if self._max_intraday_loss_value is not None and _max_drawdown_hit(
            equity=float(equity),
            peak_equity=intraday_peak_equity,
            threshold=self._max_intraday_loss_value,
            risk_type=self._max_intraday_loss_type,
        ):
            intraday_locked = True
        risk_locked = drawdown_locked or intraday_locked or filled_orders_locked
    self._risk_locked = risk_locked

    self._sync_strategy_report(
        closed_trades=closed_trades,
        open_trades=open_trades,
        gross_profit=gross_profit,
        gross_loss=gross_loss,
        total_commission=total_commission,
    )


def _risk_liquidation_reason(
    strategy: Any,
    *,
    idx: int,
    current_size: float,
    current_avg: float,
    bar_open_size: float,
    gross_profit: float,
    gross_loss: float,
    total_commission: float,
    peak_equity: float,
    intraday_peak_equity: float,
) -> str | None:
    if current_size == 0:
        return None

    if strategy._process_orders_on_close and bar_open_size == 0:
        risk_price = float(strategy._context.close.values[idx])
    else:
        risk_price = (
            float(strategy._context.low.values[idx])
            if current_size > 0
            else float(strategy._context.high.values[idx])
        )
    net_profit = gross_profit + gross_loss - total_commission
    equity = strategy._initial_capital + net_profit + _open_profit(
        current_size,
        current_avg,
        risk_price,
    )
    if strategy._max_intraday_loss_value is not None and _max_drawdown_hit(
        equity=float(equity),
        peak_equity=intraday_peak_equity,
        threshold=strategy._max_intraday_loss_value,
        risk_type=strategy._max_intraday_loss_type,
    ):
        return "risk.max_intraday_loss"
    return None


def _force_close_for_risk(
    strategy: Any,
    *,
    idx: int,
    timestamp: int,
    reason: str,
    current_size: float,
    gross_profit: float,
    gross_loss: float,
    total_commission: float,
    open_trades: list[dict[str, Any]],
    closed_trades: list[dict[str, Any]],
) -> tuple[float, float, float, float, float, list[dict[str, Any]]]:
    fill_qty = abs(current_size)
    fill_side = "sell" if current_size > 0 else "buy"
    risk_price = (
        float(strategy._context.low.values[idx])
        if current_size > 0
        else float(strategy._context.high.values[idx])
    )
    fill_price = strategy._fill_price(risk_price, fill_side)
    order = {
        "time": timestamp,
        "id": reason,
        "type": "close_all",
        "side": "flat",
        "qty": round(fill_qty, 8),
        "price": round(float(fill_price), 8),
        "position_after": 0.0,
        "comment": "",
        "_active": True,
        "_filled_qty": round(fill_qty, 8),
        "_requested_fill_qty": round(fill_qty, 8),
        "_target_qty": round(fill_qty, 8),
        "_risk_liquidation": True,
        "_submit_time": timestamp,
        "_seq": strategy._next_event_seq(),
    }
    strategy._collector.strategy_orders.append(order)
    commission = strategy._apply_commission(order, qty=fill_qty, price=fill_price)
    signed_qty = -fill_qty if current_size > 0 else fill_qty
    order["_fill_bar_index"] = idx
    gross_profit, gross_loss, total_commission, open_trades = _record_fill(
        order=order,
        signed_qty=signed_qty,
        previous_size=current_size,
        fill_price=fill_price,
        next_size=0.0,
        commission=commission,
        open_trades=open_trades,
        closed_trades=closed_trades,
        gross_profit=gross_profit,
        gross_loss=gross_loss,
        total_commission=total_commission,
    )
    return 0.0, np.nan, gross_profit, gross_loss, total_commission, open_trades


def _write_strategy_snapshot(
    strategy: Any,
    *,
    idx: int,
    current_size: float,
    current_avg: float,
    gross_profit: float,
    gross_loss: float,
    total_commission: float,
    closed_trades: list[dict[str, Any]],
    open_trades: list[dict[str, Any]],
) -> None:
    net_profit = gross_profit + gross_loss - total_commission
    open_profit = _open_profit(
        current_size,
        current_avg,
        float(strategy._context.close.values[idx]),
    )
    strategy._position_size[idx] = current_size
    strategy._position_avg_price[idx] = current_avg
    strategy._grossprofit[idx] = gross_profit
    strategy._grossloss[idx] = gross_loss
    strategy._netprofit[idx] = net_profit
    strategy._openprofit[idx] = open_profit
    strategy._equity[idx] = strategy._initial_capital + net_profit + open_profit
    strategy._closedtrades_count[idx] = len(closed_trades)
    visible_open_trades = [
        dict(trade) for trade in open_trades if float(trade.get("qty", 0.0)) > 0
    ]
    strategy._opentrades_count[idx] = len(visible_open_trades)
    strategy._closed_trades_by_bar[idx] = [dict(trade) for trade in closed_trades]
    strategy._open_trades_by_bar[idx] = visible_open_trades


def _condition_values(value: Any, length: int) -> list[bool]:
    values = _values(value, length)
    return [False if is_na_value(item) else bool(item) for item in values]


def _price_values(value: Any, fallback: PyneSeries, length: int) -> list[float]:
    values = _values(fallback if value is None else value, length)
    return [np.nan if is_na_value(item) else float(item) for item in values]


def _optional_price_values(value: Any, length: int) -> list[float | None]:
    if value is None:
        return [None] * length
    values = _values(value, length)
    return [None if is_na_value(item) else float(item) for item in values]


def _optional_numeric_values(value: Any, length: int) -> list[float | None]:
    if value is None:
        return [None] * length
    values = _values(value, length)
    return [None if is_na_value(item) else float(item) for item in values]


def _requested_close_qty(
    *,
    target_qty: float,
    qty: Any,
    qty_percent: Any,
) -> float:
    target = max(float(target_qty), 0.0)
    if qty is not None and not is_na_value(qty):
        return max(float(qty), 0.0)
    if qty_percent is not None and not is_na_value(qty_percent):
        return target * max(float(qty_percent), 0.0) / 100.0
    return target


def _entry_position_after(
    *,
    previous_size: float,
    previous_avg: float,
    side: str,
    qty: float,
    price: float,
) -> tuple[float, float]:
    signed_qty = qty if side == "long" else -qty
    if previous_size == 0 or (previous_size > 0) != (signed_qty > 0):
        return signed_qty, float(price)

    new_size = previous_size + signed_qty
    if new_size == 0:
        return 0.0, np.nan
    if is_na_value(previous_avg):
        return new_size, float(price)
    weighted = (abs(previous_size) * previous_avg + qty * float(price)) / abs(new_size)
    return new_size, weighted


def _order_position_after(
    *,
    previous_size: float,
    previous_avg: float,
    side: str,
    qty: float,
    price: float,
) -> tuple[float, float]:
    signed_qty = qty if side == "long" else -qty
    new_size = previous_size + signed_qty
    if new_size == 0:
        return 0.0, np.nan
    if previous_size == 0 or (previous_size > 0) != (new_size > 0):
        return new_size, float(price)
    if (previous_size > 0) != (signed_qty > 0):
        return new_size, previous_avg
    if is_na_value(previous_avg):
        return new_size, float(price)
    weighted = (abs(previous_size) * previous_avg + qty * float(price)) / abs(new_size)
    return new_size, weighted


def _position_avg_from_open_trades(
    open_trades: list[dict[str, Any]],
    current_size: float,
) -> float:
    if current_size == 0:
        return np.nan
    side = "long" if current_size > 0 else "short"
    total_qty = 0.0
    weighted = 0.0
    for trade in open_trades:
        if trade.get("side") != side:
            continue
        qty = abs(float(trade.get("qty", 0.0)))
        if qty <= 0:
            continue
        total_qty += qty
        weighted += qty * float(trade.get("entry_price", np.nan))
    if total_qty <= 0:
        return np.nan
    return weighted / total_qty


def _values(value: Any, length: int) -> list[Any]:
    if isinstance(value, PyneVar):
        value = value.get()
    if isinstance(value, PyneSeries):
        return value.to_numpy().tolist()
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, list):
        if len(value) == length:
            return value
        if len(value) == 1:
            return value * length
        raise ValueError("strategy series inputs must match the OHLCV length")
    return [value] * length


def _normalize_direction(direction: str) -> str:
    normalized = str(direction or "long").lower()
    if normalized in {"short", "-1", "sell"}:
        return "short"
    if normalized in {"long", "1", "buy"}:
        return "long"
    raise ValueError("strategy direction must be strategy.long or strategy.short")
