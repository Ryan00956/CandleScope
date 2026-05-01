from __future__ import annotations

from app.data_engine.backfill.config import BackfillConfig
from app.data_engine.backfill.fetcher import HistoricalFetcher
from app.data_engine.backfill.models import BackfillTask


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
    binance_task = _task("binance", "futures")

    assert fetcher._base_delay_for_task(okx_task) >= fetcher._base_delay_for_task(binance_task)
    assert fetcher._get_exchange_semaphore(okx_task)._value == cfg.fetch_okx_concurrency
