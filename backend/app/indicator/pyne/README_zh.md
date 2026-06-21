# Pyne Runtime Facade

[English](README.md)

> CandleScope 指标使用的 Pine 风格 Python 脚本运行时。CandleScope 仍通过
> `app.indicator.pyne` 导入它，但实际实现由本仓库内置的
> `packages/pyne-runtime` 包提供。

## Runtime 流程

```text
script + OHLCV + params
        ▼
execute_pyne_script()
        ├── process executor（默认）或 inline executor
        ▼
pyne_runtime.PyneRuntime.execute()
        ├── validate security policy
        ├── build runtime context
        ├── inject namespace
        ├── exec(script)
        ├── collect outputs
        └── enforce output limits
```

## 文件

| 文件 | 职责 |
|---|---|
| [external_runtime.py](external_runtime.py) | CandleScope 配置和 payload 到 `pyne_runtime` 的桥接 |
| [__init__.py](__init__.py) | 公开的 `app.indicator.pyne` facade |
| [executor.py](executor.py) | 由 `pyne_runtime` 支撑的 CandleScope 执行入口 |
| [cache.py](cache.py) | 转发到 `pyne_runtime.pyne_cache` 的 cache facade |
| [security.py](security.py) | 转发到 `pyne_runtime.security` 的 security facade |
| `runtime.py`, `incremental.py`, `context.py`, `ta.py`, `input.py`, `plot.py`, `color.py`, `math_ext.py`, `utils.py` | 转发到对应 `pyne_runtime.*` 模块的兼容 shim |

内置源码路径会自动从 `packages/pyne-runtime/src` 加载。只有临时联调其他
checkout 时才需要设置 `CANDLESCOPE_PYNE_RUNTIME_SRC`。

## 快速开始

```python
indicator("MA Cross", overlay=True)

fast_len = input.int(10, "Fast Period", minval=1)
slow_len = input.int(30, "Slow Period", minval=1)

fast = ta.ema(close, fast_len)
slow = ta.ema(close, slow_len)

plot(fast, "Fast EMA", color=color.blue)
plot(slow, "Slow EMA", color=color.orange)

marker(crossover(fast, slow), shape="triangle_up", color=color.green, text="Buy")
marker(crossunder(fast, slow), shape="triangle_down", color=color.red, text="Sell")
```

safe mode 下不需要 import。runtime 会注入 OHLCV arrays、helpers 和 namespaces。

## 注入数据

| 名称 | 类型 / 含义 |
|---|---|
| `open`, `high`, `low`, `close`, `volume` | NumPy arrays |
| `time` | Unix 秒列表 |
| `bar_count` | bars 数量 |
| `hl2` | `(high + low) / 2` |
| `hlc3` | `(high + low + close) / 3` |
| `ohlc4` | `(open + high + low + close) / 4` |
| `hlcc4` | `(high + low + close + close) / 4` |
| `params` | 原始请求参数 |
| `np`, `numpy` | NumPy namespace |

## `ta.*`

移动平均：

```python
ta.sma(src, period)
ta.ema(src, period)
ta.wma(src, period)
ta.vwma(src, period, volume=None)
ta.rma(src, period)
```

震荡和趋势：

```python
ta.rsi(src, period=14)
k, d = ta.stoch(close, high, low, 14)
ta.cci(high, low, close, 20)
ta.mfi(period=14)
dif, dea, hist = ta.macd(close, 12, 26, 9)
ta.adx(high, low, close, 14)
supertrend, direction = ta.supertrend(10, 3.0)
```

波动率和成交量：

```python
ta.tr()
ta.atr(14)
upper, mid, lower = ta.bb(close, 20, 2)
ta.stdev(close, 20)
upper, mid, lower = ta.keltner(20, 1.5)
upper, mid, lower = ta.donchian(20)
ta.obv()
ta.volume_sma(volume, 20)
```

工具代理：

```python
ta.crossover(a, b)
ta.crossunder(a, b)
ta.highest(src, period)
ta.lowest(src, period)
ta.change(src, period=1)
ta.roc(src, period=1)
ta.barssince(condition)
ta.valuewhen(condition, src, occurrence=0)
ta.pivothigh(src, left, right)
ta.pivotlow(src, left, right)
ta.cum(src)
ta.rising(src, period=1)
ta.falling(src, period=1)
```

大多数 utility 也会作为全局函数注入，因此可以直接写 `crossover(fast, slow)`。

## `input.*`

inputs 返回运行时值，并收集前端 schema：

```python
length = input.int(20, "Period", minval=1, maxval=500)
mult = input.float(2.0, "Multiplier", minval=0.1, step=0.1)
show = input.bool(True, "Show")
src = input.source(close, "Source")
col = input.color("#f59e0b", "Color")
kind = input.string("EMA", "Type", options=["SMA", "EMA", "WMA"])
```

数值输入会按 min/max clamp。

## 绘图和输出

```python
indicator("BB + Signals", overlay=True)

upper, mid, lower = ta.bb(close, 20, 2)
p1 = plot(upper, "Upper", color=color.red)
plot(mid, "Middle", color=color.orange)
p2 = plot(lower, "Lower", color=color.green)
fill(p1, p2, color="rgba(59,130,246,0.08)")

bar(close - open, "Body", color_up=color.green, color_down=color.red)
hline(0, "Zero", color=color.gray, linestyle="dashed")
marker(crossover(close, mid), shape="triangle_up", color=color.green)
bgcolor(close > upper, color="rgba(239,68,68,0.08)")
barcolor(np.where(close >= open, color.green, color.red))
emit_signal(crossover(close, mid), name="cross_up", message="Close crossed middle")
```

支持的输出辅助：

- `indicator()`
- `plot()`
- `bar()`
- `hline()`
- `fill()`
- `bgcolor()`
- `marker()`
- `barcolor()`
- `emit_signal()`
- `alertcondition()`
- `label()`
- 兼容旧脚本的 `add_line()`

序列化响应会通过 `app.indicator.serialization` 返回兼容旧前端的 `lines`，以及标准化的 `series`、`annotations`、`fills`、`paneLayout`。

## 颜色

```python
color.red
color.green
color.blue
color.orange
color.purple
color.yellow
color.white
color.black
color.gray

color.new("#ef4444", 80)  # 0 = 不透明，100 = 不可见
```

## Math 和工具

`math` 支持数组：

```python
math.abs(x)
math.log(x)
math.sqrt(x)
math.exp(x)
math.pow(base, exp)
math.ceil(x)
math.floor(x)
math.round(x)
math.max(a, b)
math.min(a, b)
math.avg(a, b, c)
math.sin(x)
math.cos(x)
math.pi
```

工具函数：

```python
nz(src, replacement=0)
na(src)
shift(src, periods=1)
highest(src, period)
lowest(src, period)
sum(src, period)
change(src, period=1)
roc(src, period=1)
```

## Incremental 模式

Batch 脚本仍是默认模式。需要实时 O(1) 的脚本可以声明 incremental，并定义 `on_bar(ctx, bar)`：

```python
indicator("Incremental MA", mode="incremental", overlay=true)

def init(ctx):
    ctx.ta.sma("ma20", period=20)

def on_bar(ctx, bar):
    ma = ctx.ta.sma("ma20").update(bar.close)
    ctx.plot("MA20", ma, color=color.orange)
```

运行模型：

- 历史加载：按时间顺序回放 bars，复杂度 O(n)。
- 实时收盘：只处理新收盘 bar，复杂度 O(1)。
- 实时预览：从已收盘状态 clone 一份临时状态，不污染 committed state。

可用基础 API：

- `ctx.state(name, default)`：持久状态值，返回带 `.value` 的对象。
- `ctx.window(name, size)`：固定长度 rolling window。
- `ctx.plot(name, value, **style)`：输出当前 bar 的单点 line。
- `ctx.marker(condition, **style)`：输出当前 bar marker。
- `ctx.ta.sma(name, period)` / `ctx.ta.ema(name, period)`：状态化均线 helper。
- `ctx.ta.boll(name, period, multiplier)`：返回 `(upper, mid, lower)`。
- `ctx.ta.macd(name, fast, slow, signal)`：返回 `(dif, dea, hist)`。
- `ctx.ta.rsi(name, period)` / `ctx.ta.atr(name, period)`：状态化震荡/波动 helper。
- `ctx.ta.highest(name, period)` / `ctx.ta.lowest(name, period)`：单调窗口 helper。

资源保护：

- `safe` 模式会限制 incremental 的 `ctx.state()` key 数量，以及 `ctx.window()` / 依赖窗口的 helper 大小。
- `research` 和 `unsafe` 模式不启用 incremental state/window 限制，保留本地研究自由度；这些模式下用户自行承担内存风险。
- 现有执行超时、`PYNE_MAX_BARS`、输出大小限制仍然生效。

Incremental WebSocket 订阅会在品种、周期、脚本、参数、安全模式、history limit 一致时共享同一个进程内 session。重复订阅复用同一根 bar 的计算结果，不会多次推进 state。

## Security Modes

模式由 `pyne_runtime.security` 定义，并通过 [security.py](security.py) 转发：

| 模式 | 行为 |
|---|---|
| `safe` | 默认。禁止 import statements，并使用受限 builtins |
| `research` | 只允许 `PYNE_ALLOWED_IMPORTS` 中的 imports |
| `unsafe` | 完整 Python builtins 和 unrestricted imports；只适合本地可信使用 |

security 和 limits 在 `app.core.config` 中配置：

| 环境变量 | 用途 |
|---|---|
| `PYNE_SECURITY_MODE` | 默认 security mode |
| `PYNE_EXECUTOR_MODE` | `process`（默认）或 `inline` |
| `PYNE_EXEC_TIMEOUT_SECONDS` | 执行超时 |
| `PYNE_PROCESS_GRACE_SECONDS` | 进程终止 grace |
| `PYNE_MAX_BARS` | 最大 OHLCV 行数 |
| `PYNE_MAX_OUTPUT_SERIES` | 最大输出 series/annotation 数 |
| `PYNE_MAX_OUTPUT_POINTS` | 最大总输出点数 |
| `PYNE_CACHE_MAX_ITEMS` | 脚本 cache 容量 |
| `PYNE_ALLOWED_IMPORTS` | research mode 允许的逗号分隔 imports |

默认使用 process executor，因为它能提供硬 timeout 边界。Inline timeout 是 best-effort，只能在 Unix-like 系统主线程中通过 `signal.setitimer` 生效。

## 错误 Payload

`PyneResult` 暴露：

- `ok`
- `error`
- `code`
- `line`
- `column`
- `hint`
- `errorDetail`
- `lines`
- `output`
- `param_schema`
- `meta`

常见错误码：

- `INVALID_OHLCV`
- `PYNE_SYNTAX_ERROR`
- `PYNE_TIMEOUT`
- `PYNE_IMPORT_BLOCKED`
- `PYNE_SECURITY_ERROR`
- `PYNE_OUTPUT_LIMIT_EXCEEDED`
- `PYNE_RUNTIME_ERROR`
- `PYNE_PROCESS_FAILED`

## Cache

`pyne.cache` 是进程内、线程安全、带 TTL 和 max-item 淘汰的 cache。它适合脚本内部缓存昂贵中间结果，但不是持久化层，也不会跨进程共享。

## 限制

- Pyne 脚本只负责计算和发出图表输出；signals 不会下单。
- safe mode 禁止 import。
- process mode 可以隔离 timeout，但不会和父进程共享 Python object state。
- inline mode 可能更快，但不能在所有环境中强制硬 timeout。

## 测试

```bash
cd backend
python -m pytest -q tests/test_indicator_api.py
```
