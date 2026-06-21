from __future__ import annotations

import math

import numpy as np
import pytest

import pyne_runtime as pn
import pyne_runtime.utils as utils
from pyne_runtime import PyneSeries


def _bars() -> list[dict[str, float]]:
    return [
        {"time": 1, "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": 100},
        {"time": 2, "open": 2, "high": 3, "low": 1.5, "close": 2.5, "volume": 120},
        {"time": 3, "open": 3, "high": 4, "low": 2.5, "close": 3.5, "volume": 140},
        {"time": 4, "open": 4, "high": 5, "low": 3.5, "close": 4.5, "volume": 160},
        {"time": 5, "open": 5, "high": 6, "low": 4.5, "close": 5.5, "volume": 180},
        {"time": 6, "open": 6, "high": 7, "low": 5.5, "close": 6.5, "volume": 200},
    ]


def _values(result: pn.PyneResult, name: str) -> list[float]:
    return result.values(name)


def test_series_bars_back_indexing_and_numpy_escape_hatch() -> None:
    close = PyneSeries(np.array([1.0, 2.0, 3.0]), name="close")

    assert np.asarray(close).tolist() == [1.0, 2.0, 3.0]
    assert np.isnan(np.asarray(close[1])[0])
    assert np.asarray(close[1])[1:].tolist() == [1.0, 2.0]
    assert np.isnan(np.asarray(close[2])[:2]).all()
    assert np.asarray(close[2])[2] == 1.0

    with pytest.raises(IndexError):
        _ = close[-1]
    with pytest.raises(IndexError):
        close.shift(-1)
    with pytest.raises(IndexError):
        utils.shift(close, -1)


def test_series_arithmetic_and_boolean_operators() -> None:
    close = PyneSeries(np.array([1.0, 2.0, 3.0]), name="close")
    open_ = PyneSeries(np.array([2.0, 1.0, 4.0]), name="open")

    mid = (close + open_) / 2
    condition = (close > open_) | (close > close[1])

    assert isinstance(mid, PyneSeries)
    assert np.asarray(mid).tolist() == [1.5, 1.5, 3.5]
    assert isinstance(condition, PyneSeries)
    assert np.asarray(condition).tolist() == [False, True, True]

    with pytest.raises(TypeError):
        bool(condition)


def test_na_left_arithmetic_preserves_series_shape() -> None:
    close = PyneSeries(np.array([1.0, 2.0, 3.0]), name="close")

    result = pn.na + close

    assert isinstance(result, PyneSeries)
    assert result.name == "close"
    assert len(result) == 3
    assert np.isnan(result.values).all()


def test_runtime_supports_pine_like_history_reference() -> None:
    result = pn.run(
        """
indicator("Series Indexing", overlay=True)

prev = close[1]
mid = (high + low) / 2
fast = ta.ema(close, 3)
slow = ta.ema(close[1], 3)

plot(close, "Close", color=color.orange)
plot(prev, "Previous Close", color=color.blue)
plot(mid, "Mid", color=color.gray)
marker((fast > slow) & (close > prev), text="Signal", color=color.green)
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    assert _values(result, "Close") == [1.5, 2.5, 3.5, 4.5, 5.5, 6.5]
    assert _values(result, "Previous Close") == [1.5, 2.5, 3.5, 4.5, 5.5]
    assert _values(result, "Mid")[-1] == 6.25
    assert result.output["markers"][0]["data"]


def test_runtime_rejects_forward_shift_helper_reference() -> None:
    result = pn.run(
        """
indicator("Forward Shift", overlay=True)
plot(shift(close, -1), "Future Close")
""",
        _bars(),
        executor_mode="inline",
    )

    assert not result.ok
    assert "forward history references" in str(result.error)


def test_input_source_accepts_pyne_series() -> None:
    result = pn.run(
        """
src = input.source(close, "Source")
plot(src[1], "Previous Source")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    assert _values(result, "Previous Source")[0] == 1.5
    assert math.isclose(_values(result, "Previous Source")[-1], 5.5)
