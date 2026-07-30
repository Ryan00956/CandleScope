# v1 script runtime compatibility adapter

Phase 13 keeps `candlescope.script-runtime/1` and `candlescope.render/1`
frozen. A v1 runtime is not rebuilt as a `candlescope.plugin/2` backend and its
activation is never copied into the v2 activation registry. CandleScope owns a
read-only `script-runtime/1` compatibility contribution that describes the
already validated v1 route.

## Author template

Use these existing SDK templates without changing their protocol family:

- runtime implementation:
  `candlescope_plugin_sdk.examples.hello_runtime`;
- bundle manifest:
  `examples/hello-runtime.manifest.json`;
- wire transcript:
  `tests/fixtures/hello_transcript_v1.json`;
- protocol:
  `docs/protocol-v1.md`.

A runtime still implements `BaseRuntimePlugin`, returns a
`RuntimeDescriptor`, and is served with `serve_runtime(...)`. Its `.cspkg`
still uses the v1 numeric `schemaVersion`, declares
`candlescope.script-runtime/1`, contains pinned wheels, and carries exact
analyze/execute probe SHA-256 values.

Do not add `script-runtime/1` to a v2 manifest. It is a Host-owned
compatibility projection, not a community-selectable v2 contribution kind.
Adding it to a v2 manifest remains unsupported and cannot grant a v1 process
access to v2 Host capabilities.

## Release checklist

1. Build every wheel from the intended source and record its SHA-256.
2. Update the v1 manifest version and exact wheel set.
3. Recompute the fixed analyze and execute probe SHA-256 values.
4. Build one immutable `.cspkg`; record the bundle SHA-256 in release
   metadata.
5. Run the SDK transcript and package smoke in fresh Python 3.12 and 3.13
   environments.
6. Run the CandleScope v1 installer `check`, fresh install, quick repeat,
   fresh-process semantic probe, and rollback.
7. Verify the HTTP compute, HTTP range, Indicator WebSocket, and
   `/api/v1/indicators/runtimes` canonical fixtures did not change.
8. In Plugin Manager, preview the v1 registry import and apply only the exact
   preview SHA-256. A changed preview must be reviewed again.

The import stores only a bounded public catalog snapshot. It does not execute
the runtime, rewrite the v1 registry, modify the v1 route table, or install a
v2 bundle.

## Compatibility matrix

| Runtime/release | Install and activation owner | Unified discovery | Execution protocol | Supported migration |
| --- | --- | --- | --- | --- |
| Existing pinned Pyne/Pine v1 `.cspkg` | v1 installer and RuntimeHost | Host compatibility contribution | `candlescope.script-runtime/1` | Explicit catalog import only |
| Community v1 runtime | v1 installer and RuntimeHost | After v1 descriptor/route validation | `candlescope.script-runtime/1` | Explicit catalog import only |
| General v2 plugin | v2 installer and Core Host | Native v2 catalog | `candlescope.plugin/2` | Normal staged v2 lifecycle |
| v2 manifest declaring `script-runtime/1` | none | Shown unsupported | none | Rejected; no guessed conversion |
| v1-only product rollback | v1 installer and RuntimeHost | Live compatibility discovery remains | `candlescope.script-runtime/1` | v2 state is ignored |

## Troubleshooting

- `PLUGIN_V1_COMPATIBILITY_PREVIEW_STALE`: the live route, descriptor, managed
  identity, or import revision changed. Fetch a new preview; never reuse the
  old digest.
- `PLUGIN_V1_COMPATIBILITY_STATE_INVALID`: the independent compatibility state
  is malformed, oversized, unsafe, or corrupt. Keep the v1 registry untouched,
  preserve the invalid file for diagnosis, and operate in v1-only mode until
  the compatibility state is repaired or restored.
- Runtime appears unavailable: inspect the v1 Host health and route mode. A
  sidecar route never silently falls back to the legacy runtime.
- Bundle SHA-256 differs: stop. Do not replace an immutable release in place;
  publish a new version and bundle digest.
- Compatibility import is disabled: enable the general Plugin Platform and use
  a trusted local management session. Live v1 discovery and execution do not
  require importing the snapshot.
