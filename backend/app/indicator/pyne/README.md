# Pyne Runtime

[中文](README_zh.md)

> Pine-style Python scripting runtime for CandleScope indicators. Pyne lets users write backend-hosted scripts with familiar `ta.*`, `input.*`, `plot()`, and `color.*` APIs while running inside a controlled execution policy.

## Runtime Flow

```text
script + OHLCV + params
        ▼
execute_pyne_script()
        ├── process executor (default) or inline executor
        ▼
PyneRuntime.execute()
        ├── validate security policy
        ├── build PyneContext
        ├── inject namespace
        ├── exec(script)
        ├── collect outputs
        └── enforce output limits
```

## Files

| File | Responsibility |
|---|---|
| [runtime.py](runtime.py) | Main execution runtime and `PyneResult` |
| [executor.py](executor.py) | Inline/process execution strategy and hard process timeout |
| [security.py](security.py) | Security modes, import policy, timeout, output limits, builtins |
| [context.py](context.py) | OHLCV arrays and derived sources |
| [ta.py](ta.py) | Technical analysis functions |
| [input.py](input.py) | `input.*` parameter declarations and UI schema collection |
| [plot.py](plot.py) | `indicator`, `plot`, `bar`, `hline`, `fill`, `marker`, `bgcolor`, `barcolor`, signals |
| [color.py](color.py) | Color constants and `color.new()` |
| [math_ext.py](math_ext.py) | Array-aware math namespace |
| [utils.py](utils.py) | `nz`, `shift`, crossovers, rolling helpers, pivots, etc. |
| [cache.py](cache.py) | Process-local TTL cache for scripts |

## Quick Start

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

No imports are required in safe mode. The runtime injects OHLCV arrays, helpers, and namespaces.

## Injected Data

| Name | Type / Meaning |
|---|---|
| `open`, `high`, `low`, `close`, `volume` | NumPy arrays |
| `time` | list of Unix seconds |
| `bar_count` | number of bars |
| `hl2` | `(high + low) / 2` |
| `hlc3` | `(high + low + close) / 3` |
| `ohlc4` | `(open + high + low + close) / 4` |
| `hlcc4` | `(high + low + close + close) / 4` |
| `params` | raw request params |
| `np`, `numpy` | NumPy namespace |

## `ta.*`

Moving averages:

```python
ta.sma(src, period)
ta.ema(src, period)
ta.wma(src, period)
ta.vwma(src, period, volume=None)
ta.rma(src, period)
```

Oscillators and trend:

```python
ta.rsi(src, period=14)
k, d = ta.stoch(close, high, low, 14)
ta.cci(high, low, close, 20)
ta.mfi(period=14)
dif, dea, hist = ta.macd(close, 12, 26, 9)
ta.adx(high, low, close, 14)
supertrend, direction = ta.supertrend(10, 3.0)
```

Volatility and volume:

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

Utility proxies:

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

Most utility functions are also injected as globals, so `crossover(fast, slow)` works.

## `input.*`

Inputs return runtime values and collect frontend schema:

```python
length = input.int(20, "Period", minval=1, maxval=500)
mult = input.float(2.0, "Multiplier", minval=0.1, step=0.1)
show = input.bool(True, "Show")
src = input.source(close, "Source")
col = input.color("#f59e0b", "Color")
kind = input.string("EMA", "Type", options=["SMA", "EMA", "WMA"])
```

Numeric inputs clamp to min/max.

## Plotting And Outputs

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

Supported output helpers include:

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
- legacy `add_line()`

The serialized response includes legacy `lines` plus normalized `series`, `annotations`, `fills`, and `paneLayout` through `app.indicator.serialization`.

## Colors

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

color.new("#ef4444", 80)  # 0 = opaque, 100 = invisible
```

## Math And Utilities

`math` is array-aware:

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

Utility helpers:

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

## Incremental Mode

Batch scripts remain the default. Scripts that need realtime O(1) updates can declare incremental mode and define `on_bar(ctx, bar)`:

```python
indicator("Incremental MA", mode="incremental", overlay=true)

def init(ctx):
    ctx.ta.sma("ma20", period=20)

def on_bar(ctx, bar):
    ma = ctx.ta.sma("ma20").update(bar.close)
    ctx.plot("MA20", ma, color=color.orange)
```

Execution model:

- Historical load replays bars in timestamp order, O(n).
- Realtime closed-bar updates process only the new closed bar, O(1).
- Realtime previews clone committed state and do not mutate it.

Available starter API:

- `ctx.state(name, default)`: persistent mutable state with a `.value` field.
- `ctx.window(name, size)`: fixed-size rolling window.
- `ctx.plot(name, value, **style)`: emit one line point for the current bar.
- `ctx.marker(condition, **style)`: emit one marker for the current bar.
- `ctx.ta.sma(name, period)` / `ctx.ta.ema(name, period)`: stateful moving-average helpers.
- `ctx.ta.boll(name, period, multiplier)`: returns `(upper, mid, lower)`.
- `ctx.ta.macd(name, fast, slow, signal)`: returns `(dif, dea, hist)`.
- `ctx.ta.rsi(name, period)` / `ctx.ta.atr(name, period)`: stateful oscillator/range helpers.
- `ctx.ta.highest(name, period)` / `ctx.ta.lowest(name, period)`: monotonic-window helpers.

Resource protection:

- In `safe` mode, incremental `ctx.state()` keys and `ctx.window()`/window-backed helper sizes are capped.
- In `research` and `unsafe` modes, incremental state/window caps are not applied. This keeps local research workflows unrestricted; users are responsible for memory use in those modes.
- Existing execution timeout, `PYNE_MAX_BARS`, and output-size limits still apply.

Incremental WebSocket subscriptions share one in-process session when symbol, interval, script, params, security mode, and history limit match. Duplicate subscribers reuse the same computed bar result instead of advancing state multiple times.

## Security Modes

Modes are defined in [security.py](security.py):

| Mode | Behavior |
|---|---|
| `safe` | Default. Blocks import statements and uses restricted builtins |
| `research` | Allows imports from `PYNE_ALLOWED_IMPORTS` only |
| `unsafe` | Full Python builtins and unrestricted imports; local trusted use only |

Security and limits are configured in `app.core.config`:

| Env | Purpose |
|---|---|
| `PYNE_SECURITY_MODE` | default security mode |
| `PYNE_EXECUTOR_MODE` | `process` (default) or `inline` |
| `PYNE_EXEC_TIMEOUT_SECONDS` | execution timeout |
| `PYNE_PROCESS_GRACE_SECONDS` | process termination grace |
| `PYNE_MAX_BARS` | maximum OHLCV rows |
| `PYNE_MAX_OUTPUT_SERIES` | maximum output series/annotation count |
| `PYNE_MAX_OUTPUT_POINTS` | maximum total output points |
| `PYNE_CACHE_MAX_ITEMS` | script cache capacity |
| `PYNE_ALLOWED_IMPORTS` | comma-separated imports allowed in research mode |

The process executor is the default because it gives the host a hard timeout boundary. Inline timeout is best-effort and only uses `signal.setitimer` in the main thread on Unix-like systems.

## Error Payloads

`PyneResult` exposes:

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

Common error codes include:

- `INVALID_OHLCV`
- `PYNE_SYNTAX_ERROR`
- `PYNE_TIMEOUT`
- `PYNE_IMPORT_BLOCKED`
- `PYNE_SECURITY_ERROR`
- `PYNE_OUTPUT_LIMIT_EXCEEDED`
- `PYNE_RUNTIME_ERROR`
- `PYNE_PROCESS_FAILED`

## Cache

`pyne.cache` is a process-local, thread-safe cache with TTL and max-item eviction. It is useful for expensive intermediate computations inside trusted scripts, but it is not a persistence layer and does not cross process boundaries.

## Limitations

- Pyne scripts compute and emit chart outputs; signals do not submit orders.
- Safe mode blocks imports.
- Process mode isolates timeout handling but does not share Python object state with the parent process.
- Inline mode can be faster but cannot enforce a hard timeout in every environment.

## Tests

```bash
cd backend
python -m pytest -q tests/test_indicator_api.py
```
