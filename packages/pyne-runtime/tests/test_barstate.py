from __future__ import annotations

import pyne_runtime as pn


def _bars() -> list[dict[str, float]]:
    return [
        {"time": 10, "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": 100},
        {"time": 20, "open": 2, "high": 3, "low": 1.5, "close": 2.5, "volume": 120},
        {"time": 30, "open": 3, "high": 4, "low": 2.5, "close": 3.5, "volume": 140},
        {"time": 40, "open": 4, "high": 5, "low": 3.5, "close": 4.5, "volume": 160},
    ]


def test_bar_index_and_last_bar_index_are_series() -> None:
    result = pn.run(
        """
plot(bar_index, "Bar Index")
plot(last_bar_index, "Last Bar Index")
plot(time[1], "Previous Time")
plot(time_close, "Time Close")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    assert result.values("Bar Index") == [0.0, 1.0, 2.0, 3.0]
    assert result.values("Last Bar Index") == [3.0, 3.0, 3.0, 3.0]
    assert result.values("Previous Time") == [10.0, 20.0, 30.0]
    assert result.values("Time Close") == [20.0, 30.0, 40.0, 100.0]


def test_explicit_time_close_is_preserved() -> None:
    bars = [
        {**bar, "time_close": bar["time"] + 5}
        for bar in _bars()
    ]
    result = pn.run(
        """
plot(time_close, "Time Close")
""",
        bars,
        executor_mode="inline",
    )

    assert result.ok
    assert result.values("Time Close") == [15.0, 25.0, 35.0, 45.0]


def test_batch_barstate_flags_emit_expected_markers() -> None:
    result = pn.run(
        """
marker(barstate.isfirst, text="First")
marker(barstate.islast, text="Last")
marker(barstate.isconfirmed, text="Confirmed")
marker(barstate.isrealtime, text="Realtime")
marker(barstate.islastconfirmedhistory, text="Last History")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    marker_data = {
        marker["text"]: [point["time"] for point in marker["data"]]
        for marker in result.output["markers"]
    }

    assert marker_data["First"] == [10]
    assert marker_data["Last"] == [40]
    assert marker_data["Confirmed"] == [10, 20, 30, 40]
    assert marker_data["Last History"] == [40]
    assert "Realtime" not in marker_data


def test_barstate_flags_can_be_combined_with_series_conditions() -> None:
    result = pn.run(
        """
condition = barstate.isconfirmed & (close > close[1])
marker(condition, text="Up")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    assert [point["time"] for point in result.output["markers"][0]["data"]] == [20, 30, 40]
