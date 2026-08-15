from __future__ import annotations

from app.backtest.strategy.python_scale import (
    official_bar_capacity,
    million_bar_is_product_ready,
)
from app.core.config import _BACKTEST_BUDGETS


def test_official_bar_capacity_is_not_raised_without_evidence() -> None:
    assert official_bar_capacity() == 200_000
    assert _BACKTEST_BUDGETS["BACKTEST_MAX_BAR_ROWS"] == 200_000
    assert million_bar_is_product_ready() is False
