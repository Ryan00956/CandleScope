"""Trading-calendar contracts and built-in implementations."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from threading import RLock
from typing import Iterable, Mapping, Protocol, Sequence, runtime_checkable
from zoneinfo import ZoneInfo

from app.data_engine.history.models import TimeRange
from app.data_engine.interval_policy import (
    add_months,
    compute_bucket_end_ms,
    compute_bucket_start_ms,
    is_monthly_interval,
    is_weekly_interval,
    parse_interval_ms,
    parse_monthly_count,
)


_UTC = timezone.utc
_DAY_MS = 86_400_000
_SEARCH_HORIZON_MS = 10 * 366 * _DAY_MS


def _interval_width_ms(interval: str) -> int:
    value = parse_interval_ms(interval)
    if value is None or value <= 0:
        raise ValueError(f"unsupported interval: {interval!r}")
    return value


def _next_bucket(open_ms: int, interval: str) -> int:
    months = parse_monthly_count(interval)
    if months is not None:
        return add_months(open_ms // 1000, months) * 1000
    return open_ms + _interval_width_ms(interval)


def _previous_bucket(open_ms: int, interval: str) -> int:
    months = parse_monthly_count(interval)
    if months is not None:
        return add_months(open_ms // 1000, -months) * 1000
    return open_ms - _interval_width_ms(interval)


@runtime_checkable
class TradingCalendar(Protocol):
    """Expected-bar policy for one market schedule."""

    calendar_id: str

    def first_expected_open(
        self, start_ms: int, end_ms: int, interval: str
    ) -> int | None: ...

    def last_expected_open(
        self, start_ms: int, end_ms: int, interval: str
    ) -> int | None: ...

    def next_expected_open(self, open_ms: int, interval: str) -> int | None: ...

    def previous_expected_open(self, open_ms: int, interval: str) -> int | None: ...

    def count_expected(self, start_ms: int, end_ms: int, interval: str) -> int: ...

    def expected_opens(
        self, start_ms: int, end_ms: int, interval: str
    ) -> Iterable[int]: ...

    def open_segments(
        self, start_ms: int, end_ms: int, interval: str
    ) -> tuple[TimeRange, ...]: ...


def expected_bucket_end_ms(
    calendar: TradingCalendar,
    open_ms: int,
    interval: str,
) -> int:
    """Return the exclusive close edge for one expected calendar bucket.

    Unknown/third-party calendars retain the natural interval edge.  Built-in
    session calendars may clamp sub-day tail buckets to the containing session
    close so a short final candle does not remain forming forever.
    """
    width_ms = _interval_width_ms(interval)
    natural_end_ms = compute_bucket_end_ms(
        int(open_ms),
        width_ms,
        interval=interval,
    )
    resolver = getattr(calendar, "bucket_end_ms", None)
    if not callable(resolver):
        return natural_end_ms
    try:
        resolved = int(resolver(int(open_ms), interval))
    except (TypeError, ValueError):
        return natural_end_ms
    return resolved if resolved > int(open_ms) else natural_end_ms


def latest_closed_expected_open_ms(
    calendar: TradingCalendar,
    now_ms: int,
    interval: str,
    requested_end_ms: int | None = None,
) -> int | None:
    """Return the latest expected open whose target bucket is fully closed.

    Session calendars may anchor bars at offsets such as 09:30.  Applying a
    UTC-aligned closed edge first can therefore include a forming session bar
    or delay a newly closed one by almost a full interval.
    """
    width_ms = parse_interval_ms(interval)
    if width_ms is None or width_ms <= 0:
        return None
    edge_ms = min(
        int(now_ms),
        int(requested_end_ms) if requested_end_ms is not None else int(now_ms),
    )
    # ``previous_expected_open`` is guaranteed to step from an expected open,
    # but third-party/always-open implementations need not align an arbitrary
    # wall-clock value first.  Resolve the initial candidate through the range
    # contract, then use strict stepping only between canonical opens.
    candidate = calendar.last_expected_open(
        max(0, edge_ms - _SEARCH_HORIZON_MS),
        edge_ms,
        interval,
    )
    while candidate is not None:
        bucket_end_ms = expected_bucket_end_ms(calendar, candidate, interval)
        if bucket_end_ms <= int(now_ms):
            return candidate
        candidate = calendar.previous_expected_open(candidate, interval)
    return None


class AlwaysOpenCalendar:
    """UTC bucket calendar for continuously traded products."""

    def __init__(self, calendar_id: str = "crypto.24x7.utc") -> None:
        self.calendar_id = str(calendar_id)

    def first_expected_open(
        self, start_ms: int, end_ms: int, interval: str
    ) -> int | None:
        if end_ms < start_ms:
            return None
        width_ms = _interval_width_ms(interval)
        current = compute_bucket_start_ms(start_ms, width_ms, interval=interval)
        if current < start_ms:
            current = _next_bucket(current, interval)
        return current if current <= end_ms else None

    def last_expected_open(
        self, start_ms: int, end_ms: int, interval: str
    ) -> int | None:
        if end_ms < start_ms:
            return None
        width_ms = _interval_width_ms(interval)
        current = compute_bucket_start_ms(end_ms, width_ms, interval=interval)
        return current if current >= start_ms else None

    def next_expected_open(self, open_ms: int, interval: str) -> int:
        return _next_bucket(int(open_ms), interval)

    def previous_expected_open(self, open_ms: int, interval: str) -> int:
        return _previous_bucket(int(open_ms), interval)

    def count_expected(self, start_ms: int, end_ms: int, interval: str) -> int:
        first = self.first_expected_open(start_ms, end_ms, interval)
        if first is None:
            return 0
        last = self.last_expected_open(start_ms, end_ms, interval)
        if last is None:
            return 0
        if not is_monthly_interval(interval):
            return ((last - first) // _interval_width_ms(interval)) + 1
        count = 0
        current = first
        while current <= last:
            count += 1
            current = _next_bucket(current, interval)
        return count

    def expected_opens(
        self, start_ms: int, end_ms: int, interval: str
    ) -> Iterable[int]:
        current = self.first_expected_open(start_ms, end_ms, interval)
        while current is not None and current <= end_ms:
            yield current
            current = _next_bucket(current, interval)

    def open_segments(
        self, start_ms: int, end_ms: int, interval: str
    ) -> tuple[TimeRange, ...]:
        first = self.first_expected_open(start_ms, end_ms, interval)
        last = self.last_expected_open(start_ms, end_ms, interval)
        if first is None or last is None:
            return ()
        return (TimeRange(first, last),)


def _parse_local_time(value: time | str) -> time:
    if isinstance(value, time):
        if value.tzinfo is not None:
            raise ValueError("session times must be timezone-naive")
        return value.replace(microsecond=0)
    text = str(value or "").strip()
    for pattern in ("%H:%M:%S", "%H:%M"):
        try:
            return datetime.strptime(text, pattern).time()
        except ValueError:
            continue
    raise ValueError(f"invalid local session time: {value!r}")


@dataclass(frozen=True, slots=True)
class SessionWindow:
    """Local wall-clock session anchored on a weekday/date.

    An end at or before the start means the session crosses midnight.  Equal
    start/end therefore represents a full 24-hour session.
    """

    start: time | str
    end: time | str

    def __post_init__(self) -> None:
        object.__setattr__(self, "start", _parse_local_time(self.start))
        object.__setattr__(self, "end", _parse_local_time(self.end))

    @property
    def crosses_midnight(self) -> bool:
        return self.end <= self.start


SessionSpec = SessionWindow | tuple[time | str, time | str]


def _normalise_window(value: SessionSpec) -> SessionWindow:
    if isinstance(value, SessionWindow):
        return value
    if isinstance(value, tuple) and len(value) == 2:
        return SessionWindow(value[0], value[1])
    raise TypeError(f"invalid session window: {value!r}")


class SessionCalendar:
    """IANA-timezone weekly calendar with date-specific overrides.

    Weekly windows and overrides are anchored on their local start date.
    Overrides replace that date's weekly windows; an empty override is a full
    holiday.  Absolute UTC stepping inside a session naturally handles DST
    skips and repeated hours.
    """

    def __init__(
        self,
        *,
        calendar_id: str,
        timezone_name: str,
        weekly_sessions: Mapping[int, Sequence[SessionSpec]],
        overrides: Mapping[date | str, Sequence[SessionSpec] | None] | None = None,
        holidays: Iterable[date | str] = (),
    ) -> None:
        if not str(calendar_id or "").strip():
            raise ValueError("calendar_id must be non-empty")
        self.calendar_id = str(calendar_id).strip()
        self.timezone_name = str(timezone_name)
        self.timezone = ZoneInfo(self.timezone_name)
        normalised_weekly: dict[int, tuple[SessionWindow, ...]] = {}
        for weekday, windows in weekly_sessions.items():
            day = int(weekday)
            if day < 0 or day > 6:
                raise ValueError("weekly session keys must be in range 0..6")
            normalised_weekly[day] = tuple(_normalise_window(item) for item in windows)
        self._weekly = normalised_weekly

        normalised_overrides: dict[date, tuple[SessionWindow, ...]] = {}
        for local_date, windows in (overrides or {}).items():
            key = self._parse_date(local_date)
            normalised_overrides[key] = tuple(
                _normalise_window(item) for item in (windows or ())
            )
        for local_date in holidays:
            normalised_overrides[self._parse_date(local_date)] = ()
        self._overrides = normalised_overrides

    @staticmethod
    def _parse_date(value: date | str) -> date:
        if isinstance(value, datetime):
            return value.date()
        if isinstance(value, date):
            return value
        return date.fromisoformat(str(value))

    def _windows_for_date(self, local_date: date) -> tuple[SessionWindow, ...]:
        override = self._overrides.get(local_date)
        if override is not None:
            return override
        return self._weekly.get(local_date.weekday(), ())

    def _to_utc_ms(self, local_date: date, local_time: time) -> int:
        local_dt = datetime.combine(local_date, local_time, tzinfo=self.timezone)
        return int(local_dt.astimezone(_UTC).timestamp() * 1000)

    def _session_segments(
        self,
        start_ms: int,
        end_ms: int,
        *,
        lookback_ms: int = 0,
    ) -> tuple[tuple[int, int], ...]:
        """Return merged full session ranges as ``[start, end)`` UTC values."""
        if end_ms < start_ms:
            return ()
        query_start = int(start_ms) - max(0, int(lookback_ms))
        local_start = datetime.fromtimestamp(query_start / 1000, self.timezone).date()
        local_end = datetime.fromtimestamp(end_ms / 1000, self.timezone).date()
        current_date = local_start - timedelta(days=1)
        final_date = local_end + timedelta(days=1)
        segments: list[tuple[int, int]] = []
        while current_date <= final_date:
            for window in self._windows_for_date(current_date):
                end_date = current_date + timedelta(days=1) if window.crosses_midnight else current_date
                session_start = self._to_utc_ms(current_date, window.start)
                session_end = self._to_utc_ms(end_date, window.end)
                if session_end <= session_start:
                    continue
                if session_end > query_start and session_start <= end_ms:
                    segments.append((session_start, session_end))
            current_date += timedelta(days=1)
        if not segments:
            return ()
        segments.sort()
        merged: list[tuple[int, int]] = [segments[0]]
        for segment_start, segment_end in segments[1:]:
            previous_start, previous_end = merged[-1]
            if segment_start <= previous_end:
                merged[-1] = (previous_start, max(previous_end, segment_end))
            else:
                merged.append((segment_start, segment_end))
        return tuple(merged)

    def bucket_end_ms(self, open_ms: int, interval: str) -> int:
        """Return a session-aware exclusive bucket end for an expected open."""
        width_ms = _interval_width_ms(interval)
        # Coarse session bars expose the first *actual* session open inside a
        # canonical weekly/monthly bucket.  A holiday or DST transition can
        # move that timestamp away from the canonical grid, so stepping from
        # the exposed open would also move the close edge.  Close coarse bars
        # on the shared UTC grid while retaining the real open timestamp.
        bucket_origin_ms = (
            compute_bucket_start_ms(
                int(open_ms),
                width_ms,
                interval=interval,
            )
            if is_weekly_interval(interval) or is_monthly_interval(interval)
            else int(open_ms)
        )
        natural_end_ms = compute_bucket_end_ms(
            bucket_origin_ms,
            width_ms,
            interval=interval,
        )
        # Daily/multi-day/monthly buckets intentionally retain their natural
        # calendar edge; only intraday session tails can be shorter than the
        # nominal interval width.
        if width_ms >= _DAY_MS or is_monthly_interval(interval):
            return natural_end_ms
        for session_start_ms, session_end_ms in self._session_segments(
            int(open_ms),
            natural_end_ms,
            lookback_ms=width_ms,
        ):
            if session_start_ms <= int(open_ms) < session_end_ms:
                return min(natural_end_ms, session_end_ms)
        return natural_end_ms

    def _coarse_expected_opens(
        self, start_ms: int, end_ms: int, interval: str, width_ms: int
    ) -> tuple[int, ...]:
        if is_monthly_interval(interval):
            months = parse_monthly_count(interval) or 1
            lookback_ms = max(
                width_ms,
                start_ms - add_months(start_ms // 1000, -months) * 1000,
            ) + (2 * _DAY_MS)
        else:
            lookback_ms = width_ms + (2 * _DAY_MS)
        candidates: dict[int, int] = {}
        for session_start, _ in self._session_segments(
            start_ms, end_ms, lookback_ms=lookback_ms
        ):
            bucket = compute_bucket_start_ms(
                session_start,
                width_ms,
                interval=interval,
            )
            candidates[bucket] = min(candidates.get(bucket, session_start), session_start)
        return tuple(
            candidate
            for _, candidate in sorted(candidates.items())
            if start_ms <= candidate <= end_ms
        )

    def expected_opens(
        self, start_ms: int, end_ms: int, interval: str
    ) -> Iterable[int]:
        if end_ms < start_ms:
            return iter(())
        width_ms = _interval_width_ms(interval)
        if is_monthly_interval(interval) or width_ms >= _DAY_MS:
            return iter(self._coarse_expected_opens(start_ms, end_ms, interval, width_ms))

        def generate() -> Iterable[int]:
            last_emitted: int | None = None
            for session_start, session_end in self._session_segments(start_ms, end_ms):
                current = session_start
                if current < start_ms:
                    current += ((start_ms - current + width_ms - 1) // width_ms) * width_ms
                while current < session_end and current <= end_ms:
                    if current != last_emitted:
                        yield current
                        last_emitted = current
                    current += width_ms

        return generate()

    def first_expected_open(
        self, start_ms: int, end_ms: int, interval: str
    ) -> int | None:
        return next(iter(self.expected_opens(start_ms, end_ms, interval)), None)

    def last_expected_open(
        self, start_ms: int, end_ms: int, interval: str
    ) -> int | None:
        result: int | None = None
        for result in self.expected_opens(start_ms, end_ms, interval):
            pass
        return result

    def next_expected_open(self, open_ms: int, interval: str) -> int | None:
        start_ms = int(open_ms) + 1
        return self.first_expected_open(
            start_ms,
            start_ms + _SEARCH_HORIZON_MS,
            interval,
        )

    def previous_expected_open(self, open_ms: int, interval: str) -> int | None:
        end_ms = int(open_ms) - 1
        return self.last_expected_open(
            end_ms - _SEARCH_HORIZON_MS,
            end_ms,
            interval,
        )

    def count_expected(self, start_ms: int, end_ms: int, interval: str) -> int:
        return sum(1 for _ in self.expected_opens(start_ms, end_ms, interval))

    def open_segments(
        self, start_ms: int, end_ms: int, interval: str
    ) -> tuple[TimeRange, ...]:
        opens = list(self.expected_opens(start_ms, end_ms, interval))
        if not opens:
            return ()
        width_ms = _interval_width_ms(interval)
        segments: list[TimeRange] = []
        segment_start = opens[0]
        previous = opens[0]
        for current in opens[1:]:
            contiguous = (
                current == _next_bucket(previous, interval)
                if is_monthly_interval(interval)
                else current - previous == width_ms
            )
            if not contiguous:
                segments.append(TimeRange(segment_start, previous))
                segment_start = current
            previous = current
        segments.append(TimeRange(segment_start, previous))
        return tuple(segments)


class WeeklySessionCalendar(SessionCalendar):
    """Explicit name for the common weekly-session calendar shape."""


class CalendarRegistry:
    """Thread-safe registry used by all history consumers."""

    def __init__(self, *, include_defaults: bool = True) -> None:
        self._calendars: dict[str, TradingCalendar] = {}
        self._lock = RLock()
        if include_defaults:
            self.register("crypto.24x7.utc", AlwaysOpenCalendar())

    def register(
        self,
        calendar_id: str,
        calendar: TradingCalendar,
        *,
        replace: bool = False,
    ) -> None:
        key = str(calendar_id or "").strip()
        if not key:
            raise ValueError("calendar_id must be non-empty")
        if not isinstance(calendar, TradingCalendar):
            raise TypeError("calendar does not implement TradingCalendar")
        with self._lock:
            if key in self._calendars and not replace:
                raise ValueError(f"calendar already registered: {key}")
            self._calendars[key] = calendar

    def get(self, calendar_id: str | None) -> TradingCalendar | None:
        if not calendar_id:
            return None
        with self._lock:
            return self._calendars.get(str(calendar_id).strip())

    def require(self, calendar_id: str) -> TradingCalendar:
        calendar = self.get(calendar_id)
        if calendar is None:
            raise KeyError(f"unknown trading calendar: {calendar_id}")
        return calendar

    def ids(self) -> tuple[str, ...]:
        with self._lock:
            return tuple(sorted(self._calendars))


_PROCESS_CALENDAR_REGISTRY = CalendarRegistry()


def get_history_calendar_registry() -> CalendarRegistry:
    """Return the process-wide registry used by production runtime wiring.

    Exchange plugins that declare a non-default ``calendar_id`` register the
    corresponding calendar during plugin bootstrap.  Merely declaring an
    unknown id remains fail-closed.
    """
    return _PROCESS_CALENDAR_REGISTRY


def register_trading_calendar(
    calendar_id: str,
    calendar: TradingCalendar,
    *,
    replace: bool = False,
) -> None:
    """Register a production trading calendar by stable capability id."""
    _PROCESS_CALENDAR_REGISTRY.register(
        calendar_id,
        calendar,
        replace=replace,
    )
