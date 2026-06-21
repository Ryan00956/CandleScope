"""Lower-timeframe grouping results and helpers."""
from __future__ import annotations

from bisect import bisect_left
from dataclasses import dataclass
from typing import Any, Callable

import numpy as np

from ..series import PyneSeries
from ..values import is_na_value

RequestValues = list[Any] | tuple[list[Any], ...]


@dataclass(frozen=True)
class LowerTimeframeSeries:
    """Array-per-chart-bar result returned by ``request.security_lower_tf()``."""

    groups: tuple[tuple[Any, ...], ...]
    name: str | None = None

    def __len__(self) -> int:
        return len(self.groups)

    def __iter__(self):
        return iter(self.groups)

    def __getitem__(self, key: int | slice) -> Any:
        if isinstance(key, slice):
            return self.groups[key]
        if not isinstance(key, (int, np.integer)):
            raise TypeError("LowerTimeframeSeries indices must be a non-negative bars-back integer")
        if key < 0:
            raise IndexError("LowerTimeframeSeries does not support forward history references")
        return self.shift(int(key))

    def to_lists(self) -> list[list[Any]]:
        return [list(group) for group in self.groups]

    def shift(self, periods: int = 1) -> "LowerTimeframeSeries":
        periods = int(periods)
        if periods <= 0:
            return self
        empty: tuple[Any, ...] = ()
        groups = [empty] * len(self.groups)
        if periods < len(self.groups):
            groups[periods:] = self.groups[: len(self.groups) - periods]
        return LowerTimeframeSeries(
            tuple(groups),
            name=f"{self.name}[{periods}]" if self.name else None,
        )

    def size(self) -> PyneSeries:
        return _lower_tf_numeric_series(
            [len(group) for group in self.groups],
            name=f"{self.name}.size" if self.name else None,
        )

    def first(self, default: Any = np.nan) -> PyneSeries:
        return self._edge(0, default=default, label="first")

    def last(self, default: Any = np.nan) -> PyneSeries:
        return self._edge(-1, default=default, label="last")

    def get(self, index: int, default: Any = np.nan) -> PyneSeries:
        """Return the value at ``index`` from each chart bar's lower-TF group."""
        index = int(index)
        if index < 0:
            raise IndexError("LowerTimeframeSeries.get() requires a non-negative index")
        values = [group[index] if index < len(group) else default for group in self.groups]
        return _lower_tf_numeric_series(
            values,
            name=f"{self.name}.get" if self.name else None,
        )

    def sum(self, default: Any = np.nan) -> PyneSeries:
        return self._aggregate(np.sum, default=default, label="sum")

    def min(self, default: Any = np.nan) -> PyneSeries:
        return self._aggregate(np.min, default=default, label="min")

    def max(self, default: Any = np.nan) -> PyneSeries:
        return self._aggregate(np.max, default=default, label="max")

    def avg(self, default: Any = np.nan) -> PyneSeries:
        return self._aggregate(np.mean, default=default, label="avg")

    def _edge(self, index: int, *, default: Any, label: str) -> PyneSeries:
        values = [group[index] if group else default for group in self.groups]
        return _lower_tf_numeric_series(
            values,
            name=f"{self.name}.{label}" if self.name else None,
        )

    def _aggregate(
        self,
        op: Callable[[np.ndarray], Any],
        *,
        default: Any,
        label: str,
    ) -> PyneSeries:
        values: list[Any] = []
        for group in self.groups:
            clean = np.asarray(
                [float(value) for value in group if not is_na_value(value)],
                dtype=np.float64,
            )
            values.append(default if len(clean) == 0 else op(clean))
        return _lower_tf_numeric_series(
            values,
            name=f"{self.name}.{label}" if self.name else None,
        )


def _group_lower_timeframe_values(
    *,
    symbol: str,
    timeframe: str,
    expression_name: str,
    chart_times: list[int],
    requested_times: list[int],
    requested_values: RequestValues,
) -> LowerTimeframeSeries | tuple[LowerTimeframeSeries, ...]:
    if isinstance(requested_values, tuple):
        return tuple(
            _group_single_lower_timeframe_values(
                symbol=symbol,
                timeframe=timeframe,
                expression_name=f"{expression_name}[{index}]",
                chart_times=chart_times,
                requested_times=requested_times,
                requested_values=values,
            )
            for index, values in enumerate(requested_values)
        )
    return _group_single_lower_timeframe_values(
        symbol=symbol,
        timeframe=timeframe,
        expression_name=expression_name,
        chart_times=chart_times,
        requested_times=requested_times,
        requested_values=requested_values,
    )

def _group_single_lower_timeframe_values(
    *,
    symbol: str,
    timeframe: str,
    expression_name: str,
    chart_times: list[int],
    requested_times: list[int],
    requested_values: list[Any],
) -> LowerTimeframeSeries:
    groups: list[tuple[Any, ...]] = []
    for index, chart_time in enumerate(chart_times):
        next_time = chart_times[index + 1] if index + 1 < len(chart_times) else None
        start = bisect_left(requested_times, chart_time)
        end = len(requested_times) if next_time is None else bisect_left(requested_times, next_time)
        groups.append(tuple(
            np.nan if is_na_value(value) else value
            for value in requested_values[start:end]
        ))
    return LowerTimeframeSeries(
        tuple(groups),
        name=f"request.security_lower_tf({symbol},{timeframe},{expression_name})",
    )

def _lower_tf_numeric_series(values: list[Any], *, name: str | None = None) -> PyneSeries:
    return PyneSeries(
        np.asarray(
            [np.nan if is_na_value(value) else float(value) for value in values],
            dtype=np.float64,
        ),
        name=name,
    )
