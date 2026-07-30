# Phase 11B WP-E — Host-native Live control contract

## 1. Scope and stop gate

WP-E installs the authorization and emergency-control plane needed before any
Live order mutation can be considered. It does **not** add a submit, cancel,
amend, transfer, withdrawal, or generic authenticated-network method.

The feature is off unless all of these Host flags are enabled:

- `CANDLESCOPE_PLUGIN_PLATFORM_V2_LIVE_BROKER_FOUNDATION_ENABLED`;
- `CANDLESCOPE_PLUGIN_PLATFORM_V2_LIVE_ACCOUNT_READONLY_ENABLED`;
- `CANDLESCOPE_PLUGIN_PLATFORM_V2_LIVE_RECONCILIATION_SHADOW_ENABLED`;
- `CANDLESCOPE_PLUGIN_PLATFORM_V2_LIVE_NATIVE_CONTROL_ENABLED`.

The platform must still be `first-party-pinned`. No plugin manifest,
contribution, SDK object, sandbox bridge, or public Host API gains a Live
trading capability in this work package.

WP-F remains the first work package allowed to add one pinned testnet
submit/cancel path. WP-E must stop and commit independently before WP-F.

## 2. Persistence and rollback boundary

WP-E owns a separate Broker-private SQLite database,
`live-control-v1.sqlite3`. It does not mutate the WP-C Broker state schema or
the WP-D shadow journal schema.

The database contains:

- one persistent control projection (`disarmed`, `armed`, or `killed`);
- a monotonically increasing control generation;
- bounded, opaque, short-lived confirmation receipts;
- an append-only SHA-256 event chain.

Only hashes of account, shadow, receipt, credential, grant, plugin, and
publisher handles are written to the control ledger. Secret bytes, auth
headers, signatures, passphrases, raw exchange responses, and raw opaque
handles are forbidden.

Turning the WP-E flag off starts no control database and exposes no management
mutation. Downgrade is performed by first invoking global kill, stopping the
Broker, and archiving the three SQLite files (`.sqlite3`, `-wal`, and `-shm`)
together with `backend/scripts/archive_live_control_v1.py` and a verified
audit export. A pre-WP-E build must reject or ignore no unknown data silently.

## 3. Persistent control semantics

- New stores start `disarmed`, never armed.
- `armed` means only that Host confirmation receipts may be issued. It does
  not imply that a submit method exists.
- `disarmed` rejects new receipts and revokes every outstanding receipt.
- `killed` rejects new receipts, revokes outstanding receipts, advances the
  Broker policy epoch, clears all credential/account bindings, and closes the
  authority epoch before the management call returns.
- Re-arming after `killed` requires an explicit Host acknowledgement. It
  cannot restore credentials or account bindings revoked by the kill.
- A restart preserves the projection. Any observed policy/control projection
  mismatch recovers to `killed`, never to `armed`.

Grant revoke, plugin disable/rollback/uninstall, publisher revoke, credential
revoke/rotation, and global kill all use the same conservative policy-advance
path. Until selective Live grants exist, each such action invalidates all
outstanding Live receipts and all Broker credential/account bindings.

## 4. Intent-bound confirmation

Confirmation is a two-step Host-only flow:

1. `preview` loads a current `prepared` WP-D shadow plus its current account
   binding and returns the exact instrument, side, order type, quantity,
   limit price, client order ID, plugin, publisher, connector, intent hash,
   policy epoch, and control generation.
2. The Host-native modal renders those values above every plugin iframe. Only
   an explicit user action calls `issue`, carrying the previewed intent hash.

The Broker rejects preview or issue when:

- control is not armed;
- the account is inactive, stale, revoked, or from another policy epoch;
- the shadow is not `prepared`, has entered reconciliation, or belongs to
  another account/plugin/publisher/connector;
- the expected intent hash, policy epoch, or control generation changed;
- an unexpired receipt already exists for the same shadow.

A receipt:

- is an opaque bearer reference returned only to the trusted Host;
- is stored only as a SHA-256 hash;
- is bound to one account, shadow, intent hash, client order ID, plugin,
  publisher, connector, policy epoch, and control generation;
- expires after 15–120 seconds;
- has one durable state transition from `issued` to exactly one of
  `consumed`, `revoked`, or `expired`;
- can be consumed only inside the Broker by a future WP-F execution method.

WP-E deliberately exposes no management or plugin endpoint that consumes a
receipt. Unit tests exercise the internal atomic consume primitive so WP-F
cannot later reinterpret “single use”.

## 5. Host and sandbox boundary

The Host exposes:

- a safe read-only public control projection for the persistent banner;
- loopback/session/CSRF/fresh-user-action protected management mutations;
- a React confirmation modal and Live control panel owned by the main Host
  document;
- a redacted audit download.

The banner is visible whenever WP-E is available and distinguishes
`DISARMED`, `ARMED`, `KILLED`, and `UNAVAILABLE`. It cannot be hidden by
closing the control panel. Sandbox iframes receive no token, control action,
confirmation draft, receipt, or audit export and remain below the Host modal
and banner in the stacking order.

## 6. Verifiable audit export

The export is `candlescope.live-audit-export/1` and contains:

- export creation time and a hash of the Broker identity;
- current policy epoch, control projection, and outstanding receipt counts;
- the complete WP-E control event chain;
- the complete WP-D shadow event chain plus redacted shadow metadata;
- source-chain heads and a SHA-256 digest over the final export envelope.

Export pagination happens only across the private Broker pipe while the Host
controller operation lock is held. The final download is therefore one stable
snapshot. Raw opaque references, credential material, authentication data,
signatures, raw venue order IDs, and raw network responses are excluded.

Opening either SQLite store validates its schema, integrity, bounds, event
hash chain, and event-to-projection consistency. Tampering fails Broker start
closed; an export is never produced from an invalid chain.

## 7. Required evidence

WP-E is complete only after:

- flag-off and dependency/trust rejection tests;
- persistence, restart, expiry, one-shot consume, duplicate issue, and
  crash-recovery tests;
- stale epoch/generation, account/shadow mismatch, and tamper tests;
- grant/plugin/publisher/credential/global revoke tests proving the next
  network-capable query is rejected until rebind;
- API origin/session/CSRF/user-action/body-shape and secret-byte-scan tests;
- frontend parser/API/component tests proving the persistent banner and
  exact-intent modal;
- a real production-build browser smoke proving Host stacking and the
  absence of any Live submit/cancel surface;
- focused, affected, full backend, SDK, frontend unit, and frontend static
  gates rerun from the final source.
