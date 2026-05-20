# Data Engine Architecture Polish Roadmap

> A practical roadmap for making the current Data Engine easier to read, safer to extend, and harder to accidentally cross-wire.

The current architecture is already organized around the right ownership boundaries:

- `ingestion` owns exchange I/O, WS/HTTP fallback, normalization, continuity, and `MarketEvent` output.
- `bar_aggregator` owns K-line semantics: bucket routing, OHLCV merge, forming/closed/amended lifecycle, and `BarEvent` publishing.
- `data_manager` owns the public business facade: query, cache, event bus, stream lifecycle, backfill coordination, price snapshots, subscriptions, and maintenance.
- `backfill` owns historical repair execution and reports precise written ranges back to DataManager.
- `runtime.py` is the composition root that wires the Data Engine into FastAPI app state.

The polish work below preserves those boundaries. It is not a rewrite plan. It is a cleanup plan for making the existing shape more explicit and less surprising.

## Implementation Status

Status after the current polish pass:

| Phase | Status | Landed result |
|---|---|---|
| Phase 1: current truth | Completed | `DATA_FLOW_PATHS.md` documents realtime K-line, backfill, price, builtin indicator, and Pyne/custom paths. Callback comments now clarify that `MarketEvent` enters `BarAggregator`, not DataManager cache directly. |
| Phase 2: thin route layer | Completed | `api/v1/stream.py` is a thin route shell. K-line streaming lives in `stream_klines.py`; shared WS helpers live in `stream_utils.py`; indicator WS orchestration lives in `stream_indicators.py`; payload/range computation lives in `stream_indicator_payloads.py`; Pyne/custom subscription lifecycle lives in `stream_pyne_subscriptions.py`. |
| Phase 3: retire compatibility names | Completed | `BinanceIngestionFactory` has been removed. `ExchangeIngestionFactory` is the only supported runtime ingestion factory export. |
| Phase 4: exchange WS capability routing | Completed | Tests assert Binance kline uses `SessionLayer` while OKX kline uses `SharedWsSessionAdapter` through capability-driven routing. |
| Phase 5: path-level tests | Completed for the listed guardrails | Tests cover MarketEvent-to-aggregator routing, price updates avoiding `BarAggregator`, factory alias retirement, session routing, and the main WS/indicator paths. |

Current full backend verification:

```bash
cd backend
python -m compileall app tests -q
python -m pytest -q
```

Latest result: `187 passed`.

## Desired End State

The goal is for a new maintainer to answer these questions without spelunking through route handlers:

1. Which module owns a given data path?
2. Which event type crosses each boundary?
3. Which component is allowed to start or stop exchange streams?
4. Which component is allowed to mutate cache or storage?
5. Why do Binance and OKX use different WS session models?
6. How should a new exchange, indicator mode, or subscription tier fit in?

The target shape:

```text
Exchange WS/REST
  -> ingestion
  -> MarketEvent / GapMarker
  -> BarAggregator
  -> BarEvent
  -> AggregatorBridge
  -> DataManager cache / storage / EventBus
  -> API / WS / Indicator / Subscription consumers
```

Parallel paths stay explicit:

- Historical repair returns through `DataManager.on_bars_backfilled()`, not through the realtime `MarketEvent` path.
- Price streams update `PriceSnapshotCache`, not `BarAggregator`.
- Indicator streams consume DataManager query/event outputs; they do not own market-data ingestion.
- Exchange plugins describe protocol and capability differences; API/frontend code consumes those capabilities instead of hard-coding exchange branches.

## Current Strengths

- The realtime K-line path is semantically clean: normalized `MarketEvent` enters `BarAggregator`, and only aggregated `BarEvent` output mutates cache/events through `AggregatorBridge`.
- `ExchangeIngestionFactory` is exchange-generic, and the old `BinanceIngestionFactory` alias has been retired.
- `StreamEnsurePlanner` keeps custom interval behavior out of route handlers and makes base-stream prerequisites explicit.
- `BackfillCoordinator` owns priority, deduplication, scheduling, retry, cancel, and completion event semantics instead of scattering those decisions through API routes.
- `SharedMultiplexHub` is capability-driven. Exchanges that declare `shared_multiplex` can share one upstream WS connection; Binance currently remains modeled as `path_per_stream`.

## Current Friction

| Area | Friction | Preferred polish |
|---|---|---|
| Legacy naming | The old `BinanceIngestionFactory` name described a Binance-only owner that no longer exists. | Completed: tests and code use `ExchangeIngestionFactory`; the old alias has been removed. |
| Large route module | `api/v1/stream.py` used to handle K-line WS, multi-interval WS, indicator WS, Pyne custom logic, range patches, heartbeat, and queueing. | Completed: route handlers are thin adapters; long-lived stream logic is split by responsibility. |
| WS session model clarity | `SharedMultiplexHub` is generic but only applies when exchange capabilities opt in. | Completed: capability routing is documented and covered by session-factory tests. |
| Price vs K-line flow | Price streams are intentionally separate from `BarAggregator`, but the parallel path was less prominent than the K-line path. | Completed: price flow is documented and guarded by tests that assert price updates do not touch K-line aggregation. |
| Docs scattered by subsystem | Existing READMEs are accurate but did not provide one decision map for future cleanup. | Completed: subsystem READMEs link to this roadmap and the concrete data-flow map. |

## Polish Phases

### Phase 1: Make Current Truth Unambiguous

Status: completed.

1. Add or refresh diagrams for the five active paths:
   - realtime K-line
   - historical repair/backfill
   - price snapshot/subscription
   - indicator builtin
   - Pyne/custom indicator
2. Document boundary events:
   - `RawMessage`: transport/session output
   - `MarketEvent`: normalized market event from ingestion
   - `GapMarker`: ingestion continuity signal
   - `BarEvent`: K-line semantic output from `BarAggregator`
   - `DataEvent`: DataManager event bus output
   - `PriceSnapshot`: lightweight price state
3. Retire compatibility names explicitly:
   - `BinanceIngestionFactory` has been removed.
   - Any new code should import `ExchangeIngestionFactory`.
4. Add source comments only where boundary crossings are easy to misread, especially callback handoff points.

Exit criteria:

- A maintainer can trace all five paths from API entrypoint to final event/cache side effect.
- Docs and code agree that `MarketEvent` enters `BarAggregator`, not DataManager cache directly.

### Phase 2: Thin The Route Layer

Goal: route handlers should validate commands, call DataManager/Indicator services, and serialize responses. They should not own long-lived market-data semantics.

Status: completed.

Recommended extraction:

| Current concentration | Candidate owner |
|---|---|
| `_dm_single_stream`, `_dm_multi_stream`, event forwarding helpers | `api/v1/stream_klines.py` or `app/streaming/klines.py` |
| indicator WS command loop | `app/indicator/streaming.py` |
| Pyne/custom indicator subscription tasks | `app/indicator/pyne_streaming.py` |
| shared WS send/heartbeat/error helpers | small `app/api/ws_utils.py` |

Rules:

- Keep FastAPI route files as adapters.
- Keep DataManager as the market-data facade.
- Keep `IndicatorEngine` and Pyne runtime code out of K-line WS handlers.
- Do not introduce a new global event bus; DataManager event bus remains the source for bar/price updates.

Exit criteria:

- `api/v1/stream.py` becomes an index/router or a thin compatibility shell.
- Existing WS tests still pass without changing public endpoint behavior.

### Phase 3: Retire Compatibility Names

Goal: remove naming that describes the old Binance-only world.

Status: completed.

Steps:

1. Replace test imports of `BinanceIngestionFactory` with `ExchangeIngestionFactory`.
2. Replace any docs or comments that call the runtime factory Binance-specific.
3. Remove the alias after downstream imports are known to be migrated.
4. Keep historical docs/changelog notes clear that `ExchangeIngestionFactory` is the supported name.

Exit criteria:

- No source or test imports use `BinanceIngestionFactory`.
- `ExchangeIngestionFactory` is the only runtime factory export and advertised factory name.

### Phase 4: Clarify Exchange WS Capability Routing

Goal: make exchange session selection a capability decision, not tribal knowledge.

Status: completed.

Current model:

```text
plugin.capabilities().ws_connection_model
  path_per_stream     -> SessionLayer
  shared_multiplex   -> SharedWsSessionAdapter / SharedMultiplexHub
  polling_only       -> HTTP fallback only
```

Guidelines:

- Binance currently uses `path_per_stream`; duplicate protection is pipeline/key reuse.
- OKX uses `shared_multiplex`; one hub can combine descriptors for one `(exchange, market_type, symbol)` group.
- A future Binance combined-stream mode should be introduced as an explicit capability/protocol change, not by special-casing Binance inside DataManager.
- `SharedMultiplexHub` should remain exchange-generic and should depend on plugin protocol methods such as `build_combined_subscribe()` and `payload_matches_descriptor()`.

Exit criteria:

- Tests cover both `path_per_stream` and `shared_multiplex` routing decisions.
- New exchange plugins can choose their WS model by capabilities alone.

### Phase 5: Strengthen Path-Level Tests

Status: completed for the guardrails listed below.

Added tests around ownership, not just outputs:

- `MarketEvent` from ingestion calls `BarAggregator.on_market_event`.
- `AggregatorBridge` is the only path that mutates K-line cache from realtime `BarEvent`.
- Backfill completion uses `DataManager.on_bars_backfilled()` and emits `BACKFILL_COMPLETED`.
- Price updates call `PriceSnapshotCache` and emit `PRICE_UPDATED` without touching `BarAggregator`.
- Indicator subscriptions consume DataManager bars/events and do not start exchange ingestion directly except through `dm.ensure_stream()`.
- Binance uses `SessionLayer`; OKX kline uses `SharedWsSessionAdapter`.

Verification set:

```bash
cd backend
python -m compileall app tests -q
python -m pytest -q \
  tests/test_data_engine_phase1_boundaries.py \
  tests/test_ingestion_session_types.py \
  tests/test_stream_api.py \
  tests/test_price_subscription_services.py \
  tests/test_indicator_api.py
```

## Design Rules For Future Work

- New market-data entrypoints should enter through DataManager unless they are internal runtime composition.
- New exchange protocol differences should live in exchange plugins and capabilities.
- New K-line semantics should live in `bar_aggregator` or `interval_policy.py`, not in API routes.
- New historical repair behavior should flow through `BackfillCoordinator`, not direct cache mutation.
- New realtime output should become a `DataEvent` before reaching WebSocket clients.
- New price-only behavior should stay on the price snapshot path unless it genuinely needs OHLCV bars.

## Non-Goals

- Do not replace the current Data Engine pipeline.
- Do not merge price snapshots into `BarAggregator`.
- Do not make API route handlers own exchange protocol details.
- Do not make frontend priority or scheduling decisions; frontend selects semantic intent, backend owns priority and execution.
- Do not introduce Binance-specific paths inside generic DataManager or ingestion orchestration.
