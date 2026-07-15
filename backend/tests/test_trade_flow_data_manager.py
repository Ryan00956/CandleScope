from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from app.data_engine.data_manager import DataManager
from app.data_engine.market_data.models import MarketChannel, MarketStreamKey


class _TradeFlowService:
    def __init__(self) -> None:
        self.calls: list[tuple[str, object, dict]] = []

    async def ensure_stream(self, key, **kwargs):
        self.calls.append(("ensure", key, kwargs))
        return True

    async def release_stream(self, key, **kwargs):
        self.calls.append(("release", key, kwargs))
        return True

    def recent(self, key, **kwargs):
        self.calls.append(("recent", key, kwargs))
        return ["raw"]

    async def history(self, key, **kwargs):
        self.calls.append(("history", key, kwargs))
        return ["rollup"]

    def attach(self, keys, **kwargs):
        self.calls.append(("attach", keys, kwargs))
        return SimpleNamespace(subscription="subscription", recent={})

    async def archive_coverage(self, key, **kwargs):
        self.calls.append(("coverage", key, kwargs))
        return {"enabled": False}

    def diagnostics(self):
        return {"state": "idle"}


def _key() -> MarketStreamKey:
    return MarketStreamKey.build(
        "binance",
        "futures",
        "BTCUSDT",
        MarketChannel.AGG_TRADE,
    )


def test_data_manager_trade_flow_facade_preserves_sync_and_async_contracts() -> None:
    async def _run() -> None:
        manager = DataManager()
        service = _TradeFlowService()
        manager.set_trade_flow_service(service)
        key = _key()

        assert manager.trade_flow_ready is True
        assert await manager.ensure_trade_flow_stream(
            key,
            consumer_id="client",
        ) is True
        assert manager.trade_flow_recent(key, limit=10) == ["raw"]
        assert await manager.trade_flow_history(key, limit=20) == ["rollup"]
        assert manager.attach_trade_flow([key], recent_limit=5).subscription == (
            "subscription"
        )
        assert await manager.trade_flow_archive_coverage(
            key,
            expected_start_agg_trade_id=1,
        ) == {"enabled": False}
        assert await manager.release_trade_flow_stream(
            key,
            consumer_id="client",
        ) is True

        assert [item[0] for item in service.calls] == [
            "ensure",
            "recent",
            "history",
            "attach",
            "coverage",
            "release",
        ]

    asyncio.run(_run())


def test_data_manager_rejects_incomplete_trade_flow_service() -> None:
    manager = DataManager()

    with pytest.raises(TypeError, match="required facade"):
        manager.set_trade_flow_service(object())
