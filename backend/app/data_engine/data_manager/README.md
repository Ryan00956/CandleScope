# Data Manager

[![English](https://img.shields.io/badge/Language-English-blue)](#) [![简体中文](https://img.shields.io/badge/语言-简体中文-red)](README_zh.md)


> **Unified cache, query, and event distribution layer for CandleScope.**

The Data Manager is the **single entry point** for all K-line data operations. Charts, indicators, strategies, API endpoints, and WebSocket hubs all interact with `DataManager` instead of touching cache, storage, or ingestion modules directly.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                  DataManager (facade)                │
│                                                      │
│  ┌──────────┐  ┌─────────────┐  ┌────────────────┐  │
│  │ BarCache │  │ QueryEngine │  │  DataEventBus  │  │
│  └────┬─────┘  └──────┬──────┘  └───────┬────────┘  │
│       │               │                │             │
│  ┌────┴───────────────┴────────────────┴──────────┐  │
│  │            StreamCoordinator                   │  │
│  │   (ingestion + aggregation lifecycle mgmt)     │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
         ▲              ▲              ▲
         │              │              │
    bar_aggregator   storage      ingestion
      (upstream)     (SQLite)    (WebSocket)
```

## Module Files

| File | Description |
|------|-------------|
| `config.py` | All configuration dataclasses (`DataManagerConfig`, `CacheConfig`, `QueryConfig`, `EventBusConfig`, `CoordinatorConfig`) |
| `models.py` | Core types: `BarData`, `SeriesKey`, `QueryResult`, `DataEvent`, `DataEventType`, `SubscriptionHandle`, `StreamInfo`, `StorageBackend` protocol |
| `cache.py` | `BarCache` — thread-safe, LRU-evicting, bounded in-memory bar storage with per-series ring buffers |
| `event_bus.py` | `DataEventBus` — topic-based pub/sub with callback and async-iterator delivery, middleware support |
| `query.py` | `QueryEngine` — three-level query resolution: Cache → Storage → Backfill |
| `coordinator.py` | `StreamCoordinator` — lifecycle management for ingestion pipelines, prewarm, idle reaping |
| `manager.py` | `DataManager` — the public facade that composes all components |

## Quick Start

```python
from app.data_engine.data_manager import DataManager, DataManagerConfig

# Create with default or custom config
dm = DataManager()
# dm = DataManager(DataManagerConfig(cache=CacheConfig(max_bars_per_series=10000)))

# Inject optional backends
dm.set_storage(my_storage_backend)          # SQLite, PostgreSQL, etc.
dm.set_ingestion_factory(my_ws_factory)     # Binance, OKX, etc.
dm.set_backfill_trigger(backfill_fn)        # gap-filling callback

# Start (prewarms cache, starts reaper)
await dm.start()
```

## Querying Data

All consumers use the same interface:

```python
# Latest 500 bars
result = dm.query("BTCUSDT", "1m", limit=500)

# Time range query
result = dm.query("BTCUSDT", "1h", start_ms=1700000000000, end_ms=1700100000000)

# Pagination (load more)
result = dm.query_before("BTCUSDT", "1m", before_ms=oldest_bar_ms, limit=500)

# Access results
for bar in result.bars:
    print(bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume)

# Metadata
print(result.source)           # "cache", "storage", "mixed", "empty"
print(result.cache_hit)        # True/False
print(result.backfill_triggered)
```

The query engine resolves data in three levels:
1. **Cache** — sub-millisecond, in-memory
2. **Storage** — SQLite / database fallback, results are cached for next time
3. **Backfill** — triggers async historical data fetch if gaps detected

## Subscribing to Events

### Callback Style

```python
from app.data_engine.data_manager import DataEventType

async def on_bar_closed(event):
    bar = event.bar
    print(f"Closed: {event.key} @ {bar.close}")

handle = dm.subscribe(
    callback=on_bar_closed,
    symbol="BTCUSDT",
    interval="1m",
    event_types={DataEventType.BAR_CLOSED},
)

# Later...
dm.unsubscribe(handle)
```

### Async Iterator Style

```python
async for event in dm.subscribe_iter("BTCUSDT", "1m"):
    await websocket.send(event.to_dict())
```

### Event Types

| Event | Description |
|-------|-------------|
| `BAR_CREATED` | New bar bucket started |
| `BAR_UPDATED` | Bar OHLCV updated (live tick) |
| `BAR_CLOSED` | Bar finalized — most important for strategies |
| `BAR_AMENDED` | Historical bar corrected (backfill) |
| `STREAM_STARTED` | Ingestion pipeline started |
| `STREAM_STOPPED` | Ingestion pipeline stopped |
| `STREAM_ERROR` | Stream encountered an error |
| `BACKFILL_STARTED/COMPLETED/FAILED` | Backfill lifecycle |
| `CACHE_PREWARM` | Cache prewarm completed for a series |
| `CACHE_EVICTION` | Series evicted from cache |

## Stream Management

```python
# Auto-start a stream when needed
info = await dm.ensure_stream("BTCUSDT", "1m")

# Stop a stream
await dm.stop_stream("BTCUSDT", "1m")

# Inspect
streams = dm.get_all_streams()
for s in streams:
    print(s.to_dict())
```

## Middleware

Middleware hooks run before every event reaches subscribers:

```python
async def logging_middleware(event):
    logger.info(f"Event: {event.event_type} {event.key}")
    return event  # return None to suppress

dm.add_middleware(logging_middleware)
```

## Integration with bar_aggregator

The `bar_aggregator.publisher` pushes events into the Data Manager:

```python
# In bar_aggregator publisher callback
bar = BarData.from_bar_state(bar_state)
await data_manager.on_bar_event(
    symbol="BTCUSDT",
    interval="5m",
    bar=bar,
    event_type=DataEventType.BAR_CLOSED,
)
```

## Integration with backfill

```python
# After backfill fetches and reconciles bars
bars = [BarData.from_storage_row(r) for r in rows]
await data_manager.on_bars_backfilled("BTCUSDT", "1m", bars)
```

## Custom Storage Backend

Implement the `StorageBackend` protocol:

```python
class MyPostgresStorage:
    def query_bars(self, symbol, interval, start_ms=None, end_ms=None, limit=None, order="ASC"):
        ...
    def upsert_bars(self, symbol, interval, rows, source="data_manager"):
        ...
    def get_bounds(self, symbol, interval):
        ...
    def delete_bars(self, symbol, interval, start_ms=None, end_ms=None):
        ...
    def fetch_before(self, symbol, interval, before_ms, limit=500):
        ...

dm.set_storage(MyPostgresStorage())
```

## Diagnostics

```python
snapshot = dm.snapshot()
# Returns a full JSON-serializable dict with:
# - cache stats (hits, misses, series counts)
# - query metrics (total queries, cache hit rate)
# - event bus state (subscriber counts, events emitted/dropped)
# - stream info (active streams, health)
# - full config
```

## Configuration

All configuration is via `DataManagerConfig`:

```python
from app.data_engine.data_manager import (
    DataManagerConfig, CacheConfig, QueryConfig, EventBusConfig, CoordinatorConfig
)

config = DataManagerConfig(
    cache=CacheConfig(
        max_bars_per_series=5000,   # bars per (symbol, interval)
        max_series=200,             # max tracked series
        prewarm_bars=1000,          # bars loaded on first access
        ttl_seconds=0,              # 0 = never expire
    ),
    query=QueryConfig(
        default_limit=500,
        max_limit=10000,
        auto_backfill=True,
    ),
    event_bus=EventBusConfig(
        subscriber_queue_size=1000,
        emit_bar_updated=True,
        emit_bar_created=True,
    ),
    coordinator=CoordinatorConfig(
        auto_start_ingestion=True,
        idle_stream_timeout_seconds=300,
        base_interval="1m",
        prewarm_symbols=["BTCUSDT"],
        prewarm_intervals={"1m": 1, "5m": 3, "1h": 30},
    ),
)

dm = DataManager(config)
```
