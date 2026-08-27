from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.data_engine.data_manager import DataManager
from app.data_engine.market_data import (
    MarketChannel,
    MarketDataCatalog,
    MarketDataProviderDescriptor,
    MarketStreamKey,
)


class _PublicTradeService:
    async def ensure_stream(self, key, **kwargs):
        return True

    async def release_stream(self, key, **kwargs):
        return True

    def recent(self, key, **kwargs):
        return []

    async def history(self, key, **kwargs):
        return []

    def attach(self, keys, **kwargs):
        return SimpleNamespace(subscription="subscription", recent={})

    async def archive_coverage(self, key, **kwargs):
        return {"enabled": False}

    def diagnostics(self):
        return {"state": "idle", "rollup_backend": "sqlite"}


def _descriptor(provider_id: str, channel: MarketChannel):
    return MarketDataProviderDescriptor(
        provider_id=provider_id,
        channels=(channel,),
        access_modes=("live", "history"),
        storage_roles=("test_store",),
        delivery="test_delivery",
        authority="test_authority",
    )


def test_catalog_rejects_ambiguous_channel_ownership() -> None:
    catalog = MarketDataCatalog()
    catalog.register(_descriptor("first", MarketChannel.TRADE))

    with pytest.raises(ValueError, match="already owned"):
        catalog.register(_descriptor("second", MarketChannel.TRADE))


def test_catalog_diagnostics_fail_closed_without_breaking_snapshot() -> None:
    catalog = MarketDataCatalog()

    def _broken_diagnostics():
        raise RuntimeError("probe failed")

    catalog.register(
        _descriptor("trades", MarketChannel.TRADE),
        diagnostics=_broken_diagnostics,
    )

    snapshot = catalog.snapshot()

    assert snapshot["degraded"] is True
    assert snapshot["channel_owners"] == {"trade": "trades"}
    assert snapshot["providers"][0]["diagnostics"] is None
    assert snapshot["providers"][0]["diagnostic_error"] == (
        "RuntimeError: probe failed"
    )


def test_data_manager_catalog_exposes_typed_provider_lanes() -> None:
    manager = DataManager()
    manager.set_trade_flow_service(_PublicTradeService())

    snapshot = manager.snapshot()["market_catalog"]
    providers = {
        provider["provider_id"]: provider for provider in snapshot["providers"]
    }

    assert snapshot["schema"] == "candlescope.market-data-catalog/1"
    assert snapshot["channel_owners"]["kline"] == "bars"
    assert snapshot["channel_owners"]["agg_trade"] == "public_trades"
    assert snapshot["channel_owners"]["trade"] == "public_trades"
    assert providers["bars"]["diagnostics"]["ready"] is False
    assert providers["public_trades"]["diagnostics"] == {
        "state": "idle",
        "rollup_backend": "sqlite",
    }

    key = MarketStreamKey.build(
        "binance",
        "futures",
        "BTCUSDT",
        MarketChannel.AGG_TRADE,
    )
    assert manager.trade_flow_recent(key) == []
