# Expression Helpers

Pyne scripts use Python syntax, but Pine-style series conditions need series-aware helpers.

Use `when()` for conditional values:

```python
body = when(close > open, close - open, open - close)
plot(body, "Body")
```

`iff()` and `where()` are kept as aliases for compatibility:

```python
plot(iff(close > open, close, na), "Up Close")
plot(where(close > open, close, na), "Up Close")
```

Use `switch()` when multiple conditions should be evaluated in priority order:

```python
regime = switch(
    (crossover(fast, slow), 1),
    (crossunder(fast, slow), -1),
    default=0,
)
plot(regime, "Regime")
```

Earlier cases win. Conditions and values may be scalar or series.

## Boolean Series

Use `&`, `|`, and `~` for boolean series:

```python
signal = (close > open) & (close > close[1])
```

Python's `and`, `or`, `not`, and direct `if` statements operate on whole objects, so they cannot be used with `PyneSeries`:

```python
# Not supported
if close > open:
    plot(close)
```

Use `when()` or `switch()` instead:

```python
plot(when(close > open, close, na), "Up Close")
```
