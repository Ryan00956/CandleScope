from __future__ import annotations

from pathlib import Path

import pytest

from app.core.config import load_backtest_settings
from tests.backtest_contract.spec import load_golden


def test_all_backtest_flags_default_off(tmp_path: Path) -> None:
    settings = load_backtest_settings(
        {},
        data_dir=tmp_path,
        klines_db_path=tmp_path / "candlescope.db",
        replay_db_path=tmp_path / "replay.db",
    )
    golden = load_golden()
    assert settings.enabled is False
    assert settings.bar_enabled is False
    assert settings.chart_context_enabled is False
    assert settings.trade_explanation_enabled is False
    assert settings.trade_tape_enabled is False
    assert settings.book_assisted_enabled is False
    assert settings.study_enabled is False
    assert settings.external_provider_enabled is False
    assert settings.online_learning_enabled is False
    assert settings.multi_market_enabled is False
    assert settings.replay_review_bridge_enabled is False
    assert settings.db_path == tmp_path / "backtest.db"
    assert (
        settings.max_active_runs
        == golden["resource_ceilings"]["BACKTEST_MAX_ACTIVE_RUNS"]
    )


def test_child_flag_cannot_enable_without_master_switch(tmp_path: Path) -> None:
    settings = load_backtest_settings(
        {"BACKTEST_BAR_ENABLED": "1"},
        data_dir=tmp_path,
        klines_db_path=tmp_path / "candlescope.db",
        replay_db_path=tmp_path / "replay.db",
    )
    assert settings.enabled is False
    assert settings.bar_effective is False
    assert settings.chart_context_effective is False
    assert settings.trade_explanation_effective is False


def test_chart_context_flag_requires_master_switch(tmp_path: Path) -> None:
    settings = load_backtest_settings(
        {"BACKTEST_CHART_CONTEXT_ENABLED": "1"},
        data_dir=tmp_path,
        klines_db_path=tmp_path / "candlescope.db",
        replay_db_path=tmp_path / "replay.db",
    )
    assert settings.chart_context_enabled is True
    assert settings.chart_context_effective is False


def test_trade_explanation_flag_requires_master_switch(tmp_path: Path) -> None:
    settings = load_backtest_settings(
        {"BACKTEST_TRADE_EXPLANATION_ENABLED": "1"},
        data_dir=tmp_path,
        klines_db_path=tmp_path / "candlescope.db",
        replay_db_path=tmp_path / "replay.db",
    )
    assert settings.trade_explanation_enabled is True
    assert settings.trade_explanation_effective is False


def test_invalid_bool_and_widened_budget_fail_closed(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="BACKTEST_ENABLED"):
        load_backtest_settings(
            {"BACKTEST_ENABLED": "sometimes"},
            data_dir=tmp_path,
            klines_db_path=tmp_path / "candlescope.db",
            replay_db_path=tmp_path / "replay.db",
        )
    with pytest.raises(ValueError, match="BACKTEST_CHART_CONTEXT_ENABLED"):
        load_backtest_settings(
            {"BACKTEST_CHART_CONTEXT_ENABLED": "maybe"},
            data_dir=tmp_path,
            klines_db_path=tmp_path / "candlescope.db",
            replay_db_path=tmp_path / "replay.db",
        )
    with pytest.raises(ValueError, match="BACKTEST_TRADE_EXPLANATION_ENABLED"):
        load_backtest_settings(
            {"BACKTEST_TRADE_EXPLANATION_ENABLED": "maybe"},
            data_dir=tmp_path,
            klines_db_path=tmp_path / "candlescope.db",
            replay_db_path=tmp_path / "replay.db",
        )
    with pytest.raises(ValueError, match="BACKTEST_MAX_ACTIVE_RUNS"):
        load_backtest_settings(
            {"BACKTEST_MAX_ACTIVE_RUNS": "8"},
            data_dir=tmp_path,
            klines_db_path=tmp_path / "candlescope.db",
            replay_db_path=tmp_path / "replay.db",
        )


def test_backtest_db_cannot_share_kline_or_replay_paths(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="BACKTEST_DB_PATH"):
        load_backtest_settings(
            {"BACKTEST_DB_PATH": str(tmp_path / "candlescope.db")},
            data_dir=tmp_path,
            klines_db_path=tmp_path / "candlescope.db",
            replay_db_path=tmp_path / "replay.db",
        )
    with pytest.raises(ValueError, match="BACKTEST_DB_PATH"):
        load_backtest_settings(
            {"BACKTEST_DB_PATH": str(tmp_path / "replay.db")},
            data_dir=tmp_path,
            klines_db_path=tmp_path / "candlescope.db",
            replay_db_path=tmp_path / "replay.db",
        )
