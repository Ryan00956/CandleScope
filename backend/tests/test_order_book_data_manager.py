from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from app.data_engine.data_manager import DataManager
from app.data_engine.market_data.models import MarketChannel, MarketStreamKey


class _OrderBookService:
    def __init__(self) -> None:
        self.calls: list[tuple[str, object, dict]] = []

    async def ensure_stream(self, key, **kwargs):
        self.calls.append(("ensure", key, kwargs))
        return True

    async def release_stream(self, key, **kwargs):
        self.calls.append(("release", key, kwargs))
        return True

    def current(self, key):
        self.calls.append(("current", key, {}))
        return "snapshot"

    async def wait_for_snapshot(self, key, **kwargs):
        self.calls.append(("wait", key, kwargs))
        return "fresh"

    def attach(self, keys, **kwargs):
        self.calls.append(("attach", keys, kwargs))
        return SimpleNamespace(subscription="subscription", current={})

    def diagnostics(self):
        return {
            "state": "idle",
            "delivery": "latest_snapshot",
            "persisted": False,
        }


def _key() -> MarketStreamKey:
    return MarketStreamKey.build(
        "binance",
        "futures",
        "BTCUSDT",
        MarketChannel.DEPTH,
        params={
            "mode": "partial",
            "depth_levels": 20,
            "update_interval_ms": 250,
        },
    )


def test_data_manager_order_book_facade_preserves_service_contracts() -> None:
    async def _run() -> None:
        manager = DataManager()
        service = _OrderBookService()
        assert manager.order_book_ready is False

        manager.set_order_book_service(service)
        key = _key()

        assert manager.order_book_ready is True
        assert await manager.books.partial.ensure_stream(
            key,
            consumer_id="client",
        ) is True
        assert manager.order_book_snapshot(key) == "snapshot"
        assert await manager.books.partial.wait_for_snapshot(
            key,
            timeout_seconds=1.5,
        ) == "fresh"
        assert manager.attach_order_books(
            [key],
            max_pending=8,
        ).subscription == "subscription"
        assert await manager.release_order_book_stream(
            key,
            consumer_id="client",
        ) is True

        assert [item[0] for item in service.calls] == [
            "ensure",
            "current",
            "wait",
            "attach",
            "release",
        ]
        assert service.calls[0][2] == {"consumer_id": "client"}
        assert service.calls[2][2] == {"timeout_seconds": 1.5}
        assert service.calls[3][2] == {"max_pending": 8}

    asyncio.run(_run())


def test_data_manager_order_book_diagnostics_follow_readiness() -> None:
    manager = DataManager()

    assert manager.snapshot()["order_book"] == {"status": "not_initialized"}

    manager.set_order_book_service(_OrderBookService())

    assert manager.snapshot()["order_book"] == {
        "state": "idle",
        "delivery": "latest_snapshot",
        "persisted": False,
    }


def test_data_manager_rejects_incomplete_order_book_service() -> None:
    manager = DataManager()

    with pytest.raises(TypeError, match="required facade"):
        manager.set_order_book_service(object())
    assert manager.order_book_ready is False


def test_data_manager_uninitialized_order_book_facade_fails_closed() -> None:
    async def _run() -> None:
        manager = DataManager()
        key = _key()

        with pytest.raises(RuntimeError, match="not initialized"):
            manager.order_book_snapshot(key)
        with pytest.raises(RuntimeError, match="not initialized"):
            await manager.wait_for_order_book_snapshot(key, timeout_seconds=1)
        with pytest.raises(RuntimeError, match="not initialized"):
            await manager.ensure_order_book_stream(key, consumer_id="client")
        with pytest.raises(RuntimeError, match="not initialized"):
            await manager.release_order_book_stream(key, consumer_id="client")
        with pytest.raises(RuntimeError, match="not initialized"):
            manager.attach_order_books([key])

    asyncio.run(_run())
