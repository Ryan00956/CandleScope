from __future__ import annotations

import asyncio
import sys
from typing import Any

import aiohttp
import pytest
from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.models import (
    DataSource,
    RawMessage,
    StreamDescriptor,
    StreamType,
)
from app.exchanges.ccxt_ext import (
    SUPPORTED_CCXT_VERSION,
    CandleScopeBinanceUSDM,
    CcxtCompatibilityError,
)
from app.exchanges.plugins.binance.normalizer import BinanceNormalizer
from app.exchanges.rate_limits import RateLimitManager
from ccxt.pro.binanceusdm import binanceusdm as CcxtBinanceUSDM


class _Client:
    url = "wss://fstream.binance.com/public/ws"


class _TrackingRateLimitManager(RateLimitManager):
    def __init__(self) -> None:
        super().__init__()
        self.requests: list[Any] = []
        self.responses: list[dict[str, Any]] = []

    async def acquire(self, rule: Any, request: Any) -> Any:
        self.requests.append(request)
        return None

    def record_response(self, rule: Any, **kwargs: Any) -> bool:
        self.responses.append(dict(kwargs))
        return super().record_response(rule, **kwargs)


def test_supported_ccxt_version_is_fail_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.exchanges.ccxt_ext.binance_usdm.ccxt.__version__", "0.0.0")

    with pytest.raises(CcxtCompatibilityError, match=SUPPORTED_CCXT_VERSION):
        CandleScopeBinanceUSDM()


def test_raw_kline_is_captured_before_ccxt_projection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured = []
    monkeypatch.setattr(CcxtBinanceUSDM, "handle_ohlcv", lambda *_args: "projected")
    driver = CandleScopeBinanceUSDM(raw_event_sink=captured.append)
    payload = {
        "e": "kline",
        "E": 60_010,
        "s": "BTCUSDT",
        "k": {
            "t": 60_000,
            "T": 119_999,
            "s": "BTCUSDT",
            "i": "1m",
            "o": "1",
            "h": "3",
            "l": "0.5",
            "c": "2",
            "v": "10",
            "q": "20",
            "n": 4,
            "V": "6",
            "Q": "12",
            "x": False,
        },
    }

    assert driver.handle_ohlcv(_Client(), payload) == "projected"
    assert captured[0].channel == "kline"
    assert captured[0].payload["k"]["V"] == "6"
    assert captured[0].payload["k"]["Q"] == "12"

    descriptor = StreamDescriptor(
        "BTCUSDT",
        StreamType.KLINE,
        interval="1m",
        market_type="futures",
    )
    normalized = BinanceNormalizer(IngestionConfig(), descriptor).parse(
        RawMessage(
            payload=captured[0].payload,
            source=DataSource.WEBSOCKET,
            stream_type=StreamType.KLINE,
            received_at_ms=captured[0].received_at_ms,
        )
    )
    assert normalized is not None
    assert normalized.data["quote_volume"] == 20
    assert normalized.data["taker_buy_base"] == 6


def test_raw_aggregate_trade_preserves_sequence_fields(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured = []
    monkeypatch.setattr(CcxtBinanceUSDM, "handle_trade", lambda *_args: None)
    driver = CandleScopeBinanceUSDM(raw_event_sink=captured.append)
    payload = {
        "e": "aggTrade",
        "E": 1_700_000_000_020,
        "s": "BTCUSDT",
        "a": 123,
        "p": "64000.1",
        "q": "0.25",
        "f": 456,
        "l": 458,
        "T": 1_700_000_000_019,
        "m": True,
    }

    driver.handle_trade(_Client(), payload)

    assert captured[0].channel == "aggTrade"
    assert captured[0].payload["a"] == 123
    assert captured[0].payload["f"] == 456
    assert captured[0].payload["l"] == 458


def test_raw_depth_preserves_strict_futures_previous_link(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured = []
    monkeypatch.setattr(CcxtBinanceUSDM, "handle_order_book", lambda *_args: None)
    driver = CandleScopeBinanceUSDM(raw_event_sink=captured.append)
    payload = {
        "e": "depthUpdate",
        "E": 1_700_000_000_010,
        "T": 1_700_000_000_009,
        "s": "BTCUSDT",
        "U": 120,
        "u": 124,
        "pu": 119,
        "b": [["100", "3"]],
        "a": [["101", "4"]],
    }

    driver.handle_order_book(_Client(), payload)

    assert captured[0].channel == "depth"
    assert {key: captured[0].payload[key] for key in ("U", "u", "pu")} == {
        "U": 120,
        "u": 124,
        "pu": 119,
    }

    descriptor = StreamDescriptor(
        "BTCUSDT",
        StreamType.FULL_DEPTH,
        market_type="futures",
        update_interval_ms=100,
    )
    normalized = BinanceNormalizer(IngestionConfig(), descriptor).parse(
        RawMessage(
            payload=captured[0].payload,
            source=DataSource.WEBSOCKET,
            stream_type=StreamType.FULL_DEPTH,
            received_at_ms=captured[0].received_at_ms,
        )
    )
    assert normalized is not None
    assert normalized.data["first_update_id"] == 120
    assert normalized.data["final_update_id"] == 124
    assert normalized.data["previous_final_update_id"] == 119


def test_lifecycle_hooks_are_forwarded(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = []
    monkeypatch.setattr(CcxtBinanceUSDM, "on_connected", lambda *_args: None)
    monkeypatch.setattr(CcxtBinanceUSDM, "on_error", lambda *_args: None)
    monkeypatch.setattr(CcxtBinanceUSDM, "on_close", lambda *_args: None)
    driver = CandleScopeBinanceUSDM(lifecycle_sink=captured.append)
    client = _Client()

    driver.on_connected(client)
    driver.on_error(client, RuntimeError("boom"))
    driver.on_close(client, None)
    driver._candlescope_closing = True
    driver.on_close(client, RuntimeError("expected shutdown"))

    assert [event.state for event in captured] == [
        "connected",
        "error",
        "disconnected",
        "closed",
    ]
    assert captured[1].error == "boom"
    assert captured[3].error is None


def test_windows_uses_threaded_dns_and_close_releases_rest_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def run() -> None:
        monkeypatch.setattr(sys, "platform", "win32")
        driver = CandleScopeBinanceUSDM()

        driver.open()

        assert driver.tcp_connector is not None
        assert isinstance(driver.tcp_connector._resolver, aiohttp.ThreadedResolver)
        assert driver.session is not None
        session = driver.session
        await driver.close()
        assert session.closed is True
        assert driver.session is None

    asyncio.run(run())


def test_rest_calls_use_shared_budget_and_settle_binance_headers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def run() -> None:
        manager = _TrackingRateLimitManager()

        async def fake_fetch2(self: Any, *args: Any, **kwargs: Any) -> dict[str, bool]:
            self.on_rest_response(
                200,
                "OK",
                "https://fapi.binance.com/fapi/v1/depth",
                "GET",
                {"x-mbx-used-weight-1m": "321"},
                '{"lastUpdateId":123}',
                {},
                None,
            )
            return {"ok": True}

        monkeypatch.setattr(CcxtBinanceUSDM, "fetch2", fake_fetch2)
        driver = CandleScopeBinanceUSDM(rate_limit_manager=manager)

        result = await driver.fetch2(
            "depth",
            "fapiPublic",
            params={"symbol": "BTCUSDT", "limit": 1000},
        )

        assert result == {"ok": True}
        assert manager.requests[0].endpoint == "/fapi/v1/depth"
        assert manager.requests[0].limit == 1000
        assert manager.requests[0].params["maxRetriesOnFailure"] == 0
        assert manager.responses == [
            {
                "status_code": 200,
                "headers": {"x-mbx-used-weight-1m": "321"},
                "body_code": None,
                "retry_after": None,
            }
        ]

    asyncio.run(run())


def test_rest_rate_limit_response_opens_existing_circuit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def run() -> None:
        manager = _TrackingRateLimitManager()

        async def fake_fetch2(self: Any, *args: Any, **kwargs: Any) -> None:
            self.on_rest_response(
                418,
                "Banned",
                "https://fapi.binance.com/fapi/v1/depth",
                "GET",
                {"Retry-After": "60"},
                '{"code":-1003,"msg":"IP banned"}',
                {},
                None,
            )
            raise RuntimeError("rate limited")

        monkeypatch.setattr(CcxtBinanceUSDM, "fetch2", fake_fetch2)
        driver = CandleScopeBinanceUSDM(rate_limit_manager=manager)

        with pytest.raises(RuntimeError, match="rate limited"):
            await driver.fetch2("depth", "fapiPublic", params={"symbol": "BTCUSDT"})

        assert manager.responses[0]["status_code"] == 418
        assert manager.responses[0]["body_code"] == "-1003"
        assert manager.responses[0]["retry_after"] == 60
        circuit = manager.circuit_snapshot()["binance:ip"]
        assert circuit["open"] is True

    asyncio.run(run())
