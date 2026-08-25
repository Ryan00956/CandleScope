from __future__ import annotations

from pathlib import Path

from app.backtest.python_first_n10 import enabled_production_flags
from app.core.config import load_backtest_settings


def test_chart_first_defaults_on_but_python_entry_remains_off(tmp_path: Path) -> None:
    settings = load_backtest_settings(
        {},
        data_dir=tmp_path,
        klines_db_path=tmp_path / "k.db",
        replay_db_path=tmp_path / "r.db",
    )
    assert settings.enabled is True
    assert settings.multi_market_enabled is False
    assert settings.bar_enabled is True
    assert enabled_production_flags({}) == []
    flags = (
        Path(__file__).resolve().parents[2]
        / "frontend"
        / "src"
        / "features"
        / "backtest"
        / "backtestFlags.ts"
    )
    text = flags.read_text(encoding="utf-8")
    assert 'VITE_BACKTEST_PYTHON_STRATEGY_ENABLED ?? "0"' in text
