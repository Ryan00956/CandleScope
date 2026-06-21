# Top-Level API

Import the friendly API from the package root:

```python
import pyne_runtime as pn
```

Core functions:

- `pn.run(script, data, params=None, settings=None, security_mode=None, executor_mode=None, data_provider=None, syminfo=None, timeframe=None, session=None)`
- `pn.read_ohlcv(path, time_unit="s", columns=None)`
- `pn.from_pandas(df, **columns)`
- `pn.validate(script, settings=None)`
- `pn.schema()`
- `pn.__version__`
- `pn.na`

`pn.schema()["scriptNamespace"]` lists the top-level names injected into Pyne
scripts, grouped for host editors that want autocomplete or quick API pickers.

Core classes:

- `pn.PyneData`
- `pn.PyneBarState`
- `pn.PyneIncrementalBarState`
- `pn.PyneMath`
- `pn.PyneResult`
- `pn.PyneSettings`
- `pn.PyneSeries`
- `pn.PyneStateNamespace`
- `pn.PyneVar`
- `pn.PyneRuntime`
- `pn.SymbolInfo`
- `pn.TimeframeInfo`
- `pn.SessionInfo`
- `pn.SessionNamespace`
- `pn.DataProvider`
- `pn.OHLCVBar`
- `pn.RequestCapabilities`
- `pn.RequestCapabilityProvider`
- `pn.RequestEvalContext`
- `pn.RequestMetadata`
- `pn.RequestMetadataProvider`
- `pn.RequestModule`
- `pn.StrategyModule`

Script namespace groups exposed by `pn.schema()["scriptNamespace"]`:

- `data`: OHLCV sources, derived price sources, bar clock, barstate, and runtime
  metadata.
- `modules`: Pine-like namespaces such as `ta`, `input`, `request`, `strategy`,
  `array`, `map`, `matrix`, `color`, `math`, `pyne`, and cache helpers.
- `plot`: plot, marker, alert, drawing object, and visual enum helpers.
- `utility`: expression helpers, history helpers, TA aliases, `na` / `nz`, and
  explicit `var` / `state` cells.
- `compat`: Python/legacy compatibility names such as `np`, `numpy`, and
  read-only `params`.
