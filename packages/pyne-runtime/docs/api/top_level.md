# Top-Level API

Import the friendly API from the package root:

```python
import pyne_runtime as pn
```

Core functions:

- `pn.run(script, data, params=None, settings=None, security_mode=None, executor_mode=None)`
- `pn.read_ohlcv(path, time_unit="s", columns=None)`
- `pn.from_pandas(df, **columns)`
- `pn.validate(script, settings=None)`
- `pn.schema()`

Core classes:

- `pn.PyneData`
- `pn.PyneResult`
- `pn.PyneSettings`
- `pn.PyneRuntime`

