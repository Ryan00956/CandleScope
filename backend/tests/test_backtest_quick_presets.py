from __future__ import annotations

from pathlib import Path

from app.backtest.runtime import BacktestRuntime
from app.core.config import load_backtest_settings


def test_capabilities_expose_versioned_quick_presets_and_default_off_flag(
    tmp_path: Path,
) -> None:
    settings = load_backtest_settings(
        {"BACKTEST_ENABLED": "1", "BACKTEST_BAR_ENABLED": "1"},
        data_dir=tmp_path,
        klines_db_path=tmp_path / "candlescope.db",
        replay_db_path=tmp_path / "replay.db",
    )
    runtime = BacktestRuntime.start(settings, local_data_dir=tmp_path / "local")
    try:
        capabilities = runtime.service.capabilities()
        assert capabilities["flags"]["BACKTEST_CHART_CONTEXT_ENABLED"] is False
        assert capabilities["chart_context"] == {
            "schema_version": "candlescope.backtest-chart-context/1",
            "enabled": False,
            "resolve_is_local_only": True,
            "materialize_requires_confirmation": True,
        }
        presets = {item["id"]: item for item in capabilities["quick_presets"]}
        standard = presets["CRYPTO_PERP_STANDARD_V1"]
        assert standard["revision"] == "1"
        assert standard["account_model"] == "LINEAR_PERP_ONE_WAY_V1"
        assert standard["sizing_policy"] == "EQUITY_PERCENT_V1"
        assert standard["equity_percent"] == "10"
        assert standard["fee_source"] == "exchange-market-preset"
        assert standard["execution_model_revision"] == "EXECUTION_REALISM_V2"
    finally:
        runtime.shutdown()
