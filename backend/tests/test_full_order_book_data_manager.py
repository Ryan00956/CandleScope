from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from app.data_engine.data_manager import DataManager
from app.data_engine.market_data.models import MarketChannel, MarketStreamKey


class _FullOrderBookService:
    def __init__(self) -> None:
        self.calls: list[tuple[str, object, dict]] = []

    async def ensure_stream(self, key, **kwargs):
        self.calls.append(("ensure", key, kwargs))
        return True

    async def release_stream(self, key, **kwargs):
        self.calls.append(("release", key, kwargs))
        return True

    def current(self, key, **kwargs):
        self.calls.append(("current", key, kwargs))
        return "live"

    async def wait_for_live(self, key, **kwargs):
        self.calls.append(("wait", key, kwargs))
        return "synchronized"

    def attach(self, keys, **kwargs):
        self.calls.append(("attach", keys, kwargs))
        return SimpleNamespace(subscription="subscription", current={})

    def diagnostics(self):
        return {
            "state": "idle",
            "source_delivery": "ordered_delta",
            "fail_closed_on_gap": True,
        }


def _key() -> MarketStreamKey:
    return MarketStreamKey.build(
        "binance",
        "futures",
        "BTCUSDT",
        MarketChannel.FULL_DEPTH,
        params={
            "mode": "full",
            "snapshot_limit": 1000,
            "update_interval_ms": 250,
        },
    )


def test_data_manager_full_order_book_facade_preserves_fail_closed_contract() -> None:
    async def _run() -> None:
        manager = DataManager()
        service = _FullOrderBookService()
        assert manager.full_order_book_ready is False

        manager.set_full_order_book_service(service)
        key = _key()

        assert manager.full_order_book_ready is True
        assert await manager.ensure_full_order_book_stream(
            key,
            consumer_id="client",
        ) is True
        assert manager.full_order_book_snapshot(key) == "live"
        assert await manager.wait_for_full_order_book_snapshot(
            key,
            timeout_seconds=2.5,
        ) == "synchronized"
        assert manager.attach_full_order_books(
            [key],
            max_pending=4,
        ).subscription == "subscription"
        assert await manager.release_full_order_book_stream(
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
        assert service.calls[1][2] == {"require_live": True}
        assert service.calls[2][2] == {"timeout_seconds": 2.5}

    asyncio.run(_run())


def test_data_manager_full_order_book_diagnostics_follow_readiness() -> None:
    manager = DataManager()

    assert manager.snapshot()["full_order_book"] == {"status": "not_initialized"}
    manager.set_full_order_book_service(_FullOrderBookService())
    assert manager.snapshot()["full_order_book"] == {
        "state": "idle",
        "source_delivery": "ordered_delta",
        "fail_closed_on_gap": True,
    }


def test_data_manager_rejects_incomplete_full_order_book_service() -> None:
    manager = DataManager()

    with pytest.raises(TypeError, match="required facade"):
        manager.set_full_order_book_service(object())
    assert manager.full_order_book_ready is False


def test_data_manager_uninitialized_full_order_book_facade_fails_closed() -> None:
    async def _run() -> None:
        manager = DataManager()
        key = _key()

        with pytest.raises(RuntimeError, match="not initialized"):
            manager.full_order_book_snapshot(key)
        with pytest.raises(RuntimeError, match="not initialized"):
            await manager.wait_for_full_order_book_snapshot(
                key,
                timeout_seconds=1,
            )
        with pytest.raises(RuntimeError, match="not initialized"):
            await manager.ensure_full_order_book_stream(key, consumer_id="client")
        with pytest.raises(RuntimeError, match="not initialized"):
            await manager.release_full_order_book_stream(key, consumer_id="client")
        with pytest.raises(RuntimeError, match="not initialized"):
            manager.attach_full_order_books([key])

    asyncio.run(_run())
