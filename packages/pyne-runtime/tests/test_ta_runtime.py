from __future__ import annotations

import math

import pyne_runtime as pn
import pyne_runtime.utils as utils
from pyne_runtime.ta import TaModule


def _bars(count: int = 40) -> list[dict[str, float]]:
    bars = []
    for idx in range(count):
        close = 100.0 + idx
        bars.append({
            "time": idx + 1,
            "open": close - 0.5,
            "high": close + 1.0,
            "low": close - 1.0,
            "close": close,
            "volume": 1000.0 + idx * 10,
        })
    return bars


def _series_values(result: pn.PyneResult, name: str) -> list[float]:
    for line in result.lines:
        if line["name"] == name:
            return [point["value"] for point in line["data"]]
    raise AssertionError(f"missing series {name}")


def test_moving_average_helpers_run_through_namespace() -> None:
    result = pn.run(
        """
plot(ta.sma(close, 3), "SMA")
plot(ta.ema(close, 3), "EMA")
plot(ta.wma(close, 3), "WMA")
plot(ta.rma(close, 3), "RMA")
""",
        _bars(),
        executor_mode="inline",
    )

    assert result.ok
    assert len(result.lines) == 4
    assert _series_values(result, "SMA")[-1] == 138.0
    assert _series_values(result, "WMA")[-1] > _series_values(result, "SMA")[-1]


def test_sma_returns_nan_for_windows_containing_nan() -> None:
    source = pn.PyneSeries([1.0, float("nan"), 3.0, 4.0], name="close")

    result = TaModule().sma(source, 2)

    assert isinstance(result, pn.PyneSeries)
    assert math.isnan(result.values[0])
    assert math.isnan(result.values[1])
    assert math.isnan(result.values[2])
    assert result.values[3] == 3.5


def test_highest_lowest_ignore_invalid_period_without_empty_window_error() -> None:
    source = pn.PyneSeries([1.0, 2.0, 3.0], name="close")

    highest = utils.highest(source, 0)
    lowest = utils.lowest(source, 0)

    assert isinstance(highest, pn.PyneSeries)
    assert isinstance(lowest, pn.PyneSeries)
    assert all(math.isnan(value) for value in highest.values)
    assert all(math.isnan(value) for value in lowest.values)


def test_highest_lowest_use_available_warmup_history() -> None:
    source = pn.PyneSeries([3.0, 1.0, 5.0, 2.0], name="close")

    highest = utils.highest(source, 3)
    lowest = utils.lowest(source, 3)

    assert isinstance(highest, pn.PyneSeries)
    assert isinstance(lowest, pn.PyneSeries)
    assert list(highest.values) == [3.0, 3.0, 5.0, 5.0]
    assert list(lowest.values) == [3.0, 1.0, 1.0, 1.0]


def test_macd_and_bollinger_outputs_are_structured() -> None:
    result = pn.run(
        """
dif, dea, hist = ta.macd(close, 12, 26, 9)
mid, upper, lower = ta.bb(close, 20, 2)
plot(dif, "DIF")
plot(dea, "DEA")
bar(hist, "HIST")
plot(upper, "Upper")
plot(mid, "Middle")
plot(lower, "Lower")
""",
        _bars(80),
        executor_mode="inline",
    )

    assert result.ok
    assert {line["name"] for line in result.lines} >= {"DIF", "DEA", "HIST", "Upper", "Middle", "Lower"}
    assert result.output["histograms"][0]["title"] == "HIST"
    assert _series_values(result, "DEA")
    assert _series_values(result, "HIST")


def test_rsi_atr_and_crossover_helpers_emit_markers() -> None:
    result = pn.run(
        """
r = ta.rsi(close, 14)
a = ta.atr(14)
plot(r, "RSI")
plot(a, "ATR")
marker(close > open, text="Up")
""",
        _bars(50),
        executor_mode="inline",
    )

    assert result.ok
    rsi_values = _series_values(result, "RSI")
    atr_values = _series_values(result, "ATR")
    assert rsi_values
    assert atr_values
    assert all(math.isfinite(value) for value in rsi_values[-5:])
    assert "markers" in result.output


def test_expanded_ta_helpers_are_series_aware() -> None:
    result = pn.run(
        """
plot(ta.mom(close, 2), "MOM")
plot(ta.dev(close, 3), "DEV")
plot(ta.variance(close, 3), "VAR")
plot(ta.linreg(close, 3), "LINREG")
plot(ta.hma(close, 4), "HMA")
marker(ta.cross(close, ta.sma(close, 3)), text="Cross")
plot(ta.mom(close[1], 2), "Shifted MOM")
""",
        _bars(12),
        executor_mode="inline",
    )

    assert result.ok
    assert _series_values(result, "MOM")[-1] == 2.0
    assert math.isclose(_series_values(result, "DEV")[-1], 2.0 / 3.0, abs_tol=1e-8)
    assert math.isclose(_series_values(result, "VAR")[-1], 2.0 / 3.0, abs_tol=1e-8)
    assert _series_values(result, "LINREG")[-1] == 111.0
    assert _series_values(result, "HMA")
    assert _series_values(result, "Shifted MOM")[-1] == 2.0


def test_second_batch_ta_helpers_are_series_aware() -> None:
    result = pn.run(
        """
plot(ta.swma(close), "SWMA")
plot(ta.alma(close, 5, 0.85, 6), "ALMA")
plot(ta.percentile_nearest_rank(close, 5, 50), "PNR")
plot(ta.percentile_linear_interpolation(close, 5, 50), "PLI")
plot(ta.correlation(close, open, 5), "CORR")
plot(ta.alma(close[1], 5, 0.85, 6), "Shifted ALMA")
""",
        _bars(12),
        executor_mode="inline",
    )

    assert result.ok
    assert _series_values(result, "SWMA")[-1] == 109.5
    assert _series_values(result, "ALMA")
    assert _series_values(result, "PNR")[-1] == 109.0
    assert _series_values(result, "PLI")[-1] == 109.0
    assert math.isclose(_series_values(result, "CORR")[-1], 1.0, abs_tol=1e-8)
    assert _series_values(result, "Shifted ALMA")


def test_third_batch_ta_helpers_are_series_aware() -> None:
    result = pn.run(
        """
plus_di, minus_di, adx = ta.dmi(5, 5)
plot(ta.cmo(close, 5), "CMO")
plot(ta.wpr(5), "WPR")
plot(ta.tsi(close, 5, 3), "TSI")
plot(plus_di, "Plus DI")
plot(minus_di, "Minus DI")
plot(adx, "ADX")
plot(ta.sar(0.02, 0.02, 0.2), "SAR")
plot(ta.cmo(close[1], 5), "Shifted CMO")
""",
        _bars(30),
        executor_mode="inline",
    )

    assert result.ok
    assert _series_values(result, "CMO")[-1] == 100.0
    assert math.isclose(_series_values(result, "WPR")[-1], -100.0 / 6.0, abs_tol=1e-8)
    assert _series_values(result, "TSI")[-1] > 0.99
    assert _series_values(result, "Plus DI")[-1] > 0.0
    assert _series_values(result, "Minus DI")[-1] == 0.0
    assert _series_values(result, "ADX")[-1] > 0.0
    assert _series_values(result, "SAR")
    assert _series_values(result, "Shifted CMO")[-1] == 100.0


def test_range_oscillators_use_available_warmup_history() -> None:
    bars = [
        {"time": 1, "open": 10, "high": 12, "low": 9, "close": 11, "volume": 100},
        {"time": 2, "open": 11, "high": 13, "low": 10, "close": 12, "volume": 110},
        {"time": 3, "open": 12, "high": 14, "low": 11, "close": 13, "volume": 120},
        {"time": 4, "open": 13, "high": 13.5, "low": 10, "close": 10.5, "volume": 130},
    ]
    result = pn.run(
        """
plot(ta.stoch(close, high, low, 4), "Stoch")
plot(ta.wpr(4), "WPR")
plot(ta.mfi(close, 4), "MFI")
""",
        bars,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert _series_values(result, "Stoch") == [66.66666667, 75.0, 80.0, 30.0]
    assert _series_values(result, "WPR") == [-33.33333333, -25.0, -20.0, -70.0]
    assert _series_values(result, "MFI") == [100.0, 100.0, 100.0, 67.84452297]


def test_percentile_linear_interpolation_uses_hazen_interpolation() -> None:
    bars = [
        {"time": 1, "open": 4, "high": 4, "low": 4, "close": 4, "volume": 100},
        {"time": 2, "open": 1, "high": 1, "low": 1, "close": 1, "volume": 100},
        {"time": 3, "open": 2, "high": 2, "low": 2, "close": 2, "volume": 100},
        {"time": 4, "open": 3, "high": 3, "low": 3, "close": 3, "volume": 100},
    ]
    result = pn.run(
        'plot(ta.percentile_linear_interpolation(close, 4, 75), "PLI")',
        bars,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert _series_values(result, "PLI") == [3.5]

    result = pn.run(
        'plot(ta.percentile_linear_interpolation(close, 7, 75), "PLI")',
        [
            {"time": 1, "open": 71099.4, "high": 71099.4, "low": 71099.4, "close": 71099.4, "volume": 100},
            {"time": 2, "open": 71470.1, "high": 71470.1, "low": 71470.1, "close": 71470.1, "volume": 100},
            {"time": 3, "open": 71537.7, "high": 71537.7, "low": 71537.7, "close": 71537.7, "volume": 100},
            {"time": 4, "open": 71548.5, "high": 71548.5, "low": 71548.5, "close": 71548.5, "volume": 100},
            {"time": 5, "open": 71571.0, "high": 71571.0, "low": 71571.0, "close": 71571.0, "volume": 100},
            {"time": 6, "open": 71617.9, "high": 71617.9, "low": 71617.9, "close": 71617.9, "volume": 100},
            {"time": 7, "open": 71698.7, "high": 71698.7, "low": 71698.7, "close": 71698.7, "volume": 100},
        ],
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert _series_values(result, "PLI") == [71606.175]


def test_supertrend_uses_pine_initial_direction_and_first_atr_band() -> None:
    bars = [
        {"time": 1, "open": 8, "high": 10, "low": 6, "close": 8, "volume": 100},
        {"time": 2, "open": 9, "high": 11, "low": 7, "close": 9, "volume": 100},
        {"time": 3, "open": 10, "high": 12, "low": 8, "close": 10, "volume": 100},
        {"time": 4, "open": 11, "high": 13, "low": 9, "close": 11, "volume": 100},
    ]
    result = pn.run(
        """
line, direction = ta.supertrend(2, 3)
plot(line, "Line")
plot(direction, "Direction")
""",
        bars,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert _series_values(result, "Line") == [0.0, 18.0, 18.0]
    assert _series_values(result, "Direction") == [1.0, 1.0, 1.0, 1.0]


def test_sar_uses_close_to_seed_initial_trend() -> None:
    bars = [
        {"time": 1, "open": 8, "high": 10, "low": 5, "close": 8, "volume": 100},
        {"time": 2, "open": 8, "high": 11, "low": 6, "close": 7, "volume": 100},
        {"time": 3, "open": 7, "high": 9, "low": 4, "close": 5, "volume": 100},
    ]
    result = pn.run(
        """
plot(ta.sar(0.02, 0.02, 0.2), "SAR")
""",
        bars,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert result.get_series("SAR")[0] == {"time": 2, "value": 10.0}


def test_state_lookup_ta_helpers_match_pine_like_offsets() -> None:
    bars = [
        {"time": 1, "open": 3, "high": 3, "low": 3, "close": 3, "volume": 100},
        {"time": 2, "open": 1, "high": 1, "low": 1, "close": 1, "volume": 100},
        {"time": 3, "open": 5, "high": 5, "low": 5, "close": 5, "volume": 100},
        {"time": 4, "open": 5, "high": 5, "low": 5, "close": 5, "volume": 100},
        {"time": 5, "open": 2, "high": 2, "low": 2, "close": 2, "volume": 100},
        {"time": 6, "open": 4, "high": 4, "low": 4, "close": 4, "volume": 100},
        {"time": 7, "open": 1, "high": 1, "low": 1, "close": 1, "volume": 100},
    ]
    result = pn.run(
        """
condition = close >= 4
plot(ta.highestbars(close, 3), "Highest Bars")
plot(ta.lowestbars(close, 3), "Lowest Bars")
plot(ta.barssince(condition), "Bars Since")
plot(ta.valuewhen(condition, close, 0), "Last Condition Close")
plot(ta.valuewhen(condition, close, 1), "Previous Condition Close")
plot(highestbars(close, 3), "Top Level Highest Bars")
""",
        bars,
        executor_mode="inline",
    )

    assert result.ok, result.error
    assert _series_values(result, "Highest Bars") == [0.0, -1.0, 0.0, 0.0, -1.0, -2.0, -1.0]
    assert _series_values(result, "Lowest Bars") == [0.0, 0.0, -1.0, -2.0, 0.0, -1.0, 0.0]
    assert _series_values(result, "Bars Since") == [0.0, 0.0, 1.0, 0.0, 1.0]
    assert _series_values(result, "Last Condition Close") == [5.0, 5.0, 5.0, 4.0, 4.0]
    assert _series_values(result, "Previous Condition Close") == [5.0, 5.0, 5.0, 5.0]
    assert _series_values(result, "Top Level Highest Bars") == [0.0, -1.0, 0.0, 0.0, -1.0, -2.0, -1.0]
