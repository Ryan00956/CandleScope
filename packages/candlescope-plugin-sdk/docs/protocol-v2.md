# CandleScope Plugin Platform Protocol v2

`candlescope.plugin/2` is the additive control-plane contract for general
CandleScope backend plugin entrypoints. It does not replace
`candlescope.script-runtime/1` and it does not grant direct access to
CandleScope internals.

This document describes the Phase 1 SDK contract. A shipping CandleScope Host,
bundle installer, permission broker, OS sandbox, frontend bridge, market-data
provider, and trading broker belong to later independently gated phases. A
Python process using this SDK is not thereby a security sandbox.

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

Delivers one bounded list of public event DTOs plus delivery metadata. This is
for low-rate control events, not order books, trades, files, or large history.
Those require the separately negotiated bounded data plane in a later phase.

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

The SDK validates correlation and static ownership. The CandleScope Host must
still validate that the opaque handle binds the exact plugin, publisher,
installation digest, entrypoint, process instance, generation, permission
scope, expiration, and rate policy.

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

Run the SDK example after installation:

```powershell
candlescope-hello-command
```

It contributes one permission-free `command/1`, supports activation, invocation,
health, deferred cancellation, deactivation, and shutdown, and has a fixed
transcript. It does not prove Host installation, product UI, OS sandboxing,
market-data access, secrets, trading, or marketplace trust.

The reference server is deliberately synchronous and bounded. Phase 2 owns the
production Host supervisor, async concurrent reader/writer, process generation,
timeouts, reentrancy policy, and circuit breaking; it must preserve this wire
contract rather than importing plugin implementation code.
