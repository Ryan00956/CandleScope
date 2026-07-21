# Replay feature boundary

Replay is a server-authoritative historical market runtime. It is not a source
toggle inside the live application. The feature is disabled by default until a
later phase wires the dedicated entry and backend capability.

Phase 0 also defines `replay.v2` in `replayV2Types.ts`, cross-checked against the
backend canonical golden. `VITE_REPLAY_PRODUCT_V2_ENABLED=0` is the default and
the v2 module is not imported by either composition root, so it creates no UI,
network request, socket, store, or background task. Direct `?product=v2` access
continues to fail closed until a later product phase owns the route.

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
