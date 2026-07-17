from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from app.data_engine.data_manager import DataManager
from app.data_engine.market_data.models import MarketChannel, MarketStreamKey


class _LiquidationService:
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
        return ["event"]

    async def history(self, key, **kwargs):
        self.calls.append(("history", key, kwargs))
        return ["rollup"]

    def attach(self, keys, **kwargs):
        self.calls.append(("attach", keys, kwargs))
        return SimpleNamespace(subscription="subscription", recent={})

    def diagnostics(self):
        return {
            "state": "idle",
            "source_quality": "sampled_best_effort",
            "backfillable": False,
        }


def _key() -> MarketStreamKey:
    return MarketStreamKey.build(
        "binance",
        "futures",
        "BTCUSDT",
        MarketChannel.LIQUIDATION,
    )


def test_data_manager_liquidation_facade_preserves_sync_and_async_contracts() -> None:
    async def _run() -> None:
        manager = DataManager()
        service = _LiquidationService()
        assert manager.liquidation_ready is False

        manager.set_liquidation_service(service)
        key = _key()

        assert manager.liquidation_ready is True
        assert await manager.ensure_liquidation_stream(
            key,
            consumer_id="client",
        ) is True
        assert manager.liquidation_recent(key, limit=10) == ["event"]
        assert await manager.liquidation_history(
            key,
            start_ms=1,
            end_ms=2,
            position_side="long",
            limit=20,
        ) == ["rollup"]
        assert manager.attach_liquidations(
            [key],
            recent_limit=5,
        ).subscription == "subscription"
        assert await manager.release_liquidation_stream(
            key,
            consumer_id="client",
        ) is True

        assert [item[0] for item in service.calls] == [
            "ensure",
            "recent",
            "history",
            "attach",
            "release",
        ]
        assert service.calls[0][2] == {"consumer_id": "client"}
        assert service.calls[1][2] == {"limit": 10}
        assert service.calls[2][2] == {
            "start_ms": 1,
            "end_ms": 2,
            "position_side": "long",
            "limit": 20,
        }

    asyncio.run(_run())


def test_data_manager_liquidation_diagnostics_follow_service_readiness() -> None:
    manager = DataManager()

    assert manager.snapshot()["liquidations"] == {"status": "not_initialized"}

    manager.set_liquidation_service(_LiquidationService())

    assert manager.snapshot()["liquidations"] == {
        "state": "idle",
        "source_quality": "sampled_best_effort",
        "backfillable": False,
    }


def test_data_manager_rejects_incomplete_liquidation_service() -> None:
    manager = DataManager()

    with pytest.raises(TypeError, match="required facade"):
        manager.set_liquidation_service(object())
    assert manager.liquidation_ready is False


def test_data_manager_uninitialized_liquidation_facade_fails_closed() -> None:
    async def _run() -> None:
        manager = DataManager()
        key = _key()

        with pytest.raises(RuntimeError, match="not initialized"):
            manager.liquidation_recent(key)
        with pytest.raises(RuntimeError, match="not initialized"):
            await manager.liquidation_history(key)
        with pytest.raises(RuntimeError, match="not initialized"):
            await manager.ensure_liquidation_stream(key, consumer_id="client")
        with pytest.raises(RuntimeError, match="not initialized"):
            await manager.release_liquidation_stream(key, consumer_id="client")
        with pytest.raises(RuntimeError, match="not initialized"):
            manager.attach_liquidations([key])

    asyncio.run(_run())
