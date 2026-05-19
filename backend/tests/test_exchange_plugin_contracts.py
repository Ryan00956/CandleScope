from __future__ import annotations

import sys

import pytest

from app.data_engine.ingestion.models import StreamDescriptor, StreamType, TransportRequest
from app.exchanges.contracts import ExchangeContractCase, validate_exchange_plugin_contract
from app.exchanges.loader import load_external_plugins_from_env
from app.exchanges.models import ExchangeCapabilities
from app.exchanges.registry import ExchangePluginRegistrationError, ExchangeRegistry
from app.exchanges import bootstrap_default_adapters, get_exchange_registry


def test_builtin_exchange_plugins_satisfy_runtime_contracts() -> None:
    bootstrap_default_adapters()
    registry = get_exchange_registry()

    cases = {
        "binance": [
            ExchangeContractCase(
                descriptor=StreamDescriptor(
                    "BTCUSDT",
                    StreamType.KLINE,
                    interval="1m",
                    exchange="binance",
                    market_type="spot",
                ),
                request=TransportRequest(
                    StreamDescriptor(
                        "BTCUSDT",
                        StreamType.KLINE,
                        interval="1m",
                        exchange="binance",
                        market_type="spot",
                    ),
                    limit=100,
                    start_ms=1_700_000_000_000,
                    end_ms=1_700_000_060_000,
                ),
                sample_http_payload=[
                    [
                        1_700_000_000_000,
                        "1",
                        "2",
                        "0.5",
                        "1.5",
                        "10",
                        1_700_000_059_999,
                    ],
                ],
                expected_http_rows=1,
            )
        ],
        "okx": [
            ExchangeContractCase(
                descriptor=StreamDescriptor(
                    "BTC-USDT",
                    StreamType.KLINE,
                    interval="1m",
                    exchange="okx",
                    market_type="spot",
                ),
                request=TransportRequest(
                    StreamDescriptor(
                        "BTC-USDT",
                        StreamType.KLINE,
                        interval="1m",
                        exchange="okx",
                        market_type="spot",
                    ),
                    limit=100,
                    start_ms=1_700_000_000_000,
                    end_ms=1_700_000_060_000,
                ),
                sample_http_payload={
                    "code": "0",
                    "data": [
                        ["1700000060000", "1", "2", "0.5", "1.5", "10"],
                        ["1700000000000", "1", "2", "0.5", "1.5", "10"],
                    ],
                },
                expected_http_rows=2,
            )
        ],
    }

    for plugin_id, plugin_cases in cases.items():
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
