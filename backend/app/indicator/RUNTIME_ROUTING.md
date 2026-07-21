# Indicator Runtime Routing

[简体中文](RUNTIME_ROUTING_zh.md)

Phase 4 connects CandleScope's stable Indicator transports to the generic
script-runtime Host. Runtime packages still implement only the public
`candlescope-plugin-sdk`; they do not import `app.indicator`, FastAPI routes,
DataManager, or frontend payload code.

## Two independent files

Plugin activation and traffic routing deliberately use different schemas:

- `runtime-registry.json` says which verified sidecar installation the Host can
  launch;
- `indicator-runtime-routes.json` says which runtime, if any, receives each
  script language.

The default route path is beside the activation registry:

- Windows: `%LOCALAPPDATA%/CandleScope/plugins/indicator-runtime-routes.json`;
- Linux: `$XDG_DATA_HOME/candlescope/plugins/indicator-runtime-routes.json`, or
  `~/.local/share/candlescope/plugins/indicator-runtime-routes.json`.

Override it with `CANDLESCOPE_INDICATOR_RUNTIME_ROUTES`. Since Phase 8, an
absent default file selects both managed first-party routes:
`pyne=sidecar,candlescope.pyne` and
`pine=sidecar,candlescope.pine-compat`. If either required plugin is not
installed and active, application startup fails closed. An explicitly selected
missing or invalid file also fails startup and remains the per-language
rollback mechanism.

```json
{
  "schemaVersion": 1,
  "routes": [
    {
      "language": "pyne",
      "mode": "shadow",
      "runtimeId": "candlescope.pyne"
    },
    {
      "language": "pine",
      "mode": "sidecar",
      "runtimeId": "candlescope.pine-compat"
    }
  ]
}
```

`language` and `runtimeId` are stable lowercase identifiers. Every language
appears at most once. The current `pyne` route must be explicit. A `legacy`
route must omit `runtimeId`; `shadow` and `sidecar` require it. Routes are read
once at startup and are not hot-reloaded.

Existing clients omit `language` and therefore remain `pyne`. API/WS clients
may explicitly send another configured language ID, allowing a community
runtime to use `sidecar` without a CandleScope-private adapter. Phase 4 has a
legacy adapter only for `pyne`, so every other language must use `sidecar`.
Since Phase 7, the frontend discovers these languages from the public catalog
instead of a closed runtime-ID union.

## Public runtime catalog

`GET /api/v1/indicators/runtimes` projects the startup-validated routes and
runtime descriptors into a versioned public catalog:

```json
{
  "schemaVersion": 1,
  "defaultLanguage": "pyne",
  "languages": [
    {
      "id": "pyne",
      "name": "Pyne",
      "extensions": [".pyne"],
      "aliases": ["pyne"],
      "runtimeId": "candlescope.pyne",
      "routeMode": "sidecar",
      "available": true,
      "features": ["batch-execution/1", "render.line-series/1"]
    }
  ],
  "runtimes": [
    {
      "id": "candlescope.pyne",
      "name": "CandleScope Pyne Runtime",
      "version": "0.2.0",
      "package": "candlescope-plugin-pyne",
      "languages": [
        {"id": "pyne", "name": "Pyne", "extensions": [".pyne"], "aliases": ["pyne"]}
      ],
      "features": ["batch-execution/1", "render.line-series/1"],
      "requiredHostFeatures": [],
      "meta": {}
    }
  ]
}
```

The response includes each referenced public SDK runtime descriptor under
`runtimes`. It never includes registry paths, process commands, PIDs, stderr, or
host failure details. Runtime metadata is JSON data only. The optional
`meta.ui.languages.<language-id>` convention may provide `monacoLanguage` and
`starterSource` strings; it cannot inject frontend code. Unknown languages use
the host's plaintext editor fallback.

## Route semantics

| Mode | User-visible result | Sidecar behavior | Failure behavior |
|---|---|---|---|
| `legacy` | Existing in-process result | Not called | Existing behavior |
| `shadow` | Exact legacy result | Receives the same source, context, params, options, and immutable bar batch | Recorded internally; never changes the response |
| `sidecar` | Plugin result adapted from `candlescope.render/1` | Sole executor | Returns a host-owned unavailable error; never silently falls back |

Shadow work starts alongside legacy work but does not extend response latency.
The service admits at most 64 pending comparisons per process. When that hard
limit is full, the request still runs and returns legacy, but no new sidecar
work is started; `shadowSkipped`, `pendingShadow`, and `maxPendingShadow` expose
the condition in diagnostics. Admitted comparisons are owned by the application
lifecycle. Diagnostics keep only hashes, differing top-level field names,
transport, runtime ID, status, and counters; source, bars, params, process
commands, stderr, and the local route-file path are not retained there.

At startup every non-legacy route is verified against the runtime descriptor.
The runtime must declare the routed language plus `batch-execution/1` and
`render.line-series/1`. A typo or capability mismatch fails closed before any
Indicator request is accepted.

## Transport coverage

One `IndicatorRuntimeService` is shared by:

- `GET /api/v1/indicators/runtimes` for descriptor-driven discovery;
- `POST /api/v1/indicators/compute`;
- `POST /api/v1/indicators/range`;
- `POST /api/v1/indicators/range/batch`;
- script subscriptions on `WS /api/v1/stream/indicators`.

The Host owns market context and OHLCV input. Runtime output is translated by a
CandleScope-owned adapter, so a plugin cannot redefine HTTP/WS envelopes. Range
host failures are transient and are not written to the Indicator range cache.
Cached payloads are re-scoped to the requesting `clientId`/`indicatorId`.
Script cache identity includes the language, so different runtimes cannot share
a result or singleflight merely because their source hashes match.

Line series remain the base Render IR v1 feature. Negotiated
`render.histogram-series/1` and `render.structured-output/1` add histograms,
markers, horizontal lines, fills, backgrounds, bar colors, signals, strategy
reports, and drawing objects. The Pyne 0.2.0 bridge uses those features to
rebuild the frozen Phase 0 payloads. The Pine Compatibility 0.2.0 bridge uses
the same public IR for its supported plot subset and fails closed on unmapped
features. True stateful realtime sessions remain outside protocol v1; the
public Pine release executes closed-bar batches only.

## Safe rollout

1. Install and activate a pinned `.cspkg`; restart CandleScope.
2. Keep the language on `legacy` and verify `/health` reports the runtime ready.
3. Change only that language to `shadow`; restart again.
4. Exercise compute, range/batch, and WebSocket traffic. Inspect
   `/api/v1/indicators/diagnostics` under `scriptRuntimeRouting`.
5. Require the frozen compatibility goldens and an agreed shadow match window.
6. Change the route to `sidecar`; the Phase 6 built-in default has completed
   this switch. Keep the old implementation available for an explicit route
   rollback until the later source-deletion commit.
7. Delete a vendored runtime snapshot only in a later, independent commit.

Emergency rollback is a route-file edit back to `legacy` plus an application
restart. `CANDLESCOPE_PLUGIN_HOST_ENABLED=0` can disable the entire Host, but a
configured `shadow` or `sidecar` route then intentionally fails startup rather
than pretending that the rollout is healthy.

Phase 4 does not ship the Pyne bridge and does not remove CandleScope's current
Pyne source snapshot. Those are separate Phase 5/6 deliverables.
