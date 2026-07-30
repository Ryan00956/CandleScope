# CandleScope Plugin Platform Protocol v2

`candlescope.plugin/2` is the additive control-plane contract for general
CandleScope backend plugin entrypoints. It does not replace
`candlescope.script-runtime/1` and it does not grant direct access to
CandleScope internals.

This document describes the Phase 1 control contract plus additive contracts
shipped through Phase 11A. The CandleScope product now supplies the Host,
installer, permission broker, core services, scoped read-only live market
consumer, Host-owned chart analysis layers, declarative/sandbox UI surfaces,
controlled integration gateways, public market-data providers, and an explicitly
pinned Paper-only broker. Live account and trading brokers remain independently gated. A Python process using this SDK is
not thereby a security sandbox.

## Stable identifiers

| Identifier | Purpose |
| --- | --- |
| `candlescope.plugin/2` | Host-to-plugin lifecycle and contribution invocation |
| `candlescope.host-api/1` | Plugin-to-Host capability calls through `host.call` |
| `candlescope.stream/1` | Host-polled provider data plane for bounded public market streams |
| `candlescope.paper/1` | Intent/ack protocol for the Host-owned Paper broker |
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

Current Hosts add a Host-minted, non-user-action `requestContext` to public
event and market-stream delivery metadata. The reference dispatcher therefore
allows `event_batch()` to return the same `HostCallInvocation` or
`DeferredInvocation` outcomes as `invoke()`. The Host binds that context only
for the lifetime of the batch request. A plugin cannot invent a context, turn
it into user-action authority, or use it after completion/cancellation.

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

`requestContext.userAction` is contextual information sent by the Host, never a
capability credential supplied by the sidecar. For a Host method that requires a
user action, the Host mints an internal, invocation-bound one-shot credential
only for a real user invocation and consumes it before the side effect begins.
Echoing or changing `userAction` cannot mint that credential; a second
user-action side effect in the same host-call chain requires a new user
invocation. Non-user-action methods remain available to bounded sequential
chains.

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
- `chart.context.read`;
- `chart.layer.publish` with marker-only `candlescope.render/1` or bounded
  analysis geometry in `candlescope.render/2`.

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

Render IR v1 remains frozen and accepts declarative markers only. The Host validates IDs, time,
position, shape, hex color, optional price, text length, total items, encoded
bytes, revision, layer contribution ownership, context, and generation. Phase
7 owns native frontend consumption; Phase 6 does not load plugin JavaScript.

The additive `chart-layer/2` contribution uses `candlescope.render/2`. Its
declarative items are `marker`, `polyline`, `price-line`, `band`, and `label`.
The Host validates exact item shapes, finite prices, strictly increasing
polyline times, line styles/widths, text and color bounds, aggregate item,
point, and encoded-byte budgets. One polyline is limited to 10,000 points by
the control-protocol container bound; `maxPoints` is the aggregate layer
budget and may be higher across multiple polylines. The plugin still receives no Lightweight
Charts instance and cannot supply JavaScript, callbacks, HTML, Canvas commands,
or arbitrary component names.

`chart.context.read` accepts only `{ "chartId": "main-chart" }` and returns a
`candlescope.chart-context/1` snapshot. An active snapshot contains the exact
live market context, series, and a Host-owned chart revision. A v2 layer
publish must echo `chartId`, `chartRevision`, context, and series; a switch,
expiry, stale revision, generation replacement, or permission-scope mismatch
fails closed. The permission scope must include `chartIds`, contexts,
exchanges, market types, symbols, and intervals. The layer publish scope also
includes local layer IDs plus `maxItems` and `maxPoints`.

The Host publishes `candlescope.chart.context-changed/1` with only chart ID,
revision, and active state. A declared `event-subscriber/1` may react by using
the batch request context to call `chart.context.read`, cancel/resubscribe the
old market stream, and publish a fresh layer. Market bar batches use the same
correlated path, so incremental analyzers do not need a timer or private Host
object.

The current product adapter is intentionally limited to the trusted desktop
`main-chart`, live time-axis representations, and bounded JSON updates. Replay
contexts, derived/ordinal chart representations, hit testing, arbitrary plugin
frontend code, and a high-frequency binary render channel are not part of this
contract.

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

## Phase 10 public market-data providers

A provider declares exactly one paired `symbol-provider/1` and
`market-data-provider/1` for each exchange ID. Both contributions must use the
same entrypoint. The symbol contribution owns canonical market types, symbol
pagination, and cache TTL. The market-data contribution declares the
`candlescope.stream/1` data plane, source quality, and bounded channel budgets.
Phase 10 channels are limited to Kline and full depth:

- Kline may declare history and/or realtime, explicit or inferred finality,
  explicit correction support, fixed intervals, page/batch bounds, rate, and
  concurrency;
- full depth is realtime-only and requires a snapshot followed by linked
  ordered deltas with range sequence IDs and `snapshot_replay` resync.

The Host invokes provider contributions through the normal `invoke` method.
The input operation is one of `symbols.list`, `history.read`, `stream.open`,
`stream.poll`, or `stream.close`. Responses use the strict schemas
`candlescope.provider-symbols-page/1`,
`candlescope.provider-history-page/1`,
`candlescope.provider-stream-open/1`,
`candlescope.provider-stream-batch/1`, and
`candlescope.provider-stream-close/1`. Every history page and stream batch
carries `sourceQuality`; every Kline carries one of `forming`, `final`, or
`corrected`. A corrected final bar must be emitted as `bar.amended`, not as a
new open-time identity.

Provider transport sequences are Host-checked and contiguous. The provider
stream ID and activation generation bind every poll; a stale generation,
non-advancing page cursor, duplicate/oversized batch, malformed finality, or
order-book sequence gap fails closed. A stream failure closes that provider
session and reconnects with `resync: true`; it does not replace or restart any
other exchange adapter.

The public contract deliberately does not expose CandleScope cache objects,
SQLite, GapLedger, EventBus, DataManager, raw sockets, credentials, account
state, or order execution. Provider rows are normalized by the Host and enter
the existing ingestion, continuity, aggregation, backfill, and storage path.
The packaged `candlescope-mock-exchange-provider` executable and
`platform_v2.examples.mock_exchange_provider` module form the deterministic
reference implementation.

## Phase 11A Paper-only accounts and orders

A Paper broker declares one paired `account-provider/1` and `order-executor/1`
per broker ID on the same entrypoint. The account contribution declares bounded
fixture accounts and initial balances. The executor declares symbols, tick/step,
quantity/notional/position/rate/open-order limits, supported market/limit order
types, and `candlescope.paper/1`. Phase 11A requires `accounts.read` and
`trade.simulate`; `secrets.use`, `network.connect`, `trade.submit`, and
`trade.cancel` remain unavailable.

`OrderIntent` uses canonical decimal strings and carries broker/account,
client-order and idempotency IDs, symbol/market, side/type, quantity, optional
limit price, and an exact Host quote ID plus observed market time. The sidecar
may only return a strict `candlescope.paper-executor-ack/1` with `accepted`,
`rejected`, or `unknown`; it cannot choose balances, fill price, fees, risk
outcome, or account state. `accounts.snapshot`, `orders.submit`,
`orders.cancel`, and `orders.recover` are the only Paper operations.

The Host serializes submit/cancel/fill races, binds each idempotency key to the
canonical intent hash, persists pending state before invocation, and never
blindly replays an unknown submission or cancellation. Recovery is explicit.
The legacy `orders.recover` shape targets `orders.submit`; cancel recovery adds
`"targetOperation": "orders.cancel"` and the exact `orderId`, using the cancel
idempotency key. An accepted cancel-recovery acknowledgement means the
cancellation completed, a rejected acknowledgement restores the pre-cancel
order state, and `unknown` remains fail-closed. Submission recovery is rejected
while the same order has an unresolved cancel. Quotes are Host-published,
time-bounded, and exact-ID matched, so future or stale prices fail before
sidecar invocation. The Host owns the ledger, reservation/fill rules, immutable
audit events, and a persisted global kill switch. Disabling a plugin or revoking
either Paper grant removes the active broker before the next action. This mode
is available only when the product explicitly enables Paper trading under
`first-party-pinned`; saved grants become ineffective if that policy is absent
on restart.

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
candlescope-mock-exchange-provider
candlescope-paper-broker
```

Hello Command contributes one permission-free `command/1`, supports activation, invocation,
health, deferred cancellation, deactivation, and shutdown, and has a fixed
transcript. Market Scanner is an integration reference for scoped read/storage/layer
Host calls. Integration Gateway is the credential-free reference for Phase 9
HTTPS, file, and endpoint contracts. An SDK executable alone still grants no
capabilities. Mock Exchange Provider is the deterministic Phase 10 reference
for symbol/history/Kline/full-depth contracts. Paper Broker is the deterministic
Phase 11A reference for intent acknowledgement; it does not prove or obtain live
execution. None of these examples proves secrets, live trading, or marketplace trust.

The reference server is deliberately synchronous and bounded. Phase 2 owns the
production Host supervisor, async concurrent reader/writer, process generation,
timeouts, reentrancy policy, and circuit breaking; it must preserve this wire
contract rather than importing plugin implementation code.
