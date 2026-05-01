from __future__ import annotations

from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.models import StreamDescriptor, StreamType
from app.data_engine.ingestion.transport import TransportLayer
from app.exchanges import bootstrap_default_adapters, get_exchange_registry


def test_okx_ticker_uses_public_ws_url() -> None:
    bootstrap_default_adapters()
    adapter = get_exchange_registry().get("okx")
    transport = TransportLayer(IngestionConfig())

    descriptor = StreamDescriptor(
        "BTC-USDT",
        StreamType.TICKER,
        exchange="okx",
        market_type="spot",
    )

    assert transport._get_ws_base_urls_for_descriptor(adapter, descriptor, "spot") == [
        "wss://ws.okx.com:8443/ws/v5/public",
    ]


def test_okx_kline_keeps_business_ws_url() -> None:
    bootstrap_default_adapters()
    adapter = get_exchange_registry().get("okx")
    transport = TransportLayer(IngestionConfig())

    descriptor = StreamDescriptor(
        "BTC-USDT",
        StreamType.KLINE,
        interval="1m",
        exchange="okx",
        market_type="spot",
    )

    assert transport._get_ws_base_urls_for_descriptor(adapter, descriptor, "spot") == [
        "wss://ws.okx.com:8443/ws/v5/business",
    ]


def test_binance_futures_kline_uses_market_ws_route() -> None:
    bootstrap_default_adapters()
    adapter = get_exchange_registry().get("binance")
    transport = TransportLayer(IngestionConfig())

    descriptor = StreamDescriptor(
        "BTCUSDT",
        StreamType.KLINE,
        interval="1h",
        exchange="binance",
        market_type="futures",
    )

    assert transport._get_ws_base_urls_for_descriptor(adapter, descriptor, "futures") == [
        "wss://fstream.binance.com/market/ws",
        "wss://fstream.binance.me/market/ws",
    ]


def test_binance_spot_kline_keeps_spot_ws_route() -> None:
    bootstrap_default_adapters()
    adapter = get_exchange_registry().get("binance")
    transport = TransportLayer(IngestionConfig())

    descriptor = StreamDescriptor(
        "BTCUSDT",
        StreamType.KLINE,
        interval="1h",
        exchange="binance",
        market_type="spot",
    )

    assert transport._get_ws_base_urls_for_descriptor(adapter, descriptor, "spot") == [
        "wss://stream.binance.com:9443/ws",
        "wss://data-stream.binance.vision/ws",
        "wss://stream.binance.me:9443/ws",
    ]
