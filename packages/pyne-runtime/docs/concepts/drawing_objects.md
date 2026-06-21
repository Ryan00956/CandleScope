# Drawing Objects

Pyne supports Pine-like drawing object handles for dynamic chart annotations.
The current object surface covers `line`, `label`, `box`, and `table`.

```python
indicator("Breakout", overlay=True)

level = line.new(bar_index[5], high[5], bar_index, high)
line.set_color(level, color.orange)

tag = label.new(bar_index, high, text="Breakout")
label.set_color(tag, color.green)

zone = box.new(bar_index[5], high[5], bar_index, low)
box.set_bgcolor(zone, color.new(color.green, 85))

summary = table.new(position.top_right, 2, 1)
table.cell(summary, 0, 0, "Close")
table.cell(summary, 1, 0, close)
```

## Handles

`line.new()`, `label.new()`, `box.new()`, and `table.new()` return opaque object
handles. Scripts should pass those handles back to namespace methods such as
`line.set_color()`, `label.set_text()`, `box.set_bgcolor()`, or `table.cell()`.

Handles are not chart data by themselves. They identify mutable drawing objects
inside the current execution.

## Batch Snapshot Semantics

Pyne batch execution returns the final drawing state:

```json
{
  "objects": {
    "lines": [
      {"id": "line_1", "x1": 0, "y1": 10.0, "x2": 5, "y2": 12.0}
    ],
    "labels": [
      {"id": "label_2", "x": 5, "y": 12.0, "text": "Breakout"}
    ],
    "boxes": [
      {"id": "box_3", "left": 0, "top": 12.0, "right": 5, "bottom": 10.0}
    ],
    "tables": [
      {"id": "table_4", "position": "top_right", "columns": 2, "rows": 1}
    ]
  }
}
```

Setter calls update the final snapshot. `delete()` removes the object from the
snapshot.

## Incremental Event Semantics

Incremental callbacks can use the same global `line`, `label`, `box`, and
`table` namespaces. Handles are commonly stored in `ctx.state()` cells so later
bars can mutate the same object:

```python
indicator("Live level", mode="incremental", overlay=True)

def on_bar(ctx, bar):
    level = ctx.state("level")
    if level.value is None:
        level.value = line.new(ctx.bar_index, bar.close, ctx.bar_index, bar.close)
    else:
        line.set_xy2(level.value, ctx.bar_index, bar.close)
```

Incremental results include the current object snapshot under
`output["objects"]` and a time-filtered event stream under
`output["object_events"]`:

```json
{
  "object_events": [
    {
      "time": 1700000000,
      "bar_index": 10,
      "confirmed": true,
      "realtime": false,
      "action": "update",
      "kind": "line",
      "id": "line_1",
      "object": {"id": "line_1", "x2": 10, "y2": 102.5}
    }
  ]
}
```

`seed()` returns the historical event stream. `on_bar_closed()` returns only the
events for that committed bar. `on_bar_updated()` runs on a cloned preview
context, so preview object events and preview snapshots do not mutate the
persistent session.

## Series Coordinates

Object coordinate arguments may be scalars or `PyneSeries` values. When a series
is passed as an object coordinate, Pyne resolves it to the latest valid value in
that series.

This keeps common Pine-like expressions usable:

```python
line.new(bar_index[2], close[2], bar_index, close)
```

In batch execution, this creates a line from the current last bar's
two-bars-back coordinate to the current last bar coordinate.

## Current Scope

Supported now:

- `line.new`, `line.set_*`, `line.delete`
- `label.new`, `label.set_*`, `label.delete`
- `box.new`, `box.set_*`, `box.delete`
- `table.new`, `table.cell`, `table.set_*`, `table.clear`, `table.delete`
- `position.*` constants for table placement
- legacy `label("text")` fixed-position labels
- final snapshot output under `output["objects"]`
- incremental create/update/delete events under `output["object_events"]`
- object count limits through `PyneSettings.max_drawing_objects`
