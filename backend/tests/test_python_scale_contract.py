from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

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


BACKEND_ROOT = Path(__file__).resolve().parents[1]


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
    assert settings.python_scale_v1_enabled is False


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
    assert settings.python_scale_v1_enabled is True


def test_million_bar_product_ready_requires_evidence() -> None:
    assert official_bar_capacity() == (
        OFFICIAL_BAR_CAPACITY if million_bar_is_product_ready() else DEFAULT_BAR_CAPACITY
    )


def test_dotenv_defaults_do_not_mutate_process_environment() -> None:
    environment = os.environ.copy()
    environment.pop("BACKTEST_ENABLED", None)
    environment.pop(SCALE_FLAG, None)
    script = f"""
import os
assert "BACKTEST_ENABLED" not in os.environ
assert {SCALE_FLAG!r} not in os.environ
from app.core.config import BACKTEST_SETTINGS
assert BACKTEST_SETTINGS.enabled is True
assert BACKTEST_SETTINGS.python_scale_v1_enabled is True
assert "BACKTEST_ENABLED" not in os.environ
assert {SCALE_FLAG!r} not in os.environ
"""

    completed = subprocess.run(
        [sys.executable, "-c", script],
        cwd=BACKEND_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=30,
        check=False,
    )

    assert completed.returncode == 0, completed.stdout + completed.stderr
