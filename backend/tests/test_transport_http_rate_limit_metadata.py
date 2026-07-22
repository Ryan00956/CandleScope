from __future__ import annotations

import asyncio
from typing import Any

import aiohttp
import pytest

from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.models import (
    StreamDescriptor,
    StreamType,
    TransportRequest,
)
from app.data_engine.ingestion.transport import TransportError, TransportLayer
from app.exchanges.rate_limits import RateLimitAdmission, RateLimitDeferred


class _FakeResponse:
    def __init__(
        self,
        payload: dict[str, Any],
        *,
        status: int = 200,
        headers: dict[str, str] | None = None,
    ) -> None:
        self.status = status
        self.headers = headers or {}
        self.url = "https://www.okx.com/api/v5/market/history-candles"
        self._payload = payload

    async def __aenter__(self) -> "_FakeResponse":
        return self

    async def __aexit__(self, *args: object) -> None:
        return None

    async def json(self) -> dict[str, Any]:
        return self._payload

    async def text(self) -> str:
        return str(self._payload)


class _FakeSession:
    closed = False

    def get(self, *args: object, **kwargs: object) -> _FakeResponse:
        return _FakeResponse(
            {"code": "50011", "msg": "Requests too frequent"},
            headers={"Retry-After": "0.25"},
        )


class _SequenceSession:
    closed = False

    def __init__(self, responses: list[_FakeResponse]) -> None:
        self._responses = responses
        self.calls = 0

    def get(self, *args: object, **kwargs: object) -> _FakeResponse:
        self.calls += 1
        return self._responses.pop(0)


class _BinanceInvalidParameterResponse(_FakeResponse):
    def __init__(self) -> None:
        super().__init__({}, status=400)
        self.url = "https://fapi.binance.com/futures/data/openInterestHist"

    async def text(self) -> str:
        return '{"msg":"parameter \'startTime\' is invalid.","code":-1130}'


class _BinanceRateLimitResponse(_FakeResponse):
    def __init__(self, *, status: int) -> None:
        super().__init__(
            {},
            status=status,
            headers={"Retry-After": "0.05"},
        )
        self.url = "https://fapi.binance.com/fapi/v1/premiumIndex"

    async def text(self) -> str:
        return '{"msg":"IP banned until retry time","code":-1003}'


class _BinanceRateLimitBodyReadFailureResponse(_BinanceRateLimitResponse):
    async def text(self) -> str:
        raise aiohttp.ClientPayloadError("rate-limit response body reset")


class _MalformedJsonResponse(_FakeResponse):
    async def json(self) -> dict[str, Any]:
        raise aiohttp.ClientPayloadError("HTTP 200 response body truncated")


class _GatedBinanceRateLimitResponse(_BinanceRateLimitResponse):
    def __init__(self, entered: asyncio.Event, release: asyncio.Event) -> None:
        super().__init__(status=418)
        self._entered = entered
        self._release = release

    async def __aenter__(self) -> "_GatedBinanceRateLimitResponse":
        self._entered.set()
        await self._release.wait()
        return self


class _CountingRateLimits:
    def __init__(self) -> None:
        self.acquire_calls = 0
        self.inspect_calls = 0
        self.response_calls = 0
        self.responses: list[dict[str, object]] = []

    async def acquire(self, rule: object, request: object) -> None:
        self.acquire_calls += 1

    async def inspect(self, rule: object, request: object) -> RateLimitAdmission:
        self.inspect_calls += 1
        return RateLimitAdmission(
            allowed=True,
            bucket_key="test:bucket",
            cost=1,
            reason=None,
            retry_after_seconds=0,
            retry_at_monotonic=None,
            retry_at_ms=None,
            rule_name="test",
        )

    async def acquire_nowait(self, rule: object, request: object) -> None:
        self.acquire_calls += 1

    def record_response(self, rule: object, **kwargs: object) -> bool:
        self.response_calls += 1
        self.responses.append(dict(kwargs))
        return False

    def snapshot(self) -> dict[str, object]:
        return {}


def test_http_fetch_preserves_okx_rate_limit_metadata() -> None:
    async def run() -> TransportError:
        transport = TransportLayer(IngestionConfig())
        transport._http_session = _FakeSession()  # type: ignore[assignment]
        req = TransportRequest(
            descriptor=StreamDescriptor(
                symbol="BTC-USDT",
                stream_type=StreamType.KLINE,
                interval="1m",
                exchange="okx",
                market_type="spot",
            ),
            limit=10,
        )

        try:
            await transport.http_fetch(req)
        except TransportError as exc:
            return exc
        raise AssertionError("expected OKX rate-limit response to raise TransportError")

    exc = asyncio.run(run())
    assert exc.status_code == 200
    assert exc.retry_after == 0.25
    assert exc.body_code == "50011"
    assert exc.headers["Retry-After"] == "0.25"


def test_http_fetch_accounts_for_each_physical_endpoint_attempt() -> None:
    async def run(*, preacquired: bool) -> tuple[int, int]:
        config = IngestionConfig(
            http_base_urls_futures=["https://one.example", "https://two.example"],
        )
        transport = TransportLayer(config)
        transport._http_session = _SequenceSession([  # type: ignore[assignment]
            _FakeResponse({"msg": "temporary"}, status=500),
            _FakeResponse({
                "symbol": "BTCUSDT",
                "markPrice": "101",
                "indexPrice": "100",
                "estimatedSettlePrice": "100.5",
                "lastFundingRate": "0.0001",
                "nextFundingTime": 1_700_028_800_000,
                "time": 1_700_000_000_000,
            }),
        ])
        counter = _CountingRateLimits()
        transport._rate_limits = counter  # type: ignore[assignment]
        req = TransportRequest(
            descriptor=StreamDescriptor(
                symbol="BTCUSDT",
                stream_type=StreamType.MARK_PRICE,
                exchange="binance",
                market_type="futures",
            ),
            quota_acquired=preacquired,
            quota_semaphore_held=preacquired,
        )

        rows = await transport.http_fetch(req)
        assert len(rows) == 1
        return counter.acquire_calls, counter.response_calls

    # A successful HTTP 200 has a headers-only accounting pass followed by a
    # completed-body pass; the failed HTTP 500 is accounted once.
    assert asyncio.run(run(preacquired=False)) == (2, 3)
    assert asyncio.run(run(preacquired=True)) == (1, 3)


def test_http_200_parse_failure_accounts_headers_before_normal_failover() -> None:
    async def run() -> tuple[list[object], _SequenceSession, _CountingRateLimits]:
        config = IngestionConfig(
            http_base_urls_futures=["https://one.example", "https://two.example"],
        )
        transport = TransportLayer(config)
        session = _SequenceSession([
            _MalformedJsonResponse(
                {},
                headers={"X-MBX-USED-WEIGHT-1M": "777"},
            ),
            _FakeResponse({
                "symbol": "BTCUSDT",
                "markPrice": "101",
                "indexPrice": "100",
                "estimatedSettlePrice": "100.5",
                "lastFundingRate": "0.0001",
                "nextFundingTime": 1_700_028_800_000,
                "time": 1_700_000_000_000,
            }),
        ])
        counter = _CountingRateLimits()
        transport._http_session = session  # type: ignore[assignment]
        transport._rate_limits = counter  # type: ignore[assignment]
        request = TransportRequest(
            descriptor=StreamDescriptor(
                symbol="BTCUSDT",
                stream_type=StreamType.MARK_PRICE,
                exchange="binance",
                market_type="futures",
            ),
        )

        rows = await transport.http_fetch(request)
        return rows, session, counter

    rows, session, counter = asyncio.run(run())
    assert len(rows) == 1
    assert session.calls == 2
    assert counter.response_calls == 4
    assert counter.responses[0]["status_code"] == 200
    assert counter.responses[0]["headers"] == {
        "X-MBX-USED-WEIGHT-1M": "777",
    }
    assert counter.responses[0]["response_complete"] is False
    assert counter.responses[1] == {"response_unknown": True}


def test_http_fetch_does_not_fail_over_binance_invalid_parameter() -> None:
    async def run() -> tuple[TransportError, int]:
        config = IngestionConfig(
            http_base_urls_futures=["https://one.example", "https://two.example"],
        )
        transport = TransportLayer(config)
        session = _SequenceSession([_BinanceInvalidParameterResponse()])
        transport._http_session = session  # type: ignore[assignment]
        request = TransportRequest(
            descriptor=StreamDescriptor(
                symbol="BTCUSDT",
                stream_type=StreamType.OPEN_INTEREST,
                interval="1h",
                exchange="binance",
                market_type="futures",
            ),
            start_ms=1,
            end_ms=2,
            limit=500,
            history=True,
        )

        try:
            await transport.http_fetch(request)
        except TransportError as exc:
            return exc, session.calls
        raise AssertionError("expected invalid startTime to raise TransportError")

    exc, calls = asyncio.run(run())
    assert calls == 1
    assert exc.status_code == 400
    assert exc.body_code == "-1130"


@pytest.mark.parametrize("status_code", [418, 429])
def test_http_fetch_does_not_fail_over_shared_rate_limit_response(
    status_code: int,
) -> None:
    async def run() -> tuple[TransportError, int]:
        config = IngestionConfig(
            http_base_urls_futures=["https://one.example", "https://two.example"],
        )
        transport = TransportLayer(config)
        session = _SequenceSession([
            _BinanceRateLimitResponse(status=status_code),
        ])
        transport._http_session = session  # type: ignore[assignment]
        request = TransportRequest(
            descriptor=StreamDescriptor(
                symbol="BTCUSDT",
                stream_type=StreamType.MARK_PRICE,
                exchange="binance",
                market_type="futures",
            ),
        )

        with pytest.raises(TransportError) as caught:
            await transport.http_fetch(request)
        return caught.value, session.calls

    exc, calls = asyncio.run(run())
    assert calls == 1
    assert exc.status_code == status_code
    assert exc.body_code == "-1003"
    assert exc.retry_after == 0.05
    assert exc.rate_limit_recorded is True


def test_http_fetch_returns_typed_deferral_after_physical_418() -> None:
    async def run() -> tuple[RateLimitDeferred, int]:
        config = IngestionConfig(
            http_base_urls_futures=["https://one.example", "https://two.example"],
        )
        transport = TransportLayer(config)
        session = _SequenceSession([_BinanceRateLimitResponse(status=418)])
        transport._http_session = session  # type: ignore[assignment]
        request = TransportRequest(
            descriptor=StreamDescriptor(
                symbol="BTCUSDT",
                stream_type=StreamType.MARK_PRICE,
                exchange="binance",
                market_type="futures",
            ),
            defer_on_rate_limit=True,
        )

        with pytest.raises(RateLimitDeferred) as caught:
            await transport.http_fetch(request)
        return caught.value, session.calls

    deferred, calls = asyncio.run(run())
    assert calls == 1
    assert deferred.reason == "circuit_open"
    assert deferred.status_code == 418
    assert deferred.body_code == "-1003"
    assert deferred.retry_after_seconds >= 0.04


@pytest.mark.parametrize("status_code", [418, 429])
def test_rate_limit_body_read_failure_preserves_typed_deferral_without_failover(
    status_code: int,
) -> None:
    async def run() -> tuple[RateLimitDeferred, int]:
        config = IngestionConfig(
            http_base_urls_futures=["https://one.example", "https://two.example"],
        )
        transport = TransportLayer(config)
        session = _SequenceSession([
            _BinanceRateLimitBodyReadFailureResponse(status=status_code),
        ])
        transport._http_session = session  # type: ignore[assignment]
        request = TransportRequest(
            descriptor=StreamDescriptor(
                symbol="BTCUSDT",
                stream_type=StreamType.MARK_PRICE,
                exchange="binance",
                market_type="futures",
            ),
            defer_on_rate_limit=True,
        )

        with pytest.raises(RateLimitDeferred) as caught:
            await transport.http_fetch(request)
        return caught.value, session.calls

    deferred, calls = asyncio.run(run())
    assert calls == 1
    assert deferred.status_code == status_code
    assert deferred.retry_after_seconds >= 0.04
    assert deferred.reason == ("circuit_open" if status_code == 418 else "cooldown")


def test_request_queued_behind_physical_418_rechecks_before_sending() -> None:
    async def run() -> tuple[list[object], int]:
        entered = asyncio.Event()
        release = asyncio.Event()
        config = IngestionConfig(
            http_base_urls_futures=["https://one.example"],
        )
        transport = TransportLayer(config)
        session = _SequenceSession([
            _GatedBinanceRateLimitResponse(entered, release),
        ])
        transport._http_session = session  # type: ignore[assignment]

        def request() -> TransportRequest:
            return TransportRequest(
                descriptor=StreamDescriptor(
                    symbol="BTCUSDT",
                    stream_type=StreamType.MARK_PRICE,
                    exchange="binance",
                    market_type="futures",
                ),
                defer_on_rate_limit=True,
            )

        first = asyncio.create_task(transport.http_fetch(request()))
        await entered.wait()
        second = asyncio.create_task(transport.http_fetch(request()))
        await asyncio.sleep(0)
        assert session.calls == 1

        release.set()
        results = await asyncio.gather(first, second, return_exceptions=True)
        return results, session.calls

    results, calls = asyncio.run(run())
    assert calls == 1
    assert all(isinstance(value, RateLimitDeferred) for value in results)
    # A conservative process-start bucket admits exactly one physical probe.
    # Its follower may see the budget/probe lease before that response returns,
    # or reach the semaphore recheck after the IP circuit opens.
    assert any(value.status_code == 418 for value in results)
    assert all(
        value.reason in {"budget", "probe_in_flight", "circuit_open"}
        for value in results
    )
