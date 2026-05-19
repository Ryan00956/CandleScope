from __future__ import annotations

import sys

import pytest

from app.data_engine.ingestion.models import DataSource, MarketEvent, StreamType
from app.exchanges.contracts import NormalizerContractSample, validate_exchange_plugin_contract
from app.exchanges.loader import load_external_plugins_from_env
from app.exchanges.models import ExchangeCapabilities
from app.exchanges.registry import ExchangePluginRegistrationError, ExchangeRegistry
from app.exchanges import bootstrap_default_adapters, get_exchange_registry
from tests.fixtures.exchanges.contract_cases import builtin_exchange_contract_cases


def test_builtin_exchange_plugins_satisfy_runtime_contracts() -> None:
    bootstrap_default_adapters()
    registry = get_exchange_registry()

    for plugin_id, plugin_cases in builtin_exchange_contract_cases().items():
        report = validate_exchange_plugin_contract(
            registry.get_plugin(plugin_id),
            plugin_cases,
        )
        assert report.ok, report.to_dict()


def test_registry_rejects_future_major_plugin_api_version() -> None:
    registry = ExchangeRegistry()

    class FutureAdapter:
        id = "future"
        name = "Future"

        def capabilities(self) -> ExchangeCapabilities:
            return ExchangeCapabilities(
                exchange="future",
                name="Future",
                plugin_api_version="2.0",
            )

    with pytest.raises(ExchangePluginRegistrationError):
        registry.register(FutureAdapter())

    diagnostics = registry.diagnostics()
    assert diagnostics["plugins"][0]["status"] == "error"
    assert "unsupported exchange plugin API" in diagnostics["plugins"][0]["error"]


def test_external_plugin_loader_records_loaded_and_failed_specs(tmp_path, monkeypatch) -> None:
    plugin_module = tmp_path / "external_exchange.py"
    plugin_module.write_text(
        """
from app.exchanges.plugins.binance.plugin import BinancePlugin

def create_plugin():
    plugin = BinancePlugin()
    plugin.id = "external_binance"
    plugin._adapter.id = "external_binance"
    return plugin
""",
        encoding="utf-8",
    )
    monkeypatch.syspath_prepend(str(tmp_path))

    registry = ExchangeRegistry()
    load_external_plugins_from_env(
        registry,
        env_value="external_exchange,missing_exchange_plugin",
    )

    diagnostics = registry.diagnostics()
    by_id = {item["plugin_id"]: item for item in diagnostics["plugins"]}
    assert by_id["external_binance"]["status"] == "loaded"
    assert by_id["missing_exchange_plugin"]["status"] == "error"
    assert "external_exchange" in sys.modules


def test_contract_harness_rejects_incomplete_normalizer_output() -> None:
    bootstrap_default_adapters()
    registry = get_exchange_registry()
    case = builtin_exchange_contract_cases()["binance"][0]

    class BrokenNormalizer:
        def parse(self, msg):
            return MarketEvent(
                event_type=StreamType.KLINE,
                symbol="BTCUSDT",
                exchange="binance",
                event_time_ms=msg.received_at_ms,
                received_at_ms=msg.received_at_ms,
                source=DataSource.HTTP_BACKFILL,
                data={"open_time": 1},
            )

    class BrokenPlugin:
        id = "binance"
        name = "Broken Binance"

        def __init__(self, base_plugin):
            self._base = base_plugin

        def adapter(self):
            return self._base.adapter()

        def capabilities(self):
            return self._base.capabilities()

        def protocol(self):
            return self._base.protocol()

        def normalizer(self, config, descriptor):
            return BrokenNormalizer()

        def symbol_normalizer(self):
            return self._base.symbol_normalizer()

        def rate_limit_policy(self, config=None):
            return self._base.rate_limit_policy(config)

        def pagination_policy(self, config=None):
            return self._base.pagination_policy(config)

        def realtime_policy(self):
            return self._base.realtime_policy()

        def price_stream_type(self, market_type="spot"):
            return self._base.price_stream_type(market_type)

    case.normalizer_samples.append(
        NormalizerContractSample(
            payload=[1, "1", "2", "0.5", "1.5", "10", 60_000, "15", 1, "6", "9", "0"],
            source=DataSource.HTTP_BACKFILL,
        )
    )
    report = validate_exchange_plugin_contract(
        BrokenPlugin(registry.get_plugin("binance")),
        [case],
    )

    assert not report.ok
    assert any(issue.code == "normalizer.data_fields_missing" for issue in report.issues)
