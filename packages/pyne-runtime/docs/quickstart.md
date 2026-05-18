# Quickstart

Install Pyne Runtime from this repository:

```bash
python -m pip install -e packages/pyne-runtime
```

Run a script from Python:

```python
import pyne_runtime as pn

data = [
    {"time": 1, "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": 100},
    {"time": 2, "open": 1.5, "high": 2.5, "low": 1.4, "close": 2.0, "volume": 120},
    {"time": 3, "open": 2.0, "high": 2.4, "low": 1.9, "close": 2.2, "volume": 150},
]

result = pn.run("""
indicator("Close", overlay=True)
plot(close, "Close", color=color.orange)
""", data)

print(result.ok)
print(result.lines)
```

Run a script from the command line:

```bash
pyne run packages/pyne-runtime/examples/ma_cross.py --ohlcv packages/pyne-runtime/examples/sample_ohlcv.csv --out result.json
```

Validate a script:

```bash
pyne validate packages/pyne-runtime/examples/ma_cross.py
```

