from __future__ import annotations

import asyncio

from app.data_engine.interval_policy import compute_bucket_start_ms
from app.data_engine.data_manager import DataManager
from app.data_engine.data_manager.models import SeriesKey
from app.data_engine.data_manager.price_cache import (
    PriceSnapshot,
    PriceSnapshotCache,
    normalize_price_key,
    price_key,
)
from app.data_engine.data_manager.subscriptions import (
    SubscriptionService,
    SubscriptionTier,
)

DAY_MS = 86_400_000


def test_price_snapshot_cache_normalizes_updates_and_watched_snapshot() -> None:
    cache = PriceSnapshotCache()

    okx_key, was_new = cache.watch("BTC-USDT", exchange="okx", market_type="spot")
    assert (okx_key, was_new) == ("okx:spot:BTC-USDT", True)
    assert cache.watch("okx:spot:BTC-USDT") == ("okx:spot:BTC-USDT", False)

    updated = cache.upsert_many([
        {
            "symbol": "okx:spot:BTC-USDT",
            "price": "101.5",
            "open": "100",
            "high": "110",
            "low": "90",
            "change_pct": "1.5",
            "volume": "12.345",
            "quote_volume": "1234.567",
            "daily_open": "99",
            "updated_at_ms": "1700000000000",
        },
        PriceSnapshot(
            symbol="ETHUSDT",
            exchange="binance",
            market_type="futures",
            price=2500,
            open=2400,
            high=2600,
            low=2300,
            change_pct=4.1666,
            volume=2,
            quote_volume=5000,
            daily_open=2450,
            updated_at_ms=1700000001000,
        ),
    ])

    assert [item.key for item in updated] == [
        "okx:spot:BTC-USDT",
        "futures:ETHUSDT",
    ]
    assert cache.get("BTC-USDT", exchange="okx").price == 101.5
    assert cache.snapshot(watched_only=True) == [
        {
            "symbol": "okx:spot:BTC-USDT",
            "exchange": "okx",
            "market_type": "spot",
            "price": 101.5,
            "open": 100.0,
            "high": 110.0,
            "low": 90.0,
            "change_pct": 1.5,
            "volume": 12.35,
            "quote_volume": 1234.57,
            "daily_open": 99.0,
            "daily_change": 2.5,
            "daily_change_pct": 2.5253,
            "updated_at_ms": 1700000000000,
        }
    ]
    assert [item["symbol"] for item in cache.snapshot(watched_only=False)] == [
        "futures:ETHUSDT",
        "okx:spot:BTC-USDT",
    ]
    assert cache.unwatch("okx:spot:BTC-USDT") == ("okx:spot:BTC-USDT", True)
    assert cache.snapshot(watched_only=True) == []
    assert cache.diagnostics() == {
        "watched": 0,
        "cached": 2,
        "watched_symbols": [],
    }


def test_price_key_helpers_normalize_exchange_market_and_symbol() -> None:
    assert normalize_price_key("btc-usdt", exchange="okx", market_type="swap") == (
        "okx",
        "swap",
        "BTC-USDT",
    )
    assert normalize_price_key("okx:spot:eth-usdt") == ("okx", "spot", "ETH-USDT")
    assert price_key("BTCUSDT", exchange="binance", market_type="spot") == "spot:BTCUSDT"
    assert price_key("BTC-USDT", exchange="okx", market_type="spot") == "okx:spot:BTC-USDT"
    assert PriceSnapshot(
        symbol="btcusdt",
        exchange="binance",
        market_type="spot",
        price=1,
        open=1,
        high=1,
        low=1,
        change_pct=0,
        volume=0,
        quote_volume=0,
    ).series_key == SeriesKey("BTCUSDT", "price")


def test_data_manager_daily_open_prefers_storage_1d_bar() -> None:
    async def _run() -> None:
        updated_at_ms = DAY_MS * 10 + 123_000
        bucket_start = compute_bucket_start_ms(updated_at_ms, DAY_MS, interval="1d")

        class _Storage:
            def __init__(self) -> None:
                self.calls: list[dict] = []

            def query_bars(self, **kwargs):
                self.calls.append(kwargs)
                return [{
                    "open_time": bucket_start,
                    "open": 95,
                    "high": 105,
                    "low": 90,
                    "close": 100,
                    "volume": 1,
                }]

        storage = _Storage()
        dm = DataManager()
        dm.set_storage(storage)  # type: ignore[arg-type]

        await dm.ensure_price_stream("BTC-USDT", exchange="okx", market_type="spot")
        await dm.on_price_ticks([{
            "symbol": "okx:spot:BTC-USDT",
            "price": 100,
            "open": 90,
            "high": 110,
            "low": 80,
            "change_pct": 11.1111,
            "volume": 12,
            "quote_volume": 1200,
            "daily_open": 99,
            "updated_at_ms": updated_at_ms,
        }])

        snapshot = dm.get_price("BTC-USDT", exchange="okx")

        assert snapshot is not None
        assert snapshot.daily_open == 95
        assert storage.calls == [{
            "symbol": "BTC-USDT",
            "interval": "1d",
            "start_ms": bucket_start,
            "end_ms": bucket_start,
            "limit": 1,
            "order": "ASC",
            "exchange": "okx",
            "market_type": "spot",
        }]

    asyncio.run(_run())


def test_data_manager_daily_open_triggers_1d_backfill_when_storage_missing() -> None:
    async def _run() -> None:
        updated_at_ms = DAY_MS * 10 + 123_000
        bucket_start = compute_bucket_start_ms(updated_at_ms, DAY_MS, interval="1d")

        class _Storage:
            def query_bars(self, **kwargs):
                return []

        calls: list[tuple] = []
        dm = DataManager()
        dm.set_storage(_Storage())  # type: ignore[arg-type]
        dm.set_backfill_trigger(lambda *args: calls.append(args))

        await dm.ensure_price_stream("BTC-USDT", exchange="okx", market_type="spot")
        await dm.on_price_ticks([{
            "symbol": "okx:spot:BTC-USDT",
            "price": 100,
            "open": 90,
            "high": 110,
            "low": 80,
            "change_pct": 11.1111,
            "volume": 12,
            "quote_volume": 1200,
            "daily_open": 99,
            "updated_at_ms": updated_at_ms,
        }])

        snapshot = dm.get_price("BTC-USDT", exchange="okx")

        assert snapshot is not None
        assert snapshot.daily_open == 99
        assert calls == [(
            "BTC-USDT",
            "1d",
            bucket_start,
            bucket_start + DAY_MS - 1,
            "okx",
            "spot",
        )]

    asyncio.run(_run())


def test_subscription_service_full_price_none_lifecycle(tmp_path) -> None:
    async def _run() -> None:
        class _StreamInfo:
            def __init__(self, key: SeriesKey) -> None:
                self.key = key

        class _DataManager:
            def __init__(self) -> None:
                self.stream_started: list[tuple[str, str, str, str]] = []
                self.stream_stopped: list[tuple[str, str, str, str]] = []
                self.price_started: list[tuple[str, str, str]] = []
                self.price_stopped: list[tuple[str, str, str]] = []
                self.streams: list[_StreamInfo] = []

            async def ensure_stream(self, symbol, interval, exchange="binance", market_type="spot"):
                self.stream_started.append((exchange, market_type, symbol, interval))
                self.streams.append(_StreamInfo(
                    SeriesKey(symbol, interval, exchange=exchange, market_type=market_type)
                ))

            async def stop_stream(self, symbol, interval, exchange="binance", market_type="spot"):
                self.stream_stopped.append((exchange, market_type, symbol, interval))
                self.streams = [
                    item for item in self.streams
                    if item.key != SeriesKey(symbol, interval, exchange=exchange, market_type=market_type)
                ]

            def get_all_streams(self):
                return list(self.streams)

            async def ensure_price_stream(self, symbol, exchange="binance", market_type="spot"):
                self.price_started.append((exchange, market_type, symbol))

            async def stop_price_stream(self, symbol, exchange="binance", market_type="spot"):
                self.price_stopped.append((exchange, market_type, symbol))

        dm = _DataManager()
        service = SubscriptionService(tmp_path / "subs.db")
        service.set_data_manager(dm)

        full = await service.set_tier("okx:spot:BTC-USDT", SubscriptionTier.FULL)
        assert full["changed"] is True
        assert full["tier"] == "full"
        assert service.get_tier("okx:spot:BTC-USDT") == SubscriptionTier.FULL
        assert dm.stream_started == [("okx", "spot", "BTC-USDT", "1m")]
        assert dm.price_started == [("okx", "spot", "BTC-USDT")]

        price_only = await service.set_tier("okx:spot:BTC-USDT", SubscriptionTier.PRICE_ONLY)
        assert price_only == {"symbol": "okx:spot:BTC-USDT", "tier": "price", "changed": True}
        assert dm.stream_stopped == [("okx", "spot", "BTC-USDT", "1m")]
        assert dm.price_stopped == []
        assert service.get_tier("okx:spot:BTC-USDT") == SubscriptionTier.PRICE_ONLY

        none = await service.set_tier("okx:spot:BTC-USDT", SubscriptionTier.NONE)
        assert none == {"symbol": "okx:spot:BTC-USDT", "tier": "none", "changed": True}
        assert dm.price_stopped == [("okx", "spot", "BTC-USDT")]
        assert service.get_tier("okx:spot:BTC-USDT") == SubscriptionTier.NONE

    asyncio.run(_run())


def test_subscription_service_restores_persisted_full_and_price_tiers(tmp_path) -> None:
    async def _run() -> None:
        class _DataManager:
            def __init__(self) -> None:
                self.stream_started: list[tuple[str, str, str, str]] = []
                self.price_started: list[tuple[str, str, str]] = []

            async def ensure_stream(self, symbol, interval, exchange="binance", market_type="spot"):
                self.stream_started.append((exchange, market_type, symbol, interval))

            async def ensure_price_stream(self, symbol, exchange="binance", market_type="spot"):
                self.price_started.append((exchange, market_type, symbol))

        db_path = tmp_path / "subs.db"
        seed = SubscriptionService(db_path)
        await seed.set_tier("spot:BTCUSDT", SubscriptionTier.FULL)
        await seed.set_tier("okx:spot:ETH-USDT", SubscriptionTier.PRICE_ONLY)

        dm = _DataManager()
        restored = SubscriptionService(db_path)
        restored.set_data_manager(dm)
        await restored.start()

        assert dm.stream_started == [("binance", "spot", "BTCUSDT", "1m")]
        assert dm.price_started == [
            ("binance", "spot", "BTCUSDT"),
            ("okx", "spot", "ETH-USDT"),
        ]

    asyncio.run(_run())
