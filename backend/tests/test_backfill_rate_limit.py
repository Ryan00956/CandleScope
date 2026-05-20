from __future__ import annotations

import asyncio
import time

from app.data_engine.backfill.config import BackfillConfig
from app.data_engine.backfill.fetcher import HistoricalFetcher
from app.data_engine.backfill.models import BackfillTask
from app.data_engine.ingestion.transport import TransportError
from app.exchanges.rate_limits import HistoricalRequest, RateLimitManager, RateLimitRule


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


def test_rate_limit_cooldown_blocks_matching_bucket() -> None:
    async def run() -> float:
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
        await fetcher._rate_limit(task)
        return time.monotonic() - start

    assert asyncio.run(run()) >= 0.045


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
