# Host-Backed `request.security()`

`request.security()` needs a host data provider. Pyne does not fetch exchange
data by itself; it asks the host for OHLCV bars, then aligns the requested
series back to the chart bars.

```python
import pyne_runtime as pn


class StaticProvider:
    capabilities: pn.RequestCapabilities = {
        "request.security": True,
        "request.security_lower_tf": True,
    }

    def __init__(self, bars_by_key):
        self.bars_by_key = bars_by_key

    def get_ohlcv(self, symbol, timeframe, start, end):
        bars = self.bars_by_key[(symbol, timeframe)]
        return [
            bar
            for bar in bars
            if start <= int(bar["time"]) <= end
        ]


chart_bars = [
    {"time": 1, "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": 100},
    {"time": 2, "open": 2, "high": 3, "low": 1.5, "close": 2.5, "volume": 120},
    {"time": 3, "open": 3, "high": 4, "low": 2.5, "close": 3.5, "volume": 140},
    {"time": 4, "open": 4, "high": 5, "low": 3.5, "close": 4.5, "volume": 160},
]

provider = StaticProvider({
    ("BTCUSDT", "2"): [
        {"time": 1, "open": 10, "high": 11, "low": 9, "close": 10, "volume": 1000},
        {"time": 3, "open": 30, "high": 31, "low": 29, "close": 30, "volume": 3000},
    ],
})

result = pn.run(
    """
indicator("Higher Timeframe", overlay=True)
higher_close = request.security("BTCUSDT", "2", close)
plot(higher_close, "Higher Close")
""",
    chart_bars,
    data_provider=provider,
    executor_mode="inline",
)

print(result.values("Higher Close"))
```

With `gaps="off"` this carries the latest requested value forward. With the data
above, the plotted values are:

```text
[10.0, 10.0, 30.0, 30.0]
```

Use `gaps="on"` when the host should render values only on exact requested bar
timestamps:

```python
higher_close = request.security("BTCUSDT", "2", "close", gaps="on")
```

Provider capabilities are optional. If a provider declares them, Pyne accepts
the canonical names `request.security` and `request.security_lower_tf`, plus the
aliases listed in `pn.schema()["requestProvider"]["supportedApis"]`. Disabled or
missing list/set capabilities return `PYNE_UNSUPPORTED_FEATURE` before
`get_ohlcv(...)` is called.

Use a callable expression thunk when the requested context should compute an
indicator:

```python
higher_sma = request.security(
    "BTCUSDT",
    "2",
    lambda ctx: ctx.ta.sma(ctx.close, 2),
)
```

The lambda receives a requested-context object. `ctx.close[1]` means the
previous requested bar, not the previous chart bar:

```python
higher_previous = request.security(
    "BTCUSDT",
    "2",
    lambda ctx: ctx.close[1],
)
```

Tuple field expressions and tuple thunks return multiple aligned series:

```python
higher_open, higher_close = request.security("BTCUSDT", "2", ("open", "close"))

higher_body, higher_range = request.security(
    "BTCUSDT",
    "2",
    lambda ctx: (ctx.close - ctx.open, ctx.high - ctx.low),
)
```

`request.security_lower_tf()` uses the same provider contract, but returns one
grouped result per chart bar:

```python
lower_close = request.security_lower_tf("BTCUSDT", "1", lambda ctx: ctx.close)
plot(lower_close.size(), "Lower TF Count")
plot(lower_close.last(), "Lower TF Last Close")
```

Lower-timeframe tuple expressions are also supported:

```python
lower_open, lower_close = request.security_lower_tf(
    "BTCUSDT",
    "1",
    lambda ctx: (ctx.open, ctx.close),
)
```

Successful request calls append host-facing diagnostics to
`result.meta["requestDiagnostics"]`. Each entry records the canonical `api`,
requested `symbol` / `timeframe`, `start` / `end`, returned `bars`, `cacheHit`,
`ignoreInvalidSymbol`, and `status`. Provider failures include
`errorDetail.requestProviderCategory` and `errorDetail.requestProviderRequest`
so hosts do not have to parse error messages.

Current scope:

- OHLCV field expressions such as `close`, `high`, `hlc3`, or `"close"`.
- History references on fields, such as `close[1]`.
- Callable expression thunks such as `lambda ctx: ctx.ta.sma(ctx.close, 2)`.
- Tuple field expressions and tuple thunks for multi-return requests.
- `request.security_lower_tf()` grouped results, including tuple expressions and
  array-like helpers such as `.size()`, `.first()`, `.last()`, `.sum()`, and
  `.max()`.
- Provider capabilities, metadata, cache diagnostics, and structured request
  error details.
- Host-owned data retrieval with Pyne-owned alignment semantics.

Current limits:

- No direct capture of already evaluated Python expressions such as
  `request.security("BTCUSDT", "2", ta.sma(close, 2))`.
- No nested `request.security()` expressions.
- No built-in exchange/network fetcher.
- Process execution requires a pickleable provider; use `executor_mode="inline"`
  for local adapters with live connections.
