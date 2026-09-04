from __future__ import annotations

import asyncio
import sqlite3

import pytest

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
    normalize_subscription_intervals,
)
from app.data_engine.ingestion import factory as ingestion_factory
from app.data_engine.ingestion.factory import ExchangeIngestionFactory
from app.data_engine.ingestion.models import DataSource, MarketEvent, StreamType

DAY_MS = 86_400_000


class _RecordingSubscriptionDataManager:
    def __init__(self) -> None:
        self.stream_started: list[tuple[str, str, str, str, str, str | None, str | None]] = []
        self.stream_released: list[tuple[str, str, str, str, str, str | None, str | None]] = []
        self.stream_stopped: list[tuple[str, str, str, str]] = []
        self.price_started: list[tuple[str, str, str]] = []
        self.price_stopped: list[tuple[str, str, str]] = []
        self.storage_intents: list[dict] = []
        self.removed_storage_intents: list[tuple[str, str, str, str, str]] = []
        self.removed_storage_prefixes: list[str] = []

    async def ensure_stream(
        self,
        symbol,
        interval,
        exchange="binance",
        market_type="spot",
        *,
        focus_scope="foreground",
        subscription_tier=None,
        consumer_id=None,
    ):
        self.stream_started.append((
            exchange,
            market_type,
            symbol,
            interval,
            focus_scope,
            subscription_tier,
            consumer_id,
        ))

    async def release_stream(
        self,
        symbol,
        interval,
        exchange="binance",
        market_type="spot",
        *,
        consumer_id=None,
        focus_scope="foreground",
        subscription_tier=None,
    ):
        self.stream_released.append((
            exchange,
            market_type,
            symbol,
            interval,
            focus_scope,
            subscription_tier,
            consumer_id,
        ))

    async def stop_stream(self, symbol, interval, exchange="binance", market_type="spot"):
        self.stream_stopped.append((exchange, market_type, symbol, interval))

    def get_all_streams(self):
        return []

    async def ensure_price_stream(self, symbol, exchange="binance", market_type="spot"):
        self.price_started.append((exchange, market_type, symbol))

    async def stop_price_stream(self, symbol, exchange="binance", market_type="spot"):
        self.price_stopped.append((exchange, market_type, symbol))

    def register_storage_intent(
        self,
        symbol,
        interval="*",
        *,
        source,
        exchange="binance",
        market_type="spot",
        priority="weak",
        storage_allowed=True,
        frontend_cache_allowed=False,
        stream_required=False,
        keep_rows=None,
        detail=None,
    ):
        intent = {
            "exchange": exchange,
            "market_type": market_type,
            "symbol": symbol,
            "interval": interval,
            "source": source,
            "priority": priority,
            "storage_allowed": storage_allowed,
            "frontend_cache_allowed": frontend_cache_allowed,
            "stream_required": stream_required,
            "keep_rows": keep_rows,
            "detail": detail or {},
        }
        self.storage_intents.append(intent)
        return intent

    def unregister_storage_intent(
        self,
        symbol,
        interval="*",
        *,
        source,
        exchange="binance",
        market_type="spot",
    ):
        self.removed_storage_intents.append((exchange, market_type, symbol, interval, source))

    def unregister_storage_intents_for_source(self, source_prefix):
        self.removed_storage_prefixes.append(source_prefix)
        return 0


def test_normalize_subscription_intervals_keeps_valid_unique_values() -> None:
    assert normalize_subscription_intervals(["1h", " 1h ", "45m", "", None, "bogus"]) == [
        "1h",
        "45m",
    ]
    assert normalize_subscription_intervals("4h") == ["4h"]
    assert normalize_subscription_intervals({"1d", "1d"}) == ["1d"]
    assert normalize_subscription_intervals({"not": "a-list"}) == []


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
    assert normalize_price_key("swap:btc-usdt") == ("okx", "swap", "BTC-USDT")
    assert normalize_price_key("twelvedata:stock:AAPL:NASDAQ") == (
        "twelvedata",
        "stock",
        "AAPL:NASDAQ",
    )
    assert normalize_price_key(
        "AAPL:NASDAQ",
        exchange="twelvedata",
        market_type="stock",
    ) == ("twelvedata", "stock", "AAPL:NASDAQ")
    assert normalize_price_key(
        "SPOT:NYSE",
        exchange="twelvedata",
        market_type="stock",
    ) == ("twelvedata", "stock", "SPOT:NYSE")
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
    assert PriceSnapshot(
        symbol="AAPL:NASDAQ",
        exchange="twelvedata",
        market_type="stock",
        price=1,
        open=1,
        high=1,
        low=1,
        change_pct=0,
        volume=0,
        quote_volume=0,
    ).key == "twelvedata:stock:AAPL:NASDAQ"


def test_ingestion_factory_price_callback_receives_delivery_events() -> None:
    async def _run() -> None:
        class _Delivery:
            def __init__(self) -> None:
                self.callbacks = []

            def on_market_event(self, callback):
                self.callbacks.append(callback)

        class _Pipeline:
            def __init__(self) -> None:
                self.delivery = _Delivery()

        received = []

        async def _on_price(tick):
            received.append(tick)

        pipeline = _Pipeline()
        factory = ExchangeIngestionFactory()
        factory._register_price_callback(  # noqa: SLF001 - regression coverage for bridge wiring
            pipeline,
            _on_price,
            "binance",
            "spot",
        )

        assert len(pipeline.delivery.callbacks) == 1

        await pipeline.delivery.callbacks[0](
            MarketEvent(
                event_type=StreamType.MINI_TICKER,
                symbol="BTCUSDT",
                exchange="binance",
                event_time_ms=1700000000123,
                received_at_ms=1700000000456,
                source=DataSource.WEBSOCKET,
                stream_key="BTCUSDT@miniTicker",
                data={
                    "last_price": 101.5,
                    "open_price": 100,
                    "high_price": 105,
                    "low_price": 95,
                    "price_change_pct": 1.5,
                    "volume": 12,
                    "quote_volume": 1200,
                },
            )
        )

        assert received == [{
            "symbol": "BTCUSDT",
            "exchange": "binance",
            "market_type": "spot",
            "price": 101.5,
            "open": 100.0,
            "high": 105.0,
            "low": 95.0,
            "change_pct": 1.5,
            "volume": 12.0,
            "quote_volume": 1200.0,
            "daily_open": 100.0,
            "updated_at_ms": 1700000000123,
        }]

    asyncio.run(_run())


def test_ingestion_factory_uses_exchange_plugin_price_stream_type() -> None:
    assert ExchangeIngestionFactory._price_stream_type("binance", "spot") == StreamType.MINI_TICKER
    assert ExchangeIngestionFactory._price_stream_type("okx", "spot") == StreamType.TICKER


def test_legacy_binance_ingestion_factory_alias_is_removed() -> None:
    assert hasattr(ingestion_factory, "ExchangeIngestionFactory")
    assert not hasattr(ingestion_factory, "BinanceIngestionFactory")


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


def test_data_manager_daily_open_repairs_from_first_closed_minute_not_forming_day() -> None:
    async def _run() -> None:
        updated_at_ms = DAY_MS * 10 + 123_000

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
            "1m",
            compute_bucket_start_ms(updated_at_ms, DAY_MS, interval="1d"),
            compute_bucket_start_ms(updated_at_ms, DAY_MS, interval="1d"),
            "okx",
            "spot",
        )]

    asyncio.run(_run())


def test_data_manager_daily_open_does_not_backfill_forming_first_minute() -> None:
    async def _run() -> None:
        updated_at_ms = DAY_MS * 10 + 30_000

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
        assert calls == []

    asyncio.run(_run())


def test_data_manager_daily_open_deduplicates_minute_repair_and_keeps_live_value_fresh() -> None:
    async def _run() -> None:
        updated_at_ms = DAY_MS * 10 + 123_000

        class _Storage:
            def query_bars(self, **kwargs):
                return []

        calls: list[tuple[tuple, dict]] = []
        dm = DataManager()
        dm.set_storage(_Storage())  # type: ignore[arg-type]
        dm.set_backfill_trigger(lambda *args, **kwargs: calls.append((args, kwargs)))

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

        await dm.on_price_ticks([{
            "symbol": "okx:spot:BTC-USDT",
            "price": 101,
            "open": 91,
            "high": 111,
            "low": 81,
            "change_pct": 10.989,
            "volume": 13,
            "quote_volume": 1300,
            "daily_open": 98,
            "updated_at_ms": updated_at_ms + 60_000,
        }])

        snapshot = dm.get_price("BTC-USDT", exchange="okx")
        assert snapshot is not None
        assert snapshot.daily_open == 98
        assert len(calls) == 1
        args, kwargs = calls[0]
        bucket_start = compute_bucket_start_ms(updated_at_ms, DAY_MS, interval="1d")
        assert args == (
            "BTC-USDT",
            "1m",
            bucket_start,
            bucket_start,
            "okx",
            "spot",
        )
        assert kwargs["reason"] == "price_daily_open"
        assert kwargs["metadata"]["requested_interval"] == "1m"

    asyncio.run(_run())


def test_subscription_service_full_price_none_lifecycle(tmp_path) -> None:
    async def _run() -> None:
        dm = _RecordingSubscriptionDataManager()
        service = SubscriptionService(tmp_path / "subs.db")
        service.set_data_manager(dm)

        full = await service.set_tier(
            "okx:spot:BTC-USDT",
            SubscriptionTier.FULL,
            intervals=["1h", "45m"],
        )
        assert full["changed"] is True
        assert full["tier"] == "full"
        assert service.get_tier("okx:spot:BTC-USDT") == SubscriptionTier.FULL
        assert dm.stream_started == [
            (
                "okx",
                "spot",
                "BTC-USDT",
                "1h",
                "subscription",
                "full",
                "watchlist:global:okx:spot:BTC-USDT",
            ),
            (
                "okx",
                "spot",
                "BTC-USDT",
                "45m",
                "subscription",
                "full",
                "watchlist:global:okx:spot:BTC-USDT",
            ),
        ]
        assert dm.price_started == [("okx", "spot", "BTC-USDT")]
        assert {
            (item["symbol"], item["interval"], item["source"], item["priority"], item["frontend_cache_allowed"])
            for item in dm.storage_intents
        } >= {
            ("BTC-USDT", "*", "watchlist:okx:spot:BTC-USDT", "strong", False),
            ("BTC-USDT", "1h", "watchlist-full:okx:spot:BTC-USDT:1h", "strong", True),
            ("BTC-USDT", "45m", "watchlist-full:okx:spot:BTC-USDT:45m", "strong", True),
        }

        price_only = await service.set_tier("okx:spot:BTC-USDT", SubscriptionTier.PRICE_ONLY)
        assert price_only == {"symbol": "okx:spot:BTC-USDT", "tier": "price", "changed": True}
        assert dm.stream_released == [
            (
                "okx",
                "spot",
                "BTC-USDT",
                "1h",
                "subscription",
                "full",
                "watchlist:global:okx:spot:BTC-USDT",
            ),
            (
                "okx",
                "spot",
                "BTC-USDT",
                "45m",
                "subscription",
                "full",
                "watchlist:global:okx:spot:BTC-USDT",
            ),
        ]
        assert dm.stream_stopped == []
        assert dm.price_stopped == []
        assert service.get_tier("okx:spot:BTC-USDT") == SubscriptionTier.PRICE_ONLY

        none = await service.set_tier("okx:spot:BTC-USDT", SubscriptionTier.NONE)
        assert none == {"symbol": "okx:spot:BTC-USDT", "tier": "none", "changed": True}
        assert dm.price_stopped == [("okx", "spot", "BTC-USDT")]
        assert service.get_tier("okx:spot:BTC-USDT") == SubscriptionTier.NONE
        assert ("okx", "spot", "BTC-USDT", "1h", "watchlist-full:okx:spot:BTC-USDT:1h") in dm.removed_storage_intents
        assert any(
            item["symbol"] == "BTC-USDT"
            and item["interval"] == "*"
            and item["source"] == "watchlist:okx:spot:BTC-USDT"
            and item["priority"] == "weak"
            for item in dm.storage_intents
        )

    asyncio.run(_run())


def test_subscription_service_preserves_provider_symbol_suffix(tmp_path) -> None:
    async def _run() -> None:
        dm = _RecordingSubscriptionDataManager()
        service = SubscriptionService(tmp_path / "subs.db")
        service.set_data_manager(dm)

        result = await service.set_tier(
            "twelvedata:stock:AAPL:NASDAQ",
            SubscriptionTier.PRICE_ONLY,
        )

        assert result == {
            "symbol": "twelvedata:stock:AAPL:NASDAQ",
            "tier": "price",
            "changed": True,
        }
        assert dm.price_started == [("twelvedata", "stock", "AAPL:NASDAQ")]

    asyncio.run(_run())


def test_subscription_service_restores_persisted_full_and_price_tiers(tmp_path) -> None:
    async def _run() -> None:
        db_path = tmp_path / "subs.db"
        seed = SubscriptionService(db_path)
        await seed.set_tier(
            "spot:BTCUSDT",
            SubscriptionTier.FULL,
            intervals=["1h", "4h"],
        )
        await seed.set_tier("okx:spot:ETH-USDT", SubscriptionTier.PRICE_ONLY)

        dm = _RecordingSubscriptionDataManager()
        restored = SubscriptionService(db_path)
        restored.set_data_manager(dm)
        await restored.start()

        assert dm.stream_started == [
            (
                "binance",
                "spot",
                "BTCUSDT",
                "1h",
                "subscription",
                "full",
                "watchlist:global:spot:BTCUSDT",
            ),
            (
                "binance",
                "spot",
                "BTCUSDT",
                "4h",
                "subscription",
                "full",
                "watchlist:global:spot:BTCUSDT",
            ),
        ]
        assert dm.price_started == [
            ("binance", "spot", "BTCUSDT"),
            ("okx", "spot", "ETH-USDT"),
        ]

    asyncio.run(_run())


def test_subscription_service_full_interval_diff_ensures_added_and_releases_removed(tmp_path) -> None:
    async def _run() -> None:
        dm = _RecordingSubscriptionDataManager()
        service = SubscriptionService(tmp_path / "subs.db")
        service.set_data_manager(dm)

        await service.set_tier(
            "okx:spot:BTC-USDT",
            SubscriptionTier.FULL,
            intervals=["1m", "1h"],
            consumer_id="client-a",
        )
        result = await service.set_tier(
            "okx:spot:BTC-USDT",
            SubscriptionTier.FULL,
            intervals=["1h", "4h"],
            consumer_id="client-a",
        )

        assert result == {"symbol": "okx:spot:BTC-USDT", "tier": "full", "changed": True}
        assert dm.stream_released == [(
            "okx",
            "spot",
            "BTC-USDT",
            "1m",
            "subscription",
            "full",
            "watchlist:global:okx:spot:BTC-USDT",
        )]
        assert dm.stream_started[-1] == (
            "okx",
            "spot",
            "BTC-USDT",
            "4h",
            "subscription",
            "full",
            "watchlist:global:okx:spot:BTC-USDT",
        )
        assert service.get("okx:spot:BTC-USDT").intervals == ["1h", "4h"]

    asyncio.run(_run())


def test_subscription_service_full_repeated_subscription_uses_global_consumer(tmp_path) -> None:
    async def _run() -> None:
        dm = _RecordingSubscriptionDataManager()
        service = SubscriptionService(tmp_path / "subs.db")
        service.set_data_manager(dm)

        await service.set_tier(
            "okx:spot:BTC-USDT",
            SubscriptionTier.FULL,
            intervals=["1h"],
            consumer_id="client-a",
        )
        result = await service.set_tier(
            "okx:spot:BTC-USDT",
            SubscriptionTier.FULL,
            intervals=["1h"],
            consumer_id="client-b",
        )

        assert result == {"symbol": "okx:spot:BTC-USDT", "tier": "full", "changed": False}
        assert dm.stream_started == [
            (
                "okx",
                "spot",
                "BTC-USDT",
                "1h",
                "subscription",
                "full",
                "watchlist:global:okx:spot:BTC-USDT",
            ),
            (
                "okx",
                "spot",
                "BTC-USDT",
                "1h",
                "subscription",
                "full",
                "watchlist:global:okx:spot:BTC-USDT",
            ),
        ]

    asyncio.run(_run())


def test_subscription_service_rejects_new_full_without_valid_intervals(tmp_path) -> None:
    async def _run() -> None:
        service = SubscriptionService(tmp_path / "subs.db")

        with pytest.raises(ValueError, match="Full subscriptions require intervals"):
            await service.set_tier("okx:spot:BTC-USDT", SubscriptionTier.FULL)

        with pytest.raises(ValueError, match="at least one valid interval"):
            await service.set_tier(
                "okx:spot:BTC-USDT",
                SubscriptionTier.FULL,
                intervals=["", "bogus"],
            )

        assert service.get("okx:spot:BTC-USDT") is None

    asyncio.run(_run())


def test_subscription_service_legacy_empty_full_intervals_restore_uses_1m(tmp_path) -> None:
    async def _run() -> None:
        db_path = tmp_path / "subs.db"
        with sqlite3.connect(db_path) as conn:
            conn.execute(
                """
                CREATE TABLE subscriptions (
                    symbol   TEXT PRIMARY KEY,
                    tier     TEXT NOT NULL DEFAULT 'none',
                    added_at INTEGER NOT NULL DEFAULT 0,
                    intervals_json TEXT NOT NULL DEFAULT '[]'
                )
                """
            )
            conn.execute(
                """
                INSERT INTO subscriptions
                    (symbol, tier, added_at, intervals_json)
                VALUES (?, ?, ?, ?)
                """,
                ("okx:spot:BTC-USDT", "full", 123, "[]"),
            )
            conn.commit()

        dm = _RecordingSubscriptionDataManager()
        service = SubscriptionService(db_path)
        service.set_data_manager(dm)
        await service.start()

        assert dm.stream_started == [(
            "okx",
            "spot",
            "BTC-USDT",
            "1m",
            "subscription",
            "full",
            "watchlist:global:okx:spot:BTC-USDT",
        )]

    asyncio.run(_run())


def test_subscription_service_persists_full_intervals(tmp_path) -> None:
    async def _run() -> None:
        db_path = tmp_path / "subs.db"
        service = SubscriptionService(db_path)
        await service.set_tier(
            "okx:spot:BTC-USDT",
            SubscriptionTier.FULL,
            intervals=["1h", "45m", "1h", "bogus"],
        )

        restored = SubscriptionService(db_path)
        sub = restored.get("okx:spot:BTC-USDT")

        assert sub is not None
        assert sub.to_dict() == {
            "symbol": "okx:spot:BTC-USDT",
            "tier": "full",
            "added_at": sub.added_at,
            "intervals": ["1h", "45m"],
        }

        with sqlite3.connect(db_path) as conn:
            row = conn.execute(
                "SELECT intervals_json FROM subscriptions WHERE symbol = ?",
                ("okx:spot:BTC-USDT",),
            ).fetchone()
        assert row == ('["1h","45m"]',)

    asyncio.run(_run())


def test_subscription_service_migrates_legacy_subscription_table(tmp_path) -> None:
    db_path = tmp_path / "subs.db"
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            """
            CREATE TABLE subscriptions (
                symbol   TEXT PRIMARY KEY,
                tier     TEXT NOT NULL DEFAULT 'none',
                added_at INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        conn.execute(
            "INSERT INTO subscriptions (symbol, tier, added_at) VALUES (?, ?, ?)",
            ("binance:spot:BTC-USDT", "full", 123),
        )
        conn.commit()

    service = SubscriptionService(db_path)
    sub = service.get("spot:BTCUSDT")

    assert sub is not None
    assert sub.to_dict() == {
        "symbol": "spot:BTCUSDT",
        "tier": "full",
        "added_at": 123,
        "intervals": [],
    }

    with sqlite3.connect(db_path) as conn:
        columns = {
            row[1]
            for row in conn.execute("PRAGMA table_info(subscriptions)").fetchall()
        }
        row = conn.execute(
            "SELECT symbol, tier, added_at, intervals_json FROM subscriptions"
        ).fetchone()

    assert "intervals_json" in columns
    assert row == ("spot:BTCUSDT", "full", 123, "[]")
