# Backfill

[中文](README_zh.md)

> Historical data repair pipeline for CandleScope. `BackfillEngine` detects gaps, plans REST fetches, fetches historical bars, reconciles them into storage, and publishes a `RepairReport`.

## Position In Data Engine

```text
DataManager.BackfillCoordinator
        ▼
BackfillEngine.run()
        │ detect -> plan -> fetch -> reconcile -> publish
        ▼
RepairReport.written_ranges
        ▼
DataManager precise storage readback + cache merge
```

`backfill` owns the repair pipeline. It does not own API endpoints, WebSocket delivery, DataManager cache updates, or request lifecycle coordination. Those are handled by `DataManager.BackfillCoordinator`.

## Demand-Aware Scheduling

Runtime backfill requests now flow through a demand-aware scheduler inside
`BackfillCoordinator`. `BackfillEngine` still owns detect/plan/fetch/reconcile;
the coordinator owns prioritization, chunking, deduplication, and cache/event
handoff.

Important behavior:

- Requests carry `reason`, `priority`, `requester`, and metadata.
- `/klines/history` submits `initial_history` at priority `10`.
- `/klines/latest` does not trigger backfill by default, so it cannot steal the
  first-screen history slot on a cold symbol.
- `/klines/range` uses `visible_range_gap`; `/klines/history/before` uses
  `visible_load_more`.
- Related intervals for the current symbol are scheduled as
  `related_interval_warmup` after the active interval.
- `full` subscriptions use lower-priority `full_subscription_warmup`; `price`
  subscriptions only maintain price flow plus `price_daily_open`; `none` does
  not proactively create K-line repair work.
- Large visible-range repairs are split into chunks and user-visible chunks run
  newest-first, so the right side of the chart can become renderable sooner.
- Different series can run concurrently; the same
  `(exchange, market_type, symbol, interval)` remains serialized for storage
  reconciliation.

Current priority map:

| Reason | Priority | Source |
|---|---:|---|
| `initial_history` | 10 | current chart first-screen history |
| `visible_load_more` / `visible_range_gap` | 20 | user-visible range work |
| `visible_seed_gap` | 30 | foreground custom/base warm start |
| `related_interval_warmup` | 40 | same-symbol interval warmup |
| `tail_gap` | 50 | realtime gap marker |
| `full_subscription_warmup` | 60 | full watchlist K-line maintenance |
| `price_daily_open` | 70 | price-only daily open repair |
| `latest_refresh` | 80 | low-value tail refresh |
| `query_gap` / query-derived fallback reasons | 100 | generic query repair |
| `startup_gap_scan` | 120 | startup maintenance |
| `background_gap_audit` | 150 | lowest-priority background audit |

The scheduler snapshot is exposed through DataManager diagnostics and includes
active requests, pending requests, chunk counts, token buckets, recent outcomes,
and coverage ranges.

## Pipeline

| Phase | Component | Responsibility |
|---|---|---|
| Detect | `GapDetector` | Compare requested/storage/live reference ranges and produce `GapInfo` |
| Plan | `BackfillPlanner` | Convert gaps into fetch tasks and custom interval decompositions |
| Fetch | `HistoricalFetcher` | Execute paginated exchange REST calls with concurrency, retry, and 429 cooldown |
| Reconcile | `Reconciler` | Deduplicate, aggregate custom intervals, batch-write storage, record `WrittenRange` |
| Publish | `RepairPublisher` | Log/callback final `RepairReport` |

## Quick Start

```python
from app.data_engine.backfill import BackfillConfig, BackfillEngine

engine = BackfillEngine(
    config=BackfillConfig(fetch_concurrency=2),
    storage=async_storage,      # implements StorageBackend
    transport=transport_layer,  # ingestion TransportLayer
    ingestion_config=ingestion_cfg,
)

report = await engine.run(
    symbol="BTCUSDT",
    intervals=["1m", "5m", "91m"],
    range_start_ms=1700000000000,
    range_end_ms=1700100000000,
    exchange="binance",
    market_type="spot",
)
```

Dry-run helpers:

```python
gaps = await engine.detect_only("BTCUSDT", intervals=["1m"])
plan = await engine.plan_only("BTCUSDT", intervals=["91m"])
```

In production, prefer submitting requests through DataManager/BackfillCoordinator instead of calling `BackfillEngine.run()` from API code.

## Key Models

| Type | Notes |
|---|---|
| `GapInfo` | Missing range for one `(exchange, market_type, symbol, interval)` |
| `IntervalComponent` / `IntervalDecomposition` | Custom interval decomposition into standard components |
| `BackfillTask` | One standard-interval REST fetch task |
| `BackfillPlan` | Gaps, tasks, estimated requests/bars, custom intervals |
| `FetchedBar` / `FetchResult` | Bars returned by historical REST fetches |
| `ReconcileResult` | Write counts, write errors, failed batches, written ranges |
| `WrittenRange` | Precise successfully written storage range |
| `RepairReport` | Final report consumed by BackfillCoordinator |
| `StorageBackend` | Protocol required by detector/reconciler |
| `CacheBackend` | Optional protocol retained for standalone use |

## RepairReport Contract

`RepairReport.written_ranges` is the authoritative handoff back to DataManager:

```python
report.status                 # completed / partial / failed / cancelled
report.errors                 # top-level errors
report.reconcile_result       # bars_written, write_errors, failed_batches
report.written_ranges         # exact ranges written to storage
```

BackfillCoordinator reads each `WrittenRange` back from storage and then calls `DataManager.on_bars_backfilled()`. This avoids blindly reading the original requested range, which may differ from actual writes after pagination, deduplication, custom aggregation, or partial failure.

## Custom Intervals

The planner decomposes custom intervals into standard components. Example:

```text
91m -> 1h + 30m + 1m
```

Supported decomposition strategies:

| Strategy | Meaning |
|---|---|
| `greedy_descending` | Use largest fitting standard intervals first |
| `min_requests` | Minimize expected REST calls |
| `single_base` | Use one base interval |

Alignment modes:

| Mode | Meaning |
|---|---|
| `epoch` | Align to `alignment_epoch_ms` |
| `midnight` | Align to UTC midnight |
| `market` | Align to market-open semantics when available |
| `none` | Start directly from gap start |

Custom interval writes reuse `BarAggregator.aggregate_batch()` so batch repair does not mutate live aggregator targets or active state.

## Fetching And Rate Limits

`HistoricalFetcher` uses exchange-aware concurrency and delay settings:

- Generic fetch concurrency defaults are intentionally modest.
- Binance futures defaults serialize requests more aggressively.
- OKX defaults are conservative and tests cover pagination beyond the 300-row page cap.
- HTTP 429 handling uses `Retry-After` when present and applies exchange/market cooldown.

## Deduplication

`DeduplicationStrategy` values:

- `skip`: keep existing rows.
- `overwrite`: always write fetched repair rows.
- `backfill_wins`: fetched repair rows replace duplicates.
- `newer_wins`: legacy alias for `backfill_wins`.

Write failures are surfaced through `ReconcileResult.write_errors` and `failed_batches`. A run with partial writes returns `PARTIAL`, not `COMPLETED`.

## Configuration

`BackfillConfig` supports constructor values, `BACKFILL_*` environment variables, and runtime `update()`.

| Env | Purpose |
|---|---|
| `BACKFILL_GAP_SCAN_INTERVALS` | default intervals scanned when none are provided |
| `BACKFILL_GAP_MAX_SCAN_RANGE_MS` | max range per detection pass |
| `BACKFILL_GAP_TOLERANCE_BARS` | tolerated missing bars before reporting |
| `BACKFILL_GAP_SCAN_INTERIOR` | whether to scan interior holes |
| `BACKFILL_STANDARD_INTERVALS` | standard intervals used for decomposition |
| `BACKFILL_DECOMPOSITION_STRATEGY` | custom interval decomposition strategy |
| `BACKFILL_CUSTOM_ALIGNMENT_MODE` | custom interval alignment mode |
| `BACKFILL_FETCH_CONCURRENCY` | generic REST fetch concurrency |
| `BACKFILL_FETCH_BINANCE_FUTURES_CONCURRENCY` | Binance futures override |
| `BACKFILL_FETCH_OKX_CONCURRENCY` | OKX override |
| `BACKFILL_FETCH_RATE_LIMIT_DELAY` | generic delay between REST calls |
| `BACKFILL_FETCH_429_BACKOFF_SECONDS` | cooldown after HTTP 429 |
| `BACKFILL_RECONCILE_DEDUP_STRATEGY` | write conflict policy |
| `BACKFILL_RECONCILE_WRITE_BATCH_SIZE` | storage write batch size |
| `BACKFILL_RECONCILE_GENERATE_CUSTOM` | generate custom interval rows |
| `BACKFILL_PUBLISH_MODE` | `callback`, `log`, or `both` |
| `BACKFILL_EXCHANGE` | default exchange |

## Tests

```bash
cd backend
python -m pytest -q \
  tests/test_backfill_coordinator.py \
  tests/test_backfill_gap_detector.py \
  tests/test_backfill_rate_limit.py \
  tests/test_backfill_reconciler.py \
  tests/test_okx_backfill_fetcher.py
```
