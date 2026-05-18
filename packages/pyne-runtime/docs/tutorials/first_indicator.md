# Tutorial: First Indicator

Pyne scripts are Python scripts with charting helpers injected into the runtime namespace.

```python
indicator("MA Cross", overlay=True)

fast = ta.ema(close, 12)
slow = ta.ema(close, 26)

plot(fast, "Fast EMA", color=color.orange)
plot(slow, "Slow EMA", color=color.blue)
marker(crossover(fast, slow), text="Buy", color=color.green)
```

The host passes OHLCV data into `pn.run()`. Pyne injects arrays such as `open`, `high`, `low`, `close`, `volume`, and `time`.

```python
import pyne_runtime as pn

data = pn.read_ohlcv("bars.csv")
result = pn.run(open("ma_cross.py", encoding="utf-8").read(), data)
```

Use `result.lines` for chart series, `result.output` for structured outputs, and `result.error_detail` when execution fails.

