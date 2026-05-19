# Plot API

Plot helpers are injected into scripts.

```python
indicator("Bands", overlay=True)

p1 = plot(upper, "Upper", color=color.blue)
plot(mid, "Middle", color=color.orange)
p2 = plot(lower, "Lower", color=color.blue)
fill(p1, p2, color="rgba(59,130,246,0.08)")
```

Common outputs:

- `plot()`
- `bar()`
- `hline()`
- `fill()`
- `marker()`
- `bgcolor()`
- `barcolor()`
- `emit_signal()`
- `alertcondition()`

