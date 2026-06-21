"""Strategy cost and margin helpers."""
from __future__ import annotations

from .constants import StrategyCommission
from .ledger import _open_profit


def _normalize_commission_type(value: str) -> str:
    normalized = str(value or "").lower()
    if normalized in {"percent", "strategy.commission.percent"}:
        return StrategyCommission.percent
    if normalized in {
        "cash_per_order",
        "cash_per_order_contract",
        "strategy.commission.cash_per_order",
    }:
        return StrategyCommission.cash_per_order
    if normalized in {
        "cash_per_contract",
        "cash_per_contracts",
        "strategy.commission.cash_per_contract",
    }:
        return StrategyCommission.cash_per_contract
    return normalized


def _commission_amount(
    *,
    commission_type: str | None,
    commission_value: float,
    qty: float,
    price: float,
) -> float:
    if commission_type is None or commission_value <= 0:
        return 0.0
    if commission_type == StrategyCommission.percent:
        return abs(float(qty) * float(price)) * commission_value / 100.0
    if commission_type == StrategyCommission.cash_per_order:
        return commission_value
    if commission_type == StrategyCommission.cash_per_contract:
        return abs(float(qty)) * commission_value
    return 0.0


def _strategy_equity(
    *,
    initial_capital: float,
    gross_profit: float,
    gross_loss: float,
    total_commission: float,
    position_size: float,
    position_avg: float,
    close_price: float,
) -> float:
    net_profit = gross_profit + gross_loss - total_commission
    return initial_capital + net_profit + _open_profit(position_size, position_avg, close_price)


def _margin_required(
    *,
    position_size: float,
    price: float,
    margin_percent: float,
    pointvalue: float,
) -> float:
    if position_size == 0 or margin_percent <= 0:
        return 0.0
    return abs(float(position_size) * float(price) * float(pointvalue)) * margin_percent / 100.0


def _is_exposure_reduction(previous_size: float, next_size: float) -> bool:
    if previous_size == 0:
        return False
    if (previous_size > 0) != (next_size > 0):
        return False
    return abs(next_size) <= abs(previous_size)
