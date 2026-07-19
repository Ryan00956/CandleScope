from __future__ import annotations

from datetime import datetime

from app.data_engine.history import (
    AlwaysOpenCalendar,
    CalendarRegistry,
    SessionWindow,
    TimeRange,
    WeeklySessionCalendar,
    expected_bucket_end_ms,
    latest_closed_expected_open_ms,
)


def _ms(value: str) -> int:
    return int(datetime.fromisoformat(value).timestamp() * 1000)


def test_always_open_calendar_aligns_fixed_and_calendar_month_buckets() -> None:
    calendar = AlwaysOpenCalendar()
    assert list(calendar.expected_opens(1_500, 4_500, "1s")) == [2_000, 3_000, 4_000]
    assert calendar.first_expected_open(1_500, 4_500, "1s") == 2_000
    assert calendar.last_expected_open(1_500, 4_500, "1s") == 4_000
    assert calendar.count_expected(1_500, 4_500, "1s") == 3
    assert calendar.open_segments(1_500, 4_500, "1s") == (TimeRange(2_000, 4_000),)

    start = _ms("2024-01-15T00:00:00+00:00")
    end = _ms("2024-04-15T00:00:00+00:00")
    expected = [
        _ms("2024-02-01T00:00:00+00:00"),
        _ms("2024-03-01T00:00:00+00:00"),
        _ms("2024-04-01T00:00:00+00:00"),
    ]
    assert list(calendar.expected_opens(start, end, "1M")) == expected
    assert calendar.next_expected_open(expected[-1], "1M") == _ms("2024-05-01T00:00:00+00:00")
    assert calendar.previous_expected_open(expected[0], "1M") == _ms("2024-01-01T00:00:00+00:00")


def test_weekly_calendar_skips_weekend_and_splits_lunch_break() -> None:
    calendar = WeeklySessionCalendar(
        calendar_id="test.weekday.utc",
        timezone_name="UTC",
        weekly_sessions={
            day: (("09:00", "11:00"), ("13:00", "15:00"))
            for day in range(5)
        },
    )
    start = _ms("2024-01-05T08:00:00+00:00")  # Friday
    end = _ms("2024-01-08T15:00:00+00:00")  # Monday
    opens = list(calendar.expected_opens(start, end, "1h"))
    assert opens == [
        _ms("2024-01-05T09:00:00+00:00"),
        _ms("2024-01-05T10:00:00+00:00"),
        _ms("2024-01-05T13:00:00+00:00"),
        _ms("2024-01-05T14:00:00+00:00"),
        _ms("2024-01-08T09:00:00+00:00"),
        _ms("2024-01-08T10:00:00+00:00"),
        _ms("2024-01-08T13:00:00+00:00"),
        _ms("2024-01-08T14:00:00+00:00"),
    ]
    assert calendar.count_expected(start, end, "1h") == 8
    assert calendar.next_expected_open(opens[3], "1h") == opens[4]
    assert calendar.previous_expected_open(opens[4], "1h") == opens[3]
    assert calendar.open_segments(start, end, "1h") == (
        TimeRange(opens[0], opens[1]),
        TimeRange(opens[2], opens[3]),
        TimeRange(opens[4], opens[5]),
        TimeRange(opens[6], opens[7]),
    )


def test_latest_closed_expected_open_respects_session_anchor() -> None:
    calendar = WeeklySessionCalendar(
        calendar_id="test.0930.closed.utc",
        timezone_name="UTC",
        weekly_sessions={day: (("09:30", "17:00"),) for day in range(5)},
    )

    assert latest_closed_expected_open_ms(
        calendar,
        _ms("2026-07-20T16:10:00+00:00"),
        "1h",
    ) == _ms("2026-07-20T14:30:00+00:00")
    assert latest_closed_expected_open_ms(
        calendar,
        _ms("2026-07-20T16:40:00+00:00"),
        "1h",
    ) == _ms("2026-07-20T15:30:00+00:00")
    assert expected_bucket_end_ms(
        calendar,
        _ms("2026-07-20T16:30:00+00:00"),
        "1h",
    ) == _ms("2026-07-20T17:00:00+00:00")
    assert latest_closed_expected_open_ms(
        calendar,
        _ms("2026-07-20T17:10:00+00:00"),
        "1h",
    ) == _ms("2026-07-20T16:30:00+00:00")

    always_open = AlwaysOpenCalendar()
    assert expected_bucket_end_ms(
        always_open,
        _ms("2026-07-20T16:30:00+00:00"),
        "1h",
    ) == _ms("2026-07-20T17:30:00+00:00")


def test_coarse_session_bucket_ends_stay_on_canonical_grid() -> None:
    calendar = WeeklySessionCalendar(
        calendar_id="test.ny.coarse-grid",
        timezone_name="America/New_York",
        weekly_sessions={day: (("09:30", "16:00"),) for day in range(5)},
        holidays=("2024-01-01", "2024-07-01"),
    )

    # New Year's Day is closed, so the public 2M open is the first actual
    # session on Jan 2.  Its close nevertheless remains the canonical Mar 1
    # boundary, rather than two nominal months after the delayed open.
    two_month_open = calendar.first_expected_open(
        _ms("2024-01-01T00:00:00+00:00"),
        _ms("2024-02-29T23:59:59+00:00"),
        "2M",
    )
    assert two_month_open == _ms("2024-01-02T14:30:00+00:00")
    assert expected_bucket_end_ms(calendar, two_month_open, "2M") == _ms(
        "2024-03-01T00:00:00+00:00"
    )

    # The July weekly bar is delayed to Tuesday by a Monday holiday.  DST
    # changes the real NY session open to 13:30 UTC, but not the UTC weekly
    # close grid.
    weekly_open = calendar.first_expected_open(
        _ms("2024-07-01T00:00:00+00:00"),
        _ms("2024-07-07T23:59:59+00:00"),
        "1w",
    )
    assert weekly_open == _ms("2024-07-02T13:30:00+00:00")
    assert expected_bucket_end_ms(calendar, weekly_open, "1w") == _ms(
        "2024-07-08T00:00:00+00:00"
    )


def test_weekly_calendar_supports_cross_midnight_and_date_overrides() -> None:
    calendar = WeeklySessionCalendar(
        calendar_id="test.overnight.utc",
        timezone_name="UTC",
        weekly_sessions={0: (("22:00", "02:00"),), 1: (("09:00", "12:00"),)},
        overrides={"2024-01-09": (("10:00", "11:00"),)},
        holidays=("2024-01-15",),
    )
    assert SessionWindow("22:00", "02:00").crosses_midnight
    opens = list(calendar.expected_opens(
        _ms("2024-01-08T21:00:00+00:00"),
        _ms("2024-01-09T12:00:00+00:00"),
        "1h",
    ))
    assert opens == [
        _ms("2024-01-08T22:00:00+00:00"),
        _ms("2024-01-08T23:00:00+00:00"),
        _ms("2024-01-09T00:00:00+00:00"),
        _ms("2024-01-09T01:00:00+00:00"),
        _ms("2024-01-09T10:00:00+00:00"),
    ]
    assert list(calendar.expected_opens(
        _ms("2024-01-15T00:00:00+00:00"),
        _ms("2024-01-16T03:00:00+00:00"),
        "1h",
    )) == []


def test_session_calendar_uses_absolute_time_across_dst_transitions() -> None:
    calendar = WeeklySessionCalendar(
        calendar_id="test.ny.dst",
        timezone_name="America/New_York",
        weekly_sessions={6: (("00:00", "04:00"),)},
    )
    spring = list(calendar.expected_opens(
        _ms("2024-03-10T04:00:00+00:00"),
        _ms("2024-03-10T10:00:00+00:00"),
        "1h",
    ))
    assert spring == [
        _ms("2024-03-10T05:00:00+00:00"),
        _ms("2024-03-10T06:00:00+00:00"),
        _ms("2024-03-10T07:00:00+00:00"),
    ]
    fall = list(calendar.expected_opens(
        _ms("2024-11-03T03:00:00+00:00"),
        _ms("2024-11-03T10:00:00+00:00"),
        "1h",
    ))
    assert fall == [
        _ms("2024-11-03T04:00:00+00:00"),
        _ms("2024-11-03T05:00:00+00:00"),
        _ms("2024-11-03T06:00:00+00:00"),
        _ms("2024-11-03T07:00:00+00:00"),
        _ms("2024-11-03T08:00:00+00:00"),
    ]


def test_calendar_registry_only_has_explicit_default() -> None:
    registry = CalendarRegistry()
    assert registry.ids() == ("crypto.24x7.utc",)
    assert isinstance(registry.require("crypto.24x7.utc"), AlwaysOpenCalendar)
    assert registry.get("missing") is None
