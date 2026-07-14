from __future__ import annotations

from types import MappingProxyType, SimpleNamespace

import pytest

from app.data_engine.market_data import DeliveryClass, MarketChannel, TransportMode
from app.exchanges.contracts import validate_exchange_capabilities
from app.exchanges.models import (
    ExchangeCapabilities,
    ExchangeMarket,
    MarketChannelCapability,
    serialize_exchange_capabilities,
)
from app.exchanges.registry import ExchangePluginRegistrationError, ExchangeRegistry


def _kline_capability(**overrides) -> MarketChannelCapability:
    values = {
        "channel": MarketChannel.KLINE,
        "market_types": ("spot",),
        "realtime": True,
        "history": True,
        "realtime_transports": (TransportMode.WEBSOCKET,),
        "history_transports": (TransportMode.REST_HISTORY,),
        "delivery": DeliveryClass.APPEND,
        "snapshot": True,
        "sequence": "timestamp",
        "resync": "replace_snapshot",
        "params": {"interval": ["1m"]},
        "available_fields": ("open_time", "open", "high", "low", "close", "volume"),
        "connection_model": "path_per_stream",
    }
    values.update(overrides)
    return MarketChannelCapability(**values)


def _v2_capabilities(*channels: object) -> ExchangeCapabilities:
    return ExchangeCapabilities(
        exchange="test",
        name="Test",
        capability_schema_version=2,
        markets=[ExchangeMarket("spot", "spot", "Spot")],
        native_intervals=["1m"],
        channels=list(channels or (_kline_capability(),)),  # type: ignore[list-item]
    )


def _channel_namespace(**overrides: object) -> SimpleNamespace:
    valid = _kline_capability()
    values = {
        field_name: getattr(valid, field_name)
        for field_name in valid.__dataclass_fields__
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def test_channels_field_is_appended_after_all_schema_v1_positional_fields() -> None:
    markets = [ExchangeMarket("spot", "spot", "Spot")]
    capabilities = ExchangeCapabilities(
        "legacy",
        "Legacy",
        "1.0",
        1,
        markets,
        ["1m"],
        True,
        False,
        "polling_only",
        ["rest.kline"],
        {"rest.max_limit": 100},
        ["legacy limitation"],
    )

    assert capabilities.native_intervals == ["1m"]
    assert capabilities.supports_multi_symbol_ticker is True
    assert capabilities.known_limitations == ["legacy limitation"]
    assert capabilities.channels == []


def test_legacy_v1_serializer_adds_empty_unknown_channel_shape() -> None:
    class LegacyCapabilities:
        exchange = "legacy"
        plugin_api_version = "1.0"
        capability_schema_version = 1

        def to_dict(self) -> dict:
            return {
                "exchange": self.exchange,
                "plugin_api_version": self.plugin_api_version,
                "capability_schema_version": self.capability_schema_version,
            }

    payload = serialize_exchange_capabilities(LegacyCapabilities())

    assert payload["capability_schema_version"] == 1
    assert payload["channels"] == []


def test_registry_accepts_and_snapshots_external_schema_v1_capabilities() -> None:
    class LegacyCapabilities:
        exchange = "legacy"
        name = "Legacy"
        plugin_api_version = "1.0"
        ws_connection_model = "path_per_stream"

        def __init__(self) -> None:
            self.native_intervals = ["1m"]
            self.limits = MappingProxyType({"rest.max_limit": 1000})

        def to_dict(self) -> dict:
            return {
                "exchange": self.exchange,
                "name": self.name,
                "plugin_api_version": self.plugin_api_version,
                "native_intervals": list(self.native_intervals),
                "ws_connection_model": self.ws_connection_model,
                "limits": dict(self.limits),
            }

    class Component:
        endpoint_rules: tuple = ()

    component = Component()

    class LegacyPlugin:
        id = "legacy"
        name = "Legacy"

        def __init__(self) -> None:
            self.document = LegacyCapabilities()

        def capabilities(self) -> LegacyCapabilities:
            return self.document

        def adapter(self) -> Component:
            return component

        def protocol(self) -> Component:
            return component

        def rate_limit_policy(self) -> Component:
            return component

        def pagination_policy(self) -> Component:
            return component

        def realtime_policy(self) -> Component:
            return component

        def symbol_normalizer(self) -> Component:
            return component

    plugin = LegacyPlugin()
    registry = ExchangeRegistry()
    registry.register(plugin, source="test:legacy")  # type: ignore[arg-type]
    plugin.document.native_intervals.append("5m")

    payload = serialize_exchange_capabilities(registry.get_capabilities("legacy"))
    diagnostics = registry.diagnostics()["plugins"][0]
    assert payload["capability_schema_version"] == 1
    assert payload["channels"] == []
    assert payload["native_intervals"] == ["1m"]
    assert payload["limits"] == {"rest.max_limit": 1000}
    assert diagnostics["capability_summary"]["market_channel_pairs"] == 0


def test_registry_does_not_partially_register_when_status_construction_fails() -> None:
    class FailingAdapter:
        id = "failing"
        name = "Failing"

        def capabilities(self) -> ExchangeCapabilities:
            return ExchangeCapabilities(
                exchange=self.id,
                name=self.name,
                native_intervals=["1m"],
            )

        def adapter(self) -> FailingAdapter:
            return self

        def rate_limit_policy(self) -> object:
            raise RuntimeError("status construction failed")

    registry = ExchangeRegistry()

    with pytest.raises(RuntimeError, match="status construction failed"):
        registry.register(FailingAdapter())  # type: ignore[arg-type]

    assert not registry.has("failing")
    diagnostics = registry.diagnostics()
    assert diagnostics["count"] == 1
    assert diagnostics["plugins"][0]["status"] == "error"


def test_schema_v2_support_queries_are_market_and_transport_specific() -> None:
    capabilities = _v2_capabilities()

    assert capabilities.supports_channel("KLINE", "SPOT")
    assert capabilities.supports_channel(
        MarketChannel.KLINE,
        "spot",
        transport="websocket",
    )
    assert capabilities.supports_channel(
        MarketChannel.KLINE,
        "spot",
        transport=TransportMode.REST_HISTORY,
        history=True,
    )
    assert not capabilities.supports_channel(MarketChannel.KLINE, "futures")


@pytest.mark.parametrize("schema_version", [0, -1, 3, "2", True])
def test_capability_validator_rejects_invalid_schema_versions(schema_version: object) -> None:
    capabilities = _v2_capabilities()
    capabilities.capability_schema_version = schema_version  # type: ignore[assignment]

    report = validate_exchange_capabilities(capabilities, plugin_id="test")

    assert not report.ok
    assert any("schema_version" in issue.code for issue in report.issues)


@pytest.mark.parametrize(
    ("channels", "expected_code"),
    [
        (
            [_kline_capability(), _kline_capability()],
            "capabilities.channel_duplicate",
        ),
        (
            [_kline_capability(market_types=("futures",))],
            "capabilities.channel_market_unknown",
        ),
        (
            [
                _kline_capability(
                    delivery=DeliveryClass.ORDERED_DELTA,
                    delta=False,
                ),
            ],
            "capabilities.ordered_delta_flag_missing",
        ),
        (
            [
                _kline_capability(
                    delivery=DeliveryClass.ORDERED_DELTA,
                    delta=True,
                    resync="none",
                ),
            ],
            "capabilities.delta_resync_missing",
        ),
        (
            [
                _kline_capability(
                    channel=MarketChannel.DEPTH,
                    params={"depth_levels": [20, 5]},
                ),
            ],
            "capabilities.depth_levels_invalid",
        ),
        (
            [_kline_capability(update_intervals_ms=(1000, 100))],
            "capabilities.update_intervals_not_canonical",
        ),
    ],
)
def test_capability_validator_rejects_malformed_channel_documents(
    channels: list[MarketChannelCapability],
    expected_code: str,
) -> None:
    report = validate_exchange_capabilities(_v2_capabilities(*channels), plugin_id="test")

    assert not report.ok
    assert any(issue.code == expected_code for issue in report.issues)


def test_capability_validator_rejects_unknown_delivery_value() -> None:
    malformed = _channel_namespace(delivery="lossy_magic")

    report = validate_exchange_capabilities(_v2_capabilities(malformed), plugin_id="test")

    assert not report.ok
    assert any(issue.code == "capabilities.delivery_unknown" for issue in report.issues)


@pytest.mark.parametrize(
    ("overrides", "expected_code"),
    [
        ({"snapshot": "false"}, "capabilities.channel_flag_invalid"),
        ({"available_fields": "last_price"}, "capabilities.channel_fields_invalid"),
        ({"available_fields": (123,)}, "capabilities.channel_fields_invalid"),
        ({"derived_fields": "volume_delta_base"}, "capabilities.channel_fields_invalid"),
    ],
)
def test_capability_validator_rejects_malformed_flags_and_fields(
    overrides: dict[str, object],
    expected_code: str,
) -> None:
    malformed = _channel_namespace(**overrides)

    report = validate_exchange_capabilities(_v2_capabilities(malformed), plugin_id="test")

    assert not report.ok
    assert any(issue.code == expected_code for issue in report.issues)


@pytest.mark.parametrize(
    "field_name",
    ["market_types", "available_fields", "derived_fields", "known_limitations"],
)
def test_channel_model_rejects_bare_string_collections(field_name: str) -> None:
    with pytest.raises(TypeError, match="iterable of strings"):
        _kline_capability(**{field_name: "spot"})


@pytest.mark.parametrize("schema_version", [0, -1, 3, "2", True])
def test_registry_rejects_invalid_capability_schema_versions(schema_version: object) -> None:
    class Adapter:
        id = "test"
        name = "Test"

        def capabilities(self) -> ExchangeCapabilities:
            capabilities = _v2_capabilities()
            capabilities.capability_schema_version = schema_version  # type: ignore[assignment]
            return capabilities

    with pytest.raises(ExchangePluginRegistrationError):
        ExchangeRegistry().register(Adapter())


def test_registry_reuses_the_capability_snapshot_validated_at_registration() -> None:
    class Adapter:
        id = "test"
        name = "Test"

        def __init__(self) -> None:
            self.calls = 0

        def capabilities(self) -> ExchangeCapabilities:
            self.calls += 1
            return _v2_capabilities()

    adapter = Adapter()
    registry = ExchangeRegistry()
    registry.register(adapter)

    assert adapter.calls == 1
    first = registry.get_capabilities("TEST")
    assert first.capability_schema_version == 2
    first.channels.clear()
    assert registry.get_capabilities("test").channels
    assert adapter.calls == 1
