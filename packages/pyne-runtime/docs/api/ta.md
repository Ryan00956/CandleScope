# `ta` API

The `ta` namespace is injected into scripts.

Common helpers:

```python
ta.sma(close, 20)
ta.ema(close, 20)
ta.wma(close, 20)
ta.rsi(close, 14)
ta.macd(close, 12, 26, 9)
ta.bb(close, 20, 2)
ta.atr(14)
ta.highest(close, 20)
ta.lowest(close, 20)
ta.crossover(a, b)
ta.crossunder(a, b)
```

Several helpers are also exposed as top-level script functions, such as `crossover()`, `crossunder()`, `highest()`, and `lowest()`.

