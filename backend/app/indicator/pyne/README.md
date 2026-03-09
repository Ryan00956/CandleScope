# Pyne — Pine-style Python Library

**Pyne** brings the simplicity of TradingView's Pine Script to Python. Write indicators using familiar `ta.*`, `input.*`, `plot()` APIs while retaining full Python power.

## Quick Start

```python
# No imports needed — everything is pre-injected
length = input.int(20, "Period", minval=1)
src    = input.source(close, "Source")

sma_line = ta.sma(src, length)
ema_line = ta.ema(src, length)

plot(sma_line, title="SMA", color=color.orange)
plot(ema_line, title="EMA", color=color.blue)
```

## Architecture

```
pyne/
├── __init__.py      — Package entry, exports PyneRuntime
├── runtime.py       — Script execution engine
├── context.py       — OHLCV data context (open/high/low/close/volume/hl2/hlc3/...)
├── ta.py            — ta.* technical analysis (sma, ema, rsi, macd, bb, atr, stoch, ...)
├── input.py         — input.* parameter declaration (int, float, bool, source, color, ...)
├── plot.py          — plot(), hline(), fill(), marker(), bgcolor(), barcolor()
├── color.py         — color.* constants and color.new() helper
├── math_ext.py      — Array-aware math.* (abs, log, sqrt, max, min, ...)
└── utils.py         — na, nz, shift, crossover, highest, lowest, change, ...
```

## Available APIs

### Global Variables (OHLCV)

| Variable | Description |
|----------|-------------|
| `open` | Open prices (numpy array) |
| `high` | High prices |
| `low` | Low prices |
| `close` | Close prices |
| `volume` | Volume |
| `time` | Timestamps (list of int) |
| `hl2` | (high + low) / 2 |
| `hlc3` | (high + low + close) / 3 |
| `ohlc4` | (open + high + low + close) / 4 |
| `hlcc4` | (high + low + close + close) / 4 |
| `bar_count` | Number of bars |

### `ta.*` — Technical Analysis

#### Moving Averages
```python
ta.sma(src, period)       # Simple Moving Average
ta.ema(src, period)       # Exponential Moving Average
ta.wma(src, period)       # Weighted Moving Average
ta.rma(src, period)       # Wilder's Moving Average (used by RSI/ATR)
ta.vwma(src, period)      # Volume-Weighted Moving Average
```

#### Oscillators
```python
ta.rsi(src, period)                        # RSI
k, d = ta.stoch(close, high, low, 14)     # Stochastic
ta.cci(high, low, close, 20)              # CCI
ta.mfi(14)                                 # Money Flow Index
```

#### Trend
```python
dif, dea, hist = ta.macd(src, 12, 26, 9)  # MACD
ta.adx(high, low, close, 14)              # ADX
st, dir = ta.supertrend(10, 3.0)          # Supertrend
```

#### Volatility
```python
ta.tr()                                    # True Range
ta.atr(14)                                 # Average True Range
upper, mid, lower = ta.bb(src, 20, 2)     # Bollinger Bands
ta.stdev(src, period)                      # Standard Deviation
upper, mid, lower = ta.keltner(20, 1.5)   # Keltner Channel
upper, mid, lower = ta.donchian(20)       # Donchian Channel
```

#### Volume
```python
ta.obv()                    # On-Balance Volume
ta.volume_sma(volume, 20)   # Volume SMA
```

#### Utility (also available as globals)
```python
ta.crossover(a, b)          # Bullish cross
ta.crossunder(a, b)         # Bearish cross
ta.highest(src, period)     # Rolling max
ta.lowest(src, period)      # Rolling min
ta.change(src, period)      # Price difference
ta.roc(src, period)         # Rate of change (%)
ta.barssince(condition)     # Bars since condition was true
ta.valuewhen(cond, src, n)  # Value when condition was true
ta.pivothigh(src, l, r)     # Pivot high detection
ta.pivotlow(src, l, r)      # Pivot low detection
ta.cum(src)                 # Cumulative sum
ta.rising(src, n)           # Rising for n bars
ta.falling(src, n)          # Falling for n bars
```

### `input.*` — Parameters

```python
length = input.int(20, "Period", minval=1, maxval=500)
mult   = input.float(2.0, "Multiplier", step=0.1)
show   = input.bool(True, "Show Line")
src    = input.source(close, "Source")
col    = input.color("#f59e0b", "Color")
type_  = input.string("SMA", "Type", options=["SMA", "EMA", "WMA"])
```

### Drawing Functions

```python
# Plot a line
p1 = plot(data, title="MA", color="#f59e0b", linewidth=2)

# Histogram
bar(data, title="MACD Hist", color_up="#26a69a", color_down="#ef5350")

# Horizontal line
hline(70, "Overbought", color="#ef4444", linestyle="dashed")

# Fill between two plots
p1 = plot(upper, "Upper", color="#ef4444")
p2 = plot(lower, "Lower", color="#22c55e")
fill(p1, p2, color="rgba(59,130,246,0.1)")

# Markers at specific bars
marker(crossover(fast, slow), shape="triangle_up", color="#26a69a", text="Buy")

# Background coloring
bgcolor(ta.rsi(close, 14) > 70, color="rgba(239,68,68,0.1)")

# Candlestick coloring
barcolor(np.where(close > open, color.green, color.red))
```

### `color.*` — Colors

```python
color.red        # "#ef4444"
color.green      # "#22c55e"
color.blue       # "#3b82f6"
color.orange     # "#f59e0b"
color.purple     # "#a855f7"
color.yellow     # "#eab308"
color.white      # "#ffffff"
color.black      # "#000000"
color.gray       # "#787b86"

color.new("#ef4444", 80)   # Add transparency (0=opaque, 100=invisible)
```

### `math.*` — Math Functions

```python
math.abs(x)     math.log(x)      math.sqrt(x)
math.exp(x)     math.pow(b, e)   math.ceil(x)
math.floor(x)   math.round(x)    math.max(a, b)
math.min(a, b)  math.sign(x)     math.avg(a, b, c)
math.sin(x)     math.cos(x)      math.pi
```

## Examples

### Bollinger Bands with RSI Coloring

```python
indicator("BB + RSI Color", overlay=True)

length = input.int(20, "BB Period")
mult   = input.float(2.0, "Multiplier")

upper, mid, lower = ta.bb(close, length, mult)
rsi = ta.rsi(close, 14)

# Color based on RSI
col = np.where(rsi > 70, color.red, np.where(rsi < 30, color.green, color.blue))

p1 = plot(upper, "Upper", color=color.red)
plot(mid, "Mid", color=color.orange)
p2 = plot(lower, "Lower", color=color.green)
fill(p1, p2, color="rgba(59,130,246,0.05)")
```

### MACD with Crossover Markers

```python
indicator("MACD Signals", overlay=False)

dif, dea, hist = ta.macd(close, 12, 26, 9)

plot(dif, "DIF", color=color.blue)
plot(dea, "DEA", color=color.orange)
bar(hist, "Histogram")

hline(0, color=color.gray)

marker(crossover(dif, dea), shape="triangle_up", color=color.green, text="Bull")
marker(crossunder(dif, dea), shape="triangle_down", color=color.red, text="Bear")
```

### Multi-MA Strategy

```python
indicator("MA Cross", overlay=True)

fast_len = input.int(10, "Fast Period")
slow_len = input.int(30, "Slow Period")
ma_type  = input.string("EMA", "MA Type", options=["SMA", "EMA", "WMA"])

if ma_type == "SMA":
    fast = ta.sma(close, fast_len)
    slow = ta.sma(close, slow_len)
elif ma_type == "EMA":
    fast = ta.ema(close, fast_len)
    slow = ta.ema(close, slow_len)
else:
    fast = ta.wma(close, fast_len)
    slow = ta.wma(close, slow_len)

plot(fast, f"Fast {ma_type}", color=color.green)
plot(slow, f"Slow {ma_type}", color=color.red)

marker(crossover(fast, slow), shape="triangle_up", color=color.green, text="Buy")
marker(crossunder(fast, slow), shape="triangle_down", color=color.red, text="Sell")
```

## Backward Compatibility

Legacy scripts using `add_line()` and `params.get()` continue to work unchanged. The Pyne runtime injects `add_line` as an alias for `plot()`, and `params` remains available as a plain dict.
