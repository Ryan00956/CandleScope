# Exchange Plugin Template

[中文](README_zh.md)

> Template for adding a new exchange plugin. The backend now routes exchange behavior through `app.exchanges.registry`; API, symbols, ingestion, backfill, and transport code should query registry capabilities instead of hard-coding exchange branches in business modules.

## Plugin Layout

```text
backend/app/exchanges/plugins/<exchange>/
├── __init__.py
├── adapter.py      # ExchangeAdapter implementation
├── normalizer.py   # ingestion payload normalizer
├── plugin.py       # ExchangePlugin / factory metadata
└── symbols.py      # symbol normalization and metadata helpers
```

Template files:

| File | Purpose |
|---|---|
| [adapter.py](adapter.py) | Capabilities, REST/WS URLs, request params, subscription specs, payload extraction |
| [normalizer.py](normalizer.py) | Convert exchange raw payloads into ingestion-standard events |
| [plugin.py](plugin.py) | Plugin entrypoint and factories |
| [symbols.py](symbols.py) | Symbol canonicalization and symbol metadata conversion |

Built-in examples:

- `backend/app/exchanges/plugins/binance/`
- `backend/app/exchanges/plugins/okx/`

## Core Contracts

| Contract | File | Meaning |
|---|---|---|
| `ExchangeAdapter` | `app/exchanges/base.py` | Main adapter protocol used by API and transport |
| `ExchangePlugin` | `app/exchanges/plugin.py` | Creates adapter, normalizer, and symbol normalizer |
| `ExchangeCapabilities` | `app/exchanges/models.py` | Markets, intervals, features, and limits |
| `WsSubscriptionSpec` | `app/exchanges/ws_protocol.py` | Path-based vs message-based WS subscription |
| `RealtimePolicy` | `app/exchanges/realtime.py` | Native interval, base fanout, or polling behavior |
| `RateLimitPolicy` | `app/exchanges/rate_limits.py` | REST/WS rate-limit defaults and overrides |

## Adding A New Plugin

1. Copy `_template` to a new directory, for example `coinbase`.
2. Rename package/module references and remove `_template` placeholders.
3. Implement capabilities and URL/param logic in `adapter.py`.
4. Implement kline, ticker, trade, and other payload normalization in `normalizer.py`.
5. Implement symbol canonicalization and symbol metadata conversion in `symbols.py`.
6. Return the adapter, normalizer, and symbol normalizer from `plugin.py`.
7. Register it in `app/exchanges/registry.py` through `bootstrap_default_adapters()`, or connect it to a future dynamic discovery mechanism.
8. Add tests for capabilities, symbol normalization, REST URLs, WS URLs/subscription specs, normalizer behavior, and historical fetch behavior.

## Adapter Capabilities To Express

At minimum, define:

- `id`: exchange id, for example `binance` or `okx`.
- `capabilities()`: supported market types, intervals, REST/WS features.
- REST base URL selection for spot/futures/swap markets.
- WS URL selection for public/business/private or spot/futures endpoints.
- Historical kline params: exchange-specific names/formats for symbol, interval, start/end, and limit.
- WebSocket subscription spec: path subscription or subscribe message after connect.
- Payload extraction: where kline/ticker arrays live in REST/WS responses.
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
  tests/test_exchange_registry_plugins.py \
  tests/test_symbol_normalization.py \
  tests/test_transport_ws_urls.py \
  tests/test_ingestion_normalizers.py
```

New exchanges usually also need dedicated fetcher/normalizer tests; see `tests/test_okx_backfill_fetcher.py`.
