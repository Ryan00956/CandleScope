# `input` API

The `input` namespace declares user-adjustable parameters.

```python
length = input.int(20, "Length", minval=1, maxval=500)
mult = input.float(2.0, "Multiplier", minval=0.1, step=0.1)
show = input.bool(True, "Show")
src = input.source(close, "Source")
color_value = input.color("#f59e0b", "Color")
kind = input.string("EMA", "Type", options=["SMA", "EMA"])
```

Declarations are collected into `result.param_schema`.

When using the CLI, override input values with `--param` or `--params-json`:

```bash
pyne run script.py --ohlcv bars.csv --param Length=20 --param Show=true
```
