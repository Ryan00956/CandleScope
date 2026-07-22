# CandleScope Plugin Platform Protocol v2

`candlescope.plugin/2` is the additive control-plane contract for general
CandleScope backend plugin entrypoints. It does not replace
`candlescope.script-runtime/1` and it does not grant direct access to
CandleScope internals.

This document describes the Phase 1 control contract plus additive contracts
shipped through Phase 9. The CandleScope product now supplies the Host,
installer, permission broker, core services, scoped read-only live market
consumer, marker-only chart-layer registry, declarative/sandbox UI surfaces,
and controlled integration gateways. Market-data providers and trading brokers
remain independently gated. A Python process using this SDK is not thereby a
security sandbox.

## Stable identifiers

| Identifier | Purpose |
| --- | --- |
| `candlescope.plugin/2` | Host-to-plugin lifecycle and contribution invocation |
| `candlescope.host-api/1` | Plugin-to-Host capability calls through `host.call` |
| `jsonl/1` | One bounded UTF-8 JSON-RPC frame per line |
| manifest `schemaVersion: 2` | Static identity, entrypoints, contributions, permissions, and probes |

The distribution remains dependency-free at runtime and requires Python 3.11
or later. The v2 API is isolated under `candlescope_plugin_sdk.platform_v2`;
existing v1 imports and wire fixtures remain unchanged.

## Framing and strict JSON

Every control frame is a JSON-RPC 2.0 object with an explicit `generation`:

```json
{
  "jsonrpc": "2.0",
  "id": "invoke-1",
  "method": "invoke",
  "params": {},
  "generation": 3
}
```

Responses contain exactly one of `result` or `error`, retain the same `id`,
and carry the owning generation. Requests and responses reject unknown envelope
fields. Notifications without an ID are not part of this protocol.

Default SDK limits are:

- 1 MiB per control frame;
- nesting depth 32;
- 10,000 members/items per JSON container;
- 256 KiB UTF-8 bytes per string;
- 32 in-flight invocations per entrypoint;
- integers restricted to the interoperable 53-bit range.

The strict decoder rejects invalid UTF-8, duplicate object keys, `NaN`,
`Infinity`, non-finite exponents, excessive depth/size, non-string keys, and
unsafe integers before model dispatch.

Canonical JSON uses UTF-8, lexicographically sorted object keys, no insignificant
whitespace, shortest deterministic finite number spelling, `-0` normalized to
`0`, and no ASCII escaping for ordinary Unicode scalar values. The fixed
language-neutral fixture is
`tests/fixtures/hello_command_transcript_v2.json`. TypeScript or Rust SDKs must
reproduce its hashes before claiming compatibility.

## Manifest v2

The authoritative JSON Schema ships inside the wheel at
`candlescope_plugin_sdk/platform_v2/schemas/manifest-v2.schema.json` and is
available through `manifest_schema()`.

The normalized manifest shape is:

```json
{
  "schemaVersion": 2,
  "plugin": {
    "id": "acme.market-scanner",
    "name": "ACME Market Scanner",
    "version": "1.2.0",
    "publisher": "acme",
    "license": "MIT",
    "engines": {
      "candlescope": ">=0.4.0 <0.5.0"
    }
  },
  "backend": {
    "entrypoints": [
      {
        "id": "main",
        "pythonModule": "acme_market_scanner",
        "resourceProfile": "standard",
        "activationEvents": ["onCommand", "onView"]
      }
    ]
  },
  "contributions": [
    {
      "id": "scan",
      "kind": "command/1",
      "title": "Scan current market",
      "entrypoint": "main",
      "configuration": {}
    }
  ],
  "permissions": {
    "required": [
      {
        "id": "market.bars.read",
        "scope": {
          "maxSymbolsPerCall": 50
        }
      }
    ],
    "optional": []
  },
  "probes": [
    {
      "id": "descriptor",
      "kind": "controlTranscript",
      "sha256": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      "entrypoint": "main"
    }
  ]
}
```

`contribution.configuration` and `permission.scope` are the only intentionally
extensible manifest objects. They still contain bounded JSON, but their keys
are interpreted by the negotiated contribution/capability version. All other
manifest objects reject unknown fields.

The Python model additionally enforces constraints JSON Schema cannot express
concisely:

- entrypoint, contribution, surface, permission, and probe IDs are unique;
- every contribution and probe references a declared entrypoint;
- required and optional permissions do not overlap;
- a runtime descriptor cannot add identity, contributions, or permissions not
  present in the manifest.

The positive reference is
`examples/platform-v2/hello-command.manifest.json`; intentionally invalid
unknown-field, missing-field, and activation-event examples live in its
`invalid/` directory. Tests require the schema and Python model to agree on all
of those cases.

## Lifecycle

The reference dispatcher implements this state sequence:

```text
created -> handshaken -> active -> quiescing
                     \-> handshaken (deactivate)
any handshaken/active state -> closed (shutdown)
```

Activation generations are positive and monotonically increasing. Handshake,
inactive `describe`, and inactive `shutdown` use generation 0. Every active
method, request context, capability handle, deferred invocation, Host API call,
and response is bound to the exact active generation. Stale results fail
closed.

### `handshake`

The Host offers protocols, Host API versions, control transports, and one exact
entrypoint. The plugin selects `candlescope.plugin/2` and `jsonl/1`, validates
the entrypoint, returns its static descriptor, and negotiates only Host APIs it
declared.

The descriptor contains plugin identity, entrypoint, a manifest-declared subset
of contributions, exact required/optional permissions, required/optional Host
APIs, and features. A descriptor/manifest mismatch is a plugin contract
violation.

### `describe`

Returns the same immutable descriptor used during handshake. It cannot discover
new permissions or contributions dynamically.

### `activate`

Carries `instanceId`, a new generation, and opaque capability grants. Grant
permission IDs must be declared in the descriptor; all required permissions
must be present. The plugin receives no database, filesystem path, network
socket, secret, DataManager, EventBus, DOM, or React object.

### `invoke`

Carries a local contribution ID, a bounded JSON input object, and:

```json
{
  "contributionId": "scan",
  "userAction": true,
  "generation": 3,
  "traceId": "trace-123"
}
```

The contribution must appear in the descriptor and the context must match the
envelope generation. Results are bounded JSON objects. The SDK reference
dispatcher also supports deferred invocations so cancellation can be tested
without threads or an unbounded work queue.

### `eventBatch`

Delivers one bounded list of public event DTOs plus delivery metadata. It is
used for low-rate control events and Phase 6 bounded K-line batches. It is not
an unbounded order-book, trade, file, or large-history transport. Dedicated
named-pipe/UDS and optional binary codecs remain a later measured data-plane
optimization, not a capability plugins may assume.

### `healthCheck`

Returns a structured JSON object suitable for Host-side redaction. It must not
expose secrets, absolute paths, capability handles, source text, or private
stderr.

### `cancel`

Takes `{ "requestId": ... }`. Cancelling an in-flight invocation completes the
original request with `REQUEST_CANCELLED`, releases any associated Host API
correlation, invokes the plugin cancellation hook, and then acknowledges the
cancel request. A late Host API response no longer owns authority.

### `prepareUpgrade`

Enters quiescing, rejects new invocations, cancels bounded pending work, and
allows the plugin to release upgrade-sensitive resources. Atomic activation and
rollback belong to the Host installer phases.

### `deactivate`

Cancels pending work, invalidates capability handles, releases activation-local
resources, and returns to the inactive handshaken state. Reactivation requires a
strictly greater generation.

### `shutdown`

Cancels pending work, invokes process cleanup, writes the final response, and
then closes the reference JSON Lines server.

## Bidirectional `host.call`

A plugin cannot name a permission and call the Host directly. It must use an
opaque handle received during `activate`:

```json
{
  "jsonrpc": "2.0",
  "id": "plugin:3:1",
  "method": "host.call",
  "params": {
    "capabilityHandle": "opaque-handle",
    "method": "market.bars.read",
    "params": {},
    "requestContext": {
      "contributionId": "scan",
      "userAction": true,
      "generation": 3,
      "traceId": "trace-123"
    }
  },
  "generation": 3
}
```

The reference dispatcher assigns a plugin-direction request ID, suspends the
originating Host invocation, correlates the response, and resumes the original
request. Unknown handles, unnegotiated `candlescope.host-api/1`, mismatched
context, duplicate in-flight IDs, stale generations, cancelled correlations,
and unknown responses fail closed.

A stale-generation response does not consume the still-current pending
correlation. A later response with the exact negotiated generation can still
complete the original invocation; once cancelled or completed, the correlation
cannot be reused.

`complete_host_call()` may return another `HostCallInvocation`. This performs a
sequential, bounded chain while retaining the original request context and
generation; it does not create concurrent authority or bypass per-method rate,
activation, response-size, and runtime in-flight budgets. Market Scanner uses
this to read settings, symbols, each scoped series, private storage, and a chart
layer without receiving any Host Python object.

The SDK validates correlation and static ownership. The CandleScope Host must
still validate that the opaque handle binds the exact plugin, publisher,
installation digest, entrypoint, process instance, generation, permission
scope, expiration, and rate policy.

## Phase 6 market consumer and chart layer

The public SDK exports strict request models and schema identifiers for:

- `market.symbols.read`;
- `market.bars.read`, `market.bars.subscribe`, `market.bars.cancel`, and
  `market.bars.resume`;
- `market.trades.read` and `market.order-book.read`;
- `chart.layer.publish` with marker-only `candlescope.render/1`.

Every market request carries an explicit context:

```json
{
  "mode": "live",
  "exchange": "binance",
  "marketType": "spot"
}
```

Live Host adapters reject `mode: replay` even if a malformed or over-broad
grant tries to include it. Symbol, market, interval, history depth, item count,
order-book depth, and concurrency are checked against the opaque lease before
the DataManager adapter runs. Bar pages include explicit coverage,
trusted-finality, source-quality, missing-range, pagination, and availability
fields; no unknown provenance is promoted to verified continuity.
`trustedFinal` is true only when both `allRowsFinal` and
`verifiedContiguous` are explicitly true.

Bar subscriptions bind one exact series and activation generation. Forming
updates use latest-only coalescing. Closed and amended rows enter a reliable
bounded queue; saturation emits `resyncRequired: true` and tears down the
consumer lease instead of silently dropping final data. Successful batches use
monotonic sequence numbers, retain a small bounded resume window, and otherwise
require an explicit resync. Revocation, disable, crash, generation change, or
Host stop releases both the DataManager event subscription and stream consumer
lease.

Render IR v1 accepts declarative markers only. The Host validates IDs, time,
position, shape, hex color, optional price, text length, total items, encoded
bytes, revision, layer contribution ownership, context, and generation. Phase
7 owns native frontend consumption; Phase 6 does not load plugin JavaScript.

## Phase 9 controlled integration gateways

The public SDK exports strict, bounded models for three Host-owned integration
paths:

- `network.http.request` under an opaque `network.connect` handle;
- `filesystem.user-selected.read` and `filesystem.user-selected.write` under
  separate open/save handles;
- `candlescope.http-endpoint-request/1` and
  `candlescope.http-endpoint-response/1` for a declared `http-endpoint/1`.

The network request supports only GET/POST, credential-free HTTPS URLs, a small
header allowlist, canonical base64 bodies, and at most 128 KiB. The product Host
additionally enforces exact lowercase DNS names, ports, methods, byte limits,
redirect count, concurrency, rate, public-only DNS resolution, and a pinned
resolved address for each hop. `Authorization`, cookies, response cookies, and
arbitrary headers are not part of the contract. The sidecar and sandbox iframe
retain no direct-egress authority.

User file selection never sends a path to the plugin. A trusted desktop user
action gives the Host browser bytes or a native save destination; the Host mints
a short-lived opaque handle bound to the plugin, contribution, field, direction,
lease, media type, and byte limit. A handle is consumed once. Save output first
becomes a one-shot Host download receipt whose size and SHA-256 are verified by
the browser before the selected destination is written. Phase 9 commands support
multiple open inputs but at most one save destination.

Declared endpoints live only under
`/api/v2/plugins/endpoints/{pluginId}/{endpointId}`. The Host applies loopback,
Host/Origin/fetch-metadata, namespace, method, request/response size,
concurrency, and rate checks before invoking the contribution. Buffered output
is limited to inert JSON, text, or octet-stream content; the alternative
`server-events` mode is a finite bounded SSE batch, not a persistent arbitrary
socket. Disable, uninstall, permission revocation, and generation replacement
remove registrations and reclaim Host-owned resources.

These are additive Host interpretations of manifest v2 contribution
configuration and permission scopes. They do not change the frozen Phase 1
manifest schema or expose Host Python objects, absolute paths, sockets, or
credentials to SDK code.

## Error behavior

Standard JSON-RPC parse/request/method/params/internal codes are retained.
Stable v2 symbolic codes include:

- `HANDSHAKE_REQUIRED`, `PROTOCOL_UNSUPPORTED`, `HOST_API_UNSUPPORTED`;
- `GENERATION_MISMATCH`, `STALE_GENERATION`, `STALE_HOST_CALL_RESPONSE`;
- `CAPABILITY_GRANTS_INVALID`, `CAPABILITY_HANDLE_INVALID`;
- `CONTRIBUTION_NOT_DECLARED`, `DESCRIPTOR_MANIFEST_MISMATCH`;
- `REQUEST_ID_IN_USE`, `IN_FLIGHT_LIMIT`, `REQUEST_CANCELLED`;
- `HOST_CALL_NOT_PENDING`, `PLUGIN_QUIESCING`, `SESSION_CLOSED`.

Expected public failures are JSON-RPC errors. Unexpected plugin exceptions are
written to stderr and become a stable `INTERNAL_ERROR` without exposing the
private exception text on stdout.

## Reference implementation and boundaries

Run the SDK examples after installation:

```powershell
candlescope-hello-command
candlescope-market-scanner
candlescope-integration-gateway
```

Hello Command contributes one permission-free `command/1`, supports activation, invocation,
health, deferred cancellation, deactivation, and shutdown, and has a fixed
transcript. Market Scanner is an integration reference for scoped read/storage/layer
Host calls. Integration Gateway is the credential-free reference for Phase 9
HTTPS, file, and endpoint contracts. An SDK executable alone still grants no
capabilities; none of these examples proves product UI, untrusted OS sandboxing,
secrets, trading, or marketplace trust.

The reference server is deliberately synchronous and bounded. Phase 2 owns the
production Host supervisor, async concurrent reader/writer, process generation,
timeouts, reentrancy policy, and circuit breaking; it must preserve this wire
contract rather than importing plugin implementation code.
