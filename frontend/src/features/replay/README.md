# Replay feature boundary

Replay is a server-authoritative historical market runtime. It is not a source
toggle inside the live application. Both replay product flags remain disabled
by default while the phase-gated v2 workbench is built and verified.

The phase-gated v2 workbench now includes the Training Hub, source-neutral market
workspace, ViewerState and aligned replay controls, Phase 4 server-owned time
disclosure and Review/Fork, Phase 5 deterministic multi-market tracks, and the
Phase 6 versioned contract account, plus Phase 7 on-demand data segments and
safe GC, and Phase 8 explainable fast-forward plus aggregate-trade flow. New TrainingRuns use `TOUCH_OR_TAPE_V2`,
configured maker/taker policies, CROSS or ISOLATED margin, approximate Sandbox
funding, simulated-account liquidation events, and a hash-chained cash ledger.
The UI continuously labels the no-book execution boundary. With
`VITE_REPLAY_PRODUCT_V2_ENABLED=1`, a direct `replay.html`
configure entry opens the Hub; opaque `?session=<id>` entries continue through
the proven v1 runtime adapter. Hub bootstrap performs only the bounded lightweight
`GET /api/v1/replay/runs` request. Historical datasets are not loaded until a
concrete training session is entered.

Phase 7 adds a checksum-bound data-segment registry over the existing immutable
BAR snapshots and raw aggTrade partition manifests without rewriting either
production store. Opening the create panel reads a small prepare plan only;
selecting a symbol does not fetch history, and create prepares only the selected
symbol/range. The Hub shows estimated rows/bytes, same-source READY inventory
(with exact range reuse revalidated at create), and the fail-closed quarantine
policy. Automatic download and automatic GC workers
remain disabled by default. Explicit GC is LRU, rehydration-aware, and requires
a fresh dry-run plan hash before any replay-owned file can be reclaimed;
embedded/non-rebuildable archives are never candidates.

Phase 8 adds a server-authoritative four-plan fast-forward response. The
optimization flag remains off by default; disabling it routes every advance to
the proven `FULL_EVENT_SCAN` reference path. With it enabled, only an account
without orders, positions, funding, risk, book, or multi-track path dependencies
may use `AGGREGATE_SCAN`. Every immutable source event still updates the ordered
reducer and source-event chain; only redundant intermediate state hashes and
ordinary projections are coalesced before an exact reset, with a bounded tail
published event-by-event. Progress exposes the plan, reasons, commit boundary,
queue high-water, and equivalence status.

The replay-only order-flow tab reads bounded pages no later than the revealed
source cursor. AGG_TRADE Tape is exact at aggregate-record fidelity, while
aggressor/CVD is explicitly approximate because side is inferred from
buyer-maker. Any gap or epoch change clears the projection and requires resync.
BAR shows `UNSUPPORTED_SOURCE_MODE`; it never renders missing history as zero.

With the repository-default `VITE_REPLAY_PRODUCT_V2_ENABLED=0`, composition is
still exactly v1. The backend additionally requires both replay flags before
serving v2 routes. The frozen v1 public execution enum and legacy
`PAPER_LINEAR_V1_MULTI_TRACK_ADAPTER` restore path remain unchanged; the v2
TrainingRun selects its internal execution version explicitly. Historical-exact
funding remains fail-closed because this repository has no aligned historical
funding plus authoritative mark source. Historical L2/book-assisted execution is
also unavailable; neither boundary silently falls back to last price or zero.

## Composition roots

The two browser documents have fixed, independent roots:

```text
index.html  -> src/main.tsx        -> App       -> live runtimes only
replay.html -> src/replay-main.tsx -> ReplayApp -> replay runtimes only
```

`App` may expose an ordinary `noopener,noreferrer` link to the replay page, but
it must not own replay bars, stores, controllers, or a replay runtime.
`ReplayApp` must work without `window.opener` and must never mount a live runtime
even briefly during loading, error, recovery, or disabled states.

## Public runtime contract

Both composition roots eventually provide their own implementation of a pure
`MarketDataRuntimeContract` with exactly three top-level capabilities:

```text
view    immutable chart/read-model projection
actions intent-level operations exposed to the shell
status  source-specific health and lifecycle state
```

The shared chart/workspace consumes that contract and one `SeriesWindowStore`.
It does not select a source. Replay source identity includes the opaque session
and data epoch so live and replay caches cannot collide.

## Allowed dependencies

Replay modules may depend on:

- feature-local protocol types, parser, API/stream controller, store, and pure calculations;
- the extracted market-data runtime contract and `SeriesWindowStore` delta semantics;
- chart adapter public APIs, drawing public APIs, settings, and pure layout components;
- React only in components, hooks, and composition files.

Components send intent through feature-local actions. They do not import
`src/services` directly. Runtime/controller files do not render JSX.

## Forbidden dependencies and side effects

Replay modules and `ReplayApp` must not value-import or mount:

- `useMarketDataRuntime` or any live K-line REST/WebSocket runtime;
- advanced market, order-book, full-order-book, trade-flow, liquidation, watchlist,
  watchlist full-cache, live alerts, or online indicator runtimes;
- private trading, signed requests, credentials, API keys, or real-order adapters;
- live stores, runtime singletons, subscription leases, BroadcastChannel, or
  shared localStorage containing session configuration or hidden real time.

The replay page may use type-only imports from pure shared contracts. Network
and state isolation are enforced again by architecture and browser tests in
later phases; the frontend entry flag is never a security boundary.
