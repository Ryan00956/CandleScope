from __future__ import annotations

import pyne_runtime as pn


def _bars() -> list[dict[str, float]]:
    return [
        {"time": 1, "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": 100},
        {"time": 2, "open": 2, "high": 3, "low": 1, "close": 2.5, "volume": 120},
        {"time": 3, "open": 3, "high": 4, "low": 2, "close": 3.5, "volume": 140},
    ]


def test_color_rgb_new_and_channel_accessors() -> None:
    result = pn.run(
        """
solid = color.rgb(255, 128, 0)
transparent = color.rgb(255, 128, 0, 75)
blue = color.new("#2196f3", 80)

label(solid)
label(transparent)
label(blue)
plot(color.r(solid), "R")
plot(color.g(solid), "G")
plot(color.b(solid), "B")
plot(color.t(transparent), "T")
plot(color.t(blue), "Blue T")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert [item["text"] for item in result.output["labels"]] == [
        "#ff8000",
        "rgba(255,128,0,0.25)",
        "rgba(33,150,243,0.2)",
    ]
    assert result.values("R") == [255.0, 255.0, 255.0]
    assert result.values("G") == [128.0, 128.0, 128.0]
    assert result.values("B") == [0.0, 0.0, 0.0]
    assert result.values("T") == [75.0, 75.0, 75.0]
    assert result.values("Blue T") == [80.0, 80.0, 80.0]


def test_color_helpers_support_series_values() -> None:
    result = pn.run(
        """
alpha = when(close > open, 0, 80)
series_color = color.rgb(10, 20, 30, alpha)
barcolor(series_color)
plot(close, "Close", color=series_color)
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert result.output["barcolors"][0]["data"] == [
        {"time": 1, "color": "#0a141e"},
        {"time": 2, "color": "#0a141e"},
        {"time": 3, "color": "#0a141e"},
    ]
    assert result.output["lines"][0]["per_bar_color"]


def test_color_channel_accessors_support_series_colors() -> None:
    result = pn.run(
        """
alpha = when(close > 2, 80, 0)
series_color = color.rgb(10, 20, 30, alpha)
plot(color.r(series_color), "Series R")
plot(color.g(series_color), "Series G")
plot(color.b(series_color), "Series B")
plot(color.t(series_color), "Series T")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert result.values("Series R") == [10.0, 10.0, 10.0]
    assert result.values("Series G") == [20.0, 20.0, 20.0]
    assert result.values("Series B") == [30.0, 30.0, 30.0]
    assert result.values("Series T") == [0.0, 80.0, 80.0]


def test_color_from_gradient_supports_scalar_and_series() -> None:
    result = pn.run(
        """
scalar = color.from_gradient(50, 0, 100, color.red, color.green)
series_colors = color.from_gradient(close, 1.5, 3.5, "#000000", "#ffffff")

label(scalar)
barcolor(series_colors)
plot(color.r(scalar), "Scalar R")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert result.output["labels"][0]["text"] == "#8a7c74"
    assert result.output["barcolors"][0]["data"] == [
        {"time": 1, "color": "#000000"},
        {"time": 2, "color": "#7f7f7f"},
        {"time": 3, "color": "#fefefe"},
    ]
    assert result.values("Scalar R") == [138.0, 138.0, 138.0]
