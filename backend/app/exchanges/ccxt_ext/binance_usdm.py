from __future__ import annotations

import contextvars
import inspect
import json
import sys
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

import aiohttp
import ccxt
from ccxt.pro.binanceusdm import binanceusdm as CcxtBinanceUSDM

from app.exchanges.rate_limits import (
    HistoricalRequest,
    RateLimitManager,
    RateLimitPolicy,
    RateLimitReservation,
    get_shared_rate_limit_manager,
    get_shared_rate_limit_semaphore,
)

from .models import CcxtLifecycleEvent, CcxtRawMarketEvent

SUPPORTED_CCXT_VERSION = "4.5.60"

RawEventSink = Callable[[CcxtRawMarketEvent], None]
LifecycleSink = Callable[[CcxtLifecycleEvent], None]

_FAPI_ENDPOINTS = {
    "aggTrades": "/fapi/v1/aggTrades",
    "depth": "/fapi/v1/depth",
    "exchangeInfo": "/fapi/v1/exchangeInfo",
    "fundingRate": "/fapi/v1/fundingRate",
    "klines": "/fapi/v1/klines",
    "openInterest": "/fapi/v1/openInterest",
    "premiumIndex": "/fapi/v1/premiumIndex",
    "premiumIndexKlines": "/fapi/v1/premiumIndexKlines",
}
_FAPI_DATA_ENDPOINTS = {
    "openInterestHist": "/futures/data/openInterestHist",
}


class CcxtCompatibilityError(RuntimeError):
    """Raised when the installed CCXT build is outside the tested contract."""


@dataclass(frozen=True, slots=True)
class _RestObservation:
    status_code: int
    headers: dict[str, str]
    body_code: str | None
    retry_after: float | None


class CandleScopeBinanceUSDM(CcxtBinanceUSDM):
    """CCXT Binance USD-M extension that preserves CandleScope quality seams.

    This class deliberately does not replace CandleScope normalization,
    continuity, reconnect supervision, or full-order-book reconstruction.
    It exposes raw websocket payloads before CCXT projects them into unified
    structures and admits REST calls through the shared CandleScope IP budget.
    """

    def __init__(
        self,
        config: Mapping[str, Any] | None = None,
        *,
        raw_event_sink: RawEventSink | None = None,
        lifecycle_sink: LifecycleSink | None = None,
        rate_limit_manager: RateLimitManager | None = None,
        rate_limit_policy: RateLimitPolicy | None = None,
        enforce_version: bool = True,
    ) -> None:
        if enforce_version and ccxt.__version__ != SUPPORTED_CCXT_VERSION:
            raise CcxtCompatibilityError(
                "CandleScope CCXT extension was tested with "
                f"ccxt=={SUPPORTED_CCXT_VERSION}, found {ccxt.__version__}",
            )
        super().__init__(dict(config or {}))
        self._candlescope_raw_event_sink = raw_event_sink
        self._candlescope_lifecycle_sink = lifecycle_sink
        self._candlescope_closing = False
        self._candlescope_rate_limit_manager = rate_limit_manager
        if rate_limit_policy is None:
            from app.exchanges.plugins.binance.plugin import BinancePlugin

            rate_limit_policy = BinancePlugin().rate_limit_policy()
        self._candlescope_rate_limit_policy = rate_limit_policy
        self._candlescope_rest_observation: contextvars.ContextVar[
            _RestObservation | None
        ] = contextvars.ContextVar(
            f"candlescope_ccxt_rest_observation_{id(self)}",
            default=None,
        )

    def open(self) -> None:
        """Open CCXT with the reliable Windows threaded DNS resolver.

        CCXT 4.5.60 installs ``aiodns``.  On the CandleScope Windows host its
        automatic resolver cannot reach the configured DNS servers, while the
        operating-system resolver succeeds.  Keep this workaround local to the
        pinned extension instead of mutating aiohttp's process-wide default.
        """

        if sys.platform != "win32" or self.session is not None or not self.own_session:
            super().open()
            return

        self.own_session = False
        try:
            super().open()
        finally:
            self.own_session = True
        self.tcp_connector = aiohttp.TCPConnector(
            ssl=self.ssl_context,
            loop=self.asyncio_loop,
            resolver=aiohttp.ThreadedResolver(loop=self.asyncio_loop),
        )
        self.session = aiohttp.ClientSession(
            loop=self.asyncio_loop,
            connector=self.tcp_connector,
            trust_env=self.aiohttp_trust_env,
        )

    async def close(self, clean_instance_data: bool = True) -> None:
        """Close both CCXT Pro websocket clients and its owned REST session."""

        self._candlescope_closing = True
        try:
            await super().close(clean_instance_data)
        finally:
            self._candlescope_closing = False

    def set_raw_event_sink(self, sink: RawEventSink | None) -> None:
        self._candlescope_raw_event_sink = sink

    def set_lifecycle_sink(self, sink: LifecycleSink | None) -> None:
        self._candlescope_lifecycle_sink = sink

    def handle_ohlcv(self, client: Any, message: Any) -> Any:
        self._emit_raw("kline", message)
        return super().handle_ohlcv(client, message)

    def handle_trade(self, client: Any, message: Any) -> Any:
        channel = (
            str(message.get("e") or "trade") if isinstance(message, dict) else "trade"
        )
        self._emit_raw(channel, message)
        return super().handle_trade(client, message)

    def handle_order_book(self, client: Any, message: Any) -> Any:
        self._emit_raw("depth", message)
        return super().handle_order_book(client, message)

    def on_connected(self, client: Any, message: Any = None) -> Any:
        self._emit_lifecycle("connected", client)
        return super().on_connected(client, message)

    def on_error(self, client: Any, error: BaseException) -> Any:
        self._emit_lifecycle("error", client, error)
        return super().on_error(client, error)

    def on_close(self, client: Any, error: BaseException | None) -> Any:
        if self._candlescope_closing:
            self._emit_lifecycle("closed", client)
        else:
            self._emit_lifecycle("disconnected", client, error)
        return super().on_close(client, error)

    def on_rest_response(
        self,
        code: int,
        reason: str,
        url: str,
        method: str,
        response_headers: Mapping[str, Any],
        response_body: str,
        request_headers: Mapping[str, Any],
        request_body: str | None,
    ) -> Any:
        headers = {str(key): str(value) for key, value in response_headers.items()}
        self._candlescope_rest_observation.set(
            _RestObservation(
                status_code=int(code),
                headers=headers,
                body_code=_body_code(response_body),
                retry_after=_retry_after(headers),
            )
        )
        return super().on_rest_response(
            code,
            reason,
            url,
            method,
            response_headers,
            response_body,
            request_headers,
            request_body,
        )

    async def fetch2(
        self,
        path: Any,
        api: Any = "public",
        method: str = "GET",
        params: Mapping[str, Any] | None = None,
        headers: Any = None,
        body: Any = None,
        config: Mapping[str, Any] | None = None,
    ) -> Any:
        clean_params = dict(params or {})
        # One shared reservation must correspond to exactly one physical HTTP
        # request.  CandleScope owns retries and endpoint failover.
        clean_params["maxRetriesOnFailure"] = 0
        request = self._historical_request(path, api, clean_params)
        rule = self._candlescope_rate_limit_policy.rule_for(request)
        manager = (
            self._candlescope_rate_limit_manager or get_shared_rate_limit_manager()
        )
        await manager.acquire(rule, request)
        reservation = RateLimitReservation(manager, rule, request)
        semaphore = get_shared_rate_limit_semaphore(
            rule,
            fallback=self._candlescope_rate_limit_policy.concurrency_for("futures"),
        )
        token = self._candlescope_rest_observation.set(None)
        try:
            async with semaphore:
                result = await super().fetch2(
                    path,
                    api,
                    method,
                    clean_params,
                    headers,
                    body,
                    dict(config or {}),
                )
            self._settle_reservation(reservation, fallback_status=200)
            return result
        except BaseException:
            self._settle_reservation(reservation)
            raise
        finally:
            if not reservation.settled:
                reservation.record_response(response_unknown=True)
            self._candlescope_rest_observation.reset(token)

    def _historical_request(
        self,
        path: Any,
        api: Any,
        params: Mapping[str, Any],
    ) -> HistoricalRequest:
        endpoint = _endpoint_for(path, api)
        return HistoricalRequest(
            exchange="binance",
            market_type="futures",
            endpoint=endpoint,
            symbol=str(params.get("symbol") or ""),
            interval=_optional_str(params.get("interval")),
            start_ms=_optional_int(params.get("startTime")),
            end_ms=_optional_int(params.get("endTime")),
            limit=_optional_int(params.get("limit")),
            params=dict(params),
        )

    def _settle_reservation(
        self,
        reservation: RateLimitReservation,
        *,
        fallback_status: int | None = None,
    ) -> None:
        observation = self._candlescope_rest_observation.get()
        if observation is None:
            if fallback_status is not None:
                reservation.record_response(status_code=fallback_status)
            return
        reservation.record_response(
            status_code=observation.status_code,
            headers=observation.headers,
            body_code=observation.body_code,
            retry_after=observation.retry_after,
        )

    def _emit_raw(self, channel: str, message: Any) -> None:
        sink = self._candlescope_raw_event_sink
        if sink is None or not isinstance(message, dict):
            return
        nested_kline = message.get("k") if isinstance(message.get("k"), dict) else {}
        symbol = message.get("s") or message.get("ps") or nested_kline.get("s")
        result = sink(
            CcxtRawMarketEvent(
                channel=channel,
                symbol=str(symbol) if symbol is not None else None,
                payload=dict(message),
                received_at_ms=int(time.time() * 1000),
            )
        )
        _require_synchronous_sink(result, "raw_event_sink")

    def _emit_lifecycle(
        self,
        state: str,
        client: Any,
        error: BaseException | None = None,
    ) -> None:
        sink = self._candlescope_lifecycle_sink
        if sink is None:
            return
        url = getattr(client, "url", None)
        result = sink(
            CcxtLifecycleEvent(
                state=state,
                url=str(url) if url is not None else None,
                observed_at_ms=int(time.time() * 1000),
                error=str(error) if error is not None else None,
            )
        )
        _require_synchronous_sink(result, "lifecycle_sink")


def _endpoint_for(path: Any, api: Any) -> str:
    path_value = str(path)
    if str(api) == "fapiData":
        return _FAPI_DATA_ENDPOINTS.get(path_value, f"/futures/data/{path_value}")
    if str(api).startswith("fapi"):
        return _FAPI_ENDPOINTS.get(path_value, f"/fapi/v1/{path_value}")
    return f"/ccxt/{api}/{path_value}"


def _body_code(body: str) -> str | None:
    try:
        payload = json.loads(body)
    except (TypeError, ValueError):
        return None
    if not isinstance(payload, dict) or payload.get("code") is None:
        return None
    return str(payload["code"])


def _retry_after(headers: Mapping[str, str]) -> float | None:
    for key, value in headers.items():
        if key.lower() != "retry-after":
            continue
        try:
            return max(0.0, float(value))
        except (TypeError, ValueError):
            return None
    return None


def _optional_int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _optional_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text or None


def _require_synchronous_sink(result: Any, name: str) -> None:
    if not inspect.isawaitable(result):
        return
    close = getattr(result, "close", None)
    if callable(close):
        close()
    raise TypeError(f"{name} must be synchronous and non-blocking")
