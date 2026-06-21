# Quickstart

Install Pyne Runtime from this repository:

```bash
python -m pip install -e .[dev]
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
print(result.series_names)
print(result.latest("Close"))
```

Run a script from the command line:

```bash
pyne run examples/ma_cross.py --ohlcv examples/sample_ohlcv.csv --out result.json
```

Override script inputs from the command line:

```bash
pyne run examples/ma_cross.py --ohlcv examples/sample_ohlcv.csv --param Length=20
```

Validate a script:

```bash
pyne validate examples/ma_cross.py
```

Inspect package metadata and schema:

```bash
pyne --version
python -m pyne_runtime --version
pyne schema
```
