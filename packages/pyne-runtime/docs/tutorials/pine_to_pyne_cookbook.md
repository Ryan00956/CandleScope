# Pine-to-Pyne Cookbook

Pyne uses Python syntax with Pine-like runtime semantics. This cookbook shows
the most common rewrites for users moving Pine ideas into Pyne scripts.

Pyne does not parse or run `.pine` source files directly. Write normal Python
and use Pyne helpers where Pine syntax has no direct Python equivalent.

## Series Conditions

Pine lets a condition produce a series value across bars. Python `if` statements
branch once on an object, so they cannot select per-bar values from a
`PyneSeries`.

Unsupported:

```python
if close > open:
    body = close - open
else:
    body = open - close
plot(body, "Body")
```

Use `when()` for per-bar selection:

```python
body = when(close > open, close - open, open - close)
plot(body, "Body")
```

Use `switch()` when several series conditions should be checked in priority
order:

```python
regime = switch(
    (crossover(fast, slow), 1),
    (crossunder(fast, slow), -1),
    default=0,
)
plot(regime, "Regime")
```

## Python Ternary Expressions

Python ternary expressions have the same object-level branching problem as
`if` statements.

Unsupported:

```python
plot(close if close > open else na, "Up Close")
```

Use `when()`:

```python
plot(when(close > open, close, na), "Up Close")
```

## Boolean Series

Use `&`, `|`, and `~` for boolean series composition. Keep parentheses around
comparisons because Python operator precedence still applies.

```python
signal = (close > open) & (close > close[1])
plot(when(signal, close, na), "Signal")
```

Python `and`, `or`, and `not` operate on whole objects, not per-bar series
values.

Unsupported:

```python
signal = (close > open) and (close > close[1])
hidden = not (close > open)
```

Use Python's bitwise operators for per-bar boolean series:

```python
signal = (close > open) & (close > close[1])
hidden = ~(close > open)
```

## `request.security()` Expressions

Python evaluates function arguments before `request.security()` receives them.
That means Pyne cannot capture an already evaluated expression and recalculate
it in the requested symbol/timeframe context.

Unsupported:

```python
higher_ema = request.security("BTCUSDT", "1h", ta.ema(close, 20))
```

Use a callable thunk. The `ctx` object is bound to the requested context:

```python
higher_ema = request.security(
    "BTCUSDT",
    "1h",
    lambda ctx: ctx.ta.ema(ctx.close, 20),
)
plot(higher_ema, "1h EMA")
```

Plain fields and field history references are still allowed:

```python
higher_close = request.security("BTCUSDT", "1h", close)
higher_prev_close = request.security("BTCUSDT", "1h", close[1])
higher_open, higher_close = request.security("BTCUSDT", "1h", ("open", "close"))
```

## Validate Before Running

Use `pyne validate` to catch common migration mistakes before execution:

```bash
pyne validate examples/my_indicator.py
```

The validator reports `PYNE_MIGRATION_HINT` diagnostics for patterns such as
series `if`, series ternary expressions, and unsupported bare
`request.security()` calculations.

## Collection Constructors

Pine uses `array.from(...)`, but `from` is a Python keyword, so this spelling is
not valid Python syntax after a dot.

Unsupported:

```python
items = array.from(close, open)
```

Use Pyne's Python-safe aliases:

```python
items = array.from_values(close, open)
items = array.from_list([close, open])
```

## Forward History References

Pine-like history references are bars-back references. Negative indexes would
look forward, so Pyne rejects them.

Unsupported:

```python
plot(close[-1], "Forward")
plot(shift(close, -1), "Forward")
```

Use non-negative bars-back references:

```python
plot(close[1], "Previous Close")
plot(shift(close, 1), "Previous Close")
```
