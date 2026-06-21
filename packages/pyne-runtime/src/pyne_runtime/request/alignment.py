"""Request bar merge and chart-time alignment helpers."""
from __future__ import annotations

from bisect import bisect_left, bisect_right
from dataclasses import dataclass
from typing import Any

import numpy as np

from ..series import PyneSeries
from ..values import is_na_value
from .errors import PyneRequestError

RequestValues = list[Any] | tuple[list[Any], ...]

_GAPS_ALIASES = {
    "off": "off",
    "gaps_off": "off",
    "barmerge.gaps_off": "off",
    "on": "on",
    "gaps_on": "on",
    "barmerge.gaps_on": "on",
}
_LOOKAHEAD_ALIASES = {
    "off": "off",
    "lookahead_off": "off",
    "barmerge.lookahead_off": "off",
    "on": "on",
    "lookahead_on": "on",
    "barmerge.lookahead_on": "on",
}


@dataclass(frozen=True)
class BarMergeNamespace:
    """Pine-like constants for request alignment options."""

    gaps_off: str = "barmerge.gaps_off"
    gaps_on: str = "barmerge.gaps_on"
    lookahead_off: str = "barmerge.lookahead_off"
    lookahead_on: str = "barmerge.lookahead_on"


barmerge = BarMergeNamespace()


def _align_request_values(
    *,
    symbol: str,
    timeframe: str,
    expression_name: str,
    chart_times: list[int],
    requested_times: list[int],
    requested_values: RequestValues,
    gaps: str,
    lookahead: str,
) -> PyneSeries | tuple[PyneSeries, ...]:
    if isinstance(requested_values, tuple):
        return tuple(
            _align_single_request_values(
                symbol=symbol,
                timeframe=timeframe,
                expression_name=f"{expression_name}[{index}]",
                chart_times=chart_times,
                requested_times=requested_times,
                requested_values=values,
                gaps=gaps,
                lookahead=lookahead,
            )
            for index, values in enumerate(requested_values)
        )

    return _align_single_request_values(
        symbol=symbol,
        timeframe=timeframe,
        expression_name=expression_name,
        chart_times=chart_times,
        requested_times=requested_times,
        requested_values=requested_values,
        gaps=gaps,
        lookahead=lookahead,
    )

def _align_single_request_values(
    *,
    symbol: str,
    timeframe: str,
    expression_name: str,
    chart_times: list[int],
    requested_times: list[int],
    requested_values: list[Any],
    gaps: str,
    lookahead: str,
) -> PyneSeries:
    confirmation_times = _confirmation_times(chart_times, requested_times)
    values = [
        _aligned_value(
            chart_time,
            requested_times,
            confirmation_times,
            requested_values,
            gaps=gaps,
            lookahead=lookahead,
        )
        for chart_time in chart_times
    ]
    return PyneSeries(
        np.asarray(values, dtype=np.float64),
        name=f"request.security({symbol},{timeframe},{expression_name})",
    )

def _aligned_value(
    chart_time: int,
    requested_times: list[int],
    confirmation_times: list[int],
    requested_values: list[float],
    *,
    gaps: str,
    lookahead: str,
) -> float:
    alignment_times = requested_times if lookahead == "on" else confirmation_times
    if gaps == "on":
        idx = bisect_left(alignment_times, chart_time)
        if idx < len(alignment_times) and alignment_times[idx] == chart_time:
            value = requested_values[idx]
            return np.nan if is_na_value(value) else float(value)
        return np.nan

    if lookahead == "on":
        idx = bisect_right(requested_times, chart_time) - 1
    else:
        idx = bisect_right(confirmation_times, chart_time) - 1

    if idx < 0 or idx >= len(requested_values):
        return np.nan
    value = requested_values[idx]
    return np.nan if is_na_value(value) else float(value)


def _confirmation_times(chart_times: list[int], requested_times: list[int]) -> list[int]:
    if not requested_times:
        return []
    chart_step = _infer_step(chart_times)
    requested_step = _infer_step(requested_times)
    if chart_step is None or requested_step is None or requested_step <= chart_step:
        return list(requested_times)
    return [time + requested_step - chart_step for time in requested_times]


def _infer_step(times: list[int]) -> int | None:
    steps = [
        next_time - time
        for time, next_time in zip(times, times[1:])
        if next_time > time
    ]
    if not steps:
        return None
    return min(steps)

def _normalize_request_option(value: Any, *, name: str, aliases: dict[str, str]) -> str:
    raw = "off" if value is None else str(value).strip().lower()
    normalized = aliases.get(raw)
    if normalized is None:
        accepted = ", ".join(sorted(aliases))
        raise PyneRequestError(
            f"request.security() {name} must be one of: {accepted}",
            code="PYNE_UNSUPPORTED_FEATURE",
        )
    return normalized
