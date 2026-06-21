# String API

Pyne exposes a Pine-like `str.*` namespace in scripts. The namespace is also
callable, so `str(value)` still works after Pyne injects the Pine-like global.

```python
label(str(close))
label(str.tostring(close, "#.##"))
value = str.tonumber("42.5")
```

In batch execution, `str.tostring()` resolves series, lists, arrays, and NumPy
arrays to their latest non-`na` value. This matches the current batch behavior
for label text and drawing-object scalar coordinates.

## Conversion

- `str(value)`
- `str.tostring(value, format=None)`
- `str.tonumber(value)`

`str.tostring()` supports simple numeric format strings such as `"#.##"` and
the Pyne/Pine-like format names `price`, `volume`, `percent`, and `inherit`.
`str.tonumber()` returns `None` for missing or non-numeric text.

## Search And Edit

- `str.length(value)`
- `str.substring(value, begin_pos, end_pos=None)`
- `str.pos(value, substring)`
- `str.contains(value, substring)`
- `str.match(value, regex)`
- `str.startswith(value, prefix)`
- `str.endswith(value, suffix)`
- `str.replace(value, target, replacement, occurrence=None)`
- `str.replace_all(value, target, replacement)`
- `str.split(value, separator)`
- `str.trim(value)`
- `str.upper(value)`
- `str.lower(value)`
- `str.repeat(value, count)`
- `str.format(template, *args)`

`str.split()` returns a `PyneArray`, so it can be used with `array.*` helpers:

```python
parts = str.split("ema,sma,rsi", ",")
label(array.join(parts, " | "))
```

`str.replace()` replaces the first occurrence by default. When `occurrence` is
provided, it replaces the zero-based matching occurrence.

`str.match()` returns the first regular-expression match as text, or `None`
when the regex does not match.
