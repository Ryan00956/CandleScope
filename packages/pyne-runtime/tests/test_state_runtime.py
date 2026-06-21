from __future__ import annotations

import math

import pyne_runtime as pn


def _bars() -> list[dict[str, float]]:
    return [
        {"time": 1, "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": 100},
        {"time": 2, "open": 2, "high": 3, "low": 1.5, "close": 2.5, "volume": 120},
        {"time": 3, "open": 3, "high": 4, "low": 2.5, "close": 3.5, "volume": 140},
        {"time": 4, "open": 4, "high": 5, "low": 3.5, "close": 4.5, "volume": 160},
    ]


def test_var_cell_initializes_once_per_script_execution() -> None:
    result = pn.run(
        """
cell = var("counter", 0)
plot(cell.get(), "Before")
cell.set(cell.get() + 1)
plot(cell.get(), "After")
same = var("counter", 99)
plot(same.get(), "Same Cell")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    assert result.values("Before") == [0.0, 0.0, 0.0, 0.0]
    assert result.values("After") == [1.0, 1.0, 1.0, 1.0]
    assert result.values("Same Cell") == [1.0, 1.0, 1.0, 1.0]


def test_var_state_is_isolated_between_runs() -> None:
    script = """
counter = pyne.var("counter", 0)
counter.set(counter.get() + 1)
plot(counter.get(), "Counter")
"""

    first = pn.run(script, _bars(), executor_mode="inline")
    second = pn.run(script, _bars(), executor_mode="inline")

    assert first.ok
    assert second.ok
    assert first.values("Counter") == [1.0, 1.0, 1.0, 1.0]
    assert second.values("Counter") == [1.0, 1.0, 1.0, 1.0]


def test_set_each_carries_prior_state_through_na_updates() -> None:
    result = pn.run(
        """
trend = pyne.var("trend", 0)
updates = where(bar_index == 0, 1, where(bar_index == 2, -1, na))
plot(trend.set_each(updates), "Trend")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    assert result.values("Trend") == [1.0, 1.0, -1.0, -1.0]


def test_var_cell_can_be_plotted_directly() -> None:
    result = pn.run(
        """
trend = state("trend", 0)
trend.set_each(where(close > close[1], 1, na))
plot(trend, "Trend")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    assert result.values("Trend") == [0.0, 1.0, 1.0, 1.0]


def test_var_reset_normalizes_na_like_set() -> None:
    cell = pn.PyneVar("cell", pn.na)

    assert math.isnan(cell.reset())


def test_var_private_state_is_not_a_constructor_argument() -> None:
    try:
        pn.PyneVar("cell", 0, _value=5)
    except TypeError:
        return
    raise AssertionError("PyneVar should not expose private state constructor args")
