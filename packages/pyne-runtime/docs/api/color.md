# Color API

Pyne exposes a Pine-like `color.*` namespace in scripts. Named colors are plain
CSS color strings, and helpers return strings that host renderers can use
directly.

```python
plot(close, color=color.blue)
plot(close, color=color.rgb(255, 128, 0))
barcolor(color.new(color.green, 80))
```

## Constants

Common Pine-style constants include:

- `color.aqua`
- `color.black`
- `color.blue`
- `color.fuchsia`
- `color.gray` / `color.grey`
- `color.green`
- `color.lime`
- `color.maroon`
- `color.navy`
- `color.olive`
- `color.orange`
- `color.purple`
- `color.red`
- `color.silver`
- `color.teal`
- `color.white`
- `color.yellow`

Pyne also exposes trading aliases such as `color.up`, `color.down`,
`color.bull`, and `color.bear`.

## Helpers

- `color.rgb(red, green, blue, transparency=0)`
- `color.new(base_color, transparency=0)`
- `color.r(color_value)`
- `color.g(color_value)`
- `color.b(color_value)`
- `color.t(color_value)`
- `color.when(condition, true_color, false_color)`
- `color.from_gradient(value, low, high, low_color, high_color)`

Transparency follows Pine's convention: `0` is opaque and `100` is fully
transparent.

`color.rgb()` returns a hex string when transparency is `0`, and an `rgba(...)`
string when transparency is greater than `0`.

```python
color.rgb(255, 128, 0)
# "#ff8000"

color.rgb(255, 128, 0, 75)
# "rgba(255,128,0,0.25)"
```

The channel helpers parse both hex and `rgb(...)` / `rgba(...)` strings. They
also accept series colors and return series channel values.

```python
color.r("#ff8000")              # 255
color.t("rgba(255,128,0,0.25)") # 75
```

`color.rgb()`, `color.new()`, `color.when()`, and `color.from_gradient()` accept
series inputs and return series-like color values.
