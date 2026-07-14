from __future__ import annotations

from dataclasses import replace
from typing import Any

import pytest

from app.data_engine.ingestion.models import (
    DataSource,
    StreamDescriptor,
    StreamType,
    TransportRequest,
)
from app.data_engine.market_data import DeliveryClass, MarketChannel, TransportMode
from app.exchanges import bootstrap_default_adapters, get_exchange_registry
from app.exchanges.contracts import validate_exchange_plugin_contract
from app.exchanges.models import ExchangeCapabilities
from app.exchanges.registry import ExchangePluginRegistrationError, ExchangeRegistry
from tests.fixtures.exchanges.contract_cases import (
    ChannelCapabilityExpectation,
    builtin_exchange_channel_expectations,
    builtin_exchange_contract_cases,
    contract_case_channel_key,
)


def test_builtin_capability_v2_declares_exact_market_channel_matrix() -> None:
    bootstrap_default_adapters()
    registry = get_exchange_registry()
    expected_by_exchange = builtin_exchange_channel_expectations()

    assert set(expected_by_exchange) == {"binance", "okx"}
    for exchange, expected in expected_by_exchange.items():
        capabilities = registry.get_plugin(exchange).capabilities()
        assert capabilities.capability_schema_version == 2

        actual = _expanded_capabilities(capabilities)
        assert set(actual) == set(expected)
        for identity, expected_channel in expected.items():
            _assert_channel_matches(actual[identity], expected_channel)


def test_every_declared_builtin_channel_has_exactly_one_contract_fixture() -> None:
    bootstrap_default_adapters()
    registry = get_exchange_registry()
    cases_by_exchange = builtin_exchange_contract_cases()
    expected_by_exchange = builtin_exchange_channel_expectations()

    for exchange, expected in expected_by_exchange.items():
        fixture_keys = [contract_case_channel_key(case) for case in cases_by_exchange[exchange]]
        assert len(fixture_keys) == len(set(fixture_keys)), fixture_keys
        assert set(fixture_keys) == set(expected)

        capabilities = registry.get_plugin(exchange).capabilities()
        declared = set(_expanded_capabilities(capabilities))
        assert declared == set(fixture_keys)

        for case in cases_by_exchange[exchange]:
            assert case.request.descriptor is case.descriptor
            assert case.normalizer_samples
            expected_sources = {DataSource.WEBSOCKET, DataSource.HTTP}
            if case.descriptor.stream_type.value in {"kline", "aggTrade"}:
                expected_sources.add(DataSource.HTTP_BACKFILL)
            assert {sample.source for sample in case.normalizer_samples} == expected_sources


def test_builtin_capability_fixture_matrix_passes_full_plugin_contract() -> None:
    bootstrap_default_adapters()
    registry = get_exchange_registry()

    for exchange, cases in builtin_exchange_contract_cases().items():
        report = validate_exchange_plugin_contract(registry.get_plugin(exchange), cases)
        assert report.ok, report.to_dict()
        assert report.cases_checked == len(
            builtin_exchange_channel_expectations()[exchange]
        )


def test_contract_rejects_duplicate_market_channel_fixtures() -> None:
    bootstrap_default_adapters()
    plugin = get_exchange_registry().get_plugin("binance")
    cases = builtin_exchange_contract_cases()["binance"]

    report = validate_exchange_plugin_contract(plugin, [*cases, cases[0]])

    assert not report.ok
    assert "capabilities.channel_fixture_duplicate" in _issue_codes(report)


def test_contract_only_invokes_transports_declared_by_schema_v2() -> None:
    bootstrap_default_adapters()
    base_plugin = get_exchange_registry().get_plugin("binance")
    base_capabilities = base_plugin.capabilities()
    spot_kline = base_capabilities.channel_capability(MarketChannel.KLINE, "spot")
    assert spot_kline is not None
    rest_only_kline = replace(
        spot_kline,
        realtime_transports=(TransportMode.REST_POLL,),
        connection_model="polling_only",
    )
    capabilities = replace(base_capabilities, channels=[rest_only_kline])
    case = builtin_exchange_contract_cases()["binance"][0]
    case.normalizer_samples = [
        sample
        for sample in case.normalizer_samples
        if sample.source is not DataSource.WEBSOCKET
    ]

    class RestOnlyProtocol:
        def __init__(self, base: Any) -> None:
            self._base = base

        def ws_connection(self, descriptor: Any) -> Any:
            raise AssertionError("WebSocket must not be probed for a REST-only channel")

        def __getattr__(self, name: str) -> Any:
            return getattr(self._base, name)

    class RestOnlyPlugin(_CapabilityOverridePlugin):
        def protocol(self) -> Any:
            return RestOnlyProtocol(self._base_plugin.protocol())

    report = validate_exchange_plugin_contract(
        RestOnlyPlugin(base_plugin, capabilities),
        [case],
    )

    assert report.ok, report.to_dict()


def test_okx_kline_marks_synthetic_zero_fields_unavailable() -> None:
    bootstrap_default_adapters()
    capabilities = get_exchange_registry().get_plugin("okx").capabilities()

    for market_type in ("spot", "futures"):
        kline = capabilities.channel_capability(MarketChannel.KLINE, market_type)
        assert kline is not None
        assert set(kline.unavailable_fields) == {
            "trades",
            "taker_buy_base",
            "taker_buy_quote",
        }
        assert set(kline.available_fields).isdisjoint(kline.unavailable_fields)
        assert kline.derived_fields == ()


def test_market_specific_capabilities_do_not_advertise_synthetic_ticker_fields() -> None:
    bootstrap_default_adapters()
    registry = get_exchange_registry()

    binance_futures = registry.get_plugin("binance").capabilities().channel_capability(
        MarketChannel.TICKER,
        "futures",
    )
    assert binance_futures is not None
    assert set(binance_futures.unavailable_fields) == {
        "prev_close_price",
        "bid_price",
        "bid_qty",
        "ask_price",
        "ask_qty",
    }
    assert set(binance_futures.available_fields).isdisjoint(
        binance_futures.unavailable_fields
    )

    okx_futures = registry.get_plugin("okx").capabilities().channel_capability(
        MarketChannel.TICKER,
        "futures",
    )
    assert okx_futures is not None
    assert okx_futures.unavailable_fields == ("quote_volume",)
    assert "quote_volume" not in okx_futures.available_fields


def test_builtin_depth_is_replaceable_snapshot_not_ordered_delta() -> None:
    bootstrap_default_adapters()
    registry = get_exchange_registry()

    for market_type in ("spot", "futures"):
        depth = registry.get_plugin("binance").capabilities().channel_capability(
            MarketChannel.DEPTH,
            market_type,
        )
        assert depth is not None
        assert depth.delivery is DeliveryClass.SNAPSHOT
        assert depth.snapshot is True
        assert depth.delta is False
        assert depth.sequence == "monotonic_id"
        assert depth.resync == "replace_snapshot"
        assert depth.params == {"depth_levels": [5, 10, 20]}

    okx = registry.get_plugin("okx").capabilities()
    assert okx.channel_capability(MarketChannel.DEPTH, "spot") is None
    assert okx.channel_capability(MarketChannel.DEPTH, "futures") is None


@pytest.mark.parametrize(
    ("market_type", "expected_limit"),
    [("spot", 5000), ("futures", 1000)],
)
def test_binance_depth_request_respects_market_specific_limit(
    market_type: str,
    expected_limit: int,
) -> None:
    bootstrap_default_adapters()
    descriptor = StreamDescriptor(
        "BTCUSDT",
        StreamType.DEPTH,
        depth_levels=20,
        exchange="binance",
        market_type=market_type,
    )

    request = get_exchange_registry().get_plugin("binance").protocol().rest_request(
        TransportRequest(descriptor, limit=5000)
    )

    assert request is not None
    assert request.params["limit"] == expected_limit


@pytest.mark.parametrize("market_type", ["spot", "futures"])
def test_binance_recent_trade_request_omits_unsupported_time_range(
    market_type: str,
) -> None:
    bootstrap_default_adapters()
    descriptor = StreamDescriptor(
        "BTCUSDT",
        StreamType.TRADE,
        exchange="binance",
        market_type=market_type,
    )

    request = get_exchange_registry().get_plugin("binance").protocol().rest_request(
        TransportRequest(
            descriptor,
            limit=5000,
            start_ms=1_700_000_000_000,
            end_ms=1_700_000_060_000,
        )
    )

    assert request is not None
    assert request.params == {"symbol": "BTCUSDT", "limit": 1000}


def test_binance_recent_trade_fixture_does_not_invent_websocket_order_ids() -> None:
    trade_cases = [
        case
        for case in builtin_exchange_contract_cases()["binance"]
        if case.descriptor.stream_type is StreamType.TRADE
    ]

    assert len(trade_cases) == 2
    for case in trade_cases:
        row = case.sample_http_payload[0]
        assert "buyerOrderId" not in row
        assert "sellerOrderId" not in row


def test_contract_rejects_schema_v2_without_channel_declarations() -> None:
    bootstrap_default_adapters()
    base_plugin = get_exchange_registry().get_plugin("binance")
    malformed = replace(
        base_plugin.capabilities(),
        capability_schema_version=2,
        channels=[],
    )

    report = validate_exchange_plugin_contract(
        _CapabilityOverridePlugin(base_plugin, malformed),
        [],
    )

    assert not report.ok
    assert "capabilities.channels_missing" in _issue_codes(report)


def test_contract_rejects_delta_channel_without_sequence_or_resync() -> None:
    bootstrap_default_adapters()
    base_plugin = get_exchange_registry().get_plugin("binance")
    base_capabilities = base_plugin.capabilities()
    depth = next(
        item for item in base_capabilities.channels if item.channel is MarketChannel.DEPTH
    )
    malformed_depth = replace(
        depth,
        delivery=DeliveryClass.ORDERED_DELTA,
        delta=True,
        sequence="none",
        resync="none",
    )
    malformed = replace(base_capabilities, channels=[malformed_depth])
    depth_cases = [
        case
        for case in builtin_exchange_contract_cases()["binance"]
        if contract_case_channel_key(case)[1] is MarketChannel.DEPTH
    ]

    report = validate_exchange_plugin_contract(
        _CapabilityOverridePlugin(base_plugin, malformed),
        depth_cases,
    )

    assert not report.ok
    codes = _issue_codes(report)
    assert "capabilities.delta_sequence_missing" in codes
    assert "capabilities.delta_resync_missing" in codes


def test_registry_rejects_future_capability_schema_version() -> None:
    registry = ExchangeRegistry()

    class FutureSchemaAdapter:
        id = "future-schema"
        name = "Future Schema"

        def capabilities(self) -> ExchangeCapabilities:
            return ExchangeCapabilities(
                exchange=self.id,
                name=self.name,
                capability_schema_version=3,
            )

    with pytest.raises(ExchangePluginRegistrationError, match="capability schema 3"):
        registry.register(FutureSchemaAdapter())


def _expanded_capabilities(capabilities: Any) -> dict[tuple[str, MarketChannel], Any]:
    expanded: dict[tuple[str, MarketChannel], Any] = {}
    for channel in capabilities.channels:
        for market_type in channel.market_types:
            identity = (market_type, channel.channel)
            assert identity not in expanded, identity
            expanded[identity] = channel
    return expanded


def _assert_channel_matches(
    actual: Any,
    expected: ChannelCapabilityExpectation,
) -> None:
    assert actual.realtime is True
    assert actual.realtime_transports == (
        TransportMode.WEBSOCKET,
        TransportMode.REST_POLL,
    )
    assert actual.history is expected.history
    assert actual.history_transports == (
        (TransportMode.REST_HISTORY,) if expected.history else ()
    )
    assert actual.delivery is expected.delivery
    assert actual.snapshot is expected.snapshot
    assert actual.delta is expected.delta
    assert actual.sequence == expected.sequence
    assert actual.resync == expected.resync
    assert actual.connection_model == expected.connection_model
    assert set(actual.available_fields) == set(expected.available_fields)
    assert set(actual.unavailable_fields) == set(expected.unavailable_fields)
    assert set(actual.derived_fields) == set(expected.derived_fields)
    assert _frozen_params(actual.params) == expected.params
    assert actual.update_intervals_ms == expected.update_intervals_ms
    assert tuple(sorted(actual.limits.items())) == expected.limits
    assert actual.known_limitations == expected.known_limitations


def _frozen_params(params: dict[str, Any]) -> tuple[tuple[str, tuple[Any, ...]], ...]:
    return tuple(
        (key, tuple(value) if isinstance(value, (list, tuple)) else (value,))
        for key, value in sorted(params.items())
    )


def _issue_codes(report: Any) -> set[str]:
    return {issue.code for issue in report.issues}


class _CapabilityOverridePlugin:
    def __init__(self, base_plugin: Any, capabilities: ExchangeCapabilities) -> None:
        self._base_plugin = base_plugin
        self._capabilities = capabilities
        self.id = base_plugin.id
        self.name = base_plugin.name

    def capabilities(self) -> ExchangeCapabilities:
        return self._capabilities

    def __getattr__(self, name: str) -> Any:
        return getattr(self._base_plugin, name)
