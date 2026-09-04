from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from functools import lru_cache
from zoneinfo import ZoneInfo

import exchange_calendars as xcals
import pandas as pd

from app.data_engine.history import AlwaysOpenCalendar, SessionCalendar
from app.data_engine.interval_policy import (
    compute_bucket_end_ms,
    is_monthly_interval,
    parse_interval_ms,
)


_DAY_MS = 86_400_000
_NEW_YORK = ZoneInfo("America/New_York")
_SCHEDULE_START = date(2000, 1, 1)
_SCHEDULE_END = date(2045, 12, 31)
_REGULAR_US_SESSION = ((time(9, 30), time(16, 0)),)


class TwelveDataProviderDateCalendar(SessionCalendar):
    """Weekday provider dates whose monthly bars retain month-start labels."""

    _calendar_grid = AlwaysOpenCalendar()

    def expected_opens(self, start_ms: int, end_ms: int, interval: str):
        if is_monthly_interval(interval):
            return self._calendar_grid.expected_opens(start_ms, end_ms, interval)
        return super().expected_opens(start_ms, end_ms, interval)


class TwelveDataUsEquityCalendar(SessionCalendar):
    """XNYS intraday sessions combined with Twelve Data's coarse date labels.

    Twelve Data returns intraday US-equity bars on exchange sessions but labels
    daily and coarser rows with provider calendar dates.  One hybrid calendar
    keeps both contracts behind the single capability calendar id.
    """

    def __init__(self, *, calendar_id: str) -> None:
        overrides, holidays = _xnys_overrides()
        super().__init__(
            calendar_id=calendar_id,
            timezone_name="America/New_York",
            weekly_sessions={weekday: _REGULAR_US_SESSION for weekday in range(5)},
            overrides=overrides,
            holidays=holidays,
        )
        self._provider_dates = TwelveDataProviderDateCalendar(
            calendar_id=f"{calendar_id}.provider-dates",
            timezone_name="UTC",
            weekly_sessions={
                weekday: (("00:00", "23:59:59"),)
                for weekday in range(5)
            },
        )

    @staticmethod
    def _uses_provider_dates(interval: str) -> bool:
        width_ms = parse_interval_ms(interval)
        return is_monthly_interval(interval) or (
            width_ms is not None and width_ms >= _DAY_MS
        )

    def expected_opens(self, start_ms: int, end_ms: int, interval: str):
        if self._uses_provider_dates(interval):
            return self._provider_dates.expected_opens(start_ms, end_ms, interval)
        clipped = _clip_intraday_range(start_ms, end_ms)
        if clipped is None or clipped != (int(start_ms), int(end_ms)):
            raise ValueError(
                "Twelve Data US-equity intraday calendar is available only "
                f"from {_SCHEDULE_START.isoformat()} through {_SCHEDULE_END.isoformat()}"
            )
        return super().expected_opens(start_ms, end_ms, interval)

    def bucket_end_ms(self, open_ms: int, interval: str) -> int:
        if self._uses_provider_dates(interval):
            return self._provider_dates.bucket_end_ms(open_ms, interval)
        open_date = datetime.fromtimestamp(
            int(open_ms) / 1000,
            tz=timezone.utc,
        ).astimezone(_NEW_YORK).date()
        if open_date < _SCHEDULE_START or open_date > _SCHEDULE_END:
            width_ms = parse_interval_ms(interval)
            if width_ms is None:
                return super().bucket_end_ms(open_ms, interval)
            return compute_bucket_end_ms(int(open_ms), width_ms, interval=interval)
        return super().bucket_end_ms(open_ms, interval)

    def cash_session_end_ms(self, open_ms: int) -> int | None:
        """Return the exclusive UTC end of the cash session for a provider date.

        Daily Twelve Data rows are labeled at UTC midnight of the venue
        calendar date, so the session lookup must use that UTC date rather
        than the New York civil date of the timestamp.
        """
        open_date = datetime.fromtimestamp(
            int(open_ms) / 1000,
            tz=timezone.utc,
        ).date()
        windows = self._windows_for_date(open_date)
        if not windows:
            return None
        last = windows[-1]
        end_date = open_date + timedelta(days=1) if last.crosses_midnight else open_date
        return self._to_utc_ms(end_date, last.end)


def _local_time(value: object) -> time:
    timestamp = value.to_pydatetime()  # pandas Timestamp from exchange_calendars
    if timestamp.tzinfo is None:
        raise ValueError("exchange calendar timestamp must be timezone-aware")
    return timestamp.astimezone(_NEW_YORK).time().replace(tzinfo=None)


@lru_cache(maxsize=1)
def _xnys_overrides() -> tuple[
    dict[date, tuple[tuple[time, time], ...]],
    tuple[date, ...],
]:
    calendar = xcals.get_calendar(
        "XNYS",
        start=_SCHEDULE_START.isoformat(),
        end=_SCHEDULE_END.isoformat(),
        side="left",
    )
    schedule = calendar.schedule
    rows = {index.date(): row for index, row in schedule.iterrows()}
    overrides: dict[date, tuple[tuple[time, time], ...]] = {}
    holidays: list[date] = []
    current = _SCHEDULE_START
    while current <= _SCHEDULE_END:
        if current.weekday() < 5:
            row = rows.get(current)
            if row is None:
                holidays.append(current)
            else:
                windows: list[tuple[time, time]] = []
                open_time = _local_time(row["open"])
                close_time = _local_time(row["close"])
                break_start = row.get("break_start")
                break_end = row.get("break_end")
                if break_start is not None and bool(pd.isna(break_start)):
                    break_start = None
                if break_end is not None and bool(pd.isna(break_end)):
                    break_end = None
                if break_start is not None and break_end is not None:
                    windows.append((open_time, _local_time(break_start)))
                    windows.append((_local_time(break_end), close_time))
                else:
                    windows.append((open_time, close_time))
                normalised = tuple(windows)
                if normalised != _REGULAR_US_SESSION:
                    overrides[current] = normalised
        current += timedelta(days=1)
    return overrides, tuple(holidays)


def _clip_intraday_range(start_ms: int, end_ms: int) -> tuple[int, int] | None:
    start_date = datetime.fromtimestamp(
        int(start_ms) / 1000,
        tz=timezone.utc,
    ).astimezone(_NEW_YORK).date()
    end_date = datetime.fromtimestamp(
        int(end_ms) / 1000,
        tz=timezone.utc,
    ).astimezone(_NEW_YORK).date()
    if end_date < _SCHEDULE_START or start_date > _SCHEDULE_END:
        return None
    clipped_start = int(start_ms)
    clipped_end = int(end_ms)
    if start_date < _SCHEDULE_START:
        clipped_start = int(
            datetime(
                _SCHEDULE_START.year,
                _SCHEDULE_START.month,
                _SCHEDULE_START.day,
                tzinfo=_NEW_YORK,
            ).astimezone(timezone.utc).timestamp()
            * 1000
        )
    if end_date > _SCHEDULE_END:
        clipped_end = int(
            datetime(
                _SCHEDULE_END.year,
                _SCHEDULE_END.month,
                _SCHEDULE_END.day,
                23,
                59,
                59,
                tzinfo=_NEW_YORK,
            ).astimezone(timezone.utc).timestamp()
            * 1000
        )
    if clipped_start > clipped_end:
        return None
    return clipped_start, clipped_end


def build_provider_date_calendar(*, calendar_id: str) -> TwelveDataProviderDateCalendar:
    return TwelveDataProviderDateCalendar(
        calendar_id=calendar_id,
        timezone_name="UTC",
        weekly_sessions={
            weekday: (("00:00", "23:59:59"),)
            for weekday in range(5)
        },
    )


__all__ = [
    "TwelveDataProviderDateCalendar",
    "TwelveDataUsEquityCalendar",
    "build_provider_date_calendar",
]
