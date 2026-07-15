# Exchange Plugin Template

[中文](README_zh.md)

> Template for adding a new exchange plugin. The backend now routes exchange behavior through `app.exchanges.registry`; API, symbols, ingestion, backfill, and transport code should query registry capabilities instead of hard-coding exchange branches in business modules.

## Plugin Layout

```text
backend/app/exchanges/plugins/<exchange>/
├── __init__.py
├── adapter.py      # legacy facade / optional symbol metadata helpers
├── normalizer.py   # ingestion payload normalizer
├── pagination.py   # optional historical pagination policy
├── plugin.py       # ExchangePlugin / factory metadata
├── protocol.py     # REST/WS request specs and payload routing
└── symbols.py      # symbol normalization and metadata helpers
```

Template files:

| File | Purpose |
|---|---|
| [adapter.py](adapter.py) | Legacy facade and optional symbol metadata helpers |
| [normalizer.py](normalizer.py) | Convert exchange raw payloads into ingestion-standard events |
| [pagination.py](pagination.py) | Optional historical pagination policy when default reverse-time pagination is not enough |
| [plugin.py](plugin.py) | Plugin entrypoint and policy/protocol factories |
| [protocol.py](protocol.py) | REST/WS request specs, subscription specs, and payload routing |
| [symbols.py](symbols.py) | Symbol canonicalization and symbol metadata conversion |

Built-in examples:

- `backend/app/exchanges/plugins/binance/`
- `backend/app/exchanges/plugins/okx/`

## Core Contracts

| Contract | File | Meaning |
|---|---|---|
| `ExchangeAdapter` | `app/exchanges/base.py` | Legacy facade kept for compatibility |
| `ExchangePlugin` | `app/exchanges/plugin.py` | Exchange-owned composition root for protocol, normalizer, and policies |
| `ExchangeProtocol` | `app/exchanges/protocol.py` | REST/WS request specs and raw payload routing |
| `ExchangeCapabilities` | `app/exchanges/models.py` | Markets, intervals, features, and limits |
| `WsSubscriptionSpec` | `app/exchanges/ws_protocol.py` | Path-based vs message-based WS subscription |
| `HistoricalPaginationPolicy` | `app/exchanges/pagination.py` | Exchange-specific historical pagination semantics |
| `RealtimePolicy` | `app/exchanges/realtime.py` | Native interval, base fanout, or polling behavior |
| `RateLimitPolicy` | `app/exchanges/rate_limits.py` | REST/WS rate-limit defaults and overrides |
| `ExchangeContractCase` | `app/exchanges/contracts.py` | Contract-test fixtures for protocol, policy, and normalizer behavior |
| `NormalizerContractSample` | `app/exchanges/contracts.py` | Raw payload samples that must parse into schema-valid `MarketEvent` objects |

## Adding A New Plugin

1. Copy `_template` to a new directory, for example `coinbase`.
2. Rename package/module references and remove `_template` placeholders.
3. Implement capabilities and any legacy facade behavior in `adapter.py`.
4. Implement REST/WS request specs and raw payload routing in `protocol.py`.
5. Implement kline, ticker, trade, and other payload normalization in `normalizer.py`.
6. Implement symbol canonicalization and symbol metadata conversion in `symbols.py`.
7. Add a pagination policy in `pagination.py` if default reverse-time pagination is not correct for the exchange.
8. Return the protocol, normalizer, symbol normalizer, and policies from `plugin.py`.
9. Keep `plugin_api_version="1.0"`; choose the highest capability schema implemented completely by the plugin (the bundled template demonstrates schema v3).
10. Register it in `app/exchanges/registry.py` through `bootstrap_default_adapters()`, or load it explicitly with `CANDLESCOPE_EXCHANGE_PLUGINS=module.path,module.path:factory`.
11. Add contract fixtures under `tests/fixtures/exchanges/` with `ExchangeContractCase` and `NormalizerContractSample`.
12. Add tests for capabilities, symbol normalization, REST specs, WS specs/subscriptions, normalizer behavior, pagination, and historical fetch behavior.

## Plugin Capabilities To Express

At minimum, define:

- `id`: exchange id, for example `binance` or `okx`.
- `capabilities()`: supported market types, intervals, REST/WS features.
- `plugin_api_version`: major contract version consumed by `ExchangeRegistry`.
- `capability_schema_version`: schema version for capability metadata.
- Schema-v3 `markets`: declare `calendar_id` and `timezone`.
- Schema-v3 historical `channels`: declare typed cadence, empty-page semantics, calendar identity, and finite history limits in `history_policy`.
- `protocol_features`: stable feature flags such as `rest.kline`, `ws.shared_multiplex`, or `pagination.reverse_time`.
- `limits`: machine-readable limits such as `rest.kline.max_limit`.
- `known_limitations`: honest limitations that frontend/runtime diagnostics can surface.
- REST request specs for spot/futures/swap markets.
- WS connection specs for public/business/private or spot/futures endpoints.
- Historical kline params and pagination semantics.
- WebSocket subscription spec: path subscription or subscribe message after connect.
- Payload extraction and routing: where kline/ticker arrays live in REST/WS responses.
- Rate-limit policy: concurrency, delay, and 429 backoff.
- Realtime policy: native interval, base interval fanout, or polling.
- Price stream type: ticker, mini ticker, or another lightweight price stream.

## Normalizer Requirements

Normalizer output must match ingestion `MarketEvent.data` conventions:

- Kline data should include `open_time`, `close_time`, `open`, `high`, `low`, `close`, `volume`, `is_closed`, and related fields when available.
- Ticker/price data should include current price, timestamps, and available volume/change fields.
- All timestamps are milliseconds.
- Symbols should use the exchange's backend canonical format.
- Normalizers must not write storage or trigger backfill.

## Symbol Rules

Different exchanges can use different canonical symbols:

- Binance usually uses `BTCUSDT`.
- OKX keeps hyphenated symbols such as `BTC-USDT` or `BTC-USDT-SWAP`.
- `normalize_symbol(symbol, exchange, market_type)` should convert user input into the target exchange's canonical format.

Tests should cover common aliases, swap/futures suffixes, case normalization, and invalid inputs.

## Suggested Tests

```bash
cd backend
python -m pytest -q \
  tests/test_exchange_plugin_contracts.py \
  tests/test_exchange_registry_plugins.py \
  tests/test_symbol_normalization.py \
  tests/test_transport_ws_urls.py \
  tests/test_ingestion_normalizers.py
```

New exchanges usually also need dedicated fetcher/normalizer tests; see `tests/test_okx_backfill_fetcher.py`.

Contract fixtures should include:

- A descriptor/request pair for every supported market data stream.
- REST sample payloads for `protocol.extract_http_rows()`.
- Normalizer raw payload samples that must produce schema-valid `MarketEvent.data`.
- Exchange-specific required data fields when a stream exposes extra semantics.
