from __future__ import annotations

import asyncio

from app.data_engine.backfill import BackfillEngine
from app.data_engine.backfill.config import BackfillConfig
from app.data_engine.backfill.reconciler import Reconciler
from app.data_engine.backfill.models import (
    BackfillPlan,
    BackfillStatus,
    BackfillTask,
    FetchedBar,
    FetchResult,
    GapInfo,
    GapType,
)


def test_reconciler_records_written_ranges_for_successful_batches() -> None:
    async def _run() -> None:
        gap = GapInfo(
            symbol="BTCUSDT",
            interval="1m",
            gap_type=GapType.TAIL,
            start_ms=60_000,
            end_ms=120_000,
            missing_bars=2,
            exchange="okx",
            market_type="spot",
        )
        task = BackfillTask(
            symbol="BTCUSDT",
            interval="1m",
            start_ms=60_000,
            end_ms=120_000,
            parent_gap=gap,
            exchange="okx",
            market_type="spot",
        )
        bars = [
            FetchedBar(
                symbol="BTCUSDT",
                interval="1m",
                open_time=60_000,
                close_time=119_999,
                open=1,
                high=2,
                low=1,
                close=2,
                volume=3,
                exchange="okx",
                market_type="spot",
            ),
            FetchedBar(
                symbol="BTCUSDT",
                interval="1m",
                open_time=120_000,
                close_time=179_999,
                open=2,
                high=3,
                low=2,
                close=3,
                volume=4,
                exchange="okx",
                market_type="spot",
            ),
        ]

        class _Storage:
            async def get_existing_open_times(self, *args, **kwargs):
                return set()

            async def upsert_bars(self, symbol, interval, rows, **kwargs):
                return len(rows)

        reconciler = Reconciler(
            BackfillConfig(
                reconcile_write_batch_size=1,
                reconcile_generate_custom=False,
                reconcile_enable_cache_push=False,
            ),
            _Storage(),
        )

        result = await reconciler.reconcile(
            [FetchResult(task=task, bars=bars, status=BackfillStatus.COMPLETED)],
            BackfillPlan(gaps=[gap], tasks=[task]),
        )

        assert result.bars_written == 2
        assert [r.to_dict() for r in result.written_ranges] == [
            {
                "symbol": "BTCUSDT",
                "interval": "1m",
                "exchange": "okx",
                "market_type": "spot",
                "start_ms": 60_000,
                "end_ms": 60_000,
                "bars_written": 1,
                "source": "backfill",
                "phase": "standard",
            },
            {
                "symbol": "BTCUSDT",
                "interval": "1m",
                "exchange": "okx",
                "market_type": "spot",
                "start_ms": 120_000,
                "end_ms": 120_000,
                "bars_written": 1,
                "source": "backfill",
                "phase": "standard",
            },
        ]

    asyncio.run(_run())


def test_reconciler_accepts_backfill_wins_and_legacy_newer_wins() -> None:
    async def _run(strategy: str) -> None:
        gap = GapInfo(
            symbol="BTCUSDT",
            interval="1m",
            gap_type=GapType.TAIL,
            start_ms=60_000,
            end_ms=60_000,
            missing_bars=1,
        )
        task = BackfillTask(
            symbol="BTCUSDT",
            interval="1m",
            start_ms=60_000,
            end_ms=60_000,
            parent_gap=gap,
        )
        bar = FetchedBar(
            symbol="BTCUSDT",
            interval="1m",
            open_time=60_000,
            close_time=119_999,
            open=1,
            high=2,
            low=1,
            close=2,
            volume=3,
        )

        class _Storage:
            async def get_existing_open_times(self, *args, **kwargs):
                return {60_000}

            async def upsert_bars(self, symbol, interval, rows, **kwargs):
                return len(rows)

        reconciler = Reconciler(
            BackfillConfig(
                reconcile_dedup_strategy=strategy,
                reconcile_generate_custom=False,
                reconcile_enable_cache_push=False,
            ),
            _Storage(),
        )

        result = await reconciler.reconcile(
            [FetchResult(task=task, bars=[bar], status=BackfillStatus.COMPLETED)],
            BackfillPlan(gaps=[gap], tasks=[task]),
        )

        assert result.bars_deduplicated == 1
        assert result.bars_skipped == 0
        assert result.bars_written == 1

    asyncio.run(_run("backfill_wins"))
    asyncio.run(_run("newer_wins"))


def test_backfill_engine_returns_partial_when_reconciler_write_fails() -> None:
    async def _run() -> None:
        gap = GapInfo(
            symbol="BTCUSDT",
            interval="1m",
            gap_type=GapType.TAIL,
            start_ms=60_000,
            end_ms=60_000,
            missing_bars=1,
        )
        task = BackfillTask(
            symbol="BTCUSDT",
            interval="1m",
            start_ms=60_000,
            end_ms=60_000,
            parent_gap=gap,
        )
        plan = BackfillPlan(
            gaps=[gap],
            tasks=[task],
            estimated_requests=1,
            estimated_bars=1,
        )
        bar = FetchedBar(
            symbol="BTCUSDT",
            interval="1m",
            open_time=60_000,
            close_time=119_999,
            open=1,
            high=2,
            low=0.5,
            close=1.5,
            volume=10,
        )

        class _Detector:
            async def detect(self, **kwargs):
                return [gap]

        class _Planner:
            def plan(self, gaps):
                return plan

        class _Fetcher:
            async def fetch(self, tasks):
                return [
                    FetchResult(
                        task=task,
                        bars=[bar],
                        status=BackfillStatus.COMPLETED,
                    )
                ]

        class _Storage:
            async def get_existing_open_times(self, *args, **kwargs):
                return set()

            async def upsert_bars(self, *args, **kwargs):
                raise RuntimeError("database locked")

        engine = BackfillEngine(
            config=BackfillConfig(
                reconcile_generate_custom=False,
                reconcile_enable_cache_push=False,
                publish_mode="log",
            ),
            storage=_Storage(),
        )
        engine._detector = _Detector()
        engine._planner = _Planner()
        engine._fetcher = _Fetcher()

        report = await engine.run(
            symbol="BTCUSDT",
            intervals=["1m"],
            range_start_ms=60_000,
            range_end_ms=60_000,
        )

        assert report.status == BackfillStatus.PARTIAL
        assert report.errors
        assert "database locked" in report.errors[0]
        assert report.reconcile_result is not None
        assert report.reconcile_result.bars_received == 1
        assert report.reconcile_result.bars_written == 0
        assert report.reconcile_result.write_errors == 1
        assert report.reconcile_result.failed_batches == [
            {
                "exchange": "binance",
                "market_type": "spot",
                "symbol": "BTCUSDT",
                "interval": "1m",
                "phase": "standard",
                "batch_size": 1,
                "start_ms": 60_000,
                "end_ms": 60_000,
                "error": "database locked",
            }
        ]

    asyncio.run(_run())
