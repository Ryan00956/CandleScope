# Phase 11B WP-F — OKX Demo Spot execution contract

## 1. Authorization and stop gate

The user's 2026-07-23 instruction to continue the next phase authorizes WP-F
only. WP-F is the first work package allowed to send an order mutation, and it
must remain an independently gated and revertible commit.

WP-F adds exactly one build-pinned connector:

- connector: `candlescope.okx-demo-spot-execution`;
- venue/environment: `okx / demo`;
- instrument: `BTC-USDT`;
- trade mode: `cash`;
- order type: `limit`;
- actions: one order submit, one order cancel, and query by stable `clOrdId`.

It does not add production trading, market/margin/derivative orders, amend,
batch order, transfer, deposit, withdrawal, generic signing, generic HTTP,
automated strategy execution, plugin SDK order APIs, or iframe order APIs.
WP-G remains unauthorized.

## 2. Feature and trust dependencies

`CANDLESCOPE_PLUGIN_PLATFORM_V2_LIVE_TESTNET_EXECUTION_ENABLED` defaults to
false. It requires all previous WP-B–WP-E flags:

- Broker foundation;
- authenticated account binding;
- reconciliation shadow;
- Host-native control.

The Host must use `first-party-pinned` trust and the activation must exactly
match the built-in release lock for the execution connector. The production
release lock remains empty. Enabling the flag alone therefore cannot make a
production build trade.

Flag-off starts no execution connector, creates or opens no execution ledger,
and exposes no Host execution route. Existing WP-C read-only account,
WP-D shadow, WP-E control, Paper runtime, SDK, and sandbox behavior remain
unchanged.

## 3. Credential and account boundary

The read-only connector identity continues to require an exact `read_only`
credential. WP-F uses a separate execution connector identity and requires the
OKX account proof to report exactly `read_only,trade`; `withdraw` or any other
permission fails before the account becomes execution eligible.

An account binding records `read_trade`, remains `okx / demo / spot`, and must
be in OKX Spot account mode. A WP-C `read_only` account cannot be silently
used for WP-F. Rebind may change a binding from read-only to execution only
through the new build-pinned connector and a fresh authenticated account
proof.

The API key, secret, passphrase, signature, authentication headers, raw
response, and opaque credential/account handles never enter plugin IPC,
frontend state, logs, audit exports, SQLite, argv, or environment variables.

## 4. Fixed network contract

The only WP-F mutation endpoints are:

- `POST /api/v5/trade/order`;
- `POST /api/v5/trade/cancel-order`.

WP-D query remains:

- `GET /api/v5/trade/order?instId=BTC-USDT&clOrdId=<stable-id>`.

Every request is sent to the pinned `https://openapi.okx.com:443` origin after
public-address DNS validation and TLS hostname verification. Redirects,
proxies, bare IP origins, alternate ports, arbitrary paths, cookies, caller
headers, and generic request bodies are unavailable.

Every Demo request includes `x-simulated-trading: 1`. Submit always uses the
exact canonical body:

```json
{
  "clOrdId": "<stable-id>",
  "instId": "BTC-USDT",
  "ordType": "limit",
  "px": "<canonical-positive-decimal>",
  "side": "buy|sell",
  "sz": "<canonical-positive-decimal>",
  "tdMode": "cash"
}
```

Submit also carries a Broker-generated `expTime` no more than five seconds in
the future. Cancel uses only `instId` and the same `clOrdId`; it never accepts
a caller-supplied venue order ID.

## 5. Hard risk envelope

The Broker re-evaluates risk immediately before receipt consumption:

- instrument exactly `BTC-USDT`;
- Spot cash and limit only;
- quantity and price are canonical positive decimals;
- order notional `quantity × limitPrice` is at most `100 USDT`;
- at most two non-terminal WP-F execution records;
- aggregate unresolved notional is at most `200 USDT`;
- account, credential, plugin, publisher, connector, policy epoch, control
  generation, shadow intent, and receipt all match;
- control mode is still `armed`.

`tdMode=cash` and the absence of margin/borrow fields prevent the Broker from
requesting a short or leveraged position. Venue balance checks remain
authoritative. A rejected or insufficient-balance response is not rewritten
as an accepted order.

These are build constants, not plugin-configurable limits.

## 6. Per-action confirmation

Submit and cancel require separate Host-native typed confirmations.

- A `prepared`, never-dispatched shadow previews action `submit`.
- A query-proven `live` or `partially_filled` order previews action `cancel`.
- The confirmation digest binds action, shadow intent, current venue state,
  risk decision, policy epoch, and control generation.
- The existing opaque receipt remains short-lived and single-use.
- Only the Broker's WP-F execution method may atomically consume it.
- Query/reconciliation is read-only and does not consume a receipt.

The Host shows Demo environment, action, exact order facts, hard limits, and
the confirmation digest above all plugin iframes. Issuing a receipt does not
send a request; submit/cancel requires a second explicit Host click.

## 7. Durable execution ledger

WP-F owns `live-execution-v1.sqlite3`, separate from WP-D shadow and WP-E
control stores. It uses SQLite/WAL, `synchronous=FULL`, exact STRICT schema,
bounded rows/events, and an append-only SHA-256 chain.

Before network dispatch the Broker has already:

1. verified current account/trust/policy/control state;
2. evaluated the fixed risk envelope;
3. atomically consumed the action-bound receipt;
4. persisted action, receipt ID, confirmation/risk digests, stable client
   order ID, connector version, policy epoch, and `submitting` or `canceling`.

Submit/cancel is never retried automatically. Transport failure, timeout,
process crash, or an acknowledgement/persist crash window becomes explicit
`unknown` or `cancel_unknown`. Restart converts interrupted dispatch states to
those conservative states before accepting another operation.

A successful submit acknowledgement records only a SHA-256 of the venue order
ID and remains `unknown` until query. A successful cancel acknowledgement
means only that cancellation was accepted for processing and remains
`cancel_unknown` until query. Query is the only path that projects `live`,
`partially_filled`, `filled`, `canceled`, or `mmp_canceled`.

OKX error `50004` is explicitly ambiguous: it does not prove whether a request
succeeded or failed. Whether it appears as the response envelope code or an
order-level `sCode`, the Broker records the mutation as `unknown` or
`cancel_unknown`, never as terminal `rejected`, and never retries it blindly.

## 8. Kill, revoke, and rollback

Global kill and every authority revoke linearize before the next Broker
operation by advancing policy epoch, clearing credentials/accounts, revoking
receipts, and leaving unresolved execution records available only to the
offline audit/rollback path. Closing a local socket is never described as a
venue cancel.

An orderly WP-F rollback requires:

1. stop issuing new submit receipts while keeping the exact execution
   authority needed for cleanup;
2. query/cancel/query until every execution record is terminal;
3. global kill;
4. a complete v2 audit export verified offline;
5. Broker stop and exclusive root lock;
6. checkpoint/archive of the execution SQLite trio plus audit export;
7. explicit source removal;
8. execution flag off and WP-F commit revert.

For an emergency, global kill remains the first action. Because kill clears
credentials and account bindings, the post-kill path cannot perform an online
query or cancel; it must instead preserve an explicit unresolved export and
complete manual venue review before source removal.

Old downgrade tools reject a remaining execution store. WP-D/WP-E data is not
silently deleted.

## 9. Audit and acceptance

Audit export v2 adds the complete execution event chain, execution head and
redacted projection. It excludes raw opaque references, raw venue order IDs,
credentials, authentication data, signatures, and raw network responses.

WP-F is ready for commit only after:

- exact connector/permission/path/header/body/response tests;
- receipt/action/account/epoch/generation mismatch tests;
- hard-limit and unresolved-cap tests;
- submit and cancel persist-before-send tests;
- timeout and both crash-window recovery tests proving no blind retry;
- cancel acknowledgement remains non-terminal until query;
- kill/revoke before-next-network-action tests;
- schema/index/view/trigger/hash/projection tamper tests;
- secret canary scans;
- Host API guard/body tests and SDK/iframe absence tests;
- a production-build browser flow through submit, query, cancel, query using
  an explicitly authorized test backend;
- focused, affected, full backend, SDK, frontend and static gates.

A real OKX Demo smoke additionally requires a user-owned Demo key with exact
Read + Trade scope, a selected test order, and explicit external-mutation
authorization. Local fake transport evidence cannot be reported as real OKX
compatibility. WP-G and production remain closed even if every WP-F local gate
passes.

Official contract references:

- <https://www.okx.com/docs-v5/en/>
- <https://www.okx.com/en-us/help/api-faq>
