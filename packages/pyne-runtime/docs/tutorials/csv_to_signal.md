# Tutorial: CSV To Signal

Use `pn.read_ohlcv()` to load CSV data with the standard columns:

```csv
time,open,high,low,close,volume
1,100,102,99,101,1200
2,101,103,100,102,1250
```

Then run a script:

```python
import pyne_runtime as pn

data = pn.read_ohlcv("bars.csv")

script = """
indicator("RSI Signal", overlay=False)
r = ta.rsi(close, 14)
plot(r, "RSI", color=color.purple)
emit_signal(crossover(r, 30), name="rsi_recover", message="RSI crossed above 30")
"""

result = pn.run(script, data)
print(result.output.get("signals", []))
```

Signals are structured output records. Hosts can use them for alerts, backtests, or UI annotations.

