# Pyne Runtime

Pyne Runtime is a Pine-style Python indicator runtime for OHLCV data.

It lets scripts use familiar charting APIs such as `ta.*`, `input.*`, `plot()`, `marker()`, and `color.*`, while staying usable as a normal Python package.

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

## Install Locally

From the CandleScope repository root:

```bash
python -m pip install -e packages/pyne-runtime
```

## Command Line

```bash
pyne run packages/pyne-runtime/examples/ma_cross.py --ohlcv packages/pyne-runtime/examples/sample_ohlcv.csv --out result.json
```

## Status

This package is the standalone runtime extraction of Pyne. It does not import CandleScope application modules.

## Documentation

Start here:

- [Quickstart](docs/quickstart.md)
- [First Indicator Tutorial](docs/tutorials/first_indicator.md)
- [CSV To Signal Tutorial](docs/tutorials/csv_to_signal.md)

Concepts:

- [Data Model](docs/concepts/data_model.md)
- [Script Runtime](docs/concepts/script_runtime.md)
- [Security Modes](docs/concepts/security_modes.md)
- [Incremental Runtime](docs/concepts/incremental_runtime.md)

API:

- [Public API](docs/api/public_api.md)
- [Top-Level API](docs/api/top_level.md)
- [PyneData](docs/api/data.md)
- [PyneResult](docs/api/result.md)
- [PyneRuntime](docs/api/runtime.md)
- [PyneSettings](docs/api/settings.md)
- [`ta` API](docs/api/ta.md)
- [`input` API](docs/api/input.md)
- [Plot API](docs/api/plot.md)

Reference:

- [Output Schema](docs/reference/output_schema.md)
- [Error Codes](docs/reference/error_codes.md)
- [Compatibility](docs/reference/compatibility.md)
