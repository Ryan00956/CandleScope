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
