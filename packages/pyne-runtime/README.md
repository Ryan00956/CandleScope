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

From the repository root:

```bash
python -m pip install -e .[dev]
```

## Command Line

```bash
pyne run examples/ma_cross.py --ohlcv examples/sample_ohlcv.csv --out result.json
```

```bash
pyne --version
python -m pyne_runtime --version
pyne schema
pyne validate examples/ma_cross.py
```

## Status

This package is the standalone runtime extraction of Pyne.

## Documentation

Start here:

- [Quickstart](docs/quickstart.md)
- [First Indicator Tutorial](docs/tutorials/first_indicator.md)
- [CSV To Signal Tutorial](docs/tutorials/csv_to_signal.md)
- [Host-Backed `request.security()`](docs/tutorials/host_request_security.md)

Concepts:

- [Data Model](docs/concepts/data_model.md)
- [Series Semantics](docs/concepts/series_semantics.md)
- [`na` Semantics](docs/concepts/na_semantics.md)
- [Bar Execution Model](docs/concepts/bar_execution_model.md)
- [State Semantics](docs/concepts/state_semantics.md)
- [Expression Helpers](docs/concepts/expression_helpers.md)
- [Drawing Objects](docs/concepts/drawing_objects.md)
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
- [`request` API](docs/api/request.md)
- [`strategy` API](docs/api/strategy.md)
- [Plot API](docs/api/plot.md)

Reference:

- [Output Schema](docs/reference/output_schema.md)
- [CLI](docs/reference/cli.md)
- [Error Codes](docs/reference/error_codes.md)
- [Compatibility](docs/reference/compatibility.md)
- [Pine-Like API Matrix](docs/reference/pine_like_api_matrix.md)

Development:

Use the quality gates before changing package internals, and use the
architecture plan to track staged module-boundary work.

- [Quality Gates](docs/development/quality_gates.md)
- [Architecture Execution Plan](docs/development/architecture_execution_plan_zh.md)
- [Pine-Like Semantics Execution Plan](docs/development/pine_semantics_execution_plan_zh.md)
- [Python Package Long-Term Direction](docs/development/python_package_long_term_plan_zh.md)
- [Phase 11 Request Security Expression Thunks Plan](docs/development/request_security_expression_thunks_plan_zh.md)
