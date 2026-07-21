# CandleScope Script Runtime Protocol v1

## Transport

- The sidecar reads one UTF-8 JSON-RPC 2.0 request per stdin line.
- It writes exactly one response per stdout line and flushes immediately.
- Logs and diagnostics that are not protocol responses go to stderr.
- Request IDs are required; JSON-RPC notifications are not part of v1.
- The default SDK message limit is 16 MiB.

The session begins with `handshake`. Every other method fails with
`HANDSHAKE_REQUIRED` until negotiation succeeds.

## Feature identifiers

```text
source-analysis/1
batch-execution/1
render.line-series/1
```

A runtime declares all supported features and the subset it requires from the
host. The handshake fails closed when a required host feature is missing.
Optional methods may only be invoked when their feature was negotiated.

## Methods

### handshake

```json
{"jsonrpc":"2.0","id":1,"method":"handshake","params":{"protocols":["candlescope.script-runtime/1"],"host":{"name":"CandleScope","version":"0.1.0"},"hostFeatures":["source-analysis/1","batch-execution/1","render.line-series/1"]}}
```

The result selects one protocol, returns the runtime descriptor, and lists the
intersection as `negotiatedFeatures`.

### describe

Returns the runtime ID, display name, package/version, language descriptors,
supported features, required host features, and JSON-compatible metadata.

### analyze

Accepts `source`, `context`, and optional `options`. It returns `ok`,
`executable`, structured diagnostics, declared inputs/dependencies, and meta.
Source errors are normal results, not JSON-RPC transport errors.

### executeBatch

Accepts `source`, `context`, `bars`, optional `params`, and optional `options`.
Each bar uses unix seconds plus OHLCV and `isClosed`. A successful result owns a
`candlescope.render/1` document. v1 render output contains line series with
stable IDs, pane/scale metadata, style, and time/value points.

Runtime compile/execution failures return `ok=false` plus diagnostics. Malformed
protocol input uses JSON-RPC errors.

### shutdown

Returns `{ "ok": true }`. The SDK server flushes that response and exits the
read loop. A host that needs a hard timeout owns process termination policy.

## Compatibility rules

- A different protocol identifier is incompatible until explicitly supported.
- Unknown methods fail with JSON-RPC `-32601`.
- Malformed params fail with `-32602` and a stable symbolic code in error data.
- Unknown optional object fields may be ignored within protocol v1.
- New render types require a new negotiated feature; they cannot masquerade as
  line series.
- IDs, feature names, protocol names, and result schema names are case-sensitive.
