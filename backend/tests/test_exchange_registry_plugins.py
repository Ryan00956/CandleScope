from app.data_engine.backfill.config import BackfillConfig
from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.models import StreamDescriptor, StreamType
from app.data_engine.ingestion.normalizers.binance import BinanceNormalizer
from app.data_engine.ingestion.normalizers.okx import OkxNormalizer
from app.exchanges.pagination import OkxHistoricalPaginationPolicy, ReverseTimePaginationPolicy
from app.exchanges.protocol import AdapterBackedProtocol
from app.exchanges import bootstrap_default_adapters, get_exchange_registry
from app.exchanges.plugins.binance.protocol import BinanceExchangeProtocol
from app.exchanges.plugins.okx.protocol import OkxExchangeProtocol


def test_registry_keeps_adapter_api_and_exposes_plugins() -> None:
    bootstrap_default_adapters()
    registry = get_exchange_registry()

    adapter = registry.get("binance")
    plugin = registry.get_plugin("binance")

    assert adapter.id == "binance"
    assert plugin.adapter() is adapter
    assert [item.id for item in registry.list()] == ["binance", "okx"]
    assert [item.id for item in registry.list_plugins()] == ["binance", "okx"]
    diagnostics = registry.diagnostics()
    assert diagnostics["count"] >= 2
    statuses = {item["plugin_id"]: item for item in diagnostics["plugins"]}
    assert statuses["binance"]["capability_summary"] == {
        "channel_declarations": 10,
        "market_channel_pairs": 12,
        "realtime_pairs": 12,
        "history_pairs": 4,
        "websocket_pairs": 12,
        "ordered_delta_pairs": 0,
    }
    assert statuses["okx"]["capability_summary"] == {
        "channel_declarations": 3,
        "market_channel_pairs": 4,
        "realtime_pairs": 4,
        "history_pairs": 2,
        "websocket_pairs": 4,
        "ordered_delta_pairs": 0,
    }


def test_builtin_plugins_create_exchange_normalizers() -> None:
    bootstrap_default_adapters()
    registry = get_exchange_registry()
    config = IngestionConfig()

    binance_descriptor = StreamDescriptor("BTCUSDT", StreamType.KLINE, interval="1m")
    okx_descriptor = StreamDescriptor(
        "BTC-USDT",
        StreamType.KLINE,
        interval="1m",
        exchange="okx",
    )

    assert isinstance(
        registry.get_plugin("binance").normalizer(config, binance_descriptor),
        BinanceNormalizer,
    )
    assert isinstance(
        registry.get_plugin("okx").normalizer(config, okx_descriptor),
        OkxNormalizer,
    )


def test_builtin_plugins_own_symbol_and_rate_limit_policies() -> None:
    bootstrap_default_adapters()
    registry = get_exchange_registry()
    config = BackfillConfig(
        fetch_concurrency=3,
        fetch_rate_limit_delay=0.25,
        fetch_binance_futures_concurrency=1,
        fetch_binance_futures_rate_limit_delay=1.5,
        fetch_okx_concurrency=1,
        fetch_okx_rate_limit_delay=0.8,
    )

    assert (
        registry.get_plugin("binance")
        .symbol_normalizer()
        .normalize("BTC-USDT-SWAP", "futures")
        == "BTCUSDT"
    )
    assert (
        registry.get_plugin("okx")
        .symbol_normalizer()
        .normalize("BTC-USDT", "spot")
        == "BTC-USDT"
    )

    binance_policy = registry.get_plugin("binance").rate_limit_policy(config)
    okx_policy = registry.get_plugin("okx").rate_limit_policy(config)

    assert binance_policy.concurrency_for("spot") == 3
    assert binance_policy.delay_for("spot") == 0.25
    assert binance_policy.concurrency_for("futures") == 1
    assert binance_policy.delay_for("futures") == 1.5
    assert okx_policy.concurrency_for("spot") == 1
    assert okx_policy.delay_for("spot") == 0.8
    assert registry.get_plugin("binance").price_stream_type("spot") == StreamType.MINI_TICKER
    assert registry.get_plugin("okx").price_stream_type("spot") == StreamType.TICKER


def test_builtin_plugins_use_concrete_protocols_and_pagination_policies() -> None:
    bootstrap_default_adapters()
    registry = get_exchange_registry()

    binance = registry.get_plugin("binance")
    okx = registry.get_plugin("okx")

    assert isinstance(binance.protocol(), BinanceExchangeProtocol)
    assert isinstance(okx.protocol(), OkxExchangeProtocol)
    assert isinstance(binance.pagination_policy(BackfillConfig()), ReverseTimePaginationPolicy)
    assert isinstance(okx.pagination_policy(BackfillConfig()), OkxHistoricalPaginationPolicy)

    binance_capabilities = binance.capabilities().to_dict()
    okx_capabilities = okx.capabilities().to_dict()
    assert binance_capabilities["plugin_api_version"] == "1.0"
    assert "ws.futures_route_split" in binance_capabilities["protocol_features"]
    assert okx_capabilities["ws_connection_model"] == "shared_multiplex"
    assert okx_capabilities["limits"]["rest.kline.max_limit"] == 300


def test_adapter_backed_protocol_sanitizes_configured_endpoints() -> None:
    class _Adapter:
        def get_http_base_urls(self, market_type="spot", config=None):
            return [
                "https://www.okx.com",
                "https://aws.okx.com",
                "https://www.okx.com",
                "",
            ]

        def get_ws_base_urls(self, market_type="spot", config=None):
            return [
                "wss://ws.okx.com:8443/ws/v5/business",
                "wss://wsaws.okx.com:8443/ws/v5/business",
                "wss://ws.okx.com:8443/ws/v5/business",
                "",
            ]

    protocol = AdapterBackedProtocol(
        _Adapter(),
        blocked_http_substrings=("aws.okx.com",),
        blocked_ws_substrings=("wsaws.okx.com",),
    )

    assert protocol.rest_base_urls() == ["https://www.okx.com"]
    assert protocol.ws_base_urls(StreamDescriptor("BTC-USDT", StreamType.KLINE)) == [
        "wss://ws.okx.com:8443/ws/v5/business",
    ]
