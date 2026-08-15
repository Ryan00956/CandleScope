from __future__ import annotations

from app.backtest.strategy.python_scale import (
    AGG_TRADE_PRODUCT_CAPACITY,
    DEFAULT_BAR_CAPACITY,
    OFFICIAL_BAR_CAPACITY,
    SCALE_FLAG,
    bar_row_hard_ceiling,
    million_bar_is_product_ready,
    official_bar_capacity,
    scale_v1_enabled,
)
from app.core.config import _BACKTEST_BUDGETS, load_backtest_settings


def test_default_bar_budget_stays_200k_without_scale_flag(tmp_path) -> None:
    assert _BACKTEST_BUDGETS["BACKTEST_MAX_BAR_ROWS"] == DEFAULT_BAR_CAPACITY
    assert _BACKTEST_BUDGETS["BACKTEST_MAX_TRADE_EVENTS"] == AGG_TRADE_PRODUCT_CAPACITY
    assert scale_v1_enabled({}) is False
    assert bar_row_hard_ceiling({}) == DEFAULT_BAR_CAPACITY
    settings = load_backtest_settings(
        {"BACKTEST_ENABLED": "1", "BACKTEST_BAR_ENABLED": "1"},
        data_dir=tmp_path,
        klines_db_path=tmp_path / "candlescope.db",
        replay_db_path=tmp_path / "replay.db",
    )
    assert settings.max_bar_rows == DEFAULT_BAR_CAPACITY


def test_scale_flag_allows_official_million_hard_ceiling(tmp_path) -> None:
    env = {
        "BACKTEST_ENABLED": "1",
        "BACKTEST_BAR_ENABLED": "1",
        SCALE_FLAG: "1",
        "BACKTEST_MAX_BAR_ROWS": "1000000",
    }
    assert bar_row_hard_ceiling(env) == OFFICIAL_BAR_CAPACITY
    settings = load_backtest_settings(
        env,
        data_dir=tmp_path,
        klines_db_path=tmp_path / "k.db",
        replay_db_path=tmp_path / "r.db",
    )
    assert settings.max_bar_rows == OFFICIAL_BAR_CAPACITY


def test_million_bar_product_ready_requires_evidence() -> None:
    assert official_bar_capacity() == (
        OFFICIAL_BAR_CAPACITY if million_bar_is_product_ready() else DEFAULT_BAR_CAPACITY
    )
