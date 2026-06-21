"""Pine-like series values used inside Pyne scripts."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

import numpy as np

from .values import is_na_sentinel, to_missing_scalar


SeriesLike = "PyneSeries | np.ndarray | list[Any] | tuple[Any, ...] | int | float | bool"


@dataclass(frozen=True)
class PyneSeries:
    """Vector-backed series with Pine-style bars-back indexing.

    ``series[1]`` means "the previous bar's series", not positional index 1.
    Internal code that needs positional indexing should use ``series.values`` or
    ``np.asarray(series)``.
    """

    values: np.ndarray
    name: str | None = None

    __array_priority__ = 1000

    def __post_init__(self) -> None:
        object.__setattr__(self, "values", np.asarray(self.values))

    def __array__(self, dtype: Any = None, copy: bool | None = None) -> np.ndarray:
        if copy is None:
            return np.asarray(self.values, dtype=dtype)
        return np.array(self.values, dtype=dtype, copy=copy)

    def __len__(self) -> int:
        return len(self.values)

    def __iter__(self):
        return iter(self.values)

    def __getitem__(self, key: int | slice) -> Any:
        if isinstance(key, slice):
            return self.values[key]
        if not isinstance(key, (int, np.integer)):
            raise TypeError("PyneSeries indices must be a non-negative bars-back integer")
        if key < 0:
            raise IndexError("PyneSeries does not support forward history references")
        return self.shift(int(key))

    def __bool__(self) -> bool:
        raise TypeError(
            "PyneSeries cannot be used as a Python bool; use '&', '|', '~', when(), or switch()."
        )

    def to_numpy(self, dtype: Any = None) -> np.ndarray:
        return np.asarray(self.values, dtype=dtype)

    def shift(self, periods: int = 1) -> "PyneSeries":
        periods = int(periods)
        if periods < 0:
            raise IndexError("PyneSeries does not support forward history references")
        result = np.full(len(self.values), np.nan, dtype=np.float64)
        values = np.asarray(self.values, dtype=np.float64)
        if periods == 0:
            result = values.copy()
        elif periods > 0 and periods < len(values):
            result[periods:] = values[: len(values) - periods]
        return PyneSeries(result, name=f"{self.name}[{periods}]" if self.name else None)

    def with_values(self, values: Any, name: str | None = None) -> "PyneSeries":
        return PyneSeries(np.asarray(values), name=name or self.name)

    def _binary(self, other: Any, op: Callable[[Any, Any], Any]) -> "PyneSeries":
        return PyneSeries(op(self.values, _operand(other)), name=self.name)

    def _rbinary(self, other: Any, op: Callable[[Any, Any], Any]) -> "PyneSeries":
        return PyneSeries(op(_operand(other), self.values), name=self.name)

    def __add__(self, other: Any) -> "PyneSeries":
        return self._binary(other, np.add)

    def __radd__(self, other: Any) -> "PyneSeries":
        return self._rbinary(other, np.add)

    def __sub__(self, other: Any) -> "PyneSeries":
        return self._binary(other, np.subtract)

    def __rsub__(self, other: Any) -> "PyneSeries":
        return self._rbinary(other, np.subtract)

    def __mul__(self, other: Any) -> "PyneSeries":
        return self._binary(other, np.multiply)

    def __rmul__(self, other: Any) -> "PyneSeries":
        return self._rbinary(other, np.multiply)

    def __truediv__(self, other: Any) -> "PyneSeries":
        return self._binary(other, np.divide)

    def __rtruediv__(self, other: Any) -> "PyneSeries":
        return self._rbinary(other, np.divide)

    def __floordiv__(self, other: Any) -> "PyneSeries":
        return self._binary(other, np.floor_divide)

    def __rfloordiv__(self, other: Any) -> "PyneSeries":
        return self._rbinary(other, np.floor_divide)

    def __mod__(self, other: Any) -> "PyneSeries":
        return self._binary(other, np.mod)

    def __rmod__(self, other: Any) -> "PyneSeries":
        return self._rbinary(other, np.mod)

    def __pow__(self, other: Any) -> "PyneSeries":
        return self._binary(other, np.power)

    def __rpow__(self, other: Any) -> "PyneSeries":
        return self._rbinary(other, np.power)

    def __neg__(self) -> "PyneSeries":
        return PyneSeries(-self.values, name=self.name)

    def __abs__(self) -> "PyneSeries":
        return PyneSeries(np.abs(self.values), name=self.name)

    def __gt__(self, other: Any) -> "PyneSeries":
        return self._binary(other, np.greater)

    def __ge__(self, other: Any) -> "PyneSeries":
        return self._binary(other, np.greater_equal)

    def __lt__(self, other: Any) -> "PyneSeries":
        return self._binary(other, np.less)

    def __le__(self, other: Any) -> "PyneSeries":
        return self._binary(other, np.less_equal)

    def __eq__(self, other: Any) -> "PyneSeries":  # type: ignore[override]
        return self._binary(other, np.equal)

    def __ne__(self, other: Any) -> "PyneSeries":  # type: ignore[override]
        return self._binary(other, np.not_equal)

    def __and__(self, other: Any) -> "PyneSeries":
        return PyneSeries(_truthy(self.values) & _truthy(_operand(other)), name=self.name)

    def __rand__(self, other: Any) -> "PyneSeries":
        return PyneSeries(_truthy(_operand(other)) & _truthy(self.values), name=self.name)

    def __or__(self, other: Any) -> "PyneSeries":
        return PyneSeries(_truthy(self.values) | _truthy(_operand(other)), name=self.name)

    def __ror__(self, other: Any) -> "PyneSeries":
        return PyneSeries(_truthy(_operand(other)) | _truthy(self.values), name=self.name)

    def __invert__(self) -> "PyneSeries":
        return PyneSeries(~_truthy(self.values), name=self.name)


def is_series(value: Any) -> bool:
    return isinstance(value, PyneSeries)


def to_numpy(value: Any, dtype: Any = None) -> np.ndarray:
    if isinstance(value, PyneSeries):
        return value.to_numpy(dtype=dtype)
    return np.asarray(value, dtype=dtype)


def wrap_like(values: Any, *sources: Any, name: str | None = None) -> Any:
    for source in sources:
        if isinstance(source, PyneSeries):
            return PyneSeries(np.asarray(values), name=name or source.name)
    return values


def where(condition: Any, true_value: Any, false_value: Any) -> Any:
    result = np.where(_truthy(_operand(condition)), _operand(true_value), _operand(false_value))
    return wrap_like(result, condition, true_value, false_value)


def when(condition: Any, true_value: Any, false_value: Any) -> Any:
    return where(condition, true_value, false_value)


def switch(*cases: Any, default: Any = np.nan) -> Any:
    """Return values from the first true condition, Pine-style.

    Cases are passed as ``(condition, value)`` tuples. Conditions may be scalar
    or series. Earlier cases take priority over later ones.
    """
    if not cases:
        return default

    length = _switch_length(cases, default)
    result = _broadcast(default, length)
    chosen = np.zeros(length, dtype=bool)
    sources: list[Any] = [default]

    for case in cases:
        if not isinstance(case, tuple) or len(case) != 2:
            raise TypeError("switch() cases must be (condition, value) tuples")
        condition, value = case
        sources.extend([condition, value])
        flags = _broadcast(_truthy(_operand(condition)), length).astype(bool)
        values = _broadcast(_operand(value), length)
        mask = flags & ~chosen
        result[mask] = values[mask]
        chosen |= mask

    return wrap_like(result, *sources)


def _operand(value: Any) -> Any:
    if isinstance(value, PyneSeries):
        return value.values
    if is_na_sentinel(value):
        return np.nan
    return value


def _truthy(value: Any) -> np.ndarray:
    arr = np.asarray(to_missing_scalar(value))
    if arr.dtype == np.bool_:
        return arr
    if np.issubdtype(arr.dtype, np.number):
        return np.isfinite(arr) & (arr != 0)
    return arr.astype(bool)


def _switch_length(cases: tuple[Any, ...], default: Any) -> int:
    for case in cases:
        if isinstance(case, tuple) and len(case) == 2:
            for item in case:
                if isinstance(item, PyneSeries):
                    return len(item)
                arr = np.asarray(_operand(item))
                if arr.ndim > 0:
                    return len(arr)
    if isinstance(default, PyneSeries):
        return len(default)
    arr = np.asarray(_operand(default))
    return len(arr) if arr.ndim > 0 else 1


def _broadcast(value: Any, length: int) -> np.ndarray:
    if isinstance(value, PyneSeries):
        value = value.values
    if is_na_sentinel(value):
        value = np.nan
    arr = np.asarray(value)
    if arr.ndim == 0:
        return np.full(length, arr.item(), dtype=object)
    if len(arr) != length:
        raise ValueError("switch() series inputs must have matching lengths")
    return arr.astype(object)
