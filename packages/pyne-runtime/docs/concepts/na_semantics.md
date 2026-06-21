# `na` Semantics

Pyne treats missing values as first-class script values.

The `na` object can be used as a missing value:

```python
plot(na, "Missing")
plot(where(close > open, close, na), "Up Close")
```

It can also be called to check whether a scalar or series value is missing:

```python
first_bar = na(close[1])
marker(first_bar, text="First")
```

History references that do not have enough bars produce `na`:

```python
prev = close[1]
two_back = close[2]
```

Use `nz()` to replace missing values:

```python
plot(nz(close[1], close), "Previous Or Current")
plot(nz(close[1], 0), "Previous Filled")
```

Use `fixnan()` when later missing values should reuse the latest known value:

```python
plot(fixnan(where(close > open, close, na)), "Last Up Close")
```

Missing conditions are treated as false by marker, signal, and coloring helpers:

```python
marker(na, text="Never")
emit_signal(na, name="never")
```

Use `na(x)` when you want to detect missing values explicitly:

```python
marker(na(close[1]), text="First Bar")
```

Current scope:

- Numeric series use `np.nan` internally for missing values.
- `na(x)` returns a boolean scalar or boolean `PyneSeries`.
- `nz(x, replacement)` is series-aware.
- `fixnan(x)` carries the latest non-`na` value forward and leaves leading
  missing values as `na`.
- `plot(na)` is a stable no-op.
- Marker and signal conditions ignore `na`.

Future phases may refine missing behavior for object handles, color values, and strategy state.
