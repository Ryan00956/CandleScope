from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

from app.api.v1 import symbols as symbols_api
from app.data_engine.market_data import (
    DeliveryClass,
    MarketChannel,
    TransportMode,
)
from app.exchanges.contracts import validate_exchange_capabilities
from app.exchanges.models import (
    CRYPTO_24X7_CALENDAR_ID,
    ExchangeCapabilities,
    ExchangeMarket,
    HistoryCadence,
    HistoryEmptyPageSemantics,
    MarketChannelCapability,
    SymbolInfo,
)
from app.exchanges.plugins.binance.adapter import BinanceExchangeAdapter
from app.exchanges.plugins.okx.adapter import OkxExchangeAdapter


def _historical_kline_capability(**overrides: object) -> MarketChannelCapability:
    values: dict[str, object] = {
        "channel": MarketChannel.KLINE,
        "market_types": ("spot",),
        "realtime": False,
        "history": True,
        "history_transports": (TransportMode.REST_HISTORY,),
        "delivery": DeliveryClass.APPEND,
        "snapshot": True,
        "sequence": "timestamp",
        "resync": "replace_snapshot",
        "available_fields": ("open_time", "close"),
        "limits": {"history.max_age_ms": 86_400_000, "rest.max_limit": 1000},
    }
    values.update(overrides)
    return MarketChannelCapability(**values)  # type: ignore[arg-type]


def test_history_policy_migrates_legacy_dotted_limits_without_removing_them() -> None:
    capability = _historical_kline_capability()

    assert capability.limits == {
        "history.max_age_ms": 86_400_000,
        "rest.max_limit": 1000,
    }
    assert capability.history_policy is not None
    assert capability.history_policy.max_age_ms == 86_400_000
    assert capability.history_policy.max_page_size == 1000
    payload = capability.to_dict()
    assert payload["limits"] == capability.limits
    assert payload["history_policy"]["max_age_ms"] == 86_400_000
    assert payload["history_policy"]["max_page_size"] == 1000


def test_schema_v2_keeps_untyped_legacy_limits_backward_compatible() -> None:
    capability = _historical_kline_capability(
        limits={"history.max_age_ms": "30d", "rest.max_limit": "1000"},
    )
    capabilities = ExchangeCapabilities(
        exchange="test",
        name="Test",
        capability_schema_version=2,
        markets=[ExchangeMarket("spot", "spot", "Spot")],
        native_intervals=["1m"],
        channels=[capability],
    )

    assert capability.history_policy is not None
    assert capability.history_policy.max_age_ms is None
    assert capability.history_policy.max_page_size is None
    assert validate_exchange_capabilities(capabilities, plugin_id="test").ok


def test_schema_v3_requires_explicit_calendar_cadence_and_empty_semantics() -> None:
    capabilities = ExchangeCapabilities(
        exchange="test",
        name="Test",
        capability_schema_version=3,
        markets=[
            ExchangeMarket(
                "spot",
                "spot",
                "Spot",
                calendar_id=CRYPTO_24X7_CALENDAR_ID,
                timezone="UTC",
            ),
        ],
        native_intervals=["1m"],
        channels=[_historical_kline_capability()],
    )

    report = validate_exchange_capabilities(capabilities, plugin_id="test")
    codes = {issue.code for issue in report.issues}

    assert "capabilities.history_cadence_invalid" in codes
    assert "capabilities.history_empty_semantics_invalid" in codes


def test_builtin_v3_capabilities_expose_typed_history_contracts() -> None:
    for adapter in (BinanceExchangeAdapter(), OkxExchangeAdapter()):
        capabilities = adapter.capabilities()
        assert capabilities.capability_schema_version == 3
        assert all(
            market.calendar_id == CRYPTO_24X7_CALENDAR_ID
            and market.timezone == "UTC"
            for market in capabilities.markets
        )
        report = validate_exchange_capabilities(capabilities, plugin_id=adapter.id)
        assert report.ok, report.to_dict()
        for channel in capabilities.channels:
            if not channel.history:
                continue
            assert channel.history_policy is not None
            assert channel.history_policy.cadence is not HistoryCadence.UNKNOWN
            assert (
                channel.history_policy.empty_page_semantics
                is HistoryEmptyPageSemantics.AUTHORITATIVE_RANGE_EMPTY
            )

    binance_oi = BinanceExchangeAdapter().capabilities().channel_capability(
        MarketChannel.OPEN_INTEREST,
        "futures",
    )
    assert binance_oi is not None and binance_oi.history_policy is not None
    assert binance_oi.history_policy.max_age_ms == 2_592_000_000
    assert binance_oi.history_policy.max_page_size == 500


def test_binance_futures_maps_onboard_date_but_ignores_perpetual_delivery_placeholder() -> None:
    adapter = BinanceExchangeAdapter()
    adapter._fetch_exchange_info = AsyncMock(  # type: ignore[method-assign]
        return_value={
            "symbols": [
                {
                    "symbol": "BTCUSDT",
                    "baseAsset": "BTC",
                    "quoteAsset": "USDT",
                    "status": "TRADING",
                    "contractType": "PERPETUAL",
                    "onboardDate": 1_569_393_000_000,
                    "deliveryDate": 4_133_404_800_000,
                    "filters": [
                        {"filterType": "PRICE_FILTER", "tickSize": "0.10"},
                    ],
                },
            ],
        },
    )

    symbol = asyncio.run(adapter._load_futures_symbols())[0]
    payload = symbol.to_dict()

    assert symbol.listed_at_ms == 1_569_393_000_000
    assert symbol.expiry_at_ms is None
    assert payload["listedAtMs"] == 1_569_393_000_000
    assert payload["expiryAtMs"] is None
    assert payload["priceTickSize"] == "0.10"


def test_okx_maps_listing_continuous_trading_and_expiry_times() -> None:
    adapter = OkxExchangeAdapter()
    adapter._fetch_public_data = AsyncMock(  # type: ignore[method-assign]
        return_value=[
            {
                "instId": "BTC-USDT-SWAP",
                "baseCcy": "BTC",
                "settleCcy": "USDT",
                "state": "live",
                "ctType": "linear",
                "listTime": "1597026383085",
                "contTdSwTime": "1597026483085",
                "expTime": "1893456000000",
            },
        ],
    )

    symbol = asyncio.run(adapter._load_symbols("SWAP", "futures", "perpetual"))[0]
    payload = symbol.to_dict()

    assert symbol.listed_at_ms == 1_597_026_383_085
    assert symbol.continuous_trading_at_ms == 1_597_026_483_085
    assert symbol.expiry_at_ms == 1_893_456_000_000
    assert payload["continuousTradingAtMs"] == 1_597_026_483_085
    assert payload["expiryAtMs"] == 1_893_456_000_000


def test_symbol_refresh_retains_disappeared_instrument_for_sync_lookup(monkeypatch) -> None:
    class Adapter:
        id = "test"

        def __init__(self) -> None:
            self.symbols = [
                SymbolInfo("AAAUSDT", "AAA", "USDT", "TRADING", "test", "spot", "spot"),
                SymbolInfo(
                    "OLDUSDT",
                    "OLD",
                    "USDT",
                    "TRADING",
                    "test",
                    "spot",
                    "spot",
                    listed_at_ms=1_000,
                ),
            ]

        def capabilities(self) -> SimpleNamespace:
            return SimpleNamespace(markets=[SimpleNamespace(market_type="spot")])

        async def list_symbols(self, market_type: str) -> list[SymbolInfo]:
            return list(self.symbols)

    adapter = Adapter()
    registry = SimpleNamespace(list=lambda: [adapter])
    # Each successful refresh also schedules its TTL deadline from wall time.
    clock = iter((100.0, 100.0, 200.0, 200.0))
    monkeypatch.setattr(symbols_api, "bootstrap_default_adapters", lambda: None)
    monkeypatch.setattr(symbols_api, "get_exchange_registry", lambda: registry)
    monkeypatch.setattr(symbols_api.time, "time", lambda: next(clock))
    symbols_api._symbol_cache.clear()
    symbols_api._market_refresh_state.clear()
    symbols_api._market_refresh_tasks.clear()
    symbols_api._cache_loaded_at = 0.0
    try:
        asyncio.run(symbols_api.refresh_exchange_metadata())
        adapter.symbols = adapter.symbols[:1]
        asyncio.run(symbols_api.refresh_exchange_metadata(force=True))

        inactive = symbols_api.get_cached_symbol_metadata("test", "spot", "oldusdt")
        assert inactive is not None
        assert inactive["active"] is False
        assert inactive["listedAtMs"] == 1_000
        assert inactive["lastSeenAtMs"] == 100_000
        assert inactive["inactiveSinceMs"] == 200_000
        assert [item["symbol"] for item in symbols_api._iter_cached_symbols()] == [
            "AAAUSDT",
        ]

        inactive["listedAtMs"] = 999
        assert symbols_api.get_cached_symbol_metadata(
            "test",
            "spot",
            "OLDUSDT",
        )["listedAtMs"] == 1_000
    finally:
        symbols_api._symbol_cache.clear()
        symbols_api._market_refresh_state.clear()
        symbols_api._market_refresh_tasks.clear()
        for handle in symbols_api._market_refresh_timers.values():
            handle.cancel()
        symbols_api._market_refresh_timers.clear()
        symbols_api._cache_loaded_at = 0.0
