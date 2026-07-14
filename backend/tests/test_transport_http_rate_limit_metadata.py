from __future__ import annotations

import asyncio
from typing import Any

from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.models import (
    StreamDescriptor,
    StreamType,
    TransportRequest,
)
from app.data_engine.ingestion.transport import TransportError, TransportLayer


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

    def get(self, *args: object, **kwargs: object) -> _FakeResponse:
        return self._responses.pop(0)


class _CountingRateLimits:
    def __init__(self) -> None:
        self.acquire_calls = 0
        self.response_calls = 0

    async def acquire(self, rule: object, request: object) -> None:
        self.acquire_calls += 1

    def record_response(self, rule: object, **kwargs: object) -> bool:
        self.response_calls += 1
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

    assert asyncio.run(run(preacquired=False)) == (2, 2)
    assert asyncio.run(run(preacquired=True)) == (1, 2)
