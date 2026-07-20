from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import pytest

import app.data_engine.backfill.gap_detector as gap_detector_module
from app.api.v1.stream_indicator_payloads import (
    IndicatorRangeEmptyError,
    _closed_indicator_compute_bars,
)
from app.data_engine.backfill.config import BackfillConfig
from app.data_engine.backfill.gap_detector import GapDetector
from app.data_engine.data_manager.cache import BarCache
from app.data_engine.data_manager.models import BarData, QueryResult, SeriesKey
from app.data_engine.data_manager.query import QueryEngine
from app.data_engine.history import (
    AlwaysOpenCalendar,
    BoundaryReason,
    CalendarRegistry,
    ExchangeHistoryPolicyResolver,
    HistoryAvailability,
    HistoryAvailabilityService,
    HistoryRequest,
    HistorySeriesKey,
    ResolvedHistoryContext,
    SessionCalendar,
    TimeBound,
)
from app.data_engine.market_data.models import MarketChannel, MarketStreamKey
from app.data_engine.market_data.service import MarketDataService
from app.exchanges import HistoryEmptyPageSemantics


def _utc_ms(value: str) -> int:
    return int(datetime.fromisoformat(value).replace(tzinfo=timezone.utc).timestamp() * 1000)


class _StaticHistoryResolver:
    def __init__(self, service: HistoryAvailabilityService, context: ResolvedHistoryContext):
        self.service = service
        self.context = context

    def plan(self, request: HistoryRequest):
        return (
            self.service.plan(
                request,
                self.context.availability,
                calendar_id=self.context.availability.calendar_id,
            ),
            self.context,
        )

    def calendar_for(self, key: HistorySeriesKey):
        return self.context.calendar


def test_explicit_cache_coverage_uses_session_expected_edges() -> None:
    calendar = SessionCalendar(
        calendar_id="test.weekday.edge.utc",
        timezone_name="UTC",
        weekly_sessions={weekday: (("09:30", "16:00"),) for weekday in range(5)},
    )

    class _CalendarOnlyResolver:
        def calendar_for(self, key):
            return calendar

    engine = QueryEngine(
        cache=BarCache(),
        config=None,
        history_policy=_CalendarOnlyResolver(),  # type: ignore[arg-type]
    )
    key = SeriesKey("TEST", "1h", exchange="test", market_type="spot")
    friday = _utc_ms("2026-07-17T15:30:00")
    saturday = _utc_ms("2026-07-18T00:00:00")
    sunday = _utc_ms("2026-07-19T23:59:59")
    monday = _utc_ms("2026-07-20T09:30:00")

    assert engine._is_complete(
        [BarData(
            time=friday // 1000,
            open=1,
            high=1,
            low=1,
            close=1,
            volume=1,
            source="backfill",
        )],
        friday // 1000,
        sunday // 1000,
        1,
        interval="1h",
        key=key,
    )
    assert engine._is_complete(
        [BarData(
            time=monday // 1000,
            open=1,
            high=1,
            low=1,
            close=1,
            volume=1,
            source="backfill",
        )],
        saturday // 1000,
        monday // 1000,
        1,
        interval="1h",
        key=key,
    )


def test_history_planner_uses_session_closed_edge_for_forming_tail() -> None:
    calendar = SessionCalendar(
        calendar_id="test.planner.0930.utc",
        timezone_name="UTC",
        weekly_sessions={weekday: (("09:30", "17:00"),) for weekday in range(5)},
    )
    registry = CalendarRegistry()
    registry.register(calendar.calendar_id, calendar)
    service = HistoryAvailabilityService(calendars=registry)
    start_ms = _utc_ms("2026-07-20T09:30:00")
    end_ms = _utc_ms("2026-07-20T16:10:00")
    request = HistoryRequest(
        HistorySeriesKey("test", "spot", "TEST", "kline", "1h"),
        "1h",
        start_ms,
        end_ms,
    )

    plan = service.plan(
        request,
        HistoryAvailability(calendar_id=calendar.calendar_id),
        now_ms=end_ms,
    )

    assert [(item.start_ms, item.end_ms) for item in plan.fetch_ranges] == [(
        start_ms,
        _utc_ms("2026-07-20T14:30:00"),
    )]
    assert [
        (item.time_range.start_ms, item.time_range.end_ms, item.reason.value)
        for item in plan.exclusions
    ] == [(
        _utc_ms("2026-07-20T15:30:00"),
        _utc_ms("2026-07-20T15:30:00"),
        "forming_bar",
    )]


def test_gap_detector_caps_session_tail_at_latest_closed_open(monkeypatch) -> None:
    calendar = SessionCalendar(
        calendar_id="test.detector.0930.utc",
        timezone_name="UTC",
        weekly_sessions={weekday: (("09:30", "17:00"),) for weekday in range(5)},
    )
    now_ms = _utc_ms("2026-07-20T16:10:00")
    monkeypatch.setattr(gap_detector_module.time, "time", lambda: now_ms / 1000)

    class _EmptyStorage:
        async def get_earliest_time(self, *args, **kwargs):
            return None

        async def get_latest_time(self, *args, **kwargs):
            return None

    detector = GapDetector(
        BackfillConfig(),
        _EmptyStorage(),  # type: ignore[arg-type]
        calendar_resolver=lambda *_args: calendar,
    )
    gaps = asyncio.run(detector.detect(
        "TEST",
        intervals=["1h"],
        range_start_ms=_utc_ms("2026-07-20T09:30:00"),
        range_end_ms=now_ms,
        exchange="test",
        market_type="spot",
    ))

    assert len(gaps) == 1
    assert gaps[0].start_ms == _utc_ms("2026-07-20T09:30:00")
    assert gaps[0].end_ms == _utc_ms("2026-07-20T14:30:00")
    assert gaps[0].reference_ms == _utc_ms("2026-07-20T14:30:00")


def test_query_before_stops_at_confirmed_left_boundary() -> None:
    class _Storage:
        def __init__(self) -> None:
            self.calls = 0

        def fetch_before(self, **kwargs):
            self.calls += 1
            return []

    service = HistoryAvailabilityService()
    calendar = service.calendars.require("crypto.24x7.utc")
    availability = HistoryAvailability(
        upstream_start=TimeBound(
            60_000,
            BoundaryReason.UPSTREAM_START,
            revision="left-edge-v1",
        ),
        calendar_id=calendar.calendar_id,
        revision="left-edge-v1",
    )
    resolver = _StaticHistoryResolver(
        service,
        ResolvedHistoryContext(
            availability=availability,
            calendar=calendar,
            policy=None,
            empty_page_semantics=HistoryEmptyPageSemantics.UNKNOWN,
        ),
    )
    storage = _Storage()
    triggered: list[tuple] = []
    engine = QueryEngine(
        cache=BarCache(),
        storage=storage,  # type: ignore[arg-type]
        backfill_trigger=lambda *args: triggered.append(args),
        history_policy=resolver,  # type: ignore[arg-type]
    )

    result = engine.query_before(
        "BTCUSDT",
        "1m",
        before_ms=60_000,
        limit=2,
        exchange="binance",
        market_type="spot",
    )

    assert storage.calls == 1
    assert triggered == []
    assert result.missing_ranges == []
    assert result.has_more is False
    assert result.history_state == "exhausted"
    assert result.complete is True
    assert result.retryable is False
    assert result.terminal_reason == "upstream_start"
    assert result.earliest_available_ms == 60_000
    assert result.availability_revision == "left-edge-v1"


def test_query_before_keeps_fetchable_gap_pending_at_confirmed_left_boundary() -> None:
    class _Storage:
        def fetch_before(self, **kwargs):
            return [
                {
                    "open_time": open_time,
                    "open": 1,
                    "high": 1,
                    "low": 1,
                    "close": 1,
                    "volume": 1,
                    "source": "backfill",
                }
                for open_time in (60_000, 180_000, 240_000)
            ]

        def query_bars(self, **kwargs):
            return []

    service = HistoryAvailabilityService()
    calendar = service.calendars.require("crypto.24x7.utc")
    resolver = _StaticHistoryResolver(
        service,
        ResolvedHistoryContext(
            availability=HistoryAvailability(
                upstream_start=TimeBound(60_000, BoundaryReason.UPSTREAM_START),
                calendar_id=calendar.calendar_id,
            ),
            calendar=calendar,
            policy=None,
            empty_page_semantics=HistoryEmptyPageSemantics.UNKNOWN,
        ),
    )
    triggered: list[tuple] = []
    storage = _Storage()
    engine = QueryEngine(
        cache=BarCache(),
        storage=storage,  # type: ignore[arg-type]
        backfill_trigger=lambda *args: triggered.append(args),
        history_policy=resolver,  # type: ignore[arg-type]
    )

    result = engine.query_before(
        "BTCUSDT",
        "1m",
        before_ms=300_000,
        limit=5,
        exchange="binance",
        market_type="spot",
    )

    assert [(item.start_ms, item.end_ms, item.reason) for item in result.missing_ranges] == [
        (120_000, 120_000, "query_interior_gap"),
    ]
    assert triggered == [("BTCUSDT", "1m", 120_000, 120_000, "binance", "spot")]
    assert result.history_state == "pending"
    assert result.complete is False
    assert result.retryable is True
    assert result.has_more is True
    assert result.terminal_reason == "upstream_start"


def test_query_engine_does_not_report_weekend_as_interior_gap() -> None:
    friday = _utc_ms("2026-07-17T09:30:00")
    monday = _utc_ms("2026-07-20T09:00:00")

    class _Storage:
        def __init__(self) -> None:
            self.calls = 0

        def query_bars(self, **kwargs):
            self.calls += 1
            return [
                {
                    "open_time": monday,
                    "open": 2,
                    "high": 2,
                    "low": 2,
                    "close": 2,
                    "volume": 1,
                    "source": "backfill",
                },
                {
                    "open_time": friday,
                    "open": 1,
                    "high": 1,
                    "low": 1,
                    "close": 1,
                    "volume": 1,
                    "source": "backfill",
                },
            ]

    registry = CalendarRegistry()
    calendar = SessionCalendar(
        calendar_id="test.weekdays.utc",
        timezone_name="UTC",
        weekly_sessions={
            weekday: (("09:00", "10:00"),)
            for weekday in range(5)
        },
    )
    registry.register(calendar.calendar_id, calendar)
    service = HistoryAvailabilityService(calendars=registry)
    resolver = _StaticHistoryResolver(
        service,
        ResolvedHistoryContext(
            availability=HistoryAvailability(calendar_id=calendar.calendar_id),
            calendar=calendar,
            policy=None,
            empty_page_semantics=HistoryEmptyPageSemantics.UNKNOWN,
        ),
    )
    triggered: list[tuple] = []
    storage = _Storage()
    engine = QueryEngine(
        cache=BarCache(),
        storage=storage,  # type: ignore[arg-type]
        backfill_trigger=lambda *args: triggered.append(args),
        history_policy=resolver,  # type: ignore[arg-type]
    )

    result = engine.query(
        "TEST",
        "30m",
        start_ms=friday,
        end_ms=monday,
        limit=10,
        exchange="binance",
        market_type="spot",
    )

    assert [bar.time_ms for bar in result.bars] == [friday, monday]
    assert result.missing_ranges == []
    assert result.history_state == "ready"
    assert result.complete is True
    assert triggered == []

    cached_result = engine.query(
        "TEST",
        "30m",
        start_ms=friday,
        end_ms=monday,
        limit=10,
        exchange="binance",
        market_type="spot",
    )

    assert [bar.time_ms for bar in cached_result.bars] == [friday, monday]
    assert cached_result.source.value == "cache"
    assert cached_result.missing_ranges == []
    assert storage.calls == 1


def test_query_before_does_not_repair_a_closed_weekend() -> None:
    friday = _utc_ms("2026-07-17T09:30:00")
    monday = _utc_ms("2026-07-20T09:00:00")

    class _Storage:
        def __init__(self) -> None:
            self.gap_calls = 0

        def fetch_before(self, **kwargs):
            return [
                {
                    "open_time": friday,
                    "open": 1,
                    "high": 1,
                    "low": 1,
                    "close": 1,
                    "volume": 1,
                    "source": "backfill",
                },
                {
                    "open_time": monday,
                    "open": 2,
                    "high": 2,
                    "low": 2,
                    "close": 2,
                    "volume": 1,
                    "source": "backfill",
                },
            ]

        def query_bars(self, **kwargs):
            self.gap_calls += 1
            raise AssertionError("closed sessions must not be queried as gaps")

    registry = CalendarRegistry()
    calendar = SessionCalendar(
        calendar_id="test.weekdays.before.utc",
        timezone_name="UTC",
        weekly_sessions={
            weekday: (("09:00", "10:00"),)
            for weekday in range(5)
        },
    )
    registry.register(calendar.calendar_id, calendar)
    service = HistoryAvailabilityService(calendars=registry)
    resolver = _StaticHistoryResolver(
        service,
        ResolvedHistoryContext(
            availability=HistoryAvailability(calendar_id=calendar.calendar_id),
            calendar=calendar,
            policy=None,
            empty_page_semantics=HistoryEmptyPageSemantics.UNKNOWN,
        ),
    )
    storage = _Storage()
    triggered: list[tuple] = []
    engine = QueryEngine(
        cache=BarCache(),
        storage=storage,  # type: ignore[arg-type]
        backfill_trigger=lambda *args: triggered.append(args),
        history_policy=resolver,  # type: ignore[arg-type]
    )

    result = engine.query_before(
        "TEST",
        "30m",
        before_ms=_utc_ms("2026-07-20T09:30:00"),
        limit=2,
        exchange="binance",
        market_type="spot",
    )

    assert [bar.time_ms for bar in result.bars] == [friday, monday]
    assert storage.gap_calls == 0
    assert result.missing_ranges == []
    assert triggered == []


def test_query_engine_fills_calendar_aware_interior_gap() -> None:
    first = 60_000
    missing = 120_000
    last = 180_000

    def _row(open_time: int) -> dict[str, int]:
        return {
            "open_time": open_time,
            "open": 1,
            "high": 1,
            "low": 1,
            "close": 1,
            "volume": 1,
        }

    class _Storage:
        def __init__(self) -> None:
            self.calls: list[dict] = []

        def query_bars(self, **kwargs):
            self.calls.append(kwargs)
            if kwargs["start_ms"] == missing and kwargs["end_ms"] == missing:
                return [_row(missing)]
            return [_row(last), _row(first)]

    service = HistoryAvailabilityService()
    calendar = service.calendars.require("crypto.24x7.utc")
    resolver = _StaticHistoryResolver(
        service,
        ResolvedHistoryContext(
            availability=HistoryAvailability(calendar_id=calendar.calendar_id),
            calendar=calendar,
            policy=None,
            empty_page_semantics=HistoryEmptyPageSemantics.UNKNOWN,
        ),
    )
    storage = _Storage()
    engine = QueryEngine(
        cache=BarCache(),
        storage=storage,  # type: ignore[arg-type]
        history_policy=resolver,  # type: ignore[arg-type]
    )

    result = engine.query(
        "BTCUSDT",
        "1m",
        start_ms=first,
        end_ms=last,
        limit=3,
        exchange="binance",
        market_type="spot",
        auto_backfill=False,
    )

    assert [bar.time_ms for bar in result.bars] == [first, missing, last]
    assert len(storage.calls) == 2
    assert storage.calls[1]["start_ms"] == missing
    assert storage.calls[1]["end_ms"] == missing


def test_exchange_policy_combines_lifecycle_and_channel_retention() -> None:
    service = HistoryAvailabilityService()
    resolver = ExchangeHistoryPolicyResolver(
        service,
        symbol_lookup=lambda exchange, market_type, symbol: {
            "symbol": symbol,
            "listedAtMs": 1_000,
            "continuousTradingAtMs": 2_000,
        },
    )

    kline_key = resolver.series_key(
        exchange="binance",
        market_type="spot",
        symbol="BTCUSDT",
        channel=MarketChannel.KLINE,
        variant="1m",
    )
    kline_context = resolver.resolve(kline_key)
    assert kline_context.availability.data_start is not None
    assert kline_context.availability.data_start.value_ms == 2_000
    assert isinstance(kline_context.calendar, AlwaysOpenCalendar)

    plan, _ = resolver.plan(HistoryRequest(
        series=kline_key,
        interval="1m",
        start_ms=0,
        end_ms=1_999,
    ))
    assert plan.terminal is True
    assert plan.has_fetch_work is False

    oi_context = resolver.resolve(resolver.series_key(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        channel=MarketChannel.OPEN_INTEREST,
        variant="1h",
    ))
    assert oi_context.availability.rolling_retention_ms == 30 * 24 * 60 * 60 * 1000
    assert oi_context.policy is not None
    assert oi_context.policy.max_page_size == 500


def test_market_history_plan_never_fetches_older_than_typed_oi_retention(
    monkeypatch,
) -> None:
    now_ms = 2_000_000_000_000
    monkeypatch.setattr("app.data_engine.market_data.service.time.time", lambda: now_ms / 1000)
    resolver = ExchangeHistoryPolicyResolver(
        HistoryAvailabilityService(),
        symbol_lookup=lambda exchange, market_type, symbol: None,
    )
    market_service = MarketDataService(object(), history_policy=resolver)
    key = MarketStreamKey.build(
        "binance",
        "futures",
        "BTCUSDT",
        MarketChannel.OPEN_INTEREST,
    )

    plan = market_service._history_refresh_plan(
        key,
        period="1h",
        start_ms=now_ms - (31 * 24 * 60 * 60 * 1000),
        end_ms=now_ms - (30 * 24 * 60 * 60 * 1000) - 1,
    )

    assert plan.should_fetch is False
    assert plan.terminal_reason == "provider_retention"
    assert plan.earliest_available_ms is not None
    assert plan.earliest_available_ms > now_ms - (30 * 24 * 60 * 60 * 1000)
    assert plan.earliest_available_ms % (60 * 60 * 1000) == 0
    assert plan.max_page_size == 500


def test_indicator_closed_market_empty_range_is_resolved_not_retryable() -> None:
    result = QueryResult(
        bars=[],
        history_state="ready",
        complete=True,
        retryable=False,
        excluded_ranges=[{
            "start_ms": 60_000,
            "end_ms": 120_000,
            "disposition": "not_expected",
            "reason": "market_closed",
        }],
    )

    with pytest.raises(IndicatorRangeEmptyError) as raised:
        _closed_indicator_compute_bars(result, 60, 120, 60_000, 120_000)

    assert raised.value.retryable is False
    assert raised.value.history_state == "ready"
    assert raised.value.terminal_reason is None
    assert raised.value.excluded_ranges[0]["reason"] == "market_closed"
