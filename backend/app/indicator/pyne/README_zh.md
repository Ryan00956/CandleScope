# Pyne — Pine风格的Python库

**Pyne** 将 TradingView的 Pine Script 的简单性带到了 Python 中。使用熟悉的 `ta.*`、`input.*`、`plot()` API 编写指标，同时保留 Python 的全部功能。

## 快速开始

```python
# 无需导入 — 所有内容均已预先注入
length = input.int(20, "Period", minval=1)
src    = input.source(close, "Source")

sma_line = ta.sma(src, length)
ema_line = ta.ema(src, length)

plot(sma_line, title="SMA", color=color.orange)
plot(ema_line, title="EMA", color=color.blue)
```

## 架构概览

```
pyne/
├── __init__.py      — 包入口，导出 PyneRuntime
├── runtime.py       — 脚本执行引擎
├── context.py       — OHLCV 数据上下文 (open/high/low/close/volume/hl2/hlc3/...)
├── ta.py            — ta.* 技术分析指标 (sma, ema, rsi, macd, bb, atr, stoch, ...)
├── input.py         — input.* 参数声明 (int, float, bool, source, color, ...)
├── plot.py          — 绘图函数 plot(), hline(), fill(), marker(), bgcolor(), barcolor()
├── color.py         — color.* 颜色常量与 color.new() 辅助函数
├── math_ext.py      — 支持数组的 math.* 扩展 (abs, log, sqrt, max, min, ...)
└── utils.py         — 实用工具函数 na, nz, shift, crossover, highest, lowest, change, ...
```

## 可用 API

### 全局变量 (OHLCV)

| 变量 | 描述 |
|----------|-------------|
| `open` | 开盘价 (numpy 数组) |
| `high` | 最高价 |
| `low` | 最低价 |
| `close` | 收盘价 |
| `volume` | 成交量 |
| `time` | 时间戳 (整数列表) |
| `hl2` | (high + low) / 2 |
| `hlc3` | (high + low + close) / 3 |
| `ohlc4` | (open + high + low + close) / 4 |
| `hlcc4` | (high + low + close + close) / 4 |
| `bar_count` | K线数量 (Bars count) |

### `ta.*` — 技术分析 (Technical Analysis)

#### 移动平均线 (Moving Averages)
```python
ta.sma(src, period)       # 简单移动平均线 (Simple Moving Average)
ta.ema(src, period)       # 指数移动平均线 (Exponential Moving Average)
ta.wma(src, period)       # 加权移动平均线 (Weighted Moving Average)
ta.rma(src, period)       # 威尔德移动平均线 (Wilder's Moving Average，RSI/ATR使用)
ta.vwma(src, period)      # 成交量加权移动平均线 (Volume-Weighted Moving Average)
```

#### 振荡器 (Oscillators)
```python
ta.rsi(src, period)                        # 相对强弱指数 (RSI)
k, d = ta.stoch(close, high, low, 14)      # 随机指标 (KD / Stochastic)
ta.cci(high, low, close, 20)               # 顺势指标 (CCI)
ta.mfi(14)                                 # 资金流量指标 (Money Flow Index)
```

#### 趋势 (Trend)
```python
dif, dea, hist = ta.macd(src, 12, 26, 9)   # 指数平滑移动平均线 (MACD)
ta.adx(high, low, close, 14)               # 平均趋向指数 (ADX)
st, dir = ta.supertrend(10, 3.0)           # 超级趋势 (Supertrend)
```

#### 波动率 (Volatility)
```python
ta.tr()                                    # 真实波动幅度 (True Range)
ta.atr(14)                                 # 平均真实波动幅度 (Average True Range)
upper, mid, lower = ta.bb(src, 20, 2)      # 布林带 (Bollinger Bands)
ta.stdev(src, period)                      # 标准差 (Standard Deviation)
upper, mid, lower = ta.keltner(20, 1.5)    # 肯特纳通道 (Keltner Channel)
upper, mid, lower = ta.donchian(20)        # 唐奇安通道 (Donchian Channel)
```

#### 成交量 (Volume)
```python
ta.obv()                    # 能量潮指标 (On-Balance Volume)
ta.volume_sma(volume, 20)   # 成交量简单移动平均线 (Volume SMA)
```

#### 实用工具 (Utility, 亦可作为全局函数使用)
```python
ta.crossover(a, b)          # 金叉 (看涨交叉 / Bullish cross)
ta.crossunder(a, b)         # 死叉 (看跌交叉 / Bearish cross)
ta.highest(src, period)     # 滚动最大值 (Rolling max)
ta.lowest(src, period)      # 滚动最小值 (Rolling min)
ta.change(src, period)      # 价格差值 (Price difference)
ta.roc(src, period)         # 变动率 (Rate of change %)
ta.barssince(condition)     # 距离条件成立时的K线数 (Bars since condition was true)
ta.valuewhen(cond, src, n)  # 条件成立时的值 (Value when condition was true)
ta.pivothigh(src, l, r)     # 高枢轴点检测 (Pivot high detection)
ta.pivotlow(src, l, r)      # 低枢轴点检测 (Pivot low detection)
ta.cum(src)                 # 累积求和 (Cumulative sum)
ta.rising(src, n)           # 连续 n 根K线上涨 (Rising for n bars)
ta.falling(src, n)          # 连续 n 根K线下跌 (Falling for n bars)
```

### `input.*` — 参数输入 (Parameters)

```python
length = input.int(20, "Period", minval=1, maxval=500)
mult   = input.float(2.0, "Multiplier", step=0.1)
show   = input.bool(True, "Show Line")
src    = input.source(close, "Source")
col    = input.color("#f59e0b", "Color")
type_  = input.string("SMA", "Type", options=["SMA", "EMA", "WMA"])
```

### 绘图函数 (Drawing Functions)

```python
# 绘制线条 (Plot a line)
p1 = plot(data, title="MA", color="#f59e0b", linewidth=2)

# 柱状图 (Histogram)
bar(data, title="MACD Hist", color_up="#26a69a", color_down="#ef5350")

# 水平线 (Horizontal line)
hline(70, "Overbought", color="#ef4444", linestyle="dashed")

# 在两根折线之间填充颜色 (Fill between two plots)
p1 = plot(upper, "Upper", color="#ef4444")
p2 = plot(lower, "Lower", color="#22c55e")
fill(p1, p2, color="rgba(59,130,246,0.1)")

# 在特定K线上添加标记 (Markers at specific bars)
marker(crossover(fast, slow), shape="triangle_up", color="#26a69a", text="Buy")

# 图表背景着色 (Background coloring)
bgcolor(ta.rsi(close, 14) > 70, color="rgba(239,68,68,0.1)")

# K线主体着色 (Candlestick coloring)
barcolor(np.where(close > open, color.green, color.red))
```

### `color.*` — 颜色 (Colors)

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

color.new("#ef4444", 80)   # 添加透明度 (0=完全不透明, 100=完全透明/不可见)
```

### `math.*` — 数学函数 (Math Functions)

```python
math.abs(x)     math.log(x)      math.sqrt(x)
math.exp(x)     math.pow(b, e)   math.ceil(x)
math.floor(x)   math.round(x)    math.max(a, b)
math.min(a, b)  math.sign(x)     math.avg(a, b, c)
math.sin(x)     math.cos(x)      math.pi
```

## 示例 (Examples)

### 配合 RSI 着色的布林带 (Bollinger Bands with RSI Coloring)

```python
indicator("BB + RSI Color", overlay=True)

length = input.int(20, "BB Period")
mult   = input.float(2.0, "Multiplier")

upper, mid, lower = ta.bb(close, length, mult)
rsi = ta.rsi(close, 14)

# 根据 RSI 值进行着色
col = np.where(rsi > 70, color.red, np.where(rsi < 30, color.green, color.blue))

p1 = plot(upper, "Upper", color=color.red)
plot(mid, "Mid", color=color.orange)
p2 = plot(lower, "Lower", color=color.green)
fill(p1, p2, color="rgba(59,130,246,0.05)")
```

### 带有交叉标记的 MACD (MACD with Crossover Markers)

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

### 多均线策略 (Multi-MA Strategy)

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

## 向后兼容性 (Backward Compatibility)

使用 `add_line()` 和 `params.get()` 的旧版脚本可以继续运行而无需任何更改。Pyne 运行时环境已将 `add_line` 注入为 `plot()` 的别名，并且 `params` 仍然可以作为普通的字典(dict)进行访问。
