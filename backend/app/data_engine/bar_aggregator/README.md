# Bar Aggregator

[![English](https://img.shields.io/badge/Language-English-blue)](#) [![简体中文](https://img.shields.io/badge/语言-简体中文-red)](README_zh.md)


> Builds OHLCV candles from heterogeneous market data streams with a layered, extensible architecture.

## Architecture

```
MarketEvent / FetchedBar / CustomData
        │
        ▼
┌─ L1: EventRouter ─────────────────────────┐
│   normalize → BarInput                     │
│   dispatch by (symbol, target_interval)    │
└───────────────┬────────────────────────────┘
                │  BarInput
                ▼
┌─ L2: TimeBucketEngine ─────────────────────┐
│   compute_bucket(open_time_ms) → bucket_ms │
│   alignment: epoch / midnight / custom     │
└───────────────┬────────────────────────────┘
                │  bucket_start_ms
                ▼
┌─ L3: BarStateEngine ───────────────────────┐
│   apply(symbol, bucket, input) → BarState  │
│   merge strategy: OHLCV / Heikin-Ashi / …  │
└───────────────┬────────────────────────────┘
                │  BarState + BarStateChange
                ▼
┌─ L4: Finalizer ───────────────────────────┐
│   strategy chain evaluation                │
│   source_close → composite → event → time  │
└───────────────┬────────────────────────────┘
                │  BarEvent (if closed)
                ▼
┌─ L5: Publisher ───────────────────────────┐
│   emit(CREATED / UPDATED / CLOSED / ...)  │
│   → callbacks + async iterators           │
└───────────────────────────────────────────┘
```

## Quick Start

```python
from app.data_engine.bar_aggregator import BarAggregator

agg = BarAggregator()
agg.add_target("BTCUSDT", "1m")
agg.add_target("BTCUSDT", "5m")
agg.add_target("BTCUSDT", "91m")  # custom interval

# Subscribe to closed bars
agg.publisher.on_bar_closed(save_to_database)

# Start background timeout checker
await agg.start()

# Feed data from ingestion
await agg.on_market_event(market_event)

# Feed data from backfill
await agg.on_backfill_bars("BTCUSDT", "1m", historical_bars)
```

## Layers

### L1: EventRouter (`router.py`)

- Accepts `MarketEvent` (from ingestion), `FetchedBar` (from backfill), or custom data
- Converts all inputs to unified `BarInput` format
- Dispatches to all matching `(symbol, interval)` targets
- Supports user-registered `BarInputAdapter` for custom data sources

### L2: TimeBucketEngine (`time_bucket.py`)

- Pure-functional, stateless computation
- Given a timestamp + interval → which bucket it belongs to
- Supports alignment modes: `epoch`, `midnight`, `market`, `custom`
- Replaceable via `BucketCalculator` protocol (session-based, volume-based, etc.)

### L3: BarStateEngine (`bar_state.py`)

- Maintains OHLCV accumulation state per `(symbol, bucket)`
- Default merge: `O=first, H=max, L=min, C=last, V=sum`
- Replaceable via `BarMergeStrategy` protocol (Heikin-Ashi, Renko, etc.)
- Auto-evicts old bars to bound memory usage

### L4: Finalizer (`finalizer.py`)

- Strategy chain pattern — first match wins
- Built-in strategies:
  - `SourceCloseFinalizer` — exchange `is_closed=True` (Binance `x=true`)
  - `CompositeCloseFinalizer` — last component bar closed (custom intervals)
  - `EventDrivenFinalizer` — next bucket's data arrived
  - `TimeBasedFinalizer` — safety timeout after `bucket_end + N ms`
  - `BatchFinalizer` — immediate close for backfill data
- Add custom strategies via `FinalizerStrategy` protocol

### L5: Publisher (`publisher.py`)

- Emits `BarEvent` lifecycle events: `CREATED`, `UPDATED`, `CLOSED`, `AMENDED`, `EXPIRED`
- Two consumption patterns:
  - **Callbacks**: `on_bar_closed(callback)`, `on_bar_updated(callback)`, etc.
  - **Async iterator**: `async for event in publisher.subscribe(filter=...)`
- Throttles `UPDATED` events (configurable)
- Bounded subscriber queues with backpressure

## Extension Points

| Extension | Protocol | Where |
|---|---|---|
| Custom data source | `BarInputAdapter` | `router.register_adapter()` |
| Custom bucketing | `BucketCalculator` | `TimeBucketEngine(custom_calculator=...)` |
| Custom merge logic | `BarMergeStrategy` | `bar_state.set_merge_strategy()` |
| Custom close logic | `FinalizerStrategy` | `finalizer.add_strategy()` |

## Configuration

All parameters are in `BarAggregatorConfig` with sensible defaults.
Override via constructor kwargs or environment variables (prefix `BAR_AGG_`):

| Parameter | Env Var | Default | Description |
|---|---|---|---|
| `bar_source_mode` | `BAR_AGG_SOURCE_MODE` | `"kline"` | `kline` / `trade` / `auto` |
| `default_alignment_mode` | `BAR_AGG_ALIGNMENT_MODE` | `"epoch"` | Bucket alignment |
| `max_active_bars` | `BAR_AGG_MAX_ACTIVE_BARS` | `3` | Max forming bars per key |
| `max_closed_bars_in_memory` | `BAR_AGG_MAX_CLOSED_BARS` | `500` | Closed bars cache |
| `use_source_close_signal` | `BAR_AGG_USE_SOURCE_CLOSE` | `true` | Use exchange x=true |
| `finalize_timeout_ms` | `BAR_AGG_FINALIZE_TIMEOUT_MS` | `5000` | Safety timeout |
| `update_throttle_ms` | `BAR_AGG_UPDATE_THROTTLE_MS` | `250` | UPDATED event throttle |

## File Structure

```
bar_aggregator/
├── __init__.py          # Public API exports
├── aggregator.py        # Top-level orchestrator (BarAggregator)
├── config.py            # BarAggregatorConfig
├── models.py            # Data models, enums, protocols
├── router.py            # L1: EventRouter
├── time_bucket.py       # L2: TimeBucketEngine
├── bar_state.py         # L3: BarStateEngine + StandardOHLCVMerge
├── finalizer.py         # L4: Finalizer + built-in strategies
├── publisher.py         # L5: BarAggregatorPublisher
├── README.md            # This file
└── README_zh.md         # Chinese documentation
```
