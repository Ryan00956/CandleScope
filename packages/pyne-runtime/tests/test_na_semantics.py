from __future__ import annotations

import numpy as np

import pyne_runtime as pn
from pyne_runtime import PyneSeries
from pyne_runtime.values import na


def _bars() -> list[dict[str, float]]:
    return [
        {"time": 1, "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": 100},
        {"time": 2, "open": 2, "high": 3, "low": 1.5, "close": 2.5, "volume": 120},
        {"time": 3, "open": 3, "high": 4, "low": 2.5, "close": 3.5, "volume": 140},
    ]


def test_na_is_callable_for_scalars_and_series() -> None:
    series = PyneSeries(np.array([np.nan, 1.0, np.nan]), name="x")

    assert pn.na is na
    assert na(na) is True
    assert na(float("nan")) is True
    assert na(1.0) is False
    assert np.asarray(na(series)).tolist() == [True, False, True]


def test_nz_replaces_series_and_scalar_missing_values() -> None:
    result = pn.run(
        """
plot(close[1], "Previous")
plot(nz(close[1], 0), "Previous Filled")
plot(where(na(close[1]), close, na), "First Only")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    assert result.values("Previous") == [1.5, 2.5]
    assert result.values("Previous Filled") == [0.0, 1.5, 2.5]
    assert result.values("First Only") == [1.5]


def test_fixnan_carries_forward_previous_non_missing_values() -> None:
    result = pn.run(
        """
source = where(bar_index == 0, na, where(bar_index == 2, na, close))
plot(fixnan(source), "Fixed")
plot(nz(fixnan(na), 7), "Scalar Missing")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    assert result.values("Fixed") == [2.5, 2.5]
    assert result.values("Scalar Missing") == [7.0, 7.0, 7.0]


def test_na_conditions_do_not_emit_markers_or_signals() -> None:
    result = pn.run(
        """
marker(na, text="Missing")
marker(na(close[1]), text="First")
emit_signal(na, name="missing")
emit_signal(na(close[1]), name="first", price=close)
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    assert len(result.output["markers"]) == 1
    assert result.output["markers"][0]["text"] == "First"
    assert result.output["markers"][0]["data"][0]["time"] == 1
    assert len(result.output["signals"]) == 1
    assert result.output["signals"][0]["name"] == "first"
    assert result.output["signals"][0]["data"][0]["price"] == 1.5


def test_plot_na_scalar_is_a_noop() -> None:
    result = pn.run(
        """
plot(na, "Missing")
plot(nz(na, 5), "Filled")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    assert result.values("Missing") == []
    assert result.values("Filled") == [5.0, 5.0, 5.0]
