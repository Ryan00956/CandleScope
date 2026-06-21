# Incremental Runtime

Batch scripts are the default. Incremental scripts define `on_bar(ctx, bar)` and can maintain state across bars.

```python
indicator("Incremental MA", mode="incremental", overlay=True)

def init(ctx):
    ctx.ta.sma("ma", period=20)

def on_bar(ctx, bar):
    value = ctx.ta.sma("ma").update(bar.close)
    ctx.plot("MA", value, color=color.orange)
```

Incremental mode is useful for realtime hosts because updates can avoid recomputing the full history.

Callback context exposes Pine-like scalar clock values for the current event:

- `ctx.bar_index` and `bar.bar_index`
- `ctx.last_bar_index` and `bar.last_bar_index`
- `ctx.barstate.isrealtime`
- `ctx.barstate.isnew`
- `ctx.barstate.isconfirmed`
- `ctx.barstate.ishistory`

`on_bar_updated()` runs as an unconfirmed realtime preview on a cloned context,
so preview state does not mutate the persistent session. `on_bar_closed()`
confirms the realtime bar and advances persistent state.

## Host Integration Flow

A realtime host usually keeps one `PyneIncrementalSession` per chart/script
instance:

```python
import pyne_runtime as pn

session = pn.PyneIncrementalSession(
    script=script,
    params=params,
    settings=pn.PyneSettings(executor_mode="inline"),
)
```

Seed historical bars once before streaming live events:

```python
seeded = session.seed(history_bars)
render_snapshot(seeded)
```

Each bar dict should include `time`, `open`, `high`, `low`, `close`, and
`volume`. Optional fields such as `time_close` and session flags are preserved
when present. The seed result is committed history: its plotted lines, markers,
drawing object snapshot, object events, and strategy report can be rendered as
the durable chart state.

Committed incremental `ctx.plot()` and `ctx.marker()` output follows the same
host-facing renderer contract as batch `plot()` and `marker()` for the covered
surface: line color, width, style, histogram/columns output, marker
shape/location/size, and default pane assignment from `indicator(...,
overlay=...)`. Explicit `pane=` values still override the indicator default.

Send unconfirmed realtime ticks or partial OHLCV updates through
`on_bar_updated()`:

```python
preview = session.on_bar_updated(live_bar)
render_preview(preview)
```

The preview result is temporary. It may include preview-only plot points,
object snapshots, `output["object_events"]`, or strategy orders/fills, but it
does not mutate the persistent session. Repeated previews for the same bar time
reuse `ctx.varip()` cells, while `ctx.state()` changes remain isolated inside
the cloned preview context.

Treat preview drawing objects and strategy output as an overlay. A preview may
create an object or submit a strategy order, including a pending stop/limit
order, but those preview-only objects, lifecycle entries, orders, fills, and
trade-ledger changes are not visible from `snapshot_result()` and are not
carried into the later `on_bar_closed()` result.

When the realtime bar is final, submit the final OHLCV through
`on_bar_closed()`:

```python
committed = session.on_bar_closed(final_bar)
merge_committed_result(committed)
```

This callback advances persistent state, TA helpers, drawing objects, and the
strategy ledger. If a preview for the same `time` was already seen,
`ctx.barstate.isnew` is false during the confirmed callback; if the host sends
only a closed bar, it is true.

`ctx.state()` cells keep committed history snapshots. Use `cell[1]` to read the
previous confirmed bar's value. If the cell stores an `array`, `map`, or
`matrix`, the historical value is a collection snapshot, so mutating the
current collection does not alter previous-bar state. Nested arrays, maps, and
matrices are snapshotted recursively, so mutating an inner collection on the
current bar does not change the previous bar's nested collection view.

`snapshot_result()` returns the current committed session without replaying the
script:

```python
current = session.snapshot_result()
```

Use it when a UI reconnects, when a viewport range changes, or after a host
needs to discard a preview overlay and redraw the last committed state.

For multi-chart services, `PyneIncrementalSessionManager` provides a small
in-process shared-session cache:

```python
manager = pn.PyneIncrementalSessionManager()
shared = manager.acquire(chart_key, lambda: pn.PyneIncrementalSession(script=script))

try:
    seeded_or_snapshot = manager.seed_or_snapshot(shared, history_bars)
    update = manager.process_bar(shared, live_bar, preview=True)
    committed = manager.process_bar(shared, final_bar, preview=False)
finally:
    manager.release(chart_key)
```

`seed_or_snapshot()` seeds once and returns snapshots afterward. `process_bar()`
deduplicates identical repeated bar events, which helps UI transports that can
retry the same message.

## Consuming Object Events

Incremental drawing output has two layers:

- `output["objects"]`: the current object snapshot for the returned result.
- `output["object_events"]`: create/update/delete events scoped to the returned
  seed, preview, or committed bar range.

Preview object events have `confirmed: false` and should be rendered as a
temporary overlay. Confirmed events have `confirmed: true` and can be merged
into the durable UI object store. When a preview is replaced by a new preview
for the same bar, redraw from the latest preview result. When a bar closes,
discard preview-only UI state and merge the `on_bar_closed()` result.

The same overlay rule applies to strategy output returned by a preview. Hosts
can display preview orders, fills, lifecycle rows, and position changes as
temporary state, but should merge only the strategy report returned by
`on_bar_closed()` into the durable ledger.

## Internal Responsibilities

Incremental runtime code is split by lifecycle role:

- `incremental.bar` defines `IncrementalBar` and scalar barstate wiring.
- `incremental.result` defines `IncrementalPyneResult`.
- `incremental.limits` tracks drawing, state, and resource limits.
- `incremental.ta` owns step-by-step technical-analysis helpers.
- `incremental.drawing` owns line, label, box, and table mutation helpers.
- `incremental.strategy` owns scalar current-bar strategy state and callback
    reporting, while reusing shared batch strategy constants and pure helpers.
- `incremental.context` exposes the callback-facing `ctx` object.
- `incremental.session` owns script compilation, preview cloning, and confirmed
    bar commits.
- `incremental.manager` provides reusable shared-session orchestration.
- `incremental.detection` decides whether a script should use incremental mode.

Public imports remain stable through `pyne_runtime.incremental` and the package
top level. These imports continue to work:

```python
from pyne_runtime.incremental import PyneIncrementalSession
from pyne_runtime import PyneIncrementalSession
```
