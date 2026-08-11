from __future__ import annotations

import asyncio
import sys
from typing import Any

import aiohttp
import pytest

from app.api.v1.symbols import _catalog_refresh_requests
from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.models import (
    DataSource,
    RawMessage,
    StreamDescriptor,
    StreamType,
    TransportRequest,
)
from app.data_engine.ingestion.transport import TransportLayer
from app.data_engine.market_data.models import MarketChannel, TransportMode
from app.exchanges.ccxt_ext.catalog import (
    ccxt_catalog_summary,
    get_ccxt_catalog_entry,
)
from app.exchanges.ccxt_ext.generic import (
    CcxtUnifiedPlugin,
    CcxtUnifiedProfile,
    _create_exchange,
)
from app.exchanges.ccxt_ext.primary import OkxCombinedSummaryProfile
from app.exchanges.ccxt_ext.primary import create_binance_ccxt_plugin
from app.exchanges.ccxt_ext.runtime import CcxtRuntimePool, close_ccxt_exchange
from app.exchanges.ccxt_ext.session import CcxtProviderSession
from app.exchanges.ccxt_ext.unified import (
    CcxtUnifiedNormalizer,
    CcxtUnifiedOrderBookOutOfSync,
    CcxtUnifiedProjector,
)
from app.exchanges.registry import bootstrap_default_adapters, get_exchange_registry
from app.exchanges.symbols import normalize_symbol


def _descriptor(
    stream_type: StreamType,
    *,
    market_type: str = "spot",
) -> StreamDescriptor:
    return StreamDescriptor(
        "BTC/USDT" if market_type == "spot" else "BTC/USDT:USDT",
        stream_type,
        interval="1m" if stream_type == StreamType.KLINE else None,
        depth_levels=5 if stream_type == StreamType.DEPTH else None,
        exchange="bybit",
        market_type=market_type,
    )


def test_pinned_catalog_registers_all_ids_with_ccxt_primary_venues() -> None:
    summary = ccxt_catalog_summary()
    assert summary == {
        "version": "4.5.60",
        "rest_exchange_ids": 105,
        "pro_exchange_ids": 77,
        "watch_ohlcv": 59,
        "watch_trades": 75,
        "watch_order_book": 76,
        "watch_ticker": 67,
        "watch_mark_price": 9,
        "watch_funding_rate": 9,
        "watch_liquidations": 10,
        "fetch_funding_rate_history": 50,
        "fetch_open_interest": 32,
        "fetch_open_interest_history": 15,
    }

    registry = bootstrap_default_adapters()
    assert len(registry.list_plugins()) == summary["rest_exchange_ids"]
    assert registry.get_plugin("binance").__class__.__name__ == "CcxtPrimaryPlugin"
    assert registry.get_plugin("okx").__class__.__name__ == "CcxtPrimaryPlugin"
    assert registry.get_plugin("binance").protocol().__class__.__name__ == (
        "CcxtUnifiedProtocol"
    )
    assert "native_transport.retired" in (
        registry.get_plugin("okx").capabilities().protocol_features
    )
    assert isinstance(registry.get_plugin("bybit"), CcxtUnifiedPlugin)


def test_catalog_routes_market_families_and_capabilities_fail_closed() -> None:
    assert get_ccxt_catalog_entry("kraken").market_types == ("spot",)
    assert get_ccxt_catalog_entry("alpaca").market_types == ("spot",)
    assert set(get_ccxt_catalog_entry("bybit").market_types) == {
        "spot",
        "swap.linear",
        "swap.inverse",
        "future.linear",
        "future.inverse",
        "option",
    }
    assert get_ccxt_catalog_entry("aster").market_types == ()
    assert get_ccxt_catalog_entry("derive").market_types == ()
    unclassified = CcxtUnifiedPlugin(get_ccxt_catalog_entry("aster")).capabilities()
    assert unclassified.capability_schema_version == 1
    assert unclassified.markets == []
    assert unclassified.channels == []

    plugin = CcxtUnifiedPlugin(get_ccxt_catalog_entry("bybit"))
    capabilities = plugin.capabilities()
    depth = capabilities.channel_capability(MarketChannel.DEPTH, "spot")
    assert depth is not None
    assert depth.delivery.value == "snapshot"
    assert depth.delta is False
    assert depth.sequence == "none"
    assert depth.supports_transport(TransportMode.PLUGIN_STREAM)
    assert "orderbook.ccxt_managed_snapshot" in capabilities.protocol_features
    assert capabilities.channel_capability(MarketChannel.FULL_DEPTH, "spot") is None


def test_generic_provider_flag_controls_websocket_routing() -> None:
    descriptor = _descriptor(StreamType.TRADE)

    assert TransportLayer(IngestionConfig()).supports_ws(descriptor) is True
    disabled = TransportLayer(
        IngestionConfig(ccxt_unified_stream_enabled=False),
    )
    assert disabled.supports_ws(descriptor) is False
    assert disabled.create_provider_session(descriptor) is None


def test_primary_venue_maps_futures_to_ccxt_linear_swap() -> None:
    registry = bootstrap_default_adapters()
    descriptor = StreamDescriptor(
        "BTCUSDT",
        StreamType.MARK_PRICE,
        exchange="binance",
        market_type="futures",
    )
    plugin = registry.get_plugin("binance")

    assert plugin.supports_provider_stream(descriptor) is True
    assert plugin.supports_provider_stream(
        StreamDescriptor(
            "BTCUSDT",
            StreamType.LIQUIDATION,
            exchange="binance",
            market_type="spot",
        )
    ) is False


def test_unified_derivatives_summary_keeps_mark_index_and_funding() -> None:
    descriptor = StreamDescriptor(
        "BTCUSDT",
        StreamType.MARK_PRICE,
        exchange="binance",
        market_type="futures",
    )
    projector = CcxtUnifiedProjector(
        exchange_id="binance",
        market_type="futures",
        descriptor=descriptor,
    )
    projected = projector.project(
        {
            "timestamp": 1_700_000_000_000,
            "markPrice": 101.5,
            "indexPrice": 101.0,
            "info": {"r": "0.0001", "T": 1_700_028_800_000},
        },
        received_at_ms=1_700_000_000_001,
    )
    event = CcxtUnifiedNormalizer(descriptor).parse(
        RawMessage(
            payload=projected[0].payload,
            source=DataSource.WEBSOCKET,
            stream_type=StreamType.MARK_PRICE,
            received_at_ms=1_700_000_000_001,
        )
    )

    assert event is not None
    assert event.data == {
        "mark_price": 101.5,
        "index_price": 101.0,
        "funding_rate": 0.0001,
        "next_funding_time_ms": 1_700_028_800_000,
    }


def test_okx_summary_profile_combines_three_ccxt_channels() -> None:
    class Exchange:
        markets = {
            "BTC/USDT:USDT": {
                "symbol": "BTC/USDT:USDT",
                "base": "BTC",
                "quote": "USDT",
                "swap": True,
            },
            "BTC/USDT": {
                "symbol": "BTC/USDT",
                "base": "BTC",
                "quote": "USDT",
                "spot": True,
            },
        }

        def market(self, symbol: str) -> dict[str, Any]:
            return self.markets[symbol]

        async def watch_mark_price(self, symbol: str) -> dict[str, Any]:
            assert symbol == "BTC/USDT:USDT"
            return {"markPrice": 101, "timestamp": 1000, "info": {"markPx": "101"}}

        async def watch_ticker(
            self,
            symbol: str,
            params: dict[str, Any],
        ) -> dict[str, Any]:
            assert (symbol, params) == ("BTC/USDT", {"channel": "index-tickers"})
            return {"indexPrice": 100, "timestamp": 1001, "info": {"idxPx": "100"}}

        async def watch_funding_rate(self, symbol: str) -> dict[str, Any]:
            assert symbol == "BTC/USDT:USDT"
            return {
                "fundingRate": 0.0001,
                "fundingTimestamp": 1002,
                "nextFundingTimestamp": 2000,
                "info": {"fundingRate": "0.0001"},
            }

    async def run() -> None:
        profile = OkxCombinedSummaryProfile(get_ccxt_catalog_entry("okx"))
        exchange = Exchange()
        descriptor = StreamDescriptor(
                "BTC-USDT-SWAP",
                StreamType.INDEX_PRICE,
                exchange="okx",
                market_type="futures",
            )
        assert profile.supports(descriptor) is True
        result: dict[str, Any] = {}
        for _attempt in range(3):
            result = await profile.watch(
                exchange,
                descriptor,
                "BTC/USDT:USDT",
            )
            if {"markPrice", "indexPrice", "fundingRate"}.issubset(result):
                break
        assert result["markPrice"] == 101
        assert result["indexPrice"] == 100
        assert result["fundingRate"] == 0.0001
        assert result["nextFundingTimestamp"] == 2000
        assert result["timestamp"] == 1001
        concurrent = await asyncio.gather(
            profile.watch(exchange, descriptor, "BTC/USDT:USDT"),
            profile.watch(exchange, descriptor, "BTC/USDT:USDT"),
        )
        assert all(
            {"markPrice", "indexPrice", "fundingRate"}.issubset(value)
            for value in concurrent
        )
        await profile.close()

    asyncio.run(run())


def test_generic_catalog_refresh_is_lazy_but_explicit_selection_is_allowed() -> None:
    eager_ids = {exchange_id for exchange_id, _market, _adapter in _catalog_refresh_requests()}
    assert eager_ids == {"binance", "okx"}

    explicit = _catalog_refresh_requests(exchange="bybit", market_type="spot")
    assert [(exchange_id, market) for exchange_id, market, _adapter in explicit] == [
        ("bybit", "spot"),
    ]


def test_generic_symbol_normalization_preserves_ccxt_unified_symbol() -> None:
    assert normalize_symbol("btc/usdt:usdt", "bybit", "swap.linear") == (
        "btc/usdt:usdt"
    )
    assert normalize_symbol("btc-usdt-swap", "binance", "futures") == "BTCUSDT"


def test_unified_kline_projection_emits_one_closure_transition() -> None:
    descriptor = _descriptor(StreamType.KLINE)
    projector = CcxtUnifiedProjector(
        exchange_id="bybit",
        market_type="spot",
        descriptor=descriptor,
    )
    first_open = 1_700_000_040_000
    first = [first_open, 10, 12, 9, 11, 3]
    second = [first_open + 60_000, 11, 13, 10, 12, 4]

    initial = projector.project([first], received_at_ms=first_open + 1_000)
    transition = projector.project([first, second], received_at_ms=second[0] + 1_000)
    repeated = projector.project([first, second], received_at_ms=second[0] + 2_000)

    assert len(initial) == 1
    assert initial[0].payload["is_closed"] is False
    assert [item.payload["is_closed"] for item in transition] == [True, False]
    assert repeated == ()

    message = RawMessage(
        payload=transition[0].payload,
        source=DataSource.WEBSOCKET,
        stream_type=StreamType.KLINE,
        received_at_ms=second[0] + 1_000,
    )
    event = CcxtUnifiedNormalizer(descriptor).parse(message)
    assert event is not None
    assert event.source == DataSource.PLUGIN
    assert event.data["is_closed"] is True
    assert event.data["open_time"] == first_open


def test_unified_trades_are_deduplicated_without_false_continuity() -> None:
    descriptor = _descriptor(StreamType.TRADE)
    projector = CcxtUnifiedProjector(
        exchange_id="bybit",
        market_type="spot",
        descriptor=descriptor,
    )
    trade = {
        "id": "10000",
        "timestamp": 1_700_000_000_000,
        "price": 10,
        "amount": 2,
        "side": "buy",
    }
    projected = projector.project([trade], received_at_ms=1_700_000_000_001)
    assert len(projected) == 1
    assert projector.project([trade], received_at_ms=1_700_000_000_002) == ()

    event = CcxtUnifiedNormalizer(descriptor).parse(
        RawMessage(
            payload=projected[0].payload,
            source=DataSource.WEBSOCKET,
            stream_type=StreamType.TRADE,
            received_at_ms=1_700_000_000_001,
        )
    )
    assert event is not None
    assert event.dedup_key == 10000
    assert event.continuity_key is None


def test_unified_order_book_is_bounded_snapshot_with_local_revision() -> None:
    descriptor = _descriptor(StreamType.DEPTH)
    projector = CcxtUnifiedProjector(
        exchange_id="bybit",
        market_type="spot",
        descriptor=descriptor,
    )
    book = {
        "timestamp": 1_700_000_000_000,
        "nonce": 123,
        "bids": [[9, 1], [10, 2], [8, 3], [7, 4], [6, 5], [5, 6]],
        "asks": [[11, 2], [13, 1], [12, 3], [14, 4], [15, 5], [16, 6]],
    }
    first = projector.project(book, received_at_ms=1_700_000_000_001)[0]
    second = projector.project(book, received_at_ms=1_700_000_000_002)[0]
    assert first.payload["local_revision"] == 1
    assert second.payload["local_revision"] == 2

    event = CcxtUnifiedNormalizer(descriptor).parse(
        RawMessage(
            payload=first.payload,
            source=DataSource.WEBSOCKET,
            stream_type=StreamType.DEPTH,
            received_at_ms=1_700_000_000_001,
        )
    )
    assert event is not None
    assert event.data["source_quality"] == "ccxt_managed_snapshot"
    assert event.data["last_update_id"] == 1
    assert len(event.data["bids"]) == 5
    assert event.data["bids"][0] == [10.0, 2.0]
    assert event.data["asks"][0] == [11.0, 2.0]


def test_unified_order_book_projection_freezes_ccxt_mutable_cache() -> None:
    descriptor = _descriptor(StreamType.DEPTH)
    projector = CcxtUnifiedProjector(
        exchange_id="bybit",
        market_type="spot",
        descriptor=descriptor,
    )
    book = {
        "timestamp": 1_700_000_000_000,
        "bids": [[10, 2]],
        "asks": [[11, 3]],
    }

    projected = projector.project(book, received_at_ms=1_700_000_000_001)[0]
    book["bids"][0][0] = 12
    book["asks"][0][1] = 99

    frozen = projected.payload["value"]
    assert frozen["bids"] == [[10, 2]]
    assert frozen["asks"] == [[11, 3]]


def test_unified_order_book_projection_fails_before_publishing_crossed_cache() -> None:
    descriptor = _descriptor(StreamType.DEPTH)
    projector = CcxtUnifiedProjector(
        exchange_id="bybit",
        market_type="spot",
        descriptor=descriptor,
    )

    with pytest.raises(CcxtUnifiedOrderBookOutOfSync, match="empty or crossed"):
        projector.project(
            {"bids": [[12, 1]], "asks": [[11, 1]]},
            received_at_ms=1_700_000_000_001,
        )


def test_profile_lets_ccxt_choose_venue_depth_before_local_bounding() -> None:
    class Exchange:
        async def watch_order_book(self, symbol: str) -> dict[str, Any]:
            assert symbol == "BTC/USDT"
            return {"bids": [[10, 1]], "asks": [[11, 1]]}

    session_profile = CcxtUnifiedProfile(get_ccxt_catalog_entry("bybit"), "spot")
    result = asyncio.run(
        session_profile.watch(
            Exchange(),
            _descriptor(StreamType.DEPTH),
            "BTC/USDT",
        )
    )
    assert result["bids"] == [[10, 1]]


def test_ccxt_close_requests_rest_and_websocket_cleanup() -> None:
    class Exchange:
        def __init__(self) -> None:
            self.clean_instance_data: bool | None = None

        async def close(self, clean_instance_data: bool = False) -> None:
            self.clean_instance_data = clean_instance_data

    exchange = Exchange()
    asyncio.run(close_ccxt_exchange(exchange))
    assert exchange.clean_instance_data is True


class _UnifiedFakeExchange:
    def __init__(self) -> None:
        self.markets = {
            "BTC/USDT": {
                "id": "BTCUSDT",
                "symbol": "BTC/USDT",
                "spot": True,
            }
        }
        self.results: asyncio.Queue[Any] = asyncio.Queue()
        self.close_calls = 0
        self.clean_ws_calls = 0

    async def load_markets(self) -> None:
        return None

    async def close(self, clean_instance_data: bool = False) -> None:
        del clean_instance_data
        self.close_calls += 1

    async def close_ws_clients(self) -> None:
        return None

    def clean_ws_data(self) -> None:
        self.clean_ws_calls += 1


class _UnifiedFakeProfile:
    exchange_id = "bybit"
    market_type = "spot"

    def __init__(self) -> None:
        self.exchange = _UnifiedFakeExchange()

    @staticmethod
    def supports(descriptor: StreamDescriptor) -> bool:
        return descriptor.stream_type in {StreamType.TRADE, StreamType.DEPTH}

    def create_exchange(
        self,
        config: IngestionConfig,
        *,
        raw_event_sink: Any,
        lifecycle_sink: Any,
    ) -> _UnifiedFakeExchange:
        del config, raw_event_sink, lifecycle_sink
        return self.exchange

    @staticmethod
    def resolve_symbol(
        exchange: _UnifiedFakeExchange,
        descriptor: StreamDescriptor,
    ) -> str:
        del exchange, descriptor
        return "BTC/USDT"

    @staticmethod
    async def watch(
        exchange: _UnifiedFakeExchange,
        descriptor: StreamDescriptor,
        ccxt_symbol: str,
    ) -> Any:
        del descriptor, ccxt_symbol
        return await exchange.results.get()

    @staticmethod
    def matches(event: Any, descriptor: StreamDescriptor) -> bool:
        del event, descriptor
        return False

    @staticmethod
    def runtime_key(config: IngestionConfig) -> tuple[str, ...]:
        del config
        return ("unified-fake",)

    def make_projector(self, descriptor: StreamDescriptor) -> CcxtUnifiedProjector:
        return CcxtUnifiedProjector(
            exchange_id=self.exchange_id,
            market_type=self.market_type,
            descriptor=descriptor,
        )


def test_provider_session_forwards_unified_watch_results_and_releases_runtime() -> None:
    async def run() -> None:
        profile = _UnifiedFakeProfile()
        session = CcxtProviderSession(
            config=IngestionConfig(ws_stale_timeout=1.0),
            descriptor=_descriptor(StreamType.TRADE),
            profile=profile,
            pool=CcxtRuntimePool(),
        )
        messages: list[RawMessage] = []

        async def on_message(message: RawMessage) -> None:
            messages.append(message)

        session.on_message(on_message)
        await session.start()
        await profile.exchange.results.put(
            [
                {
                    "id": "abc",
                    "timestamp": 1_700_000_000_000,
                    "price": 10,
                    "amount": 1,
                    "side": "sell",
                }
            ]
        )
        for _attempt in range(100):
            if messages:
                break
            await asyncio.sleep(0.01)

        assert len(messages) == 1
        assert messages[0].payload["schema"] == "candlescope.ccxt.unified/1"
        await session.stop()
        assert profile.exchange.close_calls == 1

    asyncio.run(run())


def test_provider_session_rebuilds_runtime_after_crossed_unified_book() -> None:
    async def run() -> None:
        profile = _UnifiedFakeProfile()
        session = CcxtProviderSession(
            config=IngestionConfig(
                ws_stale_timeout=1.0,
                ws_reconnect_delay_initial=0.001,
                ws_reconnect_delay_max=0.001,
            ),
            descriptor=_descriptor(StreamType.DEPTH),
            profile=profile,
            pool=CcxtRuntimePool(),
        )
        messages: list[RawMessage] = []

        async def on_message(message: RawMessage) -> None:
            messages.append(message)

        session.on_message(on_message)
        await session.start()
        await profile.exchange.results.put(
            {"bids": [[12, 1]], "asks": [[11, 1]]},
        )
        for _attempt in range(100):
            if profile.exchange.clean_ws_calls:
                break
            await asyncio.sleep(0.01)
        await profile.exchange.results.put(
            {"bids": [[10, 1]], "asks": [[11, 1]]},
        )
        for _attempt in range(100):
            if messages:
                break
            await asyncio.sleep(0.01)

        assert len(messages) == 1
        snapshot = session.snapshot()
        assert snapshot["runtime"]["websocket_generation"] == 1
        assert snapshot["metrics"]["counters"]["runtime_rebuilds"] == 1
        assert profile.exchange.clean_ws_calls == 1
        await session.stop()
        assert profile.exchange.close_calls == 1

    asyncio.run(run())


def test_generic_rest_fetch_closes_exchange_and_returns_unified_rows(
    monkeypatch: Any,
) -> None:
    class FakeRestExchange(_UnifiedFakeExchange):
        async def fetch_ohlcv(
            self,
            symbol: str,
            timeframe: str,
            since: int | None,
            limit: int,
        ) -> list[list[Any]]:
            assert (symbol, timeframe, since, limit) == (
                "BTC/USDT",
                "1m",
                1_700_000_000_000,
                2,
            )
            return [[1_700_000_000_000, 10, 12, 9, 11, 3]]

    fake = FakeRestExchange()
    monkeypatch.setattr(
        "app.exchanges.ccxt_ext.generic._create_exchange",
        lambda *_args, **_kwargs: fake,
    )
    plugin = CcxtUnifiedPlugin(get_ccxt_catalog_entry("bybit"))
    request = TransportRequest(
        descriptor=_descriptor(StreamType.KLINE),
        limit=2,
        start_ms=1_700_000_000_000,
        end_ms=1_700_000_060_000,
    )

    rows = asyncio.run(
        plugin.fetch_history_with_config(
            request,
            IngestionConfig(proxy_mode="none"),
        )
    )

    assert len(rows) == 1
    assert rows[0].source == DataSource.HTTP
    assert rows[0].payload["schema"] == "candlescope.ccxt.unified/1"
    assert fake.close_calls == 1


def test_binance_derivative_factory_does_not_bootstrap_spot_catalog() -> None:
    entry = get_ccxt_catalog_entry("binance")
    config = IngestionConfig(proxy_mode="none")

    linear = _create_exchange(
        entry,
        config,
        market_type="swap.linear",
        websocket=False,
    )
    inverse = _create_exchange(
        entry,
        config,
        market_type="swap.inverse",
        websocket=False,
    )

    assert linear.id == "binanceusdm"
    assert linear.options["fetchMarkets"]["types"] == ["linear"]
    assert inverse.id == "binancecoinm"
    assert inverse.options["fetchMarkets"]["types"] == ["inverse"]


def test_generic_exchange_uses_threaded_dns_and_owns_cleanup_on_windows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def run() -> None:
        monkeypatch.setattr(sys, "platform", "win32")
        exchange = _create_exchange(
            get_ccxt_catalog_entry("binance"),
            IngestionConfig(proxy_mode="none"),
            market_type="swap.linear",
            websocket=False,
        )

        exchange.open()
        assert isinstance(exchange.tcp_connector._resolver, aiohttp.ThreadedResolver)
        assert exchange.session is not None
        session = exchange.session
        await close_ccxt_exchange(exchange)
        assert session.closed is True
        assert exchange.session is None

    asyncio.run(run())


def test_binance_primary_kline_rest_uses_ccxt_implicit_method(
    monkeypatch: Any,
) -> None:
    class Exchange:
        def __init__(self) -> None:
            self.markets = {
                "BTC/USDT:USDT": {
                    "id": "BTCUSDT",
                    "symbol": "BTC/USDT:USDT",
                    "swap": True,
                    "linear": True,
                }
            }
            self.params: dict[str, Any] | None = None
            self.closed = False

        async def load_markets(self) -> None:
            return None

        def market(self, symbol: str) -> dict[str, Any]:
            return self.markets[symbol]

        async def fapipublic_get_klines(
            self,
            params: dict[str, Any],
        ) -> list[list[Any]]:
            self.params = params
            return [[1000, "1", "2", "0.5", "1.5", "3", 1999, "4", 5, "1", "2", "0"]]

        async def close(self, clean_instance_data: bool = False) -> None:
            assert clean_instance_data is True
            self.closed = True

    exchange = Exchange()
    monkeypatch.setattr(
        "app.exchanges.ccxt_ext.primary._create_exchange",
        lambda *_args, **_kwargs: exchange,
    )
    plugin = create_binance_ccxt_plugin()
    descriptor = StreamDescriptor(
        "BTCUSDT",
        StreamType.KLINE,
        interval="1m",
        exchange="binance",
        market_type="futures",
    )
    messages = asyncio.run(
        plugin.fetch_history_with_config(
            TransportRequest(
                descriptor,
                limit=2000,
                start_ms=1000,
                end_ms=2000,
            ),
            IngestionConfig(proxy_mode="none"),
        )
    )

    assert exchange.params == {
        "symbol": "BTCUSDT",
        "limit": 1500,
        "startTime": 1000,
        "endTime": 2000,
        "interval": "1m",
    }
    assert messages[0].payload[7:11] == ["4", 5, "1", "2"]
    event = plugin.normalizer(IngestionConfig(), descriptor).parse(messages[0])
    assert event is not None
    assert event.data["quote_volume"] == 4.0
    assert event.data["trades"] == 5
    assert exchange.closed is True


def test_binance_primary_full_depth_rest_preserves_snapshot_limit(
    monkeypatch: Any,
) -> None:
    class Exchange:
        def __init__(self) -> None:
            self.markets = {
                "BTC/USDT:USDT": {
                    "id": "BTCUSDT",
                    "symbol": "BTC/USDT:USDT",
                    "swap": True,
                    "linear": True,
                }
            }
            self.params: dict[str, Any] | None = None
            self.closed = False

        async def load_markets(self) -> None:
            return None

        def market(self, symbol: str) -> dict[str, Any]:
            return self.markets[symbol]

        async def fapipublic_get_depth(
            self,
            params: dict[str, Any],
        ) -> dict[str, Any]:
            self.params = params
            return {
                "lastUpdateId": 123,
                "E": 1000,
                "T": 1000,
                "bids": [["65000.0", "1.0"]],
                "asks": [["65000.1", "2.0"]],
            }

        async def close(self, clean_instance_data: bool = False) -> None:
            assert clean_instance_data is True
            self.closed = True

    exchange = Exchange()
    monkeypatch.setattr(
        "app.exchanges.ccxt_ext.primary._create_exchange",
        lambda *_args, **_kwargs: exchange,
    )
    plugin = create_binance_ccxt_plugin()
    descriptor = StreamDescriptor(
        "BTCUSDT",
        StreamType.FULL_DEPTH,
        exchange="binance",
        market_type="futures",
        update_interval_ms=250,
    )
    messages = asyncio.run(
        plugin.fetch_history_with_config(
            TransportRequest(descriptor, limit=1000),
            IngestionConfig(proxy_mode="none"),
        )
    )

    assert exchange.params == {"symbol": "BTCUSDT", "limit": 1000}
    assert messages[0].request_limit == 1000
    event = plugin.normalizer(IngestionConfig(), descriptor).parse(messages[0])
    assert event is not None
    assert event.data["snapshot_limit"] == 1000
    assert exchange.closed is True


def test_global_registry_contains_every_pinned_id() -> None:
    registry = get_exchange_registry()
    bootstrap_default_adapters()
    ids = {plugin.id for plugin in registry.list_plugins()}
    assert {"bybit", "kraken", "bitget", "gate"}.issubset(ids)
    assert len(ids) == 105
