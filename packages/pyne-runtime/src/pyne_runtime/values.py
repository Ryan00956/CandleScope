"""Shared scalar and missing-value semantics for Pyne."""
from __future__ import annotations

from typing import Any

import numpy as np


class PyneNA:
    """Callable Pine-like ``na`` sentinel.

    The object can be used as a missing value and as ``na(value)`` to check
    whether a scalar or series contains missing values.
    """

    __array_priority__ = 1000

    def __call__(self, value: Any = None) -> Any:
        if value is None:
            return True
        return is_na(value)

    def __array__(self, dtype: Any = None, copy: bool | None = None) -> np.ndarray:
        if copy is None:
            return np.asarray(np.nan, dtype=dtype)
        return np.array(np.nan, dtype=dtype, copy=copy)

    def __float__(self) -> float:
        return float("nan")

    def __bool__(self) -> bool:
        return False

    def __repr__(self) -> str:
        return "na"

    def __str__(self) -> str:
        return "na"

    def _nan(self, other: Any = None) -> Any:
        from .series import PyneSeries

        if isinstance(other, PyneSeries):
            return PyneSeries(np.full(len(other), np.nan, dtype=np.float64), name=other.name)
        return float("nan")

    __add__ = _nan
    __radd__ = _nan
    __sub__ = _nan
    __rsub__ = _nan
    __mul__ = _nan
    __rmul__ = _nan
    __truediv__ = _nan
    __rtruediv__ = _nan
    __floordiv__ = _nan
    __rfloordiv__ = _nan
    __mod__ = _nan
    __rmod__ = _nan
    __pow__ = _nan
    __rpow__ = _nan


na = PyneNA()


def is_na_sentinel(value: Any) -> bool:
    return isinstance(value, PyneNA)


def to_missing_scalar(value: Any) -> Any:
    return np.nan if is_na_sentinel(value) else value


def is_na(value: Any) -> Any:
    """Return Pine-like missing-value checks for scalar or series input."""
    from .series import PyneSeries, to_numpy, wrap_like

    if isinstance(value, PyneSeries):
        return wrap_like(_is_na_array(to_numpy(value)), value)
    if isinstance(value, np.ndarray):
        return _is_na_array(value)
    return is_na_value(value)


def is_na_value(value: Any) -> bool:
    if value is None or is_na_sentinel(value):
        return True
    if isinstance(value, (float, np.floating)):
        return bool(np.isnan(value))
    return False


def _is_na_array(value: np.ndarray) -> np.ndarray:
    if np.issubdtype(value.dtype, np.number):
        return np.isnan(value)
    return np.vectorize(is_na_value, otypes=[bool])(value)
