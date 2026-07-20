# Bar Aggregator

[中文](README_zh.md)

> Converts normalized market events and historical bars into lifecycle-aware OHLCV candles. It is the only Data Engine module that owns bucket calculation, merge semantics, forming/closed state, and `BarEvent` publication.

## Position In Data Engine

```text
ingestion.MarketEvent / backfill bars / manual BarInput
        ▼
bar_aggregator
        │ BarEvent
        ▼
data_manager
```

`bar_aggregator` does not connect to exchanges, read/write storage, or manage API subscriptions. It receives inputs and emits bar lifecycle events.

## Five-Layer Architecture

| Layer | Component | Responsibility |
|---|---|---|
| L1 | `EventRouter` | Convert `MarketEvent` to `BarInput`, dispatch to registered `(exchange, market_type, symbol, interval)` targets |
| L2 | `TimeBucketEngine` | Compute bucket start/end for standard, custom, weekly, and monthly intervals |
| L3 | `BarStateEngine` | Maintain forming/closed `BarState`, apply merge strategies |
| L4 | `Finalizer` | Decide when a bar closes using source-close, event-driven, composite, batch, or timeout rules |
| L5 | `BarAggregatorPublisher` | Emit `CREATED`, `UPDATED`, `CLOSED`, `AMENDED`, `EXPIRED` events to callbacks/queues |

## Public Facade

```python
from app.data_engine.bar_aggregator import BarAggregator

agg = BarAggregator()
agg.add_target("BTCUSDT", "1m", exchange="binance", market_type="spot")
agg.add_target("BTCUSDT", "91m")
agg.publisher.on_bar_closed(save_bar)

await agg.start()
await agg.on_market_event(market_event)
await agg.stop()
```

Important methods on `BarAggregator`:

| Method | Use |
|---|---|
| `add_target()` / `remove_target()` | Register or remove a target series |
| `on_market_event()` | Feed realtime normalized events from ingestion |
| `on_backfill_bars()` | Feed historical repair bars |
| `ingest_bar_input()` | Directly inject a normalized `BarInput` |
| `seed_active_bar()` | Seed forming state from warm-start data |
| `replay_components()` | Rebuild buckets from component bars |
| `aggregate_batch()` | Stateless batch aggregation for backfill/custom storage repair |
| `get_bucket_state()` / `get_latest_bar()` | Inspect current in-memory state |
| `get_active_bars()` / `get_recent_bars()` | Debug/diagnostic access |
| `snapshot()` | JSON-serializable diagnostics |

## Key Models

| Type | Notes |
|---|---|
| `BarInput` | Unified input from realtime, backfill, manual, or adapters; timestamps are milliseconds |
| `BarState` | Current OHLCV state for one bucket |
| `BarEvent` | Published lifecycle event with identity, status, and bar payload |
| `BarEventFilter` | Subscriber-side filtering |
| `FinalizeTrigger` | Reason a finalizer check is running |
| `BarInputSource` | `realtime`, `backfill`, `manual`, `adapter` |
| `BarSourceMode` | `kline`, `trade`, `auto` |
| `MergeMode` | `snapshot`, `incremental`, `component`, `price_only` |
| `BarStatus` | `forming`, `closed`, `expired` |
| `BarEventType` | `bar.created`, `bar.updated`, `bar.closed`, `bar.amended`, `bar.expired` |
| `AlignmentMode` | `epoch`, `midnight`, `market`, `custom`, `none` |

## Merge Modes

- `SNAPSHOT`: exchange kline snapshot for the target interval. Cumulative values replace the current source snapshot.
- `INCREMENTAL`: trade/tick style update. Additive fields accumulate.
- `COMPONENT`: component bar used to rebuild larger custom buckets.
- `PRICE_ONLY`: update open/high/low/close while leaving volume, quote volume, and trades unchanged. Used for OKX realtime fan-out where higher intervals should follow price without corrupting additive fields.

## Custom, Weekly, And Monthly Intervals

Intervals are parsed through the shared interval policy. Fixed custom intervals such as `7m`, `45m`, `3h`, or `91m` use millisecond bucket math. Weekly intervals are Monday-aligned. Month-unit intervals such as `1M`, `2M`, and `3M` use calendar-aware monthly bucket calculators instead of assuming a fixed 30-day month.

For backfill and storage repair, prefer `aggregate_batch()` when you need isolated batch results. Tests assert that `aggregate_batch()` does not register targets or leave active bars behind.

## Finalization

Finalizers combine multiple close signals:

- Source close signal from exchange kline payloads.
- Event-driven close when a new bucket starts.
- Composite close for custom intervals when the last component closes.
- Time-based timeout to close bars if the exchange close signal is lost.
- Batch finalization for historical aggregation.

## Configuration

`BarAggregatorConfig` supports constructor values, `BAR_AGG_*` environment variables, and runtime `update()`.

| Env | Purpose |
|---|---|
| `BAR_AGG_SOURCE_MODE` | `kline`, `trade`, or `auto` |
| `BAR_AGG_ACCEPTED_STREAMS` | accepted stream types |
| `BAR_AGG_ALIGNMENT_MODE` | default custom interval alignment |
| `BAR_AGG_ALIGNMENT_EPOCH_MS` | custom alignment epoch |
| `BAR_AGG_MAX_ACTIVE_BARS` | max forming buckets per series |
| `BAR_AGG_MAX_CLOSED_BARS` | recent closed bars retained in memory |
| `BAR_AGG_USE_SOURCE_CLOSE` | legacy compatibility flag; native snapshots always require the exchange close signal |
| `BAR_AGG_FINALIZE_TIMEOUT_MS` | fallback deadline; unconfirmed native snapshots expire instead of closing |
| `BAR_AGG_USE_EVENT_DRIVEN_CLOSE` | close previous bucket when next bucket arrives |
| `BAR_AGG_USE_COMPOSITE_CLOSE` | close custom bars from component close state |
| `BAR_AGG_UPDATE_THROTTLE_MS` | throttle `UPDATED` events |
| `BAR_AGG_PUBLISHER_QUEUE_SIZE` | subscriber queue size |

## Tests

```bash
cd backend
python -m pytest -q tests/test_bar_aggregator_contracts.py
```

The contract tests cover exchange/market identity in keys, OKX `PRICE_ONLY` fan-out behavior, event matching, isolated replay, and stateless batch aggregation.
