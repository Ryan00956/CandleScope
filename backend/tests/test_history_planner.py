from __future__ import annotations

from app.data_engine.history import (
    BoundaryReason,
    BoundaryState,
    CalendarRegistry,
    HistoryAvailability,
    HistoryAvailabilityService,
    HistoryDisposition,
    HistoryRequest,
    HistoryRequestPlanner,
    HistorySeriesKey,
    TimeBound,
    TimeRange,
    WeeklySessionCalendar,
)


def _request(start_ms: int, end_ms: int, interval: str = "1s") -> HistoryRequest:
    return HistoryRequest(
        HistorySeriesKey("Binance", "future", "btcusdt", "kline", interval),
        interval,
        start_ms,
        end_ms,
    )


def test_planner_intersects_lifetime_and_dynamic_rolling_retention() -> None:
    availability = HistoryAvailability(
        data_start=TimeBound(1_000, BoundaryReason.LISTING),
        rolling_retention_ms=5_000,
        calendar_id="crypto.24x7.utc",
    )
    plan = HistoryRequestPlanner().plan(
        _request(0, 8_000),
        availability,
        now_ms=10_000,
    )
    assert plan.disposition is HistoryDisposition.FETCH
    assert plan.fetch_ranges == (TimeRange(5_000, 8_000),)
    assert plan.exclusions[0].time_range == TimeRange(0, 4_999)
    assert plan.exclusions[0].reason is BoundaryReason.PROVIDER_RETENTION
    assert plan.exclusions[0].bound is not None
    assert plan.exclusions[0].bound.dynamic


def test_planner_returns_terminal_when_request_is_wholly_before_history() -> None:
    plan = HistoryRequestPlanner().plan(
        _request(0, 999),
        HistoryAvailability(data_start=TimeBound(1_000, BoundaryReason.LISTING)),
        now_ms=2_000,
    )
    assert plan.disposition is HistoryDisposition.TERMINAL
    assert plan.terminal
    assert not plan.fetch_ranges
    assert plan.exclusions[0].reason is BoundaryReason.LISTING


def test_planner_splits_fetch_ranges_around_market_closure() -> None:
    calendar = WeeklySessionCalendar(
        calendar_id="test.sessions",
        timezone_name="UTC",
        weekly_sessions={0: (("09:00", "11:00"), ("13:00", "15:00"))},
    )
    hour = 3_600_000
    monday = 4 * 86_400_000  # 1970-01-05
    plan = HistoryRequestPlanner(calendar).plan(
        _request(monday, monday + 23 * hour, "1h"),
        HistoryAvailability(calendar_id="test.sessions"),
        now_ms=monday + 23 * hour,
    )
    assert plan.fetch_ranges == (
        TimeRange(monday + 9 * hour, monday + 10 * hour),
        TimeRange(monday + 13 * hour, monday + 14 * hour),
    )
    assert all(item.reason is BoundaryReason.MARKET_CLOSED for item in plan.exclusions)
    assert not plan.terminal


def test_planner_keeps_candidate_boundary_as_unknown_probe() -> None:
    plan = HistoryRequestPlanner().plan(
        _request(0, 2_000),
        HistoryAvailability(upstream_start=TimeBound(
            1_000,
            BoundaryReason.SOURCE_EXHAUSTED,
            state=BoundaryState.CANDIDATE,
        )),
        now_ms=3_000,
    )
    assert plan.disposition is HistoryDisposition.UNKNOWN
    assert plan.unknown
    assert plan.fetch_ranges == (TimeRange(0, 2_000),)


def test_planner_distinguishes_retryable_from_terminal() -> None:
    plan = HistoryRequestPlanner().plan(
        _request(0, 1_000),
        HistoryAvailability(
            disposition=HistoryDisposition.RETRYABLE,
            retry_at_ms=5_000,
        ),
        now_ms=2_000,
    )
    assert plan.disposition is HistoryDisposition.RETRYABLE
    assert plan.retryable and not plan.terminal
    assert plan.retry_at_ms == 5_000
    assert not plan.fetch_ranges


def test_service_fails_closed_for_missing_or_unknown_calendar() -> None:
    service = HistoryAvailabilityService(calendars=CalendarRegistry())
    missing = service.plan(_request(0, 1_000), HistoryAvailability())
    unknown = service.plan(
        _request(0, 1_000),
        HistoryAvailability(calendar_id="not.registered"),
    )
    for plan in (missing, unknown):
        assert plan.disposition is HistoryDisposition.UNKNOWN
        assert plan.unknown
        assert not plan.fetch_ranges
        assert plan.exclusions[0].reason is BoundaryReason.CALENDAR_UNKNOWN
