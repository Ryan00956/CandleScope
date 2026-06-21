# `input` API

The `input` namespace declares user-adjustable parameters.

```python
length = input.int(20, "Length", minval=1, maxval=500)
mult = input.float(2.0, "Multiplier", minval=0.1, step=0.1)
show = input.bool(True, "Show")
src = input.source(close, "Source")
color_value = input.color("#f59e0b", "Color")
kind = input.string("EMA", "Type", options=["SMA", "EMA"])
higher_tf = input.timeframe("60", "Higher TF", options=["15", "60", "1D"])
symbol = input.symbol("NASDAQ:AAPL", "Symbol")
session_value = input.session("0930-1600", "Session")
start_time = input.time(1710000000, "Start Time")
```

Declarations are collected into `result.param_schema`. The top-level result
includes `paramSchemaVersion` so hosts can branch on parameter schema changes.

Each schema entry includes:

- `id`: stable parameter id. It currently matches `key`.
- `key`: stable override key. By default this is the input title.
- `type`: `int`, `float`, `bool`, `string`, `color`, `source`,
  `timeframe`, `symbol`, `session`, or `time`.
- `default`: declared default value.
- `current`: value used for this run after params and validation.
- `title`: display title.
- `tooltip`, `group`: UI metadata.
- `inline`: optional UI grouping hint for same-line controls.
- `confirm`: optional flag for hosts that require explicit user confirmation.
- `options`: dropdown choices for string and source inputs.
- `minval`, `maxval`, `step`: numeric bounds and increment metadata.

When multiple inputs reuse the same title, the first input keeps that title as
its `key` / `id` and later inputs receive stable numeric suffixes such as
`Length_2`, `Length_3`, and so on. The display `title` remains unchanged.

For compatibility with older schema consumers, numeric inputs also expose
`min` and `max` aliases when bounds are declared.

```python
length = input.int(
    20,
    "Length",
    minval=1,
    maxval=200,
    step=1,
    tooltip="Moving average period.",
    group="Moving Average",
    inline="ma",
    confirm=True,
)
kind = input.string("EMA", "Type", options=["SMA", "EMA"], group="Moving Average")
higher_tf = input.timeframe("60", "Higher TF", options=["15", "60", "1D"])
symbol = input.symbol("NASDAQ:AAPL", "Symbol", group="Context")
session_value = input.session("0930-1600", "Session", group="Context")
start_time = input.time(1710000000, "Start Time", confirm=True)
```

`input.timeframe()`, `input.symbol()`, and `input.session()` return strings.
`input.time()` returns a Unix timestamp in seconds. These are script parameters;
they do not override the chart metadata exposed as `timeframe`, `syminfo`, or
`session` unless the host also chooses to pass matching runtime metadata.

When using the CLI, override input values with `--param` or `--params-json`:

```bash
pyne run script.py --ohlcv bars.csv --param Length=20 --param Show=true
```

Overrides are validated by the declared input type:

- `input.int()` accepts integer-like values and enforces `minval` / `maxval`.
- `input.float()` accepts numeric values and enforces `minval` / `maxval`.
- `input.bool()` accepts booleans, `0` / `1`, and string `true` / `false`.
- string-like inputs require strings.
- inputs with `options` reject values outside the declared choices.
- `input.source()` rejects unknown source names.
- `input.time()` requires a non-negative Unix timestamp in seconds.

Invalid overrides return `PYNE_INVALID_PARAM` in the run result.
