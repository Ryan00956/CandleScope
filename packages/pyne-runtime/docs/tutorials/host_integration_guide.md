# Host Integration Guide

This guide shows how a host application can embed Pyne Runtime without taking
ownership of Pine-like execution semantics. The host owns data, UI, persistence,
and rendering. Pyne owns script execution, request alignment, parameter
collection, deterministic strategy reports, and structured output contracts.

## 1. Read Contracts First

Use `pn.schema()` during startup or adapter initialization:

```python
import pyne_runtime as pn

contracts = pn.schema()
output_schema = contracts["output"]
param_schema = contracts["params"]
request_provider_schema = contracts["requestProvider"]
script_namespace = contracts["scriptNamespace"]
```

Host applications should branch on `schemaVersion` for any contract they
consume. `scriptNamespace` is useful for editor autocomplete, quick API pickers,
and script-authoring hints.

## 2. Run A Script

Most hosts can start with `pn.run()`:

```python
result = pn.run(
    """
length = input.int(20, "Length", minval=1)
plot(ta.sma(close, length), "SMA")
""",
    chart_bars,
    params={"Length": 10},
    executor_mode="inline",
)
```

Use `PyneRuntime` when the host wants to reuse a configured runtime object.

## 3. Build Parameter UI

After a run, `result.param_schema` contains the script-declared input controls.
The top-level result also has `paramSchemaVersion`.

```python
for item in result.param_schema:
    render_control(
        id=item["id"],
        title=item["title"],
        type=item["type"],
        current=item["current"],
        options=item.get("options"),
        group=item.get("group"),
        tooltip=item.get("tooltip"),
    )
```

Hosts should submit overrides with stable parameter ids:

```python
result = pn.run(script, chart_bars, params={"Length": 50})
```

## 4. Provide Request Data

Pyne does not fetch market data. A host-backed provider supplies requested
OHLCV bars while Pyne aligns requested results back to chart bars.

```python
class HostProvider:
    capabilities: pn.RequestCapabilities = {
        "request.security": True,
        "request.security_lower_tf": True,
    }

    def get_ohlcv(
        self,
        symbol: str,
        timeframe: str,
        start: int,
        end: int,
    ) -> list[pn.OHLCVBar]:
        return load_bars(symbol, timeframe, start, end)

    def get_request_metadata(self, symbol: str, timeframe: str) -> pn.RequestMetadata:
        return {
            "syminfo": {"tickerid": symbol, "mintick": 0.01},
            "timeframe": timeframe,
            "session": {"ismarket": True},
        }
```

Local adapters with sockets, database handles, or closures should use
`executor_mode="inline"` because the process executor requires a pickleable
provider.

## 5. Consume Structured Output

Use `result.output` for host rendering. The renderer contract is described by
`pn.schema()["output"]["renderables"]`.

```python
output = result.output
renderables = pn.schema()["output"]["renderables"]

for line in output.get("lines", []):
    required = renderables["lines"]["required"]
    if all(field in line for field in required):
        draw_line_series(line["title"], line["data"], color=line["color"])
```

Drawing object snapshots live under `output["objects"]`. Incremental drawing
changes live under `output["object_events"]`. Strategy reports live under
`output["strategy"]` and are described by `pn.schema()["strategyReport"]`.

## 6. Handle Errors And Validation

Run `pn.validate()` before saving user-authored scripts:

```python
diagnostics = pn.validate(script_text)
```

Execution failures return structured result fields such as `ok`, `code`,
`error`, and `errorDetail`. Hosts should display `code` and `error` directly,
and can map known codes through [Error Codes](../reference/error_codes.md).

## 7. Release And Compatibility Checks

Before upgrading the embedded Pyne version, run the package quality gate and
review schema versions:

```bash
scripts/check.ps1
```

See [Quality Gates](../development/quality_gates.md),
[Schema Migrations](../reference/schema_migrations.md), and
[Release Process](../reference/release_process.md) for upgrade policy and
release smoke checks.
