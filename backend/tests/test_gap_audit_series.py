from __future__ import annotations

from app.data_engine.data_manager import DataManager, DataManagerConfig
from app.data_engine.data_manager.config import PrewarmTarget


class _Storage:
    def list_series(self, custom_only: bool = False):
        assert custom_only is False
        return [
            {
                "exchange": "okx",
                "market_type": "spot",
                "symbol": "ETH-USDT",
                "interval": "5m",
            }
        ]


def test_data_manager_gap_audit_series_includes_prewarm_active_and_storage() -> None:
    cfg = DataManagerConfig()
    cfg.coordinator.prewarm_targets = [
        PrewarmTarget(symbol="BTC-USDT", exchange="okx", market_type="spot")
    ]
    cfg.coordinator.prewarm_intervals = {"1m": 1}

    dm = DataManager(cfg)
    dm.set_storage(_Storage())
    dm.bar_aggregator.add_target("SOL-USDT", "15m", exchange="okx", market_type="spot")

    assert dm.gap_audit_series() == [
        ("okx", "spot", "BTC-USDT", "1m"),
        ("okx", "spot", "ETH-USDT", "5m"),
        ("okx", "spot", "SOL-USDT", "15m"),
    ]
