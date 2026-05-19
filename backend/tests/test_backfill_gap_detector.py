from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from app.data_engine.backfill.config import BackfillConfig
from app.data_engine.backfill.gap_detector import GapDetector
from app.data_engine.backfill.models import GapType


def _ms(year: int, month: int, day: int) -> int:
    return int(datetime(year, month, day, tzinfo=timezone.utc).timestamp() * 1000)


class _Storage:
    def __init__(self, existing: set[int]) -> None:
        self.existing = existing

    async def get_earliest_time(self, symbol, interval, exchange=None, market_type=None):
        return min(self.existing) if self.existing else None

    async def get_latest_time(self, symbol, interval, exchange=None, market_type=None):
        return max(self.existing) if self.existing else None

    async def get_existing_open_times(
        self,
        symbol,
        interval,
        start_ms,
        end_ms,
        exchange=None,
        market_type=None,
    ):
        return {ts for ts in self.existing if start_ms <= ts <= end_ms}


def test_gap_detector_reports_fully_empty_requested_interior_range() -> None:
    async def _run() -> None:
        detector = GapDetector(
            BackfillConfig(gap_tolerance_bars=0),
            _Storage({0, 600_000}),  # Stored boundary bars at 00:00 and 00:10.
        )

        gaps = await detector.detect(
            symbol="BTC-USDT",
            intervals=["1m"],
            range_start_ms=60_000,
            range_end_ms=540_000,
            exchange="okx",
            market_type="spot",
        )

        assert len(gaps) == 1
        gap = gaps[0]
        assert gap.gap_type == GapType.INTERIOR
        assert gap.exchange == "okx"
        assert gap.market_type == "spot"
        assert gap.start_ms == 60_000
        assert gap.end_ms == 540_000
        assert gap.missing_bars == 9

    asyncio.run(_run())


def test_gap_detector_monthly_uses_calendar_open_sequence() -> None:
    async def _run() -> None:
        detector = GapDetector(
            BackfillConfig(gap_tolerance_bars=0),
            _Storage({_ms(2024, 3, 1), _ms(2024, 6, 1)}),
        )

        gaps = await detector.detect(
            symbol="BTC-USDT",
            intervals=["1M"],
            range_start_ms=_ms(2024, 1, 1),
            range_end_ms=_ms(2024, 7, 15),
            exchange="okx",
            market_type="spot",
        )

        assert [
            (gap.gap_type, gap.start_ms, gap.end_ms, gap.missing_bars)
            for gap in sorted(gaps, key=lambda gap: gap.start_ms)
        ] == [
            (GapType.HEAD, _ms(2024, 1, 1), _ms(2024, 2, 1), 2),
            (GapType.INTERIOR, _ms(2024, 4, 1), _ms(2024, 5, 1), 2),
            (GapType.TAIL, _ms(2024, 7, 1), _ms(2024, 7, 1), 1),
        ]

    asyncio.run(_run())


def test_gap_detector_empty_monthly_range_aligns_to_calendar_months() -> None:
    async def _run() -> None:
        detector = GapDetector(BackfillConfig(gap_tolerance_bars=0), _Storage(set()))

        gaps = await detector.detect(
            symbol="BTC-USDT",
            intervals=["1M"],
            range_start_ms=_ms(2024, 1, 15),
            range_end_ms=_ms(2024, 4, 15),
            exchange="okx",
            market_type="spot",
        )

        assert len(gaps) == 1
        gap = gaps[0]
        assert gap.gap_type == GapType.TAIL
        assert gap.start_ms == _ms(2024, 2, 1)
        assert gap.end_ms == _ms(2024, 4, 1)
        assert gap.missing_bars == 3

    asyncio.run(_run())


def test_gap_detector_reports_requested_range_edge_holes() -> None:
    async def _run() -> None:
        detector = GapDetector(
            BackfillConfig(gap_tolerance_bars=0),
            _Storage({0, 180_000, 240_000, 600_000}),
        )

        gaps = await detector.detect(
            symbol="BTC-USDT",
            intervals=["1m"],
            range_start_ms=60_000,
            range_end_ms=540_000,
            exchange="okx",
            market_type="spot",
        )

        assert [(gap.start_ms, gap.end_ms, gap.missing_bars) for gap in gaps] == [
            (60_000, 120_000, 2),
            (300_000, 540_000, 5),
        ]

    asyncio.run(_run())
