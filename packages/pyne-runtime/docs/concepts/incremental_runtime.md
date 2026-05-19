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

