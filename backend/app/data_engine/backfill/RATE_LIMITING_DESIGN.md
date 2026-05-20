# Backfill Exchange Rate-Limit Architecture

> Goal: historical REST backfill is rate-limited independently by exchange, market type, endpoint, and request weight. Business scheduling stays in `BackfillCoordinator`; exchange quotas live in exchange plugins and `RateLimitManager`, so Binance, OKX, and different endpoints do not accidentally share quota.

## 1. Architecture Boundary

```text
BackfillCoordinator
  - business priority
  - request merge / dedupe
  - chunk scheduling
  - same (exchange, market_type, symbol, interval) serialization
  - cross-series concurrency
  - does not understand exchange REST quotas

BackfillEngine
  - detect / plan / fetch / reconcile / publish
  - does not decide exchange quota behavior

HistoricalFetcher
  - builds historical REST requests
  - calls RateLimitManager.acquire() before each HTTP request
  - reports response metadata back to RateLimitManager
  - does not hard-code Binance / OKX quotas

ExchangePlugin
  - owns pagination policy
  - owns symbol / market normalization
  - owns endpoint-aware rate-limit policy

RateLimitManager
  - executes token bucket / cooldown behavior
  - buckets by exchange + endpoint + scope
  - handles Retry-After, X-MBX-USED-WEIGHT-*, and OKX 50011
```

Core rules:

- Business priority does not enter exchange plugins.
- Exchange rate-limit rules do not enter `BackfillCoordinator`.
- Binance and OKX quotas are not combined.
- Binance spot and futures quotas are not combined by default.
- OKX `/api/v5/market/candles` and `/api/v5/market/history-candles` are not combined by default.
- Global fetch concurrency is local resource protection, not an exchange quota model.

## 2. Core Model

### HistoricalRequest

`HistoricalFetcher` converts `BackfillTask` and `TransportRequest` into a `HistoricalRequest` that the limiter can understand:

```python
HistoricalRequest(
    exchange="binance",
    market_type="futures",
    endpoint="/fapi/v1/klines",
    symbol="BTCUSDT",
    interval="1m",
    start_ms=...,
    end_ms=...,
    limit=1000,
)
```

This object describes only the REST request. It does not carry business priority.

### RateLimitRule

`RateLimitRule` is the endpoint rule declared by an exchange plugin:

```python
RateLimitRule(
    name="binance_futures_klines",
    bucket_key="binance:futures:request_weight:ip",
    endpoint="/fapi/v1/klines",
    market_types=("futures",),
    capacity=2400,
    refill_interval_seconds=60.0,
    cost=binance_futures_kline_cost,
    max_concurrency=1,
    cooldown_seconds=60.0,
)
```

`bucket_key` must describe the real quota scope. Different exchanges, endpoints, or quota pools should use different bucket keys.

### RateLimitManager

`RateLimitManager` keeps runtime bucket state inside the fetcher:

- `acquire(rule, request)`: spends tokens before the request; waits if needed.
- `record_response(...)`: records response status, headers, and exchange body code.
- `record_cooldown(...)`: sets cooldown for one bucket.
- `snapshot()`: exposes runtime bucket state to diagnostics.

## 3. Current Exchange Rules

### Binance Spot Klines

- Endpoint: `/api/v3/klines`
- Bucket: `binance:spot:request_weight:ip`
- Default capacity: `BACKFILL_RATE_LIMIT_BINANCE_SPOT_WEIGHT_PER_MINUTE`
- Default cost: `2` per request
- Response feedback: `X-MBX-USED-WEIGHT-*` corrects remaining bucket tokens

### Binance USD-M Futures Klines

- Endpoint: `/fapi/v1/klines`
- Bucket: `binance:futures:request_weight:ip`
- Default capacity: `BACKFILL_RATE_LIMIT_BINANCE_FUTURES_WEIGHT_PER_MINUTE`
- Request cost depends on `limit`:

```text
limit < 100          -> 1
100 <= limit < 500   -> 2
500 <= limit <= 1000 -> 5
limit > 1000         -> 10
```

The current backfill page size is commonly `1000`, so futures pages usually cost `5`, not `1`.

### OKX Market Candles

- Endpoint: `/api/v5/market/candles`
- Bucket: `okx:market-candles:ip`
- Default capacity: `BACKFILL_RATE_LIMIT_OKX_CANDLES_REQUESTS_PER_2S`
- Window: `2s`
- Cost: `1`

### OKX History Candles

- Endpoint: `/api/v5/market/history-candles`
- Bucket: `okx:history-candles:ip`
- Default capacity: `BACKFILL_RATE_LIMIT_OKX_HISTORY_CANDLES_REQUESTS_PER_2S`
- Window: `2s`
- Cost: `1`

OKX body code `50011` is treated as a rate-limit signal and cools down only the matching endpoint bucket.

## 4. Configuration Semantics

The rate-limit structure separates local concurrency protection from exchange quota:

| Setting | Meaning |
|---|---|
| `BACKFILL_FETCH_CONCURRENCY` | legacy generic REST concurrency fallback |
| `BACKFILL_FETCH_GLOBAL_CONCURRENCY` | process-wide REST fetch concurrency; local resource protection |
| `BACKFILL_FETCH_BINANCE_SPOT_CONCURRENCY` | Binance spot endpoint concurrency |
| `BACKFILL_FETCH_BINANCE_FUTURES_CONCURRENCY` | Binance futures endpoint concurrency |
| `BACKFILL_FETCH_OKX_CONCURRENCY` | OKX endpoint concurrency |
| `BACKFILL_FETCH_429_BACKOFF_SECONDS` | legacy fallback cooldown |
| `BACKFILL_RATE_LIMIT_SAFETY_FACTOR` | conservative multiplier applied to exchange quotas |
| `BACKFILL_RATE_LIMIT_BINANCE_SPOT_WEIGHT_PER_MINUTE` | Binance spot request-weight budget |
| `BACKFILL_RATE_LIMIT_BINANCE_FUTURES_WEIGHT_PER_MINUTE` | Binance futures request-weight budget |
| `BACKFILL_RATE_LIMIT_OKX_CANDLES_REQUESTS_PER_2S` | OKX market candles request window |
| `BACKFILL_RATE_LIMIT_OKX_HISTORY_CANDLES_REQUESTS_PER_2S` | OKX history candles request window |

`BACKFILL_FETCH_RATE_LIMIT_DELAY`, `BACKFILL_FETCH_BINANCE_FUTURES_RATE_LIMIT_DELAY`, and `BACKFILL_FETCH_OKX_RATE_LIMIT_DELAY` remain as legacy fallbacks for exchanges without endpoint rules or for custom limiters.

Concurrency values are normalized to at least `1` inside exchange policies. Negative cooldown values are normalized to `0`; OKX endpoint rules still keep a minimum `2s` cooldown because that is the documented request window.

## 5. Runtime Feedback

`TransportLayer` returns HTTP metadata to the fetcher:

- HTTP status
- HTTP headers
- exchange body code

Handling rules:

- HTTP `429` / `418`: cools down the matching bucket.
- `Retry-After`: preferred cooldown duration.
- Binance `X-MBX-USED-WEIGHT-*`: corrects the matching request-weight bucket tokens.
- OKX `50011`: cools down the matching OKX endpoint bucket.

This means Binance spot cooldown does not affect OKX, and OKX history-candles cooldown does not affect OKX market-candles.

## 6. Diagnostics

### Backfill Engine Snapshot

`HistoricalFetcher.snapshot()` exposes `exchange_rate_limits`:

```json
{
  "exchange_rate_limits": {
    "binance:spot:request_weight:ip": {
      "rule": "binance_spot_klines",
      "algorithm": "header_weight",
      "capacity": 960,
      "refill_interval_seconds": 60.0,
      "max_concurrency": 2,
      "tokens": 948,
      "cooldown_remaining_seconds": 0,
      "last_wait_seconds": 0,
      "last_status_code": 200,
      "last_headers": {
        "x-mbx-used-weight-1m": "12"
      }
    }
  }
}
```

`/api/v1/settings/storage/health` returns both the coordinator snapshot and the backfill engine snapshot, so business scheduling and exchange throttling can be debugged together.

### Exchange Diagnostics

`/api/v1/exchanges/diagnostics` exposes plugin-declared `rate_limit_rules`, which makes exchange policy inspectable before any backfill has run.

### Scheduler Buckets

`BackfillCoordinator` still has a local dispatch bucket to explain chunk dispatch pacing. It is not an exchange REST quota. Diagnostic fields are:

- `scheduler_buckets`: the preferred new field.
- `buckets`: compatibility field for older diagnostics.

## 7. New Exchange Requirements

A new exchange plugin should declare the following in `rate_limit_policy(config)`:

- endpoint path
- market type
- bucket key
- capacity / refill interval
- request cost
- endpoint max concurrency
- cooldown seconds

If an exchange or endpoint does not yet declare explicit rules, `RateLimitPolicy.rule_for()` falls back to legacy delay/concurrency behavior. Treat that as compatibility only.

## 8. Verification Checklist

Key tests:

- `tests/test_backfill_rate_limit.py`
- `tests/test_transport_http_rate_limit_metadata.py`
- `tests/test_exchanges_api.py`
- `tests/test_settings_api.py`
- `tests/test_backfill_coordinator.py`

Full backend regression:

```bash
cd backend
python -m pytest tests -q
```

## 9. Official Rule Sources

Defaults come from public exchange docs and conservative config. Exchange rules may change, so check official docs before changing default quotas.

- Binance Spot REST API limits: https://developers.binance.com/docs/binance-spot-api-docs/rest-api/limits
- Binance Spot market data endpoints: https://developers.binance.com/docs/binance-spot-api-docs/rest-api/market-data-endpoints
- Binance USD-M futures kline endpoint: https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Kline-Candlestick-Data
- Binance USD-M futures exchange information: https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Exchange-Information
- OKX API v5 candlesticks: https://app.okx.com/docs-v5/en/

## 10. Conclusion

This upgrade does not replace the backfill architecture. `BackfillCoordinator` still owns business scheduling, `BackfillEngine` still owns the repair pipeline, exchange rules live in exchange plugins, and execution is centralized in `RateLimitManager`.

Final ownership:

```text
business scheduling: BackfillCoordinator / Scheduler
exchange rules: ExchangePlugin.rate_limit_policy()
limit execution: RateLimitManager
actual requests: TransportLayer
```
