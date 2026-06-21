# Output Schema

Pyne results use `schemaVersion = 1`.
The strategy report contract has its own version at
`pn.schema()["strategyReport"]["schemaVersion"]`.
Schema migration policy and version history are documented in
[Schema Migrations](schema_migrations.md).

Top-level result keys:

- `schemaVersion`: output schema version.
- `paramSchemaVersion`: parameter schema version for `param_schema`.
- `ok`: whether execution succeeded.
- `error`: error message when execution failed.
- `code`: stable error code when execution failed.
- `errorDetail`: structured error detail when execution failed.
- `lines`: backward-compatible flat plotted series.
- `output`: structured output collections.
- `param_schema`: input parameter declarations collected from scripts.
- `meta`: indicator metadata collected from `indicator()`.

Parameter schema entry:

```json
{
  "id": "Length",
  "key": "Length",
  "type": "int",
  "default": 20,
  "current": 25,
  "title": "Length",
  "tooltip": "Moving average period.",
  "group": "Moving Average",
  "inline": "ma",
  "confirm": true,
  "minval": 1,
  "maxval": 200,
  "step": 1
}
```

Numeric entries also include backward-compatible `min` and `max` aliases when
bounds are declared.

`id` currently matches `key`. Hosts should prefer `id` for stable UI identity
and `key` for parameter override maps.
If repeated input declarations use the same display title, the first entry
keeps that title as `id` / `key` and later entries receive stable suffixes such
as `_2` and `_3`.

Supported parameter `type` values are `int`, `float`, `bool`, `string`,
`color`, `source`, `timeframe`, `symbol`, `session`, and `time`. Timeframe,
symbol, and session inputs return strings. Time inputs return Unix timestamps in
seconds.

If params supplied to `pn.run(..., params=...)`, `pyne run --param`, or
`pyne run --params-json` do not satisfy the declared input schema, the result
uses `code = "PYNE_INVALID_PARAM"`.

Structured output keys:

- `lines`
- `histograms`
- `markers`
- `hlines`
- `fills`
- `bgcolors`
- `labels`
- `barcolors`
- `signals`
- `strategy`
- `objects`
- `object_events`

Schema bundle keys:

- `input`: OHLCV input contract.
- `output`: top-level result and structured output contract.
- `params`: collected script parameter contract.
- `requestProvider`: host data-provider contract for `request.*`.
- `strategyReport`: strategy report contract for `output["strategy"]`.
- `scriptNamespace`: grouped script top-level names for host editor
  autocomplete.

Result `meta` may include `requestDiagnostics` when a script calls
`request.security()` or `request.security_lower_tf()`. The field is described
by `pn.schema()["requestProvider"]["diagnostics"]`.
Hosts can discover stable request APIs and their capability aliases from
`pn.schema()["requestProvider"]["supportedApis"]`.

Output migration policy:

`pn.schema()["output"]["migration"]` exposes the current output schema version,
the breaking-change checklist, and version-specific migration notes. Hosts can
read this section alongside `schemaVersion` when deciding how to handle output
contract upgrades.

Point format:

```json
{"time": 1710000000, "value": 123.45}
```

Renderer contract:

`pn.schema()["output"]["renderables"]` describes the stable field contract for
host renderers. Hosts should branch on `pn.schema()["output"]["schemaVersion"]`
before relying on these fields.

- `lines`: entries include `id`, `title`, `color`, `linewidth`, `style`,
  `pane`, and `data`; data points include `time` and `value`, with optional
  per-point `color`.
- `histograms`: entries include `title`, `color_up`, `color_down`, `pane`, and
  `data`; data points include `time` and `value`, with optional per-point
  `color`.
- `markers`: entries include marker display metadata plus `data`; data points
  include `time`, `shape`, `color`, `text`, `position`, `size`, and `pane`.
  Arrow and character markers may add `direction`, `value`, `height`, `char`,
  or `textcolor`.
- `hlines`: entries include `price`, `title`, `color`, `linestyle`,
  `linewidth`, and `pane`.
- `fills`: entries include `plot1_id`, `plot2_id`, `color`, `title`, and
  `pane`.
- `bgcolors`: entries include `color`, `pane`, `title`, and `regions`; each
  region includes `time`.
- `labels`: legacy simple text labels with `text`, `position`, `color`,
  `textcolor`, `pane`, and `style`. Prefer drawing object `objects.labels` for
  Pine-like labels.
- `barcolors`: entries contain `data`; each data point includes `time` and
  `color`.
- `signals`: entries include `name`, `side`, `message`, `pane`, and `data`;
  signal data points include `time`, `side`, `name`, and `message`, with
  optional `strength`, `price`, and `payload`.

Drawing object snapshot format:

```json
{
  "objects": {
    "lines": [
      {
        "id": "line_1",
        "x1": 0,
        "y1": 123.0,
        "x2": 10,
        "y2": 130.0,
        "color": "#2196f3",
        "width": 2,
        "style": "solid",
        "extend": "none",
        "xloc": "bar_index",
        "pane": "main"
      }
    ],
    "labels": [
      {
        "id": "label_2",
        "x": 10,
        "y": 130.0,
        "text": "Breakout",
        "color": "#ffffff",
        "textcolor": "#000000",
        "style": "label_down",
        "size": "normal",
        "xloc": "bar_index",
        "pane": "main"
      }
    ],
    "boxes": [
      {
        "id": "box_3",
        "left": 0,
        "top": 130.0,
        "right": 10,
        "bottom": 123.0,
        "bgcolor": "rgba(38,166,154,0.15)",
        "border_color": "#26a69a",
        "border_width": 1,
        "border_style": "solid",
        "xloc": "bar_index",
        "pane": "main"
      }
    ],
    "tables": [
      {
        "id": "table_4",
        "position": "top_right",
        "columns": 2,
        "rows": 1,
        "bgcolor": "#ffffff",
        "frame_color": "#787b86",
        "frame_width": 1,
        "border_color": "#787b86",
        "border_width": 1,
        "pane": "main",
        "cells": [
          {
            "column": 0,
            "row": 0,
            "text": "Close",
            "text_color": "#000000",
            "bgcolor": null,
            "width": null,
            "height": null,
            "text_halign": "center",
            "text_valign": "middle"
          }
        ]
      }
    ]
  }
}
```

Drawing object contract:

`pn.schema()["output"]["objects"]` describes the stable snapshot groups under
`output["objects"]`: `lines`, `labels`, `boxes`, and `tables`. All drawing
objects include `id` and `pane`; table cells include `column`, `row`, `text`,
`text_color`, `bgcolor`, `width`, `height`, `text_halign`, and `text_valign`.

Incremental drawing object event contract:

`pn.schema()["output"]["objectEvents"]` describes `output["object_events"]`.
Each event includes `action`, `kind`, `id`, and `object`.

- `action`: `create`, `update`, or `delete`.
- `kind`: `line`, `label`, `box`, or `table`.
- Optional bar context: `time`, `bar_index`, `confirmed`, and `realtime`.

Host consumption example:

```python
import pyne_runtime as pn

data = pn.read_ohlcv("examples/sample_ohlcv.csv")
result = pn.run("examples/host_output_contract.py", data)
schema = pn.schema()["output"]

if result.schema_version != schema["schemaVersion"]:
    raise RuntimeError("Unsupported Pyne output schema version")

for key, contract in schema["renderables"].items():
    for entry in result.output.get(key, []):
        for field in contract["required"]:
            assert field in entry
```

The packaged `examples/host_output_contract.py` script emits representative
renderer collections, drawing objects, and signals for host integration tests.

Strategy event format:

```json
{
  "strategy": {
    "orders": [
      {
        "time": 1710000000,
        "id": "Long",
        "type": "entry",
        "side": "long",
        "qty": 1.0,
        "price": 123.45,
        "position_after": 1.0,
        "comment": ""
      },
      {
        "time": 1710000600,
        "id": "Long Exit",
        "from_entry": "Long",
        "type": "exit",
        "side": "flat",
        "qty": 1.0,
        "price": 130.0,
        "position_after": 0.0,
        "reason": "limit",
        "comment": ""
      }
    ],
    "position": {
      "size": 1.0,
      "side": "long",
      "avg_price": 123.45
    }
  }
}
```

Strategy report contract:

`pn.schema()["strategyReport"]` describes the stable sections under
`output["strategy"]`:

- `orders`: compact fill/cancel/rejection ledger rows.
- `position`: final strategy position snapshot with `size`, `side`, and
  `avg_price`.
- `summary`: capital, equity, net/open/gross profit, commission, fill-policy,
  intrabar-path, and margin settings.
- `risk`: configured deterministic risk limits and current lock state.
- `closedtrades`: closed entry-lot rows with entry/exit ids, prices, profit,
  commission, and net profit.
- `opentrades`: open entry-lot rows with entry id, side, size, entry price,
  optional commission, and current open profit.
- `lifecycle`: expanded order lifecycle rows for pending, fill, cancel, and
  rejection phases.

Internal trade fields beginning with `_` are not part of the public report.

Pane values:

- `main`
- `separate`

See [error codes](error_codes.md) for structured failure payloads.

Request provider failures may add `requestProviderCategory` to `errorDetail`.
The value matches a key under
`pn.schema()["requestProvider"]["errorCategories"]`, allowing hosts to display
request integration failures without parsing error strings.
They may also add `requestProviderRequest`, whose fields are described by
`pn.schema()["requestProvider"]["errorDetail"]["requestRequired"]`.
