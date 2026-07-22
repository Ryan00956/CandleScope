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
    IntervalComponent,
    IntervalDecomposition,
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
            existing_queries = 0

            async def get_existing_open_times(self, *args, **kwargs):
                self.existing_queries += 1
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

        assert result.bars_deduplicated == 0
        assert result.bars_skipped == 0
        assert result.bars_written == 1
        assert reconciler._storage.existing_queries == 0

    asyncio.run(_run("backfill_wins"))
    asyncio.run(_run("newer_wins"))


def test_reconciler_materializes_91m_target_from_complete_1m_components() -> None:
    async def _run() -> None:
        minute_ms = 60_000
        target_ms = 91 * minute_ms
        gap = GapInfo(
            symbol="BTCUSDT",
            interval="91m",
            gap_type=GapType.INTERIOR,
            start_ms=0,
            end_ms=target_ms,
            missing_bars=2,
        )
        task = BackfillTask(
            symbol="BTCUSDT",
            interval="1m",
            start_ms=0,
            end_ms=182 * minute_ms - minute_ms,
            parent_gap=gap,
            estimated_bars=182,
            metadata={"custom_interval": "91m"},
        )
        bars = [
            FetchedBar(
                symbol="BTCUSDT",
                interval="1m",
                open_time=index * minute_ms,
                close_time=(index + 1) * minute_ms - 1,
                open=float(index + 1),
                high=float(index + 2),
                low=float(index),
                close=float(index + 1),
                volume=1,
            )
            for index in range(182)
        ]
        plan = BackfillPlan(
            gaps=[gap],
            tasks=[task],
            decompositions=[IntervalDecomposition(
                custom_interval="91m",
                custom_duration_ms=target_ms,
                components=[IntervalComponent(
                    interval="1m",
                    count=91,
                    duration_ms=minute_ms,
                )],
            )],
            custom_intervals=["91m"],
        )

        class _Storage:
            def __init__(self) -> None:
                self.writes: dict[str, list[dict]] = {}

            async def upsert_bars(self, symbol, interval, rows, **kwargs):
                self.writes.setdefault(interval, []).extend(rows)
                return len(rows)

        storage = _Storage()
        reconciler = Reconciler(
            BackfillConfig(
                reconcile_generate_custom=True,
                reconcile_enable_cache_push=False,
            ),
            storage,
        )

        result = await reconciler.reconcile(
            [FetchResult(
                task=task,
                bars=bars,
                status=BackfillStatus.COMPLETED,
            )],
            plan,
        )

        assert result.bars_written == 182
        assert result.custom_bars_generated == 2
        assert result.custom_bars_written == 2
        assert [row["open_time"] for row in storage.writes["91m"]] == [
            0,
            target_ms,
        ]
        assert {
            written.interval for written in result.written_ranges
        } == {"1m", "91m"}

    asyncio.run(_run())


def test_reconciler_never_returns_incomplete_91m_fallback_bucket() -> None:
    minute_ms = 60_000
    bars = [
        FetchedBar(
            symbol="BTCUSDT",
            interval="1m",
            open_time=index * minute_ms,
            close_time=(index + 1) * minute_ms - 1,
            open=float(index + 1),
            high=float(index + 2),
            low=float(index),
            close=float(index + 1),
            volume=1,
        )
        for index in range(91)
        if index != 45
    ]
    reconciler = Reconciler(
        BackfillConfig(reconcile_enable_cache_push=False),
        storage=object(),
    )

    aggregated = reconciler._aggregate_to_custom(
        bars,
        "BTCUSDT",
        "91m",
        91 * minute_ms,
        0,
    )

    assert aggregated == []


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


def test_backfill_engine_forces_fetch_for_contiguous_untrusted_rows() -> None:
    async def _run() -> None:
        class _Detector:
            calls = 0

            async def detect(self, **kwargs):
                self.calls += 1
                raise AssertionError("physical gap detection must be bypassed")

        class _Fetcher:
            def __init__(self) -> None:
                self.tasks = []

            async def fetch(self, tasks):
                self.tasks = list(tasks)
                return [
                    FetchResult(
                        task=task,
                        bars=[FetchedBar(
                            symbol=task.symbol,
                            interval=task.interval,
                            open_time=task.start_ms,
                            close_time=task.start_ms + 59_999,
                            open=10,
                            high=11,
                            low=9,
                            close=10.5,
                            volume=12,
                            exchange=task.exchange,
                            market_type=task.market_type,
                        )],
                        status=BackfillStatus.COMPLETED,
                    )
                    for task in tasks
                ]

        class _Storage:
            def __init__(self) -> None:
                self.source = "data_manager_closed"

            async def upsert_bars(self, symbol, interval, rows, *, source, **kwargs):
                assert symbol == "BTCUSDT"
                assert interval == "1m"
                assert len(rows) == 1
                self.source = source
                return len(rows)

        storage = _Storage()
        detector = _Detector()
        fetcher = _Fetcher()
        engine = BackfillEngine(
            config=BackfillConfig(
                reconcile_generate_custom=False,
                reconcile_enable_cache_push=False,
                publish_mode="log",
            ),
            storage=storage,
        )
        engine._detector = detector
        engine._fetcher = fetcher

        report = await engine.run(
            symbol="BTCUSDT",
            intervals=["1m"],
            range_start_ms=60_000,
            range_end_ms=60_000,
            metadata={"query_reason": "query_untrusted_finality"},
        )

        assert detector.calls == 0
        assert len(fetcher.tasks) == 1
        assert storage.source == "backfill"
        assert report.status == BackfillStatus.COMPLETED
        assert report.metadata["repair_mode"] == "authoritative_refresh"
        assert report.plan is not None
        assert report.plan.gaps[0].metadata == {
            "repair_mode": "authoritative_refresh",
        }

    asyncio.run(_run())
