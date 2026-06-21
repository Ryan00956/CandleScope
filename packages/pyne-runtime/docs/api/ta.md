# `ta` API

The `ta` namespace is injected into scripts.

Common helpers:

```python
ta.sma(close, 20)
ta.ema(close, 20)
ta.wma(close, 20)
ta.vwma(close, 20)
ta.hma(close, 20)
ta.swma(close)
ta.alma(close, 20, 0.85, 6)
ta.rsi(close, 14)
ta.cmo(close, 14)
ta.wpr(14)
ta.tsi(close, 25, 13)
ta.macd(close, 12, 26, 9)
ta.mom(close, 10)
ta.linreg(close, 20, 0)
ta.correlation(close, open, 20)
ta.stoch(close, high, low, 14)
ta.cci(close, 20)
ta.mfi(close, 14)
ta.dmi(14, 14)
ta.sar(0.02, 0.02, 0.2)
ta.supertrend(3, 10)
ta.bb(close, 20, 2)
ta.dev(close, 20)
ta.variance(close, 20)
ta.percentile_nearest_rank(close, 20, 50)
ta.percentile_linear_interpolation(close, 20, 50)
ta.atr(14)
ta.highest(close, 20)
ta.lowest(close, 20)
ta.highestbars(close, 20)
ta.lowestbars(close, 20)
ta.barssince(close > open)
ta.valuewhen(close > open, close, 0)
ta.cross(a, b)
ta.crossover(a, b)
ta.crossunder(a, b)
```

Several helpers are also exposed as top-level script functions, such as `cross()`, `crossover()`, `crossunder()`, `highest()`, and `lowest()`.

`ta.bb(source, length, mult)` follows Pine's tuple order:
`middle, upper, lower = ta.bb(close, 20, 2)`.

Several context-aware helpers also follow Pine's argument order:
`ta.stoch(source, high, low, length)`, `ta.cci(source, length)`,
`ta.mfi(source, length)`, and `ta.supertrend(factor, atrPeriod)`.

`ta.highestbars(source, length)` and `ta.lowestbars(source, length)` return the
number of bars back to the most recent highest or lowest value in the rolling
window. A return value of `0` means the current bar is the extreme.

`ta.barssince(condition)` returns the number of bars since the condition was
last true. `ta.valuewhen(condition, source, occurrence)` returns the source
value from the most recent matching condition, or an older match when
`occurrence` is greater than zero.

TA helpers are series-aware, so history references compose naturally:

```python
plot(ta.mom(close[1], 10), "Shifted Momentum")
marker(ta.cross(close, ta.sma(close, 20)), text="Cross")
```

## Golden Coverage

The TA golden suite includes deterministic fixtures for core moving averages,
Wilder smoothing, RSI, rolling extremes, bars-back extreme offsets,
`barssince()`, `valuewhen()`, MACD, Bollinger Bands, ATR, ALMA, DMI, and
Parabolic SAR, HMA, SWMA, CMO, Williams %R, TSI, rolling percentiles, mean
absolute deviation, variance, stochastic, CCI, MFI, VWMA, and Supertrend.

`ta.macd()` follows Pine's tuple shape: MACD line, signal line, and histogram,
where histogram is `macd_line - signal_line`. The signal line starts after the
first complete non-`na` MACD-line window.

The current fixture keeps a `pine_equivalent` script alongside the Pyne script
so future TradingView-exported outputs can replace or extend the expected
series without changing the test harness.

