from __future__ import annotations

import asyncio
import time

from app.data_engine.backfill.config import BackfillConfig
from app.data_engine.backfill.fetcher import HistoricalFetcher
from app.data_engine.backfill.models import BackfillTask
from app.data_engine.ingestion.transport import TransportError


class _DummyTransport:
    pass


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


def test_429_backoff_respects_retry_after_header() -> None:
    cfg = BackfillConfig(fetch_429_backoff_seconds=0.1)
    fetcher = HistoricalFetcher(cfg, _DummyTransport())  # type: ignore[arg-type]
    task = _task("binance", "futures")
    exc = TransportError("HTTP 429", status_code=429, retry_after=2.5)

    assert fetcher._retry_backoff_seconds(task, exc) == 2.5


def test_rate_limit_cooldown_blocks_exchange_key() -> None:
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
