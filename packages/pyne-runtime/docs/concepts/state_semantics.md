# State Semantics

Pyne provides runtime-scoped state cells through `var()` and `pyne.var()`.

```python
counter = var("counter", 0)
counter.set(counter.get() + 1)
plot(counter.get(), "Counter")
```

State is isolated per script execution. Running the same script twice creates fresh cells.

## Reusing A Cell

Calling `var()` with the same name returns the same cell for the current execution:

```python
trend = var("trend", 0)
trend.set(1)

same = var("trend", 99)
plot(same.get(), "Trend")  # 1
```

## Carrying State Across Bars

Batch scripts are vectorized, so ordinary Python assignment does not run once per bar. Use `set_each()` when a series of updates should carry the prior state through missing values:

```python
trend = pyne.var("trend", 0)
updates = where(bar_index == 0, 1, where(bar_index == 2, -1, na))
plot(trend.set_each(updates), "Trend")
```

The output is:

```text
1, 1, -1, -1
```

`na` means "keep the previous state".

This is useful for regime-like indicators:

```python
fast = ta.ema(close, 12)
slow = ta.ema(close, 26)

trend = pyne.var("trend", 0)
updates = where(crossover(fast, slow), 1, where(crossunder(fast, slow), -1, na))
plot(trend.set_each(updates), "Trend")
```

## Intrabar Preview State

Incremental callbacks can use `ctx.varip()` for realtime preview state:

```python
def on_preview(ctx, bar):
    ticks = ctx.varip("ticks", 0)
    ticks.value += 1
    ctx.plot("Preview Ticks", ticks.value)
```

`ctx.varip()` persists across repeated `on_bar_updated()` calls for the same
realtime bar. It resets when a new preview bar starts and before confirmed
`on_bar()` callbacks, so preview-only state does not mutate the persistent
session snapshot.

Inside incremental callbacks, `state()` / `var()` and `pyne.state()` /
`pyne.var()` are aliases for the current callback context's persistent
`ctx.state()`. `varip()` and `pyne.varip()` are aliases for `ctx.varip()`.
Using these callback-local aliases at script top level or inside `init()` is a
security error; use `ctx.state()` from callbacks or initialize ordinary helper
objects in `init()`.

## API

- `var(name, default=None)`: create or return a runtime-scoped cell.
- `state(name, default=None)`: alias for `var()`.
- `pyne.var(name, default=None)`: namespace form.
- `pyne.state(name, default=None)`: namespace alias.
- `cell.get()`: return current cell value.
- `cell.set(value)`: set and return the value.
- `cell.update(func)`: update from a callable.
- `cell.set_each(updates, default=None)`: apply per-bar updates, carrying prior state through `na`.
- `cell.reset(value=None)`: reset to default or explicit value.
- Incremental `ctx.state(name, default=None)`: persistent state for committed
  incremental callbacks.
- Incremental `ctx.varip(name, default=None)`: intrabar preview state for the
  current realtime bar.
- Incremental `state(name, default=None)` / `var(name, default=None)` and
  `pyne.state(...)` / `pyne.var(...)`: callback-local aliases for `ctx.state()`.
- Incremental `varip(name, default=None)` and `pyne.varip(...)`: callback-local
  aliases for `ctx.varip()`.

Current scope:

- `var()` is runtime-scoped and deterministic in batch mode.
- `set_each()` provides Pine-like carry-forward behavior for series updates.
- `ctx.varip()` is incremental-only and scoped to preview updates for one
  realtime bar.
- Full recursive bar-by-bar assignment semantics will be refined in later runtime phases.
