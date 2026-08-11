from __future__ import annotations

import asyncio
from typing import Any

import aiohttp
import pytest
from ccxt.pro.okx import okx as CcxtOkx

from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.models import StreamDescriptor, StreamType
from app.exchanges.ccxt_ext.models import CcxtRawMarketEvent
from app.exchanges.ccxt_ext.okx import CandleScopeOkx, CandleScopeOkxSpot
from app.exchanges.ccxt_ext.profiles import OkxSpotCcxtProfile, OkxSwapCcxtProfile
from app.exchanges.ccxt_ext.shadow_matrix import (
    CcxtShadowMatrixRunner,
    CcxtShadowMatrixSpec,
    CcxtShadowTarget,
)
from app.exchanges.ccxt_ext.shadow_okx import (
    OKX_SHADOW_SCHEMA_VERSION,
    OKX_SPOT_SHADOW_SCHEMA_VERSION,
    OkxCcxtShadowComparator,
)


class _Client:
    url = "wss://ws.okx.com:8443/ws/v5/public"


def _kline(symbol: str, *, close: str = "2", confirmed: str = "1") -> dict:
    return {
        "arg": {"channel": "candle1m", "instId": symbol},
        "data": [
            [
                "1700000000000",
                "1",
                "3",
                "0.5",
                close,
                "10",
                "0.1",
                "20",
                confirmed,
            ]
        ],
    }


def _ticker(symbol: str, timestamp: int = 1_700_000_001_000) -> dict:
    return {
        "arg": {"channel": "tickers", "instId": symbol},
        "data": [
            {
                "instType": "SWAP",
                "instId": symbol,
                "last": "64000",
                "lastSz": "1",
                "askPx": "64001",
                "bidPx": "63999",
                "open24h": "63000",
                "high24h": "65000",
                "low24h": "62000",
                "volCcy24h": "100",
                "vol24h": "1000",
                "ts": str(timestamp),
            }
        ],
    }


def _observe_pair(
    comparator: OkxCcxtShadowComparator, channel: str, payload: dict
) -> None:
    received = 1_700_000_001_010
    comparator.observe("native", channel, payload, received)
    comparator.observe("ccxt", channel, payload, received + 1)


def test_okx_raw_hook_and_cleanup_are_owned(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = []
    monkeypatch.setattr(CcxtOkx, "handle_message", lambda *_args: "projected")
    driver = CandleScopeOkx(raw_event_sink=captured.append)
    payload = _ticker("BTC-USDT-SWAP")

    assert driver.handle_message(_Client(), payload) == "projected"
    assert captured[0].channel == "tickers"
    assert captured[0].symbol == "BTC-USDT-SWAP"
    assert captured[0].exchange == "okx"

    async def close() -> None:
        driver.open()
        assert isinstance(driver.session, aiohttp.ClientSession)
        session = driver.session
        await driver.close()
        assert session.closed is True
        assert driver.session is None

    asyncio.run(close())


def test_okx_profile_is_limited_to_current_native_capabilities() -> None:
    profile = OkxSwapCcxtProfile()
    kline = StreamDescriptor(
        "BTC-USDT-SWAP",
        StreamType.KLINE,
        interval="1m",
        exchange="okx",
        market_type="futures",
    )
    ticker = StreamDescriptor(
        "BTC-USDT-SWAP",
        StreamType.TICKER,
        exchange="okx",
        market_type="futures",
    )
    depth = StreamDescriptor(
        "BTC-USDT-SWAP",
        StreamType.FULL_DEPTH,
        exchange="okx",
        market_type="futures",
    )
    exchange = type(
        "Exchange",
        (),
        {
            "markets": {
                "BTC/USDT:USDT": {
                    "id": "BTC-USDT-SWAP",
                    "symbol": "BTC/USDT:USDT",
                    "swap": True,
                    "linear": True,
                }
            }
        },
    )()

    assert profile.supports(kline) is True
    assert profile.supports(ticker) is True
    assert profile.supports(depth) is False
    assert profile.resolve_symbol(exchange, kline) == "BTC/USDT:USDT"
    assert profile.runtime_key(IngestionConfig())[:2] == ("okx", "futures")


def test_okx_spot_profile_keeps_spot_identity_and_symbol() -> None:
    profile = OkxSpotCcxtProfile()
    descriptor = StreamDescriptor(
        "BTC-USDT",
        StreamType.KLINE,
        interval="1m",
        exchange="okx",
        market_type="spot",
    )
    exchange = type(
        "Exchange",
        (),
        {
            "markets": {
                "BTC/USDT": {
                    "id": "BTC-USDT",
                    "symbol": "BTC/USDT",
                    "spot": True,
                }
            }
        },
    )()

    assert profile.supports(descriptor) is True
    assert profile.resolve_symbol(exchange, descriptor) == "BTC/USDT"
    assert profile.runtime_key(IngestionConfig())[:2] == ("okx", "spot")

    captured = []
    driver = CandleScopeOkxSpot(raw_event_sink=captured.append)
    payload = _ticker("BTC-USDT")
    driver._candlescope_emit_decoded(payload)
    assert captured[0].market_type == "spot"


def test_okx_spot_comparator_has_distinct_schema() -> None:
    comparator = OkxCcxtShadowComparator(market_type="spot")
    _observe_pair(comparator, "kline", _kline("BTC-USDT"))
    _observe_pair(comparator, "ticker", _ticker("BTC-USDT"))

    assert comparator.report()["schema_version"] == OKX_SPOT_SHADOW_SCHEMA_VERSION


def test_okx_comparator_passes_closed_kline_and_ticker_exactly() -> None:
    comparator = OkxCcxtShadowComparator()
    _observe_pair(comparator, "kline", _kline("BTC-USDT-SWAP"))
    _observe_pair(comparator, "ticker", _ticker("BTC-USDT-SWAP"))

    report = comparator.report()

    assert report["schema_version"] == OKX_SHADOW_SCHEMA_VERSION
    assert report["overall_verdict"] == "PASS"
    assert report["channels"]["kline"]["strict_comparison"]["payload_matches"] == 1
    assert report["channels"]["ticker"]["strict_comparison"]["payload_matches"] == 1


def test_okx_comparator_fails_payload_mismatch_and_out_of_order_ticker() -> None:
    comparator = OkxCcxtShadowComparator()
    comparator.observe("native", "kline", _kline("BTC-USDT-SWAP"), 1_700_000_001_010)
    comparator.observe(
        "ccxt",
        "kline",
        _kline("BTC-USDT-SWAP", close="2.1"),
        1_700_000_001_011,
    )
    for source in ("native", "ccxt"):
        comparator.observe(source, "ticker", _ticker("BTC-USDT-SWAP", 200), 1_000)
        comparator.observe(source, "ticker", _ticker("BTC-USDT-SWAP", 100), 1_001)

    report = comparator.report()

    assert report["overall_verdict"] == "FAIL"
    assert report["channels"]["kline"]["strict_comparison"]["payload_mismatches"] == 1
    assert report["channels"]["ticker"]["sources"]["native"]["out_of_order"] == 1


def test_okx_matrix_routes_raw_channel_to_logical_comparator_channel() -> None:
    spec = CcxtShadowMatrixSpec(
        profile="okx_swap",
        targets=(CcxtShadowTarget("BTC-USDT-SWAP"),),
        duration_seconds=1,
        startup_timeout_seconds=1,
    )
    runner = CcxtShadowMatrixRunner(spec)
    payload = _kline("BTC-USDT-SWAP")

    runner._on_ccxt_raw(
        CcxtRawMarketEvent(
            channel="candle1m",
            symbol="BTC-USDT-SWAP",
            payload=payload,
            received_at_ms=1_700_000_001_011,
            exchange="okx",
            market_type="futures",
        )
    )

    source = runner._comparators["BTC-USDT-SWAP"].report()["channels"]["kline"][
        "sources"
    ]["ccxt"]
    assert source["received"] == 1
    assert runner._routing_checks == 2
    assert runner._max_route_matches == 1


def test_okx_profile_watch_uses_kline_and_ticker_methods() -> None:
    calls: list[tuple[str, tuple[Any, ...]]] = []

    class Exchange:
        async def watch_ohlcv(self, *args: Any) -> None:
            calls.append(("kline", args))

        async def watch_ticker(self, *args: Any) -> None:
            calls.append(("ticker", args))

    profile = OkxSwapCcxtProfile()
    kline = StreamDescriptor(
        "BTC-USDT-SWAP",
        StreamType.KLINE,
        interval="1m",
        exchange="okx",
        market_type="futures",
    )
    ticker = StreamDescriptor(
        "BTC-USDT-SWAP",
        StreamType.TICKER,
        exchange="okx",
        market_type="futures",
    )

    async def run() -> None:
        await profile.watch(Exchange(), kline, "BTC/USDT:USDT")
        await profile.watch(Exchange(), ticker, "BTC/USDT:USDT")

    asyncio.run(run())

    assert calls == [
        ("kline", ("BTC/USDT:USDT", "1m")),
        ("ticker", ("BTC/USDT:USDT",)),
    ]
