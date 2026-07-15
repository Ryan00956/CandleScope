from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from app.data_engine.backfill.config import BackfillConfig
from app.data_engine.backfill.gap_detector import GapDetector
from app.data_engine.backfill.models import GapType
from app.data_engine.history.calendar import CalendarRegistry, SessionCalendar
from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.continuity import ContinuityLayer
from app.data_engine.ingestion.models import (
    DataSource,
    MarketEvent,
    StreamDescriptor,
    StreamType,
)
from app.data_engine.storage import klines_repo


def _ms(year: int, month: int, day: int, hour: int = 0, minute: int = 0) -> int:
    return int(
        datetime(
            year,
            month,
            day,
            hour,
            minute,
            tzinfo=timezone.utc,
        ).timestamp()
        * 1000
    )


def _weekday_calendar() -> SessionCalendar:
    return SessionCalendar(
        calendar_id="test.weekday.utc",
        timezone_name="UTC",
        weekly_sessions={
            weekday: [("09:00", "10:00")]
            for weekday in range(5)
        },
    )


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
        return {value for value in self.existing if start_ms <= value <= end_ms}


def _bar(open_time: int) -> dict:
    return {
        "open_time": open_time,
        "close_time": open_time + (30 * 60 * 1000) - 1,
        "open": 1.0,
        "high": 1.0,
        "low": 1.0,
        "close": 1.0,
        "volume": 1.0,
        "quote_volume": 1.0,
        "trades": 1,
        "taker_buy_base": 0.0,
        "taker_buy_quote": 0.0,
    }


def test_gap_detector_skips_weekend_and_reports_only_missing_session_bar() -> None:
    async def _run() -> None:
        friday_0900 = _ms(2024, 1, 5, 9)
        friday_0930 = _ms(2024, 1, 5, 9, 30)
        monday_0900 = _ms(2024, 1, 8, 9)
        monday_0930 = _ms(2024, 1, 8, 9, 30)
        calendar = _weekday_calendar()

        complete = GapDetector(
            BackfillConfig(gap_tolerance_bars=0),
            _Storage({friday_0900, friday_0930, monday_0900, monday_0930}),
            calendar_resolver=lambda exchange, market_type, symbol: calendar,
        )
        assert await complete.detect(
            "ABC",
            intervals=["30m"],
            range_start_ms=friday_0900,
            range_end_ms=monday_0930,
            exchange="test",
            market_type="stock",
        ) == []

        missing = GapDetector(
            BackfillConfig(gap_tolerance_bars=0),
            _Storage({friday_0900, friday_0930, monday_0930}),
            calendar_resolver=lambda exchange, market_type, symbol: calendar,
        )
        gaps = await missing.detect(
            "ABC",
            intervals=["30m"],
            range_start_ms=friday_0900,
            range_end_ms=monday_0930,
            exchange="test",
            market_type="stock",
        )
        assert [
            (gap.gap_type, gap.start_ms, gap.end_ms, gap.missing_bars)
            for gap in gaps
        ] == [(GapType.INTERIOR, monday_0900, monday_0900, 1)]

    asyncio.run(_run())


def test_storage_gap_scan_uses_adapter_calendar_resolver(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(klines_repo, "KLINES_DB_PATH", tmp_path / "klines.sqlite")
    klines_repo.init_klines_storage()

    friday_0930 = _ms(2024, 1, 5, 9, 30)
    monday_0900 = _ms(2024, 1, 8, 9)
    klines_repo.upsert_klines(
        "ABC",
        "30m",
        [_bar(friday_0930), _bar(monday_0900)],
        source="test",
        exchange="test",
        market_type="stock",
    )

    calendar = _weekday_calendar()
    registry = CalendarRegistry()
    registry.register(calendar.calendar_id, calendar)
    resolved_keys: list[tuple[str, str, str]] = []

    def resolve(exchange: str, market_type: str, symbol: str) -> str:
        resolved_keys.append((exchange, market_type, symbol))
        return calendar.calendar_id

    adapter = klines_repo.KlinesRepoAdapter(
        exchange="test",
        market_type="stock",
        calendar_resolver=resolve,
        calendar_registry=registry,
    )
    result = adapter.scan_gaps(
        "ABC",
        "30m",
        start_ms=friday_0930,
        end_ms=monday_0900,
    )

    assert result["gaps"] == []
    assert result["calendar_id"] == calendar.calendar_id
    assert resolved_keys == [("test", "stock", "ABC")]

    closed_only = adapter.scan_gaps(
        "ABC",
        "30m",
        start_ms=_ms(2024, 1, 6),
        end_ms=_ms(2024, 1, 7, 23, 59),
    )
    assert closed_only["gaps"] == []
    assert closed_only["missing_bars"] == 0


def test_realtime_continuity_skips_closure_but_counts_open_session_hole() -> None:
    async def _run() -> None:
        calendar = _weekday_calendar()
        registry = CalendarRegistry()
        registry.register(calendar.calendar_id, calendar)
        descriptor = StreamDescriptor(
            symbol="ABC",
            stream_type=StreamType.KLINE,
            interval="30m",
            exchange="test",
            market_type="stock",
        )
        layer = ContinuityLayer(
            IngestionConfig(),
            object(),  # Transport is not used by the continuity layer.
            descriptor,
            calendar_resolver=lambda exchange, market_type, symbol: calendar.calendar_id,
            calendar_registry=registry,
        )
        gaps = []

        async def on_gap(gap) -> None:
            gaps.append(gap)

        layer.on_gap(on_gap)

        async def ingest(open_time: int) -> None:
            await layer.ingest(MarketEvent(
                event_type=StreamType.KLINE,
                symbol="ABC",
                exchange="test",
                event_time_ms=open_time,
                received_at_ms=open_time,
                source=DataSource.MOCK,
                data={"open_time": open_time, "is_closed": True},
                market_type="stock",
            ))

        await ingest(_ms(2024, 1, 5, 9, 30))
        await ingest(_ms(2024, 1, 8, 9))
        assert gaps == []

        # Monday 09:30 is the only missing expected bar; the overnight closure
        # and the rest of the weekend are not part of the count.
        await ingest(_ms(2024, 1, 9, 9))
        assert len(gaps) == 1
        assert gaps[0].expected_count == 1

    asyncio.run(_run())
