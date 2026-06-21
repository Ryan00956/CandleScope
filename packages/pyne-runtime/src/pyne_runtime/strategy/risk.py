"""Strategy risk configuration and gates."""
from __future__ import annotations

from typing import TYPE_CHECKING

from .constants import StrategyDirection, StrategyRiskMode

if TYPE_CHECKING:
    from .module import StrategyModule


class StrategyRiskNamespace:
    """Pine-like ``strategy.risk`` configuration namespace."""

    all = StrategyDirection.all
    both = StrategyDirection.both
    long = StrategyDirection.long
    short = StrategyDirection.short
    none = StrategyDirection.none
    percent_of_equity = StrategyRiskMode.percent_of_equity
    cash = StrategyRiskMode.cash

    def __init__(self, strategy: "StrategyModule") -> None:
        self._strategy = strategy

    def allow_entry_in(self, direction: str = StrategyDirection.all) -> None:
        self._strategy._allow_entry_in = _normalize_allowed_entry_direction(direction)

    def max_drawdown(
        self,
        value: float,
        type: str = StrategyRiskMode.percent_of_equity,
    ) -> None:
        self._strategy._max_drawdown_value = max(float(value), 0.0)
        self._strategy._max_drawdown_type = _normalize_risk_mode(type)

    def max_intraday_loss(
        self,
        value: float,
        type: str = StrategyRiskMode.percent_of_equity,
    ) -> None:
        self._strategy._max_intraday_loss_value = max(float(value), 0.0)
        self._strategy._max_intraday_loss_type = _normalize_risk_mode(type)

    def max_position_size(self, contracts: float) -> None:
        self._strategy._max_position_size = max(float(contracts), 0.0)

    def max_intraday_filled_orders(self, count: int) -> None:
        self._strategy._max_intraday_filled_orders = max(int(count), 0)


def _entry_allowed(
    *,
    side: str,
    previous_size: float,
    same_direction_entry_count: int,
    pyramiding: int,
    allow_entry_in: str = StrategyDirection.all,
) -> bool:
    if allow_entry_in == StrategyDirection.none:
        return False
    if allow_entry_in == StrategyDirection.long and side != "long":
        return False
    if allow_entry_in == StrategyDirection.short and side != "short":
        return False
    if previous_size == 0:
        return True
    if side == "long" and previous_size < 0:
        return True
    if side == "short" and previous_size > 0:
        return True
    return same_direction_entry_count < pyramiding


def _entry_rejection_reason(
    *,
    side: str,
    previous_size: float,
    same_direction_entry_count: int,
    pyramiding: int,
    allow_entry_in: str = StrategyDirection.all,
) -> str | None:
    if allow_entry_in == StrategyDirection.none:
        return "direction_not_allowed"
    if allow_entry_in == StrategyDirection.long and side != "long":
        return "direction_not_allowed"
    if allow_entry_in == StrategyDirection.short and side != "short":
        return "direction_not_allowed"
    if previous_size == 0:
        return None
    if side == "long" and previous_size < 0:
        return None
    if side == "short" and previous_size > 0:
        return None
    if same_direction_entry_count >= pyramiding:
        return "pyramiding_exceeded"
    return None


def _entry_qty_for_max_position_size(
    *,
    side: str,
    previous_size: float,
    requested_qty: float,
    max_position_size: float | None,
) -> float:
    qty = abs(float(requested_qty))
    if max_position_size is None:
        return qty
    limit = max(float(max_position_size), 0.0)
    if side == "long":
        available = limit - float(previous_size) if previous_size > 0 else limit
    else:
        available = limit + float(previous_size) if previous_size < 0 else limit
    return max(min(qty, available), 0.0)


def _normalize_allowed_entry_direction(value: str) -> str:
    normalized = str(value or StrategyDirection.all).lower()
    if normalized in {"all", "both", "strategy.direction.all", "strategy.direction.both"}:
        return StrategyDirection.all
    if normalized in {"long", "strategy.long", "strategy.direction.long"}:
        return StrategyDirection.long
    if normalized in {"short", "strategy.short", "strategy.direction.short"}:
        return StrategyDirection.short
    if normalized in {"none", "false", "off", "strategy.direction.none"}:
        return StrategyDirection.none
    raise ValueError("strategy.risk.allow_entry_in() direction is invalid")


def _normalize_risk_mode(value: str) -> str:
    normalized = str(value or StrategyRiskMode.percent_of_equity).lower()
    if normalized in {
        "percent",
        "percent_of_equity",
        "strategy.percent_of_equity",
        "strategy.risk.percent_of_equity",
    }:
        return StrategyRiskMode.percent_of_equity
    if normalized in {"cash", "money", "strategy.cash", "strategy.risk.cash"}:
        return StrategyRiskMode.cash
    raise ValueError("strategy risk mode must be strategy.percent_of_equity or strategy.cash")


def _max_drawdown_hit(
    *,
    equity: float,
    peak_equity: float,
    threshold: float,
    risk_type: str,
) -> bool:
    if threshold <= 0:
        return False
    drawdown = max(float(peak_equity) - float(equity), 0.0)
    if risk_type == StrategyRiskMode.cash:
        return drawdown >= threshold
    if peak_equity <= 0:
        return False
    return drawdown / peak_equity * 100.0 >= threshold


def _intraday_filled_orders_hit(
    *,
    filled_orders: int,
    threshold: int | None,
) -> bool:
    if threshold is None:
        return False
    return int(filled_orders) >= max(int(threshold), 0)
