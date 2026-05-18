from __future__ import annotations

import math

import pyne_runtime as pn


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


def test_macd_and_bollinger_outputs_are_structured() -> None:
    result = pn.run(
        """
dif, dea, hist = ta.macd(close, 12, 26, 9)
upper, mid, lower = ta.bb(close, 20, 2)
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
