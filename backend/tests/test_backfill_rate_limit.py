from __future__ import annotations

import asyncio
import time

import pytest

from app.data_engine.backfill.config import BackfillConfig
from app.data_engine.backfill.fetcher import HistoricalFetcher
from app.data_engine.backfill.models import BackfillTask
from app.data_engine.ingestion.transport import TransportError
from app.exchanges.rate_limits import (
    HistoricalRequest,
    RateLimitDeferred,
    RateLimitManager,
    RateLimitRule,
)


class _DummyTransport:
    pass


class _OrderedTransport:
    def __init__(self, events: list[str]) -> None:
        self.events = events

    async def http_fetch(self, req):  # noqa: ANN001
        self.events.append("http_fetch")
        return []


class _FailsOnceTransport:
    def __init__(self, events: list[str]) -> None:
        self.events = events
        self.calls = 0

    async def http_fetch(self, req):  # noqa: ANN001
        self.calls += 1
        self.events.append(f"http_fetch:{self.calls}")
        if self.calls == 1:
            raise TransportError("temporary failure")
        return []


class _RateLimitedTransport:
    def __init__(self, *, status_code: int, body_code: str | None = None) -> None:
        self.status_code = status_code
        self.body_code = body_code
        self.calls = 0

    async def http_fetch(self, req):  # noqa: ANN001
        self.calls += 1
        raise TransportError(
            f"HTTP {self.status_code}",
            status_code=self.status_code,
            retry_after=0.05,
            headers={"Retry-After": "0.05"},
            body_code=self.body_code,
        )


class _GatedRateLimitedTransport(_RateLimitedTransport):
    def __init__(self, entered: asyncio.Event, release: asyncio.Event) -> None:
        super().__init__(status_code=418, body_code="-1003")
        self.entered = entered
        self.release = release

    async def http_fetch(self, req):  # noqa: ANN001
        self.calls += 1
        self.entered.set()
        await self.release.wait()
        raise TransportError(
            "HTTP 418",
            status_code=418,
            retry_after=0.05,
            headers={"Retry-After": "0.05"},
            body_code="-1003",
        )


def _task(exchange: str, market_type: str = "spot") -> BackfillTask:
    return BackfillTask(
        symbol="BTCUSDT" if exchange == "binance" else "BTC-USDT",
        interval="1m",
        start_ms=0,
        end_ms=60_000,
        exchange=exchange,
        market_type=market_type,
    )


def test_okx_backfill_defaults_are_more_conservative() -> None:
    cfg = BackfillConfig()
    fetcher = HistoricalFetcher(cfg, _DummyTransport())  # type: ignore[arg-type]

    okx_task = _task("okx", "futures")
    binance_task = _task("binance", "spot")

    assert fetcher._base_delay_for_task(okx_task) >= fetcher._base_delay_for_task(binance_task)
    assert fetcher._get_exchange_semaphore(okx_task)._value == cfg.fetch_okx_concurrency


def test_binance_futures_backfill_defaults_are_conservative() -> None:
    cfg = BackfillConfig()
    fetcher = HistoricalFetcher(cfg, _DummyTransport())  # type: ignore[arg-type]

    task = _task("binance", "futures")

    assert fetcher._base_delay_for_task(task) == cfg.fetch_binance_futures_rate_limit_delay
    assert fetcher._get_exchange_semaphore(task)._value == cfg.fetch_binance_futures_concurrency
    assert cfg.fetch_binance_futures_concurrency == 1
    assert cfg.fetch_429_backoff_seconds >= 30


def test_binance_futures_kline_weight_depends_on_limit() -> None:
    cfg = BackfillConfig()
    fetcher = HistoricalFetcher(cfg, _DummyTransport())  # type: ignore[arg-type]
    task = _task("binance", "futures")
    policy = fetcher._rate_limit_policy(task)

    small = HistoricalRequest(
        exchange="binance",
        market_type="futures",
        endpoint="/fapi/v1/klines",
        symbol="BTCUSDT",
        interval="1m",
        limit=99,
    )
    medium = HistoricalRequest(
        exchange="binance",
        market_type="futures",
        endpoint="/fapi/v1/klines",
        symbol="BTCUSDT",
        interval="1m",
        limit=499,
    )
    default_page = HistoricalRequest(
        exchange="binance",
        market_type="futures",
        endpoint="/fapi/v1/klines",
        symbol="BTCUSDT",
        interval="1m",
        limit=1000,
    )

    assert policy.rule_for(small).request_cost(small) == 1
    assert policy.rule_for(medium).request_cost(medium) == 2
    assert policy.rule_for(default_page).request_cost(default_page) == 5


def test_exchange_rate_limit_buckets_are_endpoint_aware() -> None:
    cfg = BackfillConfig()
    binance_fetcher = HistoricalFetcher(cfg, _DummyTransport())  # type: ignore[arg-type]
    okx_fetcher = HistoricalFetcher(cfg, _DummyTransport())  # type: ignore[arg-type]

    binance_request = binance_fetcher._historical_request(
        _task("binance", "spot"),
    )
    okx_request = okx_fetcher._historical_request(
        _task("okx", "spot"),
    )
    okx_market_request = HistoricalRequest(
        exchange="okx",
        market_type="spot",
        endpoint="/api/v5/market/candles",
        symbol="BTC-USDT",
        interval="1m",
        limit=300,
    )

    binance_rule = binance_fetcher._rate_limit_rule(_task("binance"), binance_request)
    okx_policy = okx_fetcher._rate_limit_policy(_task("okx"))
    okx_history_rule = okx_policy.rule_for(okx_request)
    okx_market_rule = okx_policy.rule_for(okx_market_request)

    assert binance_rule.bucket_key == "binance:spot:request_weight:ip"
    assert okx_history_rule.bucket_key == "okx:history-candles:ip"
    assert okx_market_rule.bucket_key == "okx:market-candles:ip"


def test_exchange_rate_limit_capacities_apply_safety_factor() -> None:
    cfg = BackfillConfig(
        fetch_rate_limit_safety_factor=0.5,
        fetch_binance_spot_weight_per_minute=100,
        fetch_binance_futures_weight_per_minute=200,
        fetch_okx_history_candles_requests_per_2s=10,
        fetch_okx_candles_requests_per_2s=12,
    )
    binance_fetcher = HistoricalFetcher(cfg, _DummyTransport())  # type: ignore[arg-type]
    okx_fetcher = HistoricalFetcher(cfg, _DummyTransport())  # type: ignore[arg-type]

    binance_spot = HistoricalRequest(
        exchange="binance",
        market_type="spot",
        endpoint="/api/v3/klines",
        symbol="BTCUSDT",
        interval="1m",
        limit=1000,
    )
    binance_futures = HistoricalRequest(
        exchange="binance",
        market_type="futures",
        endpoint="/fapi/v1/klines",
        symbol="BTCUSDT",
        interval="1m",
        limit=1000,
    )
    okx_history = HistoricalRequest(
        exchange="okx",
        market_type="spot",
        endpoint="/api/v5/market/history-candles",
        symbol="BTC-USDT",
        interval="1m",
        limit=300,
    )
    okx_candles = HistoricalRequest(
        exchange="okx",
        market_type="spot",
        endpoint="/api/v5/market/candles",
        symbol="BTC-USDT",
        interval="1m",
        limit=300,
    )

    assert binance_fetcher._rate_limit_policy(_task("binance")).rule_for(
        binance_spot
    ).capacity == 50
    assert binance_fetcher._rate_limit_policy(_task("binance", "futures")).rule_for(
        binance_futures
    ).capacity == 100
    assert okx_fetcher._rate_limit_policy(_task("okx")).rule_for(
        okx_history
    ).capacity == 5
    assert okx_fetcher._rate_limit_policy(_task("okx")).rule_for(
        okx_candles
    ).capacity == 6


def test_global_and_binance_spot_concurrency_are_separate() -> None:
    cfg = BackfillConfig(
        fetch_concurrency=2,
        fetch_global_concurrency=8,
        fetch_binance_spot_concurrency=3,
    )
    fetcher = HistoricalFetcher(cfg, _DummyTransport())  # type: ignore[arg-type]
    binance_task = _task("binance", "spot")
    okx_task = _task("okx", "spot")

    assert fetcher.snapshot()["global_concurrency"] == 8
    assert fetcher._get_exchange_semaphore(binance_task)._value == 3
    assert fetcher._get_exchange_semaphore(okx_task)._value == cfg.fetch_okx_concurrency


def test_legacy_fetch_concurrency_still_drives_binance_spot_when_unset() -> None:
    cfg = BackfillConfig(fetch_concurrency=4, fetch_binance_spot_concurrency=None)
    fetcher = HistoricalFetcher(cfg, _DummyTransport())  # type: ignore[arg-type]

    assert fetcher._get_exchange_semaphore(_task("binance", "spot"))._value == 4


def test_exchange_rate_limit_rules_normalize_nonpositive_config() -> None:
    cfg = BackfillConfig(
        fetch_binance_futures_concurrency=-5,
        fetch_okx_concurrency=0,
        fetch_429_backoff_seconds=-1,
    )
    binance_fetcher = HistoricalFetcher(cfg, _DummyTransport())  # type: ignore[arg-type]
    okx_fetcher = HistoricalFetcher(cfg, _DummyTransport())  # type: ignore[arg-type]
    binance_request = HistoricalRequest(
        exchange="binance",
        market_type="futures",
        endpoint="/fapi/v1/klines",
        symbol="BTCUSDT",
        interval="1m",
        limit=1000,
    )
    okx_request = okx_fetcher._historical_request(_task("okx", "spot"))

    binance_rule = binance_fetcher._rate_limit_policy(
        _task("binance", "futures"),
    ).rule_for(binance_request)
    okx_rule = okx_fetcher._rate_limit_policy(_task("okx")).rule_for(okx_request)

    assert binance_rule.max_concurrency == 1
    assert binance_rule.cooldown_seconds == 0
    assert okx_rule.max_concurrency == 1
    assert okx_rule.cooldown_seconds == 2.0


def test_429_backoff_respects_retry_after_header() -> None:
    cfg = BackfillConfig(fetch_429_backoff_seconds=0.1)
    fetcher = HistoricalFetcher(cfg, _DummyTransport())  # type: ignore[arg-type]
    task = _task("binance", "futures")
    exc = TransportError("HTTP 429", status_code=429, retry_after=2.5)

    assert fetcher._retry_backoff_seconds(task, exc) == 2.5


def test_historical_fetcher_rate_limits_before_http_fetch() -> None:
    async def run() -> list[str]:
        events: list[str] = []
        cfg = BackfillConfig(fetch_rate_limit_delay=0)
        fetcher = HistoricalFetcher(cfg, _OrderedTransport(events))  # type: ignore[arg-type]

        async def record_rate_limit(*args, **kwargs):  # noqa: ANN002, ANN003
            events.append("rate_limit")

        fetcher._rate_limit = record_rate_limit  # type: ignore[method-assign]

        result = await fetcher.fetch([_task("binance", "spot")])
        assert result[0].status.value == "completed"
        return events

    assert asyncio.run(run()) == ["rate_limit", "http_fetch"]


def test_historical_fetcher_rate_limits_once_per_retry_attempt() -> None:
    async def run() -> list[str]:
        events: list[str] = []
        cfg = BackfillConfig(fetch_rate_limit_delay=0, fetch_max_retries=1)
        fetcher = HistoricalFetcher(cfg, _FailsOnceTransport(events))  # type: ignore[arg-type]

        async def record_rate_limit(*args, **kwargs):  # noqa: ANN002, ANN003
            events.append("rate_limit")

        fetcher._rate_limit = record_rate_limit  # type: ignore[method-assign]

        result = await fetcher.fetch([_task("binance", "spot")])
        assert result[0].status.value == "completed"
        return events

    assert asyncio.run(run()) == [
        "rate_limit",
        "http_fetch:1",
        "rate_limit",
        "http_fetch:2",
    ]


def test_rate_limit_cooldown_defers_matching_bucket_without_sleeping() -> None:
    async def run() -> tuple[float, RateLimitDeferred]:
        cfg = BackfillConfig(
            fetch_rate_limit_delay=0,
            fetch_binance_futures_rate_limit_delay=0,
            fetch_429_backoff_seconds=0.05,
        )
        fetcher = HistoricalFetcher(cfg, _DummyTransport())  # type: ignore[arg-type]
        task = _task("binance", "futures")

        await fetcher._record_rate_limit_cooldown(
            task,
            TransportError("HTTP 429", status_code=429),
        )
        start = time.monotonic()
        with pytest.raises(RateLimitDeferred) as caught:
            await fetcher._rate_limit(task)
        return time.monotonic() - start, caught.value

    elapsed, deferred = asyncio.run(run())
    assert elapsed < 0.04
    assert deferred.retry_after_seconds >= 0.04
    assert deferred.retry_at_ms is not None
    assert deferred.bucket_key == "binance:futures:request_weight:ip"


def test_rate_limit_cooldown_blocks_only_matching_bucket() -> None:
    async def run() -> dict:
        cfg = BackfillConfig(fetch_429_backoff_seconds=0.05)
        fetcher = HistoricalFetcher(cfg, _DummyTransport())  # type: ignore[arg-type]
        binance_task = _task("binance", "spot")
        okx_task = _task("okx", "spot")

        await fetcher._record_rate_limit_cooldown(
            binance_task,
            TransportError("HTTP 429", status_code=429),
        )
        before = time.monotonic()
        await fetcher._rate_limit(okx_task)
        okx_elapsed = time.monotonic() - before

        snapshot = fetcher.snapshot()["exchange_rate_limits"]
        return {
            "okx_elapsed": okx_elapsed,
            "snapshot": snapshot,
        }

    result = asyncio.run(run())
    assert result["okx_elapsed"] < 0.04
    assert "binance:spot:request_weight:ip" in result["snapshot"]


def test_binance_used_weight_header_is_recorded_in_bucket_snapshot() -> None:
    cfg = BackfillConfig()
    fetcher = HistoricalFetcher(cfg, _DummyTransport())  # type: ignore[arg-type]
    task = _task("binance", "spot")
    request = fetcher._historical_request(task)
    rule = fetcher._rate_limit_rule(task, request)
    manager = RateLimitManager()

    manager.record_response(
        rule,
        status_code=200,
        headers={"X-MBX-USED-WEIGHT-1M": "10"},
    )

    snapshot = manager.snapshot()[rule.bucket_key]
    assert snapshot["rule"] == "binance_spot_klines"
    assert snapshot["algorithm"] == "header_weight"
    assert snapshot["refill_interval_seconds"] == 60.0
    assert snapshot["max_concurrency"] == rule.max_concurrency
    assert snapshot["last_status_code"] == 200
    assert snapshot["last_headers"]["x-mbx-used-weight-1m"] == "10"
    assert snapshot["tokens"] <= rule.capacity - 10


def test_rate_limit_manager_uses_retry_after_header_for_cooldown() -> None:
    cfg = BackfillConfig()
    fetcher = HistoricalFetcher(cfg, _DummyTransport())  # type: ignore[arg-type]
    task = _task("binance", "spot")
    request = fetcher._historical_request(task)
    rule = fetcher._rate_limit_rule(task, request)
    manager = RateLimitManager()

    before = time.monotonic()
    manager.record_response(
        rule,
        status_code=429,
        headers={"Retry-After": "0.05"},
    )

    snapshot = manager.snapshot()[rule.bucket_key]
    assert snapshot["cooldown_until"] - before >= 0.04
    assert snapshot["cooldown_remaining_seconds"] > 0
    assert snapshot["last_headers"]["retry-after"] == "0.05"


def test_binance_418_opens_exchange_ip_circuit_across_buckets() -> None:
    async def run() -> tuple:
        manager = RateLimitManager()
        futures_request = HistoricalRequest(
            exchange="binance",
            market_type="futures",
            endpoint="/fapi/v1/klines",
            symbol="BTCUSDT",
        )
        spot_request = HistoricalRequest(
            exchange="binance",
            market_type="spot",
            endpoint="/api/v3/klines",
            symbol="BTCUSDT",
        )
        okx_request = HistoricalRequest(
            exchange="okx",
            market_type="spot",
            endpoint="/api/v5/market/history-candles",
            symbol="BTC-USDT",
        )
        futures_rule = RateLimitRule(
            name="binance_futures",
            bucket_key="binance:futures:request_weight:ip",
            capacity=100,
            refill_interval_seconds=60,
        )
        spot_rule = RateLimitRule(
            name="binance_spot",
            bucket_key="binance:spot:request_weight:ip",
            capacity=100,
            refill_interval_seconds=60,
        )
        okx_rule = RateLimitRule(
            name="okx_history",
            bucket_key="okx:history-candles:ip",
            capacity=100,
            refill_interval_seconds=2,
        )

        manager.record_response(
            futures_rule,
            status_code=418,
            body_code="-1003",
            headers={"Retry-After": "0.05"},
        )
        return (
            await manager.inspect(futures_rule, futures_request),
            await manager.inspect(spot_rule, spot_request),
            await manager.inspect(okx_rule, okx_request),
            manager.circuit_snapshot(),
        )

    futures, spot, okx, circuits = asyncio.run(run())
    assert futures.allowed is False and futures.reason == "circuit_open"
    assert spot.allowed is False and spot.reason == "circuit_open"
    assert futures.circuit_key == spot.circuit_key == "binance:ip"
    assert futures.status_code == spot.status_code == 418
    assert futures.body_code == spot.body_code == "-1003"
    assert okx.allowed is True
    assert circuits["binance:ip"]["open"] is True


def test_binance_429_cools_only_the_matching_budget_bucket() -> None:
    async def run() -> tuple:
        manager = RateLimitManager()
        futures_request = HistoricalRequest(
            exchange="binance",
            market_type="futures",
            endpoint="/fapi/v1/klines",
            symbol="BTCUSDT",
        )
        spot_request = HistoricalRequest(
            exchange="binance",
            market_type="spot",
            endpoint="/api/v3/klines",
            symbol="BTCUSDT",
        )
        futures_rule = RateLimitRule(
            name="binance_futures",
            bucket_key="binance:futures:request_weight:ip",
            capacity=100,
            refill_interval_seconds=60,
        )
        spot_rule = RateLimitRule(
            name="binance_spot",
            bucket_key="binance:spot:request_weight:ip",
            capacity=100,
            refill_interval_seconds=60,
        )

        manager.record_response(
            futures_rule,
            status_code=429,
            headers={"Retry-After": "0.05"},
        )
        return (
            await manager.inspect(futures_rule, futures_request),
            await manager.inspect(spot_rule, spot_request),
            manager.circuit_snapshot(),
        )

    futures, spot, circuits = asyncio.run(run())
    assert futures.allowed is False and futures.reason == "cooldown"
    assert spot.allowed is True
    assert circuits == {}


def test_429_recovery_admits_one_probe_without_releasing_a_full_bucket() -> None:
    async def run() -> tuple:
        manager = RateLimitManager()
        request = HistoricalRequest(
            exchange="binance",
            market_type="futures",
            endpoint="/fapi/v1/klines",
            symbol="BTCUSDT",
        )
        rule = RateLimitRule(
            name="binance_futures",
            bucket_key="binance:futures:request_weight:ip",
            capacity=100,
            refill_interval_seconds=60,
        )

        manager.record_response(
            rule,
            status_code=429,
            headers={"Retry-After": "0.02"},
        )
        during = await manager.inspect(rule, request)
        await asyncio.sleep(0.05)
        first = await manager.acquire_nowait(rule, request)
        in_flight = manager.snapshot()[rule.bucket_key]
        with pytest.raises(RateLimitDeferred) as caught:
            await manager.acquire_nowait(rule, request)
        manager.record_response(rule, status_code=200)
        released = manager.snapshot()[rule.bucket_key]
        return during, first, caught.value, in_flight, released

    during, first, deferred, in_flight, released = asyncio.run(run())
    assert during.allowed is False and during.reason == "cooldown"
    assert first.cost == 1
    assert deferred.reason == "probe_in_flight"
    assert deferred.retry_after_seconds > 0
    assert in_flight["recovery_probe_pending"] is False
    assert in_flight["recovery_generation"] == 1
    assert in_flight["last_recovery_probe_at_ms"] is not None
    assert in_flight["probe_in_flight"] is True
    assert in_flight["probe_kind"] == "recovery"
    assert released["probe_in_flight"] is False
    assert released["last_probe_release_reason"] == "response"


def test_conservative_cold_start_admits_only_one_exact_request_cost() -> None:
    async def run() -> tuple:
        manager = RateLimitManager(conservative_cold_start=True)
        request = HistoricalRequest(
            exchange="binance",
            market_type="spot",
            endpoint="/api/v3/exchangeInfo",
            symbol="*",
        )
        rule = RateLimitRule(
            name="binance_spot_exchange_info",
            bucket_key="binance:spot:request_weight:ip",
            capacity=100,
            refill_interval_seconds=60,
            cost=lambda _request: 20,
        )
        inspected = await manager.inspect(rule, request)
        first = await manager.acquire_nowait(rule, request)
        with pytest.raises(RateLimitDeferred) as caught:
            await manager.acquire_nowait(rule, request)
        return inspected, first, caught.value, manager.snapshot()[rule.bucket_key]

    inspected, first, deferred, snapshot = asyncio.run(run())
    assert inspected.allowed is True
    assert first.cost == 20
    assert deferred.reason == "probe_in_flight"
    assert snapshot["cold_start_probe_pending"] is False
    assert snapshot["probe_in_flight"] is True
    assert snapshot["probe_kind"] == "cold_start"
    assert snapshot["tokens"] < 20


def test_cold_start_probe_blocks_concurrent_request_until_unknown_response() -> None:
    async def run() -> tuple:
        manager = RateLimitManager(
            conservative_cold_start=True,
            probe_lease_seconds=1.0,
        )
        request = HistoricalRequest(
            exchange="binance",
            market_type="spot",
            endpoint="/api/v3/exchangeInfo",
            symbol="*",
        )
        rule = RateLimitRule(
            name="binance_spot_exchange_info",
            bucket_key="binance:spot:request_weight:ip",
            capacity=100,
            refill_interval_seconds=1,
            cost=lambda _request: 20,
        )
        acquired = asyncio.Event()
        finish_with_error = asyncio.Event()

        async def physical_probe() -> None:
            await manager.acquire_nowait(rule, request)
            acquired.set()
            await finish_with_error.wait()
            manager.record_response(rule, status_code=None)

        probe_task = asyncio.create_task(physical_probe())
        await acquired.wait()
        with pytest.raises(RateLimitDeferred) as caught:
            await manager.acquire_nowait(rule, request)
        blocked = manager.snapshot()[rule.bucket_key]
        finish_with_error.set()
        await probe_task
        after_error = await manager.inspect(rule, request)
        released = manager.snapshot()[rule.bucket_key]
        return caught.value, blocked, after_error, released

    deferred, blocked, after_error, released = asyncio.run(run())
    assert deferred.reason == "probe_in_flight"
    assert blocked["probe_in_flight"] is True
    assert after_error.allowed is False and after_error.reason == "budget"
    assert released["probe_in_flight"] is False
    assert released["last_probe_release_reason"] == "unknown_response"
    assert released["tokens"] < 20


def test_429_probe_ignores_stale_response_and_waits_for_owner_response() -> None:
    async def run() -> tuple:
        manager = RateLimitManager(probe_lease_seconds=1.0)
        request = HistoricalRequest(
            exchange="okx",
            market_type="spot",
            endpoint="/api/v5/market/history-candles",
            symbol="BTC-USDT",
        )
        rule = RateLimitRule(
            name="okx_history",
            bucket_key="okx:history-candles:ip",
            capacity=20,
            refill_interval_seconds=2,
            cost=lambda _request: 2,
        )
        manager.record_response(
            rule,
            status_code=429,
            headers={"Retry-After": "0.02"},
        )
        await asyncio.sleep(0.05)
        acquired = asyncio.Event()
        owner_can_finish = asyncio.Event()

        async def physical_probe() -> None:
            await manager.acquire_nowait(rule, request)
            acquired.set()
            await owner_can_finish.wait()
            manager.record_response(rule, status_code=200)

        probe_task = asyncio.create_task(physical_probe())
        await acquired.wait()
        with pytest.raises(RateLimitDeferred) as first_caught:
            await manager.acquire_nowait(rule, request)

        # Simulate an older pre-429 request returning in a different task. It
        # must not release the newly admitted recovery probe.
        manager.record_response(rule, status_code=200)
        with pytest.raises(RateLimitDeferred) as stale_caught:
            await manager.acquire_nowait(rule, request)
        still_blocked = manager.snapshot()[rule.bucket_key]

        owner_can_finish.set()
        await probe_task
        released = manager.snapshot()[rule.bucket_key]
        return first_caught.value, stale_caught.value, still_blocked, released

    first, stale, still_blocked, released = asyncio.run(run())
    assert first.reason == "probe_in_flight"
    assert stale.reason == "probe_in_flight"
    assert still_blocked["probe_in_flight"] is True
    assert released["probe_in_flight"] is False
    assert released["last_probe_release_reason"] == "response"


def test_probe_lease_expiry_releases_into_zero_token_ramp() -> None:
    async def run() -> tuple:
        manager = RateLimitManager(
            conservative_cold_start=True,
            probe_lease_seconds=0.01,
        )
        request = HistoricalRequest(
            exchange="binance",
            market_type="futures",
            endpoint="/fapi/v1/klines",
            symbol="BTCUSDT",
        )
        rule = RateLimitRule(
            name="binance_futures",
            bucket_key="binance:futures:request_weight:ip",
            capacity=10,
            refill_interval_seconds=1,
        )
        await manager.acquire_nowait(rule, request)
        with pytest.raises(RateLimitDeferred) as in_flight:
            await manager.acquire_nowait(rule, request)
        await asyncio.sleep(0.03)
        after_expiry = await manager.inspect(rule, request)
        snapshot = manager.snapshot()[rule.bucket_key]
        return in_flight.value, after_expiry, snapshot

    in_flight, after_expiry, snapshot = asyncio.run(run())
    assert in_flight.reason == "probe_in_flight"
    assert after_expiry.allowed is False and after_expiry.reason == "budget"
    assert snapshot["probe_in_flight"] is False
    assert snapshot["last_probe_release_reason"] == "lease_expired"
    assert snapshot["tokens"] == 0


def test_headers_only_accounting_does_not_release_probe_lease() -> None:
    async def run() -> tuple:
        manager = RateLimitManager(conservative_cold_start=True)
        request = HistoricalRequest(
            exchange="binance",
            market_type="spot",
            endpoint="/api/v3/exchangeInfo",
            symbol="*",
        )
        rule = RateLimitRule(
            name="binance_spot_exchange_info",
            bucket_key="binance:spot:request_weight:ip",
            capacity=100,
            refill_interval_seconds=60,
            cost=lambda _request: 20,
        )
        await manager.acquire_nowait(rule, request)
        manager.record_response(
            rule,
            status_code=200,
            headers={"X-MBX-USED-WEIGHT-1M": "20"},
            response_complete=False,
        )
        with pytest.raises(RateLimitDeferred) as caught:
            await manager.acquire_nowait(rule, request)
        manager.record_response(rule, response_unknown=True)
        return caught.value, manager.snapshot()[rule.bucket_key]

    deferred, snapshot = asyncio.run(run())
    assert deferred.reason == "probe_in_flight"
    assert snapshot["probe_in_flight"] is False
    assert snapshot["last_probe_release_reason"] == "unknown_response"
    assert snapshot["last_status_code"] == 200
    assert snapshot["last_headers"] == {"x-mbx-used-weight-1m": "20"}
    assert snapshot["tokens"] == 0


def test_repeated_429_extends_cooldown_and_keeps_one_recovery_probe() -> None:
    async def run() -> tuple:
        manager = RateLimitManager()
        request = HistoricalRequest(
            exchange="okx",
            market_type="spot",
            endpoint="/api/v5/market/history-candles",
            symbol="BTC-USDT",
        )
        rule = RateLimitRule(
            name="okx_history",
            bucket_key="okx:history-candles:ip",
            capacity=20,
            refill_interval_seconds=2,
            cost=lambda _request: 2,
        )
        manager.record_response(
            rule,
            status_code=429,
            headers={"Retry-After": "0.01"},
        )
        first_deadline = manager.snapshot()[rule.bucket_key]["cooldown_until"]
        await asyncio.sleep(0.002)
        manager.record_response(
            rule,
            status_code=429,
            headers={"Retry-After": "0.02"},
        )
        extended = manager.snapshot()[rule.bucket_key]
        await asyncio.sleep(0.04)
        probe = await manager.acquire_nowait(rule, request)
        with pytest.raises(RateLimitDeferred) as caught:
            await manager.acquire_nowait(rule, request)
        return first_deadline, extended, probe, caught.value

    first_deadline, extended, probe, deferred = asyncio.run(run())
    assert extended["cooldown_until"] > first_deadline
    assert extended["recovery_generation"] == 2
    assert probe.cost == 2
    assert deferred.reason == "probe_in_flight"


def test_bucket_created_after_418_recovery_cannot_restart_at_full_capacity() -> None:
    async def run() -> tuple:
        manager = RateLimitManager()
        futures_request = HistoricalRequest(
            exchange="binance",
            market_type="futures",
            endpoint="/fapi/v1/klines",
            symbol="BTCUSDT",
        )
        spot_request = HistoricalRequest(
            exchange="binance",
            market_type="spot",
            endpoint="/api/v3/klines",
            symbol="BTCUSDT",
        )
        futures_rule = RateLimitRule(
            name="binance_futures",
            bucket_key="binance:futures:request_weight:ip",
            capacity=60,
            refill_interval_seconds=60,
        )
        spot_rule = RateLimitRule(
            name="binance_spot",
            bucket_key="binance:spot:request_weight:ip",
            capacity=60,
            refill_interval_seconds=60,
        )
        manager.record_response(
            futures_rule,
            status_code=418,
            body_code="-1003",
            headers={"Retry-After": "0.02"},
        )
        await asyncio.sleep(0.05)

        futures = await manager.inspect(futures_rule, futures_request)
        # This bucket did not exist when the 418 was recorded. It is created
        # only after another bucket has already completed circuit recovery.
        spot = await manager.inspect(spot_rule, spot_request)
        return futures, spot, manager.snapshot()

    futures, spot, snapshot = asyncio.run(run())
    assert futures.allowed is False and futures.reason == "budget"
    assert spot.allowed is False and spot.reason == "budget"
    assert snapshot["binance:futures:request_weight:ip"]["circuit_generation"] == 1
    assert snapshot["binance:spot:request_weight:ip"]["circuit_generation"] == 1


@pytest.mark.parametrize(
    ("status_code", "body_code"),
    [(429, None), (418, "-1003")],
)
def test_historical_fetcher_propagates_rate_limit_as_scheduler_deferral(
    status_code: int,
    body_code: str | None,
) -> None:
    async def run() -> tuple[RateLimitDeferred, int, float]:
        transport = _RateLimitedTransport(
            status_code=status_code,
            body_code=body_code,
        )
        fetcher = HistoricalFetcher(
            BackfillConfig(
                fetch_rate_limit_delay=0,
                fetch_binance_futures_rate_limit_delay=0,
                fetch_max_retries=5,
            ),
            transport,  # type: ignore[arg-type]
        )
        started = time.monotonic()
        with pytest.raises(RateLimitDeferred) as caught:
            await fetcher.fetch([_task("binance", "futures")])
        return caught.value, transport.calls, time.monotonic() - started

    deferred, calls, elapsed = asyncio.run(run())
    assert calls == 1
    assert elapsed < 0.04
    assert deferred.retry_after_seconds >= 0.04
    assert deferred.status_code == status_code
    assert deferred.body_code == body_code


def test_backfill_waiter_rechecks_circuit_after_exchange_semaphore() -> None:
    async def run() -> tuple[RateLimitDeferred, int]:
        entered = asyncio.Event()
        release = asyncio.Event()
        transport = _GatedRateLimitedTransport(entered, release)
        fetcher = HistoricalFetcher(
            BackfillConfig(
                fetch_global_concurrency=2,
                fetch_binance_futures_concurrency=1,
                fetch_rate_limit_delay=0,
                fetch_binance_futures_rate_limit_delay=0,
            ),
            transport,  # type: ignore[arg-type]
        )
        fetch_task = asyncio.create_task(fetcher.fetch([
            _task("binance", "futures"),
            _task("binance", "futures"),
        ]))
        await entered.wait()
        await asyncio.sleep(0)
        release.set()
        with pytest.raises(RateLimitDeferred) as caught:
            await fetch_task
        return caught.value, transport.calls

    deferred, calls = asyncio.run(run())
    assert calls == 1
    assert deferred.status_code == 418
    assert deferred.reason == "circuit_open"


def test_rate_limit_manager_reports_token_refill_wait() -> None:
    async def run() -> dict:
        request = HistoricalRequest(
            exchange="demo",
            market_type="spot",
            endpoint="/demo",
            symbol="BTCUSDT",
        )
        rule = RateLimitRule(
            name="demo_rule",
            bucket_key="demo:spot",
            capacity=1,
            refill_interval_seconds=0.05,
        )
        manager = RateLimitManager()

        first = await manager.acquire(rule, request)
        second = await manager.acquire(rule, request)

        return {
            "first": first,
            "second": second,
            "snapshot": manager.snapshot()[rule.bucket_key],
        }

    result = asyncio.run(run())
    assert result["first"].wait_seconds == 0
    assert result["second"].wait_seconds >= 0.045
    assert result["snapshot"]["last_wait_seconds"] >= 0.045


def test_okx_50011_body_code_uses_matching_bucket_cooldown() -> None:
    async def run() -> dict:
        cfg = BackfillConfig(fetch_429_backoff_seconds=0.05)
        fetcher = HistoricalFetcher(cfg, _DummyTransport())  # type: ignore[arg-type]
        okx_task = _task("okx", "spot")
        binance_task = _task("binance", "spot")

        await fetcher._record_rate_limit_cooldown(
            okx_task,
            TransportError("OKX rate limit", status_code=200, body_code="50011"),
        )
        before = time.monotonic()
        await fetcher._rate_limit(binance_task)
        binance_elapsed = time.monotonic() - before
        return {
            "binance_elapsed": binance_elapsed,
            "snapshot": fetcher.snapshot()["exchange_rate_limits"],
        }

    result = asyncio.run(run())
    assert result["binance_elapsed"] < 0.04
    assert "okx:history-candles:ip" in result["snapshot"]
    assert result["snapshot"]["okx:history-candles:ip"]["last_body_code"] == "50011"
