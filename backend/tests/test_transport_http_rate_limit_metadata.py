from __future__ import annotations

import asyncio
from typing import Any

import aiohttp
import pytest

from app.data_engine.backfill.config import BackfillConfig
from app.data_engine.backfill.fetcher import HistoricalFetcher
from app.data_engine.backfill.models import BackfillTask
from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.models import (
    StreamDescriptor,
    StreamType,
    TransportRequest,
)
from app.data_engine.ingestion.transport import TransportError, TransportLayer
from app.exchanges.rate_limits import (
    HistoricalRequest,
    RateLimitAdmission,
    RateLimitDeferred,
    RateLimitManager,
    RateLimitPolicy,
    RateLimitReservation,
    RateLimitRule,
)
from app.exchanges.plugins.binance.plugin import BinancePlugin
from app.exchanges.plugins.okx.plugin import OkxPlugin


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


class _TrackingRateLimitManager(RateLimitManager):
    def __init__(self) -> None:
        super().__init__(conservative_cold_start=True, probe_lease_seconds=1.0)
        self.acquires: list[tuple[object, object]] = []
        self.responses: list[dict[str, object]] = []

    async def acquire_nowait(self, rule: object, request: object) -> object:
        self.acquires.append((rule, request))
        return await super().acquire_nowait(  # type: ignore[arg-type]
            rule,
            request,
        )

    def record_response(self, rule: object, **kwargs: object) -> bool:
        self.responses.append(dict(kwargs))
        return super().record_response(rule, **kwargs)  # type: ignore[arg-type]


class _ProviderProtocol:
    @staticmethod
    def rest_path(stream_type: object, market_type: str = "spot") -> None:
        return None


class _ProviderPlugin:
    def __init__(
        self,
        *,
        error: Exception | None = None,
        entered: asyncio.Event | None = None,
        release: asyncio.Event | None = None,
    ) -> None:
        self._error = error
        self._entered = entered
        self._release = release
        self._protocol = _ProviderProtocol()

    async def fetch_history(self, request: TransportRequest) -> list[object]:
        if self._entered is not None:
            self._entered.set()
        if self._release is not None:
            await self._release.wait()
        if self._error is not None:
            raise self._error
        return []

    def protocol(self) -> _ProviderProtocol:
        return self._protocol

    @staticmethod
    def rate_limit_policy(config: object | None = None) -> RateLimitPolicy:
        return RateLimitPolicy(
            default_concurrency=2,
            default_delay_seconds=0.05,
        )


class _ConfigSensitiveProviderPlugin(_ProviderPlugin):
    def __init__(self) -> None:
        super().__init__()
        self.policy_configs: list[object | None] = []

    def rate_limit_policy(self, config: object | None = None) -> RateLimitPolicy:
        self.policy_configs.append(config)
        raise AssertionError("transport must not rebuild an owned quota policy")


class _ProviderRegistry:
    def __init__(self, plugin: _ProviderPlugin) -> None:
        self._plugin = plugin

    def get_plugin(self, exchange: str) -> _ProviderPlugin:
        assert exchange == "mock"
        return self._plugin


class _NativeRegistry:
    def __init__(self) -> None:
        self._plugins = {"binance": BinancePlugin(), "okx": OkxPlugin()}

    def get_plugin(self, exchange: str) -> Any:
        return self._plugins[exchange]


def _native_transport(config: IngestionConfig) -> TransportLayer:
    transport = TransportLayer(config)
    transport._registry = _NativeRegistry()  # type: ignore[assignment]
    return transport


def _provider_request(
    *,
    quota_acquired: bool = False,
    quota_reservation: RateLimitReservation | None = None,
) -> TransportRequest:
    return TransportRequest(
        descriptor=StreamDescriptor(
            symbol="BTCUSDT",
            stream_type=StreamType.KLINE,
            interval="1m",
            exchange="mock",
            market_type="spot",
        ),
        start_ms=1_700_000_000_000,
        end_ms=1_700_000_060_000,
        limit=2,
        quota_acquired=quota_acquired,
        quota_reservation=quota_reservation,
    )


def _provider_transport(
    plugin: _ProviderPlugin,
    rate_limits: object,
) -> TransportLayer:
    transport = TransportLayer(IngestionConfig(proxy_mode="none"))
    transport._registry = _ProviderRegistry(plugin)  # type: ignore[assignment]
    transport._rate_limits = rate_limits  # type: ignore[assignment]
    return transport


def _owned_provider_request(
    plugin: _ProviderPlugin,
    manager: RateLimitManager,
    *,
    rule: RateLimitRule | None = None,
) -> tuple[TransportRequest, RateLimitReservation]:
    quota_request = HistoricalRequest(
        exchange="mock",
        market_type="spot",
        endpoint="kline",
        symbol="BTCUSDT",
        interval="1m",
        start_ms=1_700_000_000_000,
        end_ms=1_700_000_060_000,
        limit=2,
    )
    exact_rule = rule or plugin.rate_limit_policy(None).rule_for(quota_request)
    reservation = RateLimitReservation(
        manager=manager,
        rule=exact_rule,
        request=quota_request,
    )
    return (
        _provider_request(
            quota_acquired=True,
            quota_reservation=reservation,
        ),
        reservation,
    )


def test_standalone_provider_fetch_does_not_create_quota_bucket() -> None:
    async def run() -> tuple[list[object], int]:
        counter = _CountingRateLimits()
        transport = _provider_transport(_ProviderPlugin(), counter)
        messages = await transport.http_fetch(_provider_request())
        return messages, counter.response_calls

    messages, response_calls = asyncio.run(run())
    assert messages == []
    assert response_calls == 0


def test_provider_uses_exact_reservation_when_transport_predates_event_loop() -> None:
    plugin = _ConfigSensitiveProviderPlugin()
    transport = TransportLayer(IngestionConfig(proxy_mode="none"))
    transport._registry = _ProviderRegistry(plugin)  # type: ignore[assignment]
    transport_manager = transport._rate_limits

    async def run() -> tuple[dict[str, object], dict[str, object], bool]:
        fetcher = HistoricalFetcher(
            BackfillConfig(fetch_rate_limit_delay=0.05),
            transport,
        )
        task = BackfillTask(
            symbol="BTCUSDT",
            interval="1m",
            start_ms=1_700_000_000_000,
            end_ms=1_700_000_060_000,
            exchange="mock",
            market_type="spot",
        )
        request = _provider_request(quota_acquired=True)
        reservation = await fetcher._rate_limit(task, request)
        assert reservation is not None
        request.quota_reservation = reservation
        request.quota_semaphore_held = True

        assert reservation.manager is not transport_manager
        assert reservation.manager.snapshot()[reservation.rule.bucket_key][
            "probe_in_flight"
        ]
        assert await transport.http_fetch(request) == []
        return (
            reservation.manager.snapshot()[reservation.rule.bucket_key],
            transport_manager.snapshot(),
            request.quota_reservation is None,
        )

    exact_snapshot, transport_snapshot, handoff_cleared = asyncio.run(run())
    assert exact_snapshot["probe_in_flight"] is False
    assert exact_snapshot["last_status_code"] == 200
    assert transport_snapshot == {}
    assert handoff_cleared is True
    assert plugin.policy_configs == []


def test_provider_empty_page_completes_owned_probe() -> None:
    async def run() -> tuple[
        dict[str, object], RateLimitAdmission, list[dict[str, object]]
    ]:
        plugin = _ProviderPlugin()
        manager = _TrackingRateLimitManager()
        transport = _provider_transport(plugin, manager)
        request, reservation = _owned_provider_request(
            plugin,
            manager,
        )
        await manager.acquire_nowait(reservation.rule, reservation.request)
        assert (
            manager.snapshot()[reservation.rule.bucket_key]["probe_in_flight"] is True
        )

        messages = await transport.http_fetch(request)
        assert messages == []
        snapshot = manager.snapshot()[reservation.rule.bucket_key]
        follower = await manager.inspect(reservation.rule, reservation.request)
        return snapshot, follower, manager.responses

    snapshot, follower, responses = asyncio.run(run())
    assert snapshot["probe_in_flight"] is False
    assert snapshot["last_probe_release_reason"] == "response"
    assert snapshot["last_status_code"] == 200
    assert follower.reason != "probe_in_flight"
    assert responses == [{"status_code": 200}]


def test_provider_generic_error_completes_owned_probe_as_unknown() -> None:
    async def run() -> tuple[TransportError, dict[str, object], RateLimitAdmission]:
        plugin = _ProviderPlugin(error=RuntimeError("provider failed"))
        manager = _TrackingRateLimitManager()
        transport = _provider_transport(plugin, manager)
        request, reservation = _owned_provider_request(
            plugin,
            manager,
        )
        await manager.acquire_nowait(reservation.rule, reservation.request)
        with pytest.raises(TransportError) as caught:
            await transport.http_fetch(request)
        snapshot = manager.snapshot()[reservation.rule.bucket_key]
        follower = await manager.inspect(reservation.rule, reservation.request)
        return caught.value, snapshot, follower

    error, snapshot, follower = asyncio.run(run())
    assert error.rate_limit_recorded is True
    assert snapshot["probe_in_flight"] is False
    assert snapshot["last_probe_release_reason"] == "unknown_response"
    assert snapshot["tokens"] == 0
    assert follower.reason != "probe_in_flight"


def test_provider_transport_error_accounts_metadata_once() -> None:
    async def run() -> tuple[
        TransportError,
        dict[str, object],
        list[dict[str, object]],
    ]:
        upstream_error = TransportError(
            "provider throttled",
            status_code=429,
            retry_after=0.25,
            headers={"Retry-After": "0.25"},
        )
        plugin = _ProviderPlugin(error=upstream_error)
        manager = _TrackingRateLimitManager()
        transport = _provider_transport(plugin, manager)
        request, reservation = _owned_provider_request(
            plugin,
            manager,
        )
        await manager.acquire_nowait(reservation.rule, reservation.request)
        with pytest.raises(TransportError) as caught:
            await transport.http_fetch(request)
        return (
            caught.value,
            manager.snapshot()[reservation.rule.bucket_key],
            manager.responses,
        )

    error, snapshot, responses = asyncio.run(run())
    assert error.rate_limit_recorded is True
    assert snapshot["probe_in_flight"] is False
    assert snapshot["last_status_code"] == 429
    assert snapshot["last_headers"] == {"retry-after": "0.25"}
    assert responses == [
        {
            "status_code": 429,
            "headers": {"Retry-After": "0.25"},
            "body_code": None,
            "retry_after": 0.25,
            "fallback_cooldown_seconds": 60.0,
        }
    ]


def test_cancelled_provider_fetch_completes_owned_probe_as_unknown() -> None:
    async def run() -> tuple[
        RateLimitAdmission,
        dict[str, object],
        RateLimitAdmission,
        list[dict[str, object]],
    ]:
        entered = asyncio.Event()
        release = asyncio.Event()
        plugin = _ProviderPlugin(entered=entered, release=release)
        manager = _TrackingRateLimitManager()
        transport = _provider_transport(plugin, manager)
        request, reservation = _owned_provider_request(
            plugin,
            manager,
        )

        async def owner() -> None:
            await manager.acquire_nowait(reservation.rule, reservation.request)
            await transport.http_fetch(request)

        task = asyncio.create_task(owner())
        await entered.wait()
        blocked = await manager.inspect(reservation.rule, reservation.request)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        snapshot = manager.snapshot()[reservation.rule.bucket_key]
        follower = await manager.inspect(reservation.rule, reservation.request)
        return blocked, snapshot, follower, manager.responses

    blocked, snapshot, follower, responses = asyncio.run(run())
    assert blocked.reason == "probe_in_flight"
    assert snapshot["probe_in_flight"] is False
    assert snapshot["last_probe_release_reason"] == "unknown_response"
    assert snapshot["tokens"] == 0
    assert follower.reason != "probe_in_flight"
    assert responses == [{"response_unknown": True}]


def test_http_fetch_preserves_okx_rate_limit_metadata() -> None:
    async def run() -> TransportError:
        transport = _native_transport(IngestionConfig())
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
        transport = _native_transport(config)
        transport._http_session = _SequenceSession(
            [  # type: ignore[assignment]
                _FakeResponse({"msg": "temporary"}, status=500),
                _FakeResponse(
                    {
                        "symbol": "BTCUSDT",
                        "markPrice": "101",
                        "indexPrice": "100",
                        "estimatedSettlePrice": "100.5",
                        "lastFundingRate": "0.0001",
                        "nextFundingTime": 1_700_028_800_000,
                        "time": 1_700_000_000_000,
                    }
                ),
            ]
        )
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


def test_http_fetch_accounts_owned_response_on_exact_reservation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def run() -> tuple[
        list[object],
        dict[str, object],
        list[dict[str, object]],
        _CountingRateLimits,
        bool,
    ]:
        transport = _native_transport(
            IngestionConfig(
                http_base_urls_futures=[
                    "https://one.example",
                    "https://two.example",
                ],
            )
        )
        transport._http_session = _SequenceSession(  # type: ignore[assignment]
            [
                _FakeResponse({"msg": "temporary"}, status=500),
                _FakeResponse(
                    {
                        "symbol": "BTCUSDT",
                        "markPrice": "101",
                        "indexPrice": "100",
                        "estimatedSettlePrice": "100.5",
                        "lastFundingRate": "0.0001",
                        "nextFundingTime": 1_700_028_800_000,
                        "time": 1_700_000_000_000,
                    },
                    headers={"X-MBX-USED-WEIGHT-1M": "7"},
                ),
            ]
        )
        transport_counter = _CountingRateLimits()
        transport._rate_limits = transport_counter  # type: ignore[assignment]
        plugin = transport._registry.get_plugin("binance")
        policy_configs: list[object | None] = []

        def unexpected_policy_rebuild(config: object | None = None) -> RateLimitPolicy:
            policy_configs.append(config)
            raise AssertionError("transport must not rebuild an owned quota policy")

        monkeypatch.setattr(plugin, "rate_limit_policy", unexpected_policy_rebuild)
        manager = _TrackingRateLimitManager()
        quota_request = HistoricalRequest(
            exchange="binance",
            market_type="futures",
            endpoint="/fapi/v1/premiumIndex",
            symbol="BTCUSDT",
        )
        rule = RateLimitRule(
            name="exact_http",
            bucket_key="binance:futures:exact",
            endpoint="/fapi/v1/premiumIndex",
            capacity=100,
            refill_interval_seconds=0.01,
            max_concurrency=1,
        )
        reservation = RateLimitReservation(manager, rule, quota_request)
        await manager.acquire_nowait(rule, quota_request)
        request = TransportRequest(
            descriptor=StreamDescriptor(
                symbol="BTCUSDT",
                stream_type=StreamType.MARK_PRICE,
                exchange="binance",
                market_type="futures",
            ),
            quota_acquired=True,
            quota_semaphore_held=True,
            quota_reservation=reservation,
        )

        rows = await transport.http_fetch(request)
        assert manager.acquires == [
            (rule, quota_request),
            (rule, quota_request),
        ]
        assert policy_configs == []
        return (
            rows,
            manager.snapshot()[rule.bucket_key],
            manager.responses,
            transport_counter,
            request.quota_reservation is None,
        )

    rows, snapshot, responses, transport_counter, handoff_cleared = asyncio.run(run())
    assert len(rows) == 1
    assert snapshot["probe_in_flight"] is False
    assert snapshot["last_headers"] == {"x-mbx-used-weight-1m": "7"}
    assert responses == [
        {
            "status_code": 500,
            "headers": {},
            "body_code": None,
            "retry_after": None,
            "fallback_cooldown_seconds": 60.0,
        },
        {
            "status_code": 200,
            "headers": {"X-MBX-USED-WEIGHT-1M": "7"},
            "response_complete": False,
        },
        {
            "status_code": 200,
            "headers": {"X-MBX-USED-WEIGHT-1M": "7"},
            "body_code": None,
            "retry_after": None,
            "fallback_cooldown_seconds": 60.0,
        },
    ]
    assert transport_counter.acquire_calls == 0
    assert transport_counter.response_calls == 0
    assert handoff_cleared is True


def test_http_setup_without_endpoints_settles_exact_reservation() -> None:
    async def run() -> tuple[
        RateLimitReservation,
        dict[str, object],
        list[dict[str, object]],
        bool,
    ]:
        transport = _native_transport(IngestionConfig(http_base_urls_futures=[]))
        transport._http_session = _SequenceSession([])  # type: ignore[assignment]
        manager = _TrackingRateLimitManager()
        quota_request = HistoricalRequest(
            exchange="binance",
            market_type="futures",
            endpoint="/fapi/v1/premiumIndex",
            symbol="BTCUSDT",
        )
        rule = RateLimitRule(
            name="exact_http",
            bucket_key="binance:futures:exact",
            endpoint="/fapi/v1/premiumIndex",
            capacity=100,
            refill_interval_seconds=0.01,
            max_concurrency=1,
        )
        reservation = RateLimitReservation(manager, rule, quota_request)
        await manager.acquire_nowait(rule, quota_request)
        request = TransportRequest(
            descriptor=StreamDescriptor(
                symbol="BTCUSDT",
                stream_type=StreamType.MARK_PRICE,
                exchange="binance",
                market_type="futures",
            ),
            quota_acquired=True,
            quota_semaphore_held=True,
            quota_reservation=reservation,
        )

        with pytest.raises(TransportError, match="No HTTP endpoints configured"):
            await transport.http_fetch(request)
        return (
            reservation,
            manager.snapshot()[rule.bucket_key],
            manager.responses,
            request.quota_reservation is None,
        )

    reservation, snapshot, responses, handoff_cleared = asyncio.run(run())
    assert reservation.settled is True
    assert snapshot["probe_in_flight"] is False
    assert responses == [{"response_unknown": True}]
    assert handoff_cleared is True


def test_http_setup_cancellation_settles_exact_reservation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def run() -> tuple[
        RateLimitReservation,
        dict[str, object],
        list[dict[str, object]],
        bool,
    ]:
        transport = _native_transport(IngestionConfig())

        async def cancel_setup() -> None:
            raise asyncio.CancelledError

        monkeypatch.setattr(transport, "_ensure_http_session", cancel_setup)
        manager = _TrackingRateLimitManager()
        quota_request = HistoricalRequest(
            exchange="binance",
            market_type="futures",
            endpoint="/fapi/v1/premiumIndex",
            symbol="BTCUSDT",
        )
        rule = RateLimitRule(
            name="exact_http",
            bucket_key="binance:futures:exact",
            endpoint="/fapi/v1/premiumIndex",
            capacity=100,
            refill_interval_seconds=0.01,
            max_concurrency=1,
        )
        reservation = RateLimitReservation(manager, rule, quota_request)
        await manager.acquire_nowait(rule, quota_request)
        request = TransportRequest(
            descriptor=StreamDescriptor(
                symbol="BTCUSDT",
                stream_type=StreamType.MARK_PRICE,
                exchange="binance",
                market_type="futures",
            ),
            quota_acquired=True,
            quota_semaphore_held=True,
            quota_reservation=reservation,
        )

        with pytest.raises(asyncio.CancelledError):
            await transport.http_fetch(request)
        return (
            reservation,
            manager.snapshot()[rule.bucket_key],
            manager.responses,
            request.quota_reservation is None,
        )

    reservation, snapshot, responses, handoff_cleared = asyncio.run(run())
    assert reservation.settled is True
    assert snapshot["probe_in_flight"] is False
    assert responses == [{"response_unknown": True}]
    assert handoff_cleared is True


def test_http_429_defers_from_exact_reservation_manager() -> None:
    async def run() -> tuple[RateLimitDeferred, dict[str, object], _CountingRateLimits]:
        transport = _native_transport(
            IngestionConfig(
                http_base_urls_futures=["https://one.example"],
            )
        )
        transport._http_session = _SequenceSession(  # type: ignore[assignment]
            [_BinanceRateLimitResponse(status=429)]
        )
        transport_counter = _CountingRateLimits()
        transport._rate_limits = transport_counter  # type: ignore[assignment]
        manager = _TrackingRateLimitManager()
        quota_request = HistoricalRequest(
            exchange="binance",
            market_type="futures",
            endpoint="/fapi/v1/premiumIndex",
            symbol="BTCUSDT",
        )
        rule = RateLimitRule(
            name="exact_http",
            bucket_key="binance:futures:exact",
            endpoint="/fapi/v1/premiumIndex",
            capacity=100,
            refill_interval_seconds=60,
            max_concurrency=1,
            cooldown_seconds=0.05,
        )
        reservation = RateLimitReservation(manager, rule, quota_request)
        await manager.acquire_nowait(rule, quota_request)
        request = TransportRequest(
            descriptor=StreamDescriptor(
                symbol="BTCUSDT",
                stream_type=StreamType.MARK_PRICE,
                exchange="binance",
                market_type="futures",
            ),
            quota_acquired=True,
            quota_semaphore_held=True,
            quota_reservation=reservation,
            defer_on_rate_limit=True,
        )

        with pytest.raises(RateLimitDeferred) as caught:
            await transport.http_fetch(request)
        return caught.value, manager.snapshot()[rule.bucket_key], transport_counter

    deferred, snapshot, transport_counter = asyncio.run(run())
    assert deferred.bucket_key == "binance:futures:exact"
    assert deferred.reason == "cooldown"
    assert deferred.status_code == 429
    assert snapshot["probe_in_flight"] is False
    assert snapshot["last_status_code"] == 429
    assert transport_counter.acquire_calls == 0
    assert transport_counter.response_calls == 0


def test_http_200_parse_failure_accounts_headers_before_normal_failover() -> None:
    async def run() -> tuple[list[object], _SequenceSession, _CountingRateLimits]:
        config = IngestionConfig(
            http_base_urls_futures=["https://one.example", "https://two.example"],
        )
        transport = _native_transport(config)
        session = _SequenceSession(
            [
                _MalformedJsonResponse(
                    {},
                    headers={"X-MBX-USED-WEIGHT-1M": "777"},
                ),
                _FakeResponse(
                    {
                        "symbol": "BTCUSDT",
                        "markPrice": "101",
                        "indexPrice": "100",
                        "estimatedSettlePrice": "100.5",
                        "lastFundingRate": "0.0001",
                        "nextFundingTime": 1_700_028_800_000,
                        "time": 1_700_000_000_000,
                    }
                ),
            ]
        )
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
        transport = _native_transport(config)
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
        transport = _native_transport(config)
        session = _SequenceSession(
            [
                _BinanceRateLimitResponse(status=status_code),
            ]
        )
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
        transport = _native_transport(config)
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
        transport = _native_transport(config)
        session = _SequenceSession(
            [
                _BinanceRateLimitBodyReadFailureResponse(status=status_code),
            ]
        )
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
        transport = _native_transport(config)
        session = _SequenceSession(
            [
                _GatedBinanceRateLimitResponse(entered, release),
            ]
        )
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
