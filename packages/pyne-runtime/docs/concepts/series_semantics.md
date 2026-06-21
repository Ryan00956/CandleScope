# Series Semantics

Pyne scripts use Pine-like series values for OHLCV sources and indicator results.

The key rule is that integer indexing means bars back:

```python
plot(close, "Close")
plot(close[1], "Previous Close")
plot(close[2], "Two Bars Ago")
```

In a Pyne script:

- `close[0]` is the current `close` series.
- `close[1]` is the previous bar's `close` series.
- `close[2]` is two bars back.
- Bars without enough history are `na`.
- Negative indexes are not supported because they would imply future references.

This differs from normal Python and NumPy indexing. Inside Pyne scripts, `close[1]` is intentionally not "the second value in the array"; it is the Pine-style historical reference.

Series values also support vector operations:

```python
mid = (high + low) / 2
bull = close > open
signal = (ta.ema(close, 12) > ta.ema(close, 26)) & (close > close[1])

plot(mid, "Mid")
marker(signal, text="Signal")
```

Use `&`, `|`, and `~` for boolean series. Python's `and`, `or`, and `not` operate on whole objects and are not valid for series expressions.

```python
# Good
signal = (close > open) & (close > close[1])

# Not supported
signal = (close > open) and (close > close[1])
```

Use `when()` and `switch()` for Pine-style conditional expressions:

```python
body = when(close > open, close - open, open - close)
regime = switch((crossover(fast, slow), 1), (crossunder(fast, slow), -1), default=0)
```

For package internals and advanced integrations, a `PyneSeries` can still be converted to NumPy:

```python
values = np.asarray(close)
```

NumPy is an implementation detail. User-facing script semantics should prefer series expressions.
