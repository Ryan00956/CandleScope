from __future__ import annotations

from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.models import StreamDescriptor, StreamType
from app.data_engine.ingestion.transport import TransportLayer
from app.exchanges import bootstrap_default_adapters, get_exchange_registry


def test_okx_ticker_has_no_native_ws_url() -> None:
    bootstrap_default_adapters()
    registry = get_exchange_registry()
    adapter = registry.get("okx")
    transport = TransportLayer(IngestionConfig())

    descriptor = StreamDescriptor(
        "BTC-USDT",
        StreamType.TICKER,
        exchange="okx",
        market_type="spot",
    )

    assert transport._get_ws_base_urls_for_descriptor(adapter, descriptor, "spot") == []
    assert transport.create_provider_session(descriptor) is not None
    assert registry.get_plugin("okx").protocol().ws_base_urls(descriptor) == []


def test_okx_kline_has_no_native_ws_url() -> None:
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

    assert transport._get_ws_base_urls_for_descriptor(adapter, descriptor, "spot") == []
    assert transport.create_provider_session(descriptor) is not None


def test_binance_futures_kline_has_no_native_ws_route() -> None:
    bootstrap_default_adapters()
    registry = get_exchange_registry()
    adapter = registry.get("binance")
    transport = TransportLayer(IngestionConfig())

    descriptor = StreamDescriptor(
        "BTCUSDT",
        StreamType.KLINE,
        interval="1h",
        exchange="binance",
        market_type="futures",
    )

    assert transport._get_ws_base_urls_for_descriptor(adapter, descriptor, "futures") == []
    assert transport.create_provider_session(descriptor) is not None
    assert registry.get_plugin("binance").protocol().ws_base_urls(descriptor) == []


def test_binance_spot_kline_has_no_native_ws_route() -> None:
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

    assert transport._get_ws_base_urls_for_descriptor(adapter, descriptor, "spot") == []
    assert transport.create_provider_session(descriptor) is not None
