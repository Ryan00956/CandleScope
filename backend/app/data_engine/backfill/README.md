# Backfill Engine

[![English](https://img.shields.io/badge/Language-English-blue)](#) [![简体中文](https://img.shields.io/badge/语言-简体中文-red)](README_zh.md)


> Automatic and on-demand historical data repair for CandleScope.

The Backfill Engine detects missing K-line data in the database, fetches it from the exchange REST API, deduplicates, aggregates custom intervals, writes to storage, and publishes a repair report — all in one `await engine.run("BTCUSDT")` call.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        BackfillEngine                            │
│                                                                  │
│  ┌──────────────┐   ┌──────────────┐   ┌────────────────────┐   │
│  │ Gap Detector  │──▶│   Planner    │──▶│ Historical Fetcher │   │
│  └──────────────┘   └──────────────┘   └────────┬───────────┘   │
│                                                  │               │
│                                        ┌─────────▼───────────┐  │
│                                        │     Reconciler      │  │
│                                        │  (dedup + write)    │  │
│                                        └─────────┬───────────┘  │
│                                                  │               │
│                                        ┌─────────▼───────────┐  │
│                                        │  Repair Publisher    │  │
│                                        └─────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### Pipeline Phases

| # | Phase | Component | Description |
|---|-------|-----------|-------------|
| 1 | **Detect** | `GapDetector` | Compares live edge (from ingestion L6) with DB, finds tail/head/interior gaps |
| 2 | **Plan** | `BackfillPlanner` | Decomposes custom intervals, aligns buckets, creates fetch tasks |
| 3 | **Fetch** | `HistoricalFetcher` | Paginated REST calls with concurrency control and retry |
| 4 | **Reconcile** | `Reconciler` | Dedup, aggregation, batch DB writes, cache push |
| 5 | **Publish** | `RepairPublisher` | Logs + callbacks with the `RepairReport` |

---

## Quick Start

```python
from app.data_engine.backfill import BackfillEngine, BackfillConfig

config = BackfillConfig(fetch_concurrency=5)
engine = BackfillEngine(
    config=config,
    storage=my_storage_backend,   # implements StorageBackend protocol
    transport=my_transport_layer, # ingestion TransportLayer
    cache=my_cache_backend,       # optional, implements CacheBackend protocol
)

# One-shot backfill
report = await engine.run("BTCUSDT")

# With custom intervals
report = await engine.run(
    symbol="BTCUSDT",
    intervals=["1m", "5m", "91m"],
    range_start_ms=1700000000000,
    range_end_ms=1700100000000,
)

# Dry run — detect only
gaps = await engine.detect_only("BTCUSDT")

# Dry run — detect + plan (shows cost estimate)
plan = await engine.plan_only("BTCUSDT", intervals=["1m", "91m"])
print(f"Would fetch ~{plan.estimated_bars} bars in ~{plan.estimated_requests} requests")
```

---

## Custom Interval Decomposition

The Planner automatically decomposes non-standard intervals into standard ones for efficient fetching.

**Example: 91m** (5,460,000 ms)
```
Greedy decomposition:
  91m → 1×60m + 1×30m + 1×1m
  (3 components instead of 91 individual 1m requests)
```

### Strategies

| Strategy | Description | Best for |
|----------|-------------|----------|
| `greedy_descending` | Largest standard interval first | Default, fast |
| `min_requests` | Minimize total REST pages | Large backfills |
| `single_base` | One base interval only | Simplicity |

### Alignment Modes

| Mode | Description |
|------|-------------|
| `epoch` | Align to a fixed epoch timestamp (default: Unix 0) |
| `midnight` | Align to UTC midnight boundaries |
| `market` | Align to exchange market open |
| `none` | No alignment |

---

## Storage & Cache Protocols

The engine is **storage-agnostic**. Implement these protocols to use any database:

### StorageBackend (required)

```python
class MyStorage:
    async def get_latest_time(self, symbol: str, interval: str) -> int | None: ...
    async def get_earliest_time(self, symbol: str, interval: str) -> int | None: ...
    async def query_time_range(self, symbol, interval, start_ms, end_ms) -> list[dict]: ...
    async def upsert_bars(self, symbol, interval, bars, source="backfill") -> int: ...
    async def count_bars(self, symbol, interval, start_ms, end_ms) -> int: ...
    async def get_existing_open_times(self, symbol, interval, start_ms, end_ms) -> set[int]: ...
```

### CacheBackend (optional)

```python
class MyCache:
    async def push_bars(self, symbol: str, interval: str, bars: list[dict]) -> int: ...
    async def invalidate(self, symbol, interval, start_ms, end_ms) -> None: ...
```

---

## Configuration

All parameters have sensible defaults and can be overridden via:
1. Constructor kwargs: `BackfillConfig(fetch_concurrency=10)`
2. Environment variables: `BACKFILL_FETCH_CONCURRENCY=10`
3. Runtime update: `config.update(fetch_concurrency=10)`

See [`config.py`](config.py) for the complete parameter list with documentation.

### Key Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `gap_scan_intervals` | `["1m","5m","15m","1h","4h","1d"]` | Intervals to scan |
| `gap_tolerance_bars` | `1` | Missing bars before reporting a gap |
| `gap_scan_interior` | `True` | Detect interior holes |
| `decomposition_strategy` | `"greedy_descending"` | How to decompose custom intervals |
| `custom_alignment_mode` | `"epoch"` | Bucket alignment mode |
| `fetch_concurrency` | `3` | Max concurrent REST requests |
| `fetch_batch_size` | `1000` | Bars per REST page |
| `fetch_rate_limit_delay` | `0.1` | Seconds between requests |
| `fetch_max_retries` | `3` | Retries per failed request |
| `reconcile_dedup_strategy` | `"overwrite"` | How to handle duplicates |
| `reconcile_enable_cache_push` | `True` | Push recent data to cache |
| `publish_mode` | `"both"` | `"log"`, `"callback"`, or `"both"` |

---

## Extension Points

Every sub-component exposes hooks for customization:

### Gap Detector
```python
# Custom reference time (e.g. from ingestion)
engine.detector.set_reference_time_provider(my_async_fn)

# Filter out small gaps
engine.detector.set_gap_filter(lambda g: g.missing_bars >= 5)

# Per-gap callback
engine.detector.on_gap_detected(my_async_handler)

# Feed live edge from ingestion
engine.detector.update_ingestion_reference("BTCUSDT", "1m", open_time_ms)
```

### Planner
```python
# Hardcode a decomposition
from app.data_engine.backfill.models import IntervalComponent
engine.planner.add_interval_mapping("91m", [
    IntervalComponent("1h", 1, 3_600_000),
    IntervalComponent("30m", 1, 1_800_000),
    IntervalComponent("1m", 1, 60_000),
])

# Custom decomposition function
engine.planner.set_decomposition_fn(my_decomp_fn)

# Custom alignment function
engine.planner.set_alignment_fn(my_align_fn)
```

### Fetcher
```python
# Progress tracking
engine.fetcher.on_fetch_progress(async_progress_handler)

# Error handling
engine.fetcher.on_fetch_error(async_error_handler)

# Custom rate limiter
engine.fetcher.set_rate_limiter(my_token_bucket)
```

### Reconciler
```python
# Custom OHLCV aggregation
engine.reconciler.set_custom_aggregator(my_agg_fn)

# Custom dedup logic
engine.reconciler.set_dedup_fn(my_dedup_fn)

# Per-batch callback
engine.reconciler.on_write_batch(async_batch_handler)
```

### Publisher
```python
# Webhook / notification
engine.publisher.on_report(async_webhook_handler)

# Custom formatting
engine.publisher.set_report_formatter(my_formatter)

# Filter reports (e.g. only failures)
engine.publisher.set_report_filter(lambda r: r.status != BackfillStatus.COMPLETED)
```

---

## File Structure

```
backfill/
├── __init__.py          # BackfillEngine orchestrator + public API
├── config.py            # BackfillConfig (all tunable parameters)
├── models.py            # Data models, enums, Protocol interfaces
├── gap_detector.py      # Gap Detector
├── planner.py           # Backfill Planner (decomposition + alignment)
├── fetcher.py           # Historical Fetcher (REST + pagination)
├── reconciler.py        # Reconciler (dedup + aggregation + write)
├── publisher.py         # Repair Publisher (log + callbacks)
├── README.md            # This file
└── README_zh.md         # 中文文档
```

---

## Metrics & Diagnostics

Every component tracks metrics via `LayerMetrics`:

```python
# Engine-level snapshot
snapshot = engine.snapshot()

# Per-component metrics
engine.detector.metrics.snapshot()
engine.planner.metrics.snapshot()
engine.fetcher.metrics.snapshot()
engine.reconciler.metrics.snapshot()
engine.publisher.metrics.snapshot()
```
