# Public API

Pyne Runtime keeps a small public API surface at the package root.

Stable imports:

```python
import pyne_runtime as pn

pn.run
pn.read_ohlcv
pn.from_pandas
pn.validate
pn.schema
pn.__version__

pn.PyneData
pn.PyneResult
pn.PyneSettings
pn.PyneRuntime

pn.execute_pyne_script
pn.execute_pyne_script_in_process
```

Version constants:

```python
pn.__version__
pn.PYNE_INPUT_SCHEMA_VERSION
pn.PYNE_OUTPUT_SCHEMA_VERSION
```

Internal helpers and non-exported functions are not part of the compatibility contract.

`PyneResult` also exposes convenience helpers for common series access:

```python
result.series_names
result.get_series("Close")
result.values("Close")
result.latest("Close")
```
