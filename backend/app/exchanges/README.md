# Exchange Plugin Architecture

This package is the long-lived boundary for exchange-specific behavior.
Data Engine, backfill, API, and frontend code should consume exchange behavior
through `ExchangePlugin` and `ExchangeCapabilities`, not by hard-coding
exchange names or calling adapter-specific methods.

## Ownership Model

| Layer | Owns |
|---|---|
| `app.exchanges` | Exchange registry, plugin API, plugin loading, compatibility checks |
| Exchange plugin | REST paths, WS connection model, payload routing, symbol rules, pagination, rate limits, realtime policy, normalizers |
| Adapter | Legacy facade and optional symbol metadata compatibility |
| `data_engine` | Generic ingestion/backfill orchestration only |
| Frontend | Reads backend capabilities and adapts UI choices |

Adapters are intentionally no longer the source of truth for runtime protocol
behavior. New exchange work should start from `plugin.py`, `protocol.py`,
`pagination.py`, `symbols.py`, and `normalizer.py`.

## Core Contracts

| Contract | File | Purpose |
|---|---|---|
| `ExchangePlugin` | `plugin.py` | Composition root for protocol, normalizer, and policies |
| `ExchangeProtocol` | `protocol.py` | REST request specs, WS connection specs, subscription payloads, payload routing |
| `ExchangeCapabilities` | `models.py` | Public capability metadata consumed by APIs and frontend |
| `HistoricalPaginationPolicy` | `pagination.py` | Historical REST pagination semantics |
| `RateLimitPolicy` | `rate_limits.py` | Per-exchange and per-market fetch pacing |
| `RealtimePolicy` | `realtime.py` | Native interval, base fanout, or polling behavior |
| `ExchangeContractCase` | `contracts.py` | Reusable contract test fixture for plugins |

## Runtime Flow

```text
ExchangePlugin
  ├─ capabilities()      -> API + frontend capability-driven UI
  ├─ protocol()          -> ingestion transport REST/WS specs
  ├─ pagination_policy() -> backfill historical paging
  ├─ normalizer()        -> raw payload -> MarketEvent
  ├─ rate_limit_policy() -> backfill/transport pacing
  └─ adapter()           -> legacy facade only
```

Data Engine code must not call `plugin.adapter()` for runtime behavior. The
adapter entry point exists so older imports and symbol metadata callers keep
working while new code moves through plugin contracts.

## Capability Metadata

`ExchangeCapabilities` is the public contract exposed by
`GET /api/v1/exchanges/` and `GET /api/v1/exchanges/{exchange}/capabilities`.
It includes:

- `plugin_api_version`
- `capability_schema_version`
- `markets`
- `channels`
- `native_intervals`
- `ws_connection_model`
- `protocol_features`
- `limits`
- `known_limitations`

Each schema-v2+ channel separately declares transport, snapshot/delta,
sequence/resync, `available_fields`, `unavailable_fields`, and
`derived_fields`. The P0 K-line path uses those declarations to gate enhanced
volume and order-flow proxies so plugin placeholders never become market data.
Schema v3 adds market `calendar_id`/`timezone`, typed channel
`history_policy` metadata, and normalized symbol lifecycle timestamps. Legacy
dotted history limits remain available to schema-v1/v2 consumers.

The frontend uses this metadata for interval lists, available market types,
WS behavior, and user-visible exchange limitations. Keep new exchange UI
behavior in capabilities instead of adding frontend exchange branches.

## Registry And Loading

Built-in plugins are registered by `bootstrap_default_adapters()`:

- Binance: `app.exchanges.plugins.binance`
- OKX: `app.exchanges.plugins.okx`

`ExchangeRegistry.register()` checks plugin compatibility before registration:

- `capabilities.exchange` must match `plugin.id`
- `plugin_api_version` major version must match the backend-supported major
- `capability_schema_version` must not exceed the backend-supported schema

Optional out-of-tree plugins can be loaded explicitly:

```powershell
$env:CANDLESCOPE_EXCHANGE_PLUGINS = "my_package.exchange_plugin,my_other_plugin:make_plugin"
```

Each spec can be `module.path` or `module.path:factory`. Without a factory,
the loader looks for `create_plugin()` first, then `plugin`.

## Diagnostics

Use:

```bash
curl http://localhost:8000/api/v1/exchanges/diagnostics
```

Diagnostics report loaded/error status, source, plugin API version, protocol
class, adapter facade, and policy classes. External plugin failures are recorded
there instead of silently contaminating runtime state.

## Contract Tests

The plugin contract harness lives in `contracts.py`. Built-in fixtures live in:

- `backend/tests/fixtures/exchanges/contract_cases.py`

Run:

```bash
cd backend
python -m pytest -q tests/test_exchange_plugin_contracts.py
```

Contract cases should cover:

- REST request specs and HTTP row extraction
- WS connection specs and subscription payloads
- historical pagination request generation
- normalizer output schema for `MarketEvent.data`

New exchange plugins should add fixtures before being wired into runtime.

## Adding A New Exchange

1. Copy `plugins/_template` to `plugins/<exchange>`.
2. Implement capability metadata in the adapter facade or plugin-owned provider.
3. Implement `protocol.py` for REST/WS specs and payload routing.
4. Implement `pagination.py` if the default reverse-time policy is wrong.
5. Implement `symbols.py` for canonical symbol conversion.
6. Implement `normalizer.py` for raw payload to `MarketEvent`.
7. Wire protocol, normalizer, and policies in `plugin.py`.
8. Add contract fixtures under `tests/fixtures/exchanges/`.
9. Register the built-in plugin, or load it through `CANDLESCOPE_EXCHANGE_PLUGINS`.
10. Verify diagnostics, contract tests, data engine boundary tests, and frontend capability behavior.

## Boundary Rules

- Do not add exchange-specific branches in `data_engine` for REST paths, WS URLs,
  pagination, payload shapes, rate limits, or symbol formats.
- Do not make adapter the source of truth for new runtime behavior.
- Do expose new exchange behavior through capabilities, protocol specs, and policies.
- Do add contract fixtures before relying on a plugin in ingestion/backfill.
