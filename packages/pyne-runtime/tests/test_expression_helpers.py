from __future__ import annotations

import pyne_runtime as pn


def _bars() -> list[dict[str, float]]:
    return [
        {"time": 1, "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": 100},
        {"time": 2, "open": 3, "high": 4, "low": 2, "close": 2.5, "volume": 120},
        {"time": 3, "open": 3, "high": 5, "low": 2.5, "close": 4.5, "volume": 140},
        {"time": 4, "open": 5, "high": 6, "low": 4, "close": 4.0, "volume": 160},
    ]


def test_when_and_iff_are_series_aware() -> None:
    result = pn.run(
        """
body = when(close > open, close - open, open - close)
legacy = iff(close > open, close, na)
plot(body, "Body")
plot(legacy, "Legacy")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    assert result.values("Body") == [0.5, 0.5, 1.5, 1.0]
    assert result.values("Legacy") == [1.5, 4.5]


def test_switch_selects_first_true_case_per_bar() -> None:
    result = pn.run(
        """
value = switch(
    (close > high[1], 2),
    (close > open, 1),
    default=0,
)
plot(value, "Switch")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    assert result.values("Switch") == [1.0, 2.0, 2.0, 0.0]


def test_switch_accepts_series_values() -> None:
    result = pn.run(
        """
value = switch(
    (barstate.isfirst, close),
    (close > open, high),
    default=low,
)
plot(value, "Switch Series")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    assert result.values("Switch Series") == [1.5, 2.0, 5.0, 4.0]


def test_series_python_bool_error_is_actionable() -> None:
    result = pn.run(
        """
if close > open:
    plot(close, "Close")
""",
        _bars(),
        executor_mode="inline",
    )

    assert not result.ok
    assert result.code == "PYNE_RUNTIME_ERROR"
    assert "when()" in (result.error or "")
    assert "switch()" in (result.error or "")
