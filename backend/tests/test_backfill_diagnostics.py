from __future__ import annotations

import asyncio
import logging

from app.data_engine.backfill import BackfillEngine
from app.data_engine.backfill.config import BackfillConfig
from app.data_engine.backfill.models import (
    BackfillPlan,
    BackfillStatus,
    BackfillTask,
    FetchResult,
    GapInfo,
    GapType,
)
from app.data_engine.backfill.publisher import RepairPublisher


def test_failed_fetch_report_keeps_summary_and_task_location(caplog) -> None:
    gap = GapInfo(
        symbol="BTCUSDT",
        interval="5m",
        gap_type=GapType.INTERIOR,
        start_ms=300_000,
        end_ms=600_000,
        missing_bars=2,
        market_type="futures",
    )
    task = BackfillTask(
        symbol="BTCUSDT",
        interval="5m",
        start_ms=300_000,
        end_ms=600_000,
        exchange="binance",
        market_type="futures",
    )
    plan = BackfillPlan(gaps=[gap], tasks=[task])

    class _Detector:
        async def detect(self, **kwargs):
            return [gap]

    class _Planner:
        def plan(self, gaps):
            return plan

    class _Fetcher:
        async def fetch(self, tasks):
            return [FetchResult(
                task=tasks[0],
                status=BackfillStatus.FAILED,
                errors=["upstream rejected range"],
            )]

    config = BackfillConfig(publish_mode="log")
    engine = BackfillEngine(config=config)
    engine._detector = _Detector()
    engine._planner = _Planner()
    engine._fetcher = _Fetcher()

    with caplog.at_level(logging.WARNING):
        report = asyncio.run(engine.run(
            symbol="BTCUSDT",
            intervals=["5m"],
            range_start_ms=300_000,
            range_end_ms=600_000,
            market_type="futures",
        ))

    assert report.status == BackfillStatus.FAILED
    assert report.errors[0] == "All fetch tasks failed"
    assert task.task_key in report.errors[1]
    assert "interval=5m" in report.errors[1]
    assert "range=[300000,600000]" in report.errors[1]
    assert "upstream rejected range" in report.errors[1]

    formatted = RepairPublisher._default_format(report)
    assert formatted["errors"][0] == "All fetch tasks failed"
    assert formatted["fetch_issue_count"] == 1
    assert formatted["fetch_issues"] == [{
        "task": task.task_key,
        "interval": "5m",
        "start_ms": 300_000,
        "end_ms": 600_000,
        "status": "failed",
        "errors": ["upstream rejected range"],
    }]
    assert task.task_key in caplog.text
    assert "range=[300000,600000]" in caplog.text
