from __future__ import annotations

import asyncio
from typing import Any

import aiohttp
import pytest
from ccxt.pro.binance import binance as CcxtBinanceSpot

from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.models import StreamDescriptor, StreamType
from app.exchanges.ccxt_ext.binance_spot import CandleScopeBinanceSpot
from app.exchanges.ccxt_ext.binance_usdm import SUPPORTED_CCXT_VERSION
from app.exchanges.ccxt_ext.profiles import BinanceSpotCcxtProfile


class _Client:
    url = "wss://stream.binance.com/ws"


def test_spot_hook_is_version_pinned(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.exchanges.ccxt_ext.hooks.ccxt.__version__", "0.0.0")

    with pytest.raises(RuntimeError, match=SUPPORTED_CCXT_VERSION):
        CandleScopeBinanceSpot()


def test_spot_hook_preserves_raw_payload_before_projection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured = []
    monkeypatch.setattr(CcxtBinanceSpot, "handle_message", lambda *_args: "projected")
    driver = CandleScopeBinanceSpot(raw_event_sink=captured.append)
    payload = {
        "e": "depthUpdate",
        "E": 1_700_000_000_010,
        "s": "BTCUSDT",
        "U": 120,
        "u": 124,
        "b": [["100", "3"]],
        "a": [["101", "4"]],
    }

    assert driver.handle_message(_Client(), payload) == "projected"
    assert captured[0].channel == "depth"
    assert captured[0].symbol == "BTCUSDT"
    assert captured[0].market_type == "spot"
    assert "pu" not in captured[0].payload


def test_spot_profile_support_and_symbol_resolution_are_narrow() -> None:
    profile = BinanceSpotCcxtProfile()
    spot = StreamDescriptor(
        "BTCUSDT",
        StreamType.FULL_DEPTH,
        exchange="binance",
        market_type="spot",
        update_interval_ms=100,
    )
    futures = StreamDescriptor(
        "BTCUSDT",
        StreamType.FULL_DEPTH,
        exchange="binance",
        market_type="futures",
        update_interval_ms=100,
    )
    exchange = type(
        "Exchange",
        (),
        {
            "markets": {
                "BTC/USDT": {
                    "id": "BTCUSDT",
                    "symbol": "BTC/USDT",
                    "spot": True,
                },
                "BTC/USDT:USDT": {
                    "id": "BTCUSDT",
                    "symbol": "BTC/USDT:USDT",
                    "spot": False,
                },
            }
        },
    )()

    assert profile.supports(spot) is True
    assert profile.supports(futures) is False
    assert profile.resolve_symbol(exchange, spot) == "BTC/USDT"
    assert profile.runtime_key(IngestionConfig())[:2] == ("binance", "spot")


def test_spot_close_releases_owned_rest_session() -> None:
    async def run() -> None:
        driver = CandleScopeBinanceSpot()
        driver.open()
        assert isinstance(driver.session, aiohttp.ClientSession)
        session = driver.session

        await driver.close()

        assert session.closed is True
        assert driver.session is None

    asyncio.run(run())


def test_spot_profile_uses_explicit_aggregate_trade_and_depth_rate() -> None:
    calls: list[tuple[str, tuple[Any, ...], dict[str, Any]]] = []

    class Exchange:
        async def watch_trades(self, *args: Any, **kwargs: Any) -> None:
            calls.append(("trades", args, kwargs))

        async def watch_order_book(self, *args: Any, **kwargs: Any) -> None:
            calls.append(("depth", args, kwargs))

    profile = BinanceSpotCcxtProfile()
    trade = StreamDescriptor(
        "BTCUSDT", StreamType.AGG_TRADE, exchange="binance", market_type="spot"
    )
    depth = StreamDescriptor(
        "BTCUSDT",
        StreamType.FULL_DEPTH,
        exchange="binance",
        market_type="spot",
        update_interval_ms=100,
    )

    async def run() -> None:
        await profile.watch(Exchange(), trade, "BTC/USDT")
        await profile.watch(Exchange(), depth, "BTC/USDT")

    asyncio.run(run())

    assert calls[0] == (
        "trades",
        ("BTC/USDT",),
        {"params": {"name": "aggTrade"}},
    )
    assert calls[1] == (
        "depth",
        ("BTC/USDT",),
        {"limit": 100, "params": {"watchOrderBookRate": 100}},
    )
