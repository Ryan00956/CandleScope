"""Pine-like time helper namespace."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import numpy as np

from .series import PyneSeries
from .values import is_na_value


class TimeNamespace(PyneSeries):
    """Time series with Pine-like ``time.*`` helper methods."""

    sunday = 1
    monday = 2
    tuesday = 3
    wednesday = 4
    thursday = 5
    friday = 6
    saturday = 7

    def year(self, source: Any = None, timezone: str = "UTC") -> PyneSeries | int | None:
        return _component(self._source(source), timezone, lambda dt: dt.year)

    def month(self, source: Any = None, timezone: str = "UTC") -> PyneSeries | int | None:
        return _component(self._source(source), timezone, lambda dt: dt.month)

    def dayofmonth(self, source: Any = None, timezone: str = "UTC") -> PyneSeries | int | None:
        return _component(self._source(source), timezone, lambda dt: dt.day)

    def dayofweek(self, source: Any = None, timezone: str = "UTC") -> PyneSeries | int | None:
        return _component(self._source(source), timezone, _pine_dayofweek)

    def hour(self, source: Any = None, timezone: str = "UTC") -> PyneSeries | int | None:
        return _component(self._source(source), timezone, lambda dt: dt.hour)

    def minute(self, source: Any = None, timezone: str = "UTC") -> PyneSeries | int | None:
        return _component(self._source(source), timezone, lambda dt: dt.minute)

    def second(self, source: Any = None, timezone: str = "UTC") -> PyneSeries | int | None:
        return _component(self._source(source), timezone, lambda dt: dt.second)

    def timestamp(self, *args: Any, timezone: str = "UTC") -> int:
        if args and isinstance(args[0], str):
            timezone = args[0]
            args = args[1:]
        elif len(args) == 7 and isinstance(args[-1], str):
            timezone = args[-1]
            args = args[:-1]
        if not 3 <= len(args) <= 6:
            raise TypeError("time.timestamp() expects year, month, day, optional hour/minute/second")
        year, month, day, *rest = args
        hour, minute, second = (*rest, 0, 0, 0)[:3]
        tz = _timezone(timezone)
        value = datetime(
            int(year),
            int(month),
            int(day),
            int(hour),
            int(minute),
            int(second),
            tzinfo=tz,
        )
        return int(value.timestamp())

    def format(
        self,
        source: Any = None,
        fmt: str = "%Y-%m-%d %H:%M:%S",
        timezone: str = "UTC",
    ) -> str:
        value = _latest_scalar(self._source(source))
        if is_na_value(value):
            return "na"
        return _datetime(value, timezone).strftime(fmt)

    def _source(self, source: Any = None) -> Any:
        return self if source is None else source


def time_namespace(series: PyneSeries) -> TimeNamespace:
    return TimeNamespace(series.to_numpy(), name=series.name)


def _component(source: Any, tz_name: str, getter: Any) -> PyneSeries | int | None:
    if isinstance(source, PyneSeries):
        values = []
        for item in source.to_numpy():
            if is_na_value(item):
                values.append(np.nan)
            else:
                values.append(float(getter(_datetime(item, tz_name))))
        return PyneSeries(np.array(values, dtype=np.float64), name=source.name)
    if is_na_value(source):
        return None
    return int(getter(_datetime(source, tz_name)))


def _latest_scalar(source: Any) -> Any:
    if isinstance(source, PyneSeries):
        values = source.to_numpy().tolist()
    elif isinstance(source, np.ndarray):
        values = source.tolist()
    elif isinstance(source, list | tuple):
        values = list(source)
    else:
        return source
    for item in reversed(values):
        if not is_na_value(item):
            return item
    return None


def _datetime(timestamp: Any, tz_name: str) -> datetime:
    seconds = _timestamp_seconds(timestamp)
    return datetime.fromtimestamp(seconds, tz=_timezone(tz_name))


def _timestamp_seconds(timestamp: Any) -> float:
    value = float(timestamp)
    if abs(value) > 100_000_000_000:
        return value / 1000.0
    return value


def _timezone(name: str) -> timezone | ZoneInfo:
    text = str(name or "UTC").strip()
    if text.upper() in {"UTC", "GMT", "Z"}:
        return UTC
    if len(text) == 6 and text[0] in {"+", "-"} and text[3] == ":":
        sign = 1 if text[0] == "+" else -1
        hours = int(text[1:3])
        minutes = int(text[4:6])
        return timezone(sign * timedelta(hours=hours, minutes=minutes))
    try:
        return ZoneInfo(text)
    except ZoneInfoNotFoundError:
        return UTC


def _pine_dayofweek(value: datetime) -> int:
    # Python Monday=0; Pine dayofweek.sunday=1 ... saturday=7.
    return ((value.weekday() + 1) % 7) + 1
