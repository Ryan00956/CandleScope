# Indicator Module

Event-driven, incremental indicator computation engine for CandleScope.

## Architecture

```
indicator/
├── __init__.py          # Auto-registration + public API
├── types.py             # IndicatorKey, IndicatorResult, IndicatorSpec, ...
├── base.py              # Indicator abstract base class
├── events.py            # IndicatorEvent, IndicatorEventType
├── registry.py          # IndicatorRegistry (singleton: registry)
├── engine.py            # IndicatorEngine
└── indicators/          # Built-in implementations
    ├── ma.py            # MA  — Simple Moving Average
    ├── ema.py           # EMA — Exponential Moving Average
    ├── macd.py          # MACD — Moving Average Convergence Divergence
    ├── rsi.py           # RSI — Relative Strength Index
    ├── boll.py          # BOLL — Bollinger Bands
    └── atr.py           # ATR — Average True Range
```

## Design Principles

1. **Indicators are instances, not functions.** `MA(close, 20)` and `MA(close, 60)` are two separate instances, each with their own state. Instances are uniquely identified by `IndicatorKey` (symbol + interval + name + params hash).

2. **Two-phase updates.** Every indicator separates `update_partial()` (preview values for a forming bar) from `update_closed()` (committed state advance). This lets the frontend show real-time preview values while strategies only act on confirmed closes.

3. **O(1) incremental updates.** Built-in indicators maintain rolling state (sums, EMAs, etc.) so that each new bar is processed in constant time — no full-series recomputation on every tick.

4. **Instance caching & deduplication.** The engine caches instances by `IndicatorKey`. Multiple subscribers (charts, strategies, alerts) share the same computation.

5. **Standardized output format.** Every indicator produces `IndicatorResult` containing one or more `IndicatorOutput` series, each with `OutputPoint(timestamp, value)` data. The frontend can render any indicator uniformly.

6. **Registry-driven.** All indicators (built-in and user-defined) register with the same `IndicatorRegistry`. The API exposes specs (param schemas, output definitions) so the frontend can auto-generate configuration UIs.

## Quick Start

```python
from app.indicator import create_engine, registry

# List available indicators
for spec in registry.list_specs():
    print(spec.name, spec.display_name)

# Compute an indicator
engine = create_engine()
result = engine.compute("BTCUSDT", "1m", "MA", {"period": 20}, bars)

# Access outputs
for name, output in result.outputs.items():
    print(f"{output.display_name}: {output.latest_value}")

# JSON-serializable dict
print(result.to_dict())
```

## Lifecycle

```
DataManager bar events
    │
    ├── BAR_CLOSED ──→ engine.on_bar_closed(symbol, interval, bar)
    │                     └── instance.update_closed(bar)
    │                         └── emit INDICATOR_UPDATED
    │
    ├── BAR_UPDATED ─→ engine.on_bar_updated(symbol, interval, bar)
    │                     └── instance.update_partial(bar)
    │                         └── emit INDICATOR_PREVIEW
    │
    └── BACKFILL ────→ engine.on_bars_backfilled(symbol, interval, bars)
                          └── instance.recompute(bars)
                              └── emit INDICATOR_RECOMPUTED
```

## Built-in Indicators

| Name | Category | Outputs | Pattern Validated |
|------|----------|---------|-------------------|
| MA   | 趋势     | `ma`    | Window / rolling sum |
| EMA  | 趋势     | `ema`   | Recursive state |
| MACD | 趋势     | `dif`, `dea`, `hist` | Multi-output |
| RSI  | 震荡     | `rsi`   | Stateful oscillator |
| BOLL | 波动     | `middle`, `upper`, `lower` | Overlay + rolling std |
| ATR  | 波动     | `atr`   | Multi-input (H/L/C) |

## Adding a New Indicator

1. Create a file in `indicators/` (e.g. `kdj.py`)
2. Subclass `Indicator` and implement `init()`, `update_partial()`, `update_closed()`
3. Define `get_spec()` with param schema
4. Register in `__init__.py`: `registry.register(KDJIndicator)`

```python
class KDJIndicator(Indicator):
    name = "KDJ"
    output_specs = ["k", "d", "j"]

    def init(self, bars): ...
    def update_partial(self, bar): ...
    def update_closed(self, bar): ...

    @classmethod
    def get_spec(cls) -> IndicatorSpec: ...
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/indicators/registry` | List all indicator specs |
| GET | `/api/v1/indicators/registry/{name}` | Get single indicator spec |
| POST | `/api/v1/indicators/compute` | Compute indicator on OHLCV data |

### POST `/api/v1/indicators/compute`

```json
{
  "name": "MACD",
  "params": {"fast": 12, "slow": 26, "signal": 9},
  "symbol": "BTCUSDT",
  "interval": "1m",
  "ohlcv": [
    {"time": 1710000000, "open": 65000, "high": 65100, "low": 64900, "close": 65050, "volume": 100}
  ]
}
```

Response:

```json
{
  "ok": true,
  "error": null,
  "result": {
    "indicator_id": "BTCUSDT:1m:MACD:a3f1c8...",
    "name": "MACD(12,26,9)",
    "outputs": {
      "dif": {"name": "DIF", "data": [{"time": 1710000000, "value": 123.45}], ...},
      "dea": {"name": "DEA", "data": [...], ...},
      "hist": {"name": "MACD Hist", "type": "histogram", "data": [...], ...}
    },
    "meta": {"pane": "separate", "overlay": false, "warmup_period": 34}
  }
}
```
