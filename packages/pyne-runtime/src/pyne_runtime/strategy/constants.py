"""Pine-like strategy constants."""
from __future__ import annotations


class StrategyCommission:
    """Pine-like commission type constants."""

    percent = "percent"
    cash_per_order = "cash_per_order"
    cash_per_contract = "cash_per_contract"


class StrategyOca:
    """Pine-like OCA group constants."""

    none = "none"
    cancel = "cancel"
    reduce = "reduce"


class StrategyDirection:
    """Pine-like strategy direction constants."""

    all = "all"
    both = "all"
    long = "long"
    short = "short"
    none = "none"


class StrategyRiskMode:
    """Pine-like risk value type constants."""

    percent_of_equity = "percent_of_equity"
    cash = "cash"


class StrategySameBarPriority:
    """Deterministic same-bar stop/limit priority constants."""

    stop_first = "stop_first"
    limit_first = "limit_first"


class StrategyIntrabarPath:
    """Deterministic intrabar path policy constants."""

    same_bar_priority = "same_bar_priority"
    open_high_low_close = "open_high_low_close"
    open_low_high_close = "open_low_high_close"
